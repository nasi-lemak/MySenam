-- What a venue does about a booking that starts while the counter is staffed
-- and runs on after it shuts (or the other way round): give the door code, so
-- the customer is not left without a way in or out at the end, or keep
-- somebody on the desk until such bookings end.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS partly_unstaffed TEXT NOT NULL DEFAULT 'code'
  CHECK (partly_unstaffed IN ('code', 'counter'));
