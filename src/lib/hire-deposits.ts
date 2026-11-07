import { getDb } from "./db";
import { roundMoney } from "./region";

/**
 * Hire deposits: money the venue holds for customers while their kit is out (`hire_records`; lib/store.ts `takeHire`,
 * `returnHire`). One definition of "held", for everything that reads it: the venue's liabilities in the reports
 * (lib/reports.ts `venueOwes`, ADR 0055) and the cash-up's "held for customers" lines (lib/cash-up.ts): a deposit is held
 * from the moment the kit goes out until it comes back, and what is kept back becomes a sale then (lib/counter-sales.ts
 * `sellKeptDeposit`), not before. How it was held at handover (`deposit_via`) says which till, terminal or account it sits in;
 * null for a deposit taken before that was recorded, or a waived one; for one taken before it was recorded, what staff stated since
 * (`deposit_via_stated`, migration 0327) counts, and the NULL `deposit_via` stays as the marker.
 */

export interface HeldByMethod {
  method: string | null;
  amount: number;
}

export interface HireDepositsHeld {
  total: number;
  byMethod: HeldByMethod[];
}

/** The calendar day of a stored UTC timestamp (`datetime('now')` text) in `zone`, for a column of `hire_records`. */
export const hireDay = (column: string) => `to_char((${column}::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD')`;

/**
 * What the venue holds in deposits for kit not yet back: now, or, with `at`, at the end of that day on the venue's calendar
 * (`zone`): taken by then and not back until after it.
 */
export async function hireDepositsHeld(venueId: number, at?: { day: string; zone: string }): Promise<HireDepositsHeld> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT COALESCE(h.deposit_via, h.deposit_via_stated) AS method, COALESCE(SUM(h.deposit), 0)::float AS amount
         FROM hire_records h JOIN bookings b ON b.id = h.booking_id
        WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND h.deposit > 0
          AND ${at ? `${hireDay("h.taken_at")} <= ? AND (h.returned_at IS NULL OR ${hireDay("h.returned_at")} > ?)` : "h.returned_at IS NULL"}
        GROUP BY COALESCE(h.deposit_via, h.deposit_via_stated) ORDER BY COALESCE(h.deposit_via, h.deposit_via_stated)`
    )
    .all(...(at ? [venueId, at.zone, at.day, at.zone, at.day] : [venueId]))) as { method: string | null; amount: number }[];
  const byMethod = rows.map((r) => ({ method: r.method, amount: roundMoney(Number(r.amount)) }));
  return { total: roundMoney(byMethod.reduce((s, r) => s + r.amount, 0)), byMethod };
}
