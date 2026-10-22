-- Courts priced per player (a pickleball court at RM8 a head an hour): the
-- court's rates are per player, and a booking says how many play
-- (lib/store.ts `courtPrice`). Every other court is priced for the court, as
-- before, and its bookings count one.
ALTER TABLE courts ADD COLUMN IF NOT EXISTS per_player SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE courts ADD COLUMN IF NOT EXISTS max_players INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS players INTEGER NOT NULL DEFAULT 1 CHECK (players BETWEEN 1 AND 50);
