-- Multi-visit passes sold online (docs/features/pricing.md#buying-a-pass-online;
-- lib/pass-purchases.ts, lib/payments.ts startPassPayment / settleBill).
--
-- A pass product a manager marks *sold online* (off by default) is offered on
-- the venue's page, and a signed-in customer pays the venue for it through the
-- venue's own gateway, as memberships, credit and gift vouchers already are.
-- Nothing here is a pass. The pass is issued from the product only once the
-- money is in, in the transaction that claims the payment (one claim per
-- payment), and named on the payment (`pass_id`, unique): the gateway's
-- callback and the customer's return, each repeated or racing, issue one. A
-- payment that fails or is abandoned issues nothing.

ALTER TABLE pass_products ADD COLUMN IF NOT EXISTS sold_online BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE online_payments DROP CONSTRAINT IF EXISTS online_payments_purpose_check;
ALTER TABLE online_payments ADD CONSTRAINT online_payments_purpose_check
  CHECK (purpose IN ('booking', 'invoice', 'share', 'entry', 'league', 'pack', 'topup', 'membership', 'voucher', 'split', 'coach', 'pass'));

-- What the customer chose before paying: the product, the account that pays,
-- and whose place it pays for (the account holder's own, or a participant the
-- account acts for, on a pass for one person's place).
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS pass_product_id INTEGER REFERENCES pass_products(id) ON DELETE SET NULL;
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS pass_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS pass_holder_kind TEXT CHECK (pass_holder_kind IS NULL OR pass_holder_kind IN ('customer', 'participant'));
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS pass_participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL;
-- The pass the payment issued: one pass per payment, and one payment per pass.
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS pass_id INTEGER REFERENCES passes(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_online_payments_pass ON online_payments (pass_id) WHERE pass_id IS NOT NULL;
-- When the gateway said the page failed or expired ('YYYY-MM-DD HH:MM:SS', UTC, as `created_at`): it is not
-- offered again. Money that still comes in on it is settled as any other.
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS page_closed_at TEXT;
-- A customer's open page for the same pass is sent back to, not opened twice.
CREATE INDEX IF NOT EXISTS idx_online_payments_pass_pending ON online_payments (pass_user_id, pass_product_id) WHERE purpose = 'pass' AND status = 'pending';
ALTER TABLE online_payments DROP CONSTRAINT IF EXISTS online_payments_pass_holder_check;
ALTER TABLE online_payments ADD CONSTRAINT online_payments_pass_holder_check
  CHECK (purpose <> 'pass' OR (pass_holder_kind IS NOT NULL AND (pass_holder_kind = 'participant' OR pass_participant_id IS NULL)));
