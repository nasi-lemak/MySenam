-- A resident's emailed guest invitation withdrawn before it was accepted
-- (lib/guest-invites.ts; docs/features/booking.md#residents-inviting-their-own-guests).
--
-- Withdrawing sets `cancelled_at`, as replacing one does, so every path that
-- redeems or counts an open invitation refuses it without a change of its
-- own, and says who withdrew it and when: the resident who sent it
-- (`revoked_by_user`), or the venue's manager (`revoked_by_admin`, with the
-- reason they gave, also kept in the activity log). Set only on a row still
-- open, under its row lock, so a withdrawal racing an acceptance is one or
-- the other.
ALTER TABLE guest_invitations ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE guest_invitations ADD COLUMN IF NOT EXISTS revoked_by_user INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE guest_invitations ADD COLUMN IF NOT EXISTS revoked_by_admin INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE guest_invitations ADD COLUMN IF NOT EXISTS revoke_reason TEXT;
-- The latest invitation for a guest entry, for the resident's and staff's lists.
CREATE INDEX IF NOT EXISTS idx_guest_invitations_entry ON guest_invitations (entry_id, id);
