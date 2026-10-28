-- The language a venue's new-booking alerts are written in (lib/notify.ts):
-- one of the staff languages, chosen with the alert address and number,
-- since those are the venue's own inbox and phone rather than one person's.
-- NULL is none chosen: the install's first staff language, as before.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS alert_locale TEXT CHECK (alert_locale IS NULL OR alert_locale IN ('en', 'ms', 'zh'));
