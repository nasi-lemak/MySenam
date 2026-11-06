-- Audit 9, B6/B7/B13/E5/E6/E12 (ADR 0060): waiting-list offers.
--
-- The window a waiting-list offer lasts is the venue's own (default 30 minutes, as it always was), shortened for an offer made
-- close to the start of what it is for: the minutes this offer was actually given are kept on it (`offer_minutes`, null on one
-- made before this: 30), so an offer ends when it was told it would, whatever the venue's setting is changed to afterwards.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS waitlist_offer_minutes INTEGER NOT NULL DEFAULT 30
  CHECK (waitlist_offer_minutes BETWEEN 5 AND 120);
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS offer_minutes INTEGER;

-- When an offer ran out unclaimed (null on one that ran out before this): what the person is told, once, that the place has passed on.
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS offer_lapsed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_waitlist_offer_lapsed ON waitlist (offer_lapsed_at) WHERE offer_lapsed_at IS NOT NULL;
