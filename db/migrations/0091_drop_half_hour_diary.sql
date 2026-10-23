-- Reservations as exact intervals (ADR 0010), part 3: the half-hour diary
-- goes. By now 0090 has turned it into claims, and the step after 0090 has
-- found the two the same half hour by half hour; this migration does not run
-- unless both did. Back up before upgrading: this is the one destructive step.

DROP TRIGGER IF EXISTS booking_slots_linked ON booking_slots;
DROP FUNCTION IF EXISTS shadow_linked_slot();
DROP FUNCTION IF EXISTS blocks_between(text, text);
DROP FUNCTION IF EXISTS own_blocks_between(text, text);
DROP TABLE IF EXISTS booking_slots;
DROP TABLE IF EXISTS slot_blocks;
DROP TABLE IF EXISTS coach_slots;
DROP TABLE IF EXISTS migration_venue_zones;

-- Decimal hours, now minutes.
ALTER TABLE bookings DROP COLUMN IF EXISTS start_hour;
ALTER TABLE bookings DROP COLUMN IF EXISTS end_hour;
ALTER TABLE classes DROP COLUMN IF EXISTS start_hour;
ALTER TABLE classes DROP COLUMN IF EXISTS end_hour;
ALTER TABLE waitlist DROP COLUMN IF EXISTS start_hour;
ALTER TABLE waitlist DROP COLUMN IF EXISTS end_hour;
ALTER TABLE urgent_notices DROP COLUMN IF EXISTS start_hour;
ALTER TABLE coach_hours DROP COLUMN IF EXISTS from_hour;
ALTER TABLE coach_hours DROP COLUMN IF EXISTS until_hour;
ALTER TABLE tournaments DROP COLUMN IF EXISTS start_hour;
ALTER TABLE tournaments DROP COLUMN IF EXISTS end_hour;
ALTER TABLE tournament_matches DROP COLUMN IF EXISTS hour;
ALTER TABLE venues DROP COLUMN IF EXISTS open_hour;
ALTER TABLE venues DROP COLUMN IF EXISTS close_hour;

-- Selling units and booking lengths, now booking policies.
ALTER TABLE venues DROP COLUMN IF EXISTS slot_minutes;
ALTER TABLE sport_rules DROP COLUMN IF EXISTS slot_minutes;
ALTER TABLE courts DROP COLUMN IF EXISTS min_hours;
ALTER TABLE courts DROP COLUMN IF EXISTS max_hours;
