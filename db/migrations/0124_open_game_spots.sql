-- An open game looks for up to ten players, or as many more as the venue
-- lets one booking on that court take, less the host (lib/court-activities.ts
-- `mostSpots`). The application checks the court's own limit; the database
-- keeps the widest any court can allow: every place of the largest resource.
ALTER TABLE open_games DROP CONSTRAINT IF EXISTS open_games_spots_check;
ALTER TABLE open_games ADD CONSTRAINT open_games_spots_check CHECK (spots BETWEEN 1 AND 499);
