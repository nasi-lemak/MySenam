-- A manager records what happened to the money of a customer's cancellation (or a person a customer took off) of a counter-paid booking from
-- before migration 0346, which wrote only its credit note (hardening round, brief HIST; ADR 0078; lib/historical-counter-refunds.ts;
-- docs/features/payments-and-credit.md#cancellations-from-before-the-obligation-was-written).
--
-- No new ledger. A reconciliation is an ordinary row of the list of counter money owed back (`counter_refunds_owed`), of cause
-- `customer_cancelled` or `place_withdrawn`, written already settled (`owed_since` = `settled_at` = when it was recorded, never the
-- cancellation's date, so no past day's "still owed" changes) and marked as a historical reconciliation by `historical_finding`. The
-- existing unique indexes (one per cancellation: 0346 `idx_counter_refunds_owed_cancel_only`; one per withdrawal:
-- `idx_counter_refunds_owed_withdrawal`) make it once.
--
--   * `historical_finding`: what the manager found: `earlier` (handed back at the time, no cash moves now), `now` (handed back now: a payout
--     dated now), `earlier_and_now` (part each). Null on every ordinary row.
--   * `historical_earlier_amount`, `_on`, `_via`: the part handed back earlier, the day it actually was, and how. No payout row: that day's till
--     already counted the credit note as cash leaving it (the rule before ADR 0075) and is not rewritten.
--   * `historical_now_amount`: the part handed back now. Its payout is a `counter_payouts` row dated now, by the method used, naming the old
--     credit note, with `historical_reconciliation` true so the cash-up does not count that note as "linked" on its own (already counted) day.
--   * `historical_remainder` (the credit note's total less both) and `historical_remainder_reason` (required when it is above nothing): never
--     an invisible obligation.
--   * `historical_evidence` (the reference: a till sheet, the venue's cash book, a receipt), `historical_reason`, who verified it
--     (`historical_verified_by_admin_id`, `historical_verified_by_name` as it was) and whether they acknowledged a day already counted.
--
-- Ordinary rows keep every new column null (the flag on payouts false). Nothing is backfilled; nothing already written changes.
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_finding TEXT;
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_earlier_amount NUMERIC(12,2);
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_earlier_on DATE;
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_earlier_via TEXT;
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_now_amount NUMERIC(12,2);
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_remainder NUMERIC(12,2);
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_remainder_reason TEXT;
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_evidence TEXT;
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_reason TEXT;
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_verified_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_verified_by_name TEXT;
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS historical_counted_days_acknowledged BOOLEAN;

-- A payout handed over now for a credit note written before migration 0346 (ADR 0078): today's till counts it; the note's own day is left as counted.
ALTER TABLE counter_payouts ADD COLUMN IF NOT EXISTS historical_reconciliation BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'counter_refunds_owed'::regclass AND conname = 'counter_refunds_owed_historical') THEN
    -- Every comparison is null-safe: a CHECK that comes out unknown would let the row through.
    ALTER TABLE counter_refunds_owed ADD CONSTRAINT counter_refunds_owed_historical CHECK (
      historical_finding IS NULL
      OR (
        historical_finding IN ('earlier', 'now', 'earlier_and_now')
        AND cause IN ('customer_cancelled', 'place_withdrawn')
        AND settled_at IS NOT NULL AND COALESCE(outcome, '') = 'back'
        -- Evidence, reason and who verified it, always.
        AND length(btrim(COALESCE(historical_evidence, ''))) > 0
        AND length(btrim(COALESCE(historical_reason, ''))) > 0
        AND length(btrim(COALESCE(historical_verified_by_name, ''))) > 0
        -- The parts the finding names, and only those.
        AND (historical_earlier_amount IS NOT NULL) = (historical_finding IN ('earlier', 'earlier_and_now'))
        AND (historical_now_amount IS NOT NULL) = (historical_finding IN ('now', 'earlier_and_now'))
        AND (historical_earlier_amount IS NULL OR (historical_earlier_amount > 0 AND historical_earlier_on IS NOT NULL
             AND COALESCE(historical_earlier_via, '') IN ('cash', 'qr', 'transfer', 'card')))
        AND (historical_now_amount IS NULL OR historical_now_amount > 0)
        -- What the row says was handed back in all.
        AND amount = COALESCE(historical_earlier_amount, 0) + COALESCE(historical_now_amount, 0)
        -- What is left of the credit note is stored, and said why where it is not returned.
        AND historical_remainder IS NOT NULL AND historical_remainder >= 0
        AND (historical_remainder = 0 OR length(btrim(COALESCE(historical_remainder_reason, ''))) > 0)
      )
    ) NOT VALID;
    ALTER TABLE counter_refunds_owed VALIDATE CONSTRAINT counter_refunds_owed_historical;
  END IF;
END $$;

-- The reconciliations of a venue, for the screen.
CREATE INDEX IF NOT EXISTS idx_counter_refunds_owed_historical ON counter_refunds_owed (venue_id) WHERE historical_finding IS NOT NULL;
