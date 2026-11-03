-- Counted performances (docs/features/tournaments.md#counted-performances; lib/counted-performances.ts): a
-- competitor's result in a heat or a final may be a set of counts instead of one mark. Bouldering: for each boulder,
-- the attempt on which the zone was reached and the attempt on which it was topped; climbing by height: the highest
-- hold and the attempts. The counts are the judge's record of what happened, kept as entered, one JSON array with an
-- element per boulder or route; what they rank is worked out from them each time (never stored), so a corrected count
-- re-ranks the round with nothing to drift. `result` still carries a number for the line (tops, or the height) so that
-- queries that ask whether a line has a result keep working; `attempts` is unused by a counted line.
ALTER TABLE tournament_performances ADD COLUMN IF NOT EXISTS counts TEXT;
