-- Built-in texts a venue uses unchanged are kept by key, so each customer
-- reads them in their own language (lib/concessions.ts, lib/enquiries.ts).
--
-- A concession made from a built-in preset (student, senior, child, OKU) and
-- left as it was: its name and proof are shown from the customer
-- dictionaries. Null: the venue's own text, shown as typed. A booking keeps
-- the preset it was made at, as it keeps the name.
ALTER TABLE concessions ADD COLUMN IF NOT EXISTS preset TEXT
  CHECK (preset IS NULL OR preset IN ('student', 'senior', 'child', 'oku'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS concession_preset TEXT
  CHECK (concession_preset IS NULL OR concession_preset IN ('student', 'senior', 'child', 'oku'));
-- The language a hire enquiry was made in, so a reply can be written in it.
-- Null for enquiries made before this was kept.
ALTER TABLE hire_enquiries ADD COLUMN IF NOT EXISTS locale TEXT;
