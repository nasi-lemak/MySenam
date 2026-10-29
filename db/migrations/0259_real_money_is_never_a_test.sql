-- Real money is never a test (docs/product/marketplace.md#test-bookings-before-going-live).
--
-- A booking made while its venue was a draft is a test (0254). A test is
-- synthetic: left out of the venue's own figures. So once the venue is live,
-- a payment arriving on one is a real sale, whatever path takes it (the
-- counter, an online payment confirmed, credit, a pass): the moment its
-- payment_status becomes 'paid' at a venue that has gone live, it stops being
-- a test and is in the figures, the cash-up and the month's e-invoice like
-- any other booking. Marked by the database as the payment is written, as the
-- insert trigger marks the test (0254), so no path can forget it.
--
-- A payment made while the venue was still a draft stays a test; going live is
-- refused while any such booking stands (lib/test-bookings.ts), until a
-- manager has cleared it or kept it as real.
CREATE OR REPLACE FUNCTION booking_paid_is_real() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.test AND NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid'
     AND EXISTS (SELECT 1 FROM courts c JOIN venues v ON v.id = c.venue_id
                  WHERE c.id = NEW.court_id AND v.published_at IS NOT NULL) THEN
    NEW.test := false;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS bookings_paid_real ON bookings;
CREATE TRIGGER bookings_paid_real BEFORE UPDATE ON bookings
  FOR EACH ROW WHEN (NEW.test AND NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION booking_paid_is_real();

-- A test booking cleared by a manager who says real money was taken at the
-- counter is owed back as the venue's own cancellations are (0258): the cause
-- is the test.
ALTER TABLE counter_refunds_owed DROP CONSTRAINT IF EXISTS counter_refunds_owed_cause_check;
ALTER TABLE counter_refunds_owed ADD CONSTRAINT counter_refunds_owed_cause_check
  CHECK (cause IN ('closure', 'outage', 'rain', 'api', 'class', 'test'));
