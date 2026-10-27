-- When the payment page a membership purchase is paid on closes by itself
-- (docs/features/payments-and-credit.md#a-membership-paid-online;
-- lib/membership-purchases.ts). A gateway that can close a page at a set time
-- (Stripe: 30 minutes to a day ahead) is asked to close it when the purchase's
-- hold ends, and the hold is kept until it does. NULL: the gateway's page
-- stays payable until it is paid (Billplz), so money can still come in after
-- the hold has lapsed; that money makes the membership if it can still be
-- made, and is owed back otherwise.
ALTER TABLE membership_purchases ADD COLUMN IF NOT EXISTS page_closes_at TIMESTAMPTZ;
