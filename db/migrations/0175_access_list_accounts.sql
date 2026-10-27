-- A members-only or private venue's list, by account.
--
-- A phone number is not identity (docs/architecture/privacy.md). Online, an
-- entry on the list counts only for the account staff linked it to (or a
-- resident linked their guest to, by the guest's account email), or for an
-- account that has proved the entry's number with a code. A number typed on
-- an account no longer lets it in. At the counter staff still act on their
-- word.
--
-- Existing entries are left unlinked: an account that has proved the number
-- keeps getting in; one that only typed it does not, until staff link it.
-- Erasing the account unlinks the entry and leaves it on the list.
ALTER TABLE venue_access_list ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- Who linked it, and when: a member of staff, or (linked_by NULL, invited_by
-- set) the resident who invited the guest.
ALTER TABLE venue_access_list ADD COLUMN IF NOT EXISTS linked_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE venue_access_list ADD COLUMN IF NOT EXISTS linked_at TEXT;
CREATE INDEX IF NOT EXISTS idx_venue_access_user ON venue_access_list (user_id) WHERE user_id IS NOT NULL;
