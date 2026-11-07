-- A customer's cancellation of a booking paid at the counter is an obligation to hand money back, like the venue's own cancellations
-- (hardening round, brief REFUND; ADR 0074; docs/features/payments-and-credit.md#owed-back-after-a-customer-cancels).
--
-- Until now only staff's and the venue's cancellations wrote a row on the list of counter money owed back (`counter_refunds_owed`, 0258):
-- a customer's own cancellation wrote the credit note (the tax document) and nothing told an employee to give the money back. The list
-- is extended, not duplicated: two new causes, and a way to tell the rows apart.
--
--   * `customer_cancelled`: the customer cancelled a booking paid at the counter (the whole booking, a week of a series, a class place,
--     a place taken off by closing their account). One row per booking cancelled, as for the venue's causes (the cancellation index of 0325).
--   * `place_withdrawn`: the customer took one person off a booking paid at the counter (lib/place-withdrawals.ts). A booking can lose
--     several people and then be cancelled, so this is one row per withdrawal (`withdrawal_id`), beside the booking's own cancellation row.
--
-- Nothing already written changes. Past customer cancellations are NOT turned into tasks here (nobody can say whether the money was
-- handed over at the time): scripts/reconcile-counter-cancellations.sql lists them, read only, for a manager to review.
ALTER TABLE counter_refunds_owed
  ADD COLUMN IF NOT EXISTS withdrawal_id INTEGER REFERENCES place_withdrawals(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- One per cancellation (no move, no withdrawal behind it), one per move, one per withdrawal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_refunds_owed_cancel_only ON counter_refunds_owed (booking_id) WHERE move_refund_id IS NULL AND withdrawal_id IS NULL;
DROP INDEX IF EXISTS idx_counter_refunds_owed_cancel;
CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_refunds_owed_withdrawal ON counter_refunds_owed (withdrawal_id) WHERE withdrawal_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'counter_refunds_owed'::regclass AND conname = 'counter_refunds_owed_cause_check') THEN
    ALTER TABLE counter_refunds_owed DROP CONSTRAINT counter_refunds_owed_cause_check;
  END IF;
  ALTER TABLE counter_refunds_owed
    ADD CONSTRAINT counter_refunds_owed_cause_check
    CHECK (cause IN ('closure', 'outage', 'rain', 'api', 'class', 'test', 'lesson_moved', 'moved_cheaper', 'customer_cancelled', 'place_withdrawn')) NOT VALID;
  ALTER TABLE counter_refunds_owed VALIDATE CONSTRAINT counter_refunds_owed_cause_check;
  -- A withdrawal's row is for a withdrawal, a move's for a move, and no row is for both.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'counter_refunds_owed'::regclass AND conname = 'counter_refunds_owed_one_origin') THEN
    ALTER TABLE counter_refunds_owed ADD CONSTRAINT counter_refunds_owed_one_origin CHECK (num_nonnulls(move_refund_id, withdrawal_id) <= 1) NOT VALID;
    ALTER TABLE counter_refunds_owed VALIDATE CONSTRAINT counter_refunds_owed_one_origin;
  END IF;
END $$;
