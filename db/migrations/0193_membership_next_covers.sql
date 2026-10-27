-- Whom a family membership that renews by itself should cover from its next
-- term, where the account that bought it chose a different list for then
-- (docs/features/pricing.md#changing-whom-a-family-membership-covers;
-- lib/membership-purchases.ts). `next_covers_at` NULL: the next term names
-- whom this one covers when the charge comes in, as before.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS next_covers_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS membership_next_covers (
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  PRIMARY KEY (membership_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_membership_next_covers_participant ON membership_next_covers (participant_id);
