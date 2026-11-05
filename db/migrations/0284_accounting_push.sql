-- A live push of a venue's sales to its accounting package: Xero first, behind a provider interface
-- (lib/accounting-provider.ts, lib/xero.ts, lib/accounting-push.ts; ADR 0041; docs/integrations/xero.md).
--
-- Off by default and per venue: nothing here is written until a manager connects the venue's own Xero organisation.
-- What is pushed is the sales journal's own rows (lib/accounting.ts), so the numbers cannot differ from the export, which
-- stays as it was. The tables hold no customer's name, email or phone: the queue keeps amounts, the document's number
-- and its kind; the contact is read from the account at the moment of sending and never stored here.

-- One row per venue: the connection to its organisation. Tokens are sealed (lib/secrets.ts `seal`, the key that locks
-- the payment gateways' keys): never in plain text, never logged, never returned by any route. Disconnecting revokes the
-- grant at Xero and empties both token columns.
CREATE TABLE IF NOT EXISTS accounting_connections (
  venue_id INTEGER PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'xero' CHECK (provider IN ('xero')),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
  -- The Xero organisation: its tenant id (the key every call carries), the connection id (to remove it), its name and
  -- base currency as they were when connected.
  tenant_id TEXT,
  connection_id TEXT,
  tenant_name TEXT,
  base_currency TEXT,
  -- Sealed.
  access_token TEXT,
  refresh_token TEXT,
  access_expires_at TIMESTAMPTZ,
  scopes TEXT,
  -- Held while one process refreshes the (rotating) refresh token, so two do not both spend it.
  refreshing_until TIMESTAMPTZ,
  -- Xero said "too many calls" (429): nothing is sent until this passes.
  paused_until TIMESTAMPTZ,
  -- Sales on or after this day (the venue's own calendar, YYYY-MM-DD) are pushed. The day of connecting, unless a
  -- manager picked an earlier one after confirming a preview of the count and total.
  start_date TEXT NOT NULL,
  -- The last day the journal was read through for new sales (re-read a couple of days back each time), and when.
  scanned_through TEXT,
  scanned_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  connected_by_name TEXT NOT NULL,
  -- The venue's acknowledgement of what is sent and where Xero keeps it: who, when and which wording (the app does not
  -- judge whether the transfer is lawful; it records that the venue read the notice and agreed).
  acknowledged_at TIMESTAMPTZ NOT NULL,
  acknowledged_by_name TEXT NOT NULL,
  notice_version INTEGER NOT NULL,
  last_ok_at TIMESTAMPTZ,
  -- Something has been failing since then (cleared by the next success); the venue's managers are told after a day.
  failing_since TIMESTAMPTZ,
  last_alert_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A consent screen in progress (authorization code flow with PKCE): the state we sent, its verifier (sealed) and who
-- began it, so the callback can only finish what a signed-in manager of that venue began. Short-lived, used once.
CREATE TABLE IF NOT EXISTS accounting_oauth_states (
  state_hash TEXT PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
  admin_name TEXT NOT NULL,
  verifier TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL,
  notice_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- The manager's mapping, never guessed: income by kind of sale -> an account code; the tax rate -> a tax type; how it was
-- paid -> a bank or clearing account code. `kind` and `key` are lib/accounting-push.ts's (a category such as "Court hire",
-- a rate such as "rate:8" or "none", a method such as "cash").
CREATE TABLE IF NOT EXISTS accounting_mappings (
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'tax', 'payment')),
  key TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  PRIMARY KEY (venue_id, kind, key)
);

-- The organisation's chart of accounts and tax rates as Xero last said them (read-only, to fill the mapping screen's lists).
CREATE TABLE IF NOT EXISTS accounting_chart (
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'tax')),
  body TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, kind)
);

-- The outbound queue, like the outbox: one row per document of the journal (a receipt or a credit note), unique by its
-- `source_ref` so the same sale is never queued twice, even after a crash. A sale is pushed in steps (the invoice, then its
-- payment; a credit note, then its refund) and each step's result is kept the moment Xero answers, so a retry resumes after
-- the last one and Xero's own Idempotency-Key makes a replay of a step that did land harmless.
CREATE TABLE IF NOT EXISTS accounting_queue (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  -- What the journal said, as it was when queued (amounts in cents, never floats).
  number TEXT NOT NULL,
  category TEXT NOT NULL,
  day TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  gross_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  tax_rate NUMERIC(5,2),
  method TEXT,
  -- A line's words: the kind of sale and where, never whom it was for.
  description TEXT NOT NULL,
  -- For a credit note: the document it reverses (a `source_ref`), if the journal says which.
  original_ref TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'held', 'skipped')),
  -- Why it is held (the mapping keys it lacks, comma-separated) or skipped (a reason code).
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  -- The last problem, as a code the dashboard says in the staff language, and Xero's own words (names taken out).
  error_code TEXT,
  error_detail TEXT,
  -- The organisation it went to, and what Xero holds for it.
  tenant_id TEXT,
  xero_id TEXT,
  xero_number TEXT,
  xero_total_cents INTEGER,
  xero_tax_cents INTEGER,
  xero_payment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (venue_id, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_accounting_queue_due ON accounting_queue (venue_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_accounting_queue_day ON accounting_queue (venue_id, day);
