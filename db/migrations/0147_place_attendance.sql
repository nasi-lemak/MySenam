-- Attendance per person taking part (lib/store.ts `markPlace`; ADR 0023;
-- docs/features/venue-operations.md#check-in-and-live-crowd-levels).
--
-- `check_ins` is one row per booking: somebody on it arrived. Where a
-- booking names the people taking part (`booking_participants`), staff can
-- now also say who of them arrived or did not, one row per place. The
-- booking's own arrival and no-show stay as they were: it counts as checked
-- in once anybody on it arrived, and as a no-show only when everybody named
-- was one.
--
-- An arrival hangs off the booking's check-in and goes with it when check-ins
-- are pruned (lib/privacy.ts); a no-show is kept as long as the booking's
-- own no-show flag is.

CREATE TABLE IF NOT EXISTS place_attendance (
  place_id INTEGER PRIMARY KEY REFERENCES booking_participants(id) ON DELETE CASCADE,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- Arrived: with the booking's check-in, and goes with it.
  check_in_id INTEGER REFERENCES check_ins(id) ON DELETE CASCADE,
  arrived_at TIMESTAMPTZ,
  no_show BOOLEAN NOT NULL DEFAULT false,
  -- Staff who recorded it: their name as it was.
  recorded_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  recorded_by_name TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((no_show AND check_in_id IS NULL AND arrived_at IS NULL) OR (NOT no_show AND check_in_id IS NOT NULL AND arrived_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_place_attendance_booking ON place_attendance (booking_id);
