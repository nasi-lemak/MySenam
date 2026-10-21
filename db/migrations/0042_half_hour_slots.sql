-- Half-hour bookings. A venue sells its courts by the hour, as before, or by
-- the half hour: `slot_minutes`, 60 or 30. Times that were whole hours can
-- now be on the half hour (18.5 is 18:30), so the columns holding them become
-- double precision; every value already stored keeps its meaning.
--
-- A booking's slots, and a block's, each carry how long they are (`span`, in
-- hours), so the reports add up time sold correctly whichever way a venue sold
-- it then. Classes, tournaments and trading hours stay on the hour.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS slot_minutes INTEGER NOT NULL DEFAULT 60;
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_slot_minutes_check;
ALTER TABLE venues ADD CONSTRAINT venues_slot_minutes_check CHECK (slot_minutes IN (30, 60));

ALTER TABLE bookings ALTER COLUMN start_hour TYPE double precision;
ALTER TABLE bookings ALTER COLUMN end_hour TYPE double precision;
ALTER TABLE booking_slots ALTER COLUMN hour TYPE double precision;
ALTER TABLE booking_slots ADD COLUMN IF NOT EXISTS span double precision NOT NULL DEFAULT 1;
ALTER TABLE slot_blocks ALTER COLUMN hour TYPE double precision;
ALTER TABLE slot_blocks ADD COLUMN IF NOT EXISTS span double precision NOT NULL DEFAULT 1;
ALTER TABLE waitlist ALTER COLUMN start_hour TYPE double precision;
ALTER TABLE waitlist ALTER COLUMN end_hour TYPE double precision;
ALTER TABLE urgent_notices ALTER COLUMN start_hour TYPE double precision;

-- Outages expand into each venue's own slots.
DROP FUNCTION IF EXISTS blocks_between(text, text);
CREATE FUNCTION blocks_between(d_from text, d_to text)
RETURNS TABLE (court_id integer, date text, hour double precision, reason text, places integer, span double precision)
LANGUAGE sql STABLE AS $$
  SELECT s.court_id, s.date, s.hour, s.reason, s.places, s.span
    FROM slot_blocks s
   WHERE s.date >= d_from AND s.date <= d_to
  UNION ALL
  (SELECT DISTINCT ON (o.court_id, day.d, h.h)
         o.court_id, to_char(day.d, 'YYYY-MM-DD'), h.h::double precision, o.reason, NULL::integer, v.slot_minutes / 60.0::double precision
    FROM court_outages o
    JOIN courts c ON c.id = o.court_id
    JOIN venues v ON v.id = c.venue_id
    CROSS JOIN LATERAL generate_series(
      GREATEST(o.starts_on, d_from)::date,
      LEAST(COALESCE(o.ends_on, d_to), d_to)::date,
      interval '1 day') AS day(d)
    -- In numeric, which generate_series steps in by halves exactly. A day has
    -- at most 48 slots, and saying so keeps the planner from guessing a
    -- thousand, which would cost every query that asks a JIT compilation.
    CROSS JOIN LATERAL (
      SELECT generate_series(v.open_hour::numeric, v.close_hour - v.slot_minutes / 60.0, v.slot_minutes / 60.0) AS h
       LIMIT 48) AS h(h)
   WHERE o.starts_on <= d_to AND (o.ends_on IS NULL OR o.ends_on >= d_from)
     AND NOT EXISTS (
       SELECT 1 FROM slot_blocks s
        WHERE s.court_id = o.court_id AND s.date = to_char(day.d, 'YYYY-MM-DD') AND s.hour = h.h::double precision)
   -- Two outages over one hour: the earlier one's reason.
   ORDER BY o.court_id, day.d, h.h, o.id)
$$;
