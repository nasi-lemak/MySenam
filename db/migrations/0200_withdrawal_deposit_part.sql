-- Taking one person off a booking held by a deposit (lib/place-withdrawals.ts;
-- docs/features/booking.md#taking-one-person-off-a-booking; the owner's
-- decision of 27 October 2026).
--
-- The withdrawn place's price as charged comes off what the booking costs:
-- off the balance still owed first, and only what was paid beyond the new
-- total comes out of the deposit, going back to the deposit's online payment
-- on the venue's cancellation terms. On a booking already paid in full, the
-- part paid last (the rest, at the counter or online) is settled first and
-- then the deposit.
--
-- `deposit_part` is how much of the place's price was settled from the
-- deposit (given back plus kept on a late withdrawal); `deposit_refunded` is
-- what of it went back to the deposit's payment. A later cancellation of the
-- booking gives back only the deposit that is left (lib/store.ts
-- `noteOnlineRefundDue`), and the part of a paid booking's price still on it
-- leaves out only the part settled apart from the deposit (`paidPartLeft`).
-- Every withdrawal made before has 0 for both, which is what it was.

ALTER TABLE place_withdrawals ADD COLUMN IF NOT EXISTS deposit_part NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deposit_part >= 0);
ALTER TABLE place_withdrawals ADD COLUMN IF NOT EXISTS deposit_refunded NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deposit_refunded >= 0);
