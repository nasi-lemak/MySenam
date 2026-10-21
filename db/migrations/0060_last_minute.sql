-- Cheaper hours close to their start (lib/peak.ts, computePrice): an hour still
-- free within this many hours of starting costs this percent less, for a
-- booking made then. NULL: no last-minute prices.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS last_minute_hours INTEGER CHECK (last_minute_hours IS NULL OR last_minute_hours BETWEEN 1 AND 24);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS last_minute_percent INTEGER CHECK (last_minute_percent IS NULL OR last_minute_percent BETWEEN 5 AND 50);
-- Only off-peak hours, so a full Friday evening is never sold cheap.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS last_minute_off_peak INTEGER NOT NULL DEFAULT 1;
