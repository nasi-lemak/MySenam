-- Test bookings (audit R8 X1-16; docs/product/marketplace.md#test-bookings-before-going-live).
--
-- A booking made while its venue was a draft (venues.published_at IS NULL:
-- not yet live) is a test: the set-up checklist asks for one, and staff try
-- the counter on them. It stays a booking like any other, with its receipt
-- and credit notes kept and numbered as they were; what changes is that the
-- venue's figures leave it out: the period and customer reports, the
-- bookings export, the cash-up and the month's consolidated e-invoice
-- (lib/test-bookings.ts). Staff see it marked as a test, and may clear it
-- (cancelled with everything paid given back, no message, no strike) or keep
-- it as a real booking (`test` back to false).
--
-- Marked by the database as each booking is written, whichever path writes it
-- (counter, booking page, series, class, API), as the tax rate is (0036).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS test BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION booking_marks_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM courts c JOIN venues v ON v.id = c.venue_id
              WHERE c.id = NEW.court_id AND v.published_at IS NULL) THEN
    NEW.test := true;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS bookings_test ON bookings;
CREATE TRIGGER bookings_test BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION booking_marks_test();

-- Bookings already made at venues still in draft are tests too. Nothing at a
-- venue that has gone live changes: its figures already reported stand. Nor
-- at a draft that has already written an e-invoice (its month went, or is
-- going, to LHDN as it was).
UPDATE bookings b SET test = true
  FROM courts c JOIN venues v ON v.id = c.venue_id
 WHERE c.id = b.court_id AND v.published_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM e_invoices e WHERE e.venue_id = v.id);

CREATE INDEX IF NOT EXISTS idx_bookings_test ON bookings (court_id) WHERE test;
