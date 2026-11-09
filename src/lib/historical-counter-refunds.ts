import { logAction } from "./activity";
import { getDb, isUniqueViolation, withTransaction } from "./db";
import { payOutHistorical, type CancellingStaff } from "./counter-refunds";
import { isAmount, money, roundMoney } from "./region";
import { localDateOf, todayISO } from "./time";
import { COUNTER_METHODS, PAID_VIA_LABELS, type CounterMethod, type Refusal } from "./types";
import { venueZoneOf } from "./zones";

/**
 * Cancellations from before the obligation was written (ADR 0078; docs/features/payments-and-credit.md#cancellations-from-before-the-obligation-was-written).
 *
 * Before migration 0346 a customer's cancellation of a booking paid at the counter (and a person a customer, or the venue's API key, took off it)
 * wrote its credit note and nothing else: no owed row, so nobody was told to hand the money back, and nothing says whether it was. The cash-up
 * counts such a note as cash leaving the till on its own day (ADR 0075's rule for a note nothing points at), and those days may be counted.
 *
 * Here a manager reviews them one credit note at a time (the same rules as `scripts/reconcile-counter-cancellations.sql`) and records what the
 * evidence shows, as a row of the list of counter money owed back, written already settled and marked historical (migration 0348):
 *
 * - **handed back earlier** (part or all): the day, the method and the evidence reference. No payout and no cash moves: that day's till already
 *   took the note out, and it is not rewritten.
 * - **handed back now** (part or all): a payout dated now, by the method used, on the old credit note, written by the path a customer's
 *   cancellation is settled with (`payOutHistorical`), marked so today's cash-up takes it out and the note's own day is left as counted.
 * - **what is left** of the credit note, with the reason it is not returned: stored, never an invisible obligation.
 *
 * The owed row's `owed_since` and `settled_at` are when it is recorded, never the cancellation's date, so no past day's "still owed" changes.
 * One per cancellation and one per withdrawal (the unique indexes of 0346): a second record, or two managers at once, is refused as already
 * recorded. Insufficient evidence is not saved, and there is no "not owed" shortcut: the case stays on the list. Managers only (`MANAGER_ONLY`).
 */

export const HISTORICAL_FINDINGS = ["earlier", "now", "earlier_and_now"] as const;
export type HistoricalFinding = (typeof HISTORICAL_FINDINGS)[number];

export const HISTORICAL_REFUSALS = {
  notListed: "That credit note is not on the list of cancellations to review.",
  already: "Already recorded: this cancellation has its record on the list of money owed back.",
  finding: "Say what the evidence shows: handed back earlier, handed back now, or part of each.",
  evidence: "Give the evidence reference: the till sheet, the cash book, a receipt or the log entry.",
  reason: "Give the reason for this record.",
  earlier: "The part handed back earlier needs its amount, the day it was handed back and how.",
  earlierDay: "The day it was handed back earlier is between the cancellation and yesterday. Money handed back today is recorded as handed back now.",
  now: "The part handed back now needs its amount and how it is handed back.",
  tooMuch: "Together the amounts cannot be more than the credit note.",
  remainder: "Part of the credit note is not handed back: say why, in the reason for what is left.",
  acknowledge: "A day this record concerns already has a till count. Read the preview, then confirm you have seen it.",
} as const;

const refused = (error: string): Refusal => ({ ok: false, error });
const MAX_TEXT = 500;

/** The day migration 0346 was applied: cancellations before it wrote no owed row. Null where it has not been. */
export async function obligationSince(): Promise<string | null> {
  const row = (await getDb().prepare("SELECT applied_at FROM schema_migrations WHERE version = '0346_customer_cancel_counter_owed'").get()) as
    | { applied_at: string | Date }
    | undefined;
  return row ? new Date(row.applied_at).toISOString() : null;
}

/** A credit note of a cancellation (or a person taken off) from before 0346, with no record of the money going back. */
export interface HistoricalCandidate {
  kind: "cancellation" | "withdrawal";
  venueId: number;
  venueName: string;
  bookingId: number;
  bookingCode: string;
  withdrawalId: number | null;
  creditNoteId: number;
  creditNote: string;
  /** The credit note's total: what the cancellation sold back, after any late share kept. The most that can be recorded. */
  noteTotal: number;
  /** The credit note's day on the venue's calendar: the day the cash-up took it out of the till. */
  noteDay: string;
  /** How the customer paid; null where the method was never recorded. */
  paidWith: CounterMethod | null;
  /** Staff activity-log entries naming the booking that say money went back (`payment.paid_out`, `payment.owed_credited`). */
  logEvidence: string[];
  /** Other credit notes on the booking (a move to a cheaper time, another person taken off, a price adjustment). */
  otherNotes: { count: number; total: number };
  /** Stored credit added for the booking. */
  storedCredit: number;
  /** Already handed back at the counter on this booking for its other credit notes (a move's difference, a person taken off). */
  paidOutOnBooking: number;
  /** Any of the above: part or all may already be back. */
  possibleDuplicate: boolean;
}

interface CandidateRow {
  kind: "cancellation" | "withdrawal";
  booking_id: number;
  withdrawal_id: number | null;
  note_id: number;
  note_number: string;
  note_total: number;
  issued_at: string;
  paid_via: string | null;
  code: string;
  venue_id: number;
  venue_name: string;
  time_zone: string | null;
  lat: number | null;
  lng: number | null;
  log_actions: string | null;
  other_n: number;
  other_total: number;
  credit_total: number;
  paid_out: number;
}

const COUNTER_PAID = "b.payment_status = 'paid' AND (b.paid_via IS NULL OR b.paid_via IN ('cash', 'qr', 'transfer', 'card')) AND b.account_id IS NULL AND NOT b.test AND b.demo = 0";
const BEFORE_0346 = `(cn.issued_at::timestamp AT TIME ZONE 'UTC') < COALESCE((SELECT applied_at FROM schema_migrations WHERE version = '0346_customer_cancel_counter_owed'), 'infinity'::timestamptz)`;

/**
 * The candidates, by the rules of `scripts/reconcile-counter-cancellations.sql` (kept the same; `tests/historical-counter-refunds.test.ts` checks
 * both list the same credit notes):
 *
 * - a whole cancellation: the booking's credit note (`booking:<id>`), cancelled, with no owed row for the cancellation (a move's row is not one),
 *   no payout naming that note or naming none (a payout from before payouts named their note may be this one), no stored credit given by staff
 *   for it, and not logged as cancelled by staff;
 * - a person taken off by the customer or the venue's API key (`booking:<id>:place:<withdrawal>`): no owed row for that withdrawal, no payout
 *   naming its note, no stored credit given by staff for it;
 *
 * paid at the counter (cash, QR, transfer, card, or a tick whose method was never recorded; not an account's charge), not a test or demo, the
 * note above nothing and written before migration 0346 was applied.
 */
function candidatesSql(filter: string): string {
  return `
    WITH cand AS (
      SELECT 'cancellation' AS kind, b.id AS booking_id, NULL::integer AS withdrawal_id, cn.id AS note_id
        FROM bookings b JOIN receipts cn ON cn.kind = 'credit_note' AND cn.source = 'booking:' || b.id
       WHERE b.status = 'cancelled' AND ${COUNTER_PAID} AND cn.total > 0 AND ${BEFORE_0346}
         AND NOT EXISTS (SELECT 1 FROM counter_refunds_owed o WHERE o.booking_id = b.id AND o.move_refund_id IS NULL AND o.withdrawal_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM counter_payouts p WHERE p.booking_id = b.id AND (p.credit_note_id IS NULL OR p.credit_note_id = cn.id))
         AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.booking_id = b.id AND w.admin_id IS NOT NULL AND w.amount > 0
                            AND w.move_refund_id IS NULL AND w.withdrawal_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM staff_actions s WHERE s.booking_code = b.code AND s.action = 'booking.cancelled')
      UNION ALL
      SELECT 'withdrawal', b.id, pw.id, cn.id
        FROM place_withdrawals pw JOIN bookings b ON b.id = pw.booking_id
        JOIN receipts cn ON cn.kind = 'credit_note' AND cn.source = 'booking:' || b.id || ':place:' || pw.id
       WHERE pw.by_kind IN ('customer', 'api') AND pw.paid AND ${COUNTER_PAID} AND cn.total > 0 AND ${BEFORE_0346}
         AND NOT EXISTS (SELECT 1 FROM counter_refunds_owed o WHERE o.withdrawal_id = pw.id)
         AND NOT EXISTS (SELECT 1 FROM counter_payouts p WHERE p.credit_note_id = cn.id)
         AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.withdrawal_id = pw.id AND w.admin_id IS NOT NULL AND w.amount > 0)
    )
    SELECT cand.kind, cand.booking_id, cand.withdrawal_id, cand.note_id, cn.number AS note_number, cn.total::float AS note_total, cn.issued_at,
           b.paid_via, b.code, v.id AS venue_id, v.name AS venue_name, v.time_zone, v.lat, v.lng,
           (SELECT string_agg(DISTINCT s.action, ', ' ORDER BY s.action) FROM staff_actions s
             WHERE s.booking_code = b.code AND s.action IN ('payment.paid_out', 'payment.owed_credited')) AS log_actions,
           (SELECT COUNT(*) FROM receipts o WHERE o.kind = 'credit_note' AND o.id <> cn.id
               AND (o.source = 'booking:' || b.id OR o.source LIKE 'booking:' || b.id || ':%'))::int AS other_n,
           (SELECT COALESCE(SUM(o.total), 0) FROM receipts o WHERE o.kind = 'credit_note' AND o.id <> cn.id
               AND (o.source = 'booking:' || b.id OR o.source LIKE 'booking:' || b.id || ':%'))::float AS other_total,
           (SELECT COALESCE(SUM(w.amount), 0) FROM wallet_entries w WHERE w.booking_id = b.id AND w.amount > 0)::float AS credit_total,
           (SELECT COALESCE(SUM(p.amount), 0) FROM counter_payouts p WHERE p.booking_id = b.id)::float AS paid_out
      FROM cand JOIN receipts cn ON cn.id = cand.note_id JOIN bookings b ON b.id = cand.booking_id
      JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
     WHERE ${filter}
     ORDER BY v.name, cn.issued_at, b.code, cn.number`;
}

const asMethod = (m: string | null): CounterMethod | null => ((COUNTER_METHODS as readonly string[]).includes(m ?? "") ? (m as CounterMethod) : null);

function toCandidate(r: CandidateRow): HistoricalCandidate {
  const zone = venueZoneOf(r);
  const otherNotes = { count: Number(r.other_n), total: roundMoney(Number(r.other_total)) };
  const storedCredit = roundMoney(Number(r.credit_total));
  const paidOutOnBooking = roundMoney(Number(r.paid_out));
  const logEvidence = r.log_actions ? r.log_actions.split(", ") : [];
  return {
    kind: r.kind,
    venueId: r.venue_id,
    venueName: r.venue_name,
    bookingId: r.booking_id,
    bookingCode: r.code,
    withdrawalId: r.withdrawal_id,
    creditNoteId: r.note_id,
    creditNote: r.note_number,
    noteTotal: roundMoney(Number(r.note_total)),
    noteDay: localDateOf(String(r.issued_at), zone),
    paidWith: asMethod(r.paid_via),
    logEvidence,
    otherNotes,
    storedCredit,
    paidOutOnBooking,
    possibleDuplicate: logEvidence.length > 0 || otherNotes.count > 0 || storedCredit > 0 || paidOutOnBooking > 0,
  };
}

/** The candidates at these venues (every venue where null: the platform's own), oldest first within a venue. */
export async function historicalCandidates(venueIds: number[] | null): Promise<HistoricalCandidate[]> {
  if (venueIds && venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(candidatesSql(venueIds ? `v.id IN (${venueIds.map(() => "?").join(",")})` : "true"))
    .all(...(venueIds ?? []))) as CandidateRow[];
  return rows.map(toCandidate);
}

async function candidateByNote(creditNoteId: number): Promise<HistoricalCandidate | null> {
  const row = (await getDb().prepare(candidatesSql("cand.note_id = ?")).get(creditNoteId)) as CandidateRow | undefined;
  return row ? toCandidate(row) : null;
}

/** A recorded reconciliation, as the list shows it: completed, labelled historical. */
export interface HistoricalRecord {
  id: number;
  venueId: number;
  bookingCode: string;
  kind: "cancellation" | "withdrawal";
  creditNote: string | null;
  noteTotal: number | null;
  paidWith: CounterMethod | null;
  finding: HistoricalFinding;
  earlier: { amount: number; on: string; via: CounterMethod } | null;
  now: { amount: number; via: CounterMethod | null; paidOutAt: string | null } | null;
  /** Handed back in all (earlier and now). */
  amount: number;
  remainder: number;
  remainderReason: string | null;
  evidence: string;
  reason: string;
  verifiedBy: string;
  /** When it was recorded (UTC, ISO): the owed row's `owed_since` and `settled_at`. */
  recordedAt: string;
  countedDaysAcknowledged: boolean;
}

/** The reconciliations recorded at these venues, newest first. */
export async function historicalRecords(venueIds: number[] | null): Promise<HistoricalRecord[]> {
  if (venueIds && venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT o.id, o.venue_id, b.code, o.withdrawal_id, r.number AS note_number, r.total::float AS note_total, o.via, o.historical_finding,
              o.historical_earlier_amount::float AS earlier_amount, o.historical_earlier_on::text AS earlier_on, o.historical_earlier_via,
              o.historical_now_amount::float AS now_amount, p.via AS now_via, p.paid_out_at, o.amount::float AS amount,
              o.historical_remainder::float AS remainder, o.historical_remainder_reason, o.historical_evidence, o.historical_reason,
              o.historical_verified_by_name, o.settled_at, o.historical_counted_days_acknowledged
         FROM counter_refunds_owed o JOIN bookings b ON b.id = o.booking_id
         LEFT JOIN receipts r ON r.kind = 'credit_note'
              AND r.source = CASE WHEN o.withdrawal_id IS NULL THEN 'booking:' || o.booking_id ELSE 'booking:' || o.booking_id || ':place:' || o.withdrawal_id END
         LEFT JOIN counter_payouts p ON p.booking_id = o.booking_id AND p.historical_reconciliation AND p.credit_note_id = r.id
        WHERE o.historical_finding IS NOT NULL${venueIds ? ` AND o.venue_id IN (${venueIds.map(() => "?").join(",")})` : ""}
        ORDER BY o.settled_at DESC, o.id DESC`
    )
    .all(...(venueIds ?? []))) as {
    id: number; venue_id: number; code: string; withdrawal_id: number | null; note_number: string | null; note_total: number | null; via: string | null;
    historical_finding: HistoricalFinding; earlier_amount: number | null; earlier_on: string | null; historical_earlier_via: string | null;
    now_amount: number | null; now_via: string | null; paid_out_at: string | Date | null; amount: number; remainder: number;
    historical_remainder_reason: string | null; historical_evidence: string; historical_reason: string; historical_verified_by_name: string;
    settled_at: string | Date; historical_counted_days_acknowledged: boolean | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    bookingCode: r.code,
    kind: r.withdrawal_id === null ? "cancellation" : "withdrawal",
    creditNote: r.note_number,
    noteTotal: r.note_total === null ? null : roundMoney(Number(r.note_total)),
    paidWith: asMethod(r.via),
    finding: r.historical_finding,
    earlier:
      r.earlier_amount !== null
        ? { amount: roundMoney(Number(r.earlier_amount)), on: String(r.earlier_on).slice(0, 10), via: asMethod(r.historical_earlier_via) as CounterMethod }
        : null,
    now: r.now_amount !== null ? { amount: roundMoney(Number(r.now_amount)), via: asMethod(r.now_via), paidOutAt: r.paid_out_at ? new Date(r.paid_out_at).toISOString() : null } : null,
    amount: roundMoney(Number(r.amount)),
    remainder: roundMoney(Number(r.remainder)),
    remainderReason: r.historical_remainder_reason,
    evidence: r.historical_evidence,
    reason: r.historical_reason,
    verifiedBy: r.historical_verified_by_name,
    recordedAt: new Date(r.settled_at).toISOString(),
    countedDaysAcknowledged: r.historical_counted_days_acknowledged === true,
  }));
}

/** What a manager submits for one credit note. */
export interface HistoricalInput {
  creditNoteId: number;
  finding: HistoricalFinding;
  earlier: { amount: number; on: string; via: CounterMethod } | null;
  now: { amount: number; via: CounterMethod } | null;
  evidence: string;
  reason: string;
  remainderReason: string | null;
  acknowledgeCountedDays: boolean;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "");
const isMethod = (v: unknown): v is CounterMethod => typeof v === "string" && (COUNTER_METHODS as readonly string[]).includes(v);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** The request's body as a submission, or what is missing. The amounts against the credit note are checked with it (`planHistorical`). */
export function readHistorical(body: Record<string, unknown>): HistoricalInput | Refusal {
  const id = body.creditNoteId;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return refused(HISTORICAL_REFUSALS.notListed);
  const finding = body.finding;
  if (!(HISTORICAL_FINDINGS as readonly unknown[]).includes(finding)) return refused(HISTORICAL_REFUSALS.finding);
  const f = finding as HistoricalFinding;
  const e = (body.earlier ?? null) as { amount?: unknown; on?: unknown; via?: unknown } | null;
  const n = (body.now ?? null) as { amount?: unknown; via?: unknown } | null;
  let earlier: HistoricalInput["earlier"] = null;
  let now: HistoricalInput["now"] = null;
  if (f !== "now") {
    if (!e || typeof e !== "object" || !isAmount(e.amount, 0.01) || !isDay(e.on) || !isMethod(e.via)) return refused(HISTORICAL_REFUSALS.earlier);
    earlier = { amount: roundMoney(e.amount), on: e.on, via: e.via };
  }
  if (f !== "earlier") {
    if (!n || typeof n !== "object" || !isAmount(n.amount, 0.01) || !isMethod(n.via)) return refused(HISTORICAL_REFUSALS.now);
    now = { amount: roundMoney(n.amount), via: n.via };
  }
  const evidence = text(body.evidence);
  if (!evidence) return refused(HISTORICAL_REFUSALS.evidence);
  const reason = text(body.reason);
  if (!reason) return refused(HISTORICAL_REFUSALS.reason);
  return { creditNoteId: id, finding: f, earlier, now, evidence, reason, remainderReason: text(body.remainderReason) || null, acknowledgeCountedDays: body.acknowledgeCountedDays === true };
}

/** A till count recorded for a day: who counted, when. */
export interface DayCount {
  by: string | null;
  at: string;
}

/** What saving would write, and what it does to the cash-up, in parts the screen puts into words. */
export interface HistoricalPreview {
  candidate: HistoricalCandidate;
  finding: HistoricalFinding;
  /** Handed back in all. */
  amount: number;
  remainder: number;
  /** The owed row, already settled and marked historical. */
  writes: { owedRow: true; payout: { amount: number; via: CounterMethod } | null; creditNote: false };
  /** Today's cash-up: the part handed back now, by its method; null where nothing is handed back now. */
  today: { day: string; amount: number; via: CounterMethod; counts: DayCount[] } | null;
  /** The credit note's day: not changed (it counted the note as handed back on that day under the old rule). */
  noteDay: { day: string; counts: DayCount[] };
  /** The day it was handed back earlier: not changed. */
  earlierDay: { day: string; amount: number; via: CounterMethod; counts: DayCount[] } | null;
  /** A day above has a till count: saving needs `acknowledgeCountedDays: true`. */
  needsAcknowledgement: boolean;
}

async function countsOn(venueId: number, day: string): Promise<DayCount[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT counted_by_name, MAX(created_at) AS at FROM cash_up_counts WHERE venue_id = ? AND day = ? GROUP BY counted_by_name ORDER BY MAX(created_at)`
    )
    .all(venueId, day)) as { counted_by_name: string | null; at: string | Date }[];
  return rows.map((r) => ({ by: r.counted_by_name, at: new Date(r.at).toISOString() }));
}

async function venueZone(venueId: number): Promise<string> {
  const v = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  return venueZoneOf(v ?? {});
}

/** The submission checked against its credit note, and its preview; a refusal where it cannot be saved as it is. */
async function planHistorical(candidate: HistoricalCandidate, input: HistoricalInput): Promise<{ ok: true; preview: HistoricalPreview } | Refusal> {
  const today = todayISO(await venueZone(candidate.venueId));
  if (input.earlier && (input.earlier.on < candidate.noteDay || input.earlier.on >= today)) return refused(HISTORICAL_REFUSALS.earlierDay);
  const amount = roundMoney((input.earlier?.amount ?? 0) + (input.now?.amount ?? 0));
  if (amount > candidate.noteTotal + 0.001) return refused(HISTORICAL_REFUSALS.tooMuch);
  const remainder = roundMoney(candidate.noteTotal - amount);
  if (remainder > 0 && !input.remainderReason) return refused(HISTORICAL_REFUSALS.remainder);
  const preview: HistoricalPreview = {
    candidate,
    finding: input.finding,
    amount,
    remainder,
    writes: { owedRow: true, payout: input.now ? { amount: input.now.amount, via: input.now.via } : null, creditNote: false },
    today: input.now ? { day: today, amount: input.now.amount, via: input.now.via, counts: await countsOn(candidate.venueId, today) } : null,
    noteDay: { day: candidate.noteDay, counts: await countsOn(candidate.venueId, candidate.noteDay) },
    earlierDay: input.earlier
      ? { day: input.earlier.on, amount: input.earlier.amount, via: input.earlier.via, counts: input.earlier.on === candidate.noteDay ? [] : await countsOn(candidate.venueId, input.earlier.on) }
      : null,
    needsAcknowledgement: false,
  };
  preview.needsAcknowledgement = [preview.today?.counts, preview.noteDay.counts, preview.earlierDay?.counts].some((c) => (c?.length ?? 0) > 0);
  return { ok: true, preview };
}

/** Whether this credit note already has its reconciliation (or any owed row for its cancellation or withdrawal). */
async function alreadyRecorded(creditNoteId: number): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM receipts r JOIN counter_refunds_owed o
           ON r.source = CASE WHEN o.withdrawal_id IS NULL THEN 'booking:' || o.booking_id ELSE 'booking:' || o.booking_id || ':place:' || o.withdrawal_id END
          AND o.move_refund_id IS NULL
        WHERE r.id = ? AND r.kind = 'credit_note'`
    )
    .get(creditNoteId);
  return row !== undefined;
}

/** The candidate a submission is for, or why there is none. The caller checks the venue is the manager's. */
export async function historicalCandidate(creditNoteId: number): Promise<{ ok: true; candidate: HistoricalCandidate } | Refusal> {
  const candidate = await candidateByNote(creditNoteId);
  if (candidate) return { ok: true, candidate };
  return refused((await alreadyRecorded(creditNoteId)) ? HISTORICAL_REFUSALS.already : HISTORICAL_REFUSALS.notListed);
}

/** What saving would write and do to the cash-up. Nothing is written. */
export async function previewHistorical(input: HistoricalInput): Promise<{ ok: true; preview: HistoricalPreview } | Refusal> {
  const found = await historicalCandidate(input.creditNoteId);
  if (!found.ok) return found;
  return planHistorical(found.candidate, input);
}

const viaWords = (via: CounterMethod | null) => (via ? PAID_VIA_LABELS[via] : "a method never recorded");

/**
 * Record it, once: the owed row (already settled, historical), the payout for the part handed back now, and the staff activity log, in one
 * transaction checked again against the candidate list. Two managers at once, or a second submission, write one record; the other is refused
 * as already recorded. A day with a till count needs `acknowledgeCountedDays`.
 */
export async function recordHistorical(input: HistoricalInput, staff: CancellingStaff & { id: number }): Promise<{ ok: true; preview: HistoricalPreview; recordId: number } | Refusal> {
  try {
    return await withTransaction(async () => {
      const found = await historicalCandidate(input.creditNoteId);
      if (!found.ok) return found;
      const planned = await planHistorical(found.candidate, input);
      if (!planned.ok) return planned;
      const { preview } = planned;
      if (preview.needsAcknowledgement && !input.acknowledgeCountedDays) return refused(HISTORICAL_REFUSALS.acknowledge);
      const c = found.candidate;
      const db = getDb();
      const inserted = (await db
        .prepare(
          `INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, withdrawal_id, owed_since, settled_at, outcome, admin_id, admin_name, settled_via,
                                             historical_finding, historical_earlier_amount, historical_earlier_on, historical_earlier_via, historical_now_amount,
                                             historical_remainder, historical_remainder_reason, historical_evidence, historical_reason,
                                             historical_verified_by_admin_id, historical_verified_by_name, historical_counted_days_acknowledged)
           VALUES (?, ?, ?, ?, ?, ?, now(), now(), 'back', ?, ?, ?, ?, ?, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .get(
          c.venueId,
          c.bookingId,
          preview.amount,
          c.paidWith,
          c.kind === "withdrawal" ? "place_withdrawn" : "customer_cancelled",
          c.withdrawalId,
          staff.id,
          staff.name,
          input.now && input.now.via !== c.paidWith ? input.now.via : null,
          input.finding,
          input.earlier?.amount ?? null,
          input.earlier?.on ?? null,
          input.earlier?.via ?? null,
          input.now?.amount ?? null,
          preview.remainder,
          preview.remainder > 0 ? input.remainderReason : null,
          input.evidence,
          input.reason,
          staff.id,
          staff.name,
          preview.needsAcknowledgement ? input.acknowledgeCountedDays : null
        )) as { id: number };
      if (input.now) await payOutHistorical(inserted.id, input.now.amount, input.now.via, staff);
      const parts = [
        input.earlier ? `${money(input.earlier.amount)} handed back on ${input.earlier.on} by ${PAID_VIA_LABELS[input.earlier.via]} (no cash moves now)` : "",
        input.now ? `${money(input.now.amount)} handed back now by ${PAID_VIA_LABELS[input.now.via]}` : "",
        preview.remainder > 0 ? `${money(preview.remainder)} not returned: ${input.remainderReason}` : "",
      ].filter(Boolean);
      await logAction(staff, {
        venueId: c.venueId,
        action: "payment.historical_reconciled",
        bookingCode: c.bookingCode,
        detail: `Credit note ${c.creditNote} (${money(c.noteTotal)}, ${c.kind === "withdrawal" ? "a person taken off" : "cancelled"} ${c.noteDay}, paid by ${viaWords(c.paidWith)}), from before money owed back was written down: ${parts.join("; ")}. Evidence: ${input.evidence}. Reason: ${input.reason}${preview.needsAcknowledgement ? ". A counted day acknowledged" : ""}`,
      });
      if (input.now)
        await logAction(staff, {
          venueId: c.venueId,
          action: "payment.paid_out",
          bookingCode: c.bookingCode,
          detail: `${money(input.now.amount)} handed back at the counter, by ${PAID_VIA_LABELS[input.now.via]}, for credit note ${c.creditNote} of a cancellation from before money owed back was written down (a historical reconciliation)`,
        });
      return { ok: true as const, preview, recordId: inserted.id };
    });
  } catch (err) {
    // Two managers at once: the one-per-cancellation (or per-withdrawal) index lets one through.
    if (isUniqueViolation(err)) return refused(HISTORICAL_REFUSALS.already);
    throw err;
  }
}
