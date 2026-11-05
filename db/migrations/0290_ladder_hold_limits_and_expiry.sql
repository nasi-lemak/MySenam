-- The owner's decision of 5 November 2026 on court time held for ladder challenges (docs/architecture/decisions/0048-ladder-hold-limits-and-expiry.md;
-- docs/features/tournaments.md#court-time-held-by-the-venue-an-optional-setting-per-ladder; lib/ladder-holds.ts):
--   1. the caps become configurable defaults: install default -> venue setting -> ladder override, inside install-data bounds;
--   2. a hold is tentative until both players (or a manager) confirm it, and expires, by the scheduler and lazily on every read and claim;
--   3. no two live holds on one court overlap, as a backstop under the claims exclusion constraints.
-- Everything is additive. A hold made before this migration has no `confirm_by`: it is confirmed, exactly as it was.

-- ---------------------------------------------------------------- install data: bounds and the expiry windows

-- The caps themselves (max_live_per_ladder, max_per_player_week) stay what they were: the install defaults, seeded 8 and 4.
-- Bounds: the least and most a venue or a ladder may set. A value outside them is refused with the bounds.
ALTER TABLE ladder_hold_limits ADD COLUMN IF NOT EXISTS live_min INTEGER NOT NULL DEFAULT 1 CHECK (live_min >= 1);
ALTER TABLE ladder_hold_limits ADD COLUMN IF NOT EXISTS live_max INTEGER NOT NULL DEFAULT 50 CHECK (live_max <= 200);
ALTER TABLE ladder_hold_limits ADD COLUMN IF NOT EXISTS week_min INTEGER NOT NULL DEFAULT 1 CHECK (week_min >= 1);
ALTER TABLE ladder_hold_limits ADD COLUMN IF NOT EXISTS week_max INTEGER NOT NULL DEFAULT 20 CHECK (week_max <= 50);
-- Expiry: how long players have to confirm a hold (never past the match's start minus the minimum notice), the notice, and the longest a
-- manager may extend an unconfirmed hold once.
ALTER TABLE ladder_hold_limits ADD COLUMN IF NOT EXISTS confirm_hours INTEGER NOT NULL DEFAULT 48 CHECK (confirm_hours BETWEEN 1 AND 720);
ALTER TABLE ladder_hold_limits ADD COLUMN IF NOT EXISTS min_notice_minutes INTEGER NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 4320);
ALTER TABLE ladder_hold_limits ADD COLUMN IF NOT EXISTS extend_hours INTEGER NOT NULL DEFAULT 24 CHECK (extend_hours BETWEEN 1 AND 168);

-- ---------------------------------------------------------------- the venue's and each ladder's own caps

-- A venue's setting, if a manager made one (NULL in a column: the install default). Its history is the activity log.
CREATE TABLE IF NOT EXISTS venue_ladder_hold_limits (
  venue_id INTEGER PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  max_live_per_ladder INTEGER CHECK (max_live_per_ladder IS NULL OR max_live_per_ladder BETWEEN 1 AND 200),
  max_per_player_week INTEGER CHECK (max_per_player_week IS NULL OR max_per_player_week BETWEEN 1 AND 50)
);

-- A ladder's override (NULL: the venue's, else the install's), and whether a hold has to be confirmed (on unless a manager turns it off).
ALTER TABLE ladders ADD COLUMN IF NOT EXISTS cap_live INTEGER CHECK (cap_live IS NULL OR cap_live BETWEEN 1 AND 200);
ALTER TABLE ladders ADD COLUMN IF NOT EXISTS cap_week INTEGER CHECK (cap_week IS NULL OR cap_week BETWEEN 1 AND 50);
ALTER TABLE ladders ADD COLUMN IF NOT EXISTS needs_confirmation BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------- a hold is tentative until confirmed

-- `confirm_by` NULL: confirmed (a hold of round 10, a manager's, or one on a ladder that does not need confirming). Otherwise the hold
-- is tentative until `confirmed_at`, and lapses at `confirm_by`; its block claims carry the same moment as their `expires_at`, so
-- availability reads ignore it from then on without anything having run (lib/claims.ts `occupantsOn`, `releaseExpiredOffers`).
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS confirm_by TIMESTAMPTZ;
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS confirmed_challenger_at TIMESTAMPTZ;
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS confirmed_challenged_at TIMESTAMPTZ;
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
-- A manager's confirmation (their name), instead of the players'.
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS confirmed_by TEXT;
-- A manager's one extension of the time to confirm, with the reason.
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS extended_at TIMESTAMPTZ;
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS extended_by TEXT;
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS extend_note TEXT;
-- Both players are told once that a hold expired: set when they were (the scheduler), so running it again tells nobody twice.
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS expiry_told_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_ladder_holds_unconfirmed ON ladder_court_holds (confirm_by) WHERE released_at IS NULL AND confirmed_at IS NULL AND confirm_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ladder_holds_untold ON ladder_court_holds (id) WHERE released_reason = 'expired' AND expiry_told_at IS NULL;

-- ---------------------------------------------------------------- no overlap, as a backstop

-- The held time (the match with the court's operational time either side) as an exact range. Two live holds on one court can never overlap,
-- whatever else is true: under the claims constraints that already refuse the blocks, and here, in the table that says who holds what.
-- A hold of round 10 has none (NULL ranges never conflict); the blocks it owns are still under the claims constraints.
ALTER TABLE ladder_court_holds ADD COLUMN IF NOT EXISTS held_during TSTZRANGE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ladder_holds_no_overlap') THEN
    ALTER TABLE ladder_court_holds ADD CONSTRAINT ladder_holds_no_overlap
      EXCLUDE USING gist (int4range(court_id, court_id, '[]') WITH &&, held_during WITH &&)
      WHERE (released_at IS NULL AND court_id IS NOT NULL AND held_during IS NOT NULL);
  END IF;
END
$$;
