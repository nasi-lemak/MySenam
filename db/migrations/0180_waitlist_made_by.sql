-- Who put an entry on a waiting list (lib/store.ts waiting lists; lib/waitlist-venue.ts;
-- docs/features/booking.md#at-the-counter-and-through-the-api).
--
-- Until now every entry was made online by its customer. The venue's staff
-- now queue a caller at the counter, and the venue's own system through its
-- API key, on their word for the name and number, as a counter booking is
-- made. An entry made that way is checked again, at the offer and at the
-- claim, the way it was made: each participant one the venue knows with a
-- guardian on the entry's number, and sign-offs on that number, as the
-- counter checks them; an offer claimed from it is booked as the counter or
-- the API would have booked it.
--
-- `made_by`: 'customer' (online, every entry so far), 'staff' (the counter)
-- or 'api' (the venue's API key). The member of staff or the key that made
-- it, for staff to see; `made_by_name` keeps the name as it was, as the
-- activity log does, after the account or key is gone.

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS made_by TEXT NOT NULL DEFAULT 'customer' CHECK (made_by IN ('customer', 'staff', 'api'));
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS made_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS made_by_api_key_id INTEGER REFERENCES venue_api_keys(id) ON DELETE SET NULL;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS made_by_name TEXT;
