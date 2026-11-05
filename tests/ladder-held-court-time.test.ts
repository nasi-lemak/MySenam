import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import {
  answer,
  answerMove,
  attachBooking,
  challenge,
  changeCourtTime,
  confirm,
  createLadder,
  decide,
  endSeason,
  freeze,
  join,
  ladderDetail,
  ladderHousekeeping,
  leave,
  myPlaces,
  proposeMove,
  report,
  staffHold,
  withdraw,
  type LadderInput,
} from "../src/lib/ladders";
import { listActivity } from "../src/lib/activity";
import { blockSlots, createBooking, createCourt, listVenues, unblockSlots } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as adminLadder from "../src/app/api/admin/ladders/[id]/route";
import * as challengeRoute from "../src/app/api/ladders/[id]/challenges/[challengeId]/route";

/**
 * Court time held by the venue for a ladder's accepted challenges (docs/features/tournaments.md#court-time-and-booking-for-a-challenge, ADR 0040;
 * lib/ladder-holds.ts; migration 0283). Off by default: tests/ladder-court-time.test.ts holds that default. These hold the opt-in: a court held as
 * blocks the hold owns, under the claims constraints, with no money moving; refused with the reason when nothing is free; released in every ending;
 * moved new-time-first; let go in favour of an attached booking; capped; and a manager's to release or move.
 */

vi.setConfig({ testTimeout: 90_000 });

let venueId: number;
let adminId: number;
let courtA: number;
let courtB: number;
let managerCookie: string;
let deskCookie: string;
let n = 0;
let dayNo = 0;
const today = todayISO();
/** Each scenario plays on a day of its own, so what one holds another does not find taken. */
const freshDay = () => addDays(today, 5 + dayNo++);
const START = 18 * 60;

async function person(name = "Hold"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Player${n}`, email: `hold${n}@ladder.test`, phone: `01382${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string; code?: string }): T {
  if (!r.ok) throw new Error(`${r.error} (${r.code ?? ""})`);
  return r.value;
}

const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { ...(cookie ? { cookie } : {}), origin: "http://localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const ctx2 = (id: number, challengeId: number) => ({ params: Promise.resolve({ id: String(id), challengeId: String(challengeId) }) });
const cookieOf = async (u: User) => `${SESSION_COOKIE}=${(await createSession(u.id)).token}`;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  const a = await createCourt({ venueId, name: "Held Court A", sport: "badminton", offPeakRate: 10, peakRate: 12 });
  const b = await createCourt({ venueId, name: "Held Court B", sport: "badminton", offPeakRate: 10, peakRate: 12 });
  if (!a.ok || !b.ok) throw new Error("courts");
  courtA = a.court.id;
  courtB = b.court.id;
  const manager = await createAdmin({ name: "Mina Manager", email: "mina-hold@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: "dan-hold@venue.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

type Pl = { user: User; id: number };

/** A ladder that holds court time on the courts given (default: court A alone), with `count` players joined. */
async function ladder(over: Partial<LadderInput> = {}, count = 4) {
  n++;
  const { settings, ...rest } = over;
  // Days to play: as long as it can be, so the scenarios can each have a day of their own.
  const l = ok(await createLadder({ venueId, name: `Held Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, settings: { cooldownDays: 0, playDays: 60, ...settings }, courtTime: { on: true, courtIds: [courtA] }, ...rest }, adminId));
  const people: Pl[] = [];
  for (let i = 0; i < count; i++) {
    const user = await person();
    people.push({ user, id: ok(await join(user, l.id, { adult: true })).playerId });
  }
  return { l, people };
}

/** The player lower on the ladder challenges the one above at a day and time; the other accepts (the proposal is the agreed time). */
async function accept(l: { id: number }, low: Pl, high: Pl, day: string, minute = START) {
  const made = ok(await challenge(low.user.id, l.id, low.id, high.id, { onDate: day, minute }));
  return answer(high.user.id, made.id, { accept: true });
}

const holdRows = async (challengeId: number) => (await getDb().prepare("SELECT * FROM ladder_court_holds WHERE challenge_id = ? ORDER BY id").all(challengeId)) as { id: number; court_id: number; date: string; start_min: number; end_min: number; released_at: string | null; released_reason: string | null; made_by: string }[];
const liveBlocks = async (challengeId: number) =>
  (await getDb()
    .prepare("SELECT b.court_id, b.date, b.start_min, b.end_min FROM blocks b JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ? AND h.released_at IS NULL ORDER BY b.start_min")
    .all(challengeId)) as { court_id: number; date: string; start_min: number; end_min: number }[];
const count = async (sql: string) => ((await getDb().prepare(sql).get()) as { n: number }).n;
const mail = async (to: string) => (await getDb().prepare("SELECT subject, body FROM messages WHERE kind IN ('programme', 'team_decision') AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];

describe("a ladder that holds court time", () => {
  it("is off unless a manager turns it on, and says where and for how long", async () => {
    const plain = ok(await createLadder({ venueId, name: `Plain Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null }, adminId));
    expect(plain.courtTime).toMatchObject({ on: false, courtIds: [], minutes: null, matchMinutes: 45 });
    const on = ok(await createLadder({ venueId, name: `On Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null, courtTime: { on: true, courtIds: [courtB], minutes: 60 } }, adminId));
    expect(on.courtTime).toMatchObject({ on: true, courtIds: [courtB], minutes: 60, matchMinutes: 60 });
    // A manager changes it later; a court of another venue or sport, or a silly number of minutes, is refused.
    const changed = ok(await changeCourtTime(plain.id, { on: true, courtIds: [courtA, courtB] }));
    expect(changed.courtTime).toMatchObject({ on: true, courtIds: [courtA, courtB].sort((x, y) => x - y) });
    expect(await changeCourtTime(plain.id, { minutes: 5 })).toMatchObject({ ok: false, code: "LAD2_MINUTES" });
    expect(await changeCourtTime(plain.id, { courtIds: [999999] })).toMatchObject({ ok: false, code: "LAD2_COURTS" });
    const squash = await createCourt({ venueId, name: "Squash Hold", sport: "squash", offPeakRate: 10, peakRate: 12 });
    if (!squash.ok) throw new Error(squash.error);
    expect(await changeCourtTime(plain.id, { courtIds: [squash.court.id] })).toMatchObject({ ok: false, code: "LAD2_COURTS" });
    expect(ok(await changeCourtTime(plain.id, { on: false })).courtTime.on).toBe(false);
  });

  it("holds a court when a challenge is accepted at an agreed day and time: blocks the hold owns, for the match, no money, shown to the players", async () => {
    const { l, people } = await ladder();
    const [, top, low] = people;
    const day = freshDay();
    const before = { bookings: await count("SELECT COUNT(*)::int AS n FROM bookings"), claims: await count("SELECT COUNT(*)::int AS n FROM claims") };
    const accepted = ok(await accept(l, low, top, day));
    expect(accepted).toMatchObject({ status: "accepted", agreedOn: day, agreedMin: START });
    expect(accepted.hold).toMatchObject({ courtId: courtA, court: "Held Court A", date: day, startMin: START, endMin: START + 45 });
    // The court time is blocks the hold owns: the match, as a claim under the exclusion constraint.
    expect(await liveBlocks(accepted.id)).toEqual([{ court_id: courtA, date: day, start_min: START, end_min: START + 45 }]);
    expect(await count("SELECT COUNT(*)::int AS n FROM claims") - before.claims).toBe(1);
    // Nothing is sold: no booking, no payment line.
    expect(await count("SELECT COUNT(*)::int AS n FROM bookings")).toBe(before.bookings);
    const row = (await holdRows(accepted.id))[0];
    expect(row).toMatchObject({ made_by: "players", released_at: null });
    // Nobody can book it, by any path; the hour either side is free.
    const stranger = await person("Stranger");
    expect((await createBooking({ courtId: courtA, date: day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id })).ok).toBe(false);
    expect((await createBooking({ courtId: courtA, date: day, hours: [START / 60 + 1], name: stranger.name, phone: stranger.phone, userId: stranger.id })).ok).toBe(true);
    // Both sides see it, the one told also has it in the email.
    for (const p of [low, top]) expect((await myPlaces(p.user.id, l.id))[0].open[0].hold).toMatchObject({ court: "Held Court A", date: day, startMin: START });
    const told = await mail(low.user.email);
    expect(told.some((m) => m.body.includes("Held Court A") && m.body.includes(day) && m.body.includes("18:00"))).toBe(true);
    // The public ladder shows no challenge and no court.
    const pub = JSON.stringify(await ladderDetail(l.id));
    expect(pub).not.toContain("Held Court A");
    expect(await ladderDetail(l.id)).not.toHaveProperty("challenges");
  });

  it("holds nothing until a specific time is agreed; a day alone is not a time, and the first time is agreed by both", async () => {
    const { l, people } = await ladder();
    const [, top, low] = people;
    const day = freshDay();
    const made = ok(await challenge(low.user.id, l.id, low.id, top.id, { onDate: day }));
    const accepted = ok(await answer(top.user.id, made.id, { accept: true }));
    expect(accepted.hold).toBeNull();
    expect(await holdRows(made.id)).toEqual([]);
    // A time needs both: one asks, the other agrees; nothing is held until then, and a turn-down changes nothing.
    ok(await proposeMove(low.user.id, made.id, { onDate: day, minute: START }));
    expect(await holdRows(made.id)).toEqual([]);
    expect(await answerMove(low.user.id, made.id, true)).toMatchObject({ ok: false, code: "LAD2_OWN_MOVE" });
    ok(await answerMove(top.user.id, made.id, false));
    expect(await holdRows(made.id)).toEqual([]);
    ok(await proposeMove(low.user.id, made.id, { onDate: day, minute: START + 30 }));
    const agreed = ok(await answerMove(top.user.id, made.id, true));
    expect(agreed).toMatchObject({ agreedOn: day, agreedMin: START + 30, move: null });
    expect(agreed.hold).toMatchObject({ startMin: START + 30, endMin: START + 75 });
    // A time needs a day and a minute, a challenge accepted, and a ladder that holds.
    expect(await proposeMove(low.user.id, made.id, { onDate: day })).toMatchObject({ ok: false, code: "LAD2_NEED_TIME" });
    const off = ok(await createLadder({ venueId, name: `Off Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null }, adminId));
    const a = await person();
    const b = await person();
    const pa = ok(await join(a, off.id, { adult: true }));
    const pb = ok(await join(b, off.id, { adult: true }));
    const c = ok(await challenge(b.id, off.id, pb.playerId, pa.playerId, {}));
    expect(await proposeMove(b.id, c.id, { onDate: day, minute: START })).toMatchObject({ ok: false, code: "LAD2_OFF" });
    ok(await answer(a.id, c.id, { accept: true }));
    expect(await proposeMove(b.id, c.id, { onDate: day, minute: START })).toMatchObject({ ok: false, code: "LAD2_OFF" });
  });

  it("refuses the acceptance, with the reason and nothing changed, when no court is free; a time that has gone, a closed hour and a day past the play-by day are refused too", async () => {
    const { l, people } = await ladder();
    const [, top, low] = people;
    const day = freshDay();
    // A customer has the only court the ladder may use at that time.
    const stranger = await person("Stranger");
    expect((await createBooking({ courtId: courtA, date: day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id })).ok).toBe(true);
    const made = ok(await challenge(low.user.id, l.id, low.id, top.id, { onDate: day, minute: START }));
    const refused = await answer(top.user.id, made.id, { accept: true });
    expect(refused).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
    expect((await getDb().prepare("SELECT status FROM ladder_challenges WHERE id = ?").get(made.id)) as { status: string }).toMatchObject({ status: "pending" });
    expect(await holdRows(made.id)).toEqual([]);
    expect(await liveBlocks(made.id)).toEqual([]);
    // They pick another time and it is accepted.
    ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START + 120 }));
    const retry = ok(await answer(low.user.id, made.id, { accept: true }));
    expect(retry.hold).toMatchObject({ startMin: START + 120 });
    // A time of day the venue is shut, and one past the days allowed to play it.
    const other = await ladder();
    const [, t2, l2] = other.people;
    const closed = ok(await challenge(l2.user.id, other.l.id, l2.id, t2.id, { onDate: freshDay(), minute: 3 * 60 }));
    expect(await answer(t2.user.id, closed.id, { accept: true })).toMatchObject({ ok: false, code: "LAD2_CLOSED" });
    ok(await answer(t2.user.id, closed.id, { decline: true }));
    const far = await ladder({ settings: { playDays: 14 } });
    const [, t3, l3] = far.people;
    const late = ok(await challenge(l3.user.id, far.l.id, l3.id, t3.id, { onDate: addDays(today, 40), minute: START }));
    expect(await answer(t3.user.id, late.id, { accept: true })).toMatchObject({ ok: false, code: "LAD2_AFTER" });
  });

  it("chooses the court deterministically: the ladder's own courts, the one against what is already there, then the busiest, then the lowest", async () => {
    const day = freshDay();
    // Both courts named: with nothing on either, the lowest id.
    const first = await ladder({ courtTime: { on: true, courtIds: [courtB, courtA] } });
    const one = ok(await accept(first.l, first.people[2], first.people[1], day));
    expect(one.hold!.courtId).toBe(Math.min(courtA, courtB));
    // The court with something already against the time is preferred: a customer's booking ends where the match starts, on the other court.
    const later = freshDay();
    const stranger = await person("Stranger");
    const otherCourt = [courtA, courtB].find((c) => c !== one.hold!.courtId)!;
    expect((await createBooking({ courtId: otherCourt, date: later, hours: [START / 60 - 1], name: stranger.name, phone: stranger.phone, userId: stranger.id })).ok).toBe(true);
    const second = await ladder({ courtTime: { on: true, courtIds: [courtA, courtB] } });
    const two = ok(await accept(second.l, second.people[2], second.people[1], later));
    expect(two.hold!.courtId).toBe(otherCourt);
    // Courts the ladder does not name are never used: the ladder of court B alone, with B taken, is refused though A is free.
    const third = await ladder({ courtTime: { on: true, courtIds: [courtB] } });
    const dayB = freshDay();
    expect((await createBooking({ courtId: courtB, date: dayB, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id })).ok).toBe(true);
    expect(await accept(third.l, third.people[2], third.people[1], dayB)).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
  });
});

describe("a hold's life", () => {
  async function held() {
    const s = await ladder();
    const [, top, low] = s.people;
    const day = freshDay();
    const c = ok(await accept(s.l, low, top, day));
    return { ...s, top, low, c, day };
  }
  const reason = async (id: number) => (await holdRows(id)).at(-1)?.released_reason;

  it("is released when the challenge is withdrawn, forfeited by a manager, struck, cleared, played, or the season ends", async () => {
    const a = await held();
    ok(await withdraw(a.low.user.id, a.c.id));
    expect(await liveBlocks(a.c.id)).toEqual([]);
    expect(await reason(a.c.id)).toBe("withdrawn");

    const b = await held();
    ok(await decide(b.c.id, { adminId, name: "Mina Manager" }, { winner: b.low.id, walkover: true }, "They did not come"));
    expect(await reason(b.c.id)).toBe("forfeited");
    expect(await liveBlocks(b.c.id)).toEqual([]);

    const c = await held();
    ok(await decide(c.c.id, { adminId, name: "Mina Manager" }, { void: true }, "Struck at the desk"));
    expect(await reason(c.c.id)).toBe("void");

    const d = await held();
    ok(await report(d.low.user.id, d.c.id, { winner: d.low.id, score: "21-15, 21-18" }));
    // Reported is not played yet: the hold stays until the result is confirmed.
    expect(await liveBlocks(d.c.id)).toHaveLength(1);
    ok(await confirm(d.top.user.id, d.c.id, { version: (await myPlaces(d.top.user.id, d.l.id))[0].open[0].version }));
    expect(await reason(d.c.id)).toBe("played");
    expect(await liveBlocks(d.c.id)).toEqual([]);
    // Struck afterwards and put back to be played: no court is held again; the players agree a time.
    ok(await decide(d.c.id, { adminId, name: "Mina Manager" }, { clear: true }, "Wrong score"));
    expect(await liveBlocks(d.c.id)).toEqual([]);

    const e = await held();
    ok(await endSeason(e.l.id));
    expect(await reason(e.c.id)).toBe("season");
    expect(await liveBlocks(e.c.id)).toEqual([]);
  });

  it("is released when a player leaves or freezes, and when it lapses unplayed (the scheduler), once", async () => {
    const a = await held();
    ok(await freeze(a.low.user.id, a.low.id, addDays(today, 8)));
    expect(await reason(a.c.id)).toBe("frozen");

    const b = await held();
    ok(await leave(b.top.id));
    expect(await reason(b.c.id)).toBe("left");

    const c = await held();
    await getDb().prepare("UPDATE ladder_challenges SET play_by = ? WHERE id = ?").run(addDays(today, -1), c.c.id);
    await ladderHousekeeping();
    expect(await reason(c.c.id)).toBe("notPlayed");
    expect(await liveBlocks(c.c.id)).toEqual([]);
    await ladderHousekeeping();
    expect(await holdRows(c.c.id)).toHaveLength(1);
  });

  it("is moved when the players agree a new time: the new time held first, then the old let go; a time that overlaps the old one works", async () => {
    const a = await held();
    ok(await proposeMove(a.top.user.id, a.c.id, { onDate: a.day, minute: START + 30 }));
    const moved = ok(await answerMove(a.low.user.id, a.c.id, true));
    expect(moved.hold).toMatchObject({ startMin: START + 30, endMin: START + 75 });
    const rows = await holdRows(a.c.id);
    expect(rows.map((r) => [r.start_min, r.released_reason])).toEqual([[START, "moved"], [START + 30, null]]);
    expect(await liveBlocks(a.c.id)).toEqual([{ court_id: courtA, date: a.day, start_min: START + 30, end_min: START + 75 }]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM blocks WHERE ladder_hold_id = ${rows[0].id}`)).toBe(0);
    expect((await mail(a.top.user.email)).some((m) => m.subject.includes("match time is agreed"))).toBe(true);
  });

  it("keeps the old court held when the new time cannot be held, and tells why", async () => {
    const a = await held();
    const stranger = await person("Stranger");
    const newDay = addDays(a.day, 0);
    expect((await createBooking({ courtId: courtA, date: newDay, hours: [START / 60 + 2], name: stranger.name, phone: stranger.phone, userId: stranger.id , staff: { override: true } })).ok).toBe(true);
    ok(await proposeMove(a.low.user.id, a.c.id, { onDate: newDay, minute: START + 120 }));
    expect(await answerMove(a.top.user.id, a.c.id, true)).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
    expect(await liveBlocks(a.c.id)).toEqual([{ court_id: courtA, date: a.day, start_min: START, end_min: START + 45 }]);
    expect(await holdRows(a.c.id)).toHaveLength(1);
    // The request stands for them to answer or take back.
    expect((await myPlaces(a.top.user.id, a.l.id))[0].open[0].move).toMatchObject({ onDate: newDay, minute: START + 120 });
    ok(await answerMove(a.low.user.id, a.c.id, false));
    expect((await myPlaces(a.top.user.id, a.l.id))[0].open[0].move).toBeNull();
  });

  it("is let go in favour of an ordinary booking the players attach: no second court for the same match", async () => {
    const a = await held();
    const booking = await createBooking({ courtId: courtB, date: a.day, hours: [START / 60 + 1], name: a.low.user.name, phone: a.low.user.phone, userId: a.low.user.id , staff: { override: true } });
    if (!booking.ok) throw new Error(booking.error);
    ok(await attachBooking(a.low.user.id, a.c.id, booking.booking.code));
    expect(await reason(a.c.id)).toBe("booking");
    expect(await liveBlocks(a.c.id)).toEqual([]);
    // A booking is the court time: asking for a time to hold is refused while it is attached.
    expect(await proposeMove(a.top.user.id, a.c.id, { onDate: a.day, minute: START })).toMatchObject({ ok: false, code: "LAD2_HAS_BOOKING" });
  });

  it("follows the play-by day: a time after it is refused, and a hold whose court time was lost is marked lost, told once, and the challenge stands", async () => {
    const a = await held();
    const play = ((await getDb().prepare("SELECT play_by FROM ladder_challenges WHERE id = ?").get(a.c.id)) as { play_by: string }).play_by;
    expect(await proposeMove(a.low.user.id, a.c.id, { onDate: addDays(play, 1), minute: START })).toMatchObject({ ok: false, code: "LAD2_AFTER" });
    // The court taken out of service lets go of the blocks on it: the scheduler finds it.
    await getDb().prepare("DELETE FROM blocks WHERE ladder_hold_id IN (SELECT id FROM ladder_court_holds WHERE challenge_id = ?)").run(a.c.id);
    await ladderHousekeeping();
    expect(await reason(a.c.id)).toBe("lost");
    const lost = (await mail(a.low.user.email)).filter((m) => m.subject.includes("court held for your challenge is gone"));
    expect(lost).toHaveLength(1);
    await ladderHousekeeping();
    expect((await mail(a.low.user.email)).filter((m) => m.subject.includes("court held for your challenge is gone"))).toHaveLength(1);
    expect((await myPlaces(a.low.user.id, a.l.id))[0].open[0]).toMatchObject({ status: "accepted", hold: null });
    // They agree a time again and a court is held.
    ok(await proposeMove(a.low.user.id, a.c.id, { onDate: a.day, minute: START + 60 }));
    expect(ok(await answerMove(a.top.user.id, a.c.id, true)).hold).toMatchObject({ startMin: START + 60 });
  });
});

describe("caps, so a ladder cannot swallow a venue", () => {
  it("at most a few held at once on a ladder, and at most a few live at once for one player (not the holds ever made, ADR 0050); install data", async () => {
    const limits = (await getDb().prepare("SELECT max_live_per_ladder, max_per_player_week FROM ladder_hold_limits WHERE id = 1").get()) as { max_live_per_ladder: number; max_per_player_week: number };
    expect(limits).toEqual({ max_live_per_ladder: 8, max_per_player_week: 4 });
    try {
      await getDb().prepare("UPDATE ladder_hold_limits SET max_live_per_ladder = 1 WHERE id = 1").run();
      const s = await ladder({}, 6);
      const [, p2, p3, p4, p5, p6] = s.people;
      ok(await accept(s.l, p3, p2, freshDay()));
      expect(await accept(s.l, p5, p4, freshDay())).toMatchObject({ ok: false, code: "LAD2_CAP_LADDER" });
      // The challenge that was refused is still pending: it can be accepted at a time without a hold, or after the first is played.
      expect((await myPlaces(p4.user.id, s.l.id))[0].open[0].status).toBe("pending");
      expect(p6.id).toBeGreaterThan(0);
    } finally {
      await getDb().prepare("UPDATE ladder_hold_limits SET max_live_per_ladder = 8 WHERE id = 1").run();
    }
    try {
      await getDb().prepare("UPDATE ladder_hold_limits SET max_active_per_player = 1 WHERE id = 1").run();
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      const first = ok(await accept(s.l, low, top, freshDay()));
      ok(await withdraw(low.user.id, first.id));
      // A hold let go stops counting at once (ADR 0050, which replaced the "made in 7 days" quota): the player's allowance is free again.
      expect(ok(await accept(s.l, low, top, freshDay())).hold).not.toBeNull();
    } finally {
      await getDb().prepare("UPDATE ladder_hold_limits SET max_active_per_player = 4 WHERE id = 1").run();
    }
  });
});

describe("races", () => {
  it("of two challenges accepted at once for the last court, one holds it and the other is refused", async () => {
    const day = freshDay();
    const s = await ladder({}, 5);
    const [, p2, p3, p4, p5] = s.people;
    const c1 = ok(await challenge(p3.user.id, s.l.id, p3.id, p2.id, { onDate: day, minute: START }));
    const c2 = ok(await challenge(p5.user.id, s.l.id, p5.id, p4.id, { onDate: day, minute: START + 15 }));
    const done = await Promise.all([answer(p2.user.id, c1.id, { accept: true }), answer(p4.user.id, c2.id, { accept: true })]);
    expect(done.filter((r) => r.ok)).toHaveLength(1);
    expect(done.filter((r) => !r.ok)[0]).toMatchObject({ code: "LAD2_NO_COURT" });
    expect(await count(`SELECT COUNT(*)::int AS n FROM blocks WHERE ladder_hold_id IN (SELECT id FROM ladder_court_holds WHERE ladder_id = ${s.l.id} AND released_at IS NULL)`)).toBe(1);
  });

  it("of two ladders racing for the same court at the same time, the database lets one hold it", async () => {
    const day = freshDay();
    const one = await ladder({}, 3);
    const two = await ladder({}, 3);
    const a = ok(await challenge(one.people[2].user.id, one.l.id, one.people[2].id, one.people[1].id, { onDate: day, minute: START }));
    const b = ok(await challenge(two.people[2].user.id, two.l.id, two.people[2].id, two.people[1].id, { onDate: day, minute: START }));
    const done = await Promise.all([answer(one.people[1].user.id, a.id, { accept: true }), answer(two.people[1].user.id, b.id, { accept: true })]);
    expect(done.filter((r) => r.ok)).toHaveLength(1);
    expect(done.filter((r) => !r.ok)[0]).toMatchObject({ code: "LAD2_NO_COURT" });
    // The loser's challenge is still pending, with nothing held for it.
    const lost = done[0].ok ? b : a;
    expect(await holdRows(lost.id)).toEqual([]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM claims c JOIN blocks k ON k.id = c.block_id WHERE k.court_id = ${courtA} AND k.date = '${day}' AND c.active`)).toBe(1);
  });
});

describe("what staff see and do", () => {
  it("a staff block over held time leaves it, and unblocking does not take it; a manager releases or moves it, with a reason, logged and told", async () => {
    const s = await ladder();
    const [, top, low] = s.people;
    const day = freshDay();
    const c = ok(await accept(s.l, low, top, day));
    const before = await liveBlocks(c.id);
    await blockSlots(courtA, day, { start: START - 60, end: START + 120 }, "Staff block");
    await unblockSlots(courtA, day, { start: START - 60, end: START + 120 });
    expect(await liveBlocks(c.id)).toEqual(before);
    // The staff view lists the challenge with its court.
    const staffView = (await ladderDetail(s.l.id, { forStaff: true }))!.challenges!.find((x) => x.id === c.id)!;
    expect(staffView.hold).toMatchObject({ court: "Held Court A", startMin: START });

    const send = (cookie: string | undefined, body: unknown) => adminLadder.POST(req(`/api/admin/ladders/${s.l.id}`, "POST", cookie, body), ctx(s.l.id));
    // The desk cannot; a reason is needed; another venue's or ladder's challenge is not found.
    expect((await send(deskCookie, { action: "hold_release", challengeId: c.id, reason: "No longer needed" })).status).toBe(403);
    expect((await send(undefined, { action: "hold_release", challengeId: c.id, reason: "No longer needed" })).status).toBe(401);
    expect((await send(managerCookie, { action: "hold_release", challengeId: c.id })).status).toBe(400);
    expect((await send(managerCookie, { action: "hold_release", challengeId: 999999, reason: "No longer needed" })).status).toBe(404);
    // Moved to the other court's time: new time held first; a move to a time that is taken is refused and the old stays.
    const stranger = await person("Stranger");
    expect((await createBooking({ courtId: courtA, date: day, hours: [START / 60 + 3], name: stranger.name, phone: stranger.phone, userId: stranger.id , staff: { override: true } })).ok).toBe(true);
    const taken = await send(managerCookie, { action: "hold_move", challengeId: c.id, onDate: day, minute: (START / 60 + 3) * 60, courtId: courtA, reason: "Court is being re-laid" });
    expect(taken.status).toBe(409);
    expect((await taken.json()).code).toBe("LAD2_NO_COURT");
    expect(await liveBlocks(c.id)).toEqual(before);
    const moved = await send(managerCookie, { action: "hold_move", challengeId: c.id, onDate: day, minute: START + 120, courtId: courtB, reason: "Court A is being re-laid" });
    expect(moved.status).toBe(200);
    expect(await liveBlocks(c.id)).toEqual([{ court_id: courtB, date: day, start_min: START + 120, end_min: START + 165 }]);
    expect((await holdRows(c.id)).map((r) => [r.made_by, r.released_reason])).toEqual([["players", "moved"], ["staff", null]]);
    expect((await mail(low.user.email)).some((m) => m.body.includes("Held Court B") && m.body.includes("Court A is being re-laid"))).toBe(true);
    const released = await send(managerCookie, { action: "hold_release", challengeId: c.id, reason: "The players will book it themselves" });
    expect(released.status).toBe(200);
    expect(await liveBlocks(c.id)).toEqual([]);
    expect((await holdRows(c.id)).at(-1)).toMatchObject({ released_reason: "staff" });
    expect(await send(managerCookie, { action: "hold_release", challengeId: c.id, reason: "The players will book it themselves" }).then((r) => r.status)).toBe(409);
    const logged = (await listActivity([venueId], { limit: 500 })).filter((e) => e.action.startsWith("ladder.hold_"));
    expect(logged.map((e) => e.action)).toEqual(expect.arrayContaining(["ladder.hold_moved", "ladder.hold_released"]));
    expect(logged.some((e) => e.detail?.includes("The players will book it themselves"))).toBe(true);
    // Through staffHold directly, a challenge that is not accepted has nothing to hold.
    expect(await staffHold(c.id, { adminId, name: "Mina" }, { release: true }, "x")).toMatchObject({ ok: false, code: "LD_REASON" });
  });

  it("the court time setting is a manager's, logged", async () => {
    const s = await ladder({ courtTime: { on: false } }, 2);
    const send = (cookie: string, body: unknown) => adminLadder.POST(req(`/api/admin/ladders/${s.l.id}`, "POST", cookie, body), ctx(s.l.id));
    expect((await send(deskCookie, { action: "court_time", on: true })).status).toBe(403);
    expect((await send(managerCookie, { action: "court_time", on: true, courtIds: [courtA], minutes: 5 })).status).toBe(400);
    const done = await send(managerCookie, { action: "court_time", on: true, courtIds: [courtA], minutes: 50 });
    expect(done.status).toBe(200);
    expect((await done.json()).ladder.courtTime).toMatchObject({ on: true, courtIds: [courtA], matchMinutes: 50 });
    expect((await listActivity([venueId], { limit: 500 })).some((e) => e.action === "ladder.court_time")).toBe(true);
  });
});

describe("through the player's route", () => {
  it("agrees a time by propose_move and agree_move; refused to anybody who is not in the challenge", async () => {
    const s = await ladder();
    const [, top, low] = s.people;
    const day = freshDay();
    const made = ok(await challenge(low.user.id, s.l.id, low.id, top.id, { onDate: day }));
    ok(await answer(top.user.id, made.id, { accept: true }));
    const send = async (u: User | null, body: unknown) => challengeRoute.POST(req(`/api/ladders/${s.l.id}/challenges/${made.id}`, "POST", u ? await cookieOf(u) : undefined, body), ctx2(s.l.id, made.id));
    expect((await send(null, { action: "propose_move", onDate: day, minute: START })).status).toBe(401);
    expect((await send(await person(), { action: "propose_move", onDate: day, minute: START })).status).toBe(404);
    expect((await send(low.user, { action: "propose_move", onDate: day })).status).toBe(400);
    const asked = await send(low.user, { action: "propose_move", onDate: day, minute: START });
    expect(asked.status).toBe(200);
    expect((await asked.json()).challenge.move).toMatchObject({ onDate: day, minute: START });
    expect((await (await send(low.user, { action: "agree_move" })).json()).code).toBe("LAD2_OWN_MOVE");
    const agreed = await send(top.user, { action: "agree_move" });
    expect(agreed.status).toBe(200);
    expect((await agreed.json()).challenge.hold).toMatchObject({ court: "Held Court A", startMin: START });
  });
});
