import { getDb, withTransaction } from "./db";
import { creditReceipt } from "./documents";
import { localDateOf, todayISO } from "./time";
import { venueHours } from "./store";
import type { StaffRole } from "./roles";
import { COUNTER_METHODS, PAID_VIA_LABELS, type CounterMethod, type Refusal } from "./types";

/**
 * A tournament entry fee taken at the counter, owed back (ADR 0059; docs/features/tournaments.md#entry-fees-taken-at-the-counter-owed-back).
 *
 * A venue that calls a tournament off, or takes an entrant out before the draw where the tournament's rules refund before the draw, owes back
 * what was paid at the counter, as it does for a booking it cancels (lib/counter-refunds.ts `oweCounter`): the debt is written down at once
 * (`counter_fee_refunds_owed`: how much, how it was paid, why), it is listed for staff with the bookings owed back, and **nothing is paid out
 * automatically**. Staff settle it when the customer comes (`settleEntryFee`): handed back the way it was paid, by whom and when recorded, the
 * credit note on the entry's receipt written then (so the till, the credit note and the day's cash-up agree) and a line in the activity log.
 * A fee paid online is not here: the gateway gives it back (`refund_due` on the payment).
 *
 * Only a fee that was receipted at the counter is owed this way: the receipt (`entry:<id>@...`, not yet credited) says how much and how.
 */

export type FeeCause = "tournament_cancelled" | "before_draw";

/** A counter fee owed back, for staff to settle. */
export interface OwedEntryFee {
  id: number;
  venueId: number;
  entryId: number;
  tournamentId: number;
  tournamentName: string;
  /** Who paid, as the entry names them. */
  name: string;
  amount: number;
  via: CounterMethod | null;
  cause: FeeCause;
  owedSince: string;
  paidAt: string | null;
  /** Paid at the counter on an earlier day: only a manager hands it back, as when staff cancel a booking. */
  managerOnly: boolean;
  settled: { by: string; at: string } | null;
}

export const FEE_OWED_REFUSALS = {
  notFound: "Nothing is owed back on that.",
  settled: "That was settled already. Look at the list again.",
  manager: "The front desk can only give back a counter payment taken today. Ask a manager.",
} as const;

const refused = (error: string): Refusal => ({ ok: false, error });

/** The method a receipt's `paid_via` label names, or null where it only says the counter. */
function methodOf(label: string | null): CounterMethod | null {
  return (COUNTER_METHODS.find((m) => PAID_VIA_LABELS[m] === label) as CounterMethod | undefined) ?? null;
}

/**
 * In the caller's transaction: the fee taken at the counter for this entry written down as owed back. False where there is none (nothing was paid
 * there, it was paid online, or it was credited already) or it was written down already. Once per entry.
 */
export async function oweEntryFee(entryId: number, cause: FeeCause): Promise<boolean> {
  const db = getDb();
  const receipt = (await db
    .prepare(
      `SELECT r.source, r.total::float AS total, r.paid_via, t.venue_id FROM receipts r
         JOIN tournament_entries e ON e.id = ? JOIN tournaments t ON t.id = e.tournament_id
        WHERE r.source LIKE ? AND r.kind = 'receipt' AND NOT EXISTS (SELECT 1 FROM receipts c WHERE c.credits_id = r.id)
        ORDER BY r.id DESC LIMIT 1`
    )
    .get(entryId, `entry:${entryId}@%`)) as { source: string; total: number; paid_via: string | null; venue_id: number } | undefined;
  if (!receipt || !(receipt.total > 0)) return false;
  const made = await db
    .prepare(
      `INSERT INTO counter_fee_refunds_owed (venue_id, tournament_entry_id, receipt_source, amount, via, cause) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tournament_entry_id) DO NOTHING`
    )
    .run(receipt.venue_id, entryId, receipt.source, receipt.total, methodOf(receipt.paid_via), cause);
  return made.changes > 0;
}

interface OwedRow {
  id: number;
  venue_id: number;
  tournament_entry_id: number;
  amount: number;
  via: CounterMethod | null;
  cause: FeeCause;
  owed_since: string | Date;
  settled_at: string | Date | null;
  admin_name: string | null;
  tournament_id: number;
  tournament_name: string;
  entry_name: string;
  paid_at: string | null;
}

const OWED_SQL = `SELECT o.id, o.venue_id, o.tournament_entry_id, o.amount::float AS amount, o.via, o.cause, o.owed_since, o.settled_at, o.admin_name,
                         t.id AS tournament_id, t.name AS tournament_name, e.name AS entry_name, e.paid_at
                    FROM counter_fee_refunds_owed o JOIN tournament_entries e ON e.id = o.tournament_entry_id JOIN tournaments t ON t.id = e.tournament_id`;

async function toOwed(r: OwedRow, role: StaffRole, zones: Map<number, string>): Promise<OwedEntryFee> {
  if (!zones.has(r.venue_id)) zones.set(r.venue_id, (await venueHours(r.venue_id)).zone);
  const zone = zones.get(r.venue_id)!;
  return {
    id: r.id,
    venueId: r.venue_id,
    entryId: r.tournament_entry_id,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    name: r.entry_name,
    amount: Number(r.amount),
    via: r.via,
    cause: r.cause,
    owedSince: new Date(r.owed_since).toISOString(),
    paidAt: r.paid_at,
    managerOnly: role === "desk" && (!r.paid_at || localDateOf(r.paid_at, zone) !== todayISO(zone)),
    settled: r.settled_at && r.admin_name ? { by: r.admin_name, at: new Date(r.settled_at).toISOString() } : null,
  };
}

/** What is still owed back at these venues (every venue where null), oldest first. */
export async function entryFeesOwed(venueIds: number[] | null, role: StaffRole): Promise<OwedEntryFee[]> {
  if (venueIds && venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(`${OWED_SQL} WHERE o.settled_at IS NULL${venueIds ? ` AND o.venue_id IN (${venueIds.map(() => "?").join(",")})` : ""} ORDER BY o.owed_since, o.id`)
    .all(...(venueIds ?? []))) as OwedRow[];
  const zones = new Map<number, string>();
  const out: OwedEntryFee[] = [];
  for (const r of rows) out.push(await toOwed(r, role, zones));
  return out;
}

/** One owed fee, settled or not, as `role` would be shown it. */
export async function owedEntryFee(id: number, role: StaffRole): Promise<OwedEntryFee | null> {
  const row = (await getDb().prepare(`${OWED_SQL} WHERE o.id = ?`).get(id)) as OwedRow | undefined;
  return row ? toOwed(row, role, new Map()) : null;
}

/**
 * Staff settle a counter fee owed back: handed back at the counter the way it was paid, by whom and when recorded, the credit note written now.
 * Once: two members of staff at the same moment settle it once. The front desk hands back only a fee taken today; anything older is a manager's.
 */
export async function settleEntryFee(id: number, staff: { id: number; name: string; role: StaffRole }): Promise<{ ok: true; owed: OwedEntryFee } | Refusal> {
  const owed = await owedEntryFee(id, staff.role);
  if (!owed) return refused(FEE_OWED_REFUSALS.notFound);
  if (owed.settled) return refused(FEE_OWED_REFUSALS.settled);
  if (owed.managerOnly) return refused(FEE_OWED_REFUSALS.manager);
  const done = await withTransaction(async () => {
    const db = getDb();
    const claimed = await db
      .prepare("UPDATE counter_fee_refunds_owed SET settled_at = now(), outcome = 'back', admin_id = ?, admin_name = ? WHERE id = ? AND settled_at IS NULL")
      .run(staff.id, staff.name, id);
    if (claimed.changes !== 1) return false;
    const row = (await db.prepare("SELECT receipt_source FROM counter_fee_refunds_owed WHERE id = ?").get(id)) as { receipt_source: string };
    // The whole fee goes back: the credit note reverses the receipt it was taken on (a receipt already credited by hand is not credited twice).
    const note = await creditReceipt(row.receipt_source, "receipt.why.voided");
    if (note) await db.prepare("UPDATE counter_fee_refunds_owed SET credit_note_id = ? WHERE id = ?").run(note.id, id);
    return true;
  });
  if (!done) return refused(FEE_OWED_REFUSALS.settled);
  return { ok: true, owed: (await owedEntryFee(id, staff.role)) ?? owed };
}
