-- How a shared facility's bookings are priced, and sign-offs that name who
-- they are for and who gave them (docs/features/activities.md).

-- ------------------------------------------------------------ pricing

-- A resource with places is priced per place unless the venue says the rate
-- is for the whole booking (a party room, a group package).
ALTER TABLE courts ADD COLUMN IF NOT EXISTS flat_rate BOOLEAN NOT NULL DEFAULT false;
-- Prices by quantity: [{"from": 4, "percent": 90}] — each place at 90% of the
-- rate once a booking takes four or more. NULL: one price per place.
ALTER TABLE courts ADD COLUMN IF NOT EXISTS quantity_prices TEXT;

-- Per player is for a court booked whole; a facility with places is already
-- counted by the place. Templates made some with both: they mean per place.
UPDATE courts SET per_player = 0 WHERE capacity > 1 AND per_player <> 0;
ALTER TABLE courts DROP CONSTRAINT IF EXISTS courts_per_player_whole;
ALTER TABLE courts ADD CONSTRAINT courts_per_player_whole CHECK (per_player = 0 OR capacity = 1);
ALTER TABLE courts DROP CONSTRAINT IF EXISTS courts_flat_rate_places;
ALTER TABLE courts ADD CONSTRAINT courts_flat_rate_places CHECK (NOT flat_rate OR capacity > 1);

-- A studio or room run as classes: customers book its classes, not places in
-- the room (staff can still hire it out).
ALTER TABLE courts ADD COLUMN IF NOT EXISTS classes_only BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------ sign-offs

-- For a branch, or for every branch of a business.
ALTER TABLE sign_offs ALTER COLUMN venue_id DROP NOT NULL;
ALTER TABLE sign_offs ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE sign_offs DROP CONSTRAINT IF EXISTS sign_offs_scope;
ALTER TABLE sign_offs ADD CONSTRAINT sign_offs_scope CHECK ((venue_id IS NULL) <> (business_id IS NULL));
-- The customer's account, where staff matched one: online, only that account
-- (or one that has proved this number) books on it.
ALTER TABLE sign_offs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- An operational sign-off (staff saw them do it) or a certification required
-- by law or a governing body, with what was seen (its number and issuer).
ALTER TABLE sign_offs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'operational';
ALTER TABLE sign_offs DROP CONSTRAINT IF EXISTS sign_offs_kind;
ALTER TABLE sign_offs ADD CONSTRAINT sign_offs_kind CHECK (kind IN ('operational', 'certification'));
ALTER TABLE sign_offs ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE sign_offs DROP CONSTRAINT IF EXISTS sign_offs_certified;
ALTER TABLE sign_offs ADD CONSTRAINT sign_offs_certified CHECK (kind <> 'certification' OR (reference IS NOT NULL AND expires_on IS NOT NULL));
-- Who took it back, and why.
ALTER TABLE sign_offs ADD COLUMN IF NOT EXISTS revoked_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE sign_offs ADD COLUMN IF NOT EXISTS revoke_reason TEXT;

DROP INDEX IF EXISTS uq_sign_offs_live;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sign_offs_live
  ON sign_offs (COALESCE(venue_id, 0), COALESCE(business_id, 0), phone_key(phone), COALESCE(sport, ''), kind)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sign_offs_user ON sign_offs(user_id) WHERE user_id IS NOT NULL AND revoked_at IS NULL;

-- A rule asking for a certification, not only a sign-off.
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS needs_certification BOOLEAN;
