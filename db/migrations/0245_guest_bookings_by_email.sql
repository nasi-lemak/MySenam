-- Bookings made without an account are shown on the account whose proved
-- address they were made under (lib/store.ts `ACCOUNT_BOOKING`;
-- docs/features/booking.md#bookings-on-the-account). The account page reads
-- them by that address on every visit: this finds them without reading every
-- booking.
CREATE INDEX IF NOT EXISTS idx_bookings_guest_email ON bookings (lower(email)) WHERE user_id IS NULL AND email IS NOT NULL;
