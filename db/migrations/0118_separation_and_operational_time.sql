-- Minimum separation, kept apart from operational time
-- (docs/architecture/booking-time-model.md#buffers-separation-and-operational-time).
--
-- A booking policy's "kept free before / after" (buffer_before, buffer_after)
-- is from now on a minimum separation: two neighbours need the larger of the
-- two separations that face each other, not their sum. The columns keep
-- their names and their values, so every existing setting becomes a minimum
-- separation as it stands; nothing is rewritten.
--
-- Operational time (setting up before, cleaning after) is new, and adds up:
-- 10 minutes of cleaning after one booking and 10 of preparation before the
-- next need 20. Unset on every existing level, so inherited as 0.
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS operational_before INTEGER CHECK (operational_before BETWEEN 0 AND 240);
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS operational_after INTEGER CHECK (operational_after BETWEEN 0 AND 240);

-- Each claim keeps the separation it was made with. Existing claims get 0:
-- what they were made with stays in `occupied` (their buffers, widened as
-- before) and is not shrunk, so nothing they protected is given up and no
-- two existing claims can come to collide. New claims on a space keep their
-- operational time in `occupied` and their separation here, which
-- claim_gaps_apart (migration 0119) enforces. Bounded as the policy is.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS separation_before INTEGER NOT NULL DEFAULT 0 CHECK (separation_before BETWEEN 0 AND 240);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS separation_after INTEGER NOT NULL DEFAULT 0 CHECK (separation_after BETWEEN 0 AND 240);
