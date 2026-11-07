-- Post-audit hardening (ADR 0067): a counter payment owed back after a paid booking was moved to a cheaper time is written on the
-- list of counter money owed back (`counter_refunds_owed`, 0258) beside what the venue's own cancellations leave, and settled from it
-- the same way (handed back the way it was paid, or as credit for an account), by whom and when kept here.
--
-- That list held one row per booking (a booking is cancelled once). A booking can be moved cheaper more than once, so the rule
-- becomes: one per booking for a cancellation, one per move for a move.
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS move_refund_id INTEGER REFERENCES booking_move_refunds(id) ON DELETE SET NULL;

ALTER TABLE counter_refunds_owed DROP CONSTRAINT IF EXISTS counter_refunds_owed_booking_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_refunds_owed_cancel ON counter_refunds_owed (booking_id) WHERE move_refund_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_refunds_owed_move ON counter_refunds_owed (move_refund_id) WHERE move_refund_id IS NOT NULL;

ALTER TABLE counter_refunds_owed DROP CONSTRAINT IF EXISTS counter_refunds_owed_cause_check;
ALTER TABLE counter_refunds_owed ADD CONSTRAINT counter_refunds_owed_cause_check
  CHECK (cause IN ('closure', 'outage', 'rain', 'api', 'class', 'test', 'lesson_moved', 'moved_cheaper'));
