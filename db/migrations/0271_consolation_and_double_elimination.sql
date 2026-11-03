-- Consolation draws and double elimination (docs/architecture/decisions/0032-consolation-draws-and-double-elimination.md).
--
-- A match's bracket: 'winners', 'losers' and 'grand' (double elimination) or 'consolation' (a knockout's first-round
-- losers). NULL is the ordinary knockout. Its round and position count within its bracket; the routes the winner and the
-- loser take (next_match_id / loser_next_match_id) are the ones the third-place match already used, so they are not new.
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS bracket TEXT;
ALTER TABLE tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_bracket_check;
ALTER TABLE tournament_matches ADD CONSTRAINT tournament_matches_bracket_check
  CHECK (bracket IS NULL OR bracket IN ('winners', 'losers', 'grand', 'consolation'));

-- The order a draw was made in (entry ids, seeds first and then those drawn by lot): the draw is a pure function of it, so it
-- can be reproduced. Null on tournaments drawn before.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS draw_order TEXT;

-- Formats: double elimination joins the four. A consolation draw is a rule of a knockout (tournaments.rules), not a format.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'tournaments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%round_robin%'
  LOOP
    EXECUTE format('ALTER TABLE tournaments DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'competition_templates'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%round_robin%'
  LOOP
    EXECUTE format('ALTER TABLE competition_templates DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_format_check
  CHECK (format IN ('knockout', 'groups', 'round_robin', 'performance', 'double_elimination'));
ALTER TABLE competition_templates ADD CONSTRAINT competition_templates_format_check
  CHECK (format IN ('knockout', 'groups', 'round_robin', 'performance', 'double_elimination'));
