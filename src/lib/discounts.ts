import { getDb } from "./db";
import { placeShares, refuse, soldByPlace, splitInProportion } from "./entitlements";
import { region, roundMoney } from "./region";
import type { PromoKind, Refusal } from "./types";

/**
 * Discounts together on one booking (ADR 0025, changes of 27 October 2026;
 * docs/features/pricing.md#discounts-together): which benefits are
 * discounts at all, whether two go together, and the one order and rounding
 * every path prices a booking by.
 *
 * What each benefit is:
 *
 * - **A price, not a discount**: the public rate, a member's rate (for the
 *   booking or for a member's own place), a last-minute price. A member's rate
 *   always goes with a discount: it is what the member's time costs.
 * - **A discount**: a concession (for the booking, or one person's place) and
 *   a promo code. These are what stacking is about.
 * - **A means of paying**, applied after the price is worked out and never
 *   changing it: stored credit, a gift voucher (it becomes credit), a pass
 *   (paid by entitlement), a payment online or at the counter.
 *
 * The rule: a concession and a promo code go together only where the venue
 * allows discounts together (`venues.discount_stacking = 'promotion'`) and the
 * code says it may (`promo_codes.combinable`); otherwise the second one asked
 * for is refused, the same way on every path (the booking form, the counter,
 * the API): `ONE_DISCOUNT` where the venue gives one discount at a time,
 * `STK_NOT_COMBINABLE` where the code does not combine. A last-minute price
 * takes no concession and no code, as before. Two concessions never cover one
 * place: a booking's own covers every place on it.
 *
 * The order, in whole sen: each place's share of the court time at the public
 * price (`placeShares`, split evenly, the earlier places taking the odd sen);
 * its member price; its concession (a share of what the place costs then,
 * rounded half up); then the code, worked out on the court time after all of
 * those (a percentage rounded down, a fixed amount never more than the court
 * time) and shared between the places in proportion to what each costs by
 * then, by largest remainder; then tax, which is inside the price; then the
 * means of paying. Fees, a coach's fee and extras are never discounted. A
 * price never goes below nothing.
 */

export const DISCOUNT_STACKING = ["never", "promotion"] as const;
export type DiscountStacking = (typeof DISCOUNT_STACKING)[number];

export function isDiscountStacking(v: unknown): v is DiscountStacking {
  return typeof v === "string" && (DISCOUNT_STACKING as readonly string[]).includes(v);
}

/** The venue's rule: `never` (one discount at a time, the default) or `promotion` (where the code allows). */
export async function discountStacking(venueId: number): Promise<DiscountStacking> {
  const row = (await getDb().prepare("SELECT discount_stacking FROM venues WHERE id = ?").get(venueId)) as { discount_stacking: string } | undefined;
  return isDiscountStacking(row?.discount_stacking) ? row.discount_stacking : "never";
}

export async function setDiscountStacking(venueId: number, value: unknown): Promise<{ ok: true; stacking: DiscountStacking } | { ok: false; error: string }> {
  if (!isDiscountStacking(value)) return { ok: false, error: "Say never, or promotion (where the code allows it)." };
  const done = await getDb().prepare("UPDATE venues SET discount_stacking = ? WHERE id = ?").run(value, venueId);
  if (done.changes !== 1) return { ok: false, error: "Venue not found." };
  return { ok: true, stacking: value };
}

/**
 * What a code takes off a price: a percentage rounded down to the sen or
 * cent (in the venue's favour), or a fixed amount; never more than the price.
 */
export function promoDiscount(p: { kind: PromoKind; value: number }, price: number): number {
  const scale = 10 ** region().currency.minorUnits;
  const base = Math.max(0, roundMoney(price));
  // The small allowance is for floating point (10.05 × 20% is 2.0100000000000002), not for rounding.
  const off = p.kind === "percent" ? Math.floor((base * p.value * scale) / 100 + 1e-6) / scale : p.value;
  return roundMoney(Math.max(0, Math.min(off, base)));
}

/** The discounts standing on a booking, as the rule reads them. */
interface Standing {
  venueId: number;
  lastMinute: boolean;
  /** The booking's own concession, still counted (not refused at the counter). */
  bookingConcession: boolean;
  /** A concession on one person's place, still standing. */
  placeConcession: boolean;
  promo: { combinable: boolean } | null;
  /** A manager adjusted its price (lib/price-adjustments.ts). */
  adjusted: boolean;
}

async function standing(bookingId: number): Promise<Standing | null> {
  const db = getDb();
  const b = (await db
    .prepare(
      `SELECT c.venue_id, b.last_minute, b.concession_id, b.concession_check,
              EXISTS (SELECT 1 FROM place_benefits pb WHERE pb.booking_id = b.id AND pb.kind = 'concession' AND pb.reversed_at IS NULL) AS place_concession,
              (SELECT p.combinable FROM promo_uses u JOIN promo_codes p ON p.id = u.promo_id WHERE u.booking_id = b.id) AS promo_combinable,
              EXISTS (SELECT 1 FROM promo_uses u WHERE u.booking_id = b.id) AS has_promo,
              EXISTS (SELECT 1 FROM booking_price_adjustments a WHERE a.booking_id = b.id) AS adjusted
         FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?`
    )
    .get(bookingId)) as
    | {
        venue_id: number;
        last_minute: number | null;
        concession_id: number | null;
        concession_check: string | null;
        place_concession: boolean;
        promo_combinable: boolean | null;
        has_promo: boolean;
        adjusted: boolean;
      }
    | undefined;
  if (!b) return null;
  return {
    venueId: b.venue_id,
    lastMinute: Number(b.last_minute) === 1,
    bookingConcession: b.concession_id !== null && b.concession_check !== "refused",
    placeConcession: !!b.place_concession,
    promo: b.has_promo ? { combinable: !!b.promo_combinable } : null,
    adjusted: !!b.adjusted,
  };
}

/** A concession and a code together: allowed only where the venue and the code both allow it. */
async function together(venueId: number, combinable: boolean): Promise<Refusal | null> {
  const policy = await discountStacking(venueId);
  if (policy === "never") return refuse("ONE_DISCOUNT");
  return combinable ? null : refuse("STK_NOT_COMBINABLE");
}

/**
 * Why `adding` cannot go on this booking with the discounts it has, or null
 * where it can: the one rule every path asks (lib/concessions.ts,
 * lib/store.ts `applyPromo`), read in the transaction that adds it, under the
 * booking's row lock.
 */
export async function stackRefusal(
  bookingId: number,
  adding: { kind: "concession" } | { kind: "placeConcession" } | { kind: "promo"; combinable: boolean }
): Promise<Refusal | null> {
  const s = await standing(bookingId);
  if (!s) return refuse("BOOKING_NOT_FOUND");
  // A manager set its price (lib/price-adjustments.ts): that is the last word, after every discount on it.
  if (s.adjusted) return refuse("P8B_PRICE_ADJUSTED");
  if (adding.kind === "promo") {
    // A last-minute price is already one.
    if (s.lastMinute) return refuse("PROMO_NOT_LAST_MINUTE");
    if (s.bookingConcession || s.placeConcession) return together(s.venueId, adding.combinable);
    return null;
  }
  if (s.lastMinute) return refuse("ONE_DISCOUNT");
  // One concession for a place: the booking's own covers every place on it.
  if (s.bookingConcession || (adding.kind === "concession" && s.placeConcession)) return refuse("ONE_DISCOUNT");
  if (s.promo) return together(s.venueId, s.promo.combinable);
  return null;
}

/**
 * The court time a code is worked out on: as charged, after member prices
 * and concessions, before the code (fees, a coach's fee and extras are never
 * discounted). Summed from the places, so it is the same figure the code's
 * shares are drawn from.
 */
export async function courtBeforePromo(bookingId: number): Promise<number> {
  const { lines } = await placeShares(bookingId);
  return roundMoney(lines.reduce((s, l) => s + l.gross - l.member - l.concession, 0));
}

/**
 * Work a booking's code out (again) on what the booking costs now: a code
 * just claimed, or a concession added or refused since. Inside the caller's
 * transaction, under the booking's row lock. The use's discount and the
 * booking's price change together; on a booking priced by the place each
 * named place's share is recorded (`promo_place_shares`) and any earlier
 * share marked given back. Null where the booking has no code.
 */
export async function allocatePromo(bookingId: number): Promise<{ discount: number; was: number } | null> {
  const db = getDb();
  const use = (await db
    .prepare(
      `SELECT u.discount::float AS discount, p.kind, p.value, c.per_player, c.capacity, c.flat_rate
         FROM promo_uses u JOIN promo_codes p ON p.id = u.promo_id JOIN bookings b ON b.id = u.booking_id JOIN courts c ON c.id = b.court_id
        WHERE u.booking_id = ?`
    )
    .get(bookingId)) as
    | { discount: number; kind: PromoKind; value: number; per_player: number | null; capacity: number; flat_rate: boolean | number | null }
    | undefined;
  if (!use) return null;
  const { lines } = await placeShares(bookingId);
  const before = roundMoney(lines.reduce((s, l) => s + l.gross - l.member - l.concession, 0));
  const was = roundMoney(Number(use.discount));
  const discount = promoDiscount({ kind: use.kind, value: Number(use.value) }, before);
  const byPlace = soldByPlace({ perPlayer: Number(use.per_player) === 1, capacity: Number(use.capacity), flatRate: use.flat_rate === true || use.flat_rate === 1 });
  await db.prepare("UPDATE promo_place_shares SET reversed_at = now(), reversed_why = 'repriced' WHERE booking_id = ? AND reversed_at IS NULL").run(bookingId);
  if (byPlace && lines.some((l) => l.placeId !== null && l.placeId !== -1)) {
    const shares = splitInProportion(
      discount,
      lines.map((l) => l.gross - l.member - l.concession)
    );
    for (const [i, l] of lines.entries())
      if (l.placeId !== null && l.placeId !== -1)
        await db.prepare("INSERT INTO promo_place_shares (booking_id, place_id, amount) VALUES (?, ?, ?)").run(bookingId, l.placeId, shares[i]);
  }
  await db.prepare("UPDATE promo_uses SET discount = ? WHERE booking_id = ?").run(discount, bookingId);
  if (discount !== was) await db.prepare("UPDATE bookings SET total_price = GREATEST(0, total_price - ?) WHERE id = ?").run(roundMoney(discount - was), bookingId);
  return { discount, was };
}

/** A booking's code given back (a cancellation): its places' shares go with it. */
export async function releasePromoShares(bookingId: number): Promise<void> {
  await getDb()
    .prepare("UPDATE promo_place_shares SET reversed_at = now(), reversed_why = 'released' WHERE booking_id = ? AND reversed_at IS NULL")
    .run(bookingId);
}
