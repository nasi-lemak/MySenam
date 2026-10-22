-- A deposit to hold a booking, rather than the whole price: where a venue
-- holds bookings until paid online, it may let the customer pay this share
-- now and the rest at the counter. NULL: the whole price, as before.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS deposit_percent INTEGER;

-- What a booking has had paid as a deposit online. It is also counted in
-- shares_paid, which is everything paid towards a booking on receipts of its
-- own; this says how much of that was the booker's deposit.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid NUMERIC(12,2) NOT NULL DEFAULT 0;

-- A payment page that was for a deposit.
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS deposit INTEGER NOT NULL DEFAULT 0;
