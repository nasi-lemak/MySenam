-- Who owns an API key or a webhook address (ADR 0064, audit A13): a person's, which stops when that person no longer manages the venue,
-- or the venue's own, which keeps working when whoever made it leaves. Authority is re-read on every use (lib/credential-owners.ts), so
-- ending a person's access ends what they own at once, with nothing to sweep.
--
-- `ownership`:      'person' (stops when `owner_admin_id` is no longer a manager here) or 'venue' (the venue's integration).
-- `owner_admin_id`: the account that owns a 'person' credential. Set null if the account is deleted, which, for a person's credential,
--                   means it has no owner and does not work.
-- `admin_id`:       who made it (webhooks gain it here; keys already had it): shown as "made by", never an owner by itself.
-- `*_reason`:       why one was stopped by the system, for the list the managers read.
--
-- Rows from before this migration are the venue's ('venue'), the default: an integration already in use keeps working (the people who
-- made them are not known to be the right owners, and a venue's website or door system should not stop at the next staff change), and
-- the managers' list shows who made each so it can be reviewed, handed to a person, or rotated.
ALTER TABLE venue_api_keys ADD COLUMN IF NOT EXISTS ownership TEXT NOT NULL DEFAULT 'venue';
ALTER TABLE venue_api_keys ADD COLUMN IF NOT EXISTS owner_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE venue_api_keys ADD COLUMN IF NOT EXISTS revoked_reason TEXT;
ALTER TABLE venue_api_keys DROP CONSTRAINT IF EXISTS venue_api_keys_ownership_check;
ALTER TABLE venue_api_keys ADD CONSTRAINT venue_api_keys_ownership_check CHECK (ownership IN ('venue', 'person')) NOT VALID;
ALTER TABLE venue_api_keys VALIDATE CONSTRAINT venue_api_keys_ownership_check;

ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS ownership TEXT NOT NULL DEFAULT 'venue';
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS owner_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS stopped_reason TEXT;
ALTER TABLE webhook_endpoints DROP CONSTRAINT IF EXISTS webhook_endpoints_ownership_check;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_ownership_check CHECK (ownership IN ('venue', 'person')) NOT VALID;
ALTER TABLE webhook_endpoints VALIDATE CONSTRAINT webhook_endpoints_ownership_check;

CREATE INDEX IF NOT EXISTS venue_api_keys_owner ON venue_api_keys (owner_admin_id) WHERE owner_admin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_endpoints_owner ON webhook_endpoints (owner_admin_id) WHERE owner_admin_id IS NOT NULL;
