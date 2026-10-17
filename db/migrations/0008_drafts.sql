-- Businesses sign themselves up and set up straight away; going live is what
-- the platform owner approves.
--
-- published_at   when customers could first reach the venue. NULL: a draft,
--                which only its own staff see. Venues already here, and any
--                the platform owner makes by hand, are live from the start.
-- suspended_at   when it was taken off the marketplace for an invoice long
--                overdue (lib/listing.ts). NULL again once it is paid.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS published_at TEXT DEFAULT datetime('now');
ALTER TABLE venues ADD COLUMN IF NOT EXISTS suspended_at TEXT;

-- An application now opens an account and a draft venue as soon as its email
-- is confirmed, and stays as that venue's record: 'draft' while it is set up,
-- 'pending' once it asks to go live, then 'approved' or 'rejected' — and a
-- rejected one may ask again.
ALTER TABLE venue_applications DROP CONSTRAINT IF EXISTS venue_applications_status_check;
ALTER TABLE venue_applications ADD CONSTRAINT venue_applications_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'rejected'));

-- When somebody last signed in, so a draft nobody has come back to can go.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_seen_at TEXT;

-- Sign-ups still waiting for their email to be confirmed are drafts-to-be,
-- not requests to go live.
UPDATE venue_applications SET status = 'draft' WHERE status = 'pending' AND email_check = 'waiting';
