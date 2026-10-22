-- Webhook deliveries: the scheduler reads only those still to go, every
-- minute, and the retention pass removes old ones by age.
DROP INDEX IF EXISTS webhook_deliveries_due;
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending ON webhook_deliveries (next_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_created ON webhook_deliveries (created_at);
