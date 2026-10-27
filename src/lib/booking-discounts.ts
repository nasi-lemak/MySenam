import { applyConcession, applyPlaceConcession } from "./concessions";
import { placeFor } from "./entitlements";
import { applyPromo, getBookingById } from "./store";
import type { Booking } from "./types";

/**
 * The discounts a booking just made asks for, put on in the one order
 * (lib/discounts.ts; docs/features/pricing.md#discounts-together): the
 * booking's own concession, then each person's own concession on their place,
 * then a promo code, worked out on what the court time costs by then. Every
 * path that makes a booking with discounts calls this, with what it was asked:
 * the booking form and the counter (app/api/bookings, the same route) and the
 * venue's API key (app/api/v1/bookings), so the same request gives the same
 * price, rounding, place shares, usage limits and refusals on each.
 *
 * Best-effort, as paying is: a discount refused leaves the booking standing at
 * the price before it, and says why (the first refusal of each kind). A
 * concession asked for is taken on the word of whoever booked (the customer
 * online, the venue at its counter or through its system): proof is looked at
 * when the person arrives (`concession_check`, lib/concessions.ts), as for any
 * concession. The bookings are updated in place to what they cost now.
 */

export interface AskedDiscounts {
  /** A concession for the whole booking (or the only place on it). */
  concessionId?: unknown;
  /** One person's own concession on their place (lib/entitlements.ts `readPlaceConcessions`); null is the customer's own. */
  placeConcessions?: { participantId: number | null; concessionId: number }[];
  /** A promo code, as typed. */
  promoCode?: unknown;
}

export interface DiscountOutcome {
  concessionError: { error: string; code?: string; vars?: Record<string, string | number> } | null;
  promoError: string | null;
  /** Its code, where it has one (ONE_DISCOUNT, STK_NOT_COMBINABLE…), for the caller to say it in its own words. */
  promoErrorCode: string | null;
  /** What the code took off, over all the bookings. */
  discount: number;
}

export async function applyAskedDiscounts(bookings: Booking[], asked: AskedDiscounts): Promise<DiscountOutcome> {
  // A concession price the customer said is theirs (lib/concessions.ts), shown
  // at the counter. Like a code, best-effort: refused, the booking stands at
  // the full price and says why. Concessions come before a code, whose discount is worked out on the
  // lower price where the venue and the code allow both (lib/discounts.ts).
  let concessionError: DiscountOutcome["concessionError"] = null;
  if (Number.isInteger(asked.concessionId)) {
    for (const booking of bookings) {
      const applied = await applyConcession(booking.id, asked.concessionId as number);
      if (!applied.ok) {
        if (!concessionError) concessionError = { error: applied.error, code: applied.code, vars: applied.vars };
        continue;
      }
      // As stored now: the lower price, and which concession, for the confirmation.
      Object.assign(booking, (await getBookingById(booking.id)) ?? {});
    }
  }
  // Each person's own concession, on their own place (a child's price for one child of three).
  // On several courts, on the court that person is on.
  for (const one of asked.placeConcessions ?? []) {
    let applied = false;
    for (const booking of bookings) {
      if (!(await placeFor(booking.id, one.participantId))) continue;
      const done = await applyPlaceConcession(booking.id, one.concessionId, one.participantId);
      if (!done.ok) {
        if (!concessionError) concessionError = { error: done.error, code: done.code, vars: done.vars };
        applied = true;
        continue;
      }
      applied = true;
      Object.assign(booking, (await getBookingById(booking.id)) ?? {});
    }
    if (!applied && !concessionError) concessionError = { error: "That person is not taking part in this booking.", code: "ENT_NOT_ON_BOOKING" };
  }

  // A code is claimed before anything is settled, so paying from credit or a
  // pass charges the discounted figure. Like paying, it is best-effort: a code
  // that has run out leaves the booking standing at full price with the reason.
  let promoError: string | null = null;
  let promoErrorCode: string | null = null;
  let discount = 0;
  if (typeof asked.promoCode === "string" && asked.promoCode.trim() !== "") {
    for (const booking of bookings) {
      const applied = await applyPromo(booking.id, asked.promoCode);
      if (!applied.ok) {
        if (!promoError) {
          promoError = applied.error;
          promoErrorCode = applied.code ?? null;
        }
      } else {
        booking.totalPrice = applied.newTotal;
        discount += applied.discount;
      }
    }
  }
  return { concessionError, promoError, promoErrorCode, discount };
}
