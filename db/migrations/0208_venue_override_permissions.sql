-- Which of a venue's booking policies its managers may override for one
-- booking at the counter (lib/policy-overrides.ts; ADR 0026;
-- docs/features/booking.md#the-same-policies-on-every-path).
--
-- Customer, counter and API bookings are held to the same venue policies
-- (the owner's decision of 28 October 2026). A venue may let its managers,
-- and only its managers, go past some operational restrictions for one
-- booking, with a reason that is kept: the house rules' limits, no-show
-- strikes, the guest limit, and an assisted booking (a weekly booking for a
-- customer without an account). Every one is off until a manager turns it
-- on, one row per policy turned on. A refused number, the unpaid-bookings
-- limit, eligibility, capacity, safety prerequisites and payment are never
-- overridable, and have no row to turn on.
CREATE TABLE IF NOT EXISTS venue_override_permissions (
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  policy TEXT NOT NULL CHECK (policy IN ('house_rules', 'strikes', 'guest_surge', 'assisted')),
  granted_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, policy)
);
