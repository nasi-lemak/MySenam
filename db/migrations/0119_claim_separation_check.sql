-- Minimum separation between claims on a space, enforced by the database
-- (docs/architecture/booking-time-model.md#buffers-separation-and-operational-time).
--
-- The exclusion constraint claims_no_overlap refuses two claims whose
-- `occupied` (their time and operational time) overlap on a space: that part
-- adds up. Separation does not: two neighbours on a space need, between the
-- end of one's time and the start of the other's, at least the larger of the
-- earlier one's separation after and the later one's separation before.
--
-- That is the same as: no claim's time overlaps the separation another keeps
-- before or after it (the gap is short of the larger exactly when it is short
-- of one of them), while separations may overlap each other freely. So each
-- claim on a space is written here as its time (role [0,0]) and, where it
-- keeps any, the separation before and after it (role [1,1]), and one
-- exclusion constraint refuses a time and a separation that overlap on the
-- same space: `role WITH -|-` (adjacent ranges: [0,0] beside [1,1]) is true
-- only between a time and a separation, never two times (claims_no_overlap's
-- business) or two separations (which do not add up).
--
-- A constraint rather than a trigger that reads: it raises 23P01 (what every
-- path turns into "taken") whatever writes the claim, waits on a concurrent
-- writer's uncommitted row as claims_no_overlap does, and takes no predicate
-- locks, so serializable checking does not make independent bookings retry.
--
-- The rows are kept in step with `claims` by triggers, so no path writes a
-- claim without them. No foreign key: its check would read the claims index
-- under serializable checking for every booking; a claim deleted takes its
-- rows with it by trigger instead.
--
-- Shared facilities (claims with places) have none: their places are not told
-- apart, so there are no neighbours to compare; their claims hold their
-- separation as places, inside `occupied`, under claims_capacity.
CREATE TABLE IF NOT EXISTS claim_gaps (
  claim_id BIGINT NOT NULL,
  space_id INTEGER NOT NULL,
  -- [0,0]: the claim's time (`during`); [1,1]: the separation it keeps before or after it.
  role INT4RANGE NOT NULL CHECK (role IN ('[0,0]'::int4range, '[1,1]'::int4range)),
  zone TSTZRANGE NOT NULL CHECK (NOT isempty(zone)),
  active BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_gaps_claim ON claim_gaps (claim_id);
ALTER TABLE claim_gaps ADD CONSTRAINT claim_gaps_apart
  EXCLUDE USING gist (int4range(space_id, space_id, '[]') WITH &&, role WITH -|-, zone WITH &&)
  WHERE (active)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION claim_gaps_write(c claims) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF c.space_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO claim_gaps (claim_id, space_id, role, zone, active) VALUES (c.id, c.space_id, '[0,0]', c.during, c.active);
  IF c.separation_before > 0 THEN
    INSERT INTO claim_gaps (claim_id, space_id, role, zone, active)
    VALUES (c.id, c.space_id, '[1,1]', tstzrange(lower(c.during) - make_interval(mins => c.separation_before), lower(c.during)), c.active);
  END IF;
  IF c.separation_after > 0 AND NOT upper_inf(c.during) THEN
    INSERT INTO claim_gaps (claim_id, space_id, role, zone, active)
    VALUES (c.id, c.space_id, '[1,1]', tstzrange(upper(c.during), upper(c.during) + make_interval(mins => c.separation_after)), c.active);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION claim_gaps_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM claim_gaps_write(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM claim_gaps WHERE claim_id = OLD.id;
  ELSIF NEW.space_id IS NOT DISTINCT FROM OLD.space_id AND NEW.during = OLD.during
        AND NEW.separation_before = OLD.separation_before AND NEW.separation_after = OLD.separation_after THEN
    -- Released, or taken up again: the same rows, on or off.
    IF NEW.active IS DISTINCT FROM OLD.active THEN
      UPDATE claim_gaps SET active = NEW.active WHERE claim_id = NEW.id;
    END IF;
  ELSE
    DELETE FROM claim_gaps WHERE claim_id = OLD.id;
    PERFORM claim_gaps_write(NEW);
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS claims_gaps ON claims;
CREATE TRIGGER claims_gaps AFTER INSERT OR DELETE OR UPDATE OF space_id, during, separation_before, separation_after, active ON claims
  FOR EACH ROW EXECUTE FUNCTION claim_gaps_sync();

-- Every claim already on a space gets its time; none keeps a separation yet
-- (0118 gave them 0), so nothing here can conflict: two times are never
-- compared by this constraint.
INSERT INTO claim_gaps (claim_id, space_id, role, zone, active)
SELECT id, space_id, '[0,0]', during, active FROM claims WHERE space_id IS NOT NULL;
