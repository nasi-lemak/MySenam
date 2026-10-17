-- idx_slots_court_date (court_id, date) repeats the start of the UNIQUE
-- (court_id, date, hour, seat) index that stops double-booking, which answers
-- the same lookups — measured, as an index-only scan. Dropping it takes about
-- 18 bytes off every booked hour: 94 MB per five million.
DROP INDEX IF EXISTS idx_slots_court_date;
