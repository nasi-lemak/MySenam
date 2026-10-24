-- How long matches are given on court, by stage: {"group": 30, "knockout": 45,
-- "final": 60, "heat": 20}. A stage not named takes the tournament's (the
-- division's) match_minutes. The knockout's last round and its third-place
-- match are "final".
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS stage_minutes TEXT;

-- Each match's own length, set at the draw from the above and changed only by
-- an organiser moving or lengthening that fixture. Null on matches drawn
-- before: they take the tournament's match_minutes.
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS minutes INTEGER CHECK (minutes IS NULL OR minutes BETWEEN 5 AND 600);

-- A knockout's optional third-place match: the two semi-final losers play it.
-- A semi-final's loser goes to loser_next_match_id, as its winner goes to
-- next_match_id. placement = 3 marks the match itself.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS third_place INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS placement INTEGER CHECK (placement IS NULL OR placement = 3);
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS loser_next_match_id INTEGER REFERENCES tournament_matches(id) ON DELETE SET NULL;
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS loser_next_slot TEXT CHECK (loser_next_slot IS NULL OR loser_next_slot IN ('a', 'b'));

-- On the day: who has arrived, marked by staff.
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS checked_in_at TEXT;
-- A declared minor's parent or guardian, and when they gave consent (as the
-- entrant declared it: not verified by the app).
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS guardian_name TEXT;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS guardian_consent_at TEXT;
-- An organiser's own check of eligibility (an age seen on a document at the
-- desk, say). The document itself is never recorded.
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS eligibility_checked_at TEXT;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS eligibility_checked_by TEXT;

-- An official's link stops working at the end of this day (the venue's time).
ALTER TABLE tournament_officials ADD COLUMN IF NOT EXISTS expires_on TEXT;
