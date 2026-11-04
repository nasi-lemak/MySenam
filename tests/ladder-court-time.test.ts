import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import {
  answer,
  attachBooking,
  challenge,
  confirm,
  createLadder,
  decide,
  detachBooking,
  join,
  ladderHousekeeping,
  myPlaces,
  report,
  withdraw,
  type LadderInput,
} from "../src/lib/ladders";
import { adminCancelBooking, cancelBooking, createBooking, createCourt, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as challengeRoute from "../src/app/api/ladders/[id]/challenges/[challengeId]/route";

/**
 * A ladder challenge holds no court time (docs/features/tournaments.md#club-ladders, "Court time and booking"; lib/ladders.ts
 * `attachBooking`; migration 0276). The two players book as anybody does, through the ordinary booking path with every check of
 * availability, price, payment and eligibility, and may add that booking's code to the challenge. Only a confirmed booking reserves a court.
 */

vi.setConfig({ testTimeout: 60_000 });

let venueId: number;
let adminId: number;
let courtId: number;
let otherSportCourt: number;
let n = 0;
let slot = 0;

async function person(name = "Lad"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Court${n}`, email: `lc${n}@ladder.test`, phone: `01381${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string; code?: string }): T {
  if (!r.ok) throw new Error(`${r.error} (${r.code ?? ""})`);
  return r.value;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courtId = venue.courts.find((c) => c.sport === "badminton")!.id;
  const squash = await createCourt({ venueId, name: "Squash LC", sport: "squash", offPeakRate: 10, peakRate: 12 });
  if (!squash.ok) throw new Error(squash.error);
  otherSportCourt = squash.court.id;
});

/** A ladder of three adults; the challenger (player 3) challenges player 2, who accepts. */
async function accepted(over: Partial<LadderInput> = {}) {
  n++;
  const l = ok(await createLadder({ venueId, name: `Court Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, ...over }, adminId));
  const people: { user: User; id: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const user = await person();
    people.push({ user, id: ok(await join(user, l.id, { adult: true })).playerId });
  }
  const [, top, low] = people;
  const made = ok(await challenge(low.user.id, l.id, low.id, top.id, {}));
  const done = ok(await answer(top.user.id, made.id, { accept: true }));
  return { l, people, challenger: low, challenged: top, challengeId: done.id };
}

/** A booking made the ordinary way, a few days out, an hour nobody else has. */
async function booking(user: User, over: { courtId?: number; sport?: string; date?: string } = {}) {
  slot++;
  const made = await createBooking({
    courtId: over.courtId ?? courtId,
    date: over.date ?? addDays(todayISO(), 2 + (slot % 10)),
    hours: [8 + (Math.floor(slot / 10) % 12)],
    name: user.name,
    phone: user.phone,
    userId: user.id,
    ...(over.sport ? { sport: over.sport as never } : {}),
  });
  if (!made.ok) throw new Error(`booking: ${made.error}`);
  return made.booking;
}

const count = async (sql: string) => ((await getDb().prepare(sql).get()) as { n: number }).n;
const holds = async () => ({
  claims: await count("SELECT COUNT(*)::int AS n FROM claims"),
  blocks: await count("SELECT COUNT(*)::int AS n FROM blocks"),
  bookings: await count("SELECT COUNT(*)::int AS n FROM bookings"),
});
const attachments = async (challengeId: number) => (await getDb().prepare("SELECT * FROM ladder_challenge_bookings WHERE challenge_id = ? ORDER BY id").all(challengeId)) as { booking_id: number; dropped_at: string | null; dropped_reason: string | null }[];
const mail = async (to: string) => (await getDb().prepare("SELECT subject, body FROM messages WHERE kind = 'programme' AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];

describe("no court time is held for a challenge", () => {
  it("creating, proposing a time, accepting, withdrawing, reporting, confirming and deciding write no claim, block or booking", async () => {
    const before = await holds();
    const l = ok(await createLadder({ venueId, name: `No Hold Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null, settings: { cooldownDays: 0 } }, adminId));
    const people: { user: User; id: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const user = await person();
      people.push({ user, id: ok(await join(user, l.id, { adult: true })).playerId });
    }
    const [, p2, p3, p4] = people;
    const tomorrow = addDays(todayISO(), 1);
    // Created with a proposed day and time, countered with another, accepted: no hold at any step.
    const c1 = ok(await challenge(p4.user.id, l.id, p4.id, p3.id, { onDate: tomorrow, minute: 19 * 60 }));
    expect(await holds()).toEqual(before);
    const c1b = ok(await answer(p3.user.id, c1.id, { propose: true, onDate: addDays(tomorrow, 1), minute: 20 * 60 }));
    expect(c1b).toMatchObject({ proposedOn: addDays(tomorrow, 1), proposedMin: 20 * 60 });
    expect(await holds()).toEqual(before);
    const c1c = ok(await answer(p4.user.id, c1.id, { accept: true }));
    expect(c1c).toMatchObject({ status: "accepted", agreedOn: addDays(tomorrow, 1), agreedMin: 20 * 60 });
    expect(await holds()).toEqual(before);
    // Reported, confirmed: a result, still no hold.
    ok(await report(p4.user.id, c1.id, { winner: p4.id, score: "21-15, 21-18" }));
    ok(await confirm(p3.user.id, c1.id, { version: (await myPlaces(p3.user.id, l.id))[0].open[0].version }));
    expect(await holds()).toEqual(before);
    // Another challenge withdrawn after acceptance, one declined, one decided by a manager, one that lapses: none holds anything.
    const c2 = ok(await challenge(p3.user.id, l.id, p3.id, p2.id, { onDate: tomorrow, minute: 18 * 60 }));
    ok(await answer(p2.user.id, c2.id, { accept: true }));
    ok(await withdraw(p3.user.id, c2.id));
    const c3 = ok(await challenge(p3.user.id, l.id, p3.id, p2.id, {}));
    ok(await answer(p2.user.id, c3.id, { decline: true }));
    const c4 = ok(await challenge(p3.user.id, l.id, p3.id, p2.id, {}));
    ok(await decide(c4.id, { adminId, name: "Mina Manager" }, { winner: p3.id, score: "21-5, 21-5" }, "Settled at the desk"));
    expect(await holds()).toEqual(before);
    const c5 = ok(await challenge(p4.user.id, l.id, p4.id, p3.id, {}));
    ok(await answer(p3.user.id, c5.id, { accept: true }));
    await getDb().prepare("UPDATE ladder_challenges SET play_by = ? WHERE id = ?").run(addDays(todayISO(), -1), c5.id);
    await ladderHousekeeping();
    expect((await getDb().prepare("SELECT status FROM ladder_challenges WHERE id = ?").get(c5.id)) as { status: string }).toMatchObject({ status: "lapsed" });
    expect(await holds()).toEqual(before);
    // No ladder table refers to a claim or a block at all.
    const cols = (await getDb().prepare("SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'ladder%' AND (column_name LIKE '%claim%' OR column_name LIKE '%block%' OR column_name LIKE '%hold%')").all()) as unknown[];
    expect(cols).toEqual([]);
  });
});

describe("a booking the players made, attached to an accepted challenge", () => {
  it("is shown on the challenge to both, changes nothing about the booking, and is added once", async () => {
    const { l, challenger, challenged, challengeId } = await accepted();
    const b = await booking(challenger.user);
    const before = await holds();
    const row = async () => (await getDb().prepare("SELECT status, total_price::float AS price, payment_status, court_id, date, start_min, end_min FROM bookings WHERE id = ?").get(b.id)) as Record<string, unknown>;
    const bookingBefore = await row();
    const attached = ok(await attachBooking(challenger.user.id, challengeId, b.code.toLowerCase()));
    expect(attached).toMatchObject({ code: b.code, court: expect.any(String), date: b.date });
    // Nothing about the booking, and no new claim, block or slot.
    expect(await row()).toEqual(bookingBefore);
    expect(await holds()).toEqual(before);
    // Both see it ("Court booked: Court 2, 19:00"), the other from their own side.
    for (const p of [challenger, challenged]) {
      const mine = (await myPlaces(p.user.id, l.id))[0];
      expect(mine.open[0].booking).toMatchObject({ code: b.code, date: b.date, startMin: attached.startMin });
      expect(mine.bookingPage).toBe(`/venue/${venueId}?sport=badminton`);
    }
    expect((await mail(challenged.user.email)).some((m) => m.subject.includes("A court is booked for your challenge"))).toBe(true);
    // One at a time: another code, or the same one, is refused until it is taken off.
    const b2 = await booking(challenged.user);
    expect(await attachBooking(challenged.user.id, challengeId, b2.code)).toMatchObject({ ok: false, code: "LD_BK_HAVE" });
    expect(await detachBooking(challenged.user.id, challengeId)).toMatchObject({ ok: true });
    expect((await myPlaces(challenger.user.id, l.id))[0].open[0].booking).toBeNull();
    expect(await row()).toEqual(bookingBefore);
    expect(await detachBooking(challenged.user.id, challengeId)).toMatchObject({ ok: false, code: "LD_BK_NONE" });
    expect(await attachBooking(challenged.user.id, challengeId, b2.code)).toMatchObject({ ok: true });
    // The other player's booking counts too: made through either of the two accounts.
    expect((await myPlaces(challenger.user.id, l.id))[0].open[0].booking!.code).toBe(b2.code);
  });

  it("is checked: accepted, confirmed, this venue and sport, today or later, one of the two players', not on another challenge, never probed", async () => {
    const { l, challenger, challenged, challengeId } = await accepted();
    const outsider = await person("Outsider");
    const fine = await booking(challenger.user);
    // A code that is nobody's of the two players is answered as not found: whatever is true of the booking, nothing leaks.
    const strangers = await booking(outsider);
    expect(await attachBooking(challenger.user.id, challengeId, strangers.code)).toMatchObject({ ok: false, code: "LD_BK_NOT_FOUND", status: 404 });
    expect(await attachBooking(challenger.user.id, challengeId, "NOSUCHCODE")).toMatchObject({ ok: false, code: "LD_BK_NOT_FOUND" });
    expect(await attachBooking(challenger.user.id, challengeId, "")).toMatchObject({ ok: false, code: "LD_BK_NOT_FOUND" });
    expect(await attachBooking(challenger.user.id, challengeId, 12345 as never)).toMatchObject({ ok: false, code: "LD_BK_NOT_FOUND" });
    // Somebody who is not in the challenge cannot attach anything to it.
    expect(await attachBooking(outsider.id, challengeId, fine.code)).toMatchObject({ ok: false, code: "LD_NO_CHALLENGE", status: 404 });
    // Another sport's court, though the player's own.
    const squash = await booking(challenger.user, { courtId: otherSportCourt, sport: "squash" });
    expect(await attachBooking(challenger.user.id, challengeId, squash.code)).toMatchObject({ ok: false, code: "LD_BK_SPORT" });
    // Another venue: the booking is the player's, the court another venue's.
    const elsewhere = await getDb().prepare("SELECT id FROM venues WHERE id <> ? LIMIT 1").get(venueId) as { id: number } | undefined;
    if (elsewhere) {
      const far = (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ? AND sport = 'badminton' LIMIT 1").get(elsewhere.id)) as { id: number } | undefined;
      if (far) {
        const away = await booking(challenger.user, { courtId: far.id });
        expect(await attachBooking(challenger.user.id, challengeId, away.code)).toMatchObject({ ok: false, code: "LD_BK_VENUE" });
      }
    }
    // Cancelled, or already past.
    const gone = await booking(challenger.user);
    expect((await cancelBooking(gone.code, challenger.user.phone)).ok).toBe(true);
    expect(await attachBooking(challenger.user.id, challengeId, gone.code)).toMatchObject({ ok: false, code: "LD_BK_STATE" });
    const past = await booking(challenger.user);
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(todayISO(), -1), past.id);
    expect(await attachBooking(challenger.user.id, challengeId, past.code)).toMatchObject({ ok: false, code: "LD_BK_STATE" });
    // Today is allowed.
    const today = await booking(challenged.user);
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(todayISO(), today.id);
    // A booking on another challenge cannot be on this one.
    const second = await accepted();
    expect(await attachBooking(second.challenger.user.id, second.challengeId, fine.code)).toMatchObject({ ok: false, code: "LD_BK_NOT_FOUND" });
    expect(await attachBooking(challenger.user.id, challengeId, fine.code)).toMatchObject({ ok: true });
    // A booking already on one challenge cannot be on another, even for a person who is in both.
    const otherLadder = ok(await createLadder({ venueId, name: `Second Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null }, adminId));
    const rival = await person();
    const rivalPlace = ok(await join(rival, otherLadder.id, { adult: true }));
    const mine = ok(await join(challenger.user, otherLadder.id, { adult: true }));
    const second2 = ok(await challenge(challenger.user.id, otherLadder.id, mine.playerId, rivalPlace.playerId, {}));
    ok(await answer(rival.id, second2.id, { accept: true }));
    expect(await attachBooking(challenger.user.id, second2.id, fine.code)).toMatchObject({ ok: false, code: "LD_BK_TAKEN" });
    // A challenge not yet accepted, or already decided, takes none.
    const pendingL = ok(await createLadder({ venueId, name: `Pending Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null }, adminId));
    const a = await person();
    const b = await person();
    const pa = ok(await join(a, pendingL.id, { adult: true }));
    const pb = ok(await join(b, pendingL.id, { adult: true }));
    const pending = ok(await challenge(b.id, pendingL.id, pb.playerId, pa.playerId, {}));
    expect(await attachBooking(b.id, pending.id, (await booking(b)).code)).toMatchObject({ ok: false, code: "LD_BK_NOT_OPEN" });
    expect(l.id).toBeGreaterThan(0);
  });

  it("a cancelled booking drops off the challenge once, both players are told, and the challenge stands; the same through the scheduler", async () => {
    const one = await accepted();
    const b = await booking(one.challenger.user);
    ok(await attachBooking(one.challenger.user.id, one.challengeId, b.code));
    expect((await adminCancelBooking(b.code)).ok).toBe(true);
    const rows = await attachments(one.challengeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ booking_id: b.id, dropped_reason: "cancelled" });
    expect(rows[0].dropped_at).not.toBeNull();
    for (const p of [one.challenger, one.challenged]) {
      expect((await mail(p.user.email)).filter((m) => m.subject.includes("booking for your challenge") && m.subject.includes("cancelled"))).toHaveLength(1);
      expect((await myPlaces(p.user.id, one.l.id))[0].open[0]).toMatchObject({ status: "accepted", booking: null });
    }
    // Idempotent: the scheduler running again changes and tells nobody.
    await ladderHousekeeping();
    await ladderHousekeeping();
    expect(await attachments(one.challengeId)).toHaveLength(1);
    expect((await mail(one.challenger.user.email)).filter((m) => m.subject.includes("booking for your challenge") && m.subject.includes("cancelled"))).toHaveLength(1);
    // A new booking can be added in its place.
    const b2 = await booking(one.challenged.user);
    expect(await attachBooking(one.challenged.user.id, one.challengeId, b2.code)).toMatchObject({ ok: true });
    // A cancellation by a path that never said so (a hold let go, a direct change) is caught by the scheduler.
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b2.id);
    expect((await myPlaces(one.challenger.user.id, one.l.id))[0].open[0].booking).toBeNull();
    await ladderHousekeeping();
    expect((await attachments(one.challengeId)).map((r) => r.dropped_reason)).toEqual(["cancelled", "cancelled"]);
    expect((await mail(one.challenged.user.email)).filter((m) => m.subject.includes("booking for your challenge") && m.subject.includes("cancelled"))).toHaveLength(2);
  });

  it("is through the player's route: refused to anybody else, and the booking rules are the ordinary ones", async () => {
    const { l, challenger, challengeId } = await accepted();
    const cookie = async (u: User) => `${SESSION_COOKIE}=${(await createSession(u.id)).token}`;
    const send = async (u: User | null, body: unknown) =>
      challengeRoute.POST(
        new NextRequest(`http://localhost/api/ladders/${l.id}/challenges/${challengeId}`, { method: "POST", headers: { "content-type": "application/json", ...(u ? { cookie: await cookie(u) } : {}), origin: "http://localhost" }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: String(l.id), challengeId: String(challengeId) }) }
      );
    const b = await booking(challenger.user);
    expect((await send(null, { action: "attach_booking", code: b.code })).status).toBe(401);
    expect((await send(await person(), { action: "attach_booking", code: b.code })).status).toBe(404);
    const res = await send(challenger.user, { action: "attach_booking", code: b.code });
    expect(res.status).toBe(200);
    expect((await res.json()).booking).toMatchObject({ code: b.code });
    const again = await send(challenger.user, { action: "attach_booking", code: b.code });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "LD_BK_HAVE" });
    expect((await send(challenger.user, { action: "detach_booking" })).status).toBe(200);
    expect(await (await send(challenger.user, { action: "detach_booking" })).json()).toMatchObject({ code: "LD_BK_NONE" });
  });

  it("agreeing a time on a challenge reserves nothing: another customer can take that court time, and the challenger then meets the ordinary refusal", async () => {
    n++;
    const l = ok(await createLadder({ venueId, name: `Slot Ladder ${n}`, sport: "badminton", teamSize: 1, level: null }, adminId));
    const top = await person();
    const low = await person();
    const topPlace = ok(await join(top, l.id, { adult: true }));
    const lowPlace = ok(await join(low, l.id, { adult: true }));
    const day = addDays(todayISO(), 9);
    const made = ok(await challenge(low.id, l.id, lowPlace.playerId, topPlace.playerId, { onDate: day, minute: 19 * 60 }));
    ok(await answer(top.id, made.id, { accept: true }));
    expect(await myPlaces(low.id, l.id)).toMatchObject([{ open: [{ status: "accepted", agreedOn: day, agreedMin: 19 * 60 }] }]);
    // The agreed time is only a note: a stranger books that court at that time, and the court is theirs.
    const stranger = await person();
    const theirs = await createBooking({ courtId, date: day, hours: [19], name: stranger.name, phone: stranger.phone, userId: stranger.id });
    expect(theirs.ok).toBe(true);
    // The challenger now books it the ordinary way and is refused as anybody would be; nothing was waived for the challenge.
    const mine = await createBooking({ courtId, date: day, hours: [19], name: low.name, phone: low.phone, userId: low.id });
    expect(mine.ok).toBe(false);
    // A free hour is booked, with the booking path's own checks, and then attached.
    const free = await createBooking({ courtId, date: day, hours: [20], name: low.name, phone: low.phone, userId: low.id });
    if (!free.ok) throw new Error("booking");
    const before = await holds();
    ok(await attachBooking(low.id, made.id, free.booking.code));
    ok(await detachBooking(low.id, made.id));
    expect(await holds()).toEqual(before);
  });
});
