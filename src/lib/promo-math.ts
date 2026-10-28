import { region, roundMoney } from "./region";
import type { PromoKind } from "./types";

/**
 * What a code takes off a price: a percentage rounded down to the sen or
 * cent (in the venue's favour), or a fixed amount; never more than the price.
 *
 * The one calculation (lib/discounts.ts uses it, and re-exports it): kept
 * apart from the database so the booking form can show a code's discount
 * before booking by the same arithmetic the booking will use.
 */
export function promoDiscount(p: { kind: PromoKind; value: number }, price: number): number {
  const scale = 10 ** region().currency.minorUnits;
  const base = Math.max(0, roundMoney(price));
  // The small allowance is for floating point (10.05 × 20% is 2.0100000000000002), not for rounding.
  const off = p.kind === "percent" ? Math.floor((base * p.value * scale) / 100 + 1e-6) / scale : p.value;
  return roundMoney(Math.max(0, Math.min(off, base)));
}
