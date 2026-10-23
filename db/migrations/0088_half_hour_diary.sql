-- One diary for every court: time is stored in half hours, whatever a court
-- is sold by (ADR 0008). What a sport is sold by, the hour or the half hour,
-- is a selling rule: the sport's own at the venue (`sport_rules.slot_minutes`),
-- else padel's half hours, else the venue's default (`venues.slot_minutes`).
--
-- This rewrites stored rows: every whole-hour slot of a booking, a block and
-- a coach's lesson becomes its two halves, holding what it held. Nothing is
-- sold, freed or repriced by it: the same booking holds the same time.

-- A booking's whole hour: its second half, with the same seat. Shadows across
-- court links are split as rows of their own, so the trigger that makes them
-- is held off while they are.
ALTER TABLE booking_slots DISABLE TRIGGER booking_slots_linked;
INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span, shadow)
SELECT booking_id, court_id, date, hour + 0.5, seat, 0.5, shadow
  FROM booking_slots WHERE span = 1
ON CONFLICT DO NOTHING;
UPDATE booking_slots SET span = 0.5 WHERE span = 1;
ALTER TABLE booking_slots ENABLE TRIGGER booking_slots_linked;
ALTER TABLE booking_slots ALTER COLUMN span SET DEFAULT 0.5;

INSERT INTO slot_blocks (court_id, date, hour, reason, places, tournament_id, repeat_code, span)
SELECT court_id, date, hour + 0.5, reason, places, tournament_id, repeat_code, 0.5
  FROM slot_blocks WHERE span = 1
ON CONFLICT DO NOTHING;
UPDATE slot_blocks SET span = 0.5 WHERE span = 1;
ALTER TABLE slot_blocks ALTER COLUMN span SET DEFAULT 0.5;

-- A coach's lesson booked by the hour: the half after each of its hours.
INSERT INTO coach_slots (coach_id, date, hour, booking_id)
SELECT c.coach_id, c.date, c.hour + 0.5, c.booking_id
  FROM coach_slots c
  JOIN bookings b ON b.id = c.booking_id
 WHERE c.hour + 0.5 < b.end_hour
   AND NOT EXISTS (SELECT 1 FROM coach_slots o WHERE o.booking_id = c.booking_id AND o.coach_id = c.coach_id AND o.date = c.date AND o.hour = c.hour + 0.5)
ON CONFLICT DO NOTHING;

-- What a sport is sold by at a venue; NULL: the venue's default.
ALTER TABLE sport_rules ADD COLUMN IF NOT EXISTS slot_minutes INTEGER CHECK (slot_minutes IN (30, 60));

-- Outages close a court half hour by half hour.
CREATE OR REPLACE FUNCTION own_blocks_between(d_from text, d_to text)
RETURNS TABLE (court_id integer, date text, hour double precision, reason text, places integer, span double precision)
LANGUAGE sql STABLE AS $$
  SELECT s.court_id, s.date, s.hour, s.reason, s.places, s.span
    FROM slot_blocks s
   WHERE s.date >= d_from AND s.date <= d_to
  UNION ALL
  (SELECT DISTINCT ON (o.court_id, day.d, h.h)
         o.court_id, to_char(day.d, 'YYYY-MM-DD'), h.h::double precision, o.reason, NULL::integer, 0.5::double precision
    FROM court_outages o
    JOIN courts c ON c.id = o.court_id
    JOIN venues v ON v.id = c.venue_id
    CROSS JOIN LATERAL generate_series(
      GREATEST(o.starts_on, d_from)::date,
      LEAST(COALESCE(o.ends_on, d_to), d_to)::date,
      interval '1 day') AS day(d)
    -- That weekday's hours: its own, closed (none), or the usual.
    CROSS JOIN LATERAL (SELECT v.week_hours::jsonb -> EXTRACT(DOW FROM day.d)::int AS e) wd
    CROSS JOIN LATERAL (
      SELECT CASE jsonb_typeof(wd.e) WHEN 'object' THEN (wd.e ->> 'open')::numeric WHEN 'string' THEN 0 ELSE v.open_hour::numeric END AS o,
             CASE jsonb_typeof(wd.e) WHEN 'object' THEN (wd.e ->> 'close')::numeric WHEN 'string' THEN 0 ELSE v.close_hour::numeric END AS c) dh
    -- In numeric, which generate_series steps in by halves exactly. A day has
    -- at most 56 halves (to 4 AM), and saying so keeps the planner from
    -- guessing a thousand.
    CROSS JOIN LATERAL (
      SELECT generate_series(dh.o, dh.c - 0.5, 0.5) AS h
       LIMIT 56) AS h(h)
   WHERE o.starts_on <= d_to AND (o.ends_on IS NULL OR o.ends_on >= d_from)
     AND NOT EXISTS (
       SELECT 1 FROM slot_blocks s
        WHERE s.court_id = o.court_id AND s.date = to_char(day.d, 'YYYY-MM-DD') AND s.hour = h.h::double precision)
   -- Two outages over one half hour: the earlier one's reason.
   ORDER BY o.court_id, day.d, h.h, o.id)
$$;
