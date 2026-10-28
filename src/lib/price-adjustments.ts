import { creditBookingAdjustment, documentRef } from "./documents";
import { getDb, withTransaction } from "./db";
import { REASON_MAX, REASON_MIN } from "./policy-overrides";
import { receiptPath } from "./receipts";
import { isAmount, roundMoney } from "./region";
import { COUNTER_METHODS, type CounterMethod } from "./types";

/**
 * A manager's adjustment of one booking's price (X1-17;
 * docs/features/pricing.md#a-managers-price-adjustment): a goodwill
 * discount, a free hour for a coach or a sponsor, a price matched to a quote
 * given on the phone. Recorded as ADR 0026 records a policy override: which
 * booking, the price before and after, complimentary or not, the reason
 * (required) and the manager, written in the same transaction as the change
 * (`booking_price_adjustments`, migration 0236) and in the activity log
 * (`booking.price_adjusted`). Front desk never adjusts a price.
 *
 * Through the one price and receipt path:
 *
 * - **Before it is paid** the booking's price becomes the new amount and its
 *   receipt (drawn from the booking, lib/documents.ts `bookingSale`) shows
 *   the difference as a line of its own, after every discount. Whatever is
 *   then paid, by any way, is the adjusted price.
 * - **After it was paid at the counter** (cash, QR, transfer or card) the
 *   receipt stays as sold: only a lower price, and the difference is a credit
 *   note of its own, given back the way it was paid (the cash-up counts it),
 *   and left out of what a later cancellation gives back
 *   (lib/store.ts `paidPartLeft`). Paid online, with credit or a pass, money
 *   goes back by the refund paths instead, and the adjustment is refused.
 *
 * With discounts already on it: the new amount is what the customer pays for
 * the booking as it stands, after member prices, concessions and any promo
 * code, which all stay on the receipt as they were worked out (a code stays
 * used). It is the last word: no code or concession is added to an adjusted
 * booking afterwards (lib/discounts.ts `stackRefusal`, `P8B_PRICE_ADJUSTED`),
 * so the manager's figure is never discounted again behind their back. What
 * changes the booking itself later (extras added, a concession whose proof
 * is not shown, moving to a dearer hour) moves the price by its own
 * difference, as it would have without the adjustment.
 *
 * Refused where others' money is in it (a split, an open game, a payment page
 * still open, an account invoice already issued), for a cancelled booking,
 * and below what deposits and shares already paid.
 */

export interface Adjuster {
  id: number;
  name: string;
  role: "manager" | "desk";
}

export interface PriceAdjustment {
  id: number;
  bookingId: number;
  before: number;
  after: number;
  delta: number;
  complimentary: boolean;
  /** Made after it was paid: a credit note for the difference. */
  paid: boolean;
  reason: string;
  adminName: string;
  createdAt: string;
}

export type AdjustResult =
  | {
      ok: true;
      adjustment: PriceAdjustment;
      booking: { code: string; venueId: number; totalPrice: number; paymentStatus: string };
      creditNote: { number: string; path: string } | null;
    }
  | { ok: false; error: string; code: string; status: number };

const refused = (status: number, code: string, error: string): AdjustResult => ({ ok: false, status, code, error });

class Refused extends Error {
  constructor(readonly result: AdjustResult) {
    super(result.ok ? "" : result.error);
  }
}

export async function adjustBookingPrice(input: { code: string; amount?: unknown; complimentary?: unknown; reason: unknown; staff: Adjuster }): Promise<AdjustResult> {
  if (input.staff.role === "desk") return refused(403, "MANAGER_ONLY", "Front-desk accounts cannot change this. Ask a manager.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    return refused(400, "P8B_ADJUST_REASON", "Say why the price is being changed (5 to 300 characters): it is kept with the booking.");
  const complimentary = input.complimentary === true;
  if (!complimentary && !isAmount(input.amount, 0, 100000)) return refused(400, "P8B_PRICE_INVALID", "A price is 0 or more, to the sen or cent.");
  const target = complimentary ? 0 : roundMoney(input.amount as number);

  const db = getDb();
  try {
    return await withTransaction(async () => {
      // Under the booking's row lock: a payment, a discount or another adjustment at the same moment waits, or is seen.
      const b = (await db
        .prepare(
          `SELECT b.id, b.code, b.status, b.payment_status, b.paid_via, b.total_price::float AS total_price, b.shares_paid::float AS shares_paid,
                  b.account_invoice_id, c.venue_id
             FROM bookings b JOIN courts c ON c.id = b.court_id WHERE UPPER(b.code) = UPPER(?) FOR UPDATE OF b`
        )
        .get(input.code.trim())) as
        | {
            id: number;
            code: string;
            status: string;
            payment_status: string;
            paid_via: string | null;
            total_price: number;
            shares_paid: number;
            account_invoice_id: number | null;
            venue_id: number;
          }
        | undefined;
      if (!b) throw new Refused(refused(404, "BOOKING_NOT_FOUND", "Booking not found."));
      if (b.status === "cancelled") throw new Refused(refused(409, "P8B_ADJUST_CANCELLED", "This booking is cancelled."));
      // Others' money is in it: settle or call that off first.
      const others = (await db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM booking_splits WHERE booking_id = ?) AS split,
                  EXISTS (SELECT 1 FROM open_games WHERE booking_id = ? AND status <> 'cancelled') AS game,
                  EXISTS (SELECT 1 FROM online_payments p JOIN online_payment_bookings pb ON pb.payment_id = p.id
                           WHERE pb.booking_id = ? AND p.status = 'pending' AND p.created_at > datetime('now', '-24 hours')) AS page`
        )
        .get(b.id, b.id, b.id)) as { split: boolean; game: boolean; page: boolean };
      if (others.split || others.game)
        throw new Refused(refused(409, "P8B_ADJUST_SHARED", "Others are paying shares of this booking. Its price cannot be adjusted while they are."));
      if (others.page) throw new Refused(refused(409, "P8B_ADJUST_PAGE_OPEN", "A payment page for this booking is still open. Wait for it to close, or for the payment."));
      if (b.account_invoice_id !== null)
        throw new Refused(refused(409, "P8B_ADJUST_INVOICED", "This booking is on an account invoice already issued. Put it right on the account instead."));

      const total = roundMoney(b.total_price);
      if (b.payment_status !== "paid") {
        // Before payment: the price itself, never below what deposits and shares already paid.
        if (target === total) throw new Refused(refused(409, "P8B_ADJUST_SAME", "That is its price already."));
        if (target < roundMoney(b.shares_paid))
          throw new Refused(refused(409, "P8B_ADJUST_BELOW_PAID", "That is less than has been paid on it already (a deposit or shares)."));
        const row = await insert(b.venue_id, b.id, total, target, complimentary, false, reason, input.staff);
        await db.prepare("UPDATE bookings SET total_price = ? WHERE id = ?").run(target, b.id);
        return {
          ok: true as const,
          adjustment: row,
          booking: { code: b.code, venueId: b.venue_id, totalPrice: target, paymentStatus: b.payment_status },
          creditNote: null,
        };
      }

      // After payment at the counter: a credit note for the difference, the receipt as sold.
      if (!COUNTER_METHODS.includes(b.paid_via as CounterMethod))
        throw new Refused(
          refused(409, "P8B_ADJUST_NOT_COUNTER", "This booking was paid online, with credit or with a pass. Give money back through a refund instead.")
        );
      const { paidPartLeft } = await import("./store");
      const current = roundMoney((total - roundMoney(b.shares_paid)) * (await paidPartLeft(b.id)));
      if (target >= current)
        throw new Refused(refused(409, "P8B_ADJUST_ONLY_DOWN", "It is paid: its price can only come down now. Take anything more as a counter sale."));
      const row = await insert(b.venue_id, b.id, current, target, complimentary, true, reason, input.staff);
      const note = await creditBookingAdjustment(b.id, row.id, roundMoney(current - target), complimentary);
      return {
        ok: true as const,
        adjustment: row,
        booking: { code: b.code, venueId: b.venue_id, totalPrice: total, paymentStatus: b.payment_status },
        creditNote: note ? { number: note.number, path: receiptPath(documentRef(note.id)) } : null,
      };
    });
  } catch (err) {
    if (err instanceof Refused) return err.result;
    throw err;
  }
}

async function insert(
  venueId: number,
  bookingId: number,
  before: number,
  after: number,
  complimentary: boolean,
  paid: boolean,
  reason: string,
  staff: Adjuster
): Promise<PriceAdjustment> {
  const r = (await getDb()
    .prepare(
      `INSERT INTO booking_price_adjustments (venue_id, booking_id, before_price, after_price, delta, complimentary, paid, reason, admin_id, admin_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`
    )
    .get(venueId, bookingId, before, after, roundMoney(after - before), complimentary, paid, reason, staff.id, staff.name)) as { id: number; created_at: unknown };
  return {
    id: r.id,
    bookingId,
    before,
    after,
    delta: roundMoney(after - before),
    complimentary,
    paid,
    reason,
    adminName: staff.name,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** The adjustments on these bookings, oldest first, for the staff dashboard. */
export async function adjustmentsFor(bookingIds: number[]): Promise<Map<number, PriceAdjustment[]>> {
  const out = new Map<number, PriceAdjustment[]>();
  if (bookingIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT id, booking_id, before_price::float AS before, after_price::float AS after, delta::float AS delta, complimentary, paid, reason, admin_name, created_at
         FROM booking_price_adjustments WHERE booking_id IN (${bookingIds.map(() => "?").join(",")}) ORDER BY id`
    )
    .all(...bookingIds)) as {
    id: number;
    booking_id: number;
    before: number;
    after: number;
    delta: number;
    complimentary: boolean;
    paid: boolean;
    reason: string;
    admin_name: string;
    created_at: unknown;
  }[];
  for (const r of rows)
    out.set(r.booking_id, [
      ...(out.get(r.booking_id) ?? []),
      {
        id: r.id,
        bookingId: r.booking_id,
        before: Number(r.before),
        after: Number(r.after),
        delta: Number(r.delta),
        complimentary: !!r.complimentary,
        paid: !!r.paid,
        reason: r.reason,
        adminName: r.admin_name,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      },
    ]);
  return out;
}
