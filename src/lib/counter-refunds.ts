import { logAction } from "./activity";
import { getDb, withTransaction } from "./db";
import { creditBooking, creditBookingMove } from "./documents";
import { creditScope } from "./mode";
import { money, roundMoney } from "./region";
import { said, withPhrase } from "./staff-text";
import { addDays, formatHour, isPastSlot, isWithinCancelWindow, localDateOf, todayISO } from "./time";
import { cancelPolicyFor } from "./cancel-policy";
import { policyRefusal } from "./policy-overrides";
import type { StaffRole } from "./roles";
import { COUNTER_METHODS, PAID_VIA_LABELS, type Booking, type CounterMethod, type PaidVia, type Refusal } from "./types";
import {
  adminCancelBooking,
  cancelCutoffForBooking,
  depositGone,
  findBookingByCode,
  getCourt,
  hasOpenHire,
  paidPartLeft,
  venueHours,
  type CancelResult,
  type StaffCancelSettlement,
} from "./store";

/**
 * Staff cancelling a booking that was paid (X1-1, X1-10;
 * docs/features/payments-and-credit.md#cancelling-a-booking-paid-at-the-counter).
 *
 * Before anything is done staff see what was paid towards it and how, and the
 * venue's terms as a customer cancelling would meet them (lib/cancel-policy.ts:
 * free up to the cutoff; past it, the venue's late share where it keeps one).
 * Then they choose how it is settled:
 *
 * - `back`: the way it was paid. A counter payment (cash, QR, transfer, card)
 *   is handed back at the counter and written down as paid out, by whom and on
 *   which credit note (`counter_payouts`, listed for the till); credit goes
 *   back to credit, a pass to the pass, and money paid online is owed back on
 *   the payment, as every staff cancellation already did.
 * - `credit`: a counter payment given as stored credit instead, to the
 *   booking's own account (`wallet_entries`, with the booking and the member
 *   of staff); the credit note says it went back as stored credit.
 * - `keep`: the venue's late share kept, the rest going back the way it was
 *   paid, only where the booking is past the venue's cutoff and the venue
 *   keeps a share of late cancellations.
 *
 * It is the same cancellation and the same refund as before (lib/store.ts
 * `adminCancelBooking`, `refundBooking`): the outcome only says what share
 * goes back and records where it went. A counter payment taken on an earlier
 * day is given back by a manager only, as *Mark unpaid* is.
 */

export const CANCEL_OUTCOMES = ["back", "credit", "keep"] as const;
export type CancelOutcome = (typeof CANCEL_OUTCOMES)[number];
export const isCancelOutcome = (v: unknown): v is CancelOutcome => typeof v === "string" && (CANCEL_OUTCOMES as readonly string[]).includes(v);

/** How the customer's own payment on a booking was made, as it decides how it can go back. */
export type PaidHowKind = "none" | "counter" | "online" | "credit" | "pass" | "account";

export interface StaffCancelOption {
  outcome: CancelOutcome;
  /** What goes back, in all (the customer's own payment and any deposit paid online). */
  refund: number;
  /** What the venue keeps. */
  kept: number;
}

/** What cancelling a booking would do, shown to staff before they choose. */
export interface StaffCancelPreview {
  code: string;
  name: string;
  date: string;
  startHour: number;
  endHour: number;
  seriesCode: string | null;
  /** The customer's own payment towards it as it stands (places taken off since excluded); 0 when unpaid. */
  paid: number;
  paidVia: PaidVia | null;
  paidAt: string | null;
  how: PaidHowKind;
  /** A deposit paid online to hold it: goes back online, whatever is chosen (less the venue's share on `keep`). */
  deposit: number;
  /** Past the venue's free-cancellation cutoff. */
  late: boolean;
  cutoffHours: number;
  /** The share the venue keeps of a late cancellation, where it keeps one and the booking is late; else null. */
  keptPercent: number | null;
  /** The ways it can be settled; with nothing paid, only `back` (nothing to give back). */
  options: StaffCancelOption[];
  /** A counter payment taken on an earlier day: only a manager gives it back. */
  managerOnly: boolean;
  /** Kit on hire is still out: it is taken back before the booking can be cancelled. */
  kitOut: boolean;
  /** Made from a customer's account: only then can a counter payment be given back as stored credit. */
  account: boolean;
}

/** Refusals, in English as sent; staff screens say them in their language (lib/staff-i18n/refusals-2.ts). */
export const COUNTER_REFUSALS = {
  notOffered: "That way of settling is not offered for this booking. Look at it again.",
  changed: "What was paid on this booking, or the venue's terms, changed since you looked. Look at it again.",
  manager: "The front desk can only give back a counter payment taken today. Ask a manager.",
  noAccount: "This booking was not made from an account, so it cannot be given as credit.",
} as const;

const refused = (error: string): Refusal => ({ ok: false, error });

const isCounter = (via: PaidVia | null | undefined): boolean => via === null || via === undefined || (COUNTER_METHODS as readonly string[]).includes(via);

/** How the booking's own payment was made. */
function howPaid(b: Booking): PaidHowKind {
  if (b.paymentStatus !== "paid") return "none";
  if (b.accountId) return "account";
  if (b.paidVia === "online") return "online";
  if (b.paidVia === "credit") return "credit";
  if (b.paidVia === "pass") return "pass";
  return isCounter(b.paidVia) ? "counter" : "online";
}

/**
 * The terms a booking would be cancelled on by staff, and each way of
 * settling it. Staff may cancel past the cutoff and while it is being played
 * (they may waive the venue's terms); the venue's late share is offered where
 * its terms would keep one, never invented where they would not.
 */
export async function staffCancelTerms(b: Booking, role: StaffRole): Promise<StaffCancelPreview> {
  const court = await getCourt(b.courtId);
  const venueId = court?.venueId ?? 0;
  const { zone } = await venueHours(venueId);
  const cutoff = await cancelCutoffForBooking(b.id);
  const late = !isWithinCancelWindow(b.date, b.startHour, cutoff, zone);
  const { lateKeep } = court ? await cancelPolicyFor(venueId, b.sport) : { lateKeep: null };
  const keptPercent = late && lateKeep !== null ? lateKeep : null;
  const how = howPaid(b);
  const paid = how === "none" ? 0 : roundMoney((b.totalPrice - (b.sharesPaid ?? 0)) * (await paidPartLeft(b.id)));
  const deposit = roundMoney(Math.max(0, (b.depositPaid ?? 0) - (await depositGone(b.id))));
  const all = roundMoney(paid + deposit);
  const account = await bookedFromAccount(b.id);
  const options: StaffCancelOption[] = [{ outcome: "back", refund: all, kept: 0 }];
  if (how === "counter" && paid > 0 && account) options.push({ outcome: "credit", refund: all, kept: 0 });
  if (keptPercent !== null && all > 0) {
    const back = roundMoney(all * (1 - keptPercent / 100));
    options.push({ outcome: "keep", refund: back, kept: roundMoney(all - back) });
  }
  // The desk puts right its own counter takings of the day; anything older is a manager's (as `setPaymentStatus` says).
  const earlier = how === "counter" && paid > 0 && paidBeforeToday(b.paidAt, zone);
  return {
    code: b.code,
    name: b.name,
    date: b.date,
    startHour: b.startHour,
    endHour: b.endHour,
    seriesCode: b.seriesCode,
    paid,
    paidVia: b.paidVia ?? null,
    paidAt: b.paidAt,
    how,
    deposit,
    late,
    cutoffHours: cutoff,
    keptPercent,
    options,
    managerOnly: role === "desk" && earlier,
    kitOut: await hasOpenHire(b.id),
    account,
  };
}

/** Made from a customer's account, which stored credit belongs to. */
async function bookedFromAccount(bookingId: number): Promise<boolean> {
  const row = (await getDb().prepare("SELECT user_id FROM bookings WHERE id = ?").get(bookingId)) as { user_id: number | null } | undefined;
  return row?.user_id !== null && row?.user_id !== undefined;
}

/** What cancelling this booking would do, for staff; a refusal where it cannot be cancelled. */
export async function previewStaffCancel(code: string, role: StaffRole): Promise<{ ok: true; preview: StaffCancelPreview } | Refusal> {
  const b = await findBookingByCode(code.trim());
  if (!b) return policyRefusal("BOOKING_NOT_FOUND");
  if (b.status === "cancelled") return policyRefusal("ALREADY_CANCELLED");
  return { ok: true, preview: await staffCancelTerms(b, role) };
}

/** Who is cancelling: recorded with any payout or credit. */
export interface CancellingStaff {
  id: number | null;
  name: string;
  role: StaffRole;
}

/** What was settled, once the cancellation has gone through: for the log and the screen. */
export interface Settled {
  outcome: CancelOutcome;
  refund: number;
  kept: number;
  /** Handed back at the counter, and how; or given as credit. */
  paidOut?: { amount: number; via: CounterMethod | null };
  credited?: number;
}

/**
 * The settlement `adminCancelBooking` applies for the outcome staff chose,
 * worked out again from the booking as it is cancelled. With `expectRefund`,
 * refused if what would go back is no longer what staff were shown.
 */
function settlementFor(
  outcome: CancelOutcome,
  staff: CancellingStaff,
  expectRefund: number | undefined,
  out: { settled?: Settled }
): (b: Booking) => Promise<StaffCancelSettlement | Refusal> {
  return async (b) => {
    const terms = await staffCancelTerms(b, staff.role);
    const option = terms.options.find((o) => o.outcome === outcome);
    if (!option) return refused(outcome === "credit" && terms.how === "counter" && !terms.account ? COUNTER_REFUSALS.noAccount : COUNTER_REFUSALS.notOffered);
    if (expectRefund !== undefined && Math.abs(option.refund - expectRefund) > 0.004) return refused(COUNTER_REFUSALS.changed);
    if (terms.managerOnly && option.refund > 0) return refused(COUNTER_REFUSALS.manager);
    const share = outcome === "keep" ? (100 - terms.keptPercent!) / 100 : 1;
    out.settled = { outcome, refund: option.refund, kept: option.kept };
    return {
      share,
      ...(outcome === "keep" ? { keptPercent: terms.keptPercent! } : {}),
      ...(outcome === "credit" ? { backAs: PAID_VIA_LABELS.credit } : {}),
      // Decided by the booking as it is cancelled, not as it was previewed: only counter money is paid out or credited here.
      settle: async (bookingId) => {
        const settled = await settleCounter(bookingId, outcome, share, outcome === "keep" ? terms.keptPercent : null, staff);
        if (settled) Object.assign(out.settled!, settled);
      },
    };
  };
}

/** A booking's own payment, where it was made at the counter (not on an account): `share` of what is left of it. */
async function counterMoney(bookingId: number, share = 1) {
  const row = (await getDb()
    .prepare(
      `SELECT b.code, b.user_id, b.payment_status, b.paid_via, b.account_id, (b.total_price - b.shares_paid)::float AS own, c.venue_id
         FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?`
    )
    .get(bookingId)) as
    | { code: string; user_id: number | null; payment_status: string; paid_via: string | null; account_id: number | null; own: number; venue_id: number }
    | undefined;
  if (!row || row.payment_status !== "paid" || row.account_id !== null || !isCounter(row.paid_via as PaidVia | null)) return null;
  const amount = roundMoney(Number(row.own) * (await paidPartLeft(bookingId)) * share);
  if (amount <= 0) return null;
  const via = (COUNTER_METHODS as readonly string[]).includes(row.paid_via ?? "") ? (row.paid_via as CounterMethod) : null;
  return { row, amount, via };
}

/**
 * The counter money of a booking just cancelled, read again with its row
 * claimed: handed back (a payout for the till) or given as credit. Nothing
 * where it was not paid at the counter after all.
 */
async function settleCounter(
  bookingId: number,
  outcome: CancelOutcome,
  share: number,
  keptPercent: number | null,
  staff: CancellingStaff
): Promise<Partial<Settled> | null> {
  const db = getDb();
  const counter = await counterMoney(bookingId, share);
  if (!counter) return null;
  const { row, amount } = counter;
  if (outcome === "credit") {
    if (row.user_id === null) throw new Error("credit without an account");
    await db
      .prepare("INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, booking_id, venue_id, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.user_id, amount, ...withPhrase(said("srv.wallet.refund", { code: row.code })), bookingId, creditScope() === "venue" ? row.venue_id : null, staff.id);
    return { credited: amount };
  }
  const note = (await db.prepare("SELECT id FROM receipts WHERE source = ? AND kind = 'credit_note'").get(`booking:${bookingId}`)) as { id: number } | undefined;
  const { via } = counter;
  await db
    .prepare(
      `INSERT INTO counter_payouts (venue_id, booking_id, credit_note_id, amount, via, kept_percent, admin_id, admin_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.venue_id, bookingId, note?.id ?? null, amount, via, keptPercent, staff.id, staff.name);
  return { paidOut: { amount, via } };
}

/**
 * Staff cancel a booking, settling what was paid as they chose (`back` where
 * not said, as every staff cancellation did). The same cancellation as
 * before: claimed once, so two at the same moment refund once.
 */
export async function staffCancel(
  code: string,
  staff: CancellingStaff,
  choice: { outcome?: CancelOutcome; expectRefund?: number } = {}
): Promise<{ result: CancelResult; settled: Settled | null }> {
  const out: { settled?: Settled } = {};
  const result = await adminCancelBooking(code, settlementFor(choice.outcome ?? "back", staff, choice.expectRefund, out));
  return { result, settled: result.ok ? (out.settled ?? null) : null };
}

/* ---------------- A weekly series, by staff ---------------- */

/** Each week of a series still to be played, and what cancelling it would do, for staff. */
export interface StaffSeriesWeek extends StaffCancelPreview {
  /** Cancellable now: not over, nothing on hire still out. */
  open: boolean;
}

async function seriesBookings(seriesCode: string): Promise<Booking[]> {
  const rows = (await getDb()
    .prepare("SELECT code FROM bookings WHERE UPPER(series_code) = UPPER(?) AND status = 'confirmed' ORDER BY date, start_min")
    .all(seriesCode.trim())) as { code: string }[];
  const out: Booking[] = [];
  for (const r of rows) {
    const b = await findBookingByCode(r.code);
    if (b) out.push(b);
  }
  return out;
}

/**
 * The upcoming weeks of a series, each with its own terms, as the customer's
 * series preview gives them (lib/store.ts `seriesCancelPlan`): inside the free
 * window all of it back; past it, the venue's late share where it keeps one.
 * Staff may cancel weeks a customer could not (past the cutoff), as they may
 * one booking. Weeks already played are left out.
 */
export async function previewStaffSeries(seriesCode: string, role: StaffRole): Promise<{ ok: true; weeks: StaffSeriesWeek[]; venueIds: number[] } | Refusal> {
  const all = await seriesBookings(seriesCode);
  if (all.length === 0) return refused("Series not found.");
  const weeks: StaffSeriesWeek[] = [];
  const venueIds = new Set<number>();
  for (const b of all) {
    const court = await getCourt(b.courtId);
    if (court) venueIds.add(court.venueId);
    const { zone } = await venueHours(court?.venueId ?? 0);
    if (isPastSlot(b.date, b.endHour, zone)) continue;
    const terms = await staffCancelTerms(b, role);
    weeks.push({ ...terms, open: !terms.kitOut });
  }
  return { ok: true, weeks, venueIds: [...venueIds] };
}

/** The venues a series' bookings are at, for the caller's access check. */
export async function seriesVenueIds(seriesCode: string): Promise<number[]> {
  const rows = (await getDb()
    .prepare(
      "SELECT DISTINCT c.venue_id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE UPPER(b.series_code) = UPPER(?)"
    )
    .all(seriesCode.trim())) as { venue_id: number }[];
  return rows.map((r) => r.venue_id);
}

/**
 * Cancel the weeks of a series staff chose, each on its own terms with the
 * outcome chosen: where a week has no such option (`keep` inside the free
 * window, `credit` on a week not paid at the counter), it goes back the way
 * it was paid. Each week is cancelled and settled in its own transaction,
 * once; a week that cannot go (kit out, a manager's refund, already
 * cancelled) is returned with why, and the others still go.
 */
export async function staffCancelSeries(
  seriesCode: string,
  codes: string[],
  staff: CancellingStaff,
  choice: { outcome?: CancelOutcome; expect?: Record<string, number> } = {}
): Promise<
  | { ok: true; cancelled: { booking: Booking; settled: Settled | null }[]; left: { code: string; error: string }[] }
  | Refusal
> {
  const plan = await previewStaffSeries(seriesCode, staff.role);
  if (!plan.ok) return plan;
  const byCode = new Map(plan.weeks.map((w) => [w.code.toUpperCase(), w]));
  const chosen = [...new Set(codes.map((c) => c.trim().toUpperCase()))];
  if (chosen.length === 0) return { ok: false, error: "Choose the weeks to cancel." };
  for (const c of chosen) if (!byCode.has(c)) return refused(COUNTER_REFUSALS.changed);
  const cancelled: { booking: Booking; settled: Settled | null }[] = [];
  const left: { code: string; error: string }[] = [];
  for (const c of chosen) {
    const week = byCode.get(c)!;
    const wanted = choice.outcome ?? "back";
    const outcome = week.options.some((o) => o.outcome === wanted) ? wanted : "back";
    const expect = choice.expect?.[week.code] ?? choice.expect?.[c];
    const done = await staffCancel(week.code, staff, { outcome, ...(expect !== undefined ? { expectRefund: expect } : {}) });
    if (done.result.ok) cancelled.push({ booking: done.result.booking, settled: done.settled });
    else left.push({ code: week.code, error: done.result.error });
  }
  return { ok: true, cancelled, left };
}

/* ---------------- What the till paid out ---------------- */

export interface CounterPayout {
  id: number;
  venueId: number;
  bookingCode: string;
  amount: number;
  via: CounterMethod | null;
  keptPercent: number | null;
  /** The credit note it was paid out on. */
  creditNote: string | null;
  adminName: string;
  paidOutAt: string;
}

/** Money handed back at the counter on a day (the venue's own day), for the till: newest first. */
export async function counterPayoutsOn(venueIds: number[] | null, date: string): Promise<CounterPayout[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.venue_id, b.code, p.amount::float AS amount, p.via, p.kept_percent, r.number AS note_number, p.admin_name, p.paid_out_at
         FROM counter_payouts p JOIN bookings b ON b.id = p.booking_id LEFT JOIN receipts r ON r.id = p.credit_note_id
        WHERE p.paid_out_at >= ?::timestamptz AND p.paid_out_at < ?::timestamptz
          ${venueIds ? `AND p.venue_id IN (${venueIds.map(() => "?").join(",") || "NULL"})` : ""}
        ORDER BY p.id DESC`
    )
    // A day either side, then the venue's own day: its time zone decides.
    .all(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, ...(venueIds ?? []))) as {
    id: number;
    venue_id: number;
    code: string;
    amount: number;
    via: CounterMethod | null;
    kept_percent: number | null;
    note_number: string | null;
    admin_name: string;
    paid_out_at: string | Date;
  }[];
  const zones = new Map<number, string>();
  const out: CounterPayout[] = [];
  for (const r of rows) {
    if (!zones.has(r.venue_id)) zones.set(r.venue_id, (await venueHours(r.venue_id)).zone);
    const at = new Date(r.paid_out_at).toISOString();
    if (localDateOf(at, zones.get(r.venue_id)!) !== date) continue;
    out.push({
      id: r.id,
      venueId: r.venue_id,
      bookingCode: r.code,
      amount: Number(r.amount),
      via: r.via,
      keptPercent: r.kept_percent,
      creditNote: r.note_number,
      adminName: r.admin_name,
      paidOutAt: at,
    });
  }
  return out;
}

/* ---------------- Owed back after the venue cancels ---------------- */

/**
 * The venue's own cancellations of many bookings at once: closing a day, a
 * court taken out of service, a rain-out, and the venue's API key
 * (docs/features/payments-and-credit.md#owed-back-after-the-venue-cancels).
 * Nobody stands at the till for each, and staff are not asked booking by
 * booking, so a counter payment on one is written down as owed back
 * (`counter_refunds_owed`) instead of being said to have gone back. It is the
 * same cancellation as a staff one (`adminCancelBooking`, `refundBooking`):
 * money paid online, with credit or with a pass goes back as it always did.
 *
 * Staff then settle each from the day list as a staff cancellation settles
 * (`settleCounter`): handed back at the counter (a payout with who and how, in
 * that day's cash-up) or as stored credit on the account it was booked from.
 * The booking's credit note is written then, by the member of staff settling
 * it, so the till, the credit note and the payout agree.
 *
 * A manager clearing a test booking from before going live, who says real
 * money was taken at the counter on it, owes it back the same way, with the
 * cause `test` (lib/test-bookings.ts).
 */
export const VENUE_CANCEL_CAUSES = ["closure", "outage", "rain", "api", "class", "test", "lesson_moved"] as const;
export type VenueCancelCause = (typeof VENUE_CANCEL_CAUSES)[number];
/** What the list of counter money owed back holds: what the venue cancelled, and a paid booking moved to a cheaper time (lib/move-money.ts). */
export type OwedCause = VenueCancelCause | "moved_cheaper";
export type OwedOutcome = Extract<CancelOutcome, "back" | "credit">;
export const isOwedOutcome = (v: unknown): v is OwedOutcome => v === "back" || v === "credit";

/** The venue cancels a booking as part of a closure, an outage, a rain-out or through its API: all of it back, a counter payment owed. */
export async function venueCancel(
  code: string,
  cause: VenueCancelCause,
  /**
   * `offer: false` where the venue is taking the time away (a closed day, a rain-out, a court out of service): the freed
   * place is offered to nobody. `within` is written in the cancellation's transaction (a closure taking the freed time).
   */
  opts: { offer?: boolean; within?: (booking: Booking) => Promise<void> } = {}
): Promise<CancelResult> {
  return adminCancelBooking(code, async () => ({ share: 1, owe: (bookingId) => oweCounter(bookingId, cause) }), opts);
}

/** The counter payment on a booking that cancelling it would give back (the rule `oweCounter` and settling use), or null where there is none. */
export async function counterPaymentOn(bookingId: number): Promise<number | null> {
  return (await counterMoney(bookingId))?.amount ?? null;
}

/**
 * In the cancellation's transaction: a counter payment on it written down as owed back. False where none was. Also
 * for a class's enrolments as the class is called off (lib/store.ts `cancelClassSession`).
 */
export async function oweCounter(bookingId: number, cause: VenueCancelCause): Promise<boolean> {
  const counter = await counterMoney(bookingId);
  if (!counter) return false;
  await getDb()
    .prepare("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause) VALUES (?, ?, ?, ?, ?)")
    .run(counter.row.venue_id, bookingId, counter.amount, counter.via, cause);
  return true;
}

/** A counter payment owed back on a booking the venue cancelled, for staff to settle. */
export interface OwedRefund {
  id: number;
  venueId: number;
  bookingId: number;
  bookingCode: string;
  name: string;
  /** When the booking was for. */
  date: string;
  startMin: number;
  amount: number;
  via: CounterMethod | null;
  cause: OwedCause;
  owedSince: string;
  /** When it was paid at the counter. */
  paidAt: string | null;
  /** Made from a customer's account: it may be given as stored credit there. */
  account: boolean;
  /** Paid at the counter on an earlier day: only a manager hands it back, as when staff cancel. */
  managerOnly: boolean;
  /** Settled already: how, by whom and when. */
  settled: { outcome: OwedOutcome; by: string; at: string } | null;
}

export const OWED_REFUSALS = {
  notFound: "Nothing is owed back on that.",
  settled: "That was settled already. Look at the list again.",
} as const;

/** A counter payment taken on an earlier day than the venue's today: a manager's to give back (as `setPaymentStatus` says). */
function paidBeforeToday(paidAt: string | null, zone: string): boolean {
  return !paidAt || localDateOf(paidAt, zone) !== todayISO(zone);
}

interface OwedRow {
  id: number;
  venue_id: number;
  booking_id: number;
  amount: number;
  via: CounterMethod | null;
  cause: OwedCause;
  owed_since: string | Date;
  settled_at: string | Date | null;
  outcome: OwedOutcome | null;
  admin_name: string | null;
  code: string;
}

const OWED_SQL = `SELECT o.id, o.venue_id, o.booking_id, o.amount::float AS amount, o.via, o.cause, o.owed_since, o.settled_at, o.outcome, o.admin_name, b.code
                    FROM counter_refunds_owed o JOIN bookings b ON b.id = o.booking_id`;

async function toOwed(r: OwedRow, role: StaffRole, zones: Map<number, string>): Promise<OwedRefund | null> {
  const b = await findBookingByCode(r.code);
  if (!b) return null;
  if (!zones.has(r.venue_id)) zones.set(r.venue_id, (await venueHours(r.venue_id)).zone);
  return {
    id: r.id,
    venueId: r.venue_id,
    bookingId: r.booking_id,
    bookingCode: r.code,
    name: b.name,
    date: b.date,
    startMin: b.startMin,
    amount: Number(r.amount),
    via: r.via,
    cause: r.cause,
    owedSince: new Date(r.owed_since).toISOString(),
    paidAt: b.paidAt,
    account: await bookedFromAccount(r.booking_id),
    managerOnly: role === "desk" && paidBeforeToday(b.paidAt, zones.get(r.venue_id)!),
    settled: r.settled_at && r.outcome ? { outcome: r.outcome, by: r.admin_name ?? "", at: new Date(r.settled_at).toISOString() } : null,
  };
}

/** What is still owed back at the counter at these venues (every venue where null: the platform's own), oldest first. */
export async function counterOwed(venueIds: number[] | null, role: StaffRole): Promise<OwedRefund[]> {
  if (venueIds && venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `${OWED_SQL} WHERE o.settled_at IS NULL${venueIds ? ` AND o.venue_id IN (${venueIds.map(() => "?").join(",")})` : ""} ORDER BY o.owed_since, o.id`
    )
    .all(...(venueIds ?? []))) as OwedRow[];
  const zones = new Map<number, string>();
  const out: OwedRefund[] = [];
  for (const r of rows) {
    const owed = await toOwed(r, role, zones);
    if (owed) out.push(owed);
  }
  return out;
}

/** One owed refund, settled or not, as `role` would be shown it. */
export async function owedRefund(id: number, role: StaffRole): Promise<OwedRefund | null> {
  const row = (await getDb().prepare(`${OWED_SQL} WHERE o.id = ?`).get(id)) as OwedRow | undefined;
  return row ? toOwed(row, role, new Map()) : null;
}

/**
 * Staff settle a counter payment owed back: `back`, handed back at the counter
 * the way it was paid (a payout for the till, by whom, on the credit note
 * written now), or `credit`, as stored credit on the account it was booked
 * from. Once: two members of staff at the same moment settle it once. The
 * front desk hands back only a payment taken today; anything older is a
 * manager's, as when staff cancel.
 */
export async function settleOwed(
  id: number,
  outcome: OwedOutcome,
  staff: CancellingStaff
): Promise<{ ok: true; owed: OwedRefund; settled: Settled } | Refusal> {
  const owed = await owedRefund(id, staff.role);
  if (!owed) return refused(OWED_REFUSALS.notFound);
  if (owed.settled) return refused(OWED_REFUSALS.settled);
  if (owed.managerOnly) return refused(COUNTER_REFUSALS.manager);
  if (outcome === "credit" && !owed.account) return refused(COUNTER_REFUSALS.noAccount);
  const done = await withTransaction(async () => {
    const claimed = await getDb()
      .prepare("UPDATE counter_refunds_owed SET settled_at = now(), outcome = ?, admin_id = ?, admin_name = ? WHERE id = ? AND settled_at IS NULL")
      .run(outcome, staff.id, staff.name, id);
    if (claimed.changes !== 1) return null;
    // A difference owed back after a paid booking was moved to a cheaper time: that sum alone, not the booking (lib/move-money.ts).
    if (owed.cause === "moved_cheaper") return settleMoveDifference(owed, outcome, staff);
    // The credit note the cancellation left for now, written by whoever settles it: as stored credit, or the way it was paid.
    await creditBooking(owed.bookingId, "receipt.why.cancelled", 1, await paidPartLeft(owed.bookingId), outcome === "credit" ? PAID_VIA_LABELS.credit : undefined);
    return (await settleCounter(owed.bookingId, outcome, 1, null, staff)) ?? {};
  });
  if (!done) return refused(OWED_REFUSALS.settled);
  return {
    ok: true,
    owed: (await owedRefund(id, staff.role)) ?? owed,
    settled: { outcome, refund: owed.amount, kept: 0, ...done },
  };
}

/**
 * A difference owed back at the counter after a paid booking was moved to a cheaper time, settled in the claiming transaction: its credit
 * note now (so the till, the credit note and the cash-up agree), then handed back the way it was paid (a payout with who and which note)
 * or, at the customer's request, as stored credit on the account it was booked from. Only this sum: never the booking's whole price.
 */
async function settleMoveDifference(owed: OwedRefund, outcome: OwedOutcome, staff: CancellingStaff): Promise<Partial<Settled>> {
  const db = getDb();
  const move = (await db.prepare("SELECT move_refund_id AS id FROM counter_refunds_owed WHERE id = ?").get(owed.id)) as { id: number | null } | undefined;
  if (!move?.id) throw new Error("move row missing");
  const note = await creditBookingMove(owed.bookingId, move.id, owed.amount, outcome === "credit" ? PAID_VIA_LABELS.credit : undefined);
  const row = (await db
    .prepare("SELECT b.code, b.user_id, c.venue_id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?")
    .get(owed.bookingId)) as { code: string; user_id: number | null; venue_id: number };
  if (outcome === "credit") {
    if (row.user_id === null) throw new Error("credit without an account");
    await db
      .prepare("INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, booking_id, venue_id, admin_id, move_refund_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.user_id, owed.amount, ...withPhrase(said("srv.wallet.refund", { code: row.code })), owed.bookingId, creditScope() === "venue" ? row.venue_id : null, staff.id, move.id);
    return { credited: owed.amount };
  }
  await db
    .prepare(
      `INSERT INTO counter_payouts (venue_id, booking_id, credit_note_id, amount, via, kept_percent, admin_id, admin_name)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(row.venue_id, owed.bookingId, note?.id ?? null, owed.amount, owed.via, staff.id, staff.name);
  return { paidOut: { amount: owed.amount, via: owed.via } };
}

/* ---------------- Saying what was done ---------------- */

/** In the activity log: the cancellation, how the money was settled, and any cash handed back at the counter. */
export async function logCancelled(admin: { id: number; name: string }, venueId: number, booking: Booking, settled: Settled | null): Promise<void> {
  const how =
    settled && settled.refund + settled.kept > 0
      ? settled.outcome === "credit"
        ? `; ${money(settled.credited ?? settled.refund)} given as stored credit`
        : settled.outcome === "keep"
          ? `; the venue kept ${money(settled.kept)} on its late terms, ${money(settled.refund)} back as paid`
          : `; ${money(settled.refund)} back as paid`
      : "";
  await logAction(admin, {
    venueId,
    action: "booking.cancelled",
    bookingCode: booking.code,
    detail: `${booking.date} ${formatHour(booking.startHour)}, ${booking.name}, ${money(booking.totalPrice)}${
      booking.paymentStatus === "paid" ? " (was paid)" : ""
    }${how}`,
  });
  if (settled?.paidOut)
    await logAction(admin, {
      venueId,
      action: "payment.paid_out",
      bookingCode: booking.code,
      detail: `${money(settled.paidOut.amount)} handed back at the counter${settled.paidOut.via ? `, by ${PAID_VIA_LABELS[settled.paidOut.via]}` : ""}`,
    });
}

/** What the customer is told of the money, where it was not all given back the way it was paid. */
export function settledWords(settled: Settled | null): { phrase: "p8a.msg.credit" | "p8a.msg.kept" | "p8a.msg.keptAll"; vars: Record<string, string> } | undefined {
  if (!settled || settled.refund + settled.kept <= 0) return undefined;
  if (settled.outcome === "credit" && settled.credited) return { phrase: "p8a.msg.credit", vars: { amount: money(settled.credited) } };
  if (settled.outcome === "keep")
    return settled.refund > 0
      ? { phrase: "p8a.msg.kept", vars: { kept: money(settled.kept), amount: money(settled.refund) } }
      : { phrase: "p8a.msg.keptAll", vars: {} };
  return undefined;
}
