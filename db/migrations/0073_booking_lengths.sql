-- How long a booking may run, court by court, and how many weeks a weekly
-- booking may run at a venue (lib/types.ts `bookingLengths`, lib/house-rules.ts).
-- NULL keeps what was always so: one slot to four hours, and eight weeks.
ALTER TABLE courts ADD COLUMN IF NOT EXISTS min_hours DOUBLE PRECISION;
ALTER TABLE courts ADD COLUMN IF NOT EXISTS max_hours DOUBLE PRECISION;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS series_weeks INTEGER;
