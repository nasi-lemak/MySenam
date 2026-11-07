-- When the outbox last tried to send a message (ADR 0073). `next_attempt_at` is when it tries next and `sent_at` when it went; neither
-- says how many sends the provider has refused lately, which is what an owner needs to see ("is the email provider failing?").
-- The drain stamps it as it claims a message, so a message sent and one that failed are both counted in the hour they were tried.
--
-- Nullable and without a default: a column added this way does not rewrite the table, and rows written before it simply have none
-- (they are not counted in the recent failure rate, which looks at the last hour only). Nothing is edited or deleted.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_attempt_at TEXT;
