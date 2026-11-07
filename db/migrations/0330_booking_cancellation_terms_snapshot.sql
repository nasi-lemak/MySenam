-- Post-audit hardening, B12 / DEC-09 (ADR 0069): the cancellation terms a customer was shown when they booked are the terms that
-- govern that booking.
--
-- `bookings.cancel_terms`: a JSON object written once, in the booking's own transaction, from the terms in force at that moment
-- (lib/booking-terms.ts `cancelTermsSnapshot`): the free-cancellation cutoff in hours, the share the venue keeps of a late cancellation
-- (null: no late cancelling online), whether the court may be given back late, the strike limit and window, how money paid online goes
-- back and how long staff take, the hold and deposit terms, the digest of what the customer was shown (`version`, the same digest the
-- terms endpoint gives) and when it was taken. Cancelling, moving and withdrawing read the cutoff, the share and the give-back from it;
-- the rest is the evidence of what was presented.
--
-- A booking made before this migration has NULL: its terms are the venue's current ones when it is cancelled, as they always were.
-- Nothing is backfilled: what the customer was shown then is not recorded anywhere, and writing today's terms onto it would be an
-- invention of past terms. A nullable column without a default is a catalogue change only: no table rewrite, no long lock. The check
-- is added NOT VALID (a catalogue change) and then validated, which scans the table without blocking writes; every existing row is NULL.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_terms JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancel_terms_object_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_cancel_terms_object_check
      CHECK (cancel_terms IS NULL OR jsonb_typeof(cancel_terms) = 'object') NOT VALID;
  END IF;
END $$;
ALTER TABLE bookings VALIDATE CONSTRAINT bookings_cancel_terms_object_check;
