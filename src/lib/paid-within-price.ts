import { getDb } from "./db";
import { creditReceipt } from "./documents";
import { refuse } from "./entitlements";
import { roundMoney } from "./region";
import type { Refusal } from "./types";

/**
 * The one rule for every path that lowers an unpaid booking's price (a move to
 * a cheaper time or court, a promo code, a concession): what has been paid on
 * it already (a deposit, friends' shares) never exceeds what it now costs, and
 * where it would, nothing is silently kept (ADR 0054).
 *
 * Called inside the transaction that wrote the new `total_price`, under the
 * booking's row lock. Where a deposit paid online is the part above the new
 * price, that part comes off the booking and is owed back on the deposit's
 * payment (`refund_due`, with a credit note on its receipt, as for a place
 * taken off the booking or a price that came down while a page was open); the
 * refund then goes by the venue's own path (lib/payments.ts). Where friends'
 * shares are above it, or the deposit cannot be told apart, the change is
 * refused (`PAID_ABOVE_PRICE`) and the caller rolls it back, as a manager's
 * price adjustment is (`P8B_ADJUST_BELOW_PAID`). A booking paid in full keeps
 * the price it was paid at (a separate, deliberate rule) and is left alone.
 */
export async function keepPaidWithinPrice(bookingId: number): Promise<{ ok: true; owedBack: number } | Refusal> {
  const db = getDb();
  const b = (await db
    .prepare("SELECT code, payment_status, total_price::float AS total_price, shares_paid::float AS shares_paid, deposit_paid::float AS deposit_paid FROM bookings WHERE id = ? FOR UPDATE")
    .get(bookingId)) as { code: string; payment_status: string; total_price: number; shares_paid: number; deposit_paid: number } | undefined;
  if (!b) return refuse("BOOKING_NOT_FOUND");
  if (b.payment_status === "paid") return { ok: true, owedBack: 0 };
  const excess = roundMoney(Number(b.shares_paid) - Number(b.total_price));
  if (excess <= 0.005) return { ok: true, owedBack: 0 };
  const deposit = Number(b.deposit_paid);
  // Friends' shares are above the new price: those are other people's, to be squared with them (the venue's to do).
  if (excess > deposit + 0.005) return refuse("PAID_ABOVE_PRICE");
  // The deposit's payment, and what of it is still on this booking (a place taken off settled some of it already).
  const dep = (await db
    .prepare(
      `SELECT p.id, pb.amount::float AS amount FROM online_payments p JOIN online_payment_bookings pb ON pb.payment_id = p.id
        WHERE pb.booking_id = ? AND p.deposit = 1 AND p.status = 'paid' AND pb.amount IS NOT NULL ORDER BY p.id DESC LIMIT 1`
    )
    .get(bookingId)) as { id: number; amount: number } | undefined;
  if (!dep) return refuse("PAID_ABOVE_PRICE");
  const gone = (await db.prepare("SELECT COALESCE(SUM(deposit_part), 0)::float AS gone FROM place_withdrawals WHERE booking_id = ?").get(bookingId)) as { gone: number };
  if (roundMoney(Number(dep.amount) - Number(gone.gone)) + 0.005 < excess) return refuse("PAID_ABOVE_PRICE");
  const after = roundMoney(deposit - excess);
  await db
    .prepare("UPDATE bookings SET deposit_paid = GREATEST(0, deposit_paid - ?), shares_paid = GREATEST(0, shares_paid - ?) WHERE id = ?")
    .run(excess, excess, bookingId);
  await db.prepare("UPDATE online_payment_bookings SET amount = amount - ? WHERE payment_id = ? AND booking_id = ?").run(excess, dep.id, bookingId);
  await db.prepare("UPDATE online_payments SET refund_due = LEAST(amount, refund_due + ?) WHERE id = ? AND status = 'paid'").run(excess, dep.id);
  // Keyed by what is left of the deposit, so each reduction has its own credit note, once however often this runs.
  await creditReceipt(`payment:${dep.id}`, "receipt.why.priceLowered", 1, { key: `${b.code}:lowered:${Math.round(after * 100)}`, amount: excess, text: b.code });
  return { ok: true, owedBack: excess };
}
