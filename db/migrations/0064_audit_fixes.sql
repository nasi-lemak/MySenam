-- Fixes from the audit of the platform's rules (README, "Audit fixes").

-- A pay-to-hold booking's hold is stretched once, for a payment page opened
-- near its end; not again and again to keep the court without paying.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_extended INTEGER NOT NULL DEFAULT 0;

-- Lookups by booking or series code compare upper-cased: let them use an index.
CREATE INDEX IF NOT EXISTS bookings_code_upper ON bookings (UPPER(code));
CREATE INDEX IF NOT EXISTS bookings_series_upper ON bookings (UPPER(series_code)) WHERE series_code IS NOT NULL;

-- Booked at a last-minute price: a promo code does not come off it too.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_minute INTEGER NOT NULL DEFAULT 0;
