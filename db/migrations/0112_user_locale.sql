-- The language an account last used the site in, so emails about its games,
-- tournaments, leagues and groups are written in it. Null until they first
-- sign in after this change: the install's first language until then.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT;
