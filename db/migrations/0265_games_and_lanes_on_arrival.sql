-- Selling by the game, and a lane given on arrival (docs/features/booking.md#by-the-game-and-a-lane-given-on-arrival;
-- docs/features/activities.md). Both are booking rules, set at any level of a venue's booking policies like the rest,
-- and given by the activity catalogue to an activity that is usually sold so (bowling):
--
-- * game_minutes: the venue's estimate of one game for one player, in minutes; with it, the time is sold by the game
--   (0 at a level is "by time", over a level beneath that sells by the game). game_minutes_each: more for each further
--   player. The booking holds the resource for the games times that estimate, rounded up to the length step.
-- * max_games: the most games one booking may be for.
-- * game_price, game_peak_price: the price of a game (for each player, on a resource priced per player); none set, a
--   game booking costs the time it holds at the resource's rates.
-- * lane_on_arrival: the booking holds one lane, so the claims still refuse an overlap, but the lane is provisional:
--   the customer is told a lane is given when they arrive, and the desk may put them on any lane free then.
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS game_minutes INTEGER CHECK (game_minutes IS NULL OR game_minutes BETWEEN 0 AND 240);
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS game_minutes_each INTEGER CHECK (game_minutes_each IS NULL OR game_minutes_each BETWEEN 0 AND 240);
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS max_games INTEGER CHECK (max_games IS NULL OR max_games BETWEEN 1 AND 20);
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS game_price NUMERIC(10, 2) CHECK (game_price IS NULL OR game_price >= 0);
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS game_peak_price NUMERIC(10, 2) CHECK (game_peak_price IS NULL OR game_peak_price >= 0);
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS lane_on_arrival BOOLEAN;

-- What a booking was sold as: how many games (null: by time), and whether its lane is given on arrival, as the rules
-- said when it was made. A provisional lane is shown to staff, never to the customer before check-in.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS games INTEGER CHECK (games IS NULL OR games >= 1);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lane_on_arrival BOOLEAN NOT NULL DEFAULT false;
