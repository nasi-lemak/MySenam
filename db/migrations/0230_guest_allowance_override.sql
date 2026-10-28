-- A member's or resident's guest allowance as a policy a venue may let its
-- managers override for one booking at the counter (lib/policy-overrides.ts;
-- ADR 0026; docs/features/booking.md#manager-overrides): the guests each may
-- have on the list at once, and how long a guest's visit may run. Off until a
-- manager turns it on, as every other.
ALTER TABLE venue_override_permissions DROP CONSTRAINT IF EXISTS venue_override_permissions_policy_check;
ALTER TABLE venue_override_permissions ADD CONSTRAINT venue_override_permissions_policy_check
  CHECK (policy IN ('house_rules', 'strikes', 'guest_surge', 'assisted', 'guest_allowance'));
ALTER TABLE booking_policy_overrides DROP CONSTRAINT IF EXISTS booking_policy_overrides_policy_check;
ALTER TABLE booking_policy_overrides ADD CONSTRAINT booking_policy_overrides_policy_check
  CHECK (policy IN ('house_rules', 'strikes', 'guest_surge', 'assisted', 'guest_allowance'));
