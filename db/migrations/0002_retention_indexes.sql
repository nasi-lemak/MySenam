-- Indexes for the daily retention prune, so it reads what is due and nothing
-- else. Without them each run scans whole tables — every check-in, every door
-- code shown, every message ever sent — which is fine for one venue and a
-- minutes-long daily job for a marketplace with years of history.
--
-- Timestamps are 'YYYY-MM-DD HH:MM:SS' text, so "before a date" is a plain
-- comparison with 'YYYY-MM-DD' and these serve it directly.

CREATE INDEX IF NOT EXISTS idx_check_ins_at ON check_ins(checked_in_at);
CREATE INDEX IF NOT EXISTS idx_access_reveals_at ON access_reveals(revealed_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

-- Bookings that still name somebody. Once a booking is anonymised it leaves
-- this index, so the daily pass finds the few that have just come due instead
-- of walking every booking older than the cut-off, every day, for ever.
CREATE INDEX IF NOT EXISTS idx_bookings_identified ON bookings(date) WHERE name <> '(removed)';
