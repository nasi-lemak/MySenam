-- Reservations as exact intervals (ADR 0010), part 1: the new structures and
-- every time of day in minutes. Part 2 (0090) turns what is stored into
-- claims; part 3 (0091) removes the half-hour diary.
--
-- Times of day become whole minutes from the start of the business day
-- (18:07 is 1087; past 1440 is after midnight), replacing decimal hours.

-- ------------------------------------------------------------ minutes

ALTER TABLE venues ADD COLUMN IF NOT EXISTS open_min INTEGER;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS close_min INTEGER;
UPDATE venues SET open_min = round(open_hour * 60), close_min = round(close_hour * 60);
ALTER TABLE venues ALTER COLUMN open_min SET NOT NULL;
ALTER TABLE venues ALTER COLUMN close_min SET NOT NULL;
ALTER TABLE venues ALTER COLUMN open_min SET DEFAULT 480;
ALTER TABLE venues ALTER COLUMN close_min SET DEFAULT 1380;
-- Each weekday's own hours, in minutes too.
UPDATE venues SET week_hours = (
  SELECT jsonb_agg(
           CASE WHEN jsonb_typeof(e) = 'object'
                THEN jsonb_build_object('open', round((e ->> 'open')::numeric * 60)::int, 'close', round((e ->> 'close')::numeric * 60)::int)
                ELSE e END
           ORDER BY i)::text
    FROM jsonb_array_elements(week_hours::jsonb) WITH ORDINALITY AS a(e, i))
 WHERE week_hours IS NOT NULL;

-- Peak windows to the minute (they were whole hours).
ALTER TABLE venues RENAME COLUMN peak_weekday_from TO peak_weekday_from_min;
ALTER TABLE venues RENAME COLUMN peak_weekday_until TO peak_weekday_until_min;
ALTER TABLE venues RENAME COLUMN peak_weekend_from TO peak_weekend_from_min;
ALTER TABLE venues RENAME COLUMN peak_weekend_until TO peak_weekend_until_min;
UPDATE venues SET peak_weekday_from_min = peak_weekday_from_min * 60, peak_weekday_until_min = peak_weekday_until_min * 60,
                  peak_weekend_from_min = peak_weekend_from_min * 60, peak_weekend_until_min = peak_weekend_until_min * 60;
ALTER TABLE venues ALTER COLUMN peak_weekday_from_min SET DEFAULT 1080;
ALTER TABLE venues ALTER COLUMN peak_weekday_until_min SET DEFAULT 1440;
ALTER TABLE venues ALTER COLUMN peak_weekend_from_min SET DEFAULT 0;
ALTER TABLE venues ALTER COLUMN peak_weekend_until_min SET DEFAULT 1440;
ALTER TABLE sport_rules RENAME COLUMN peak_weekday_from TO peak_weekday_from_min;
ALTER TABLE sport_rules RENAME COLUMN peak_weekday_until TO peak_weekday_until_min;
ALTER TABLE sport_rules RENAME COLUMN peak_weekend_from TO peak_weekend_from_min;
ALTER TABLE sport_rules RENAME COLUMN peak_weekend_until TO peak_weekend_until_min;
UPDATE sport_rules SET peak_weekday_from_min = peak_weekday_from_min * 60, peak_weekday_until_min = peak_weekday_until_min * 60,
                       peak_weekend_from_min = peak_weekend_from_min * 60, peak_weekend_until_min = peak_weekend_until_min * 60;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS start_min INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS end_min INTEGER;
-- The moments it starts and ends, where the venue is (set in 0090).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
-- Setup and cleanup fees, part of total_price, shown apart from the time booked.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
-- Made by staff outside the booking policy (who and what is in the activity log).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS policy_override BOOLEAN NOT NULL DEFAULT false;
UPDATE bookings SET start_min = round(start_hour * 60), end_min = round(end_hour * 60);

ALTER TABLE classes ADD COLUMN IF NOT EXISTS start_min INTEGER;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS end_min INTEGER;
UPDATE classes SET start_min = round(start_hour * 60), end_min = round(end_hour * 60);

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS start_min INTEGER;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS end_min INTEGER;
UPDATE waitlist SET start_min = round(start_hour * 60), end_min = round(end_hour * 60) WHERE start_hour IS NOT NULL;

ALTER TABLE urgent_notices ADD COLUMN IF NOT EXISTS start_min INTEGER;
UPDATE urgent_notices SET start_min = round(start_hour * 60);

ALTER TABLE coach_hours ADD COLUMN IF NOT EXISTS from_min INTEGER;
ALTER TABLE coach_hours ADD COLUMN IF NOT EXISTS until_min INTEGER;
UPDATE coach_hours SET from_min = round(from_hour * 60), until_min = round(until_hour * 60);

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS start_min INTEGER;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS end_min INTEGER;
-- How long each match is given on court.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS match_minutes INTEGER NOT NULL DEFAULT 60 CHECK (match_minutes BETWEEN 5 AND 600);
UPDATE tournaments SET start_min = start_hour * 60, end_min = end_hour * 60;
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS start_min INTEGER;
UPDATE tournament_matches SET start_min = hour * 60 WHERE hour IS NOT NULL;

-- ------------------------------------------------------------ spaces

-- The smallest things that can be double-booked: one for each court that
-- takes one booking at a time. A court is the set of spaces it covers: its
-- own, and, for a court over others (a futsal pitch over badminton courts),
-- theirs too. Shared facilities (capacity above one) have none: they hold
-- places.
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  court_id INTEGER NOT NULL UNIQUE REFERENCES courts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS court_spaces (
  court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  PRIMARY KEY (court_id, space_id)
);
CREATE INDEX IF NOT EXISTS idx_court_spaces_space ON court_spaces(space_id);

-- ------------------------------------------------------------ blocks

-- Time staff take a court out for: a block, a repeating block's week, a
-- rain-out, a tournament's hold. Its claims hold the court.
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  reason TEXT,
  -- Places out of a shared facility; NULL: the whole court.
  places INTEGER CHECK (places IS NULL OR places > 0),
  repeat_code TEXT,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT datetime('now'),
  CHECK (end_min > start_min)
);
CREATE INDEX IF NOT EXISTS idx_blocks_court_date ON blocks(court_id, date);
CREATE INDEX IF NOT EXISTS idx_blocks_repeat ON blocks(repeat_code, date) WHERE repeat_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_tournament ON blocks(tournament_id) WHERE tournament_id IS NOT NULL;

-- ------------------------------------------------------------ claims

-- Everything that occupies a court's time, as an exact interval: bookings
-- (paid, or held unpaid), waiting-list offers, classes, blocks, outages.
-- Exclusive space: one claim per space, and the exclusion constraint refuses
-- any two that overlap, whatever wrote them. Shared facilities: places, and
-- a trigger refuses more than the court's capacity at any moment.
CREATE TABLE IF NOT EXISTS claims (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
  space_id INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
  places INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'offer', 'class', 'block', 'outage')),
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
  outage_id INTEGER REFERENCES court_outages(id) ON DELETE CASCADE,
  waitlist_id INTEGER REFERENCES waitlist(id) ON DELETE CASCADE,
  -- The time sold or held.
  during TSTZRANGE NOT NULL,
  -- The time it keeps the court from anybody else: `during` with the court's
  -- buffers either side, as they were when it was made.
  occupied TSTZRANGE NOT NULL,
  buffer_before INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before >= 0),
  buffer_after INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  -- A waiting-list offer lapses then.
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((space_id IS NULL) <> (places IS NULL)),
  CHECK (places IS NULL OR places > 0),
  CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during) AND NOT lower_inf(during)),
  CHECK (occupied @> during),
  -- To the minute.
  CHECK (extract(epoch FROM lower(during)) % 60 = 0 AND (upper_inf(during) OR extract(epoch FROM upper(during)) % 60 = 0)),
  CHECK ((kind = 'booking') = (booking_id IS NOT NULL)),
  CHECK ((kind = 'class') = (class_id IS NOT NULL)),
  CHECK ((kind = 'block') = (block_id IS NOT NULL)),
  CHECK ((kind = 'outage') = (outage_id IS NOT NULL)),
  CHECK ((kind = 'offer') = (waitlist_id IS NOT NULL))
);
-- int4range(id, id, '[]') && is equality, so no extension is needed.
ALTER TABLE claims ADD CONSTRAINT claims_no_overlap
  EXCLUDE USING gist (int4range(space_id, space_id, '[]') WITH &&, occupied WITH &&)
  WHERE (active AND space_id IS NOT NULL)
  DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX IF NOT EXISTS idx_claims_court_during ON claims USING gist (int4range(court_id, court_id, '[]'), occupied) WHERE active;
CREATE INDEX IF NOT EXISTS idx_claims_booking ON claims(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_class ON claims(class_id) WHERE class_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_block ON claims(block_id) WHERE block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_outage ON claims(outage_id) WHERE outage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_offer ON claims(waitlist_id) WHERE waitlist_id IS NOT NULL;

-- A claim's court, space and venue agree: nothing is held across venues. A
-- court that takes one booking at a time is held by its spaces, never by
-- places (which only the capacity trigger would see), and a shared facility
-- by places.
CREATE OR REPLACE FUNCTION claim_belongs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap INTEGER;
BEGIN
  SELECT capacity INTO cap FROM courts WHERE id = NEW.court_id AND venue_id = NEW.venue_id;
  IF cap IS NULL THEN
    RAISE EXCEPTION 'claim court % is not at venue %', NEW.court_id, NEW.venue_id USING ERRCODE = '23514';
  END IF;
  IF (cap = 1) <> (NEW.space_id IS NOT NULL) THEN
    RAISE EXCEPTION 'court % is held by %', NEW.court_id, CASE WHEN cap = 1 THEN 'its spaces' ELSE 'places' END USING ERRCODE = '23514';
  END IF;
  IF NEW.space_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM court_spaces WHERE court_id = NEW.court_id AND space_id = NEW.space_id) THEN
    RAISE EXCEPTION 'space % is not part of court %', NEW.space_id, NEW.court_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS claims_belong ON claims;
CREATE TRIGGER claims_belong BEFORE INSERT OR UPDATE OF venue_id, court_id, space_id, places ON claims
  FOR EACH ROW EXECUTE FUNCTION claim_belongs();

-- A shared facility never holds more places than it has at any moment. The
-- court row is locked first, so claims on one facility are checked one after
-- another; claims on other facilities are not held up. NO KEY UPDATE, not
-- UPDATE: the bookings and claims being written alongside hold a key-share
-- lock on the same row through their foreign keys, which UPDATE would wait
-- on, each transaction for the next.
CREATE OR REPLACE FUNCTION claim_within_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap INTEGER;
  peak INTEGER;
BEGIN
  IF NEW.space_id IS NOT NULL OR NOT NEW.active THEN
    RETURN NEW;
  END IF;
  SELECT capacity INTO cap FROM courts WHERE id = NEW.court_id FOR NO KEY UPDATE;
  SELECT COALESCE(max(load), 0) INTO peak FROM (
    SELECT sum(d) OVER (ORDER BY t, d) AS load FROM (
      SELECT greatest(lower(c.occupied), lower(NEW.occupied)) AS t, c.places AS d
        FROM claims c
       WHERE c.court_id = NEW.court_id AND c.active AND c.space_id IS NULL AND c.id <> COALESCE(NEW.id, -1)
         AND c.occupied && NEW.occupied AND (c.expires_at IS NULL OR c.expires_at > now())
      UNION ALL
      SELECT least(COALESCE(upper(c.occupied), 'infinity'), COALESCE(upper(NEW.occupied), 'infinity')), -c.places
        FROM claims c
       WHERE c.court_id = NEW.court_id AND c.active AND c.space_id IS NULL AND c.id <> COALESCE(NEW.id, -1)
         AND c.occupied && NEW.occupied AND (c.expires_at IS NULL OR c.expires_at > now())
    ) edges
  ) loads;
  IF peak + NEW.places > cap THEN
    RAISE EXCEPTION 'court % has % places; % are held then', NEW.court_id, cap, peak USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS claims_capacity ON claims;
CREATE TRIGGER claims_capacity BEFORE INSERT OR UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION claim_within_capacity();

-- A coach is in one lesson at a time, to the minute.
CREATE TABLE IF NOT EXISTS coach_claims (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  during TSTZRANGE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during))
);
ALTER TABLE coach_claims ADD CONSTRAINT coach_claims_no_overlap
  EXCLUDE USING gist (int4range(coach_id, coach_id, '[]') WITH &&, during WITH &&) WHERE (active);
CREATE INDEX IF NOT EXISTS idx_coach_claims_booking ON coach_claims(booking_id);

-- ------------------------------------------------------------ policies

-- What may be booked, apart from what is stored: when bookings start, how
-- long they are, buffers, hours, notice, and how time is priced. Each setting
-- is inherited where it is NULL: a court's own, else its sport's at the
-- venue, else the venue's, else its business's, else the platform's
-- (lib/booking-policy.ts).
CREATE TABLE IF NOT EXISTS booking_policies (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  sport TEXT,
  court_id INTEGER REFERENCES courts(id) ON DELETE CASCADE,
  start_every INTEGER CHECK (start_every BETWEEN 1 AND 1440),
  start_offset INTEGER CHECK (start_offset BETWEEN 0 AND 1439),
  start_times TEXT,
  length_step INTEGER CHECK (length_step BETWEEN 1 AND 1440),
  min_length INTEGER CHECK (min_length BETWEEN 1 AND 1440),
  max_length INTEGER CHECK (max_length BETWEEN 1 AND 1440),
  lengths TEXT,
  default_length INTEGER CHECK (default_length BETWEEN 1 AND 1440),
  buffer_before INTEGER CHECK (buffer_before BETWEEN 0 AND 240),
  buffer_after INTEGER CHECK (buffer_after BETWEEN 0 AND 240),
  week_hours TEXT,
  notice_minutes INTEGER CHECK (notice_minutes BETWEEN 0 AND 10080),
  rate_mode TEXT CHECK (rate_mode IN ('split', 'start')),
  bill_step INTEGER CHECK (bill_step BETWEEN 1 AND 1440),
  min_billed INTEGER CHECK (min_billed BETWEEN 1 AND 1440),
  min_charge NUMERIC(12,2) CHECK (min_charge >= 0),
  fixed_prices TEXT,
  setup_fee NUMERIC(12,2) CHECK (setup_fee >= 0),
  cleanup_fee NUMERIC(12,2) CHECK (cleanup_fee >= 0),
  updated_at TEXT NOT NULL DEFAULT datetime('now'),
  CHECK (
    (court_id IS NOT NULL AND venue_id IS NULL AND sport IS NULL AND business_id IS NULL) OR
    (court_id IS NULL AND venue_id IS NOT NULL AND business_id IS NULL) OR
    (court_id IS NULL AND venue_id IS NULL AND sport IS NULL AND business_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_court ON booking_policies(court_id) WHERE court_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_venue ON booking_policies(venue_id) WHERE venue_id IS NOT NULL AND sport IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_venue_sport ON booking_policies(venue_id, sport) WHERE venue_id IS NOT NULL AND sport IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_business ON booking_policies(business_id) WHERE business_id IS NOT NULL;

-- Today's settings, as policies: a venue sold by the half hour starts and
-- runs in half hours; a sport's own unit likewise; a court's shortest and
-- longest booking are its own.
INSERT INTO booking_policies (venue_id, start_every, length_step, min_length)
SELECT id, slot_minutes, slot_minutes, slot_minutes FROM venues WHERE slot_minutes = 30;
INSERT INTO booking_policies (venue_id, sport, start_every, length_step, min_length)
SELECT venue_id, sport, slot_minutes, slot_minutes, slot_minutes FROM sport_rules WHERE slot_minutes IS NOT NULL;
INSERT INTO booking_policies (court_id, min_length, max_length)
SELECT id, round(min_hours * 60), round(max_hours * 60) FROM courts WHERE min_hours IS NOT NULL OR max_hours IS NOT NULL;

-- ------------------------------------------------------------ passes

-- A pass spends entries (one per visit, or one per so many minutes or part)
-- or minutes of time credit. Passes already sold keep their rule: an entry
-- per hour or part.
ALTER TABLE passes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'time'));
-- Session passes: minutes one entry covers (NULL: a whole booking, any length).
ALTER TABLE passes ADD COLUMN IF NOT EXISTS entry_minutes INTEGER CHECK (entry_minutes IS NULL OR entry_minutes BETWEEN 1 AND 1440);
-- The longest booking it may pay for; NULL: any.
ALTER TABLE passes ADD COLUMN IF NOT EXISTS max_minutes INTEGER CHECK (max_minutes IS NULL OR max_minutes BETWEEN 1 AND 1440);
UPDATE passes SET entry_minutes = 60 WHERE kind = 'session';

-- ------------------------------------------------------------ zones

-- Each venue's zone as the app works it out (from its setting or its pin,
-- lib/zones.ts), written by the step that runs after this migration, for
-- 0090 to turn local times into moments. Dropped there.
CREATE TABLE IF NOT EXISTS migration_venue_zones (
  venue_id INTEGER PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  zone TEXT NOT NULL
);
