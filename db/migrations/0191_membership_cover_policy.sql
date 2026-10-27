-- How whom a family membership covers may change within one term
-- (docs/features/pricing.md#changing-whom-a-family-membership-covers;
-- lib/membership-purchases.ts). The owner's decision of 27 October 2026:
-- dependants are not freely swappable.
--
-- A family plan names up to `family_limit` dependants besides its holder
-- (migration 0167). Within one term (one membership), the account that
-- bought it may add people while the term has places left, and take people
-- off at any time; every person added uses a place for the rest of the term,
-- and taking somebody off gives none back. `cover_swaps` is how many places
-- more than the limit a term has, so that somebody taken off can be replaced:
-- none unless the venue says so (the conservative default). Anything beyond
-- that waits for the next term. A manager correcting a wrongly entered person
-- uses no place (lib/membership-purchases.ts correctCover).
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS cover_swaps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE membership_plans DROP CONSTRAINT IF EXISTS membership_plans_cover_swaps;
ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_cover_swaps
  CHECK (cover_swaps BETWEEN 0 AND 12 AND (offered_for = 'family' OR cover_swaps = 0));

-- The plan's limit and replacements as each family membership was sold, so a
-- plan changed later does not change a term already paid for. NULL: sold
-- before this, or at the counter on no family plan: the plan's own, and no
-- replacements.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS cover_limit INTEGER;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_cover_limit;
ALTER TABLE memberships ADD CONSTRAINT memberships_cover_limit CHECK (cover_limit IS NULL OR cover_limit BETWEEN 1 AND 12);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS cover_swaps INTEGER;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_cover_swaps;
ALTER TABLE memberships ADD CONSTRAINT memberships_cover_swaps CHECK (cover_swaps IS NULL OR cover_swaps BETWEEN 0 AND 12);
