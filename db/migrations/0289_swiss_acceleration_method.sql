-- Swiss: the acceleration method an event was drawn with
-- (docs/architecture/decisions/0047-baku-acceleration-for-chess.md; docs/features/tournaments.md#accelerated-pairing; lib/swiss.ts).
--
-- Round 10 stored an accelerated event as accel_rounds > 0 and nothing else: a constant virtual point for that many rounds. FIDE's Baku
-- Acceleration Method grades the point (a win's value in the first half of the accelerated rounds, half of it in the rest), so the event
-- now also keeps which method it was drawn with, chosen before the draw and fixed at it like the rest:
--   'none'     standard Swiss pairing (the default; accel_rounds is 0),
--   'constant' the legacy method of round 10 (accel_rounds rounds, accel_points each), which every event stored before this reads as,
--   'baku'     FIDE's Baku method: accel_rounds is the number of accelerated rounds (the first half of the event's rounds, rounded up),
--              accel_points the virtual points of its first half (a win's table points; the rest carry half), accel_group the size of GA.
-- Virtual points are used only to pair; they are in no table, result, tie-break or rating.
ALTER TABLE swiss_events ADD COLUMN IF NOT EXISTS accel_method TEXT NOT NULL DEFAULT 'none' CHECK (accel_method IN ('none', 'constant', 'baku'));

-- Events drawn before the method was stored: those that were accelerated used the constant method. Safe to run again.
UPDATE swiss_events SET accel_method = 'constant' WHERE accel_rounds > 0 AND accel_method = 'none';
