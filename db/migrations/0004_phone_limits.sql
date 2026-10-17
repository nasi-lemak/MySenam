-- A phone number as the digits that identify it, however it was typed:
-- "012-345 6789", "+60 12 345 6789" and "0123456789" are one number.
CREATE OR REPLACE FUNCTION phone_key(phone text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN d LIKE '60%' THEN '0' || substr(d, 3) ELSE d END
  FROM (SELECT regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS d) AS digits
$$;

-- Kept on each booking, so "how many unpaid bookings does this number have
-- coming up" is an index lookup, not a pass over every upcoming booking. On a
-- big install this rewrites the bookings table once, as it is added.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phone_key TEXT GENERATED ALWAYS AS (phone_key(phone)) STORED;
CREATE INDEX IF NOT EXISTS idx_bookings_phone_unpaid ON bookings(phone_key, date)
  WHERE status = 'confirmed' AND payment_status = 'unpaid';

-- Numbers a venue will not take online bookings from: somebody who books and
-- never comes, or fills the evening with names that do not exist.
CREATE TABLE IF NOT EXISTS venue_blocked_phones (
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  phone_key TEXT NOT NULL,
  -- As staff typed it, to show back to them.
  phone TEXT NOT NULL,
  reason TEXT,
  blocked_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT datetime('now'),
  PRIMARY KEY (venue_id, phone_key)
);

-- Who a message is for, normalised: the same number however it was typed, the
-- same address whatever its case. The outbox counts a day's messages to one
-- recipient by it, so the site cannot be used to flood somebody's phone.
CREATE INDEX IF NOT EXISTS idx_messages_recipient_day ON messages (
  (CASE WHEN channel = 'email' THEN lower(recipient) ELSE phone_key(recipient) END), created_at
);
