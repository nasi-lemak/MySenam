-- Several courts booked together, at the same time, by one person (a company
-- night, a club session): each court its own booking and code, as before,
-- sharing a group code so they are confirmed, held and paid as one
-- (lib/store.ts `createGroupBooking`).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_code TEXT;
CREATE INDEX IF NOT EXISTS idx_bookings_group ON bookings(group_code) WHERE group_code IS NOT NULL;
