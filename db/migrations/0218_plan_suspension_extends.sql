-- Whether a plan's memberships run on by the time they were suspended
-- (lib/membership-suspensions.ts; docs/features/pricing.md#suspending-a-membership).
--
-- Off unless the venue turns it on: suspending a membership does not move
-- its end (the owner's decision of 28 October 2026). On, the days a
-- suspension takes out of the term are added to its end, once, when the
-- suspension's last day is known (set when suspended, or when it is lifted).
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS extend_on_suspension BOOLEAN NOT NULL DEFAULT false;
