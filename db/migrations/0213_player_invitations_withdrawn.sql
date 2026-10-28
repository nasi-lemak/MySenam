-- An emailed invitation to an open game or a community group withdrawn
-- before it was accepted (lib/player-invitations.ts;
-- docs/features/matchmaking.md#invitations-links-and-private-games).
--
-- Withdrawing sets `cancelled_at`, as replacing one does, so accepting it
-- and the game's count of invitations waiting for an answer leave it out
-- without a change of their own, and says who withdrew it and when (the
-- host, the player who sent it, or the group's organiser). Set only on a row
-- still open, under the game's or the group's row lock that accepting takes,
-- so a withdrawal racing an acceptance is one or the other.
ALTER TABLE player_invitations ADD COLUMN IF NOT EXISTS revoked_at TEXT;
ALTER TABLE player_invitations ADD COLUMN IF NOT EXISTS revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
