-- Each venue's time zone, an IANA name (Asia/Kuching, America/New_York).
-- NULL, the usual case, means "where the map pin is", worked out from the pin
-- whenever it is needed, so moving the pin moves the zone; with no pin, the
-- install's. Staff choosing one stores it here, and a moved pin leaves it be.
-- Times on the courts stay as they were, wall-clock times at the venue.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS time_zone TEXT;
