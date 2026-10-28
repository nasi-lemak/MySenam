-- Removing a member of staff (audit R8 X1-14) must not depend on what they
-- did while they worked there. Six references from the first schema named the
-- account with no ON DELETE, so removing anybody who had recorded an
-- induction, sold a membership or pass, made a promo code, given credit at the
-- counter or decided a venue application failed. Every reference added since
-- keeps the record and forgets the account (ON DELETE SET NULL); these now do
-- the same. Who did it stays in the staff activity log, which keeps the name.
ALTER TABLE inductions DROP CONSTRAINT IF EXISTS inductions_admin_id_fkey;
ALTER TABLE inductions ADD CONSTRAINT inductions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_admin_id_fkey;
ALTER TABLE memberships ADD CONSTRAINT memberships_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE passes DROP CONSTRAINT IF EXISTS passes_admin_id_fkey;
ALTER TABLE passes ADD CONSTRAINT passes_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_admin_id_fkey;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_admin_id_fkey;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE venue_applications DROP CONSTRAINT IF EXISTS venue_applications_decided_by_fkey;
ALTER TABLE venue_applications ADD CONSTRAINT venue_applications_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES admins(id) ON DELETE SET NULL;
