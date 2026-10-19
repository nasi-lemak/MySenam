-- Customers buying stored credit online, into the venue's own account.
ALTER TABLE online_payments DROP CONSTRAINT IF EXISTS online_payments_purpose_check;
ALTER TABLE online_payments ADD CONSTRAINT online_payments_purpose_check
  CHECK (purpose IN ('booking', 'invoice', 'share', 'entry', 'league', 'pack', 'topup'));
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS topup_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
