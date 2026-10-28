-- A waiting-list entry's own private link to leave the list (audit R8 X2-9;
-- lib/store.ts `leaveWaitlistByToken`, docs/features/booking.md#leaving-and-turning-an-offer-down):
-- given once, to whoever joined, on the joined screen and in the email saying
-- so, and kept here only as its SHA-256 hash, as a coach's link is (0137).
-- Entries made before this have none: they leave as before (the account's
-- waiting lists, or the venue).
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS leave_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leave_hash ON waitlist (leave_hash) WHERE leave_hash IS NOT NULL;
