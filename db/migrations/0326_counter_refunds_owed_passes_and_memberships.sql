-- Money handed back at the counter, one list (hardening round, brief MONEY: C11, D1; docs/features/payments-and-credit.md#owed-back-after-the-venue-cancels,
-- ADR 0068).
--
-- `counter_fee_refunds_owed` (migration 0304) is the list of counter money owed back that is not a booking's: a tournament entry fee the venue
-- calls off. A counter-sold pass or membership whose unused part a manager hands back is the same thing: a credit note says the sale was reversed
-- (that is the tax document, and it counts in the till at once, as before), but a credit note is not cash paid: somebody has to hand the money back,
-- and the till has to show who and when. So such a refund is written here too, one row per credit note, open until a named member of staff says it was
-- handed back (then it is in that day's list of money handed back at the counter, as a booking's payout is).
--
-- Nothing already written changes: a row is still one entry's, and what was voided or credited before this migration is not turned into a task (nobody
-- can say whether the money was handed over; a credit note stands as it always did).
ALTER TABLE counter_fee_refunds_owed ALTER COLUMN tournament_entry_id DROP NOT NULL;
ALTER TABLE counter_fee_refunds_owed ADD COLUMN IF NOT EXISTS pass_id INTEGER REFERENCES passes(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE counter_fee_refunds_owed ADD COLUMN IF NOT EXISTS membership_id INTEGER REFERENCES memberships(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

DO $$
BEGIN
  -- Why it is owed: the two a tournament gives, and a pass's or a membership's refund.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'counter_fee_refunds_owed'::regclass AND conname = 'counter_fee_refunds_owed_cause_check') THEN
    ALTER TABLE counter_fee_refunds_owed DROP CONSTRAINT counter_fee_refunds_owed_cause_check;
  END IF;
  ALTER TABLE counter_fee_refunds_owed
    ADD CONSTRAINT counter_fee_refunds_owed_cause_check CHECK (cause IN ('tournament_cancelled', 'before_draw', 'pass_refunded', 'membership_refunded')) NOT VALID;
  ALTER TABLE counter_fee_refunds_owed VALIDATE CONSTRAINT counter_fee_refunds_owed_cause_check;

  -- Each row is for exactly one thing: an entry, a pass or a membership.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'counter_fee_refunds_owed'::regclass AND conname = 'counter_fee_refunds_owed_one_subject') THEN
    ALTER TABLE counter_fee_refunds_owed
      ADD CONSTRAINT counter_fee_refunds_owed_one_subject CHECK (num_nonnulls(tournament_entry_id, pass_id, membership_id) = 1) NOT VALID;
    ALTER TABLE counter_fee_refunds_owed VALIDATE CONSTRAINT counter_fee_refunds_owed_one_subject;
  END IF;
END $$;

-- A credit note for a pass or a membership is written when it is voided (an entry's, when it is settled), so it is owed once: one row per note.
CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_fee_refunds_owed_note ON counter_fee_refunds_owed (credit_note_id) WHERE credit_note_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_counter_fee_refunds_owed_settled ON counter_fee_refunds_owed (venue_id, settled_at) WHERE settled_at IS NOT NULL;
