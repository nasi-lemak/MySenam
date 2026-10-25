import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migrations 0118–0119 (docs/architecture/booking-time-model.md#buffers-separation-and-operational-time)
 * on an install with buffers already set and claims made under them: the
 * "kept free" settings become minimum separation as they stand, every claim
 * keeps exactly what it was made with (nothing is shrunk or rewritten, so
 * nothing that was apart can come to collide), and claims made afterwards
 * follow the new rule beside them.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
const ZONE_OFFSET = "+08:00";
const DAY = "2030-03-04";

/** Run migrations as lib/db.ts does: SQL then its step, one transaction each. */
async function run(db: PGlite, files: string[]): Promise<void> {
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
    });
  }
}

const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;
const iso = (minute: number) => new Date(new Date(`${DAY}T00:00:00${ZONE_OFFSET}`).getTime() + minute * 60_000).toISOString();
const range = (start: number, end: number) => `[${iso(start)},${iso(end)})`;

describe("migrations 0118–0119 on claims and settings made under buffers that added up", () => {
  it("keep every claim as it was, turn the settings into separation, and apply the new rule only to new claims", async () => {
    const db = await PGlite.create(undefined, { extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0118"));

    const id = async (sql: string, params: unknown[]) => (await one<{ id: number }>(db, `${sql} RETURNING id`, params)).id;
    const venue = await id("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Hall', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur')", []);
    const court = (name: string, capacity = 1) =>
      id("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate, capacity) VALUES ($1, $2, 'badminton', 20, 30, $3)", [venue, name, capacity]);
    const c1 = await court("Court 1");
    const gym = await court("Floor", 2);
    const space = (await one<{ space_id: number }>(db, "SELECT space_id FROM court_spaces WHERE court_id = $1", [c1])).space_id;
    // The venue kept 10 minutes free before and after every booking.
    await db.query("INSERT INTO booking_policies (venue_id, buffer_before, buffer_after) VALUES ($1, 10, 10)", [venue]);

    /** A claim as the old code made it: `occupied` widened by both buffers. */
    const old = async (courtId: number, start: number, end: number, opts: { space?: number; places?: number } = {}) => {
      const block = await id("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES ($1, $2, $3, $4, $5)", [venue, courtId, DAY, start, end]);
      await db.query(
        `INSERT INTO claims (venue_id, court_id, space_id, places, kind, block_id, during, occupied, buffer_before, buffer_after)
         VALUES ($1, $2, $3, $4, 'block', $5, $6::tstzrange, $7::tstzrange, 10, 10)`,
        [venue, courtId, opts.space ?? null, opts.places ?? null, block, range(start, end), range(start - 10, end + 10)]
      );
    };
    // Two bookings' worth on Court 1, 20 minutes apart (as buffers that added up required), and two places of the floor.
    await old(c1, 600, 660, { space });
    await old(c1, 680, 740, { space });
    await old(gym, 600, 660, { places: 1 });
    await old(gym, 600, 660, { places: 1 });
    const before = await db.query("SELECT id, during::text, occupied::text, buffer_before, buffer_after, active FROM claims ORDER BY id");

    await run(db, FILES.filter((f) => f >= "0118" && f < "0120"));

    // Nothing stored changed; every claim has no separation of its own (its buffers stay in `occupied`).
    expect((await db.query("SELECT id, during::text, occupied::text, buffer_before, buffer_after, active FROM claims ORDER BY id")).rows).toEqual(before.rows);
    expect((await db.query("SELECT DISTINCT separation_before, separation_after FROM claims")).rows).toEqual([{ separation_before: 0, separation_after: 0 }]);
    // Each claim on a space is written beside them as its time alone, for the separation constraint; the floor's are not.
    expect((await db.query("SELECT g.role::text, g.zone::text = c.during::text AS same, g.active FROM claim_gaps g JOIN claims c ON c.id = g.claim_id ORDER BY g.claim_id")).rows).toEqual([
      { role: "[0,1)", same: true, active: true },
      { role: "[0,1)", same: true, active: true },
    ]);
    // The setting is the same number, read from now on as minimum separation; operational time is unset (inherited: none).
    expect(await one(db, "SELECT buffer_before, buffer_after, operational_before, operational_after FROM booking_policies WHERE venue_id = $1", [venue])).toEqual({
      buffer_before: 10,
      buffer_after: 10,
      operational_before: null,
      operational_after: null,
    });

    /** A claim as the new code makes it: separation apart, no operational time. */
    const fresh = async (start: number, end: number, sepBefore: number, sepAfter: number) => {
      const block = await id("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES ($1, $2, $3, $4, $5)", [venue, c1, DAY, start, end]);
      await db.query(
        `INSERT INTO claims (venue_id, court_id, space_id, kind, block_id, during, occupied, separation_before, separation_after)
         VALUES ($1, $2, $3, 'block', $4, $5::tstzrange, $5::tstzrange, $6, $7)`,
        [venue, c1, space, block, range(start, end), sepBefore, sepAfter]
      );
    };
    const refused = async (start: number, end: number) => {
      await db.exec("BEGIN");
      try {
        await fresh(start, end, 10, 10);
        return "taken";
      } catch (err) {
        return (err as { code?: string }).code;
      } finally {
        await db.exec("ROLLBACK");
      }
    };
    // An old claim still keeps its 10 minutes after it (in its `occupied`): 5 minutes later is refused.
    expect(await refused(745, 800)).toBe("23P01");
    // A new claim keeping 10 before it may now start 10 minutes after the old one: the larger, not the sum.
    await fresh(750, 800, 10, 10);
    // And a new claim's own separation is checked against the next one (the old claims' too).
    expect(await refused(805, 830)).toBe("23P01");
    await fresh(810, 830, 10, 10);
    // The floor still counts places over the old claims' `occupied`.
    const block = await id("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES ($1, $2, $3, $4, $5)", [venue, gym, DAY, 665, 700]);
    await expect(
      db.query(
        `INSERT INTO claims (venue_id, court_id, places, kind, block_id, during, occupied) VALUES ($1, $2, 1, 'block', $3, $4::tstzrange, $4::tstzrange)`,
        [venue, gym, block, range(665, 700)]
      )
    ).rejects.toMatchObject({ code: "23P01" });
    await db.close();
  }, 120_000);
});
