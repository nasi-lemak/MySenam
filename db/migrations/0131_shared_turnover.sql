-- How a shared facility is turned over between bookings
-- (docs/architecture/booking-time-model.md#shared-facilities-how-they-are-turned-over).
--
-- A booking policy may now say, for resources with places (a gym floor, a
-- climbing area, a fleet of kayaks), what its setup, cleaning and minimum gap
-- apply to:
--   'place'    each place a booking takes, held as places for its setup or
--              cleaning and its gap added together (what every claim with
--              places did before; the default, so nothing becomes more
--              sellable unless a venue says so);
--   'unit'     each place a booking takes, held as places for the longer of
--              its setup or cleaning and its gap on each side, not their sum;
--   'facility' the whole facility: kept clear of everybody between sessions,
--              by the rule of a court of one place (gaps shared, the larger
--              counts; setup and cleaning add up), while bookings in the same
--              session share its places.
-- Unset on every level, so inherited as 'place'. Courts of one place ignore it.
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS turnover TEXT CHECK (turnover IN ('place', 'unit', 'facility'));

-- A claim made under 'facility' holds places for its time only (`occupied`
-- is `during`); its buffer_before/after are then the setup and cleaning the
-- whole facility needs, and its separation_before/after the gap the whole
-- facility keeps, both enforced through facility_gaps below. Every claim made
-- before keeps false, and with it exactly what it holds as places.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS facility_wide BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE claims ADD CONSTRAINT claims_facility_wide_holds_places CHECK (NOT facility_wide OR (space_id IS NULL AND occupied = during));

-- What each claim on a shared facility keeps from the others across the
-- whole facility, as rows the database compares, as claim_gaps (0119) does
-- on a space. Places are still counted by claims_capacity, on `occupied`.
--
-- facility_gaps_clear (`side`): every claim with places is written as its
-- time ([0,0]); a facility-wide claim also as the time it keeps the whole
-- facility clear before and after it ([1,1]): its gap, its setup, its
-- cleaning, each from the edge of its time. A time and a zone kept clear may
-- not overlap (`-|-` is true only between [0,0] and [1,1]); two zones may
-- (gaps do not add up; two bookings ending together are cleaned once), and
-- two times are the capacity trigger's to count.
--
-- facility_gaps_work (`work`): setup and cleaning add up, as on a court of
-- one place, between one booking and the next. Roles, so that `-|-` holds
-- exactly between what follows what:
--   [0,0] before a per-place claim's time, what it holds as places there;
--   [1,1] after a facility-wide claim, its cleaning;
--   [2,2] before a facility-wide claim, its setup;
--   [3,3] after a per-place claim's time, what it holds as places there.
-- So the whole facility's cleaning refuses the next one's setup, or what a
-- per-place claim holds before its time; and what a per-place claim holds
-- after its time refuses the whole facility's setup. Two per-place claims are never
-- compared here (their places are a count), nor two cleanings or two setups.
-- What a per-place claim holds around its time is taken as setup and
-- cleaning, adding up, though some of it may be a gap: never closer than
-- either asks, and only where a facility mixes the two.
--
-- Constraints that read nothing, so they raise 23P01 whatever writes the
-- claim, wait on a concurrent writer's uncommitted row, and take no
-- serializable predicate locks. Rows kept in step with `claims` by trigger;
-- no foreign key (its check would read claims under serializable checking).
CREATE TABLE IF NOT EXISTS facility_gaps (
  claim_id BIGINT NOT NULL,
  court_id INTEGER NOT NULL,
  side INT4RANGE CHECK (side IS NULL OR side IN ('[0,0]'::int4range, '[1,1]'::int4range)),
  work INT4RANGE CHECK (work IS NULL OR work IN ('[0,0]'::int4range, '[1,1]'::int4range, '[2,2]'::int4range, '[3,3]'::int4range)),
  zone TSTZRANGE NOT NULL CHECK (NOT isempty(zone)),
  active BOOLEAN NOT NULL,
  -- A claim's time; a zone kept clear, its setup or cleaning marked; or what a per-place claim holds around its time.
  CHECK (
    (side = '[0,0]'::int4range AND work IS NULL)
    OR (side = '[1,1]'::int4range AND (work IS NULL OR work IN ('[1,1]'::int4range, '[2,2]'::int4range)))
    OR (side IS NULL AND work IN ('[0,0]'::int4range, '[3,3]'::int4range))
  )
);
CREATE INDEX IF NOT EXISTS idx_facility_gaps_claim ON facility_gaps (claim_id);
ALTER TABLE facility_gaps ADD CONSTRAINT facility_gaps_clear
  EXCLUDE USING gist (int4range(court_id, court_id, '[]') WITH &&, side WITH -|-, zone WITH &&)
  WHERE (active AND side IS NOT NULL)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facility_gaps ADD CONSTRAINT facility_gaps_work
  EXCLUDE USING gist (int4range(court_id, court_id, '[]') WITH &&, work WITH -|-, zone WITH &&)
  WHERE (active AND work IS NOT NULL)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION facility_gaps_write(c claims) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF c.space_id IS NOT NULL THEN
    RETURN;
  END IF;
  INSERT INTO facility_gaps (claim_id, court_id, side, work, zone, active) VALUES (c.id, c.court_id, '[0,0]', NULL, c.during, c.active);
  IF NOT c.facility_wide THEN
    -- What it holds as places around its time, taken as setup before and cleaning after.
    IF lower(c.occupied) < lower(c.during) THEN
      INSERT INTO facility_gaps (claim_id, court_id, side, work, zone, active)
      VALUES (c.id, c.court_id, NULL, '[0,0]', tstzrange(lower(c.occupied), lower(c.during)), c.active);
    END IF;
    IF NOT upper_inf(c.during) AND (upper_inf(c.occupied) OR upper(c.occupied) > upper(c.during)) THEN
      INSERT INTO facility_gaps (claim_id, court_id, side, work, zone, active)
      VALUES (c.id, c.court_id, NULL, '[3,3]', tstzrange(upper(c.during), upper(c.occupied)), c.active);
    END IF;
    RETURN;
  END IF;
  IF c.separation_before > 0 THEN
    INSERT INTO facility_gaps (claim_id, court_id, side, work, zone, active)
    VALUES (c.id, c.court_id, '[1,1]', NULL, tstzrange(lower(c.during) - make_interval(mins => c.separation_before), lower(c.during)), c.active);
  END IF;
  IF c.buffer_before > 0 THEN
    INSERT INTO facility_gaps (claim_id, court_id, side, work, zone, active)
    VALUES (c.id, c.court_id, '[1,1]', '[2,2]', tstzrange(lower(c.during) - make_interval(mins => c.buffer_before), lower(c.during)), c.active);
  END IF;
  IF NOT upper_inf(c.during) THEN
    IF c.separation_after > 0 THEN
      INSERT INTO facility_gaps (claim_id, court_id, side, work, zone, active)
      VALUES (c.id, c.court_id, '[1,1]', NULL, tstzrange(upper(c.during), upper(c.during) + make_interval(mins => c.separation_after)), c.active);
    END IF;
    IF c.buffer_after > 0 THEN
      INSERT INTO facility_gaps (claim_id, court_id, side, work, zone, active)
      VALUES (c.id, c.court_id, '[1,1]', '[1,1]', tstzrange(upper(c.during), upper(c.during) + make_interval(mins => c.buffer_after)), c.active);
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION facility_gaps_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM facility_gaps_write(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM facility_gaps WHERE claim_id = OLD.id;
  ELSIF NEW.court_id = OLD.court_id AND NEW.space_id IS NOT DISTINCT FROM OLD.space_id AND NEW.during = OLD.during
        AND NEW.occupied = OLD.occupied AND NEW.buffer_before = OLD.buffer_before AND NEW.buffer_after = OLD.buffer_after
        AND NEW.separation_before = OLD.separation_before AND NEW.separation_after = OLD.separation_after
        AND NEW.facility_wide = OLD.facility_wide THEN
    -- Released, or taken up again: the same rows, on or off.
    IF NEW.active IS DISTINCT FROM OLD.active THEN
      UPDATE facility_gaps SET active = NEW.active WHERE claim_id = NEW.id;
    END IF;
  ELSE
    DELETE FROM facility_gaps WHERE claim_id = OLD.id;
    PERFORM facility_gaps_write(NEW);
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS claims_facility_gaps ON claims;
CREATE TRIGGER claims_facility_gaps
  AFTER INSERT OR DELETE OR UPDATE OF court_id, space_id, during, occupied, buffer_before, buffer_after,
    separation_before, separation_after, facility_wide, active ON claims
  FOR EACH ROW EXECUTE FUNCTION facility_gaps_sync();

-- Every claim already on a shared facility is written as above. None is
-- facility-wide, so there is no [1,1] row for a time to meet, and the only
-- work rows are [0,0] and [3,3], which are never adjacent: nothing here can
-- conflict, and nothing stored changes.
SELECT facility_gaps_write(c) FROM claims c WHERE c.space_id IS NULL;
