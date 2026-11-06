-- The staff activity log (staff_actions) is read by venue. A change at business level (a business manager invited, removed,
-- given another address or role) has no venue, so the business's own managers could not see it; only the platform owner
-- could. An entry with no venue can now name the business it is about, and the business's managers read those
-- (lib/activity.ts `listActivity`; ADR 0057). Nullable: every earlier entry stays as it is.
ALTER TABLE staff_actions ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_staff_actions_business ON staff_actions (business_id, created_at) WHERE business_id IS NOT NULL;
