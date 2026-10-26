-- Inductions belong to the person inducted (lib/participants.ts; ADR 0023;
-- docs/features/venue-operations.md#inductions).
--
-- An induction was one row per venue and phone number (0001): a child shown
-- round on a parent's number could only be filed as the parent, and a door
-- code was given on the booking's number, so a child rode on the parent's
-- induction and a sibling on either. Now an induction is either the number
-- holder's own (as every existing row stays) or a participant's, by their id.
-- A participant's keeps the number it was recorded on (the guardian's, to
-- reach them) as evidence, never as identity.

ALTER TABLE inductions ADD COLUMN IF NOT EXISTS participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL;
-- A participant's induction stays a participant's once their record is
-- erased: it then counts for nobody, never for the number it was recorded on.
ALTER TABLE inductions ADD COLUMN IF NOT EXISTS for_participant BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE inductions DROP CONSTRAINT IF EXISTS inductions_participant_only;
ALTER TABLE inductions ADD CONSTRAINT inductions_participant_only CHECK (for_participant OR participant_id IS NULL);
ALTER TABLE inductions DROP CONSTRAINT IF EXISTS inductions_venue_id_phone_key;
-- One own induction per number and venue, as before; one per participant and venue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inductions_own ON inductions (venue_id, phone) WHERE NOT for_participant;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inductions_participant ON inductions (venue_id, participant_id) WHERE participant_id IS NOT NULL;

-- An existing number-keyed induction whose number is that of an account that
-- manages somebody, under a name that is not the account holder's, may have
-- been somebody else in the family shown round. It stays the number holder's
-- (nothing is moved on matching contact details) and is flagged for the
-- venue's staff to look at: kept as it is, or given to a named participant
-- through the audited tool, with a reason, never automatically.
ALTER TABLE inductions ADD COLUMN IF NOT EXISTS review_reason TEXT;
ALTER TABLE inductions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE inductions ADD COLUMN IF NOT EXISTS reviewed_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE inductions ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT;
ALTER TABLE inductions ADD COLUMN IF NOT EXISTS review_note TEXT;
-- Where it was given to a participant: the number holder it was filed as, kept.
ALTER TABLE inductions ADD COLUMN IF NOT EXISTS assigned_from_name TEXT;

UPDATE inductions i SET review_reason = 'shared-number'
 WHERE NOT i.for_participant AND i.revoked_at IS NULL
   AND EXISTS (
     SELECT 1 FROM users u JOIN participant_guardians g ON g.user_id = u.id AND g.revoked_at IS NULL
      WHERE phone_key(u.phone) = phone_key(i.phone) AND lower(btrim(u.name)) <> lower(btrim(i.name)));
CREATE INDEX IF NOT EXISTS idx_inductions_review ON inductions (venue_id) WHERE review_reason IS NOT NULL AND reviewed_at IS NULL;
