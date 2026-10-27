-- When the people a receipt or credit note names were taken out of it
-- (lib/receipt-names.ts; docs/architecture/privacy.md#receipts-and-credit-notes).
--
-- Retention and erasure always took the customer's name, phone and account
-- off a receipt, but the names of whom its lines were for stayed inside
-- `lines` (a guardian's children on the court time, a child taken off a
-- booking, the family a membership covers). They are cleared with the rest
-- now, and this says a receipt's have been, so a receipt anonymised before
-- (its customer already `(removed)`) is still found and cleared once.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS names_cleared_at TIMESTAMPTZ;

-- The receipts whose names are still to go, by when they were issued (the retention rule).
CREATE INDEX IF NOT EXISTS receipts_names_due ON receipts (issued_at) WHERE names_cleared_at IS NULL;
