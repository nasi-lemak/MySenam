-- Post-audit hardening, D6 / DEC-34 (ADR 0071): a membership keeps the benefits it was sold with.
--
-- Until now a membership's price level, booking window, price scope, entry admission and suspension rule were read live from its
-- tier (`membership_plans`), so editing a tier changed terms members had already paid for. A membership now carries a snapshot of
-- those benefits, taken when the term is sold (a new purchase, a renewal charge or a counter sale), and every reader uses it.
--
-- `membership_plans.version` is the tier's version: 1 until its benefits are edited, then one more on each edit that changes a
-- benefit the snapshot holds. `memberships.benefits` is the snapshot (JSONB: ratePercent, aheadDays, scope, admitsEntry,
-- admitsEntrySport, extendOnSuspension), `benefits_version` the tier version it was taken at, and `benefits_source` where it came
-- from: `sold` (taken at the sale) or `backfilled` (migration 0338: a term sold before this existed, given the benefits of its
-- tier as they stand when the migration ran, which is what it was getting; earlier terms are never reconstructed).
-- NULL `benefits` (a row written by something that does not know the column) is read as the tier's current benefits.
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS benefits JSONB;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS benefits_version INTEGER;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS benefits_source TEXT;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_benefits_source_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_benefits_source_check
  CHECK (benefits_source IS NULL OR benefits_source IN ('sold', 'backfilled')) NOT VALID;
ALTER TABLE memberships VALIDATE CONSTRAINT memberships_benefits_source_check;
