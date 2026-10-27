-- A league result is changed only as the one who changes it saw it
-- (lib/leagues.ts; docs/features/tournaments.md#box-leagues).
--
-- Reporting, confirming, disputing, and staff deciding, voiding or clearing a
-- league match each read the match and then wrote it by id: a correction
-- racing a confirmation, or a staff decision, could turn a settled result
-- back to reported, and a confirmation confirmed whatever score was there by
-- then, not the one the player saw. Each is now one transaction that locks
-- the match's row and writes only if the status and this version are still
-- what was read; a player confirming or disputing names the version they
-- saw, and a stale one is refused ("the result changed").
--
-- The version goes up by itself whenever the status, score, winner or
-- reporter changes, by whatever path (a player, staff, a walkover on
-- leaving, the end of a season, a result standing unanswered), so no path
-- can forget it.

ALTER TABLE league_matches ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION league_matches_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.score IS DISTINCT FROM OLD.score
     OR NEW.winner IS DISTINCT FROM OLD.winner OR NEW.reported_by IS DISTINCT FROM OLD.reported_by THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_league_matches_version ON league_matches;
CREATE TRIGGER trg_league_matches_version BEFORE UPDATE ON league_matches
  FOR EACH ROW EXECUTE FUNCTION league_matches_version();
