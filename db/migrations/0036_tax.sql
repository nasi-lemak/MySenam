-- Sales tax (SST in Malaysia, GST in Singapore), two ways.

-- 1. A venue's own: whether it is registered, what the tax is called, its
--    rate and registration number. Its prices are what the customer pays,
--    tax included, as Singapore requires and Malaysians expect.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tax_registered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tax_name TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tax_reg_no TEXT;

-- The rate a booking was taken at, whatever the venue's rate later becomes;
-- null when the venue charged no tax. Set as the booking is made, however it
-- is made.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2);

CREATE OR REPLACE FUNCTION booking_tax_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tax_rate IS NULL THEN
    SELECT CASE WHEN v.tax_registered = 1 THEN v.tax_rate END INTO NEW.tax_rate
      FROM courts c JOIN venues v ON v.id = c.venue_id
     WHERE c.id = NEW.court_id;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bookings_tax_rate ON bookings;
CREATE TRIGGER bookings_tax_rate BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION booking_tax_rate();

-- 2. The platform's own, on what it invoices venues: `amount` stays what the
--    venue pays, now including the tax; the tax, its rate and name, and the
--    operator's registration number are kept as they were on the day.
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2);
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS tax_name TEXT;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS tax_reg_no TEXT;
