-- Who chooses the coach of a new lesson at a venue (lib/lesson-coaches.ts;
-- docs/features/programmes.md#who-chooses-the-coach).
--
-- 'customer' (as before, and the default): the venue's coaches are listed and
-- the customer books a named one. 'venue': the customer books a lesson for a
-- sport and a time, and a coach of that sport who is free then is assigned
-- (the fewest lessons that day, then the lowest id), shown on the
-- confirmation. Staff may still book a named coach either way.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS lesson_coach_choice TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_lesson_coach_choice_check;
ALTER TABLE venues ADD CONSTRAINT venues_lesson_coach_choice_check CHECK (lesson_coach_choice IN ('customer', 'venue'));
