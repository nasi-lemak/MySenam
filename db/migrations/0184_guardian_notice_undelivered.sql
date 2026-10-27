-- A guardian notice that never reached the guardian becomes the venue's task
-- (lib/contact-guardians.ts; docs/integrations/messaging.md#guardian-notices).
--
-- A notice queued on WhatsApp for a guardian recorded by name and number can
-- still fail: the outbox gives it up after its tries, it runs out of the
-- venue's WhatsApp credit, it is over the day's limit for that number, or
-- WhatsApp later reports it undelivered. Then the guardian was not told, and
-- the venue that recorded them is given the same task as when nothing could
-- be sent: tell them, and mark it done.

-- Which notice was sent to whom about what, so a notice given up is turned
-- into that guardian's task, once.
CREATE TABLE IF NOT EXISTS guardian_notice_messages (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  guardianship_id INTEGER NOT NULL REFERENCES participant_guardians(id) ON DELETE CASCADE,
  venue_id INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  change TEXT NOT NULL CHECK (change IN ('added', 'ended', 'request', 'claimed')),
  about INTEGER,
  -- When it was found not to have reached them and made a task (or found one already there).
  tasked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_guardian_notice_messages_untasked ON guardian_notice_messages (message_id) WHERE tasked_at IS NULL;

-- A third reason a task exists: a notice was sent and did not arrive.
ALTER TABLE guardian_notice_tasks DROP CONSTRAINT IF EXISTS guardian_notice_tasks_why_check;
ALTER TABLE guardian_notice_tasks ADD CONSTRAINT guardian_notice_tasks_why_check CHECK (why IN ('unverified_number', 'no_channel', 'not_delivered'));
-- The message that did not arrive, for staff to see why.
ALTER TABLE guardian_notice_tasks ADD COLUMN IF NOT EXISTS message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
