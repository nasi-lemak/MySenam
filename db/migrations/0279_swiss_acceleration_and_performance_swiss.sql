-- Swiss: accelerated pairing, the tie-break sequence, and Swiss for counted performance events
-- (docs/architecture/decisions/0038-swiss-acceleration-tie-break-screen-and-performance-swiss.md;
-- docs/features/tournaments.md#swiss-tournaments, #swiss-for-performance-events; lib/swiss.ts, lib/swiss-performances.ts).

-- Accelerated pairing, chosen before the draw and stored at it so the event reads what it was drawn with: the number of rounds paired
-- with virtual points (0: off), how many of the initial order's best are in the accelerated group (an even number, 2 * ceil(n / 4),
-- fixed at the draw so a withdrawal does not move anybody in or out), and the virtual points each carries (a win's table points).
-- Virtual points are used only to pair; they are in no table, result or rating.
ALTER TABLE swiss_events ADD COLUMN IF NOT EXISTS accel_rounds INTEGER NOT NULL DEFAULT 0 CHECK (accel_rounds BETWEEN 0 AND 126);
ALTER TABLE swiss_events ADD COLUMN IF NOT EXISTS accel_group INTEGER NOT NULL DEFAULT 0 CHECK (accel_group >= 0);
ALTER TABLE swiss_events ADD COLUMN IF NOT EXISTS accel_points INTEGER NOT NULL DEFAULT 0 CHECK (accel_points BETWEEN 0 AND 10);

-- A counted performance event played in Swiss rounds keeps its recorded seed, rounds and round notes in the same two tables as a
-- head-to-head Swiss event (its tiebreaks '[]' and bye points 0: it has neither), and how its rounds' placings add up here, fixed
-- at the draw: 'sum_of_placings' or 'best_n' (with `best_n` the number of best placings that count).
ALTER TABLE swiss_events ADD COLUMN IF NOT EXISTS cumulative TEXT CHECK (cumulative IN ('sum_of_placings', 'best_n'));
ALTER TABLE swiss_events ADD COLUMN IF NOT EXISTS best_n INTEGER CHECK (best_n BETWEEN 1 AND 127);

-- A performance-Swiss round grouped before a correction: a manager who has reviewed what the corrected standings would group differently and
-- chosen to keep the grouping records which expected grouping they looked at (a fingerprint), so the flag stays off until the standings
-- change again. Nothing here ever moves a competitor.
ALTER TABLE swiss_rounds ADD COLUMN IF NOT EXISTS kept_for TEXT;
