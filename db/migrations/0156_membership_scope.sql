-- Memberships by the scope of what they give (ADR 0025; lib/entitlements.ts;
-- docs/features/pricing.md#memberships-and-member-rates).
--
-- A membership was held against a phone number and priced a booking its
-- holder took part in. Three things are now said explicitly:
--
-- * Whose it is. The number's holder themself (`customer`, every membership
--   so far, which keeps meaning exactly what it did), or a participant the
--   holder acts for (`participant`: a child's own swim-club membership,
--   sold on the guardian's number). A participant's membership is theirs
--   alone: it never gives the number's holder a member's price, window or
--   entry, and the holder's never covers the participant.
-- * Whom else it covers. A family membership names the dependants it covers
--   (`membership_participants`): each counts as a member for their own place
--   where a session asks for one, and for the member's price.
-- * What its price covers. A plan's benefit is for the booking its member
--   takes part in (`booking`, every plan so far: a member reserves a whole
--   court at the member's price whoever plays) or for the members' own places
--   only (`participant`: on a session priced by the place, the member's place
--   at the member's price and everybody else's at the public one).

ALTER TABLE memberships ADD COLUMN IF NOT EXISTS holder_kind TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_holder_kind;
ALTER TABLE memberships ADD CONSTRAINT memberships_holder_kind CHECK (holder_kind IN ('customer', 'participant'));
-- A participant's record erased leaves their membership covering nobody, never the number's holder.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS holder_participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_holder_participant;
ALTER TABLE memberships ADD CONSTRAINT memberships_holder_participant CHECK (holder_kind = 'participant' OR holder_participant_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_memberships_holder_participant ON memberships (holder_participant_id) WHERE holder_participant_id IS NOT NULL;

-- The dependants a family membership covers, named when it is sold: never
-- inferred from a shared number or surname.
CREATE TABLE IF NOT EXISTS membership_participants (
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  added_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_membership_participants_participant ON membership_participants (participant_id);

ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'booking';
ALTER TABLE membership_plans DROP CONSTRAINT IF EXISTS membership_plans_scope;
ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_scope CHECK (scope IN ('booking', 'participant'));
UPDATE membership_plans SET scope = 'booking' WHERE scope IS DISTINCT FROM 'booking';
