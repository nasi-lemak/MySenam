-- Staff notes on a customer (lib/customer-notes.ts): one per number per
-- venue. Personal data: exported with the number, erased with the account.
CREATE TABLE IF NOT EXISTS customer_notes (
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  phone_key TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT datetime('now'),
  PRIMARY KEY (venue_id, phone_key)
);
