-- Which outbox message carries a password reset's link or a sign-up's link (ADR 0073), so that a second request while the first
-- email has not yet gone (the provider is down, or it is waiting its turn) reuses what is already waiting instead of making
-- another token and another email, and so that the cooldown between emails to one address is counted from the link itself.
--
-- A plain number, not a foreign key: messages are kept for a limited time and the pointer must never hold one back. A challenge
-- written before this migration has none, and is treated as one whose email is no longer waiting. Nullable, no default, nothing
-- rewritten.
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS message_id INTEGER;
ALTER TABLE registration_links ADD COLUMN IF NOT EXISTS message_id INTEGER;
