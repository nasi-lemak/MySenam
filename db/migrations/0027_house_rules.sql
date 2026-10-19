-- A venue's fair-use rules for customers booking online. NULL: no limit.
-- Counted per person, or per household where the venue's list gives people
-- the same unit (venue_access_list.label). Staff at the counter are not held
-- to them.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS limit_upcoming INTEGER CHECK (limit_upcoming IS NULL OR limit_upcoming BETWEEN 1 AND 50);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS limit_per_week INTEGER CHECK (limit_per_week IS NULL OR limit_per_week BETWEEN 1 AND 50);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS limit_per_day INTEGER CHECK (limit_per_day IS NULL OR limit_per_day BETWEEN 1 AND 20);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS book_ahead_days INTEGER CHECK (book_ahead_days IS NULL OR book_ahead_days BETWEEN 0 AND 60);
CREATE INDEX IF NOT EXISTS idx_bookings_phone_key_date ON bookings (phone_key, date) WHERE status = 'confirmed';
