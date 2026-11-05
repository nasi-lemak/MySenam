import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { abandonedCount, holdViews, resolveHoldLimits } from "../src/lib/ladder-holds";
import { sweepExpiredHolds } from "../src/lib/ladder-hold-sweep";
import {
  answer,
  answerMove,
  challenge,
  confirm,
  confirmHoldAsPlayer,
  createLadder,
  ladderDetail,
  ladderHousekeeping,
  myPlaces,
  previewHoldFor,
  proposeMove,
  join,
  report,
  staffHold,
  withdraw,
  type LadderInput,
} from "../src/lib/ladders";
import { listActivity } from "../src/lib/activity";
import { blockSlots, createBooking, createCourt } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as adminLadder from "../src/app/api/admin/ladders/[id]/route";
import * as challengeRoute from "../src/app/api/ladders/[id]/challenges/[challengeId]/route";

/**
 * The owner's decisions of 5 November 2026 on ladder court time (ADR 0050, which amends ADR 0048; migration 0292; lib/ladder-holds.ts, lib/ladders.ts):
 *  - an exact time one player proposed and the other explicitly accepted is both players' agreement: the hold is made confirmed, what each agreed is kept,
 *    and the acceptance screen shows the court, time, duration, charges and implications first;
 *  - a counter-proposal, a day alone, or a time a manager chose is not an agreement; a change the players did not both agree makes the hold tentative again;
 *  - an expired or released hold stops counting towards the player's active allowance at once; only holds a player created and abandoned count towards
 *    the anti-abuse limit, whose consequence is a cooldown.
 * Nothing here bypasses the one claim path: every hold is still made under the exclusion constraints and the ladder's limits.
 */

vi.setConfig({ testTimeout: 120_000 });

let venueId: number;
let adminId: number;
let courtA: number;
let courtB: number;
let courtC: number;
let managerCookie: string;
let n = 0;
let dayNo = 0;
const today = todayISO();
/** Each scenario plays on a day of its own, so what one holds another does not find taken. */
const freshDay = () => addDays(today, 5 + (dayNo++ % 50));
const START = 18 * 60;
const db = () => getDb();

async function person(name = "Tan"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Agree${n}`, email: `tan${n}@agree.test`, phone: `01385${String(n).padStart(5, "0")}`, password: "a long enough password" });
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
  const venue = (await (await import("../src/lib/store")).listVenues())[0];
  venueId = venue.id;
  const made = [] as number[];
  for (const name of ["Agree Court A", "Agree Court B", "Agree Court C"]) {
    const c = await createCourt({ venueId, name, sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!c.ok) throw new Error("courts");
    made.push(c.court.id);
  }
  [courtA, courtB, courtC] = made;
  const manager = await createAdmin({ name: "Mina Manager", email: "mina-agree@venue.my", password: "manager-pass-1", venueId });
  if (!manager.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
});

/**
 * A ladder may only be played within 60 days, so the days a scenario plays on come round again; what a scenario left on the three courts (holds, blocks, bookings)
 * is cleared after it, so the next finds them empty. Nothing else is touched.
 */
afterEach(async () => {
  await db().prepare("UPDATE ladder_court_holds SET released_at = datetime('now'), released_reason = 'test cleanup' WHERE released_at IS NULL").run();
  await db().prepare("DELETE FROM blocks WHERE court_id IN (?, ?, ?)").run(courtA, courtB, courtC);
  await db().prepare("DELETE FROM bookings WHERE court_id IN (?, ?, ?)").run(courtA, courtB, courtC);
});

type Pl = { user: User; id: number };

/** A ladder that holds court time on the courts given (default: court A alone), with `count` players joined. */
async function ladder(over: Partial<LadderInput> = {}, count = 4) {
  n++;
  const { settings, ...rest } = over;
  const l = ok(await createLadder({ venueId, name: `Agree Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, settings: { cooldownDays: 0, playDays: 60, ...settings }, courtTime: { on: true, courtIds: [courtA] }, ...rest }, adminId));
  const people: Pl[] = [];
  for (let i = 0; i < count; i++) {
    const user = await person();
    people.push({ user, id: ok(await join(user, l.id, { adult: true })).playerId });
  }
  return { l, people };
}

/** The lower player challenges the one above, proposing a day and time (or a day alone). */
const propose = async (l: { id: number }, low: Pl, high: Pl, day: string, minute?: number) =>
  ok(await challenge(low.user.id, l.id, low.id, high.id, minute === undefined ? { onDate: day } : { onDate: day, minute }));

/** A challenge accepted by exact agreement: proposed at a day and time, accepted unchanged. */
async function agreed(over: Partial<LadderInput> = {}, minute = START) {
  const s = await ladder(over, 3);
  const [, top, low] = s.people;
  const day = freshDay();
  const made = await propose(s.l, low, top, day, minute);
  const c = ok(await answer(top.user.id, made.id, { accept: true }));
  return { ...s, top, low, c, day, made };
}

/** A tentative hold: the accepter names the time (a counter-proposal), so both must confirm. */
async function tentative(over: Partial<LadderInput> = {}, minute = START) {
  const s = await ladder(over, 3);
  const [, top, low] = s.people;
  const day = freshDay();
  const made = await propose(s.l, low, top, day);
  const c = ok(await answer(top.user.id, made.id, { accept: true, onDate: day, minute }));
  return { ...s, top, low, c, day, made };
}

type HoldRow = {
  id: number;
  court_id: number;
  date: string;
  start_min: number;
  made_by: string;
  made_by_place: number | null;
  released_at: string | null;
  released_reason: string | null;
  confirm_by: Date | string | null;
  confirmed_at: Date | string | null;
  agreed_exactly: boolean;
  changed_from: string | null;
  abandoned_place: number | null;
  abandoned_at: Date | string | null;
};
const holdRows = async (challengeId: number) => (await db().prepare("SELECT * FROM ladder_court_holds WHERE challenge_id = ? ORDER BY id").all(challengeId)) as HoldRow[];
const lastHold = async (challengeId: number) => (await holdRows(challengeId)).at(-1)!;
const claimExpiries = async (challengeId: number) =>
  ((await db()
    .prepare("SELECT c.expires_at FROM claims c JOIN blocks b ON b.id = c.block_id JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ? AND c.active")
    .all(challengeId)) as { expires_at: Date | string | null }[]).map((r) => (r.expires_at === null ? null : new Date(r.expires_at).getTime()));
const liveBlocks = async (challengeId: number) =>
  (await db()
    .prepare("SELECT b.court_id, b.date, b.start_min, b.end_min FROM blocks b JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ? AND h.released_at IS NULL ORDER BY b.start_min")
    .all(challengeId)) as { court_id: number; date: string; start_min: number; end_min: number }[];
const count = async (sql: string) => ((await db().prepare(sql).get()) as { n: number }).n;
const agreements = async (challengeId: number) =>
  (await db().prepare("SELECT * FROM ladder_agreed_times WHERE challenge_id = ? ORDER BY id").all(challengeId)) as {
    held_id: number;
    player_id: number;
    role: string;
    date: string;
    start_min: number;
    minutes: number;
    court_id: number | null;
  }[];
const mail = async (to: string) => (await db().prepare("SELECT subject, body FROM messages WHERE kind IN ('programme', 'team_decision') AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];
const mailAbout = async (to: string, text: string) => (await mail(to)).filter((m) => m.subject.includes(text) || m.body.includes(text));
const view = async (l: { id: number }, challengeId: number) => (await ladderDetail(l.id, { forStaff: true }))!.challenges!.find((c) => c.id === challengeId)!;
const versionOf = async (challengeId: number) => ((await db().prepare("SELECT version FROM ladder_challenges WHERE id = ?").get(challengeId)) as { version: number }).version;
const statusOf = async (challengeId: number) => ((await db().prepare("SELECT status FROM ladder_challenges WHERE id = ?").get(challengeId)) as { status: string }).status;
const send = (cookie: string | undefined, ladderId: number, body: unknown) => adminLadder.POST(req(`/api/admin/ladders/${ladderId}`, "POST", cookie, body), ctx(ladderId));

/** Time passes: the hold's confirm-by moment, and the one its claims carry, are a minute ago (the scheduler has not run). */
async function lapse(challengeId: number) {
  await db().prepare("UPDATE ladder_court_holds SET confirm_by = now() - interval '1 minute' WHERE challenge_id = ? AND released_at IS NULL").run(challengeId);
  await db()
    .prepare("UPDATE claims SET expires_at = now() - interval '1 minute' WHERE kind = 'block' AND block_id IN (SELECT b.id FROM blocks b JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ?)")
    .run(challengeId);
}

/** Put the install's numbers back, so one scenario's settings never reach another's. */
async function clean(fn: () => Promise<void>) {
  try {
    await fn();
  } finally {
    await db().prepare("DELETE FROM venue_ladder_hold_limits WHERE venue_id = ?").run(venueId);
    await db()
      .prepare(
        "UPDATE ladder_hold_limits SET max_live_per_ladder = 8, max_active_per_player = 4, active_min = 1, active_max = 20, abuse_limit = 6, abuse_min = 2, abuse_max = 50, abuse_window_days = 7, abuse_cooldown_hours = 24 WHERE id = 1"
      )
      .run();
  }
}

async function caps(ladderId: number, body: Record<string, unknown>, scope: "ladder" | "venue" = "ladder") {
  const r = await send(managerCookie, ladderId, { action: "hold_limits", scope, ...body });
  expect(r.status).toBe(200);
}

// ============================================================================ agreement counts

describe("an existing agreement counts as confirmation", () => {
  it("a time one player proposed and the other accepts unchanged is made confirmed: no second tap, no confirm-by, nothing to expire, the claims carry no lapse moment", async () => {
    const a = await agreed();
    expect(a.c.hold).toMatchObject({ tentative: false, agreed: true, confirmBy: null, confirmedBy: { challenger: true, challenged: true }, court: "Agree Court A", date: a.day, startMin: START });
    const row = await lastHold(a.c.id);
    expect(row).toMatchObject({ agreed_exactly: true, confirm_by: null, made_by: "players", made_by_place: a.top.id });
    expect(row.confirmed_at).not.toBeNull();
    expect(await claimExpiries(a.c.id)).toEqual([null]);
    // Nothing for the scheduler to let go, however long it is left.
    await db().prepare("UPDATE ladder_court_holds SET created_at = datetime('now', '-30 days') WHERE challenge_id = ?").run(a.c.id);
    expect(await sweepExpiredHolds()).toEqual([]);
    await ladderHousekeeping();
    expect((await holdViews([a.c.id])).get(a.c.id)).toMatchObject({ tentative: false });
    // A confirmation by either of them afterwards is a repeat: nothing changes, nobody is told.
    expect(ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id)).hold).toMatchObject({ tentative: false });
    expect(await mailAbout(a.low.user.email, "Please confirm the court")).toHaveLength(0);
  });

  it("keeps what each player agreed: the day, the start, the minutes and the court, as the proposer's and the accepter's own", async () => {
    const a = await agreed();
    const rows = await agreements(a.c.id);
    expect(rows).toHaveLength(2);
    const proposed = rows.find((r) => r.role === "proposed")!;
    const accepted = rows.find((r) => r.role === "accepted")!;
    expect(proposed.player_id).toBe(a.low.id);
    expect(accepted.player_id).toBe(a.top.id);
    for (const r of rows) expect(r).toMatchObject({ held_id: (await lastHold(a.c.id)).id, date: a.day, start_min: START, minutes: a.c.hold!.endMin - START, court_id: courtA });
    // The other player is told, in the email, that the exact time is agreed and nobody has to confirm again.
    const told = await mailAbout(a.low.user.email, "You both agreed this exact time");
    expect(told).toHaveLength(1);
    expect(told[0].body).not.toContain("Please confirm the court");
  });

  it("accepting with the very same day and time named is the same agreement; a different time named is a counter-proposal", async () => {
    const s = await ladder({}, 4);
    const [, top, low, third] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    expect(ok(await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START })).hold).toMatchObject({ tentative: false, agreed: true });
    const other = await propose(s.l, third, s.people[0], freshDay(), START);
    const counter = ok(await answer(s.people[0].user.id, other.id, { accept: true, onDate: other.proposedOn!, minute: START + 30 }));
    expect(counter.hold).toMatchObject({ tentative: true, agreed: false, startMin: START + 30, confirmedBy: { challenger: false, challenged: false } });
    expect(await agreements(other.id)).toEqual([]);
  });

  it("a counter-proposal the other side then accepts unchanged is an agreement, the counter's proposer being the one who proposed", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START + 60 }));
    const c = ok(await answer(low.user.id, made.id, { accept: true }));
    expect(c.hold).toMatchObject({ tentative: false, agreed: true, startMin: START + 60 });
    expect((await agreements(c.id)).find((r) => r.role === "proposed")!.player_id).toBe(top.id);
  });

  it("a day alone, a counter-proposal and a time a manager chose are not an agreement: a day alone holds nothing, the others are tentative until both confirm", async () => {
    // A day alone, accepted: no time, no court.
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const dayOnly = await propose(s.l, low, top, freshDay());
    const accepted = ok(await answer(top.user.id, dayOnly.id, { accept: true }));
    expect(accepted.hold).toBeNull();
    expect(await holdRows(dayOnly.id)).toEqual([]);
    // A manager names the time: tentative, and each player must confirm it.
    const day = freshDay();
    expect((await send(managerCookie, s.l.id, { action: "hold_move", challengeId: dayOnly.id, onDate: day, minute: START, reason: "Courts are busy that week" })).status).toBe(200);
    expect(await view(s.l, dayOnly.id)).toMatchObject({ hold: { tentative: true, agreed: false, confirmedBy: { challenger: false, challenged: false } } });
    expect(await agreements(dayOnly.id)).toEqual([]);
    ok(await confirmHoldAsPlayer(top.user.id, dayOnly.id));
    expect((await view(s.l, dayOnly.id)).hold).toMatchObject({ tentative: true });
    ok(await confirmHoldAsPlayer(low.user.id, dayOnly.id));
    expect((await view(s.l, dayOnly.id)).hold).toMatchObject({ tentative: false, agreed: false });
    // A counter-proposal: tentative.
    const t = await tentative();
    expect(t.c.hold).toMatchObject({ tentative: true, agreed: false });
  });

  it("on a ladder whose manager turned confirmation off every hold is confirmed, as before", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    expect((await send(managerCookie, s.l.id, { action: "court_time", needsConfirmation: false })).status).toBe(200);
    const day = freshDay();
    const made = await propose(s.l, low, top, day);
    expect(ok(await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START })).hold).toMatchObject({ tentative: false, agreed: false, confirmBy: null });
  });
});

describe("agreement bypasses nothing: the one claim path, the limits, the hours and the database decide", () => {
  it("a court taken between the preview and the acceptance: refused with the reason, nothing reserved, the challenge unchanged", async () => {
    const day = freshDay();
    const s = await ladder({ courtTime: { on: true, courtIds: [courtA, courtB] } }, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, day, START);
    const shown = ok(await previewHoldFor(top.user.id, made.id, { kind: "accept" }));
    if (!shown.applies) throw new Error("a court should be shown");
    const before = { holds: await count("SELECT COUNT(*)::int AS n FROM ladder_court_holds"), version: await versionOf(made.id) };
    // The court shown is then blocked by the venue.
    expect((await blockSlots(shown.courtId!, day, { start: START - 60, end: START + 240 }, "Maintenance")).ok).toBe(true);
    const refused = await answer(top.user.id, made.id, { accept: true, courtId: shown.courtId! });
    expect(refused).toMatchObject({ ok: false, code: "LAD4_COURT_CHANGED", vars: { court: shown.court, date: day } });
    expect(await count("SELECT COUNT(*)::int AS n FROM ladder_court_holds")).toBe(before.holds);
    expect(await statusOf(made.id)).toBe("pending");
    expect(await versionOf(made.id)).toBe(before.version);
    expect(await agreements(made.id)).toEqual([]);
    expect(await mailAbout(low.user.email, "You both agreed this exact time")).toHaveLength(0);
    // An old client that names no court still gets the deterministic choice among what is free: the other court.
    const open = ok(await answer(top.user.id, made.id, { accept: true }));
    expect(open.hold).toMatchObject({ tentative: false, agreed: true });
    expect(open.hold!.courtId).not.toBe(shown.courtId);
  });

  it("a court the ladder does not allow, named by the accepter, is refused and nothing is held", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, freshDay(), START);
    expect(await answer(top.user.id, made.id, { accept: true, courtId: courtC })).toMatchObject({ ok: false, code: "LAD4_COURT_CHANGED" });
    expect(await holdRows(made.id)).toEqual([]);
    expect(await statusOf(made.id)).toBe("pending");
  });

  it("the ladder's live limit still applies to an agreed time, and a refused agreement leaves the challenge as it was", async () => {
    await clean(async () => {
      const s = await ladder({}, 5);
      const [, p2, p3, p4, p5] = s.people;
      await caps(s.l.id, { maxLive: 1 });
      const first = await propose(s.l, p3, p2, freshDay(), START);
      ok(await answer(p2.user.id, first.id, { accept: true }));
      const second = await propose(s.l, p5, p4, freshDay(), START);
      const version = await versionOf(second.id);
      expect(await answer(p4.user.id, second.id, { accept: true })).toMatchObject({ ok: false, code: "LAD2_CAP_LADDER" });
      expect(await statusOf(second.id)).toBe("pending");
      expect(await versionOf(second.id)).toBe(version);
      expect(await agreements(second.id)).toEqual([]);
    });
  });

  it("the venue's opening hours and the play-by day still apply: an agreed time outside them is refused and nothing is held", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const night = await propose(s.l, low, top, freshDay(), 3 * 60);
    expect(await answer(top.user.id, night.id, { accept: true })).toMatchObject({ ok: false, code: "LAD2_CLOSED" });
    expect(await holdRows(night.id)).toEqual([]);
    expect(await statusOf(night.id)).toBe("pending");
    const far = await ladder({}, 3);
    const late = await propose(far.l, far.people[2], far.people[1], addDays(today, 200), START);
    expect(await answer(far.people[1].user.id, late.id, { accept: true })).toMatchObject({ ok: false, code: "LAD2_AFTER" });
    expect(await holdRows(late.id)).toEqual([]);
  });

  it("limits raised as far as they go, with every court blocked, hold nothing: an agreement is no more than a request for the claim", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      await caps(s.l.id, { maxLive: 50, maxActive: 20, maxAbandoned: 50 });
      const day = freshDay();
      expect((await blockSlots(courtA, day, { start: 8 * 60, end: 23 * 60 }, "Closed for a tournament")).ok).toBe(true);
      const made = await propose(s.l, low, top, day, START);
      expect(await answer(top.user.id, made.id, { accept: true })).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
      expect(await holdRows(made.id)).toEqual([]);
      expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE ladder_id = ${s.l.id}`)).toBe(0);
    });
  });
});

describe("the acceptance screen's preview", () => {
  it("names the court that is then actually held, for accepting, agreeing a move and asking for one, and reserves nothing", async () => {
    const day = freshDay();
    const s = await ladder({ courtTime: { on: true, courtIds: [courtA, courtB] } }, 4);
    const [p1, , p3, p4] = s.people;
    // Something already on court B that ends where the match starts makes B the deterministic choice (the one sitting against something).
    expect((await blockSlots(courtB, day, { start: START - 120, end: START - 15 }, "Coaching")).ok).toBe(true);
    const made = await propose(s.l, p4, p3, day, START);
    const claimsBefore = await count("SELECT COUNT(*)::int AS n FROM claims WHERE active");
    const version = await versionOf(made.id);
    const looked = ok(await previewHoldFor(p3.user.id, made.id, { kind: "accept" }));
    if (!looked.applies) throw new Error("applies");
    expect(looked).toMatchObject({ court: "Agree Court B", date: day, startMin: START, effect: "confirmed", replaces: null });
    expect(looked.minutes).toBe(looked.endMin - START);
    // Nothing was reserved or changed by looking.
    expect(await count("SELECT COUNT(*)::int AS n FROM claims WHERE active")).toBe(claimsBefore);
    expect(await holdRows(made.id)).toEqual([]);
    expect(await versionOf(made.id)).toBe(version);
    expect(await statusOf(made.id)).toBe("pending");
    // Accepting with the court shown holds exactly it.
    const done = ok(await answer(p3.user.id, made.id, { accept: true, courtId: looked.courtId! }));
    expect(done.hold).toMatchObject({ courtId: looked.courtId, court: looked.court, tentative: false });
    // Asking for a move: the proposer's look is of the court that would be held if the other agrees, and the move then holds it.
    const day2 = freshDay();
    const asked = ok(await previewHoldFor(p4.user.id, made.id, { kind: "propose_move", onDate: day2, minute: START + 30 }));
    if (!asked.applies) throw new Error("applies");
    expect(asked).toMatchObject({ date: day2, startMin: START + 30, effect: "confirmed", replaces: { court: looked.court, date: day } });
    expect(await liveBlocks(made.id)).toHaveLength(1);
    ok(await proposeMove(p4.user.id, made.id, { onDate: day2, minute: START + 30 }));
    const agreeing = ok(await previewHoldFor(p3.user.id, made.id, { kind: "agree_move" }));
    if (!agreeing.applies) throw new Error("applies");
    expect(agreeing.courtId).toBe(asked.courtId);
    const moved = ok(await answerMove(p3.user.id, made.id, true, { courtId: agreeing.courtId! }));
    expect(moved.hold).toMatchObject({ courtId: agreeing.courtId, date: day2, tentative: false, agreed: true });
    expect(p1.id).toBeGreaterThan(0);
  });

  it("says no court would be held for a day alone, and is only for the players of the challenge: the one who proposed has nothing to accept, a stranger finds nothing", async () => {
    const s = await ladder({}, 5);
    const [, p2, p3, p4, p5] = s.people;
    const dayOnly = await propose(s.l, p3, p2, freshDay());
    expect(ok(await previewHoldFor(p2.user.id, dayOnly.id, { kind: "accept" }))).toEqual({ applies: false });
    const timed = await propose(s.l, p5, p4, freshDay(), START);
    expect(await previewHoldFor(p5.user.id, timed.id, { kind: "accept" })).toMatchObject({ ok: false, code: "LD_NOT_AWAITING" });
    expect(await previewHoldFor(p2.user.id, timed.id, { kind: "accept" })).toMatchObject({ ok: false, code: "LD_NO_CHALLENGE" });
    expect(await previewHoldFor(p4.user.id, timed.id, { kind: "something" })).toMatchObject({ ok: false, status: 400 });
    // Asking to agree a move that nobody asked for, or one's own, is refused as the act would be.
    expect(await previewHoldFor(p4.user.id, timed.id, { kind: "agree_move" })).toMatchObject({ ok: false, code: "LAD2_NO_MOVE" });
  });

  it("refuses for a full ladder and for a day past the play-by day, with the act's own reasons, and holds nothing", async () => {
    await clean(async () => {
      const s = await ladder({}, 5);
      const [, p2, p3, p4, p5] = s.people;
      await caps(s.l.id, { maxLive: 1 });
      ok(await answer(p2.user.id, (await propose(s.l, p3, p2, freshDay(), START)).id, { accept: true }));
      const second = await propose(s.l, p5, p4, freshDay(), START);
      expect(await previewHoldFor(p4.user.id, second.id, { kind: "accept" })).toMatchObject({ ok: false, code: "LAD2_CAP_LADDER" });
      expect(await holdRows(second.id)).toEqual([]);
      const far = await ladder({}, 3);
      const late = await propose(far.l, far.people[2], far.people[1], addDays(today, 200), START);
      expect(await previewHoldFor(far.people[1].user.id, late.id, { kind: "accept" })).toMatchObject({ ok: false, code: "LAD2_AFTER" });
    });
  });

  it("is a route of the challenge's own players: they see the preview, a stranger does not, and a signed-out visitor is refused", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, freshDay(), START);
    const ask = async (who: User | null) => challengeRoute.POST(req(`/api/ladders/${s.l.id}/challenges/${made.id}`, "POST", who ? await cookieOf(who) : undefined, { action: "preview_hold", for: "accept" }), ctx2(s.l.id, made.id));
    const seen = await ask(top.user);
    expect(seen.status).toBe(200);
    expect((await seen.json()).preview).toMatchObject({ applies: true, court: "Agree Court A", effect: "confirmed" });
    expect((await ask(await person("Stranger"))).status).toBe(404);
    expect((await ask(null)).status).toBe(401);
    // Looking changed nothing.
    expect(await holdRows(made.id)).toEqual([]);
    // The acceptance by the route carries the court shown.
    const shown = (await (await ask(top.user)).json()).preview;
    const accepted = await challengeRoute.POST(req(`/api/ladders/${s.l.id}/challenges/${made.id}`, "POST", await cookieOf(top.user), { action: "accept", courtId: shown.courtId }), ctx2(s.l.id, made.id));
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).challenge.hold).toMatchObject({ courtId: shown.courtId, tentative: false });
  });
});

describe("a change that is not both players' agreement needs renewed consent", () => {
  it("a manager's move of an agreed hold is tentative again with a fresh window; both are told what changed; each confirms the new specification", async () => {
    const a = await agreed();
    const was = await lastHold(a.c.id);
    const day2 = freshDay();
    expect((await send(managerCookie, a.l.id, { action: "hold_move", challengeId: a.c.id, onDate: day2, minute: START + 45, reason: "A tournament needs the court" })).status).toBe(200);
    const now = (await view(a.l, a.c.id)).hold!;
    expect(now).toMatchObject({ tentative: true, agreed: false, date: day2, startMin: START + 45, changed: { date: a.day, startMin: START, court: "Agree Court A" }, confirmedBy: { challenger: false, challenged: false } });
    expect(typeof now.confirmBy).toBe("string");
    const row = await lastHold(a.c.id);
    expect(row.id).not.toBe(was.id);
    expect(JSON.parse(row.changed_from!)).toMatchObject({ date: a.day, startMin: START });
    expect(await claimExpiries(a.c.id)).toEqual([expect.any(Number)]);
    // Both are told what it was and what it is, why, and that they must confirm.
    for (const p of [a.low, a.top]) {
      const told = await mailAbout(p.user.email, "The match time or court was changed");
      expect(told).toHaveLength(1);
      expect(told[0].body).toContain(a.day);
      expect(told[0].body).toContain(day2);
      expect(told[0].body).toContain("A tournament needs the court");
      expect(told[0].body).toContain("Please confirm the new court");
    }
    // The agreement rows of the first hold are history; the new hold has none until the players confirm.
    expect((await agreements(a.c.id)).every((r) => r.held_id === was.id)).toBe(true);
    ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id));
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: true, confirmedBy: { challenged: true, challenger: false } });
    ok(await confirmHoldAsPlayer(a.low.user.id, a.c.id));
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: false });
  });

  it("a change of court alone is material too, and one that moves nothing is not: the same day, start and court keep the agreement, its confirmations and its history", async () => {
    const a = await agreed({ courtTime: { on: true, courtIds: [courtA, courtB] } });
    const firstCourt = a.c.hold!.courtId!;
    const other = firstCourt === courtA ? courtB : courtA;
    // Nothing material: same day, same start, no court named. The agreement stands.
    const was = await lastHold(a.c.id);
    expect((await send(managerCookie, a.l.id, { action: "hold_move", challengeId: a.c.id, onDate: a.day, minute: START, reason: "Re-laid the same court" })).status).toBe(200);
    const same = (await view(a.l, a.c.id)).hold!;
    expect(same).toMatchObject({ tentative: false, agreed: true, changed: null, courtId: firstCourt, confirmedBy: { challenger: true, challenged: true } });
    const rows = await agreements(a.c.id);
    expect(rows.filter((r) => r.held_id === (rows.at(-1)!).held_id)).toHaveLength(2);
    expect((await lastHold(a.c.id)).id).not.toBe(was.id);
    // Another court: material, so tentative again and it says so.
    expect((await send(managerCookie, a.l.id, { action: "hold_move", challengeId: a.c.id, onDate: a.day, minute: START, courtId: other, reason: "Court resurfacing" })).status).toBe(200);
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: true, courtId: other, changed: { court: expect.any(String) } });
  });

  it("an extension, a note and a repeated confirmation never reset agreement or confirmations", async () => {
    const a = await tentative();
    ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id));
    expect(await staffHold(a.c.id, { adminId, name: "Mina" }, { extend: true }, "Players are away this week")).toMatchObject({ ok: true });
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: true, extended: true, confirmedBy: { challenged: true, challenger: false } });
    ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id));
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ confirmedBy: { challenged: true, challenger: false } });
    // An agreed hold has nothing to extend and nothing to reset.
    const b = await agreed();
    expect(await staffHold(b.c.id, { adminId, name: "Mina" }, { extend: true }, "Not needed here")).toMatchObject({ ok: false, code: "LAD3_NOT_TENTATIVE" });
    expect((await view(b.l, b.c.id)).hold).toMatchObject({ tentative: false, agreed: true });
  });

  it("a move both players agree is again an exact agreement for the new specification, and the earlier one stays as history", async () => {
    const a = await agreed();
    const day2 = freshDay();
    ok(await proposeMove(a.low.user.id, a.c.id, { onDate: day2, minute: START + 60 }));
    const moved = ok(await answerMove(a.top.user.id, a.c.id, true));
    expect(moved.hold).toMatchObject({ tentative: false, agreed: true, date: day2, startMin: START + 60 });
    const rows = await agreements(a.c.id);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.date === a.day)).toHaveLength(2);
    expect(rows.filter((r) => r.date === day2 && r.start_min === START + 60)).toHaveLength(2);
    expect((await holdRows(a.c.id)).map((h) => h.released_reason)).toEqual(["moved", null]);
  });

  it("backward compatibility: a hold already confirmed stays confirmed, and a tentative one keeps its window", async () => {
    const a = await tentative();
    const t = await lastHold(a.c.id);
    const b = await agreed();
    await ladderHousekeeping();
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: true });
    expect(new Date((await lastHold(a.c.id)).confirm_by!).getTime()).toBe(new Date(t.confirm_by!).getTime());
    expect((await view(b.l, b.c.id)).hold).toMatchObject({ tentative: false });
  });
});

describe("races", () => {
  it("two exact acceptances at once for one court and time: one is held and confirmed, the other refused with nothing held, and the database holds one claim", async () => {
    const day = freshDay();
    const one = await ladder({}, 3);
    const two = await ladder({}, 3);
    const x = await propose(one.l, one.people[2], one.people[1], day, START);
    const y = await propose(two.l, two.people[2], two.people[1], day, START);
    const done = await Promise.all([answer(one.people[1].user.id, x.id, { accept: true }), answer(two.people[1].user.id, y.id, { accept: true })]);
    expect(done.filter((r) => r.ok)).toHaveLength(1);
    expect(done.filter((r) => !r.ok)[0]).toMatchObject({ code: "LAD2_NO_COURT" });
    const winner = done[0].ok ? x : y;
    const loser = done[0].ok ? y : x;
    expect((await agreements(winner.id)).length).toBe(2);
    expect(await agreements(loser.id)).toEqual([]);
    expect(await statusOf(loser.id)).toBe("pending");
    expect(await count(`SELECT COUNT(*)::int AS n FROM claims c JOIN blocks k ON k.id = c.block_id WHERE k.court_id = ${courtA} AND k.date = '${day}' AND c.active`)).toBe(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE court_id = ${courtA} AND date = '${day}' AND released_at IS NULL`)).toBe(1);
  });

  it("the same acceptance twice at once (a double tap): one hold, once, the second told the challenge has moved on", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, freshDay(), START);
    const done = await Promise.all([answer(top.user.id, made.id, { accept: true }), answer(top.user.id, made.id, { accept: true })]);
    expect(done.filter((r) => r.ok)).toHaveLength(1);
    expect(await holdRows(made.id)).toHaveLength(1);
    expect(await agreements(made.id)).toHaveLength(2);
  });

  it("an acceptance racing a booking for the same court and time: whichever is first, the other is refused and nothing overlaps", async () => {
    const day = freshDay();
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, day, START);
    const stranger = await person("Walker");
    const [accepted, booked] = await Promise.all([
      answer(top.user.id, made.id, { accept: true }),
      createBooking({ courtId: courtA, date: day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id, staff: { override: true } }),
    ]);
    expect(Number(accepted.ok) + Number(booked.ok)).toBe(1);
    if (accepted.ok) expect(accepted.value.hold).toMatchObject({ tentative: false, agreed: true });
    else expect(await holdRows(made.id)).toEqual([]);
    // Nothing anywhere holds a minute twice.
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM blocks a JOIN blocks b ON a.court_id = b.court_id AND a.date = b.date AND a.id < b.id
          WHERE a.court_id = ${courtA} AND a.date = '${day}' AND a.start_min < b.end_min AND b.start_min < a.end_min`
      )
    ).toBe(0);
  });

  it("an acceptance racing a staff block for the same court: one gets it, and an agreement that failed leaves the challenge pending", async () => {
    const day = freshDay();
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, day, START);
    const [accepted, blocked] = await Promise.all([answer(top.user.id, made.id, { accept: true }), blockSlots(courtA, day, { start: START, end: START + 90 }, "Staff block")]);
    // A staff block leaves a hold's time alone (the block takes only what is free), so the block is made either way; what matters is that nothing is held twice.
    expect(blocked.ok).toBe(true);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM blocks a JOIN blocks b ON a.court_id = b.court_id AND a.date = b.date AND a.id < b.id
          WHERE a.court_id = ${courtA} AND a.date = '${day}' AND a.start_min < b.end_min AND b.start_min < a.end_min`
      )
    ).toBe(0);
    if (!accepted.ok) {
      expect(accepted).toMatchObject({ code: "LAD2_NO_COURT" });
      expect(await statusOf(made.id)).toBe("pending");
      expect(await holdRows(made.id)).toEqual([]);
    } else {
      expect(await liveBlocks(made.id)).toHaveLength(1);
    }
  });

  it("an acceptance racing a manager's move onto the same court and time: one gets it, the other keeps what it had", async () => {
    const day = freshDay();
    const one = await ladder({}, 3);
    const two = await ladder({}, 3);
    // Two's challenge is already held at another time; the manager moves it onto the time One's players are accepting.
    const y = await propose(two.l, two.people[2], two.people[1], freshDay(), START + 240);
    const two2 = ok(await answer(two.people[1].user.id, y.id, { accept: true }));
    const x = await propose(one.l, one.people[2], one.people[1], day, START);
    const [accepted, moved] = await Promise.all([
      answer(one.people[1].user.id, x.id, { accept: true }),
      send(managerCookie, two.l.id, { action: "hold_move", challengeId: two2.id, onDate: day, minute: START, reason: "Reshuffle" }),
    ]);
    expect(Number(accepted.ok) + Number(moved.status === 200)).toBe(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE court_id = ${courtA} AND date = '${day}' AND start_min = ${START} AND released_at IS NULL`)).toBe(1);
    if (!accepted.ok) expect(await statusOf(x.id)).toBe("pending");
    else expect((await liveBlocks(two2.id))[0].date).not.toBe(day);
  });
});

// ============================================================================ expired holds do not count

describe("an expired or released hold stops counting towards the player's active allowance", () => {
  it("the moment it lapses, before the scheduler runs and after it: the ladder's live count and the player's allowance drop, the court is free, the row is kept as history", async () => {
    await clean(async () => {
      const a = await tentative();
      await caps(a.l.id, { maxActive: 1 });
      expect((await resolveHoldLimits({ id: a.l.id, venueId })).inUse).toBe(1);
      await lapse(a.c.id);
      // Lazy: nothing has run, and the hold is already not live to the count.
      expect((await resolveHoldLimits({ id: a.l.id, venueId })).inUse).toBe(0);
      await ladderHousekeeping();
      expect((await resolveHoldLimits({ id: a.l.id, venueId })).inUse).toBe(0);
      const row = await lastHold(a.c.id);
      expect(row).toMatchObject({ released_reason: "expired", abandoned_place: a.top.id });
      expect(row.released_at).not.toBeNull();
      expect(row.abandoned_at).not.toBeNull();
      expect(await liveBlocks(a.c.id)).toEqual([]);
      // The same two players agree a time again: the allowance of 1 is free, so it is held.
      ok(await proposeMove(a.low.user.id, a.c.id, { onDate: a.day, minute: START + 60 }));
      expect(ok(await answerMove(a.top.user.id, a.c.id, true)).hold).toMatchObject({ startMin: START + 60, tentative: false });
      expect((await holdRows(a.c.id)).map((h) => h.released_reason)).toEqual(["expired", null]);
    });
  });

  it("a player with four expired holds can create a new one: expiry is never held against a normal player", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      for (let i = 0; i < 4; i++) {
        const day = freshDay();
        const made = await propose(s.l, low, top, day);
        const c = ok(await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START }));
        await lapse(c.id);
        await ladderHousekeeping();
        ok(await withdraw(low.user.id, c.id));
      }
      // Four holds expired in the week, a threshold of six: not blocked, and the allowance of four is all free.
      expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE released_reason = 'expired' AND abandoned_place = ${top.id}`)).toBe(4);
      const day = freshDay();
      const made = await propose(s.l, low, top, day);
      expect(ok(await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START })).hold).toMatchObject({ tentative: true });
    });
  });

  it("released by the venue, or played, frees the allowance and is never an abandoned hold", async () => {
    await clean(async () => {
      const a = await agreed();
      await caps(a.l.id, { maxActive: 1 });
      expect((await resolveHoldLimits({ id: a.l.id, venueId })).inUse).toBe(1);
      expect((await send(managerCookie, a.l.id, { action: "hold_release", challengeId: a.c.id, reason: "Court needed for a league" })).status).toBe(200);
      expect((await resolveHoldLimits({ id: a.l.id, venueId })).inUse).toBe(0);
      expect(await lastHold(a.c.id)).toMatchObject({ released_reason: "staff", abandoned_place: null });
      // Played: a result stands, the hold is let go as played.
      const b = await agreed();
      ok(await report(b.low.user.id, b.c.id, { winner: b.low.id, score: "21-10, 21-12" }));
      ok(await confirm(b.top.user.id, b.c.id, { version: (await myPlaces(b.top.user.id, b.l.id))[0].open[0].version }));
      expect(await lastHold(b.c.id)).toMatchObject({ released_reason: "played", abandoned_place: null });
      expect((await resolveHoldLimits({ id: b.l.id, venueId })).inUse).toBe(0);
    });
  });
});

describe("the anti-abuse limit: only holds a player created and abandoned count, and the consequence is a cooldown", () => {
  /** One counter-accepted hold by `top`, let lapse and swept, then the challenge withdrawn so the pair can start again. */
  async function abandonOne(s: { l: { id: number }; people: Pl[] }) {
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day);
    const accepted = await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START });
    if (!accepted.ok) return accepted;
    await lapse(accepted.value.id);
    await ladderHousekeeping();
    ok(await withdraw(low.user.id, accepted.value.id));
    return accepted;
  }

  it("past the threshold a new hold is refused with a plain message and nothing is held; the active limits are separate and untouched", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      await caps(s.l.id, { maxAbandoned: 2 });
      expect((await resolveHoldLimits({ id: s.l.id, venueId })).abandonedThreshold).toBe(2);
      ok(await abandonOne(s));
      ok(await abandonOne(s));
      const day = freshDay();
      const made = await propose(s.l, low, top, day);
      const refused = await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START });
      expect(refused).toMatchObject({ ok: false, code: "LAD4_COOLDOWN", vars: { hours: 24, n: 2, days: 7 } });
      expect(await holdRows(made.id)).toEqual([]);
      expect(await statusOf(made.id)).toBe("pending");
      // It is the same for an agreed time (a cooldown is about creating holds), and the preview says so too; the active limits are separate and untouched.
      expect(await previewHoldFor(top.user.id, made.id, { kind: "accept", onDate: day, minute: START })).toMatchObject({ ok: false, code: "LAD4_COOLDOWN" });
      expect(await resolveHoldLimits({ id: s.l.id, venueId })).toMatchObject({ inUse: 0, maxActivePerPlayer: 4 });
    });
  });

  it("the cooldown ends once its hours have passed since the last abandoned hold, and a hold is allowed again", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      await caps(s.l.id, { maxAbandoned: 2 });
      ok(await abandonOne(s));
      ok(await abandonOne(s));
      await db().prepare("UPDATE ladder_court_holds SET abandoned_at = now() - interval '25 hours' WHERE abandoned_place = ?").run(top.id);
      const day = freshDay();
      const made = await propose(s.l, low, top, day);
      expect(ok(await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START })).hold).toMatchObject({ tentative: true });
      // The window: holds abandoned more than 7 days ago no longer count at all.
      expect((await abandonedCount(top.id, 7)).count).toBe(2);
      await db().prepare("UPDATE ladder_court_holds SET abandoned_at = now() - interval '8 days' WHERE abandoned_place = ?").run(top.id);
      expect((await abandonedCount(top.id, 7)).count).toBe(0);
    });
  });

  it("counts only abandoned holds: played, released by the venue, a manager's that expired, and a confirmed one withdrawn do not; a tentative one withdrawn does, against the one who withdrew", async () => {
    await clean(async () => {
      // Released by the venue.
      const a = await tentative();
      expect((await send(managerCookie, a.l.id, { action: "hold_release", challengeId: a.c.id, reason: "League night" })).status).toBe(200);
      expect(await lastHold(a.c.id)).toMatchObject({ released_reason: "staff", abandoned_place: null });
      // A manager's hold that nobody confirmed: the players did not create it.
      const b = await ladder({}, 3);
      const day = freshDay();
      const dayOnly = await propose(b.l, b.people[2], b.people[1], day);
      ok(await answer(b.people[1].user.id, dayOnly.id, { accept: true }));
      expect((await send(managerCookie, b.l.id, { action: "hold_move", challengeId: dayOnly.id, onDate: day, minute: START, reason: "Courts are busy" })).status).toBe(200);
      await lapse(dayOnly.id);
      await ladderHousekeeping();
      expect(await lastHold(dayOnly.id)).toMatchObject({ released_reason: "expired", made_by: "staff", abandoned_place: null, abandoned_at: null });
      // Confirmed by both, then withdrawn: not abandoned.
      const c = await tentative();
      ok(await confirmHoldAsPlayer(c.top.user.id, c.c.id));
      ok(await confirmHoldAsPlayer(c.low.user.id, c.c.id));
      ok(await withdraw(c.low.user.id, c.c.id));
      expect(await lastHold(c.c.id)).toMatchObject({ released_reason: "withdrawn", abandoned_place: null });
      // Withdrawn while still tentative: counted, against the one who withdrew.
      const d = await tentative();
      ok(await withdraw(d.low.user.id, d.c.id));
      expect(await lastHold(d.c.id)).toMatchObject({ released_reason: "withdrawn", abandoned_place: d.low.id });
    });
  });

  it("is logged by the system once the threshold is reached, kept as history, shown to staff in the ladder and never to players; the threshold is a manager's and bounded", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      await caps(s.l.id, { maxAbandoned: 2 });
      ok(await abandonOne(s));
      const named = async () => (await listActivity([venueId], { limit: 500 })).filter((e) => e.action === "ladder.hold_cooldown" && e.detail?.includes(top.user.name));
      expect(await named()).toHaveLength(0);
      ok(await abandonOne(s));
      const cooldown = await named();
      expect(cooldown).toHaveLength(1);
      expect(cooldown[0].adminName).toBe("System");
      expect(cooldown[0].detail).toContain("limit 2");
      // The rows are history: nothing was deleted.
      expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE abandoned_place = ${top.id} AND released_reason = 'expired'`)).toBe(2);
      // Staff see each player's count and whether they are cooling down.
      const staff = (await ladderDetail(s.l.id, { forStaff: true }))!;
      expect(staff.holdAbandoned).toEqual([expect.objectContaining({ playerId: top.id, name: top.user.name, count: 2, coolingUntil: expect.any(String) })]);
      expect(staff.holdLimits).toMatchObject({ abandonedThreshold: 2, from: { abandoned: "ladder" }, abuse: { windowDays: 7, cooldownHours: 24 } });
      // Players and the public are shown none of it.
      for (const shown of [JSON.stringify(await ladderDetail(s.l.id)), JSON.stringify(await myPlaces(top.user.id, s.l.id)), JSON.stringify(await myPlaces(low.user.id, s.l.id))]) {
        expect(shown).not.toContain("holdAbandoned");
        expect(shown).not.toContain("abandoned");
        expect(shown).not.toContain("coolingUntil");
      }
      // A manager's, bounded: below the install's minimum is refused with the bounds; the desk and another venue cannot set it.
      const low1 = await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxAbandoned: 1 });
      expect(low1.status).toBe(400);
      expect(await low1.json()).toMatchObject({ code: "LAD3_BOUNDS", vars: { what: "abandoned", min: 2, max: 50 } });
      expect((await send(undefined, s.l.id, { action: "hold_limits", scope: "ladder", maxAbandoned: 3 })).status).toBe(401);
      const entry = (await listActivity([venueId], { limit: 500 })).find((e) => e.action === "ladder.hold_limits" && e.detail?.includes("holds abandoned before a cooldown default to 2"));
      expect(entry?.adminName).toBe("Mina Manager");
    });
  });

  it("an override is resolved ladder, then venue, then install, like the other limits", async () => {
    await clean(async () => {
      const s = await ladder({}, 2);
      expect(await resolveHoldLimits({ id: s.l.id, venueId })).toMatchObject({ abandonedThreshold: 6, maxActivePerPlayer: 4, from: { abandoned: "install", active: "install" } });
      await caps(s.l.id, { maxAbandoned: 4, maxActive: 3 }, "venue");
      expect(await resolveHoldLimits({ id: s.l.id, venueId })).toMatchObject({ abandonedThreshold: 4, maxActivePerPlayer: 3, from: { abandoned: "venue", active: "venue" } });
      await caps(s.l.id, { maxAbandoned: 5 });
      expect(await resolveHoldLimits({ id: s.l.id, venueId })).toMatchObject({ abandonedThreshold: 5, maxActivePerPlayer: 3, from: { abandoned: "ladder", active: "venue" } });
      await caps(s.l.id, { maxAbandoned: null });
      expect(await resolveHoldLimits({ id: s.l.id, venueId })).toMatchObject({ abandonedThreshold: 4 });
    });
  });
});

describe("the old creation quota is replaced, and what was set under its name carries over", () => {
  it("the old key `maxWeek` is read and written as the per-player active limit, and shown under both names", async () => {
    await clean(async () => {
      const s = await ladder({}, 2);
      await caps(s.l.id, { maxWeek: 3 });
      const limits = (await ladderDetail(s.l.id, { forStaff: true }))!.holdLimits!;
      expect(limits).toMatchObject({ maxActivePerPlayer: 3, maxPerPlayerWeek: 3, from: { active: "ladder", week: "ladder" }, ladder: { maxActivePerPlayer: 3, maxPerPlayerWeek: 3 } });
      const bad = await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxWeek: 99 });
      expect(await bad.json()).toMatchObject({ code: "LAD3_BOUNDS", vars: { what: "active", min: 1, max: 20 } });
    });
  });

  it("a hold made earlier in the week no longer matters: four holds made and withdrawn leave the allowance free", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      for (let i = 0; i < 5; i++) {
        const c = ok(await answer(top.user.id, (await propose(s.l, low, top, freshDay(), START)).id, { accept: true }));
        expect(c.hold).not.toBeNull();
        ok(await withdraw(low.user.id, c.id));
      }
      const last = ok(await answer(top.user.id, (await propose(s.l, low, top, freshDay(), START)).id, { accept: true }));
      expect(last.hold).toMatchObject({ tentative: false });
    });
  });

  it("migration 0292 carries what was set under the old key: install default and bounds, the venue's setting and each ladder's override become the per-player active limit", async () => {
    await clean(async () => {
      const s = await ladder({}, 2);
      // As the database stood before the migration: the new columns do not exist, the old ones hold what was set under the old name.
      await db().exec(
        `ALTER TABLE ladder_hold_limits DROP COLUMN max_active_per_player, DROP COLUMN active_min, DROP COLUMN active_max;
         ALTER TABLE venue_ladder_hold_limits DROP COLUMN max_active_per_player;
         ALTER TABLE ladders DROP COLUMN cap_active;`
      );
      await db().prepare("UPDATE ladder_hold_limits SET max_per_player_week = 5, week_min = 2, week_max = 9 WHERE id = 1").run();
      await db().prepare("INSERT INTO venue_ladder_hold_limits (venue_id, max_live_per_ladder, max_per_player_week) VALUES (?, NULL, 7) ON CONFLICT (venue_id) DO UPDATE SET max_per_player_week = 7").run(venueId);
      await db().prepare("UPDATE ladders SET cap_week = 3 WHERE id = ?").run(s.l.id);
      const sql = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "0292_ladder_agreement_and_active_hold_limits.sql"), "utf8");
      await db().exec(sql);
      expect(await db().prepare("SELECT max_active_per_player, active_min, active_max, max_per_player_week FROM ladder_hold_limits WHERE id = 1").get()).toEqual({ max_active_per_player: 5, active_min: 2, active_max: 9, max_per_player_week: 5 });
      expect(await db().prepare("SELECT max_active_per_player, max_per_player_week FROM venue_ladder_hold_limits WHERE venue_id = ?").get(venueId)).toEqual({ max_active_per_player: 7, max_per_player_week: 7 });
      expect(await db().prepare("SELECT cap_active, cap_week FROM ladders WHERE id = ?").get(s.l.id)).toEqual({ cap_active: 3, cap_week: 3 });
      // The resolution reads them: the ladder's own, then the venue's.
      expect(await resolveHoldLimits({ id: s.l.id, venueId })).toMatchObject({ maxActivePerPlayer: 3, from: { active: "ladder" }, venue: { maxActivePerPlayer: 7 } });
      // Running it again changes nothing (it only copies when it adds the column).
      await db().prepare("UPDATE ladders SET cap_active = 4 WHERE id = ?").run(s.l.id);
      await db().exec(sql);
      expect(await db().prepare("SELECT cap_active, cap_week FROM ladders WHERE id = ?").get(s.l.id)).toEqual({ cap_active: 4, cap_week: 3 });
    });
  });
});
