-- Two-factor sign-in for staff: a time-based code from an authenticator app
-- (RFC 6238) after the password. The secret is sealed like the payment keys;
-- `totp_last_step` refuses the same code twice; recovery codes are kept only
-- as hashes, each struck off once used.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_pending TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled_at TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS recovery_codes TEXT;

-- Between the password and the code: who got the password right, briefly.
CREATE TABLE IF NOT EXISTS admin_login_tickets (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
