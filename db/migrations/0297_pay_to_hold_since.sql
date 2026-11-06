-- When a venue turned "pay online to hold a booking" on (lib/holds.ts `setHoldPolicy`; ADR 0054). The scheduler's sweep of bookings
-- made online whose request died before their hold was applied (`holdStrandedBookings`) must never hold, and so release, a booking made
-- before the venue asked for holds: it is only for bookings created from this moment. Null: on before this column existed, or off.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS pay_to_hold_since TEXT;
