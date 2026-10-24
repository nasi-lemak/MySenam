-- Refunds made by hand (lib/payments.ts): how many days a venue that refunds
-- by hand tells customers it takes, so a refund past it shows as overdue to
-- staff and the customer sees the date; and what staff wrote down when they
-- made one (a bank transfer reference), kept with the refund for the audit.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS refund_within_days INTEGER NOT NULL DEFAULT 7
  CHECK (refund_within_days BETWEEN 1 AND 30);
ALTER TABLE online_refunds ADD COLUMN IF NOT EXISTS note TEXT;
