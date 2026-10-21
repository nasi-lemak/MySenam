-- Where a venue hears about a booking made online: an address and a WhatsApp
-- number of its own choosing, either, both or neither (off, as before).
ALTER TABLE venues ADD COLUMN IF NOT EXISTS alert_email TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS alert_phone TEXT;
