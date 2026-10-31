-- The venue guide's intent: what a venue's manager told the setup journey, and
-- what they said they had reviewed or did not want to hear about
-- (docs/features/venue-guide.md, ADR 0028).
--
-- The guide is a read model over the venue's real configuration; nothing
-- about how the venue is set up is kept here. Only the operator's own words
-- are new data:
--   answers       the discovery questions' answers (src/lib/guide/answer-schema.ts),
--                 validated, versioned, and replaced key by key;
--   acknowledged  steps the manager said they had reviewed, a judgement no
--                 saved state can show: { stepId: { at, byAdminId, byName } };
--   dismissed     suggestions they asked not to see again: { id: { at } };
--   rev           a revision number every write moves on, so two people
--                 saving at once cannot overwrite each other unseen.
-- One row per venue (a venue that has never answered has none), removed with
-- the venue. It holds no personal data beyond the name of the staff member who
-- acknowledged, kept as it was the way the staff activity log keeps names.
-- A branch started from another's set-up (lib/branch-copy.ts) gets no row:
-- it is its own venue with its own intent.
CREATE TABLE IF NOT EXISTS venue_guide (
  venue_id INTEGER PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged JSONB NOT NULL DEFAULT '{}'::jsonb,
  dismissed JSONB NOT NULL DEFAULT '{}'::jsonb,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT datetime('now'),
  updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL
);

-- What a visitor chose in the public guide before applying (a JSON object of
-- business types and activities, validated by `normaliseFit`): kept with the
-- application, and copied into `venue_guide.answers` as the starting intent
-- when the application opens the venue. Business types and activity keys
-- only; nothing about a person.
ALTER TABLE venue_applications ADD COLUMN IF NOT EXISTS fit TEXT;
