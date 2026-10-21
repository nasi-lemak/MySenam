-- A venue forgiving a number its strikes: only no-shows and late cancellations
-- on bookings dated after this count again.
CREATE TABLE IF NOT EXISTS strike_forgiveness (
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  phone_key TEXT NOT NULL,
  forgiven_on TEXT NOT NULL,
  admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  PRIMARY KEY (venue_id, phone_key)
);

-- The language a gift voucher was bought in, for the email that sends it.
ALTER TABLE gift_vouchers ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en';
