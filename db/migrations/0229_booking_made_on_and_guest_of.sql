-- How each booking was made, and whose guest it is (the owner's decision of
-- 28 October 2026: count actual guests, distinguishing ordinary walk-in
-- customers from guests accompanying members; docs/features/booking.md#members-and-residents-guests-at-the-counter-and-through-the-api).
--
-- `made_on`: the path the booking was made on, as lib/limits.ts names them:
-- the customer online, the venue's staff at its counter, or the venue's own
-- system through its API key. The limit on online bookings without an
-- account (`GUEST_SURGE`) counts what was made online, not the counter's own
-- walk-ins. Bookings made before this migration carry no path and are
-- counted as they were (the limit looks back one hour).
--
-- `guest_of_entry`: the resident or member on the venue's list whose guest
-- the person booked is, where staff or the venue's API key booked them as one
-- (lib/guest-invites.ts `registerGuest`); null for everybody else, a walk-in
-- customer included. Gone with the host's entry; the booking stays.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS made_on TEXT CHECK (made_on IN ('customer', 'staff', 'api'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_of_entry INTEGER REFERENCES venue_access_list(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_guest_of_entry ON bookings (guest_of_entry) WHERE guest_of_entry IS NOT NULL;
