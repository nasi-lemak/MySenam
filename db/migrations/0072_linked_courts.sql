-- Linked courts: one floor sold more than one way (lib/court-links.ts). A
-- multi-purpose hall is one futsal pitch or four badminton courts; booking the
-- pitch takes the four, and booking any of the four takes the pitch.
--
-- A link is a whole and one of its parts, both exclusive courts at the same
-- venue. Parts do not take each other, and two wholes over the same part take
-- each other through it.
CREATE TABLE IF NOT EXISTS court_links (
  whole_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
  PRIMARY KEY (whole_id, part_id),
  CHECK (whole_id <> part_id)
);
CREATE INDEX IF NOT EXISTS idx_court_links_part ON court_links(part_id);

-- Each booked hour is mirrored onto the courts it takes, as a slot of the
-- same booking marked `shadow`. Booking_slots' UNIQUE (court_id, date, hour,
-- seat) then refuses a double booking across a link as it does on one court,
-- however two requests race:
--   a whole's hour takes seat 0 on each part, where a booking of the part sits;
--   a part's hour takes seat -part_id on the whole, so the whole reads as full
--   (and parts do not collide with each other there).
-- Shadows go when the booking's slots go (they are its own rows), and are not
-- time sold: the reports count only `shadow = 0`.
ALTER TABLE booking_slots ADD COLUMN IF NOT EXISTS shadow SMALLINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION shadow_linked_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shadow = 0 THEN
    INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span, shadow)
      SELECT NEW.booking_id, l.part_id, NEW.date, NEW.hour, 0, NEW.span, 1
        FROM court_links l WHERE l.whole_id = NEW.court_id
      UNION ALL
      SELECT NEW.booking_id, l.whole_id, NEW.date, NEW.hour, -NEW.court_id, NEW.span, 1
        FROM court_links l WHERE l.part_id = NEW.court_id;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS booking_slots_linked ON booking_slots;
CREATE TRIGGER booking_slots_linked AFTER INSERT ON booking_slots
  FOR EACH ROW EXECUTE FUNCTION shadow_linked_slot();

-- Blocks: a block or outage on a court closes the courts linked to it too,
-- since it is the same floor. Outages also now follow each weekday's own
-- hours (venues.week_hours), late Friday hours included.
--
-- Two functions, each one plain SELECT, so the planner inlines them and a
-- caller's "WHERE court_id = ..." reaches the tables (a shared WITH would
-- stop it, and read every venue's blocks for every call).
DROP FUNCTION IF EXISTS blocks_between(text, text);
DROP FUNCTION IF EXISTS own_blocks_between(text, text);
CREATE FUNCTION own_blocks_between(d_from text, d_to text)
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
    -- That weekday's hours: its own, closed (none), or the usual.
    CROSS JOIN LATERAL (SELECT v.week_hours::jsonb -> EXTRACT(DOW FROM day.d)::int AS e) wd
    CROSS JOIN LATERAL (
      SELECT CASE jsonb_typeof(wd.e) WHEN 'object' THEN (wd.e ->> 'open')::numeric WHEN 'string' THEN 0 ELSE v.open_hour::numeric END AS o,
             CASE jsonb_typeof(wd.e) WHEN 'object' THEN (wd.e ->> 'close')::numeric WHEN 'string' THEN 0 ELSE v.close_hour::numeric END AS c) dh
    -- In numeric, which generate_series steps in by halves exactly. A day has
    -- at most 56 slots (to 4 AM by halves), and saying so keeps the planner
    -- from guessing a thousand.
    CROSS JOIN LATERAL (
      SELECT generate_series(dh.o, dh.c - v.slot_minutes / 60.0, v.slot_minutes / 60.0) AS h
       LIMIT 56) AS h(h)
   WHERE o.starts_on <= d_to AND (o.ends_on IS NULL OR o.ends_on >= d_from)
     AND NOT EXISTS (
       SELECT 1 FROM slot_blocks s
        WHERE s.court_id = o.court_id AND s.date = to_char(day.d, 'YYYY-MM-DD') AND s.hour = h.h::double precision)
   -- Two outages over one hour: the earlier one's reason.
   ORDER BY o.court_id, day.d, h.h, o.id)
$$;

CREATE FUNCTION blocks_between(d_from text, d_to text)
RETURNS TABLE (court_id integer, date text, hour double precision, reason text, places integer, span double precision)
LANGUAGE sql STABLE AS $$
  -- A court's own block first; else one carried across a link, whole. Driven
  -- from the links court by court, so a venue with none reads nothing more.
  SELECT DISTINCT ON (b.court_id, b.date, b.hour) b.court_id, b.date, b.hour, b.reason, b.places, b.span
    FROM (
      SELECT o.court_id, o.date, o.hour, o.reason, o.places, o.span, 0 AS carried FROM own_blocks_between(d_from, d_to) o
      UNION ALL
      SELECT l.court_id, o.date, o.hour, o.reason, NULL::integer, o.span, 1
        FROM (SELECT whole_id AS court_id, part_id AS other FROM court_links
              UNION ALL SELECT part_id, whole_id FROM court_links) l
        JOIN own_blocks_between(d_from, d_to) o ON o.court_id = l.other
    ) b
   ORDER BY b.court_id, b.date, b.hour, b.carried
$$;
