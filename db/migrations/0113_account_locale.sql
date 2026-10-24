-- The language a company or school account's invoices are written in (one of
-- the install's languages); empty means the install's first.
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS locale TEXT;
