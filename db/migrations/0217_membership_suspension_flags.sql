-- A suspension's bookings flagged for staff, and admissions past one at the
-- desk (lib/membership-suspensions.ts, lib/membership-flags.ts;
-- docs/features/pricing.md#suspending-a-membership).
--
-- Bookings already made for dates in a suspension are never cancelled or
-- refunded: like a cancelled membership's, they are flagged for staff
-- (reason 'suspended'), with the suspension that flagged them. Each
-- suspension flags a booking once per person; another suspension of the same
-- membership later flags it again, so the unique index takes the suspension
-- in. Flags of every other reason (no suspension) are unique as before.
ALTER TABLE membership_booking_flags DROP CONSTRAINT IF EXISTS membership_booking_flags_reason_check;
ALTER TABLE membership_booking_flags ADD CONSTRAINT membership_booking_flags_reason_check
  CHECK (reason IN ('cancelled', 'revoked', 'uncovered', 'suspended'));
ALTER TABLE membership_booking_flags ADD COLUMN IF NOT EXISTS suspension_id INTEGER REFERENCES membership_suspensions(id) ON DELETE SET NULL;
DROP INDEX IF EXISTS uq_membership_booking_flags;
CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_booking_flags_by_suspension
  ON membership_booking_flags (membership_id, booking_id, COALESCE(participant_id, 0), COALESCE(suspension_id, 0));

-- Admitted at the desk although the membership was suspended on the day: kept as 'suspended'.
ALTER TABLE membership_admissions DROP CONSTRAINT IF EXISTS membership_admissions_lapse_check;
ALTER TABLE membership_admissions ADD CONSTRAINT membership_admissions_lapse_check
  CHECK (lapse IN ('ended', 'cancelled', 'none', 'suspended'));
