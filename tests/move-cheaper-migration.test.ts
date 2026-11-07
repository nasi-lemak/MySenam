import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migrations 0324 and 0325 (lib/move-money.ts, ADR 0067) on an install that already has counter money owed back and credit given back:
 * what was there stays as it was, a cancellation is still owed once per booking, and a booking can now be owed a difference for each
 * move to a cheaper time.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

async function run(db: PGlite, files: string[]): Promise<void> {
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
    });
  }
}

describe("migrations 0324 and 0325 on an install with money already owed back", () => {
  it("keeps the legacy rows, still refuses a second cancellation row for a booking, and allows one row for each move", async () => {
    const db = new PGlite({ extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0324"));
    const venue = (await db.query<{ id: number }>("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Hall', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur') RETURNING id")).rows[0].id;
    const court = (await db.query<{ id: number }>("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES ($1, 'C1', 'badminton', 20, 20) RETURNING id", [venue])).rows[0].id;
    const booking = (
      await db.query<{ id: number }>(
        `INSERT INTO bookings (code, court_id, sport, date, start_min, end_min, starts_at, ends_at, name, phone, total_price, status, payment_status, paid_via)
         VALUES ('MS-LEGACY1', $1, 'badminton', '2026-12-01', 600, 660, '2026-12-01T02:00:00Z', '2026-12-01T03:00:00Z', 'Aina', '0123456789', 20, 'cancelled', 'paid', 'cash') RETURNING id`,
        [court]
      )
    ).rows[0].id;
    await db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause) VALUES ($1, $2, 20, 'cash', 'closure')", [venue, booking]);
    const user = (await db.query<{ id: number }>("INSERT INTO users (name, email, phone, password_hash) VALUES ('Aina', 'a@x.test', '0123456789', 'x') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO wallet_entries (user_id, amount, reason, booking_id) VALUES ($1, 20, 'refund', $2)", [user, booking]);

    await run(db, FILES.filter((f) => f >= "0324"));

    // What was there is as it was.
    expect((await db.query("SELECT amount::float AS amount, cause, settled_at, move_refund_id FROM counter_refunds_owed")).rows).toEqual([
      { amount: 20, cause: "closure", settled_at: null, move_refund_id: null },
    ]);
    expect((await db.query("SELECT amount::float AS amount, move_refund_id FROM wallet_entries")).rows).toEqual([{ amount: 20, move_refund_id: null }]);
    // A booking is still cancelled, and so owed for the cancellation, once.
    await expect(db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause) VALUES ($1, $2, 5, 'cash', 'rain')", [venue, booking])).rejects.toThrow();
    // A difference owed for a move is its own row, one for each move.
    const move = async (amount: number) =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO booking_move_refunds (venue_id, booking_id, moved_by, from_date, from_start_min, to_date, to_start_min, paid_before, price_after, amount, how)
           VALUES ($1, $2, 'customer', '2026-12-01', 600, '2026-12-01', 660, 60, 25, $3, 'counter') RETURNING id`,
          [venue, booking, amount]
        )
      ).rows[0].id;
    const first = await move(35);
    const second = await move(5);
    await db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, move_refund_id) VALUES ($1, $2, 35, 'cash', 'moved_cheaper', $3)", [venue, booking, first]);
    await db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, move_refund_id) VALUES ($1, $2, 5, 'cash', 'moved_cheaper', $3)", [venue, booking, second]);
    // But one move is owed once.
    await expect(db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, move_refund_id) VALUES ($1, $2, 35, 'cash', 'moved_cheaper', $3)", [venue, booking, first])).rejects.toThrow();
    // Nothing owed for a difference is nought or less.
    await expect(move(0)).rejects.toThrow();
    // Running the migrations again changes nothing (IF NOT EXISTS throughout).
    await run(db, FILES.filter((f) => f >= "0324"));
    expect(Number((await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM counter_refunds_owed")).rows[0].n)).toBe(3);
    await db.close();
  });
});
