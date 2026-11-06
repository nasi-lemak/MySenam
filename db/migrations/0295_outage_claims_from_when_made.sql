-- A court taken out of service from today claims the court from the moment it was taken out, not from midnight: the
-- hours already played (or under way and then cancelled) on its first day are history and never stand in the way of
-- the outage, and ending it later claims the same time again (lib/outages.ts `claimOutage`; docs/features/booking.md,
-- "A court out of service"). NULL, as for every outage made before this: from the start of its first business day.
ALTER TABLE court_outages ADD COLUMN IF NOT EXISTS claimed_from TIMESTAMPTZ;
