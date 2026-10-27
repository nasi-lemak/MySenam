-- A resident's guest invited by email: an invitation, not a link.
--
-- A resident who gave a guest's email used to have the guest's entry linked
-- at once to the account holding that address, and was told when no account
-- held it: anybody on a venue's list could find out whether an address has a
-- MySenam account. Now the email address is sent a single-use link instead,
-- the same whether or not an account holds it (lib/guest-invites.ts;
-- docs/features/booking.md#residents-inviting-their-own-guests). Only the
-- account that signs in with that address and accepts it is linked to the
-- one guest entry it was made for.
--
-- Kept: hashes only. The token is a keyed hash (as a password reset's), the
-- address a keyed hash of its lower-case form, to check the accepting
-- account is the one it was sent to without keeping the address.
CREATE TABLE IF NOT EXISTS guest_invitations (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  -- The guest's entry it links, and only that one; the entry going voids it.
  entry_id INTEGER NOT NULL REFERENCES venue_access_list(id) ON DELETE CASCADE,
  -- The resident's own entry it was made under; the resident leaving voids it.
  host_entry_id INTEGER NOT NULL REFERENCES venue_access_list(id) ON DELETE CASCADE,
  invited_by_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email_hash TEXT NOT NULL,
  -- The last day it can be accepted: never after the guest's entry ends.
  expires_on TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Replaced by a newer invitation, or the guest taken over by another resident.
  cancelled_at TIMESTAMPTZ
);
-- One open invitation per guest: inviting again replaces it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_invitations_open ON guest_invitations (entry_id) WHERE used_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guest_invitations_host ON guest_invitations (host_entry_id);
