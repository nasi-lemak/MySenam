import { getDb } from "./db";
import { money, region, roundMoney } from "./region";
import type { PaymentResult } from "./gateways/types";
import type { OnlinePayment } from "./payments";

/**
 * Whether what a gateway reports is what the page asked for, before anything is applied, and the list of what staff
 * must look at because it was not (audit C19 and C18; docs/features/payments-and-credit.md#settlement-checks,
 * [ADR 0065](../../docs/architecture/decisions/0065-a-payment-is-settled-for-the-amount-the-gateway-took-and-never-into-a-lapsed-hold.md)).
 *
 * A payment is not settled because a signed report says "paid". The gateway's own figures are held against the
 * page's: the bill it says it made against the one MySenam asked for, the currency, the collection, and what it says
 * it took. A match settles as before. More than was asked settles what was asked and owes the rest back. Less, a bill
 * that is not ours, a currency that is not the install's, or a paid report without the amounts the gateway documents on
 * it is applied to nothing: the money received is recorded and owed back whole, the booking or product stays as it was,
 * and the payment goes on the list of payments to check. Every observation is one staff activity-log row and some
 * columns of the payment row; no receipt, credit note or booking is edited to make it so.
 *
 * What a report that carries no amounts (a renewal charge, a test, a redirect Billplz cannot say more about) is believed
 * for is what it always was: it settles the page's amount. The mocks in tests/ prove the arithmetic and the guards, not
 * that Billplz sends these fields: that is checked in its sandbox (docs/integrations/payment-gateways.md).
 */

export type SettlementIssue =
  | "underpaid"
  | "overpaid"
  | "bill_amount"
  | "collection"
  | "currency"
  | "unverified"
  | "hold_lapsed"
  | "short_after_settled";

/** The issues that keep a payment from being applied at all. */
export type HoldIssue = "underpaid" | "bill_amount" | "collection" | "currency" | "unverified";

export type Assessment =
  /** Settle what the page asked for. `receivedMinor` is what the gateway said it took, where it said. */
  | { kind: "match"; receivedMinor: number | null }
  /** Settle what the page asked for; the rest of `receivedMinor` is owed back. */
  | { kind: "over"; receivedMinor: number; excessMinor: number }
  /** Apply nothing: record what was received (where it is known) and owe it back. */
  | { kind: "hold"; issue: HoldIssue; receivedMinor: number | null };

const minorUnits = () => 10 ** region().currency.minorUnits;

/** Whole currency units to the smallest unit, as the gateway counts. */
export const toMinor = (amount: number | string): number => Math.round(Number(amount) * minorUnits());
/** The smallest unit to whole currency units, as a payment row holds it. */
export const fromMinor = (minor: number): number => roundMoney(minor / minorUnits());

/** What the page asked for, held against what the gateway said. Pure. */
export function assessSettlement(row: { amount: number | string }, result: PaymentResult): Assessment {
  const received = result.receivedMinor ?? null;
  if (result.mismatch) return { kind: "hold", issue: result.mismatch, receivedMinor: received };
  if (result.currency && result.currency.toUpperCase() !== region().currency.code)
    return { kind: "hold", issue: "currency", receivedMinor: received };
  const asked = toMinor(row.amount);
  if (result.billedMinor != null && result.billedMinor !== asked) return { kind: "hold", issue: "bill_amount", receivedMinor: received };
  if (received === null) return { kind: "match", receivedMinor: null };
  if (received < asked) return { kind: "hold", issue: "underpaid", receivedMinor: received };
  if (received > asked) return { kind: "over", receivedMinor: received, excessMinor: received - asked };
  return { kind: "match", receivedMinor: received };
}

/**
 * One staff activity-log row for what the system itself observed (the actor is MySenam). The log is loaded when it is
 * written, not before: lib/activity.ts reaches back into the payments code through the admin sign-in.
 */
export async function logSettlement(venueId: number | null, detail: string): Promise<void> {
  const { logAction } = await import("./activity");
  await logAction({ id: null, name: "MySenam" }, { venueId, action: "payment.settlement_check", detail });
}

/** How many payments to check a venue has told the owners about one by one in a day; further ones are one daily line (`alertPaymentToCheck`). */
export const PAYMENT_ALERT_EACH_MAX = 5;
const PAYMENT_CHECK_KEY = "payment:check:";

/**
 * A payment has just been put on the list *Payments to check* (`settlement_issue` set; called where that happens, once per payment): the
 * platform owners are told, once, through `raiseAlert` (their email through the outbox, the alert webhook, *System health*), under the key
 * `payment:check:<payment id>`. It names the venue and the payment's reference (the gateway's bill id), the issue and the amounts, and where the
 * list is; never a customer's name, phone or email. The list stays the record: this is a pointer to it.
 *
 * Idempotent: a payment that already has its alert, or is no longer waiting, writes nothing, so a repeated or parallel callback, and a
 * redirect after it, tell once. Marking the payment checked clears the alert (`reviewPayment`); a different payment later is news again.
 * After `PAYMENT_ALERT_EACH_MAX` standing alerts at a venue, further ones are told as one line a day for that venue
 * (`payment:check:many:<venue>:<day>`), not one each. Never throws: a payment already recorded must not fail for want of an alert.
 */
export async function alertPaymentToCheck(paymentId: number): Promise<void> {
  try {
    const db = getDb();
    const p = (await db
      .prepare(
        `SELECT p.id, p.bill_id, p.venue_id, p.settlement_issue AS issue, p.amount::float AS amount, GREATEST(p.refund_due - p.refunded, 0)::float AS owed, v.name AS venue
           FROM online_payments p JOIN venues v ON v.id = p.venue_id
          WHERE p.id = ? AND p.purpose NOT IN ('invoice', 'pack') AND p.settlement_issue IS NOT NULL AND p.settlement_reviewed_at IS NULL`
      )
      .get(paymentId)) as { id: number; bill_id: string; venue_id: number; issue: SettlementIssue; amount: number; owed: number; venue: string } | undefined;
    if (!p) return;
    const key = `${PAYMENT_CHECK_KEY}${p.id}`;
    if (await db.prepare("SELECT 1 AS yes FROM system_alerts WHERE key = ?").get(key)) return;
    const { raiseAlert } = await import("./alerts");
    const { englishOf, said } = await import("./staff-text");
    const standing = (await db
      .prepare("SELECT COUNT(*)::int AS n FROM system_alerts a JOIN online_payments q ON a.key = 'payment:check:' || q.id::text WHERE q.venue_id = ?")
      .get(p.venue_id)) as { n: number };
    if (standing.n >= PAYMENT_ALERT_EACH_MAX) {
      const manyKey = `${PAYMENT_CHECK_KEY}many:${p.venue_id}:${new Date().toISOString().slice(0, 10)}`;
      if (await db.prepare("SELECT 1 AS yes FROM system_alerts WHERE key = ?").get(manyKey)) return;
      const waiting = (await db
        .prepare("SELECT COUNT(*)::int AS n FROM online_payments WHERE venue_id = ? AND purpose NOT IN ('invoice', 'pack') AND settlement_issue IS NOT NULL AND settlement_reviewed_at IS NULL")
        .get(p.venue_id)) as { n: number };
      const detail = said("srv.vis.pay.many.d", { n: waiting.n, venue: p.venue, each: PAYMENT_ALERT_EACH_MAX });
      await raiseAlert(manyKey, said("srv.vis.pay.many.s", { venue: p.venue }), englishOf(detail), [detail]);
      return;
    }
    const detail = said("srv.vis.pay.d", {
      ref: p.bill_id,
      amount: money(p.amount),
      venue: p.venue,
      issue: said(`srv.vis.issue.${p.issue}`),
      owed: p.owed > 0 ? said("srv.vis.pay.owed", { amount: money(p.owed) }) : said("srv.vis.pay.nothingOwed"),
    });
    await raiseAlert(key, said("srv.vis.pay.s", { venue: p.venue }), englishOf(detail), [detail]);
  } catch (err) {
    console.error(`[mysenam] could not raise the alert for payment ${paymentId} to check:`, err instanceof Error ? err.message : "unknown error");
  }
}

/** A payment was checked: its alert goes, and with the last one waiting at the venue the day's line for it goes too. */
async function clearPaymentCheckAlert(paymentId: number, venueId: number): Promise<void> {
  const db = getDb();
  await db.prepare("DELETE FROM system_alerts WHERE key = ?").run(`${PAYMENT_CHECK_KEY}${paymentId}`);
  const left = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM online_payments WHERE venue_id = ? AND purpose NOT IN ('invoice', 'pack') AND settlement_issue IS NOT NULL AND settlement_reviewed_at IS NULL")
    .get(venueId)) as { n: number };
  if (left.n === 0) await db.prepare("DELETE FROM system_alerts WHERE key LIKE ?").run(`${PAYMENT_CHECK_KEY}many:${venueId}:%`);
}

interface PaidRow {
  id: number;
  venue_id: number | null;
  bill_id: string;
  amount: number | string;
  purpose?: string;
}

/**
 * Write down what the gateway reported on a payment that has been settled (or is being, by the caller), once. A match
 * records it. More than was asked records it too, takes the page's amount down to what was asked and owes the excess
 * back, in one statement under the guard that nothing was recorded yet, so a callback repeated, a redirect after it or
 * two at once record and owe it once. A report that disagrees with a payment already applied (short, or a bill that
 * is not ours) cannot undo what was applied: it is recorded and put on the list to check, money untouched.
 */
export async function recordReceived(row: PaidRow, a: Assessment, alreadyApplied: boolean): Promise<void> {
  if (a.receivedMinor === null && a.kind !== "hold") return;
  const db = getDb();
  if (a.kind === "match" && a.receivedMinor !== null) {
    await db
      .prepare("UPDATE online_payments SET received_amount = ? WHERE id = ? AND received_amount IS NULL AND status = 'paid'")
      .run(fromMinor(a.receivedMinor), row.id);
    return;
  }
  if (a.kind === "over") {
    const excess = fromMinor(a.excessMinor);
    // `amount` becomes what was received, as everything counted against it (owed back, refunded, kept) expects, and the
    // page's own figure is kept in `billed_amount`. The excess is owed back with whatever was owed already.
    const done = await db
      .prepare(
        `UPDATE online_payments
            SET received_amount = ?, billed_amount = amount, amount = ?, refund_due = refund_due + ?,
                settlement_issue = COALESCE(settlement_issue, 'overpaid'), settlement_issue_at = COALESCE(settlement_issue_at, datetime('now'))
          WHERE id = ? AND received_amount IS NULL AND status = 'paid'`
      )
      .run(fromMinor(a.receivedMinor), fromMinor(a.receivedMinor), excess, row.id);
    if (done.changes === 1) {
      await logSettlement(row.venue_id, `Payment ${row.id} (${row.bill_id}): ${money(Number(row.amount))} asked, ${money(fromMinor(a.receivedMinor))} received; ${money(excess)} is owed back`);
      await alertPaymentToCheck(row.id);
    }
    return;
  }
  if (a.kind === "hold" && alreadyApplied) {
    // Applied before the amounts were known (a report without them came first). Not undone: recorded, and put to staff.
    const issue: SettlementIssue = a.issue === "underpaid" ? "short_after_settled" : a.issue;
    const done = await db
      .prepare(
        `UPDATE online_payments
            SET received_amount = ?, settlement_issue = COALESCE(settlement_issue, ?), settlement_issue_at = COALESCE(settlement_issue_at, datetime('now'))
          WHERE id = ? AND received_amount IS NULL AND settlement_issue IS NULL AND status = 'paid'`
      )
      .run(a.receivedMinor === null ? null : fromMinor(a.receivedMinor), issue, row.id);
    if (done.changes === 1) {
      await logSettlement(
        row.venue_id,
        `Payment ${row.id} (${row.bill_id}) was applied, and the gateway then reported ${
          a.receivedMinor === null ? "figures that do not match" : `${money(fromMinor(a.receivedMinor))} received against ${money(Number(row.amount))}`
        } (${issue}); it needs a look`
      );
      await alertPaymentToCheck(row.id);
    }
  }
}

/** A payment's issue as a line of plain English for the activity log (staff screens say it in their own language). */
export const ISSUE_ENGLISH: Record<SettlementIssue, string> = {
  underpaid: "less than the page asked for",
  overpaid: "more than the page asked for",
  bill_amount: "the bill is not for what was asked",
  collection: "the bill is in another collection",
  currency: "in another currency",
  unverified: "the report lacks the amounts it should carry",
  hold_lapsed: "arrived after the booking's hold was let go",
  short_after_settled: "less than the page asked for, reported after it was applied",
};

// ------------------------------------------------------------ the list staff check

export interface PaymentToCheck {
  id: number;
  billId: string;
  venueId: number | null;
  purpose: OnlinePayment["purpose"];
  issue: SettlementIssue;
  /** What was received (what the payment now stands at), and what the page asked for where that differs. */
  amount: number;
  billedAmount: number | null;
  /** Still to be paid back (nothing, when it was applied or already refunded). */
  refundOwed: number;
  payerName: string | null;
  payerPhone: string | null;
  providerName: string;
  bookingCodes: string[];
  at: string;
  /**
   * How the payer can be reached about it: an email their account has proved is theirs (`verified`: told by email),
   * only the address typed on the booking (`unverified`: not written to about this; staff may ring), or none.
   */
  contact: "verified" | "unverified" | "none";
  payerTold: boolean;
}

interface CheckRow {
  id: number;
  bill_id: string;
  venue_id: number | null;
  purpose: OnlinePayment["purpose"];
  settlement_issue: SettlementIssue;
  amount: number;
  billed_amount: number | null;
  refund_due: number;
  refunded: number;
  payer_name: string | null;
  payer_phone: string | null;
  provider: string;
  at: string;
  told: string | null;
}

/** How a payment's payer can be reached about it, by its first booking: see `PaymentToCheck.contact`. */
export async function payerContact(paymentId: number): Promise<{ bookingId: number | null; email: string | null; contact: PaymentToCheck["contact"] }> {
  const b = (await getDb()
    .prepare(
      `SELECT b.id, b.email,
              CASE WHEN b.email IS NOT NULL AND b.email <> '' AND b.user_id IS NOT NULL AND EXISTS (
                     SELECT 1 FROM users u WHERE u.id = b.user_id AND u.email_confirmed_at IS NOT NULL AND lower(u.email) = lower(b.email)) THEN 1 ELSE 0 END AS verified
         FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id
        WHERE pb.payment_id = ? ORDER BY b.id LIMIT 1`
    )
    .get(paymentId)) as { id: number; email: string | null; verified: number } | undefined;
  if (!b) return { bookingId: null, email: null, contact: "none" };
  const email = b.email?.trim() || null;
  return { bookingId: b.id, email, contact: !email ? "none" : Number(b.verified) === 1 ? "verified" : "unverified" };
}

const CHECK_SELECT = `SELECT p.id, p.bill_id, p.venue_id, p.purpose, p.settlement_issue, p.amount::float AS amount, p.billed_amount::float AS billed_amount,
        p.refund_due::float AS refund_due, p.refunded::float AS refunded, p.payer_name, p.payer_phone, p.provider,
        COALESCE(p.settlement_issue_at, p.paid_at, p.created_at) AS at, p.settlement_payer_told_at AS told
   FROM online_payments p`;

async function toCheck(r: CheckRow, providerName: (id: string) => string): Promise<PaymentToCheck> {
  const codes = (await getDb()
    .prepare("SELECT b.code FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id WHERE pb.payment_id = ? ORDER BY b.date, b.start_min")
    .all(r.id)) as { code: string }[];
  return {
    id: r.id,
    billId: r.bill_id,
    venueId: r.venue_id,
    purpose: r.purpose,
    issue: r.settlement_issue,
    amount: Number(r.amount),
    billedAmount: r.billed_amount === null ? null : Number(r.billed_amount),
    refundOwed: Math.max(0, roundMoney(Number(r.refund_due) - Number(r.refunded))),
    payerName: r.payer_name,
    payerPhone: r.payer_phone,
    providerName: providerName(r.provider),
    bookingCodes: codes.map((c) => c.code),
    at: String(r.at),
    contact: (await payerContact(r.id)).contact,
    payerTold: r.told !== null,
  };
}

/**
 * A venue's payments with an issue nobody has looked at, oldest first: money received and not applied, an excess to
 * pay back, a payment that came after a hold was let go. The venue's own payments only (a venue's invoice to the
 * platform is the platform's). Each leaves the list when a manager or the desk marks it checked
 * (`reviewPayment`); the money owed on it is refunded the usual way, from *Refunds owed*.
 */
export async function paymentsToCheck(venueId: number, providerName: (id: string) => string): Promise<PaymentToCheck[]> {
  const rows = (await getDb()
    .prepare(`${CHECK_SELECT} WHERE p.venue_id = ? AND p.purpose NOT IN ('invoice', 'pack') AND p.settlement_issue IS NOT NULL AND p.settlement_reviewed_at IS NULL ORDER BY p.id`)
    .all(venueId)) as CheckRow[];
  return Promise.all(rows.map((r) => toCheck(r, providerName)));
}

/** Per venue, how many payments await a look, their amount owed back and the oldest day (for the needs-attention panel). */
export async function paymentChecksSummary(venueIds: number[] | null): Promise<{ venueId: number; venueName: string; count: number; owed: number; oldest: string }[]> {
  if (venueIds && venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT p.venue_id, v.name AS venue_name, COUNT(*)::int AS n, COALESCE(SUM(GREATEST(p.refund_due - p.refunded, 0)), 0)::float AS owed,
              MIN(COALESCE(p.settlement_issue_at, p.paid_at, p.created_at)) AS oldest
         FROM online_payments p JOIN venues v ON v.id = p.venue_id
        WHERE p.purpose NOT IN ('invoice', 'pack') AND p.settlement_issue IS NOT NULL AND p.settlement_reviewed_at IS NULL
          ${venueIds ? `AND p.venue_id IN (${venueIds.map(() => "?").join(",")})` : ""}
        GROUP BY p.venue_id, v.name ORDER BY MIN(p.id)`
    )
    .all(...(venueIds ?? []))) as { venue_id: number; venue_name: string; n: number; owed: number; oldest: string }[];
  return rows.map((r) => ({ venueId: r.venue_id, venueName: r.venue_name, count: Number(r.n), owed: roundMoney(Number(r.owed)), oldest: String(r.oldest).slice(0, 10) }));
}

/**
 * Staff have looked at a payment on the list: out of the list, with who and when and a note, and one activity-log row.
 * Looking does not move money: what is owed on it stays under *Refunds owed* until it is refunded. Only the venue's own
 * staff (the caller checks the venue), once: a second look finds nothing to check.
 */
export async function reviewPayment(
  paymentId: number,
  venueId: number,
  admin: { id: number; name: string },
  note: string | null
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const text = note?.trim().slice(0, 300) || null;
  const done = await getDb()
    .prepare(
      `UPDATE online_payments SET settlement_reviewed_at = datetime('now'), settlement_reviewed_by = ?, settlement_review_note = ?
        WHERE id = ? AND venue_id = ? AND purpose NOT IN ('invoice', 'pack') AND settlement_issue IS NOT NULL AND settlement_reviewed_at IS NULL`
    )
    .run(admin.id, text, paymentId, venueId);
  if (done.changes !== 1) return { ok: false, error: "That payment is not waiting to be checked.", status: 409 };
  const { logAction } = await import("./activity");
  await logAction(admin, { venueId, action: "payment.settlement_reviewed", detail: `Payment ${paymentId} checked${text ? `: ${text}` : ""}` });
  await clearPaymentCheckAlert(paymentId, venueId).catch((err) => console.error("[mysenam] could not clear the payment-to-check alert:", err instanceof Error ? err.message : "unknown error"));
  return { ok: true };
}
