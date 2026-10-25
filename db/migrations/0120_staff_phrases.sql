-- Text MySenam composes and stores, kept also as a phrase with its values
-- (lib/staff-text.ts), so staff screens say it in the staff language. The
-- English beside it stays as written; rows from before have no phrase and
-- show their English.

-- An alert's subject, and its detail's lines where MySenam wrote them.
ALTER TABLE system_alerts ADD COLUMN IF NOT EXISTS said TEXT;

-- A stored-credit line's reason, where MySenam wrote it ("Booking ABC123");
-- what staff typed at the counter has none.
ALTER TABLE wallet_entries ADD COLUMN IF NOT EXISTS reason_phrase TEXT;

-- An urgent notice's line on the staff's list ("… cancelled booking …").
ALTER TABLE urgent_notices ADD COLUMN IF NOT EXISTS summary_phrase TEXT;

-- What a tournament correction, or resolving a wrong progression, changed:
-- the phrases beside the sentences in `changes`. (A progression issue's
-- affected matches keep theirs inside its own JSON.)
ALTER TABLE tournament_corrections ADD COLUMN IF NOT EXISTS change_phrases TEXT;
