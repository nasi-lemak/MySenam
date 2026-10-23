-- Reservations as exact intervals (ADR 0010), part 2: what the half-hour
-- diary holds, as claims. Each venue's zone was staged by the step after
-- 0089 (lib/db-steps.ts); the step after this one compares the old diary with
-- the new claims half hour by half hour, and the migration fails rather than
-- move anything.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM venues v WHERE NOT EXISTS (SELECT 1 FROM migration_venue_zones z WHERE z.venue_id = v.id)) THEN
    RAISE EXCEPTION 'a venue has no staged time zone';
  END IF;
END
$$;

-- Minute `m` of business day `d`, where the venue is.
CREATE FUNCTION migration_instant(d TEXT, m INTEGER, zone TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$ SELECT (d::date + make_interval(mins => m)) AT TIME ZONE zone $$;

-- ------------------------------------------------------------ spaces

INSERT INTO spaces (venue_id, court_id) SELECT venue_id, id FROM courts WHERE capacity = 1;
INSERT INTO court_spaces (court_id, space_id) SELECT court_id, id FROM spaces;
-- From here on the database keeps a court's own space in step with its
-- capacity, however the court was written: one booking at a time, a space;
-- shared, none (court_spaces and the claims on it go with it).
CREATE OR REPLACE FUNCTION court_own_space() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  own INTEGER;
BEGIN
  IF NEW.capacity = 1 THEN
    INSERT INTO spaces (venue_id, court_id) VALUES (NEW.venue_id, NEW.id) ON CONFLICT (court_id) DO NOTHING RETURNING id INTO own;
    IF own IS NOT NULL THEN
      INSERT INTO court_spaces (court_id, space_id) VALUES (NEW.id, own) ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    DELETE FROM spaces WHERE court_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS courts_own_space ON courts;
CREATE TRIGGER courts_own_space AFTER INSERT OR UPDATE OF capacity ON courts
  FOR EACH ROW EXECUTE FUNCTION court_own_space();
-- A court over others covers their spaces as well as its own.
INSERT INTO court_spaces (court_id, space_id)
SELECT l.whole_id, s.id FROM court_links l JOIN spaces s ON s.court_id = l.part_id
  JOIN courts w ON w.id = l.whole_id AND w.capacity = 1
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------ bookings

UPDATE bookings b
   SET starts_at = migration_instant(b.date, b.start_min, z.zone),
       ends_at = migration_instant(b.date, b.end_min, z.zone)
  FROM courts c JOIN migration_venue_zones z ON z.venue_id = c.venue_id
 WHERE c.id = b.court_id;

-- Every booking still holding the diary held one stretch: its own slots, end
-- to end, exactly its start to its end.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT b.code INTO bad FROM bookings b JOIN booking_slots s ON s.booking_id = b.id AND s.shadow = 0
   GROUP BY b.id, b.code, b.start_min, b.end_min
  HAVING round(min(s.hour) * 60) <> b.start_min
      OR round(max(s.hour + s.span) * 60) <> b.end_min
      -- One place each half hour (a shared facility's may differ from one to the next).
      OR count(*) <> count(DISTINCT s.hour)
      OR round(sum(s.span) * 60) <> b.end_min - b.start_min
      OR count(DISTINCT s.court_id) <> 1
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'booking % does not hold one stretch of its own time', bad;
  END IF;
END
$$;

-- A booking holding the diary claims its court's spaces, or a place of a
-- shared facility. A class enrolment holds no court time of its own: the
-- class does.
INSERT INTO claims (venue_id, court_id, space_id, kind, booking_id, during, occupied)
SELECT c.venue_id, b.court_id, cs.space_id, 'booking', b.id,
       tstzrange(b.starts_at, b.ends_at, '[)'), tstzrange(b.starts_at, b.ends_at, '[)')
  FROM bookings b JOIN courts c ON c.id = b.court_id JOIN court_spaces cs ON cs.court_id = b.court_id
 WHERE c.capacity = 1 AND b.class_id IS NULL
   AND EXISTS (SELECT 1 FROM booking_slots s WHERE s.booking_id = b.id AND s.shadow = 0);
INSERT INTO claims (venue_id, court_id, places, kind, booking_id, during, occupied)
SELECT c.venue_id, b.court_id, 1, 'booking', b.id,
       tstzrange(b.starts_at, b.ends_at, '[)'), tstzrange(b.starts_at, b.ends_at, '[)')
  FROM bookings b JOIN courts c ON c.id = b.court_id
 WHERE c.capacity > 1 AND b.class_id IS NULL
   AND EXISTS (SELECT 1 FROM booking_slots s WHERE s.booking_id = b.id AND s.shadow = 0);

-- A coach in a lesson, for the lesson's time.
INSERT INTO coach_claims (coach_id, booking_id, during)
SELECT DISTINCT k.coach_id, b.id, tstzrange(b.starts_at, b.ends_at, '[)')
  FROM coach_slots k JOIN bookings b ON b.id = k.booking_id;

-- ------------------------------------------------------------ classes

INSERT INTO claims (venue_id, court_id, space_id, kind, class_id, during, occupied)
SELECT c.venue_id, k.court_id, cs.space_id, 'class', k.id,
       tstzrange(migration_instant(k.date, k.start_min, z.zone), migration_instant(k.date, k.end_min, z.zone), '[)'),
       tstzrange(migration_instant(k.date, k.start_min, z.zone), migration_instant(k.date, k.end_min, z.zone), '[)')
  FROM classes k JOIN courts c ON c.id = k.court_id JOIN migration_venue_zones z ON z.venue_id = c.venue_id
  JOIN court_spaces cs ON cs.court_id = k.court_id
 WHERE k.status = 'scheduled' AND c.capacity = 1;
INSERT INTO claims (venue_id, court_id, places, kind, class_id, during, occupied)
SELECT c.venue_id, k.court_id, c.capacity, 'class', k.id,
       tstzrange(migration_instant(k.date, k.start_min, z.zone), migration_instant(k.date, k.end_min, z.zone), '[)'),
       tstzrange(migration_instant(k.date, k.start_min, z.zone), migration_instant(k.date, k.end_min, z.zone), '[)')
  FROM classes k JOIN courts c ON c.id = k.court_id JOIN migration_venue_zones z ON z.venue_id = c.venue_id
 WHERE k.status = 'scheduled' AND c.capacity > 1;

-- ------------------------------------------------------------ blocks

-- Half hours blocked alike, end to end, become one block.
WITH halves AS (
  SELECT s.court_id, s.date, s.reason, s.places, s.repeat_code, s.tournament_id,
         round(s.hour * 60)::int AS m, round(s.span * 60)::int AS len
    FROM slot_blocks s
), runs AS (
  SELECT h.*, h.m - sum(h.len) OVER (
           PARTITION BY h.court_id, h.date, COALESCE(h.reason, ''), COALESCE(h.places, -1), COALESCE(h.repeat_code, ''), COALESCE(h.tournament_id, -1)
           ORDER BY h.m ROWS UNBOUNDED PRECEDING) AS grp
    FROM halves h
)
INSERT INTO blocks (venue_id, court_id, date, start_min, end_min, reason, places, repeat_code, tournament_id)
SELECT c.venue_id, r.court_id, r.date, min(r.m), max(r.m + r.len), r.reason, r.places, r.repeat_code, r.tournament_id
  FROM runs r JOIN courts c ON c.id = r.court_id
 GROUP BY c.venue_id, r.court_id, r.date, r.reason, r.places, r.repeat_code, r.tournament_id, r.grp;

INSERT INTO claims (venue_id, court_id, space_id, kind, block_id, during, occupied)
SELECT k.venue_id, k.court_id, cs.space_id, 'block', k.id,
       tstzrange(migration_instant(k.date, k.start_min, z.zone), migration_instant(k.date, k.end_min, z.zone), '[)'),
       tstzrange(migration_instant(k.date, k.start_min, z.zone), migration_instant(k.date, k.end_min, z.zone), '[)')
  FROM blocks k JOIN courts c ON c.id = k.court_id JOIN migration_venue_zones z ON z.venue_id = k.venue_id
  JOIN court_spaces cs ON cs.court_id = k.court_id
 WHERE c.capacity = 1;
INSERT INTO claims (venue_id, court_id, places, kind, block_id, during, occupied)
SELECT k.venue_id, k.court_id, COALESCE(k.places, c.capacity), 'block', k.id,
       tstzrange(migration_instant(k.date, k.start_min, z.zone), migration_instant(k.date, k.end_min, z.zone), '[)'),
       tstzrange(migration_instant(k.date, k.start_min, z.zone), migration_instant(k.date, k.end_min, z.zone), '[)')
  FROM blocks k JOIN courts c ON c.id = k.court_id JOIN migration_venue_zones z ON z.venue_id = k.venue_id
 WHERE c.capacity > 1;

-- ------------------------------------------------------------ outages

-- Out of service for whole business days, from the first to the last (or on).
INSERT INTO claims (venue_id, court_id, space_id, kind, outage_id, during, occupied)
SELECT c.venue_id, o.court_id, cs.space_id, 'outage', o.id,
       tstzrange(migration_instant(o.starts_on, 0, z.zone),
                 CASE WHEN o.ends_on IS NULL THEN NULL ELSE migration_instant(o.ends_on, 1440, z.zone) END, '[)'),
       tstzrange(migration_instant(o.starts_on, 0, z.zone),
                 CASE WHEN o.ends_on IS NULL THEN NULL ELSE migration_instant(o.ends_on, 1440, z.zone) END, '[)')
  FROM court_outages o JOIN courts c ON c.id = o.court_id JOIN migration_venue_zones z ON z.venue_id = c.venue_id
  JOIN court_spaces cs ON cs.court_id = o.court_id
 WHERE c.capacity = 1;
INSERT INTO claims (venue_id, court_id, places, kind, outage_id, during, occupied)
SELECT c.venue_id, o.court_id, c.capacity, 'outage', o.id,
       tstzrange(migration_instant(o.starts_on, 0, z.zone),
                 CASE WHEN o.ends_on IS NULL THEN NULL ELSE migration_instant(o.ends_on, 1440, z.zone) END, '[)'),
       tstzrange(migration_instant(o.starts_on, 0, z.zone),
                 CASE WHEN o.ends_on IS NULL THEN NULL ELSE migration_instant(o.ends_on, 1440, z.zone) END, '[)')
  FROM court_outages o JOIN courts c ON c.id = o.court_id JOIN migration_venue_zones z ON z.venue_id = c.venue_id
 WHERE c.capacity > 1;

-- ------------------------------------------------------------ the rest in minutes

ALTER TABLE bookings ALTER COLUMN start_min SET NOT NULL;
ALTER TABLE bookings ALTER COLUMN end_min SET NOT NULL;
ALTER TABLE bookings ALTER COLUMN starts_at SET NOT NULL;
ALTER TABLE bookings ALTER COLUMN ends_at SET NOT NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_minutes CHECK (end_min > start_min AND ends_at > starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_starts_at ON bookings(starts_at);
ALTER TABLE classes ALTER COLUMN start_min SET NOT NULL;
ALTER TABLE classes ALTER COLUMN end_min SET NOT NULL;
ALTER TABLE classes ADD CONSTRAINT classes_minutes CHECK (end_min > start_min);
ALTER TABLE coach_hours ALTER COLUMN from_min SET NOT NULL;
ALTER TABLE coach_hours ALTER COLUMN until_min SET NOT NULL;
ALTER TABLE tournaments ALTER COLUMN start_min SET NOT NULL;
ALTER TABLE tournaments ALTER COLUMN end_min SET NOT NULL;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_minutes CHECK (end_min > start_min);
ALTER TABLE urgent_notices ALTER COLUMN start_min SET NOT NULL;
ALTER TABLE venues ADD CONSTRAINT venues_minutes CHECK (close_min > open_min);

DROP FUNCTION migration_instant(TEXT, INTEGER, TEXT);
