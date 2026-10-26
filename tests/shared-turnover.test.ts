import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import pg from "pg";
import { registerUser } from "../src/lib/auth";
import { hostMove } from "../src/lib/game-moves";
import { askToJoin, openGame } from "../src/lib/games";
import { claimBuffers, policyFor, startTakes, updatePolicy, validateSettings } from "../src/lib/booking-policy";
import { claim, isConflict } from "../src/lib/claims";
import { getDb, withTransaction } from "../src/lib/db";
import { checkIntegrity } from "../src/lib/integrity";
import { blockSlots, createBooking, createCourt, createVenue, getAdminSlots, getAvailability, getCourt } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * How a shared facility is turned over between bookings
 * (docs/architecture/booking-time-model.md#shared-facilities-how-they-are-turned-over).
 *
 * "place" (the default): each place a booking takes is held over its setup,
 * cleaning and gap, added together, as before. "unit": each place is held over
 * the longer of its setup or cleaning and its gap, each side. "facility": the
 * whole facility is kept clear of everybody between sessions, gaps shared and
 * setup and cleaning added up, while bookings in one session share its places.
 * The database refuses whatever breaks any of them (the capacity trigger for
 * places, facility_gaps for a facility kept clear), and the board offers
 * exactly what it accepts.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number, m = 0) => h * 60 + m;
let n = 0;
const phone = () => `0177770${String(++n).padStart(3, "0")}`;

let venueId: number;
/** Three places; 10 minutes' gap either side, 10 of cleaning after; turned over per place, added up (the default). */
let place3: number;
/** The same rules, turned over per place, the longer of the two. */
let unit3: number;
/** Three places; 5 minutes' setup, 15 of cleaning, 10 minutes' gap either side; turned over whole. */
let whole3: number;
/** Three places; 10 minutes' gap either side and nothing else; turned over whole. */
let gapOnly: number;
/** Made per place, then turned over whole. */
let mixed: number;
/** For raw SQL, with no rules of its own beyond the venue's. */
let rawFloor: number;

const make = (courtId: number, date: string, start: number, end: number, players = 1) =>
  createBooking({ courtId, date, start, end, name: "Player", phone: phone(), players });

beforeAll(async () => {
  const made = await createVenue({ name: "Turnover Hall", area: "PJ", address: "x", phone: "0312340999", openMin: at(7), closeMin: at(23) });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const floor = async (name: string, capacity = 3) => {
    const c = await createCourt({ venueId, name, sport: "gym", offPeakRate: 10, peakRate: 10, capacity });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  place3 = await floor("Per place");
  unit3 = await floor("Per unit");
  whole3 = await floor("Whole");
  gapOnly = await floor("Gap only");
  mixed = await floor("Mixed");
  rawFloor = await floor("Raw");
  // Any minute, five minutes to four hours, for every resource here.
  expect(await updatePolicy({ venue: venueId }, { startEvery: 1, lengthStep: 1, minLength: 5 })).toMatchObject({ ok: true });
  const set = async (courtId: number, settings: Record<string, unknown>) => expect(await updatePolicy({ court: courtId }, settings)).toMatchObject({ ok: true });
  await set(place3, { bufferBefore: 10, bufferAfter: 10, operationalAfter: 10 });
  await set(unit3, { bufferBefore: 10, bufferAfter: 10, operationalAfter: 10, turnover: "unit" });
  await set(whole3, { operationalBefore: 5, operationalAfter: 15, bufferBefore: 10, bufferAfter: 10, turnover: "facility" });
  await set(gapOnly, { bufferBefore: 10, bufferAfter: 10, turnover: "facility" });
  await set(mixed, { operationalAfter: 10 });
});

/** Would the database take a claim of one place for this time, with the resource's own rules? Tried, then undone. */
class Undo extends Error {}
async function databaseTakes(courtId: number, date: string, start: number, minutes: number): Promise<boolean> {
  const court = (await getCourt(courtId))!;
  const policy = await policyFor(court);
  try {
    await withTransaction(async () => {
      const block = (await getDb()
        .prepare("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min, places) VALUES (?, ?, ?, ?, ?, 1) RETURNING id")
        .get(court.venueId, court.id, date, start, start + minutes)) as { id: number };
      await claim({ court, source: { kind: "block", blockId: block.id }, date, span: { start, end: start + minutes }, zone: ZONE, places: 1, ...claimBuffers(policy) });
      throw new Undo();
    });
  } catch (err) {
    if (err instanceof Undo) return true;
    if (isConflict(err)) return false;
    throw err;
  }
  return false;
}

type Row = { during: string; occupied: string; buffer_before: number; buffer_after: number; separation_before: number; separation_after: number; facility_wide: boolean; places: number };
const rowsOf = async (courtId: number, date: string) =>
  (await getDb()
    .prepare(
      `SELECT c.during::text, c.occupied::text, c.buffer_before, c.buffer_after, c.separation_before, c.separation_after, c.facility_wide, c.places
         FROM claims c JOIN bookings b ON b.id = c.booking_id
        WHERE c.court_id = ? AND c.active AND b.date = ? ORDER BY lower(c.during), c.id`
    )
    .all(courtId, date)) as Row[];

describe("the setting", () => {
  it("is place, unit or facility, inherited level by level, and place unless a venue says otherwise", async () => {
    expect(validateSettings({ turnover: "facility" })).toMatchObject({ ok: true, settings: { turnover: "facility" } });
    expect(validateSettings({ turnover: "unit" })).toMatchObject({ ok: true, settings: { turnover: "unit" } });
    expect(validateSettings({ turnover: "everyone" })).toMatchObject({ ok: false });
    expect(validateSettings({ turnover: 2 })).toMatchObject({ ok: false });

    const other = await createVenue({ name: "Inherit Hall", area: "PJ", address: "x", phone: "0312340998", openMin: at(7), closeMin: at(23) });
    if (!other.ok) throw new Error("venue");
    const made = await createCourt({ venueId: other.venue.id, name: "Floor", sport: "gym", offPeakRate: 5, peakRate: 5, capacity: 4 });
    if (!made.ok) throw new Error(made.error);
    const court = made.court;
    // Nothing set anywhere: per place, added up, as before.
    expect((await policyFor(court)).turnover).toBe("place");
    // The venue's reaches the resource; the resource's own wins; cleared, it inherits again.
    expect(await updatePolicy({ venue: other.venue.id }, { turnover: "facility" })).toMatchObject({ ok: true });
    expect((await policyFor(court)).turnover).toBe("facility");
    expect(await updatePolicy({ court: court.id }, { turnover: "unit" })).toMatchObject({ ok: true });
    expect((await policyFor(court)).turnover).toBe("unit");
    expect(await updatePolicy({ court: court.id }, { turnover: null })).toMatchObject({ ok: true });
    expect((await policyFor(court)).turnover).toBe("facility");
    expect(claimBuffers(await policyFor(court))).toMatchObject({ turnover: "facility" });
  });
});

describe("turned over per place, added up (the default)", () => {
  it("holds each place over its cleaning and gaps added together, as before, and leaves other places bookable", async () => {
    const date = day(3);
    expect((await make(place3, date, at(10), at(11), 2)).ok).toBe(true);
    // Held 10 before (the gap) and 20 after (10 cleaning + 10 gap) as places.
    expect(await rowsOf(place3, date)).toMatchObject([{ buffer_before: 10, buffer_after: 20, separation_before: 10, separation_after: 10, facility_wide: false }]);
    // The third place stays sellable straight after.
    expect((await make(place3, date, at(11), at(12))).ok).toBe(true);
    // Those two places are kept until 11:20 and a newcomer keeps 10 before: 11:30 at the earliest.
    expect(await make(place3, date, at(11, 29), at(12))).toMatchObject({ ok: false });
    expect((await make(place3, date, at(11, 30), at(12))).ok).toBe(true);
  });
});

describe("turned over per place, the longer of the two", () => {
  it("holds each place over the longer of its cleaning and its gap, never their sum", async () => {
    const date = day(3);
    for (let i = 0; i < 3; i++) expect((await make(unit3, date, at(10), at(11))).ok).toBe(true);
    // 10 after (cleaning 10, gap 10: the longer), 10 before.
    expect((await rowsOf(unit3, date))[0]).toMatchObject({ buffer_before: 10, buffer_after: 10, separation_before: 10, separation_after: 10, facility_wide: false });
    // A newcomer keeps 10 before: 11:20 (it was 11:30 added up).
    expect(await make(unit3, date, at(11, 19), at(12))).toMatchObject({ ok: false });
    expect((await make(unit3, date, at(11, 20), at(12))).ok).toBe(true);
  });

  it("is what a fleet's own turnaround is: a place freed at 11:00 is out until 11:10, the others stay sellable", async () => {
    const date = day(4);
    const kayaks = await createCourt({ venueId, name: "Single kayaks", sport: "gym", offPeakRate: 10, peakRate: 10, capacity: 2 });
    if (!kayaks.ok) throw new Error(kayaks.error);
    expect(await updatePolicy({ court: kayaks.court.id }, { operationalAfter: 10, turnover: "unit" })).toMatchObject({ ok: true });
    expect((await make(kayaks.court.id, date, at(9), at(11))).ok).toBe(true);
    expect((await make(kayaks.court.id, date, at(11), at(12))).ok).toBe(true);
    expect(await make(kayaks.court.id, date, at(11, 9), at(12))).toMatchObject({ ok: false });
    expect((await make(kayaks.court.id, date, at(11, 10), at(12))).ok).toBe(true);
  });
});

describe("turned over whole", () => {
  it("shares a session's places, and keeps the whole facility clear for its cleaning, setup and gap", async () => {
    const date = day(5);
    expect((await make(whole3, date, at(10), at(11))).ok).toBe(true);
    expect((await make(whole3, date, at(10), at(11), 2)).ok).toBe(true);
    // Full: the count of places still decides within a session.
    expect(await make(whole3, date, at(10), at(11))).toMatchObject({ ok: false });
    // Places held for the time only; setup and cleaning, and the gap, kept apart for the whole facility.
    expect((await rowsOf(whole3, date))[0]).toMatchObject({ buffer_before: 5, buffer_after: 15, separation_before: 10, separation_after: 10, facility_wide: true });
    expect((await rowsOf(whole3, date))[0].occupied).toBe((await rowsOf(whole3, date))[0].during);
    // The next session: 15 minutes' cleaning and its own 5 of setup add up (20), more than the 10-minute gap.
    expect(await make(whole3, date, at(11, 15), at(12))).toMatchObject({ ok: false });
    expect(await make(whole3, date, at(11, 19), at(12))).toMatchObject({ ok: false });
    expect((await make(whole3, date, at(11, 20), at(12))).ok).toBe(true);
    // Before it, the same: the earlier session ends by 09:40 (its 15 of cleaning and this one's 5 of setup).
    expect(await make(whole3, date, at(8), at(9, 41))).toMatchObject({ ok: false });
    expect((await make(whole3, date, at(8), at(9, 40))).ok).toBe(true);
  });

  it("refuses anyone in the facility while it is cleared, though places are free", async () => {
    const date = day(6);
    expect((await make(whole3, date, at(10), at(11))).ok).toBe(true);
    // Two places free, but the session's cleaning runs 11:00 to 11:15 and this one runs on.
    expect(await make(whole3, date, at(10, 30), at(11, 30))).toMatchObject({ ok: false });
    // Joining a session under way needs the facility set up first: its 5 minutes of setup are inside the session.
    expect(await make(whole3, date, at(10, 30), at(11))).toMatchObject({ ok: false });
  });

  it("takes the larger gap, not the sum, between sessions", async () => {
    const date = day(5);
    expect((await make(gapOnly, date, at(10), at(11), 3)).ok).toBe(true);
    expect(await make(gapOnly, date, at(11, 9), at(12))).toMatchObject({ ok: false });
    expect((await make(gapOnly, date, at(11, 10), at(12))).ok).toBe(true);
  });

  it("shows the time it is cleared as taken to customers and as held to staff", async () => {
    const date = day(6);
    const board = (await getAvailability(venueId, date)).find((c) => c.court.id === whole3)!;
    // The session from 10:00 is cleaned until 11:15: no start then, the column from 11:00 not on sale.
    expect(board.slots.find((s) => s.minute === at(11))).toMatchObject({ available: false });
    expect(board.starts.some((s) => s.minute >= at(11) && s.minute < at(11, 15))).toBe(false);
    // Joining the session is offered for the session's length, not for a shorter one cleaned while it runs on.
    const join = board.starts.find((s) => s.minute === at(10))!;
    expect(startTakes(join, 60)).toBe(true);
    expect(startTakes(join, 30)).toBe(false);
    expect(join.lengths).toEqual([60]);
    expect(JSON.stringify(board)).not.toContain("buffer");
    const staff = (await getAdminSlots(venueId, date)).find((c) => c.court.id === whole3)!;
    expect(staff.slots.find((s) => s.minute === at(11))?.status).toBe("booked");
    expect(staff.entries.filter((e) => e.kind === "buffer" && e.end > e.start).map((e) => [e.start, e.end])).toEqual([
      [at(9, 50), at(10)],
      [at(11), at(11, 15)],
    ]);
  });

  it("places a block either side of the time it is cleared", async () => {
    const date = day(7);
    expect((await make(whole3, date, at(10), at(11))).ok).toBe(true);
    const blocked = await blockSlots(whole3, date, { start: at(10, 30), end: at(12) }, "Maintenance", 1);
    expect(blocked).toMatchObject({ ok: true });
    const spans = (await getDb()
      .prepare("SELECT start_min, end_min FROM blocks WHERE court_id = ? AND date = ? ORDER BY start_min")
      .all(whole3, date)) as { start_min: number; end_min: number }[];
    // Beside the session (a place is free), not while the facility is cleared from 11:00 to 11:15.
    expect(spans).toEqual([
      { start_min: at(10, 30), end_min: at(11) },
      { start_min: at(11, 15), end_min: at(12) },
    ]);
  });

  it("holds a game's proposed new time as a session would be, beside its own booking", async () => {
    const date = day(13);
    const users = [];
    for (const who of ["Host", "Guest"]) {
      n++;
      const made = await registerUser({ name: `${who} ${n}`, email: `turn${n}@floor.my`, phone: `01480${String(n).padStart(5, "0")}`, password: "a long enough password" });
      if (!made.ok) throw new Error(made.error);
      users.push(made.user);
    }
    const [host, guest] = users;
    const booked = await createBooking({ courtId: whole3, date, start: at(10), end: at(11), name: host.name, phone: host.phone, userId: host.id });
    if (!booked.ok) throw new Error(booked.error);
    const game = await openGame(host.id, { bookingCode: booked.booking.code, spots: 2, level: null, share: 5, autoAccept: true });
    if (!game.ok) throw new Error(game.error);
    expect((await askToJoin(guest, game.game.id)).ok).toBe(true);
    // Straight after its own session: its own cleaning does not keep it away.
    expect(await hostMove(host.id, game.game.id, { date, start: at(11) })).toMatchObject({ ok: true, outcome: "proposal" });
    const hold = (await getDb()
      .prepare("SELECT during::text, occupied::text, buffer_before, buffer_after, separation_before, separation_after, facility_wide FROM claims WHERE court_id = ? AND kind = 'move' AND active")
      .all(whole3)) as Row[];
    expect(hold).toHaveLength(1);
    expect(hold[0]).toMatchObject({ facility_wide: true, buffer_before: 0, separation_before: 0, buffer_after: 15, separation_after: 10 });
    // Nobody else in the facility while its own session is cleaned, nor while the held time will be.
    expect(await make(whole3, date, at(11, 5), at(11, 50))).toMatchObject({ ok: false });
    expect(await make(whole3, date, at(12, 5), at(13))).toMatchObject({ ok: false });
    expect((await make(whole3, date, at(12, 20), at(13))).ok).toBe(true);
  });
});

describe("a facility changed from per place to whole", () => {
  it("keeps what each claim was made with, and keeps the new kind clear of what the old ones hold", async () => {
    const date = day(8);
    expect((await make(mixed, date, at(10), at(11))).ok).toBe(true);
    const old = (await rowsOf(mixed, date))[0];
    expect(old).toMatchObject({ buffer_before: 0, buffer_after: 10, facility_wide: false });
    // Now the whole facility is cleaned for 10 minutes after a session, and set up for 5 before one.
    expect(await updatePolicy({ court: mixed }, { turnover: "facility", operationalBefore: 5 })).toMatchObject({ ok: true });
    // The old booking still holds its place until 11:10 (its cleaning, as a place) and nothing more.
    expect((await rowsOf(mixed, date))[0]).toEqual(old);
    // The next session's setup of the whole facility comes after the old booking's place is cleaned: 10 + 5.
    expect(await make(mixed, date, at(11, 14), at(12))).toMatchObject({ ok: false });
    expect((await make(mixed, date, at(11, 15), at(12))).ok).toBe(true);
    // Alongside the old one, in its session, the new kind is fine: two cleanings after one session are one task.
    expect((await make(mixed, date, at(10), at(11))).ok).toBe(true);
    // Later sessions follow the new rule alone: 10 minutes' cleaning from 12:00, then 5 of setup.
    expect(await make(mixed, date, at(12, 14), at(13), 2)).toMatchObject({ ok: false });
    expect((await make(mixed, date, at(12, 15), at(13), 2)).ok).toBe(true);
    expect(await updatePolicy({ court: mixed }, { turnover: null, operationalBefore: null })).toMatchObject({ ok: true });
  });
});

describe("what is offered", () => {
  it("is exactly what the database takes, minute by minute, in every mode", async () => {
    const date = day(9);
    for (const [courtId, start, end, players] of [
      [place3, at(10), at(11), 2],
      [place3, at(10, 30), at(11), 1],
      [unit3, at(10), at(11), 3],
      [unit3, at(12), at(12, 30), 1],
      [whole3, at(10), at(11), 2],
      [whole3, at(12), at(12, 40), 1],
      [gapOnly, at(10), at(11), 1],
      [gapOnly, at(11, 30), at(12), 3],
    ])
      expect((await make(courtId, date, start, end, players)).ok, `${courtId} ${start}`).toBe(true);
    expect(await blockSlots(place3, date, { start: at(12), end: at(12, 30) }, "Repair", 2)).toMatchObject({ ok: true });
    expect(await blockSlots(whole3, date, { start: at(13), end: at(13, 20) }, "Repair", 1)).toMatchObject({ ok: true });
    const mismatches: string[] = [];
    for (const courtId of [place3, unit3, whole3, gapOnly]) {
      const board = (await getAvailability(venueId, date)).find((c) => c.court.id === courtId)!;
      for (let start = at(8, 30); start <= at(14); start++) {
        const shown = board.starts.some((s) => s.minute === start && startTakes(s, 30));
        const taken = await databaseTakes(courtId, date, start, 30);
        if (shown !== taken) mismatches.push(`court ${courtId} at ${start}: offered ${shown}, database ${taken}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);
});

/** Everything active on a court, read straight from the table, in minutes of `date`. */
async function heldOn(courtId: number) {
  const ms = (e: string) => `(extract(epoch FROM ${e}) / 60)::float8`;
  return (await getDb()
    .prepare(
      `SELECT ${ms("lower(during)")} AS s, ${ms("upper(during)")} AS e, ${ms("lower(occupied)")} AS os, ${ms("upper(occupied)")} AS oe,
              buffer_before AS bb, buffer_after AS ba, separation_before AS sb, separation_after AS sa, facility_wide AS wide, places, kind
         FROM claims WHERE court_id = ? AND active`
    )
    .all(courtId)) as { s: number; e: number; os: number; oe: number; bb: number; ba: number; sb: number; sa: number; wide: boolean; places: number; kind: string }[];
}

describe("whatever is asked for", () => {
  it("never sells more places than there are, nor anything while a facility is cleared", async () => {
    // A fixed sequence of requests, crowded on purpose: every mode, one to three places, any minute, any length.
    let seed = 7;
    const next = (k: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
    const date = day(10);
    let sold = 0;
    for (let i = 0; i < 160; i++) {
      const courtId = [place3, unit3, whole3, gapOnly][next(4)];
      const start = at(8) + next(10 * 60);
      const length = 20 + next(100);
      const result = await make(courtId, date, start, start + length, 1 + next(3));
      if (result.ok) sold++;
    }
    expect(sold).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const courtId of [place3, unit3, whole3, gapOnly]) {
      const capacity = (await getCourt(courtId))!.capacity;
      const rows = await heldOn(courtId);
      // Places, at every moment anything starts.
      for (const t of rows.map((r) => r.os)) {
        const load = rows.filter((r) => r.os <= t && t < r.oe).reduce((a, r) => a + r.places, 0);
        if (load > capacity) problems.push(`court ${courtId}: ${load} places at ${t}`);
      }
      for (const w of rows.filter((r) => r.wide)) {
        // Nobody's time while it keeps the facility clear.
        const zones = [
          [w.s - Math.max(w.bb, w.sb), w.s],
          [w.e, w.e + Math.max(w.ba, w.sa)],
        ];
        for (const r of rows)
          for (const [zs, ze] of zones) if (zs < ze && r.s < ze && zs < r.e) problems.push(`court ${courtId}: in the facility during a turnover at ${zs}`);
        // Cleaning and setup add up.
        for (const r of rows.filter((x) => x.wide && x !== w))
          if (w.ba > 0 && r.bb > 0 && w.e <= r.s && r.s - r.bb < w.e + w.ba) problems.push(`court ${courtId}: cleaning and setup overlap at ${w.e}`);
      }
      // Per place, each claim holds its places over its buffers as its mode says.
      for (const r of rows.filter((x) => !x.wide && x.kind === "booking")) {
        const before = r.s - r.os;
        const after = r.oe - r.e;
        if (courtId === unit3 && (before !== 10 || after !== 10)) problems.push(`unit claim holds ${before}/${after}`);
        if (courtId === place3 && (before !== 10 || after !== 20)) problems.push(`place claim holds ${before}/${after}`);
      }
    }
    expect(problems).toEqual([]);
    expect(await checkIntegrity()).toEqual([]);
  }, 300_000);
});

describe("the database on its own", () => {
  const iso = (date: string, m: number) => new Date(new Date(`${date}T00:00:00+08:00`).getTime() + m * 60_000).toISOString();
  const range = (date: string, s: number, e: number) => `[${iso(date, s)},${iso(date, e)})`;
  /** A block and its claim written by hand on the raw floor, in one transaction (a refused claim takes its block with it). */
  const raw = (
    start: number,
    end: number,
    o: { wide?: boolean; before?: number; after?: number; sepBefore?: number; sepAfter?: number; held?: [number, number]; space?: boolean } = {}
  ) =>
    withTransaction(async () => {
      const db = getDb();
      const date = day(11);
      const block = (await db
        .prepare("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min, places) VALUES (?, ?, ?, ?, ?, 1) RETURNING id")
        .get(venueId, rawFloor, date, start, end)) as { id: number };
      const occupied = o.held ? range(date, o.held[0], o.held[1]) : range(date, start, end);
      const done = await db
        .prepare(
          `INSERT INTO claims (venue_id, court_id, places, kind, block_id, during, occupied, buffer_before, buffer_after,
                               separation_before, separation_after, facility_wide)
           VALUES (?, ?, 1, 'block', ?, ?::tstzrange, ?::tstzrange, ?, ?, ?, ?, ?) RETURNING id`
        )
        .get(venueId, rawFloor, block.id, range(date, start, end), occupied, o.before ?? 0, o.after ?? 0, o.sepBefore ?? 0, o.sepAfter ?? 0, o.wide ?? false);
      return (done as { id: number }).id;
    });

  it("refuses places held while a facility is cleared, and setup on top of cleaning, however it is written", async () => {
    // A session cleaned for 15 minutes after it, the facility kept clear 10 minutes after it.
    const first = await raw(at(10), at(11), { wide: true, after: 15, sepAfter: 10 });
    // A second in the same session, cleaned for 10: two cleanings overlap, as one task.
    await raw(at(10), at(11), { wide: true, after: 10 });
    // Anyone's time in it, facility-wide or per place.
    await expect(raw(at(11, 5), at(12))).rejects.toMatchObject({ code: "23P01" });
    await expect(raw(at(11, 14), at(12), { wide: true })).rejects.toMatchObject({ code: "23P01" });
    // What a per-place claim holds before its time is its setup, and adds to the facility's cleaning.
    await expect(raw(at(11, 30), at(12), { held: [at(11, 10), at(12)], before: 20 })).rejects.toMatchObject({ code: "23P01" });
    // Setup on top of cleaning: 15 + 10 is 25.
    await expect(raw(at(11, 20), at(12), { wide: true, before: 10 })).rejects.toMatchObject({ code: "23P01" });
    await raw(at(11, 25), at(12), { wide: true, before: 10 });
    // A gap kept clear before a session: nobody's time in it, though gaps and setup may meet it.
    await raw(at(12, 30), at(13), { wide: true, sepBefore: 30 });
    await expect(raw(at(12, 10), at(12, 20))).rejects.toMatchObject({ code: "23P01" });
    // What a per-place claim holds after its time is its cleaning, and adds to the facility's setup.
    await raw(at(13, 30), at(14), { held: [at(13, 30), at(14, 10)], after: 10 });
    await expect(raw(at(14, 15), at(15), { wide: true, before: 10 })).rejects.toMatchObject({ code: "23P01" });
    await raw(at(14, 20), at(15), { wide: true, before: 10 });
    // Only a claim with places can be facility-wide, and it holds places for its time alone.
    await expect(raw(at(16), at(17), { wide: true, held: [at(15, 50), at(17)], before: 10 })).rejects.toMatchObject({ code: "23514" });
    // Let go, its turnover goes with it.
    await getDb().prepare("UPDATE claims SET active = false WHERE id = ?").run(first);
    await getDb().prepare("UPDATE claims SET active = false WHERE block_id IN (SELECT id FROM blocks WHERE court_id = ? AND start_min = ? AND end_min = ?)").run(rawFloor, at(10), at(11));
    await raw(at(11, 5), at(11, 10));
  });

  it("refuses a facility-wide claim on a court of one place", async () => {
    const c = await createCourt({ venueId, name: "Court A", sport: "badminton", offPeakRate: 10, peakRate: 10 });
    if (!c.ok) throw new Error(c.error);
    const db = getDb();
    const date = day(11);
    const space = (await db.prepare("SELECT space_id FROM court_spaces WHERE court_id = ?").get(c.court.id)) as { space_id: number };
    const block = (await db.prepare("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES (?, ?, ?, ?, ?) RETURNING id").get(venueId, c.court.id, date, at(10), at(11))) as { id: number };
    await expect(
      db
        .prepare(
          `INSERT INTO claims (venue_id, court_id, space_id, kind, block_id, during, occupied, facility_wide)
           VALUES (?, ?, ?, 'block', ?, ?::tstzrange, ?::tstzrange, true)`
        )
        .run(venueId, c.court.id, space.space_id, block.id, range(date, at(10), at(11)), range(date, at(10), at(11)))
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("two people at the same moment", () => {
  it("never both get a session and a time inside its turnover", async () => {
    const date = day(2);
    for (let round = 0; round < 4; round++) {
      const base = at(8 + 3 * round);
      const results = await Promise.all([
        make(whole3, date, base, base + 60),
        make(whole3, date, base, base + 60),
        // 15 minutes after: inside the session's 15 of cleaning and its own 5 of setup.
        make(whole3, date, base + 75, base + 120),
      ]);
      const [a, b, c] = results.map((r) => r.ok);
      expect(c && (a || b)).toBe(false);
      expect(a || b || c).toBe(true);
    }
  });
});

describe("two writers on Postgres, without the application's locks", () => {
  // Only a server has two connections; PGlite runs one transaction at a time.
  it.skipIf(!process.env.TEST_DATABASE_URL)("are checked one after the other on a facility, so the second is refused", async () => {
    const court = (await getCourt(rawFloor))!;
    const date = day(12);
    const iso = (m: number) => new Date(new Date(`${date}T00:00:00+08:00`).getTime() + m * 60_000).toISOString();
    for (const isolation of ["READ COMMITTED", "SERIALIZABLE"]) {
      const clients = [new pg.Client({ connectionString: process.env.DATABASE_URL }), new pg.Client({ connectionString: process.env.DATABASE_URL })];
      await Promise.all(clients.map((c) => c.connect()));
      const base = isolation === "READ COMMITTED" ? at(9) : at(15);
      const write = async (c: pg.Client, start: number, end: number, wide: boolean, after: number) => {
        const block = await c.query("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min, places) VALUES ($1, $2, $3, $4, $5, 1) RETURNING id", [
          court.venueId,
          court.id,
          date,
          start,
          end,
        ]);
        await c.query(
          `INSERT INTO claims (venue_id, court_id, places, kind, block_id, during, occupied, buffer_after, facility_wide)
           VALUES ($1, $2, 1, 'block', $3, $4::tstzrange, $4::tstzrange, $5, $6)`,
          [court.venueId, court.id, block.rows[0].id, `[${iso(start)},${iso(end)})`, after, wide]
        );
      };
      try {
        await clients[0].query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await clients[1].query(`BEGIN ISOLATION LEVEL ${isolation}`);
        // Both read first, so a serializable snapshot is taken before either writes.
        await clients[0].query("SELECT count(*) FROM claims WHERE court_id = $1", [court.id]);
        await clients[1].query("SELECT count(*) FROM claims WHERE court_id = $1", [court.id]);
        // A session cleaned for 15 minutes; the other wants a place 5 minutes after it ends.
        await write(clients[0], base, base + 60, true, 15);
        const second = write(clients[1], base + 65, base + 120, false, 0).then(
          () => clients[1].query("COMMIT").then(() => "committed"),
          (err: { code?: string }) => clients[1].query("ROLLBACK").then(() => err.code ?? "error")
        );
        await new Promise((r) => setTimeout(r, 200));
        await clients[0].query("COMMIT");
        // Refused as taken (23P01), or stopped by serializable checking (40001), which the application retries and is then refused.
        expect(["23P01", "40001"]).toContain(await second);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
      const held = (await getDb()
        .prepare("SELECT count(*)::int AS n FROM claims WHERE court_id = ? AND active AND during && ?::tstzrange")
        .get(court.id, `[${iso(base)},${iso(base + 120)})`)) as { n: number };
      expect(held.n).toBe(1);
    }
  });
});
