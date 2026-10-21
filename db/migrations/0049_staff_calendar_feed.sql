-- A secret address a venue's staff subscribe to in their own calendar app,
-- for the venue's bookings and classes. NULL: no feed. A new token is a new
-- address, and the old one stops working.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS calendar_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS venues_calendar_token ON venues (calendar_token) WHERE calendar_token IS NOT NULL;
