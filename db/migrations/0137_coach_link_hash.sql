-- A coach's private link (lib/coach-schedule.ts) kept as a hash, with an
-- expiry: the link itself is shown once, when made, and a copy of the
-- database cannot be used to open it. Links already given keep working until
-- their new expiry, a year from now; the plain tokens are removed.
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS link_hash TEXT;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS link_expires_at TIMESTAMPTZ;
UPDATE coaches
   SET link_hash = encode(sha256(convert_to(calendar_token, 'UTF8')), 'hex'),
       link_expires_at = now() + interval '365 days'
 WHERE calendar_token IS NOT NULL;
UPDATE coaches SET calendar_token = NULL WHERE calendar_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS coaches_link_hash ON coaches (link_hash) WHERE link_hash IS NOT NULL;
