import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migrations 0089–0091 (ADR 0010) take an install from the half-hour diary
 * to exact intervals: every booking, block, class, lesson and outage the old
 * diary held is claimed as the same moments, the step after 0090 compares
 * the two half hour by half hour, and only then are the old tables dropped.
 * Anything that does not reconcile stops the migration and changes nothing.
 *
 * Each case builds its own database at 0088 with rows written as the old
 * code wrote them (the linked-court trigger adding shadows, half-hour rows),
 * then runs the new migrations as lib/db.ts does: the SQL and its step in one
 * transaction each.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
const NEW = FILES.filter((f) => f >= "0089");
const DAY = "2030-03-04";

async function at0088(): Promise<PGlite> {
  const db = await PGlite.create(undefined, { extensions: { citext } });
  for (const f of FILES.filter((f) => f < "0089")) await db.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
  return db;
}

/** Run the new migrations as lib/db.ts would: SQL then step, one transaction each. */
async function migrate(db: PGlite): Promise<void> {
  for (const f of NEW) {
    const version = f.replace(/\.sql$/, "");
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
    });
  }
}

const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;
const all = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];

/** A venue in Kuala Lumpur (UTC+8) with two courts under a pitch, a gym of three places, and a coach. */
async function seed(db: PGlite) {
  const id = async (sql: string, params: unknown[]) => (await one<{ id: number }>(db, `${sql} RETURNING id`, params)).id;
  const venue = await id(
    "INSERT INTO venues (name, area, address, phone, open_hour, close_hour, time_zone) VALUES ('Old Hall', 'PJ', 'x', '031', 8, 23, 'Asia/Kuala_Lumpur')",
    []
  );
  const court = (name: string, sport: string, capacity = 1) =>
    id("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate, capacity) VALUES ($1, $2, $3, 20, 30, $4)", [venue, name, sport, capacity]);
  const c1 = await court("Court 1", "badminton");
  const c2 = await court("Court 2", "badminton");
  const pitch = await court("Pitch", "futsal");
  const gym = await court("Gym", "gym", 3);
  await db.query("INSERT INTO court_links (whole_id, part_id) VALUES ($1, $2), ($1, $3)", [pitch, c1, c2]);

  let n = 0;
  const booking = (courtId: number, start: number, end: number, extra: Record<string, unknown> = {}) =>
    id(
      `INSERT INTO bookings (code, court_id, date, start_hour, end_hour, name, phone, total_price${Object.keys(extra).map((k) => `, ${k}`).join("")})
       VALUES ($1, $2, $3, $4, $5, 'Aina', '0123', 20${Object.keys(extra).map((_, i) => `, $${i + 6}`).join("")})`,
      [`MS-OLD${++n}`, courtId, DAY, start, end, ...Object.values(extra)]
    );
  /** The diary's half hours for a booking, as the old code wrote them: the trigger shadows linked courts. */
  const hold = async (bookingId: number, courtId: number, start: number, end: number, seat = 0) => {
    for (let h = start; h < end; h += 0.5)
      await db.query("INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span) VALUES ($1, $2, $3, $4, $5, 0.5)", [bookingId, courtId, DAY, h, seat]);
  };

  // 10:00–11:30 on Court 1: the pitch above it is shadowed by the trigger.
  const b1 = await booking(c1, 10, 11.5);
  await hold(b1, c1, 10, 11.5);
  // Two places of the gym, 18:00–19:00.
  const g1 = await booking(gym, 18, 19);
  await hold(g1, gym, 18, 19, 0);
  const g2 = await booking(gym, 18, 19);
  await hold(g2, gym, 18, 19, 1);
  // A block on Court 2, 14:00–15:00, in two half hours.
  for (const h of [14, 14.5])
    await db.query("INSERT INTO slot_blocks (court_id, date, hour, reason, span) VALUES ($1, $2, $3, 'Net repair', 0.5)", [c2, DAY, h]);
  // A class on the gym, 20:00–21:00, its enrolment holding a place as it did.
  const cls = await id(
    "INSERT INTO classes (court_id, name, instructor, date, start_hour, end_hour, capacity, price) VALUES ($1, 'Spin', 'Mei', $2, 20, 21, 3, 15)",
    [gym, DAY]
  );
  const enrolled = await booking(gym, 20, 21, { class_id: cls });
  await hold(enrolled, gym, 20, 21, 0);
  // A lesson on Court 2 with a coach, 16:00–17:00.
  const coach = await id("INSERT INTO coaches (venue_id, name, sports, rate) VALUES ($1, 'Ana', 'badminton', 80)", [venue]);
  const lesson = await booking(c2, 16, 17, { coach_id: coach, coach_fee: 80 });
  await hold(lesson, c2, 16, 17);
  for (const h of [16, 16.5]) await db.query("INSERT INTO coach_slots (coach_id, date, hour, booking_id) VALUES ($1, $2, $3, $4)", [coach, DAY, h, lesson]);
  // A cancelled booking holds nothing.
  await booking(c1, 12, 13, { status: "cancelled" });
  // The gym out of service the next day.
  await db.query("INSERT INTO court_outages (court_id, starts_on, ends_on, reason) VALUES ($1, '2030-03-05', '2030-03-05', 'Floor')", [gym]);
  // A pass sold before: an entry an hour or part.
  await db.query(
    "INSERT INTO passes (code, venue_id, name, entries, price, holder_name, holder_phone, expires_on) VALUES ('PS-OLD', $1, 'Ten', 10, 150, 'Aina', '0123', '2030-12-31')",
    [venue]
  );
  return { venue, c1, c2, pitch, gym, b1, g1, lesson, cls, coach };
}

describe("migrating the half-hour diary to intervals", () => {
  it("claims what the diary held, to the minute, and then drops the diary", async () => {
    const db = await at0088();
    const s = await seed(db);
    await migrate(db);

    // Times in minutes of the day, and the moments they are where the venue is (UTC+8).
    expect(await one(db, "SELECT open_min, close_min FROM venues WHERE id = $1", [s.venue])).toEqual({ open_min: 480, close_min: 1380 });
    const b1 = await one<{ start_min: number; end_min: number; starts_at: Date; ends_at: Date }>(
      db,
      "SELECT start_min, end_min, starts_at, ends_at FROM bookings WHERE id = $1",
      [s.b1]
    );
    expect([b1.start_min, b1.end_min]).toEqual([600, 690]);
    expect(new Date(b1.starts_at).toISOString()).toBe("2030-03-04T02:00:00.000Z");
    expect(new Date(b1.ends_at).toISOString()).toBe("2030-03-04T03:30:00.000Z");

    // The booking claims Court 1's space once; the pitch over it is held because it covers that space.
    const claims = await all<{ court_id: number; space_id: number | null; places: number | null }>(
      db,
      "SELECT court_id, space_id, places FROM claims WHERE booking_id = $1 AND active",
      [s.b1]
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].court_id).toBe(s.c1);
    const pitchSpaces = await all<{ space_id: number }>(db, "SELECT space_id FROM court_spaces WHERE court_id = $1 ORDER BY space_id", [s.pitch]);
    expect(pitchSpaces).toHaveLength(3);
    // So the pitch at 10:30 is refused by the database.
    const pitchAt = (from: string, to: string) =>
      db.query(
        `INSERT INTO claims (venue_id, court_id, space_id, kind, block_id, during, occupied)
         SELECT $1, $2, cs.space_id, 'block', (SELECT id FROM blocks LIMIT 1), tstzrange($3, $4, '[)'), tstzrange($3, $4, '[)')
           FROM court_spaces cs WHERE cs.court_id = $2`,
        [s.venue, s.pitch, from, to]
      );
    await expect(pitchAt("2030-03-04T02:30:00Z", "2030-03-04T03:00:00Z")).rejects.toMatchObject({ code: "23P01" });

    // The gym: one place each, from the same half hours, and a class holding all three.
    expect(await one(db, "SELECT places FROM claims WHERE booking_id = $1", [s.g1])).toEqual({ places: 1 });
    expect(await one(db, "SELECT places FROM claims WHERE class_id = $1", [s.cls])).toEqual({ places: 3 });
    // Its enrolment holds no court time of its own.
    expect(await one(db, "SELECT COUNT(*)::int AS n FROM claims c JOIN bookings b ON b.id = c.booking_id WHERE b.class_id = $1", [s.cls])).toEqual({ n: 0 });

    // The block is one block, 14:00–15:00, and claims Court 2.
    expect(await all(db, "SELECT court_id, start_min, end_min, reason FROM blocks")).toEqual([{ court_id: s.c2, start_min: 840, end_min: 900, reason: "Net repair" }]);
    expect(await one(db, "SELECT COUNT(*)::int AS n FROM claims WHERE kind = 'block' AND active")).toEqual({ n: 1 });

    // The lesson holds its coach as well as its court.
    expect(await one(db, "SELECT COUNT(*)::int AS n FROM coach_claims WHERE booking_id = $1 AND active", [s.lesson])).toEqual({ n: 1 });
    // The outage holds the gym, all three places.
    expect(await one(db, "SELECT places FROM claims WHERE kind = 'outage'")).toEqual({ places: 3 });
    // Nothing claimed for the cancelled booking.
    expect(await one(db, "SELECT COUNT(*)::int AS n FROM claims c JOIN bookings b ON b.id = c.booking_id WHERE b.status = 'cancelled'")).toEqual({ n: 0 });

    // Passes sold before keep their rule: an entry an hour or part.
    expect(await one(db, "SELECT kind, entry_minutes FROM passes WHERE code = 'PS-OLD'")).toEqual({ kind: "session", entry_minutes: 60 });

    // The diary and its hour columns are gone.
    for (const table of ["booking_slots", "slot_blocks", "coach_slots", "migration_venue_zones"])
      expect(await one(db, "SELECT to_regclass($1) AS t", [table])).toEqual({ t: null });
    const columns = await all<{ table_name: string; column_name: string }>(
      db,
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE column_name IN ('start_hour', 'end_hour', 'open_hour', 'close_hour', 'slot_minutes', 'min_hours', 'max_hours')
          AND table_name IN ('bookings', 'classes', 'venues', 'courts', 'sport_rules', 'waitlist', 'tournaments')`
    );
    expect(columns).toEqual([]);
    // The courts' spaces are kept in step from here on, however a court is written.
    const added = await one<{ id: number }>(db, "INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES ($1, 'New', 'badminton', 1, 1) RETURNING id", [s.venue]);
    expect(await one(db, "SELECT COUNT(*)::int AS n FROM court_spaces WHERE court_id = $1", [added.id])).toEqual({ n: 1 });
  });

  it("stops, changing nothing, when a booking's diary does not match its times", async () => {
    const db = await at0088();
    const s = await seed(db);
    // A booking that says 10:00–11:30 but whose diary also holds 12:00.
    await db.query("INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span) VALUES ($1, $2, $3, 12, 0, 0.5)", [s.b1, s.c1, DAY]);
    await expect(migrate(db)).rejects.toThrow(/does not hold one stretch/);
    // 0089 went in; 0090 did not, and the diary is untouched.
    expect(await one(db, "SELECT to_regclass('booking_slots') AS t")).not.toEqual({ t: null });
    expect(await one(db, "SELECT COUNT(*)::int AS n FROM claims")).toEqual({ n: 0 });
  });

  it("stops when what was claimed does not add up to what the diary held", async () => {
    const db = await at0088();
    const s = await seed(db);
    // A place of the gym held twice at 18:00 by one booking's diary: the claims cannot say that.
    await db.query("INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span) VALUES ($1, $2, $3, 18, 2, 0.5)", [s.g1, s.gym, DAY]);
    await expect(migrate(db)).rejects.toThrow();
    expect(await one(db, "SELECT to_regclass('booking_slots') AS t")).not.toEqual({ t: null });
  });
});
