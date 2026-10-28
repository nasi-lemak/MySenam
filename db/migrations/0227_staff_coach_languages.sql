-- A language of their own for staff and coaches (the owner's decision of
-- 28 October 2026: "Support individual language preferences for staff and
-- coaches"). NULL is none chosen: MySenam then writes to them in the
-- install's first staff language, as before.
--
-- Staff read the dashboard, so theirs is one of its languages (English,
-- Malay, Chinese; not Tamil, the owner's decision of 24 October 2026). A
-- coach reads only pages, calendars and emails written from the customer
-- dictionaries (lib/coach-schedule.ts), so theirs may be any of the four.
-- Whether the install still offers it is checked where it is read.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS locale TEXT CHECK (locale IS NULL OR locale IN ('en', 'ms', 'zh'));
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS locale TEXT CHECK (locale IS NULL OR locale IN ('en', 'ms', 'zh', 'ta'));
