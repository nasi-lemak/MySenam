-- Kinds of kit under one heading: "Kayaks" over "Single kayak" and "Double
-- kayak". Resources at a venue with the same heading are shown together
-- beneath it; each is still a resource of its own, booked and counted apart
-- (lib/resources.ts). Null: shown on its own, as before.
ALTER TABLE courts ADD COLUMN IF NOT EXISTS heading TEXT
  CHECK (heading IS NULL OR (length(heading) BETWEEN 2 AND 40));
