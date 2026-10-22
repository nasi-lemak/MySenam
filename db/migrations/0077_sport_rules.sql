-- Rules for one sport at a venue, over the venue's own (lib/sport-rules.ts):
-- tennis cancelled a day ahead while badminton is two hours, or pickleball's peak
-- starting at 5 PM. NULL in any column: the venue's rule.
CREATE TABLE IF NOT EXISTS sport_rules (
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  sport TEXT NOT NULL,
  cancel_cutoff_hours INTEGER CHECK (cancel_cutoff_hours BETWEEN 0 AND 72),
  -- Percent kept on a late cancellation online; -1: no cancelling online after the cutoff.
  late_keep INTEGER CHECK (late_keep = -1 OR late_keep BETWEEN 0 AND 100),
  peak_weekday_from INTEGER,
  peak_weekday_until INTEGER,
  peak_weekend_from INTEGER,
  peak_weekend_until INTEGER,
  PRIMARY KEY (venue_id, sport)
);
