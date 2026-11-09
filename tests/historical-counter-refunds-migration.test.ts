import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migration 0348 (ADR 0078) on an install with production-shaped money already on the lists: owed rows of the venue's causes, a customer's
 * cancellation and a withdrawal (settled and not), payouts with and without their credit note, credit notes and a till count. Nothing is
 * backfilled and nothing already written changes; ordinary rows keep the new columns empty; a historical reconciliation row must carry its
 * evidence, reason, verifier and consistent amounts. Always PGlite: it replays the SQL itself.
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

const OWED = "SELECT id, venue_id, booking_id, amount::text, via, cause, owed_since, settled_at, outcome, admin_id, admin_name, move_refund_id, withdrawal_id, settled_via, customer_notified_at FROM counter_refunds_owed ORDER BY id";
const PAYOUTS = "SELECT id, venue_id, booking_id, credit_note_id, amount::text, via, kept_percent, admin_id, admin_name, paid_out_at FROM counter_payouts ORDER BY id";

describe("migration 0348 on an install with counter refunds already written", () => {
  it("leaves every row as it was, adds empty columns, and holds a reconciliation row to its evidence", async () => {
    const db = new PGlite({ extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0348"));
    const venue = (await db.query<{ id: number }>("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Hall', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur') RETURNING id")).rows[0].id;
    const court = (await db.query<{ id: number }>("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES ($1, 'C1', 'badminton', 20, 20) RETURNING id", [venue])).rows[0].id;
    const admin = (await db.query<{ id: number }>("INSERT INTO admins (name, email, password_hash, venue_id) VALUES ('Mona', 'mona@old.test', 'x', $1) RETURNING id", [venue])).rows[0].id;
    const booking = async (code: string, status: string, via: string | null = "cash") =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO bookings (code, court_id, sport, date, start_min, end_min, starts_at, ends_at, name, phone, total_price, status, payment_status, paid_via)
           VALUES ($1, $2, 'badminton', '2026-12-01', 600, 660, '2026-12-01T02:00:00Z', '2026-12-01T03:00:00Z', 'Aina', '0123456789', 30, $3, 'paid', $4) RETURNING id`,
          [code, court, status, via]
        )
      ).rows[0].id;
    let seq = 0;
    const note = async (source: string, total: number, issued = "2026-03-01 04:00:00") =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO receipts (venue_id, kind, seq, number, source, total, paid_via, customer_name, lines, note, issued_at)
           VALUES ($1, 'credit_note', $2, $3, $4, $5, 'Cash', 'Aina', '[]', 'receipt.why.cancelled', $6) RETURNING id`,
          [venue, ++seq, `CN-${String(seq).padStart(6, "0")}`, source, total, issued]
        )
      ).rows[0].id;
    // The venue closed a day: owed, not settled.
    const closed = await booking("MS-OLD00001", "cancelled");
    await db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause) VALUES ($1, $2, 30, 'cash', 'closure')", [venue, closed]);
    // A customer's cancellation after 0346, settled by staff another way than paid, told; its payout on its credit note.
    const settled = await booking("MS-OLD00002", "cancelled", "qr");
    const settledNote = await note(`booking:${settled}`, 30, "2026-11-08 04:00:00");
    await db.query(
      `INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, settled_at, outcome, admin_id, admin_name, settled_via, customer_notified_at)
       VALUES ($1, $2, 30, 'qr', 'customer_cancelled', now(), 'back', $3, 'Mona', 'cash', now())`,
      [venue, settled, admin]
    );
    await db.query("INSERT INTO counter_payouts (venue_id, booking_id, credit_note_id, amount, via, admin_id, admin_name) VALUES ($1, $2, $3, 30, 'cash', $4, 'Mona')", [venue, settled, settledNote, admin]);
    // A withdrawal owed back, and a staff cancellation's payout from before payouts named their note.
    const withdrawn = await booking("MS-OLD00003", "confirmed");
    const w = (
      await db.query<{ id: number }>(
        `INSERT INTO place_withdrawals (booking_id, takes_part_as, places, price, paid, refunded, kept, late, by_kind, by_name) VALUES ($1, 'unnamed', 1, 10, true, 10, 0, false, 'customer', 'Aina') RETURNING id`,
        [withdrawn]
      )
    ).rows[0].id;
    await note(`booking:${withdrawn}:place:${w}`, 10, "2026-11-08 05:00:00");
    await db.query("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, withdrawal_id) VALUES ($1, $2, 10, 'cash', 'place_withdrawn', $3)", [venue, withdrawn, w]);
    const staffCancelled = await booking("MS-OLD00004", "cancelled");
    await note(`booking:${staffCancelled}`, 30);
    await db.query("INSERT INTO counter_payouts (venue_id, booking_id, amount, via, admin_name) VALUES ($1, $2, 30, 'cash', 'Dani')", [venue, staffCancelled]);
    // A pre-0346 customer cancellation: its credit note only. A till count on its day.
    const legacy = await booking("MS-OLD00005", "cancelled");
    const legacyNote = await note(`booking:${legacy}`, 30);
    await db.query("INSERT INTO cash_up_counts (venue_id, day, method, counted, expected, variance, counted_by_admin_id, counted_by_name) VALUES ($1, '2026-03-01', 'cash', 0, -30, 30, $2, 'Mona')", [venue, admin]);

    const owedBefore = (await db.query(OWED)).rows;
    const payoutsBefore = (await db.query(PAYOUTS)).rows;
    const receiptsBefore = (await db.query("SELECT * FROM receipts ORDER BY id")).rows;
    const countsBefore = (await db.query("SELECT * FROM cash_up_counts ORDER BY id")).rows;

    await run(db, FILES.filter((f) => f >= "0348"));

    // Nothing already written changed, and nothing was added: no backfill.
    expect((await db.query(OWED)).rows).toEqual(owedBefore);
    expect((await db.query(PAYOUTS)).rows).toEqual(payoutsBefore);
    expect((await db.query("SELECT * FROM receipts ORDER BY id")).rows).toEqual(receiptsBefore);
    expect((await db.query("SELECT * FROM cash_up_counts ORDER BY id")).rows).toEqual(countsBefore);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM counter_refunds_owed WHERE booking_id = $1", [legacy])).rows).toEqual([{ n: 0 }]);
    // The new columns are empty on every ordinary row; no payout is marked.
    expect(
      (await db.query("SELECT COUNT(*)::int AS n FROM counter_refunds_owed WHERE historical_finding IS NOT NULL OR historical_evidence IS NOT NULL OR historical_remainder IS NOT NULL")).rows
    ).toEqual([{ n: 0 }]);
    expect((await db.query("SELECT bool_or(historical_reconciliation) AS any FROM counter_payouts")).rows).toEqual([{ any: false }]);
    expect((await db.query("SELECT convalidated FROM pg_constraint WHERE conname = 'counter_refunds_owed_historical'")).rows).toEqual([{ convalidated: true }]);

    // A reconciliation row for the pre-0346 note: only with its evidence, reason, verifier and amounts that add up.
    const reconcile = (over: Record<string, unknown> = {}) => {
      const v = {
        finding: "earlier_and_now", earlier: 10, on: "2026-03-02", via: "cash", now: 15, amount: 25, remainder: 5, remainderReason: "kept for damage",
        evidence: "till sheet 2 March", reason: "customer confirmed", verifier: "Mona", outcome: "back", cause: "customer_cancelled", ...over,
      };
      return db.query(
        `INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, settled_at, outcome, admin_id, admin_name, historical_finding,
                                           historical_earlier_amount, historical_earlier_on, historical_earlier_via, historical_now_amount, historical_remainder,
                                           historical_remainder_reason, historical_evidence, historical_reason, historical_verified_by_admin_id, historical_verified_by_name)
         VALUES ($1, $2, $3, 'cash', $4, now(), $5, $6, 'Mona', $7, $8, $9, $10, $11, $12, $13, $14, $15, $6, $16)`,
        [venue, legacy, v.amount, v.cause, v.outcome, admin, v.finding, v.earlier, v.on, v.via, v.now, v.remainder, v.remainderReason, v.evidence, v.reason, v.verifier]
      );
    };
    for (const bad of [
      { evidence: "  " },
      { evidence: null },
      { reason: null },
      { verifier: "" },
      { amount: 30 },
      { remainderReason: null },
      { remainder: null },
      { on: null },
      { via: null },
      { via: "cheque" },
      { finding: "earlier" },
      { finding: "not_owed" },
      { cause: "closure" },
      { now: 0, amount: 10 },
    ])
      await expect(reconcile(bad), JSON.stringify(bad)).rejects.toThrow();
    await reconcile();
    // One per cancellation: a second is refused by the 0346 index.
    await expect(reconcile()).rejects.toThrow();
    expect(legacyNote).toBeGreaterThan(0);

    // Running it again changes nothing.
    await run(db, FILES.filter((f) => f >= "0348"));
    expect((await db.query("SELECT COUNT(*)::int AS n FROM counter_refunds_owed")).rows).toEqual([{ n: 4 }]);
    await db.close();
  });
});
