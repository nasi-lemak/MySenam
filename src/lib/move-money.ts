import { getDb } from "./db";
import { creditBookingMove } from "./documents";
import { refuse } from "./entitlements";
import { roundMoney } from "./region";
import { said, withPhrase } from "./staff-text";
import { COUNTER_METHODS, type CounterMethod, type Refusal } from "./types";

/**
 * The money of moving a booking to another time (ADR 0067; docs/features/booking.md#changing-the-date-or-time).
 *
 * A move changes what the court time costs. Unpaid, the booking's price follows it (lib/store.ts `rescheduleBooking`). Paid, the
 * customer must not silently lose the difference when the new time is cheaper (DEC-16): it is given back the way it was paid, in the
 * move's own transaction and under the booking's row lock:
 *
 * - paid online: owed back on the payment (`refund_due`), with a credit note; the venue's refund path then sends it through the
 *   gateway where it can (Stripe) and otherwise lists it under *Refunds owed* for staff (Billplz), never said to be paid;
 * - paid at the counter (cash, QR, transfer, card): written on the list of counter money owed back (`counter_refunds_owed`), settled
 *   by staff when the customer comes (handed back the way it was paid, or as credit on request), the credit note written then;
 * - paid from stored credit: back to the credit it was taken from, with a credit note;
 * - paid with a pass: no money is involved, the pass covers the same length of time; nothing changes;
 * - charged to a company or school account whose invoice was issued: a credit note on the account (lib/accounts.ts), as before.
 *
 * Cash is never turned into venue credit without the customer's say (staff settle a counter debt as credit only when asked). The
 * booking's price and its receipt stay as sold; what went back is a row of `booking_move_refunds`, which `paidPartLeft` takes off what
 * a later cancellation gives back. Where the difference cannot be given back cleanly (friends' shares paid, a payment that cannot be
 * found, a price below what a deposit took), the move is refused with the reason rather than leave a booking in a state nobody can settle.
 */

/** The way a difference goes back: the way the booking was paid. */
export type MoveHow = "online" | "counter" | "credit";

/** What the move does to the money, as quoted before it is made and as it was made (a preview changes nothing). */
export interface MoveMoney {
  /** What the booking costs as it stands (paid: what was paid for it), what it costs at the new time, and the difference (below nought: cheaper). */
  oldPrice: number;
  newPrice: number;
  difference: number;
  /**
   * `price`: unpaid, the price changes by the difference. `refund`: paid and cheaper, the difference goes back (see `refund`).
   * `kept`: paid, the price stays as paid (a dearer time customers cannot take, a cheaper one the venue keeps, a lesson's agreed
   * price). `account`: credited to the company account. `pass`: paid with a pass, no money moves. `none`: no difference.
   */
  settles: "none" | "price" | "refund" | "kept" | "account" | "pass";
  /** `refund`: how much goes back and the way it goes. After the move, `sent` says what the venue's refund path did with an online one. */
  refund?: { amount: number; how: MoveHow; sent?: { how: "gateway" | "staff" | "credit"; pending?: boolean; dueBy?: string } };
  /** `account`: how much was credited to the company account. */
  account?: number;
  /** A last-minute price the booking had at its first time goes with that time (lib/pricing.ts). */
  lastMinuteLost?: boolean;
  /** Paid and cheaper: the difference could go back, and the move is the venue's (staff may choose to keep it instead). */
  canKeep?: boolean;
}

/** How a staff change of time settles a paid, cheaper move: the difference back (the default before the cutoff), or kept by the venue. */
export type DifferenceChoice = "refund" | "keep";

/**
 * What a booking costs at its new time, discounts as given (a move keeps what was charged: a concession and a code stay at the amounts
 * they took off, pricing.md "A move keeps what was charged"), and never makes the time free: where the amounts kept would take the
 * price to nothing, it is the share of the new court time the booking was paying (`total / oldQuote`) instead (D3).
 */
export function movedTotal(total: number, oldQuote: number, newQuote: number, delta: number): number {
  const kept = roundMoney(total + delta);
  if (kept > 0.005 || total <= 0.005 || oldQuote <= 0.005 || newQuote <= 0.005) return Math.max(0, kept);
  return roundMoney((total * newQuote) / oldQuote);
}

export type DifferencePlan =
  | { kind: "none" }
  | { kind: "pass" }
  | { kind: "kept" }
  | { kind: "refund"; amount: number; how: MoveHow; paidBefore: number; priceAfter: number };

export interface DifferenceInput {
  bookingId: number;
  paidVia: string | null;
  totalPrice: number;
  sharesPaid: number;
  depositPaid: number;
  /** The court time at the old and the new time, and the difference with any coach's fee (as `rescheduleBooking` works them out). */
  oldQuote: number;
  newQuote: number;
  delta: number;
  /** `keep`: the venue keeps the difference (a staff choice, or the move is past the customer's cutoff). */
  choice: DifferenceChoice;
}

/**
 * What giving the difference back of a paid booking moved to a cheaper time comes to, or why it cannot be: read under the booking's
 * lock, so what it counts is what is there when the move is made. Not asked for a booking that is not paid or not cheaper.
 */
export async function planDifference(i: DifferenceInput): Promise<DifferencePlan | Refusal> {
  if (!(i.delta < -0.005)) return { kind: "none" };
  if (i.paidVia === "pass") return { kind: "pass" };
  if (i.choice === "keep") return { kind: "kept" };
  const { paidPartLeft } = await import("./store");
  const total = roundMoney(i.totalPrice);
  const shares = roundMoney(i.sharesPaid);
  // Others' money is in it: a friend's share, or a player's in an open game. It stays where it is; the difference is the booker's own, but
  // which payer it belongs to is for the venue to square, so a move that would owe any back is refused (a deposit is the booker's own).
  if (shares - roundMoney(i.depositPaid) > 0.005) return refuse("MOVE_DIFFERENCE_SHARED");
  // What the booker paid for the booking itself and is still on it: its price less what others and a deposit paid, less what has gone back.
  const own = roundMoney(Math.max(0, total - shares) * (await paidPartLeft(i.bookingId)));
  // What the booking costs as it stands is that and what others paid (the price as sold stays on the booking, and what went back for an
  // earlier move is no longer part of it), and at the new time the discounts it was given stay as amounts, never making it free (D3).
  const priceAfter = movedTotal(roundMoney(own + shares), i.oldQuote, i.newQuote, i.delta);
  // A deposit taken online stays what it was: a price below it is the deposit's own matter (lib/paid-within-price.ts), not this one's.
  if (priceAfter < shares - 0.005) return refuse("MOVE_DIFFERENCE_BELOW_PAID");
  const amount = roundMoney(Math.min(own, own - (priceAfter - shares)));
  if (amount <= 0.005) return { kind: "none" };
  const how: MoveHow = i.paidVia === "credit" ? "credit" : i.paidVia === "online" ? "online" : "counter";
  return { kind: "refund", amount, how, paidBefore: own, priceAfter };
}

/** Who moved it, for the record. */
export interface MovedBy {
  by: "customer" | "staff";
  admin: { adminId: number | null; name: string } | null;
}

/**
 * Give the difference back, inside the move's transaction and under the booking's row lock: the row that records it, then the route
 * the booking was paid by. Returns the row's id. Throws a refusal (undoing the move) where the money cannot be tracked.
 */
export class MoveRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super("MOVE_REFUSED");
  }
}

export async function returnDifference(
  booking: { id: number; code: string; venueId: number; paidVia: string | null; userId: number | null },
  plan: Extract<DifferencePlan, { kind: "refund" }>,
  moved: MovedBy,
  from: { date: string; startMin: number; courtId: number },
  to: { date: string; startMin: number; courtId: number }
): Promise<number> {
  const db = getDb();
  let paymentId: number | null = null;
  if (plan.how === "online") {
    // The payment that took the booking's money (not a deposit, whose excess has its own path): the latest paid one that holds room for it.
    const pays = (await db
      .prepare(
        `SELECT p.id, p.amount::float AS amount, p.refund_due::float AS due FROM online_payment_bookings pb
           JOIN online_payments p ON p.id = pb.payment_id
          WHERE pb.booking_id = ? AND p.status = 'paid' AND p.deposit = 0 AND p.purpose = 'booking' ORDER BY p.id DESC`
      )
      .all(booking.id)) as { id: number; amount: number; due: number }[];
    const pay = pays.find((p) => roundMoney(p.amount - p.due) + 0.005 >= plan.amount);
    if (!pay) throw new MoveRefused(refuse("MOVE_DIFFERENCE_UNTRACED"));
    paymentId = pay.id;
  }
  const row = (await db
    .prepare(
      `INSERT INTO booking_move_refunds (venue_id, booking_id, moved_by, admin_id, admin_name, from_date, from_start_min, from_court_id,
         to_date, to_start_min, to_court_id, paid_before, price_after, amount, how, payment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      booking.venueId, booking.id, moved.by, moved.admin?.adminId ?? null, moved.admin?.name ?? null,
      from.date, from.startMin, from.courtId, to.date, to.startMin, to.courtId,
      plan.paidBefore, plan.priceAfter, plan.amount, plan.how, paymentId
    )) as { id: number };

  if (plan.how === "online") {
    // Owed back on the payment, never more than it took; sent through the venue's refund path once this commits (lib/payments.ts).
    const done = await db
      .prepare("UPDATE online_payments SET refund_due = LEAST(amount, refund_due + ?) WHERE id = ? AND status = 'paid' AND amount - refund_due >= ? - 0.005")
      .run(plan.amount, paymentId, plan.amount);
    if (done.changes !== 1) throw new MoveRefused(refuse("MOVE_DIFFERENCE_UNTRACED"));
    await creditBookingMove(booking.id, row.id, plan.amount);
  } else if (plan.how === "credit") {
    // Back to the pots it came from, in proportion, marked as this move's (not the booking's own refund on cancelling).
    const charges = (await db
      .prepare("SELECT user_id, amount::float AS amount, venue_id FROM wallet_entries WHERE booking_id = ? AND amount < 0 ORDER BY id")
      .all(booking.id)) as { user_id: number; amount: number; venue_id: number | null }[];
    const charged = charges.reduce((s, c) => s - Number(c.amount), 0);
    if (charges.length === 0 || charged + 0.005 < plan.amount) throw new MoveRefused(refuse("MOVE_DIFFERENCE_UNTRACED"));
    const why = withPhrase(said("srv.wallet.refund", { code: booking.code }));
    let rest = plan.amount;
    for (const [i, c] of charges.entries()) {
      const back = i === charges.length - 1 ? roundMoney(rest) : roundMoney((-Number(c.amount) / charged) * plan.amount);
      rest = roundMoney(rest - back);
      if (back > 0)
        await db
          .prepare("INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, booking_id, venue_id, move_refund_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(c.user_id, back, ...why, booking.id, c.venue_id, row.id);
    }
    await creditBookingMove(booking.id, row.id, plan.amount);
  } else {
    // At the counter: owed back, on the list staff settle from; nothing has left the till, so the credit note is written then.
    const via = (COUNTER_METHODS as readonly string[]).includes(booking.paidVia ?? "") ? (booking.paidVia as CounterMethod) : null;
    await db
      .prepare("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause, move_refund_id) VALUES (?, ?, ?, ?, 'moved_cheaper', ?)")
      .run(booking.venueId, booking.id, plan.amount, via, row.id);
  }
  return row.id;
}
