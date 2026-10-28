-- A dearer coach's difference paid online (lib/lesson-coaches.ts, lib/payments.ts;
-- docs/features/programmes.md#giving-a-lesson-to-another-coach; owner's
-- decision of 28 October 2026).
--
-- The difference a paid lesson owes after a manager gave it to a dearer coach
-- and adjusted the price (`lesson_coach_changes.owed`, migration 0188) may be
-- paid on the venue's payment page as well as at the counter. Each page opened
-- for it is an attempt of its own, numbered on the change; a change is paid by
-- one payment at most, whichever way: the counter's (`owed_paid_via` a counter
-- method) or one online payment (`owed_payment_id`). A second payment, one made
-- on a page the counter closed, or one that arrives after the lesson was
-- cancelled or went to another coach again, is owed back on that payment
-- (`online_payments.refund_due`), never receipted or counted.

ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS coach_change_id INTEGER REFERENCES lesson_coach_changes(id) ON DELETE SET NULL;
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS coach_attempt INTEGER;
-- One page per attempt: two customers' clicks at once cannot both open one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_online_payments_coach_attempt
  ON online_payments (coach_change_id, coach_attempt) WHERE coach_change_id IS NOT NULL;
ALTER TABLE online_payments DROP CONSTRAINT IF EXISTS online_payments_purpose_check;
ALTER TABLE online_payments ADD CONSTRAINT online_payments_purpose_check
  CHECK (purpose IN ('booking', 'invoice', 'share', 'entry', 'league', 'pack', 'topup', 'membership', 'voucher', 'split', 'coach'));

-- How many pages have been opened for the difference, and until when the
-- latest counts as open: the counter does not take the difference while it is,
-- unless staff close it first (`owed_page_until` set to now).
ALTER TABLE lesson_coach_changes ADD COLUMN IF NOT EXISTS owed_pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lesson_coach_changes ADD COLUMN IF NOT EXISTS owed_page_until TIMESTAMPTZ;
-- The online payment that paid the difference ('online' in `owed_paid_via`); its receipt is `lesson-coach:<id>`.
ALTER TABLE lesson_coach_changes ADD COLUMN IF NOT EXISTS owed_payment_id INTEGER REFERENCES online_payments(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_coach_changes_owed_payment
  ON lesson_coach_changes (owed_payment_id) WHERE owed_payment_id IS NOT NULL;
-- Why a difference is no longer owed: 'cancelled' (the lesson), or 'superseded'
-- (the lesson went to another coach again, and the new change's terms count it).
ALTER TABLE lesson_coach_changes ADD COLUMN IF NOT EXISTS owed_cleared_why TEXT
  CHECK (owed_cleared_why IS NULL OR owed_cleared_why IN ('cancelled', 'superseded'));
