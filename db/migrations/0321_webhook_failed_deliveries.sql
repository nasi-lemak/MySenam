-- Hardening round, G17 (ADR 0066): a webhook delivery that used up its attempts stays visible and can be sent again by hand.
--
-- The delivery row already is the failed-delivery record (attempts used up, never delivered, last status and error). What it lacked:
-- when the last attempt was made, and that someone sent it again. `redeliveries` counts the times a manager sent the same event
-- again (the payload, so its event id, is never changed), `redelivered_at` is the last time. Retention is unchanged in kind
-- (docs/architecture/privacy.md): delivered or given up on, 30 days after it was made; lib/privacy.ts now also counts as given up a
-- delivery whose address was turned off, which no run would ever send.
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS last_attempt_at TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS redeliveries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS redelivered_at TEXT;

-- Rows that already exist, deterministically: a delivered one was last tried when it was delivered; one that used its eight attempts
-- was last tried one back-off before the time the last failure set for the next (1, 2, 4... minutes, at most 360: lib/webhooks.ts).
-- A delivery still being retried is left empty and gets its time with its next attempt.
UPDATE webhook_deliveries SET last_attempt_at = delivered_at WHERE delivered_at IS NOT NULL AND last_attempt_at IS NULL;
UPDATE webhook_deliveries
   SET last_attempt_at = to_char(next_at::timestamp - LEAST(POWER(2, attempts - 1), 360) * INTERVAL '1 minute', 'YYYY-MM-DD HH24:MI:SS')
 WHERE delivered_at IS NULL AND attempts >= 8 AND last_attempt_at IS NULL;
