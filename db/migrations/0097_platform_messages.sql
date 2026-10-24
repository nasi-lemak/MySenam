-- Emails that belong to no venue go through the outbox too: to people
-- applying to list a venue, password reset links, and alerts to the
-- platform's owners and a venue's staff (known limitations S11;
-- docs/integrations/messaging.md).
ALTER TABLE messages ALTER COLUMN venue_id DROP NOT NULL;

-- A message whose content stops being of use (a password reset link that has
-- run out) is not sent after this time: it is given up, with the reason.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TEXT;
