-- Things going wrong that the platform owner should hear about: one row per
-- kind, so the same failure is told about at most every few hours however
-- often it happens, with how many times it did.
CREATE TABLE IF NOT EXISTS system_alerts (
  key TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  last_detail TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL DEFAULT datetime('now'),
  last_at TEXT NOT NULL DEFAULT datetime('now'),
  last_sent_at TEXT
);
