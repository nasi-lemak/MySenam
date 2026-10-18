-- WhatsApp per venue: off; urgent only — the venue's own cancellations and
-- moves, and waitlist offers, which the platform pays for; or everything,
-- from prepaid credit. Urgent only is the default.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS whatsapp_mode TEXT NOT NULL DEFAULT 'urgent'
  CHECK (whatsapp_mode IN ('off', 'urgent', 'all'));
UPDATE venues SET whatsapp_mode = 'all' WHERE whatsapp_on = 1;
ALTER TABLE venues DROP COLUMN IF EXISTS whatsapp_on;
