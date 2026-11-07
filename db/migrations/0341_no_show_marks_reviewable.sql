-- A host's no-show mark is reviewable and correctable (hardening, DEC-50, ADR 0072; lib/no-show-marks.ts).
--
-- A mark was `open_game_players.no_show = 1` and nothing else: no reason, no notice, no way to answer it, no venue, no review, and
-- three of them in 90 days shut the player out of every open game on the platform. Each mark now carries the facts a review needs, on
-- the same row (no new table):
--
--   no_show_status   in_force (counts), disputed (the player answered it; does not count until reviewed), upheld (a reviewer kept
--                    it; counts), reversed (a reviewer took it back), withdrawn (the host took it back). NULL: no mark.
--   no_show_scope    venue (counts only at the venue of the game), platform (counts at every venue: only the platform owner sets it,
--                    with a written justification), legacy_platform (a mark from before scopes whose venue cannot be found: counts
--                    everywhere until the platform owner reviews it).
--   no_show_venue_id the venue of the game.
--   the host's reason, when it was made, the player's answer, and who reviewed it, when and why.
--
-- `no_show` stays 1 while a mark exists and is not taken back (so every reader of the old flag still reads a mark as one) and is set
-- to 0 when it is reversed or withdrawn; the row, its reason and its history stay.
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_status TEXT;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_scope TEXT;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_venue_id INTEGER REFERENCES venues(id) ON DELETE SET NULL;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_reason TEXT;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_at TEXT;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_dispute_note TEXT;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_disputed_at TEXT;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_reviewed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_reviewed_at TEXT;
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_review_note TEXT;
-- The platform owner's written justification for a mark that counts at every venue.
ALTER TABLE open_game_players ADD COLUMN IF NOT EXISTS no_show_platform_note TEXT;

ALTER TABLE open_game_players DROP CONSTRAINT IF EXISTS open_game_players_no_show_status_check;
ALTER TABLE open_game_players ADD CONSTRAINT open_game_players_no_show_status_check
  CHECK (no_show_status IS NULL OR no_show_status IN ('in_force', 'disputed', 'upheld', 'reversed', 'withdrawn')) NOT VALID;
ALTER TABLE open_game_players DROP CONSTRAINT IF EXISTS open_game_players_no_show_scope_check;
ALTER TABLE open_game_players ADD CONSTRAINT open_game_players_no_show_scope_check
  CHECK (no_show_scope IS NULL OR no_show_scope IN ('venue', 'platform', 'legacy_platform')) NOT VALID;
ALTER TABLE open_game_players VALIDATE CONSTRAINT open_game_players_no_show_status_check;
ALTER TABLE open_game_players VALIDATE CONSTRAINT open_game_players_no_show_scope_check;

-- Marks already in force stay in force. Each is scoped to the venue of its game, which is always known for a game that still has its
-- booking; one whose venue cannot be found is flagged `legacy_platform`, counted everywhere as before, and left for the platform owner
-- to review. The time, the host's reason and the host are not known for a past mark and are left empty, never made up: a reviewer
-- sees "recorded before reasons were kept".
UPDATE open_game_players p
   SET no_show_status = 'in_force', no_show_scope = 'venue', no_show_venue_id = c.venue_id
  FROM open_games g
  JOIN bookings b ON b.id = g.booking_id
  JOIN courts c ON c.id = b.court_id
 WHERE g.id = p.game_id AND p.no_show = 1 AND p.no_show_status IS NULL AND c.venue_id IS NOT NULL;
UPDATE open_game_players
   SET no_show_status = 'in_force', no_show_scope = 'legacy_platform'
 WHERE no_show = 1 AND no_show_status IS NULL;

-- Reviews waiting, and a host's reversed marks, are looked up by status.
CREATE INDEX IF NOT EXISTS idx_open_game_players_no_show ON open_game_players (no_show_venue_id, no_show_status) WHERE no_show_status IS NOT NULL;
