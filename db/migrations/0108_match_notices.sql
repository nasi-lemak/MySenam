-- When suggested games were last looked for on a player's behalf, found or
-- not, so the scheduler works through everybody who asked for them in turn
-- rather than the same few each time (lib/matchmaking.ts, sendMatchNotices).
ALTER TABLE player_profiles ADD COLUMN IF NOT EXISTS matches_checked_at TEXT;
CREATE INDEX IF NOT EXISTS idx_player_profiles_notify ON player_profiles(matches_checked_at) WHERE notify_matches <> 'none';
