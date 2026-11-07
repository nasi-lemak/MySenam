import { getDb, withTransaction } from "./db";
import { creditReceipt, paidHowOf } from "./documents";
import { addDays, localDateOf, todayISO } from "./time";
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
 *
 * The same list holds the refund of a counter-sold pass or membership (ADR 0068, `oweCounterRefund`): there the credit note is written when the
 * manager voids it with a refund (the tax document, in the till at once, as before), and the row is the task and the record that the money was
 * actually handed over: open until a named member of staff says so. A credit note is not cash paid. Settled, every kind is in that day's list of
 * money handed back at the counter (`feePayoutsOn`, with the bookings' payouts in lib/counter-refunds.ts `counterPayoutsOn`).
 */

export type FeeCause = "tournament_cancelled" | "before_draw" | "pass_refunded" | "membership_refunded";
/** What the refund is of. */
export type OwedKind = "entry" | "pass" | "membership";

/** A counter fee owed back, for staff to settle. */
export interface OwedEntryFee {
  id: number;
  venueId: number;
  kind: OwedKind;
  /** An entry's: null for a pass or a membership. */
  entryId: number | null;
  tournamentId: number | null;
  /** The tournament, for an entry; empty for the others. */
  tournamentName: string;
  /** What it is of, in the words a list needs: the tournament, the pass and its code, the membership's code. */
  what: string;
  /** Who paid, as the entry names them; a pass's or a membership's holder. */
  name: string;
  /** The credit note it reverses: written already for a pass or a membership, when settled for an entry. */
  creditNote: string | null;
  amount: number;
  via: CounterMethod | null;
  cause: FeeCause;
  owedSince: string;
  /** When it was paid at the counter; for a pass or a membership, when the credit note was written (the day the desk may still hand it back). */
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
  tournament_entry_id: number | null;
  pass_id: number | null;
  membership_id: number | null;
  amount: number;
  via: CounterMethod | null;
  cause: FeeCause;
  owed_since: string | Date;
  settled_at: string | Date | null;
  admin_name: string | null;
  tournament_id: number | null;
  tournament_name: string | null;
  entry_name: string | null;
  paid_at: string | null;
  pass_name: string | null;
  pass_code: string | null;
  pass_holder: string | null;
  membership_code: string | null;
  membership_holder: string | null;
  note_number: string | null;
}

const OWED_SQL = `SELECT o.id, o.venue_id, o.tournament_entry_id, o.pass_id, o.membership_id, o.amount::float AS amount, o.via, o.cause, o.owed_since, o.settled_at, o.admin_name,
                         t.id AS tournament_id, t.name AS tournament_name, e.name AS entry_name, e.paid_at,
                         p.name AS pass_name, p.code AS pass_code, p.holder_name AS pass_holder, m.code AS membership_code, m.holder_name AS membership_holder,
                         r.number AS note_number
                    FROM counter_fee_refunds_owed o
                    LEFT JOIN tournament_entries e ON e.id = o.tournament_entry_id LEFT JOIN tournaments t ON t.id = e.tournament_id
                    LEFT JOIN passes p ON p.id = o.pass_id LEFT JOIN memberships m ON m.id = o.membership_id
                    LEFT JOIN receipts r ON r.id = o.credit_note_id`;

async function toOwed(r: OwedRow, role: StaffRole, zones: Map<number, string>): Promise<OwedEntryFee> {
  if (!zones.has(r.venue_id)) zones.set(r.venue_id, (await venueHours(r.venue_id)).zone);
  const zone = zones.get(r.venue_id)!;
  const kind: OwedKind = r.pass_id !== null ? "pass" : r.membership_id !== null ? "membership" : "entry";
  const owedSince = new Date(r.owed_since).toISOString();
  // An entry's fee was taken on the day it was marked paid; a pass's or a membership's refund is written, and handed back, from the day its credit note is.
  const paidAt = kind === "entry" ? r.paid_at : owedSince;
  return {
    id: r.id,
    venueId: r.venue_id,
    kind,
    entryId: r.tournament_entry_id,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name ?? "",
    what: kind === "entry" ? (r.tournament_name ?? "") : kind === "pass" ? `${r.pass_name ?? ""} ${r.pass_code ?? ""}`.trim() : (r.membership_code ?? ""),
    name: (kind === "entry" ? r.entry_name : kind === "pass" ? r.pass_holder : r.membership_holder) ?? "",
    creditNote: r.note_number,
    amount: Number(r.amount),
    via: r.via,
    cause: r.cause,
    owedSince,
    paidAt,
    managerOnly: role === "desk" && (!paidAt || localDateOf(paidAt, zone) !== todayISO(zone)),
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
 * Staff settle a counter fee owed back: handed back at the counter the way it was paid, by whom and when recorded. An entry's credit note is written
 * now; a pass's or a membership's was written when it was voided and is only linked here. Once: two members of staff at the same moment settle it
 * once. The front desk hands back only a fee taken today; anything older is a manager's.
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
    if (owed.kind !== "entry") return true;
    const row = (await db.prepare("SELECT receipt_source FROM counter_fee_refunds_owed WHERE id = ?").get(id)) as { receipt_source: string };
    // The whole fee goes back: the credit note reverses the receipt it was taken on (a receipt already credited by hand is not credited twice).
    const note = await creditReceipt(row.receipt_source, "receipt.why.voided");
    if (note) await db.prepare("UPDATE counter_fee_refunds_owed SET credit_note_id = ? WHERE id = ?").run(note.id, id);
    return true;
  });
  if (!done) return refused(FEE_OWED_REFUSALS.settled);
  return { ok: true, owed: (await owedEntryFee(id, staff.role)) ?? owed };
}

/**
 * In the caller's transaction, a credit note written for a counter-sold pass or membership whose unused part is handed back (ADR 0068): the same
 * amount written down as owed back at the counter, so there is a task and a record of who paid it out, as a booking's refund has. A credit note is
 * the tax document and counts in the till as written; it is not cash paid. Only money taken at the counter is handed back across it: a pass bought
 * online is owed back on its payment (lib/payments.ts `oweBackPass`), one paid for with stored credit is not here. Once per credit note. False
 * where nothing was written.
 */
export async function oweCounterRefund(
  note: { id: number; total: number; paidVia: string | null; venueId: number | null },
  subject: { passId: number } | { membershipId: number }
): Promise<boolean> {
  if (note.venueId === null || !(note.total > 0)) return false;
  const how = paidHowOf(note.paidVia);
  if (!how || (how.via !== "counter" && !(COUNTER_METHODS as readonly string[]).includes(how.via))) return false;
  const passId = "passId" in subject ? subject.passId : null;
  const membershipId = "membershipId" in subject ? subject.membershipId : null;
  const made = await getDb()
    .prepare(
      `INSERT INTO counter_fee_refunds_owed (venue_id, pass_id, membership_id, receipt_source, amount, via, cause, credit_note_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (credit_note_id) WHERE credit_note_id IS NOT NULL DO NOTHING`
    )
    .run(note.venueId, passId, membershipId, passId !== null ? `pass:${passId}` : `membership:${membershipId}`, note.total, methodOf(note.paidVia), passId !== null ? "pass_refunded" : "membership_refunded", note.id);
  return made.changes > 0;
}

/** Money handed back at the counter against an entry fee, a pass or a membership: for the list beside the bookings' payouts. */
export interface FeePayout {
  id: number;
  venueId: number;
  kind: OwedKind;
  /** What it was for: who and which tournament, pass or membership. */
  what: string;
  amount: number;
  via: CounterMethod | null;
  creditNote: string | null;
  adminName: string;
  paidOutAt: string;
}

/** What was handed back at the counter on `date` (the venue's own day) from the owed list, at these venues (every venue where null), newest first. */
export async function feePayoutsOn(venueIds: number[] | null, date: string): Promise<FeePayout[]> {
  if (venueIds && venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `${OWED_SQL} WHERE o.settled_at IS NOT NULL AND o.settled_at >= ?::timestamptz AND o.settled_at < ?::timestamptz
         ${venueIds ? `AND o.venue_id IN (${venueIds.map(() => "?").join(",")})` : ""} ORDER BY o.settled_at DESC, o.id DESC`
    )
    // A day either side, then the venue's own day: its time zone decides.
    .all(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, ...(venueIds ?? []))) as OwedRow[];
  const zones = new Map<number, string>();
  const out: FeePayout[] = [];
  for (const r of rows) {
    if (!zones.has(r.venue_id)) zones.set(r.venue_id, (await venueHours(r.venue_id)).zone);
    const at = new Date(r.settled_at!).toISOString();
    if (localDateOf(at, zones.get(r.venue_id)!) !== date) continue;
    const owed = await toOwed(r, "manager", zones);
    out.push({
      id: r.id,
      venueId: r.venue_id,
      kind: owed.kind,
      what: `${owed.name}, ${owed.what}`,
      amount: owed.amount,
      via: owed.via,
      creditNote: owed.creditNote,
      adminName: r.admin_name ?? "",
      paidOutAt: at,
    });
  }
  return out;
}
