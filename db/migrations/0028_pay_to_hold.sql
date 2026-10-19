-- A venue can ask for payment online to hold a booking made online: until
-- it is paid it is held for hold_minutes, then let go for somebody else.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS pay_to_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS hold_minutes INTEGER NOT NULL DEFAULT 15
  CHECK (hold_minutes BETWEEN 5 AND 60);

-- Until when an unpaid booking is held; cleared once it is paid.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_until TEXT;
-- 1 for a booking let go because it was not paid in time.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS released_unpaid INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_bookings_hold ON bookings (hold_until)
  WHERE hold_until IS NOT NULL AND status = 'confirmed' AND payment_status = 'unpaid';
