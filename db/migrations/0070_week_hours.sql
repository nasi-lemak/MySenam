-- Hours that differ by weekday (lib/week-hours.ts): seven entries, Sunday
-- first, each null (the usual open_hour/close_hour), {"open","close"}, or
-- "closed". NULL: every day keeps the usual hours, as before. close_hour may
-- now run past midnight, to 28 (4 AM).
ALTER TABLE venues ADD COLUMN IF NOT EXISTS week_hours TEXT;
