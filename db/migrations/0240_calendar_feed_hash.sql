-- A venue's staff calendar feed (lib/staff-calendar.ts) kept as a hash, with
-- an expiry, as coaches' links are (0137): the address is shown once, when a
-- manager makes it, and a copy of the database cannot be used to read the
-- venue's bookings. Addresses already given keep working until their new
-- expiry, a year from now; the plain tokens are removed.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS calendar_feed_hash TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS calendar_feed_made_at TIMESTAMPTZ;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS calendar_feed_expires_at TIMESTAMPTZ;
UPDATE venues
   SET calendar_feed_hash = encode(sha256(convert_to(calendar_token, 'UTF8')), 'hex'),
       calendar_feed_expires_at = now() + interval '365 days'
 WHERE calendar_token IS NOT NULL;
UPDATE venues SET calendar_token = NULL WHERE calendar_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS venues_calendar_feed_hash ON venues (calendar_feed_hash) WHERE calendar_feed_hash IS NOT NULL;
