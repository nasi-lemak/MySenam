-- What happens to money paid online when a customer cancels.
--
-- 'staff' (as before): it is shown as owed back, and staff refund it.
-- 'gateway': it goes straight back through the gateway it came through, where
--   that gateway refunds by API (Stripe); otherwise staff refund it as before.
-- 'credit': it becomes stored credit at the venue for the customer's account;
--   a booking made without an account is left to staff as before.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS online_refunds TEXT NOT NULL DEFAULT 'staff';
