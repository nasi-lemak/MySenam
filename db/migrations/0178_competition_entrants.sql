-- Who an entry or a league place is for, and who made it
-- (lib/competition-entrants.ts; docs/features/tournaments.md#who-enters-and-how).
--
-- An entry was always the account's own. Now it can also be:
--
-- - a participant a guardian enters from their account (ADR 0023): the
--   participant is the entrant (`participant_id`); the guardian's account
--   stays on it (`user_id`) as the one who acts for it — pays, withdraws,
--   reports results and is told;
-- - somebody staff enter at the counter, on the number and name they give
--   (as a counter booking): no account (`user_id` NULL), the number to reach
--   them (`contact_phone`) and who entered it (`entered_by_admin_id`, and the
--   name as it was), or a participant the venue knows with a guardian on
--   that number.
--
-- An entrant without an account of their own declares their gender at entry
-- where the event asks it (`entrant_gender`), as a partner's is; the account
-- holder's own is still read from their account. A number is a contact
-- detail, never proof that two entries are one person.

ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS entrant_gender TEXT CHECK (entrant_gender IN ('woman', 'man'));
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS entered_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS entered_by_name TEXT;

ALTER TABLE league_players ADD COLUMN IF NOT EXISTS participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL;
ALTER TABLE league_players ADD COLUMN IF NOT EXISTS entrant_gender TEXT CHECK (entrant_gender IN ('woman', 'man'));
ALTER TABLE league_players ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE league_players ADD COLUMN IF NOT EXISTS entered_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE league_players ADD COLUMN IF NOT EXISTS entered_by_name TEXT;

-- One live entry per account for itself, and one per participant, however
-- many people one guardian enters.
DROP INDEX IF EXISTS uq_tournament_entry_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_entry_user ON tournament_entries (tournament_id, user_id)
  WHERE user_id IS NOT NULL AND participant_id IS NULL AND status <> 'withdrawn';
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_entry_participant ON tournament_entries (tournament_id, participant_id)
  WHERE participant_id IS NOT NULL AND status <> 'withdrawn';

DROP INDEX IF EXISTS uq_league_player_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_league_player_user ON league_players (league_id, user_id)
  WHERE user_id IS NOT NULL AND participant_id IS NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_league_player_participant ON league_players (league_id, participant_id)
  WHERE participant_id IS NOT NULL AND status = 'active';
