-- Checking that a venue asking to join is where it says it is, and that the
-- person asking can be reached at the email they gave.
--
-- lat, lng          the pin the applicant dropped on the map
-- found_lat, ...    where the address they typed leads, looked up when they
--                   applied (NULL: not found, or the install looks nothing up)
-- pin_place         what is at the pin, by the same lookup, to set beside the
--                   area they named
-- email_check       'waiting'   a link was emailed and not yet followed; the
--                               platform owner does not see it until it is
--                   'confirmed' they followed it
--                   'unsent'    the install cannot send email, so nobody asked
--                   'account'   a branch asked for by a signed-in manager
--                   'not asked' applied before any of this existed
-- review_checks     what the platform owner ticked before approving, comma
--                   separated, or 'auto' for a branch approved on its own
ALTER TABLE venue_applications
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS found_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS found_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pin_place TEXT,
  ADD COLUMN IF NOT EXISTS email_check TEXT NOT NULL DEFAULT 'not asked'
    CHECK (email_check IN ('waiting', 'confirmed', 'unsent', 'account', 'not asked')),
  ADD COLUMN IF NOT EXISTS email_token TEXT,
  ADD COLUMN IF NOT EXISTS review_checks TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_venue_applications_email_token ON venue_applications(email_token)
  WHERE email_token IS NOT NULL;

-- Where a venue is, from the pin it was approved with. NULL for venues that
-- joined before pins, until somebody sets one.
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
