-- Women-only and men-only games, tournament categories, leagues and classes
-- (lib/who.ts), and the one thing about a player they decide by.

-- What the player says, asked only when it first matters. NULL: never asked.
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT CHECK (gender IN ('woman', 'man', 'unsaid'));

ALTER TABLE open_games ADD COLUMN IF NOT EXISTS who TEXT NOT NULL DEFAULT 'anyone' CHECK (who IN ('anyone', 'women', 'men'));
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS who TEXT NOT NULL DEFAULT 'anyone' CHECK (who IN ('anyone', 'women', 'men'));
ALTER TABLE classes ADD COLUMN IF NOT EXISTS who TEXT NOT NULL DEFAULT 'anyone' CHECK (who IN ('anyone', 'women', 'men'));

-- Badminton's events: men's, women's, mixed (a woman and a man), or open.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'open'
  CHECK (category IN ('open', 'women', 'men', 'mixed'));
ALTER TABLE tournaments ADD CONSTRAINT tournaments_mixed_is_doubles CHECK (category <> 'mixed' OR team_size = 2);

-- A doubles partner, as the entrant describes them, where the event asks.
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS partner_gender TEXT CHECK (partner_gender IN ('woman', 'man'));
ALTER TABLE league_players ADD COLUMN IF NOT EXISTS partner_gender TEXT CHECK (partner_gender IN ('woman', 'man'));
