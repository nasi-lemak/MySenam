-- Coaching, round two (lib/coaching.ts).
-- A coach's own schedule: emailed about lessons booked and cancelled, and a
-- private link to their lessons and a calendar feed of them.
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS calendar_token TEXT UNIQUE;

-- A pack of lessons: a pass for one coach, which pays a whole lesson (court
-- and coach) rather than court time.
ALTER TABLE passes ADD COLUMN IF NOT EXISTS coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL;
