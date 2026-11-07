-- Second-factor attempts counted before they are checked (ADR 0064, audit A14), per account and per address, in the database so every
-- instance and every parallel request sees one count (lib/two-factor.ts `countAttempt`).
--
-- One row per account and address (the address as a keyed hash, never the address itself), and one per account as a whole
-- (`address_key = '*'`). `attempts` is bumped by one atomic upsert before the code is looked at; a row past its limit refuses the attempt
-- without checking the code, until `reset_at` (epoch milliseconds, a fixed window that failing again does not extend) passes and it
-- starts again at one. A right code clears the address's row and gives the account's one back. Nothing here is a permanent lock: every
-- limit ends by itself, and a reset of the account's two-factor sign-in (lib/two-factor-reset.ts) clears them at once.
CREATE TABLE IF NOT EXISTS admin_two_factor_attempts (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  address_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  reset_at BIGINT NOT NULL,
  PRIMARY KEY (admin_id, address_key)
);
CREATE INDEX IF NOT EXISTS admin_two_factor_attempts_reset ON admin_two_factor_attempts (reset_at);
