-- Refund reconciliation runs for every venue; refund execution only where the
-- venue refunds automatically (lib/payments.ts, `reconcileRefunds`). The
-- policy a refund obligation was first seen under is kept with it, so a venue
-- that switches to automatic refunds later never has obligations its staff
-- were handling by hand refunded behind them.
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS refund_seen_policy TEXT CHECK (refund_seen_policy IN ('auto', 'manual'));
-- Obligations seen before this was kept were only ever noted for venues refunding automatically.
UPDATE online_payments SET refund_seen_policy = 'auto' WHERE refund_seen_at IS NOT NULL AND refund_seen_policy IS NULL;
-- When a venue's staff were last told what refunds wait for them: at most once a day.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS refund_digest_at TEXT;
