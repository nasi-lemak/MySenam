-- Each tournament entry keeps the fee it was made at (lib/tournaments.ts
-- `enterAs`, `changeTournament`; docs/features/tournaments.md#changing-a-tournament).
--
-- Staff may change a tournament's entry fee before its draw, for entries made
-- from then on. What an entry owes, is paid online, and is receipted at the
-- counter is its own fee (lib/payments.ts `startEntryPayment`,
-- lib/documents.ts `entrySale`), so nothing already entered, paid or not, is
-- repriced. Entries made before this migration take their tournament's fee as
-- it stands, which is what they were made at: nothing could change it before.
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS fee NUMERIC(12,2) CHECK (fee IS NULL OR fee >= 0);
UPDATE tournament_entries e SET fee = t.entry_fee FROM tournaments t WHERE t.id = e.tournament_id AND e.fee IS NULL;
