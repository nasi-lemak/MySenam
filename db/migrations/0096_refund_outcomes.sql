-- What happened to a refund after the gateway accepted it, and refunds owed
-- that nothing has asked the gateway for (known limitations M15;
-- docs/features/payments-and-credit.md).

-- A refund the gateway accepted and later could not make (a closed card,
-- say): the money is owed again, and this row stays as the record of it.
ALTER TABLE online_refunds ADD COLUMN IF NOT EXISTS failed_at TEXT;
-- When the gateway was last asked how a refund still going through stands.
ALTER TABLE online_refunds ADD COLUMN IF NOT EXISTS checked_at TEXT;

-- When the scheduler first saw money owed back on a payment with nothing
-- asked for it, and when it last asked the gateway for it by itself: an
-- automatic refund the app stopped before asking for is asked for later,
-- and one the gateway refused is not asked for again every minute.
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS refund_seen_at TEXT;
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS auto_refund_tried_at TEXT;
