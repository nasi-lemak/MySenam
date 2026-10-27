-- Whom a membership plan is sold to online (docs/features/pricing.md#joining-online;
-- lib/membership-purchases.ts).
--
-- A plan said what its member's price covers (`scope`, migration 0156); it now
-- also says whom a customer may buy it for, online:
--
-- * `account`: the account holder themself, on their own number (every plan
--   so far, which keeps selling exactly as it did);
-- * `participant`: somebody the account is an active guardian of (a junior
--   plan): the participant's own membership, sold on the guardian's number;
-- * `individual`: either of those, one person;
-- * `family`: the account holder and the dependants they name, each somebody
--   the account is an active guardian of, up to the plan's `family_limit`
--   (at most 12, as at the counter).
--
-- At the counter staff sell any plan to anyone, as before.

ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS offered_for TEXT NOT NULL DEFAULT 'account';
ALTER TABLE membership_plans DROP CONSTRAINT IF EXISTS membership_plans_offered_for;
ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_offered_for
  CHECK (offered_for IN ('account', 'participant', 'individual', 'family'));
UPDATE membership_plans SET offered_for = 'account' WHERE offered_for IS DISTINCT FROM 'account';

-- How many dependants a family plan covers besides its holder: a family plan's only.
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS family_limit INTEGER;
ALTER TABLE membership_plans DROP CONSTRAINT IF EXISTS membership_plans_family_limit;
ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_family_limit
  CHECK ((offered_for = 'family') = (family_limit IS NOT NULL) AND (family_limit IS NULL OR family_limit BETWEEN 1 AND 12));
