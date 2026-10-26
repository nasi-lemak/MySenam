import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migration 0131 (docs/architecture/booking-time-model.md#shared-facilities-how-they-are-turned-over)
 * on an install with shared facilities already booked: every claim keeps
 * exactly what it holds (nothing is shrunk or rewritten, nothing becomes more
 * sellable), every level's turnover is unset (so "place", as before), each
 * claim on a shared facility is written into facility_gaps as its time and
 * what it holds around it, which cannot conflict, and a facility-wide claim
 * made afterwards keeps clear of the old ones.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
const DAY = "2030-03-04";

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
const iso = (minute: number) => new Date(new Date(`${DAY}T00:00:00+08:00`).getTime() + minute * 60_000).toISOString();
const range = (start: number, end: number) => `[${iso(start)},${iso(end)})`;

describe("migration 0131 on shared facilities already booked", () => {
  it("keeps every claim as it was, sets no turnover, and keeps new facility-wide claims clear of the old", async () => {
    const db = await PGlite.create(undefined, { extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0131"));

    const id = async (sql: string, params: unknown[]) => (await one<{ id: number }>(db, `${sql} RETURNING id`, params)).id;
    const venue = await id("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Gym', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur')", []);
    const court = (name: string, capacity: number) =>
      id("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate, capacity) VALUES ($1, $2, 'gym', 10, 10, $3)", [venue, name, capacity]);
    const floor = await court("Floor", 3);
    const c1 = await court("Court 1", 1);
    const space = (await one<{ space_id: number }>(db, "SELECT space_id FROM court_spaces WHERE court_id = $1", [c1])).space_id;
    await db.query("INSERT INTO booking_policies (venue_id, buffer_before, buffer_after, operational_after) VALUES ($1, 10, 10, 5)", [venue]);

    /** A claim as the code before 0131 made it: on the floor, its separation and cleaning held as places, added up. */
    const old = async (courtId: number, start: number, end: number, opts: { space?: number; places?: number; before?: number; after?: number }) => {
      const block = await id("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES ($1, $2, $3, $4, $5)", [venue, courtId, DAY, start, end]);
      const before = opts.before ?? 0;
      const after = opts.after ?? 0;
      await db.query(
        `INSERT INTO claims (venue_id, court_id, space_id, places, kind, block_id, during, occupied, buffer_before, buffer_after, separation_before, separation_after)
         VALUES ($1, $2, $3, $4, 'block', $5, $6::tstzrange, $7::tstzrange, $8, $9, 10, 10)`,
        [venue, courtId, opts.space ?? null, opts.places ?? null, block, range(start, end), range(start - before, end + after), before, after]
      );
    };
    await old(floor, 600, 660, { places: 2, before: 10, after: 15 });
    await old(floor, 600, 660, { places: 1, before: 10, after: 15 });
    await old(c1, 600, 660, { space, after: 5 });
    const snapshot = "SELECT id, court_id, space_id, places, during::text, occupied::text, buffer_before, buffer_after, separation_before, separation_after, active FROM claims ORDER BY id";
    const before = (await db.query(snapshot)).rows;

    await run(db, FILES.filter((f) => f >= "0131"));

    // Nothing stored changed; no claim is facility-wide; no level sets a turnover (so each place, added up, as before).
    expect((await db.query(snapshot)).rows).toEqual(before);
    expect((await db.query("SELECT DISTINCT facility_wide FROM claims")).rows).toEqual([{ facility_wide: false }]);
    expect((await db.query("SELECT DISTINCT turnover FROM booking_policies")).rows).toEqual([{ turnover: null }]);
    // Each claim on the floor is written as its time, and what it holds before and after it; the court's are not.
    const rows = (await db.query(
      `SELECT g.side::text, g.work::text, g.zone::text AS zone, c.during::text AS during, c.space_id
         FROM facility_gaps g JOIN claims c ON c.id = g.claim_id ORDER BY g.claim_id, g.work NULLS FIRST`
    )).rows as { side: string | null; work: string | null; zone: string; during: string; space_id: number | null }[];
    expect(rows.every((r) => r.space_id === null)).toBe(true);
    expect(rows.map((r) => [r.side, r.work])).toEqual([
      ["[0,1)", null],
      [null, "[0,1)"],
      [null, "[3,4)"],
      ["[0,1)", null],
      [null, "[0,1)"],
      [null, "[3,4)"],
    ]);
    expect(rows[0].zone).toBe(rows[0].during);

    /** A claim as the new code makes it on a facility turned over whole: places for its time, the rest kept clear. */
    const wide = async (start: number, end: number, o: { places?: number; setup?: number; cleaning?: number; sepBefore?: number; sepAfter?: number }) => {
      const block = await id("INSERT INTO blocks (venue_id, court_id, date, start_min, end_min) VALUES ($1, $2, $3, $4, $5)", [venue, floor, DAY, start, end]);
      await db.query(
        `INSERT INTO claims (venue_id, court_id, places, kind, block_id, during, occupied, buffer_before, buffer_after, separation_before, separation_after, facility_wide)
         VALUES ($1, $2, $3, 'block', $4, $5::tstzrange, $5::tstzrange, $6, $7, $8, $9, true)`,
        [venue, floor, o.places ?? 1, block, range(start, end), o.setup ?? 0, o.cleaning ?? 0, o.sepBefore ?? 0, o.sepAfter ?? 0]
      );
    };
    const refused = async (start: number, end: number, o: Parameters<typeof wide>[2]) => {
      await db.exec("BEGIN");
      try {
        await wide(start, end, o);
        return "taken";
      } catch (err) {
        return (err as { code?: string }).code;
      } finally {
        await db.exec("ROLLBACK");
      }
    };
    // The old claims hold all three places until 11:15 (their cleaning and gap, as places): the floor is still full then.
    expect(await refused(670, 700, {})).toBe("23P01");
    // A session kept clear 20 minutes before it may not have the old claims' time in that gap; 15 meets only what they hold after.
    expect(await refused(675, 700, { sepBefore: 20 })).toBe("23P01");
    expect(await refused(675, 700, { sepBefore: 15 })).toBe("taken");
    // Its setup adds to what the old claims hold after them (taken as their cleaning): from 11:15, 10 more.
    expect(await refused(680, 720, { setup: 10 })).toBe("23P01");
    await wide(685, 720, { setup: 10 });
    // And a new one's cleaning adds to what they hold before them: it ends by 09:40 with 10 minutes of it.
    expect(await refused(540, 590, { cleaning: 10 })).toBe("23P01");
    await wide(540, 580, { cleaning: 10 });
    await db.close();
  }, 120_000);
});
