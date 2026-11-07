-- What a payment gateway said it received, held against what the page asked for, and why a payment was not applied
-- (audit C19 and C18; docs/features/payments-and-credit.md#settlement-checks, ADR 0065).
--
-- A payment page asks for one amount. A report that it was paid is believed for that amount only when the gateway's own
-- figures agree with it; otherwise the payment is recorded as what it was and put on the staff's list of payments to
-- check. Nothing here rewrites a receipt, a credit note or a booking: these are columns of the payment row, which already
-- carries what is owed back, plus one staff activity-log row for each observation.
--
-- All nullable, no default, no backfill: a payment settled before this migration has none of them and reads as "the
-- gateway's figures were not recorded", never as a mismatch. Added the way earlier migrations add a column to this table
-- (no table rewrite); the constraint is NOT VALID so no scan of existing rows is needed (they are all NULL).

-- What the gateway reported as taken, in ringgit, when it said so; and what the page asked for when that was different
-- (`amount` then holds what was received, the same figure `refund_due` and `refunded` are counted against).
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS received_amount NUMERIC(12,2);
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS billed_amount NUMERIC(12,2);

-- Why the money was not applied, or needs a person to look: a short payment, a bill that is not the one we made, a report
-- that cannot be checked, or a payment that came after the booking's hold was let go. Set once, never cleared.
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS settlement_issue TEXT;
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS settlement_issue_at TEXT;

-- A manager or the front desk has looked at it (the list of payments to check keeps only what nobody has).
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS settlement_reviewed_at TEXT;
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS settlement_reviewed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS settlement_review_note TEXT;

-- When the payer was told (an email, only to an address their account has proved), once.
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS settlement_payer_told_at TEXT;

ALTER TABLE online_payments DROP CONSTRAINT IF EXISTS online_payments_settlement_issue_check;
ALTER TABLE online_payments ADD CONSTRAINT online_payments_settlement_issue_check
  CHECK (settlement_issue IS NULL OR settlement_issue IN
    ('underpaid', 'overpaid', 'bill_amount', 'collection', 'currency', 'unverified', 'hold_lapsed', 'short_after_settled')) NOT VALID;

-- The list of payments to check: only the ones with an issue nobody has looked at, by venue.
CREATE INDEX IF NOT EXISTS online_payments_to_check ON online_payments (venue_id, id)
  WHERE settlement_issue IS NOT NULL AND settlement_reviewed_at IS NULL;
