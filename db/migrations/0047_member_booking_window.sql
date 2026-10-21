-- Members of a venue may book further ahead than everybody else: how many
-- days ahead they may. NULL: the same window as everybody.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS member_ahead_days INTEGER;
