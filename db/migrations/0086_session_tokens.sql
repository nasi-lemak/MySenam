-- Sessions keep the SHA-256 of their token rather than the token, so a backup
-- or a read of these tables hands out no live sign-in (lib/auth.ts, sessionKey);
-- and their expiry in the form datetime('now') has, so the two compare to the
-- second rather than to the day. Sessions already issued keep working.
UPDATE sessions
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex'),
       expires_at = replace(substr(expires_at, 1, 19), 'T', ' ');

UPDATE admin_sessions
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex'),
       expires_at = replace(substr(expires_at, 1, 19), 'T', ' ');
