-- A booking can have more than one hand-back at the counter: the difference after a paid
-- booking was moved cheaper (once per move, migration 0324), a share after an outage, and
-- finally a cancellation. `counter_payouts.booking_id` was UNIQUE ("one payout per booking",
-- migration 0231), written when a booking had one cancellation and so one hand-back; the
-- second settle or cancel threw on it and left the sum owed for good (found by the
-- cross-domain tests of the 7 November 2026 hardening round).
--
-- Each hand-back is still claimed once, by its own owed row (`settled_at`, and one owed row
-- per cancellation or per move: migration 0325), so the table's own uniqueness is not what
-- guards a double payout. A plain index keeps the lookups by booking fast. Nothing is
-- deleted or rewritten.
ALTER TABLE counter_payouts DROP CONSTRAINT IF EXISTS counter_payouts_booking_id_key;
CREATE INDEX IF NOT EXISTS idx_counter_payouts_booking ON counter_payouts (booking_id);
