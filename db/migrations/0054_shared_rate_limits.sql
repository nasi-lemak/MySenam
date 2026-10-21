-- Rate-limit counters shared by every instance of the app, when it runs on
-- more than one (MYSENAM_RATE_LIMITS=shared). reset_at is epoch milliseconds.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset ON rate_limits (reset_at);
