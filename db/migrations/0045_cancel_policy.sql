-- What a late cancellation or a no-show costs, venue by venue.
--
-- late_cancel_keep: NULL (as before) means a customer cannot cancel after the
-- free-cancellation cutoff, only call; a percentage means they can, and the
-- venue keeps that share of what was paid, the rest going back as it came.
--
-- strike_limit / strike_days: after this many no-shows, and late
-- cancellations of bookings never paid, in that many days, a number must pay
-- online to book here (or book at the counter, where the venue takes nothing
-- online). NULL: no limit, as before.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS late_cancel_keep INTEGER;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS strike_limit INTEGER;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS strike_days INTEGER NOT NULL DEFAULT 90;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_cancelled INTEGER NOT NULL DEFAULT 0;
