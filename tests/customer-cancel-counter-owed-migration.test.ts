import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migrations 0346 and 0347 (ADR 0074) on an install that already has counter money owed back and payouts: what was there stays as it was
 * (nothing is turned into a task, nothing is rewritten), a cancellation is still owed once per booking, a person taken off a booking is owed
 * once per withdrawal beside it, the new causes are accepted and others still refused. Always PGlite: it replays the SQL itself.
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

describe("migrations 0346 and 0347 on an install with money already owed back and customers' cancellations already credited", () => {
  it("keeps the legacy rows untouched, owes a cancellation once and a withdrawal once, and turns no past cancellation into a task", async () => {
    const db = new PGlite({ extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0346"));
    const venue = (await db.query<{ id: number }>("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Hall', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur') RETURNING id")).rows[0].id;
    const court = (await db.query<{ id: number }>("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES ($1, 'C1', 'badminton', 20, 20) RETURNING id", [venue])).rows[0].id;
    const booking = async (code: string, status: string) =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO bookings (code, court_id, sport, date, start_min, end_min, starts_at, ends_at, name, phone, total_price, status, payment_status, paid_via)
           VALUES ($1, $2, 'badminton', '2026-12-01', 600, 660, '2026-12-01T02:00:00Z', '2026-12-01T03:00:00Z', 'Aina', '0123456789', 20, $3, 'paid', 'cash') RETURNING id`,
          [code, court, status]
        )
      ).rows[0].id;
    // The venue closed a day (owed, unsettled) and staff handed one back (a payout) before this change.
    const closed = await booking("MS-LEGACY1", "cancelled");
    await db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause) VALUES ($1, $2, 20, 'cash', 'closure')", [venue, closed]);
    const handed = await booking("MS-LEGACY2", "cancelled");
    await db.query("INSERT INTO counter_payouts (venue_id, booking_id, amount, via, admin_name) VALUES ($1, $2, 20, 'cash', 'Dani')", [venue, handed]);
    // A customer's cancellation from before: a credit note and no owed row. It is not turned into a task.
    const customer = await booking("MS-LEGACY3", "cancelled");
    await db.query(
      `INSERT INTO receipts (venue_id, kind, seq, number, source, total, paid_via, customer_name, lines, note, issued_at)
       VALUES ($1, 'credit_note', 1, 'CN-000001', $2, 20, 'Cash', 'Aina', '[]', 'receipt.why.cancelled', now())`,
      [venue, `booking:${customer}`]
    );

    await run(db, FILES.filter((f) => f >= "0346"));

    expect((await db.query("SELECT booking_id, amount::float AS amount, cause, settled_at, withdrawal_id, settled_via, customer_notified_at FROM counter_refunds_owed")).rows).toEqual([
      { booking_id: closed, amount: 20, cause: "closure", settled_at: null, withdrawal_id: null, settled_via: null, customer_notified_at: null },
    ]);
    expect((await db.query("SELECT amount::float AS amount, via FROM counter_payouts")).rows).toEqual([{ amount: 20, via: "cash" }]);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM receipts")).rows).toEqual([{ n: 1 }]);

    // A customer's cancellation is owed once, whatever else is owed on the booking.
    const live = await booking("MS-NEW00001", "cancelled");
    const owe = (cause: string, extra = "") =>
      db.query(`INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause${extra ? ", withdrawal_id" : ""}) VALUES ($1, $2, 10, 'cash', '${cause}'${extra ? `, ${extra}` : ""})`, [venue, live]);
    await owe("customer_cancelled");
    await expect(owe("customer_cancelled")).rejects.toThrow();
    // The venue cannot also have cancelled that booking.
    await expect(owe("closure")).rejects.toThrow();
    // A person taken off it is owed once per withdrawal, beside the cancellation.
    const withdrawal = async () =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO place_withdrawals (booking_id, takes_part_as, name, places, price, paid, refunded, kept, late, by_kind, by_name)
           VALUES ($1, 'unnamed', NULL, 1, 10, true, 10, 0, false, 'customer', 'Aina') RETURNING id`,
          [live]
        )
      ).rows[0].id;
    const w1 = await withdrawal();
    const w2 = await withdrawal();
    await owe("place_withdrawn", String(w1));
    await owe("place_withdrawn", String(w2));
    await expect(owe("place_withdrawn", String(w1))).rejects.toThrow();
    expect(Number((await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM counter_refunds_owed WHERE booking_id = $1", [live])).rows[0].n)).toBe(3);
    // Causes are still a short list; a move and a withdrawal are not the same row.
    await expect(owe("somebody_felt_like_it")).rejects.toThrow();
    await expect(
      db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, move_refund_id, withdrawal_id) VALUES ($1, $2, 1, 'cash', 'moved_cheaper', 1, $3)", [venue, live, w1])
    ).rejects.toThrow();
    // How it was handed back is cash, QR, transfer or card.
    await expect(db.query("UPDATE counter_refunds_owed SET settled_via = 'cheque' WHERE booking_id = $1", [live])).rejects.toThrow();

    // Running the migrations again changes nothing.
    await run(db, FILES.filter((f) => f >= "0346"));
    expect(Number((await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM counter_refunds_owed")).rows[0].n)).toBe(4);
    await db.close();
  });
});
