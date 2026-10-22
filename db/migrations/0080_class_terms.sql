-- Class terms (lib/store.ts `enrolInTerm`): a weekly class can be joined for
-- every session left at once, one confirmation and one bill, at a share off
-- each session where the venue offers one for the whole term.
ALTER TABLE classes ADD COLUMN IF NOT EXISTS term_off_percent INTEGER CHECK (term_off_percent BETWEEN 0 AND 50);
