import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import pg from "pg";
import { registerUser } from "../src/lib/auth";
import { claimBuffers, describePolicy, policyFor, policySettings, updatePolicy, validateSettings } from "../src/lib/booking-policy";
import { claim, isConflict } from "../src/lib/claims";
import { setCourtParts } from "../src/lib/court-links";
import { getDb, withTransaction } from "../src/lib/db";
import { hostMove } from "../src/lib/game-moves";
import { askToJoin, openGame } from "../src/lib/games";
import { checkIntegrity } from "../src/lib/integrity";
import {
  createBooking,
  createBookingSeries,
  createCourt,
  createVenue,
  getAdminSlots,
  getAvailability,
  getCourt,
  rescheduleBooking,
  rescheduleOptions,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Minimum separation does not add up; operational time does
 * (docs/architecture/booking-time-model.md#buffers-separation-and-operational-time).
 *
 * Two bookings that each keep 10 minutes free on the side they meet may be 10
 * minutes apart: the larger of the two separations that face each other. Ten
 * minutes of cleaning after one and ten of setup before the next need twenty.
 * The database refuses whatever breaks either (the exclusion constraint for
 * operational time, the claim_gaps_apart constraint for separation), and the
 * board offers exactly what it accepts.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number, m = 0) => h * 60 + m;
let n = 0;
const phone = () => `0166660${String(++n).padStart(3, "0")}`;

let venueId: number;
/** 10 minutes' separation either side. */
let gap: number;
/** 10 minutes' setup before and 10 of cleaning after, no separation. */
let clean: number;
/** 5 minutes' cleaning after, 15 minutes' separation either side: the separation decides. */
let mixed: number;
/** 10 minutes' setup and 10 of cleaning, 15 minutes' separation: the operational time decides (20). */
let busy: number;
/** A pitch over p1 and p2: the pitch keeps 25 minutes after it, p1 10 either side, p2 nothing. */
let pitch: number;
let p1: number;
let p2: number;
/** A shared floor of two places, 10 minutes' separation either side. */
let gym: number;
/** A court whose rules change between bookings. */
let changing: number;

const make = (courtId: number, date: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
  createBooking({ courtId, date, start, end, name: "Player", phone: phone(), ...extra });

beforeAll(async () => {
  const made = await createVenue({ name: "Separation Hall", area: "PJ", address: "x", phone: "0312340888", openMin: at(7), closeMin: at(23) });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = async (name: string, sport: "badminton" | "futsal" | "gym", capacity = 1) => {
    const c = await createCourt({ venueId, name, sport, offPeakRate: 20, peakRate: 20, capacity });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  gap = await court("Gap", "badminton");
  clean = await court("Clean", "badminton");
  mixed = await court("Mixed", "badminton");
  busy = await court("Busy", "badminton");
  p1 = await court("Part 1", "badminton");
  p2 = await court("Part 2", "badminton");
  pitch = await court("Pitch", "futsal");
  gym = await court("Floor", "gym", 2);
  changing = await court("Changing", "badminton");
  expect(await setCourtParts(pitch, [p1, p2])).toMatchObject({ ok: true });
  // Any minute, five minutes to four hours, for every court here.
  expect(await updatePolicy({ venue: venueId }, { startEvery: 1, lengthStep: 1, minLength: 5 })).toMatchObject({ ok: true });
  const set = async (courtId: number, settings: Record<string, number>) =>
    expect(await updatePolicy({ court: courtId }, settings)).toMatchObject({ ok: true });
  await set(gap, { bufferBefore: 10, bufferAfter: 10 });
  await set(clean, { operationalBefore: 10, operationalAfter: 10 });
  await set(mixed, { operationalAfter: 5, bufferBefore: 15, bufferAfter: 15 });
  await set(busy, { operationalBefore: 10, operationalAfter: 10, bufferBefore: 15, bufferAfter: 15 });
  await set(pitch, { bufferAfter: 25 });
  await set(p1, { bufferBefore: 10, bufferAfter: 10 });
  await set(gym, { bufferBefore: 10, bufferAfter: 10 });
  await set(changing, { bufferBefore: 10, bufferAfter: 10 });
});

/** Is `start` offered on the board for a booking of `minutes` on this court? */
async function offered(courtId: number, date: string, start: number, minutes: number): Promise<boolean> {
  const board = (await getAvailability(venueId, date)).find((c) => c.court.id === courtId)!;
  return board.starts.some((s) => s.minute === start && s.maxLength >= minutes);
}

/** Would the database take a claim for this time, with the court's own buffers? Tried, then undone. */
class Undo extends Error {}
async function databaseTakes(courtId: number, date: string, start: number, minutes: number): Promise<boolean> {
  const court = (await getCourt(courtId))!;
  const policy = await policyFor(court);
  try {
    await withTransaction(async () => {
      const block = (await getDb()
        .prepare("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .get(court.venueId, court.id, date, start, start + minutes)) as { id: number };
      await claim({ court, source: { kind: "block", blockId: block.id }, date, span: { start, end: start + minutes }, zone: ZONE, ...claimBuffers(policy) });
      throw new Undo();
    });
  } catch (err) {
    if (err instanceof Undo) return true;
    if (isConflict(err)) return false;
    throw err;
  }
  return false;
}

describe("the rules", () => {
  it("set separation and operational time apart, each inherited level by level and bounded", async () => {
    expect(validateSettings({ operationalAfter: 300 })).toMatchObject({ ok: false });
    expect(validateSettings({ operationalBefore: -1 })).toMatchObject({ ok: false });
    expect(validateSettings({ operationalBefore: 10, operationalAfter: 15 })).toMatchObject({ ok: true, settings: { operationalBefore: 10, operationalAfter: 15 } });
    // The venue's cleaning reaches every court that does not set its own.
    expect(await updatePolicy({ venue: venueId }, { operationalAfter: 5 })).toMatchObject({ ok: true });
    const policy = await policyFor((await getCourt(gap))!);
    expect(policy).toMatchObject({ bufferBefore: 10, bufferAfter: 10, operationalBefore: 0, operationalAfter: 5 });
    expect(describePolicy(policy)).toContain("kept free 10 minutes before and 10 minutes after (shared with neighbours)");
    expect(describePolicy(policy)).toContain("setup and cleaning 5 minutes after (adds up)");
    expect(await updatePolicy({ venue: venueId }, { operationalAfter: null })).toMatchObject({ ok: true });
    expect((await policyFor((await getCourt(gap))!)).operationalAfter).toBe(0);
    // A level's own settings carry both, as stored.
    expect(await policySettings({ court: busy })).toMatchObject({ operationalBefore: 10, operationalAfter: 10, bufferBefore: 15, bufferAfter: 15 });
  });
});

describe("minimum separation", () => {
  it("does not add up: two 10-minute separations leave 10 minutes, not 20", async () => {
    const date = day(3);
    expect((await make(gap, date, at(10), at(11))).ok).toBe(true);
    // After it: 9 minutes is too close, 10 is enough.
    expect(await make(gap, date, at(11, 9), at(12))).toMatchObject({ ok: false });
    expect((await make(gap, date, at(11, 10), at(12))).ok).toBe(true);
    // Before it, the same.
    expect(await make(gap, date, at(8, 51), at(9, 51))).toMatchObject({ ok: false });
    expect((await make(gap, date, at(8, 50), at(9, 50))).ok).toBe(true);
    // The separation is not held as time: the claims are exactly the time sold.
    const held = (await getDb()
      .prepare("SELECT buffer_before, buffer_after, separation_before, separation_after FROM claims WHERE court_id = ? AND active ORDER BY lower(during)")
      .all(gap)) as { buffer_before: number; buffer_after: number; separation_before: number; separation_after: number }[];
    expect(held[0]).toEqual({ buffer_before: 0, buffer_after: 0, separation_before: 10, separation_after: 10 });
  });

  it("takes the larger of two that differ, on courts that share a floor too", async () => {
    const date = day(4);
    // The pitch keeps 25 minutes after it; Part 1 keeps 10 before: 25 it is, on each court under the pitch.
    expect((await make(pitch, date, at(10), at(11))).ok).toBe(true);
    expect(await make(p1, date, at(11, 10), at(12))).toMatchObject({ ok: false });
    expect(await make(p1, date, at(11, 24), at(12))).toMatchObject({ ok: false });
    expect(await make(p2, date, at(11, 20), at(12))).toMatchObject({ ok: false });
    expect((await make(p1, date, at(11, 25), at(12))).ok).toBe(true);
    expect((await make(p2, date, at(11, 25), at(12))).ok).toBe(true);
    // The other way: Part 1 keeps 10 after it, the pitch nothing before: 10.
    expect((await make(p1, date, at(14), at(15))).ok).toBe(true);
    expect(await make(pitch, date, at(15, 9), at(16))).toMatchObject({ ok: false });
    expect((await make(pitch, date, at(15, 10), at(16))).ok).toBe(true);
  });

  it("is held as places on a shared floor, where places are not told apart, so it adds up there", async () => {
    const date = day(5);
    expect((await make(gym, date, at(10), at(11))).ok).toBe(true);
    expect((await make(gym, date, at(10), at(11))).ok).toBe(true);
    // Both places are kept until 11:10, and a newcomer keeps 10 before: from 11:20.
    expect(await make(gym, date, at(11, 10), at(12))).toMatchObject({ ok: false });
    expect(await make(gym, date, at(11, 19), at(12))).toMatchObject({ ok: false });
    expect((await make(gym, date, at(11, 20), at(12))).ok).toBe(true);
    // One place still free at 11:20 alongside: a second from 11:20 fits.
    expect((await make(gym, date, at(11, 20), at(12))).ok).toBe(true);
    expect(await make(gym, date, at(11, 30), at(11, 45))).toMatchObject({ ok: false });
  });
});

describe("operational time", () => {
  it("adds up: 10 minutes of cleaning and 10 of setup need 20", async () => {
    const date = day(3);
    expect((await make(clean, date, at(10), at(11))).ok).toBe(true);
    expect(await make(clean, date, at(11, 19), at(12))).toMatchObject({ ok: false });
    expect((await make(clean, date, at(11, 20), at(12))).ok).toBe(true);
    // Held as part of the claim, as buffers always were.
    const first = (await getDb()
      .prepare("SELECT buffer_before, buffer_after, separation_before, separation_after FROM claims WHERE court_id = ? AND active ORDER BY lower(during) LIMIT 1")
      .get(clean)) as Record<string, number>;
    expect(first).toEqual({ buffer_before: 10, buffer_after: 10, separation_before: 0, separation_after: 0 });
  });

  it("with separation: the larger of the operational time added up and the separations", async () => {
    const date = day(6);
    // Mixed: 5 minutes' cleaning, 15 minutes' separation: 15.
    expect((await make(mixed, date, at(10), at(11))).ok).toBe(true);
    expect(await make(mixed, date, at(11, 14), at(12))).toMatchObject({ ok: false });
    expect((await make(mixed, date, at(11, 15), at(12))).ok).toBe(true);
    // Busy: 10 + 10 operational, 15 separation: 20.
    expect((await make(busy, date, at(10), at(11))).ok).toBe(true);
    expect(await make(busy, date, at(11, 15), at(12))).toMatchObject({ ok: false });
    expect(await make(busy, date, at(11, 19), at(12))).toMatchObject({ ok: false });
    expect((await make(busy, date, at(11, 20), at(12))).ok).toBe(true);
  });

  it("shows staff what each booking keeps free, separation included, and customers only time they cannot have", async () => {
    const date = day(6);
    const staff = (await getAdminSlots(venueId, date)).find((c) => c.court.id === mixed)!;
    // 10:00–11:00 and 11:15–12:00, each keeping 15 either side (the 5 minutes' cleaning inside it).
    expect(staff.entries.filter((e) => e.kind === "buffer").map((e) => [e.start, e.end])).toEqual([
      [at(9, 45), at(10)],
      [at(11), at(11, 15)],
      [at(11), at(11, 15)],
      [at(12), at(12, 15)],
    ]);
    const board = (await getAvailability(venueId, date)).find((c) => c.court.id === mixed)!;
    expect(JSON.stringify(board)).not.toContain("buffer");
  });
});

describe("every path", () => {
  it("reschedules no closer than the separation, and lists only times it would take", async () => {
    const date = day(7);
    const first = await make(gap, date, at(13), at(14));
    const second = await make(gap, date, at(15), at(16));
    if (!first.ok || !second.ok) throw new Error("setup");
    const options = await rescheduleOptions(second.booking.code, date);
    expect(options.some((o) => o.courtId === gap && o.startMin === at(14, 5))).toBe(false);
    expect(options.some((o) => o.courtId === gap && o.startMin === at(14, 10))).toBe(true);
    expect(await rescheduleBooking(second.booking.code, { date, start: at(14, 5), courtId: gap }, "customer")).toMatchObject({ ok: false });
    expect(await rescheduleBooking(second.booking.code, { date, start: at(14, 10), courtId: gap }, "customer")).toMatchObject({ ok: true });
    // And over its own old time, which it gives up as it moves.
    expect(await rescheduleBooking(second.booking.code, { date, start: at(14, 40), courtId: gap }, "customer")).toMatchObject({ ok: true });
  });

  it("skips a week of a weekly booking that would be too close", async () => {
    const date = day(1);
    expect((await make(gap, addDays(date, 7), at(19), at(20))).ok).toBe(true);
    const series = await createBookingSeries({ courtId: gap, date, weeks: 3, start: at(20, 5), end: at(21), skipConflicts: true, name: "Weekly", phone: phone() });
    if (!series.ok) throw new Error(series.error);
    expect(series.skipped.map((s) => s.date)).toEqual([addDays(date, 7)]);
    const closer = await createBookingSeries({ courtId: gap, date: addDays(date, 1), weeks: 2, start: at(20, 10), end: at(21), name: "Weekly", phone: phone() });
    expect(closer.ok).toBe(true);
  });

  it("lets no manager past a separation, whatever rules they may override", async () => {
    const date = day(13);
    expect((await make(gap, date, at(18), at(19))).ok).toBe(true);
    expect(await make(gap, date, at(19, 5), at(19, 30), { staff: { override: true } })).toMatchObject({ ok: false });
    expect((await make(gap, date, at(19, 10), at(19, 30), { staff: { override: true } })).ok).toBe(true);
  });

  it("keeps what each claim was made with when the rules change, and applies new rules to new claims", async () => {
    const date = day(9);
    expect((await make(changing, date, at(16), at(17))).ok).toBe(true);
    // Now 25 before every booking, and nothing after.
    expect(await updatePolicy({ court: changing }, { bufferBefore: 25, bufferAfter: 0 })).toMatchObject({ ok: true });
    expect(await make(changing, date, at(17, 24), at(18))).toMatchObject({ ok: false });
    expect((await make(changing, date, at(17, 25), at(18))).ok).toBe(true);
    // The first booking still keeps the 10 before it that it was made with, though new ones keep nothing after.
    expect(await make(changing, date, at(14), at(15, 55))).toMatchObject({ ok: false });
    expect((await make(changing, date, at(14), at(15, 50))).ok).toBe(true);
  });

  it("holds a game's proposed new time beside its own booking, keeping the separation from everyone else", async () => {
    const date = day(10);
    const users = [];
    for (const who of ["Host", "Guest"]) {
      n++;
      const made = await registerUser({ name: `${who} ${n}`, email: `sep${n}@gap.my`, phone: `01470${String(n).padStart(5, "0")}`, password: "a long enough password" });
      if (!made.ok) throw new Error(made.error);
      users.push(made.user);
    }
    const [host, guest] = users;
    const booked = await createBooking({ courtId: gap, date, start: at(18), end: at(19), name: host.name, phone: host.phone, userId: host.id });
    if (!booked.ok) throw new Error(booked.error);
    const game = await openGame(host.id, { bookingCode: booked.booking.code, spots: 4, level: null, share: 5, autoAccept: true });
    if (!game.ok) throw new Error(game.error);
    expect((await askToJoin(guest, game.game.id)).ok).toBe(true);
    // Straight after its own time, on the same court: its own booking does not keep it away.
    expect(await hostMove(host.id, game.game.id, { date, start: at(19) })).toMatchObject({ ok: true, outcome: "proposal" });
    // Somebody else keeps the separation from the time held for it.
    expect(await make(gap, date, at(20, 5), at(21))).toMatchObject({ ok: false });
    expect((await make(gap, date, at(20, 10), at(21))).ok).toBe(true);
  });
});

describe("what is offered", () => {
  it("is exactly what the database takes, minute by minute", async () => {
    const date = day(11);
    // Something on each kind of court, then every start from 08:00 to 14:00 for half an hour.
    for (const [courtId, start, end] of [
      [gap, at(10), at(11)],
      [clean, at(10), at(11)],
      [mixed, at(10), at(11)],
      [busy, at(10), at(11)],
      [pitch, at(9), at(10)],
      [p1, at(11, 30), at(12)],
      [p2, at(12, 30), at(13)],
      [gym, at(10), at(11)],
      [gym, at(10, 30), at(11)],
    ])
      expect((await make(courtId, date, start, end)).ok).toBe(true);
    const mismatches: string[] = [];
    for (const courtId of [gap, clean, mixed, busy, pitch, p1, p2, gym]) {
      const board = (await getAvailability(venueId, date)).find((c) => c.court.id === courtId)!;
      for (let start = at(8); start <= at(14); start++) {
        const shown = board.starts.some((s) => s.minute === start && s.maxLength >= 30);
        const taken = await databaseTakes(courtId, date, start, 30);
        if (shown !== taken) mismatches.push(`court ${courtId} at ${start}: offered ${shown}, database ${taken}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(await offered(gap, date, at(11, 10), 30)).toBe(true);
    expect(await offered(gap, date, at(11, 9), 30)).toBe(false);
  }, 120_000);
});

describe("the database on its own", () => {
  // A block and its claim written by hand, in one transaction (a refused claim takes its block with it).
  const raw = (courtId: number, start: number, end: number, sepBefore: number, sepAfter: number) => withTransaction(async () => {
    const db = getDb();
    const court = (await getCourt(courtId))!;
    const date = day(12);
    const block = (await db
      .prepare("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .get(venueId, courtId, date, start, end)) as { id: number };
    const space = (await db.prepare("SELECT space_id FROM court_spaces WHERE court_id = ? LIMIT 1").get(court.id)) as { space_id: number };
    const iso = (m: number) => new Date(`${date}T00:00:00+08:00`).getTime() + m * 60_000;
    const range = `[${new Date(iso(start)).toISOString()},${new Date(iso(end)).toISOString()})`;
    return db
      .prepare(
        `INSERT INTO claims (venue_id, court_id, space_id, kind, block_id, during, occupied, separation_before, separation_after)
         VALUES (?, ?, ?, 'block', ?, ?::tstzrange, ?::tstzrange, ?, ?)`
      )
      .run(venueId, courtId, space.space_id, block.id, range, range, sepBefore, sepAfter);
  });

  it("refuses a claim closer than the larger separation, however it is written", async () => {
    await raw(changing, at(10), at(11), 0, 10);
    await expect(raw(changing, at(11, 5), at(12), 0, 0)).rejects.toMatchObject({ code: "23P01" });
    await expect(raw(changing, at(8), at(9, 50), 0, 15)).rejects.toMatchObject({ code: "23P01" });
    await raw(changing, at(11, 10), at(12), 5, 0);
    await raw(changing, at(8), at(9, 45), 0, 15);
    // Separations are bounded as the rules are, so the check knows how far to look.
    await expect(raw(changing, at(20), at(21), 300, 0)).rejects.toMatchObject({ code: "23514" });
  });

  it("leaves what was booked agreeing with what is held", async () => {
    expect(await checkIntegrity()).toEqual([]);
  });
});

describe("two people at the same moment", () => {
  it("never both get neighbouring times closer than the separation", async () => {
    const date = day(2);
    for (let round = 0; round < 4; round++) {
      const base = at(8 + 3 * round);
      const results = await Promise.all([
        make(gap, date, base, base + 60),
        make(gap, date, base + 65, base + 120),
        make(p1, date, base + 125, base + 180),
        make(pitch, date, base + 60, base + 120),
      ]);
      const [a, b, c, d] = results.map((r) => r.ok);
      // Gap: one of the two neighbours 5 minutes apart.
      expect([a, b].filter(Boolean)).toHaveLength(1);
      // The pitch keeps 25 after it, Part 1 10 before: 5 minutes apart is one of them.
      expect([c, d].filter(Boolean)).toHaveLength(1);
    }
    // Far enough apart, both.
    const later = day(12);
    const both = await Promise.all([make(gap, later, at(10), at(11)), make(gap, later, at(11, 10), at(12))]);
    expect(both.every((r) => r.ok)).toBe(true);
  });
});

describe("two writers on Postgres, without the application's locks", () => {
  // Only a server has two connections; PGlite runs one transaction at a time.
  it.skipIf(!process.env.TEST_DATABASE_URL)("are checked one after the other on a space, so the second is refused", async () => {
    const court = (await getCourt(changing))!;
    const space = ((await getDb().prepare("SELECT space_id FROM court_spaces WHERE court_id = ?").get(changing)) as { space_id: number }).space_id;
    const date = day(11);
    const iso = (m: number) => new Date(new Date(`${date}T00:00:00+08:00`).getTime() + m * 60_000).toISOString();
    for (const isolation of ["READ COMMITTED", "SERIALIZABLE"]) {
      const clients = [new pg.Client({ connectionString: process.env.DATABASE_URL }), new pg.Client({ connectionString: process.env.DATABASE_URL })];
      await Promise.all(clients.map((c) => c.connect()));
      const base = isolation === "READ COMMITTED" ? at(9) : at(15);
      const write = async (c: pg.Client, start: number, end: number, sepAfter: number) => {
        const block = await c.query("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
          court.venueId,
          court.id,
          date,
          start,
          end,
        ]);
        await c.query(
          `INSERT INTO claims (venue_id, court_id, space_id, kind, block_id, during, occupied, separation_after)
           VALUES ($1, $2, $3, 'block', $4, $5::tstzrange, $5::tstzrange, $6)`,
          [court.venueId, court.id, space, block.rows[0].id, `[${iso(start)},${iso(end)})`, sepAfter]
        );
      };
      try {
        await clients[0].query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await clients[1].query(`BEGIN ISOLATION LEVEL ${isolation}`);
        // Both read first, so a serializable snapshot is taken before either writes.
        await clients[0].query("SELECT count(*) FROM claims WHERE space_id = $1", [space]);
        await clients[1].query("SELECT count(*) FROM claims WHERE space_id = $1", [space]);
        await write(clients[0], base, base + 60, 10);
        // The second waits on the first's uncommitted row under the separation constraint until it commits.
        const second = write(clients[1], base + 65, base + 120, 0).then(
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
        .prepare("SELECT count(*)::int AS n FROM claims WHERE space_id = ? AND active AND during && ?::tstzrange")
        .get(space, `[${iso(base)},${iso(base + 120)})`)) as { n: number };
      expect(held.n).toBe(1);
    }
  });
});
