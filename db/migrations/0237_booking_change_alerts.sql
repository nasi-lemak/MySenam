-- Booking alerts for customers' own cancellations and changes made online
-- (lib/notify.ts `alertVenueChange`; docs/features/venue-operations.md#booking-alerts).
--
-- The venue already hears about each new online booking at the address and
-- WhatsApp number it chose (migration 0037). It may also choose to hear when a
-- customer cancels online, or changes a booking's time or who is on it, through
-- the same channels. Both are off unless the venue turns them on. Only bookings
-- starting within `alert_change_hours` of the change are announced (a day,
-- unless the venue widens it; NULL announces every one), so a cancellation
-- weeks ahead does not cost a WhatsApp message.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS alert_cancellations BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS alert_changes BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS alert_change_hours INTEGER DEFAULT 24
  CHECK (alert_change_hours IS NULL OR (alert_change_hours >= 1 AND alert_change_hours <= 720));
