-- A booking on a company or school account cancelled after its invoice was
-- issued (lib/accounts.ts `creditAccountForCancellation`;
-- docs/features/payments-and-credit.md#company-and-school-accounts).
--
-- The issued invoice stays as it is: what goes back on the cancellation
-- terms is a credit note on the account against it, as for one person taken
-- off a booking (migration 0201), and comes off the account's next invoice
-- or is paid back by hand. One per booking cancelled, however many times the
-- cancellation is attempted at once.
ALTER TABLE account_credits ADD COLUMN IF NOT EXISTS for_cancellation BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_credit_cancellation ON account_credits (booking_id) WHERE for_cancellation;
