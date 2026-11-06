-- Audit 9, FX11 (ADR 0063): a venue's suspension and the customers who hold something there; time given for an overdue invoice.
--
-- `venues.suspension_told_for`: the `suspended_at` stamp of the suspension whose customers have been told (lib/suspension-notices.ts);
-- a venue is untold while it differs from `suspended_at`, so a notice is sent once per suspension and a stop in between is mended by the
-- next run.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS suspension_told_for TEXT;
-- A suspension already in force when this runs is not told to its customers now, a deploy being no reason for a burst of old news: only
-- suspensions that begin after it are.
UPDATE venues SET suspension_told_for = suspended_at WHERE suspended_at IS NOT NULL AND suspension_told_for IS NULL;

-- An invoice the owner has given more time on: the venue is not held for it until after this date (lib/payment-holds.ts), with the
-- reason, who gave it and when. The invoice itself is not changed: its due date, amount and status stay as issued.
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS billing_grace_until TEXT;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS billing_grace_reason TEXT;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS billing_grace_by TEXT;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS billing_grace_at TEXT;

-- A membership that renews itself at the gateway, paused there while its venue is suspended (null: not paused).
ALTER TABLE membership_subscriptions ADD COLUMN IF NOT EXISTS paused_at TEXT;
