-- Hardening round, G19 (ADR 0066): a free hour for regulars is given once, by the database's own rule.
--
-- Each reward is now the Nth one given to a number at a venue (`n`), and (venue, number, N) is unique, so two runs of the grant
-- (two instances, a lease lost mid-run, a retry) that both find the same reward due cannot both record it: the second one's insert
-- finds the key taken and its pass is never issued (lib/loyalty.ts, one transaction per reward).
--
-- Rewards already given are kept exactly as they are. Each is numbered in the order it was recorded (by id) within its venue and
-- number, so a venue/number that already holds two rewards for one earned hour keeps both, as 1 and 2: nothing is deleted or merged,
-- the index cannot fail on them, and the count the grant works from (rewards given so far) does not change. Whether any of them was a
-- duplicate is for review, by scripts/reconcile-loyalty.sql (docs/features/pricing.md#a-free-hour-for-regulars).
-- A row written by an older build during a rolling deploy has no `n` (NULL keys are never equal), and only counts.
ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS n INTEGER;
UPDATE loyalty_rewards lr
   SET n = numbered.n
  FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY venue_id, phone_key ORDER BY id) AS n FROM loyalty_rewards) numbered
 WHERE lr.id = numbered.id AND lr.n IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_rewards_venue_phone_n ON loyalty_rewards (venue_id, phone_key, n);
