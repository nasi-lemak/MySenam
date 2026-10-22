-- Membership tiers (lib/membership-plans.ts): a plan can carry benefits of
-- its own over the venue's member rates and booking window. Gold pays 70% of
-- the public price and books 30 days ahead; Silver pays 85% and books 14.
-- NULL: the venue's (each court's member rates, the venue's members' window).
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS rate_percent INTEGER CHECK (rate_percent BETWEEN 10 AND 99);
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS ahead_days INTEGER CHECK (ahead_days BETWEEN 1 AND 90);
-- Which tier a membership is on, however it was sold (plan_id stays "bought online on this plan").
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS tier_id INTEGER REFERENCES membership_plans(id) ON DELETE SET NULL;
UPDATE memberships SET tier_id = plan_id WHERE tier_id IS NULL AND plan_id IS NOT NULL;
