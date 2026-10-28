-- Who took the money at the counter, for the cash-up (lib/cash-up.ts;
-- docs/features/payments-and-credit.md#cash-up).
--
-- A receipt or credit note written while a member of staff was acting (a
-- top-up, a pass, a membership, a fee marked paid, a sale voided, a booking
-- cancelled) keeps who it was, by id and by name as it was then, as the
-- activity log does; one written by a customer's own payment or by the
-- system keeps none. A booking marked paid at the desk keeps the same: its
-- receipt is drawn from the booking (migration 0040), so who took the money
-- is kept there. Rows written before this migration have nobody.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS staff_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS staff_name TEXT;
-- Credit sold where it is the install's own (MYSENAM_CREDIT_SCOPE=platform) is
-- receipted to no venue (`venue_id` NULL), but the money went into one
-- venue's till: which, for that venue's cash-up.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS counter_venue_id INTEGER REFERENCES venues(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_by_name TEXT;
