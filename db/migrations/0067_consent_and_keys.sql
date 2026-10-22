-- Marketing email only once the address has said yes itself: a box ticked
-- for somebody else's address, or for one that had unsubscribed, waits for
-- that address to confirm from the email it is sent. Agreements made before
-- this stand as they were.
ALTER TABLE marketing_consents ADD COLUMN IF NOT EXISTS confirmed_at TEXT;
UPDATE marketing_consents SET confirmed_at = consented_at WHERE confirmed_at IS NULL;

-- API keys that read availability and the venue only, for a website or a
-- widget: no customer's name or number behind them.
ALTER TABLE venue_api_keys DROP CONSTRAINT IF EXISTS venue_api_keys_scope_check;
ALTER TABLE venue_api_keys ADD CONSTRAINT venue_api_keys_scope_check CHECK (scope IN ('availability', 'read', 'write'));
