-- Credit on a company or school account paid back by hand (lib/accounts.ts
-- `settleAccountCredit`; docs/features/payments-and-credit.md#company-and-school-accounts).
--
-- A credit note on an account (a place taken off a booking already invoiced)
-- waits for the account's next invoice. An account closed, or with nothing
-- more to invoice, would keep it for ever; the venue pays it back some other
-- way (a bank transfer), and a manager records that here, with what they
-- wrote down to find it again. A credit settled so is never taken off an
-- invoice afterwards, so it is not given back twice. Credits already taken
-- off an invoice are not touched.
ALTER TABLE account_credits ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE account_credits ADD COLUMN IF NOT EXISTS settled_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE account_credits ADD COLUMN IF NOT EXISTS settled_by_name TEXT;
ALTER TABLE account_credits ADD COLUMN IF NOT EXISTS settled_note TEXT CHECK (settled_note IS NULL OR length(settled_note) <= 200);
ALTER TABLE account_credits ADD CONSTRAINT account_credits_settled_or_applied CHECK (settled_at IS NULL OR applied_invoice_id IS NULL);

-- What waits for the next invoice: neither taken off one nor paid back by hand.
CREATE INDEX IF NOT EXISTS idx_account_credits_waiting ON account_credits (account_id) WHERE applied_invoice_id IS NULL AND settled_at IS NULL;
