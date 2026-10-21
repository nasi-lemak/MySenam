-- "Don't show again for this venue": a signed-in customer has read a venue's
-- booking rules. Keyed on what the rules said (version), so a change to them
-- shows them again.
CREATE TABLE IF NOT EXISTS terms_dismissals (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  dismissed_at TEXT NOT NULL DEFAULT datetime('now'),
  PRIMARY KEY (user_id, venue_id)
);
