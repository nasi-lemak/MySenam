import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { createCourt, createVenue } from "../src/lib/store";
import { instantOf } from "../src/lib/interval";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Rows that point at a booking are checked at commit (migration 0206;
 * docs/architecture/booking-concurrency.md, "Independent bookings").
 *
 * Checked as each row was written, a claim read the page of the bookings
 * index every new booking goes to, and three bookings with nothing in common
 * were enough for Postgres to cancel the middle one as a pivot: the full
 * suite on a loaded machine once counted 36 retries for 24 bookings on
 * different courts. The second test replays that order of events on the real
 * tables, three connections at once, so it needs real Postgres.
 */

const onPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe("rows pointing at a booking", () => {
  it("are all checked at commit", async () => {
    const rows = (await getDb()
      .prepare(
        `SELECT cls.relname AS table, con.conname AS name, con.condeferrable AS deferrable, con.condeferred AS deferred
           FROM pg_constraint con JOIN pg_class cls ON cls.oid = con.conrelid
          WHERE con.contype = 'f' AND con.confrelid = 'bookings'::regclass
          ORDER BY 1, 2`
      )
      .all()) as { table: string; name: string; deferrable: boolean; deferred: boolean }[];
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => !r.deferrable || !r.deferred)).toEqual([]);
  });
});

describe.skipIf(!onPostgres)("three independent bookings at once (Postgres)", () => {
  let venueId = 0;
  const courts: { id: number; space: number }[] = [];
  const zone = "Asia/Kuala_Lumpur";

  beforeAll(async () => {
    const v = await createVenue({ name: "Pivot Hall", area: "Petaling Jaya", address: "x", phone: "0312009900", openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error(v.error);
    venueId = v.venue.id;
    for (let i = 0; i < 3; i++) {
      const c = await createCourt({ venueId, name: `Pivot ${i}`, sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
      if (!c.ok) throw new Error(c.error);
      const { space_id } = (await getDb().prepare("SELECT space_id FROM court_spaces WHERE court_id = ?").get(c.court.id)) as { space_id: number };
      courts.push({ id: c.court.id, space: space_id });
    }
  });

  /**
   * Book each court at the same hour in its own SERIALIZABLE transaction, in
   * the order that made the middle one a pivot: each writes its booking and
   * its claim before the next begins writing, and the last commits first.
   * `immediate` checks the claim's booking as it is written, as before 0206.
   */
  async function bookThree(date: string, immediate: boolean): Promise<string[]> {
    const start = 18 * 60;
    const from = instantOf(date, start, zone).toISOString();
    const to = instantOf(date, start + 60, zone).toISOString();
    const clients = await Promise.all(
      courts.map(async () => {
        const k = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await k.connect();
        return k;
      })
    );
    const refused: string[] = [];
    try {
      for (const k of clients) {
        await k.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        if (immediate) await k.query("SET CONSTRAINTS ALL IMMEDIATE");
      }
      for (const [i, k] of clients.entries()) {
        const { rows } = await k.query(
          `INSERT INTO bookings (code, court_id, sport, date, start_min, end_min, starts_at, ends_at, name, phone, total_price)
           VALUES ($1, $2, 'badminton', $3, $4, $5, $6, $7, 'Pivot', $8, 20) RETURNING id`,
          [`PIV${date.replaceAll("-", "")}${i}${immediate ? "I" : "D"}`, courts[i].id, date, start, start + 60, from, to, `012990000${i}`]
        );
        await k.query(
          `INSERT INTO claims (venue_id, court_id, space_id, kind, booking_id, during, occupied, buffer_before, buffer_after, separation_before, separation_after)
           VALUES ($1, $2, $3, 'booking', $4, tstzrange($5, $6), tstzrange($5, $6), 0, 0, 0, 0)`,
          [venueId, courts[i].id, courts[i].space, rows[0].id, from, to]
        );
      }
      for (const [i, k] of [...clients.entries()].reverse()) {
        try {
          await k.query("COMMIT");
        } catch (err) {
          refused.push(`booking ${i + 1}: ${(err as { code?: string }).code}`);
          await k.query("ROLLBACK").catch(() => {});
        }
      }
    } finally {
      await Promise.all(clients.map((k) => k.end()));
    }
    return refused;
  }

  it("all commit, none cancelled as a pivot", async () => {
    for (let round = 0; round < 3; round++) expect(await bookThree(addDays(todayISO(), 3 + round), false)).toEqual([]);
    const { n } = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE venue_id = ? AND active").get(venueId)) as { n: number };
    expect(n).toBe(9);
  });

  it("checked as each row was written, the middle one was cancelled: what 0206 removed", async () => {
    expect(await bookThree(addDays(todayISO(), 8), true)).toEqual(["booking 2: 40001"]);
  });

  it("still refuses a claim on a booking that is not there, at commit", async () => {
    const k = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await k.connect();
    try {
      await k.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const date = addDays(todayISO(), 9);
      const from = instantOf(date, 18 * 60, zone).toISOString();
      const to = instantOf(date, 19 * 60, zone).toISOString();
      await k.query(
        `INSERT INTO claims (venue_id, court_id, space_id, kind, booking_id, during, occupied, buffer_before, buffer_after, separation_before, separation_after)
         VALUES ($1, $2, $3, 'booking', 999999, tstzrange($4, $5), tstzrange($4, $5), 0, 0, 0, 0)`,
        [venueId, courts[0].id, courts[0].space, from, to]
      );
      await expect(k.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
    } finally {
      await k.end();
    }
  });
});
