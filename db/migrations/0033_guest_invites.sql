-- Residents (and members) on a venue's list inviting their own guests.
-- How many guests each may have on the list at once (0: staff add guests),
-- and for how many days at most.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS guest_invites INTEGER NOT NULL DEFAULT 0;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS guest_invite_days INTEGER NOT NULL DEFAULT 3;

-- The resident who invited this guest. Removing them removes their guests.
ALTER TABLE venue_access_list ADD COLUMN IF NOT EXISTS invited_by INTEGER REFERENCES venue_access_list(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_venue_access_invited_by ON venue_access_list (invited_by);
