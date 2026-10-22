-- What each booking was billed on a payment page, so a payment settles what
-- it was for even if the booking's price moved while the page was open, and
-- a refund is never more than was paid for it. NULL on pages made before.
ALTER TABLE online_payment_bookings ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2);

-- How many bookings one customer (by phone) may use a code on; NULL is no
-- limit, as every code was before. New codes are offered once each.
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_per_customer INTEGER;

-- The share of the price a venue kept when this booking was cancelled late
-- (its late_cancel_keep then), so a coach's cut of it can be worked out later.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_kept_percent INTEGER;
