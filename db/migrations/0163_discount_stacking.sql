-- Whether a concession price and a promo code go together on one booking
-- (lib/discounts.ts; ADR 0025, changes of 27 October 2026;
-- docs/features/pricing.md#discounts-together).
--
-- Only real discounts are subject to it: a person's concession (for the
-- booking or for one person's place) and a promo code. A member's rate is a
-- price, not a discount; stored credit, a gift voucher (which becomes credit)
-- and a pass are means of paying, applied after the price is worked out. A
-- last-minute price combines with nothing, as before.
--
-- The conservative default: they do not combine, unless the venue allows it
-- (`venues.discount_stacking = 'promotion'`) AND the code itself says it may
-- (`promo_codes.combinable`). Every venue and every code made before keeps
-- the rule it had: one discount at a time.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS discount_stacking TEXT NOT NULL DEFAULT 'never';
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_discount_stacking_check;
ALTER TABLE venues ADD CONSTRAINT venues_discount_stacking_check CHECK (discount_stacking IN ('never', 'promotion'));

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS combinable BOOLEAN NOT NULL DEFAULT false;
