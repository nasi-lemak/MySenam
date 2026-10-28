-- E-invoices name nobody in their lines, and are kept for the statutory
-- period (the owner's decisions 1 and 2 of 28 October 2026;
-- docs/integrations/myinvois.md#names-in-what-is-sent,
-- docs/architecture/privacy.md#e-invoice-records).
--
-- 1. The lines of an e-invoice not yet sent never carry participants' or
--    coaches' names: a customer's own, and a large sale's, say the receipt's
--    number and the kind of sale (`Receipt R-000012: memberships`), whatever
--    the venue's setting. The setting migration 0220 added for it is retired:
--    the column stays, readable, and nothing reads or writes it any more. A
--    document already sent keeps what it said (migration 0220's trigger).

COMMENT ON COLUMN einvoice_settings.leave_names_out IS
  'Retired by migration 0225: e-invoice lines never name people, whatever this says. Kept readable; not read or written by MySenam.';

-- 2. How long e-invoice records are kept: the install's one setting, in years
--    from each document's issue (when it was sent to LHDN). The default, 7,
--    is the owner's provisional reading of Malaysia's record-keeping period,
--    pending legal verification; the code's floor is the same 7 years, and a
--    shorter period is set only with a recorded review (who advised it, on
--    what authority as they state it, their firm, the day, where the written
--    advice is kept, and its basis: lib/einvoice-retention.ts). A review is
--    the platform owner's record of what a reviewer advised, never a
--    verification by MySenam; changing the period lapses it. Every change,
--    review and lapse goes in retention_policy_events, never pruned.
CREATE TABLE IF NOT EXISTS einvoice_retention (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  years INTEGER NOT NULL DEFAULT 7 CHECK (years BETWEEN 5 AND 20),
  changed_at TIMESTAMPTZ,
  changed_by_name TEXT,
  -- The review in force, absent until the platform owner records one.
  review_jurisdiction TEXT CHECK (review_jurisdiction IN ('MY', 'SG')),
  reviewer_name TEXT,
  reviewer_role TEXT,
  review_firm TEXT,
  reviewed_on TEXT,
  advice_reference TEXT,
  review_basis TEXT,
  review_recorded_by_name TEXT,
  review_recorded_at TIMESTAMPTZ,
  CHECK (
    (reviewer_name IS NULL) = (reviewed_on IS NULL)
    AND (reviewer_name IS NULL) = (review_basis IS NULL)
    AND (reviewer_name IS NULL) = (advice_reference IS NULL)
    AND (reviewer_name IS NULL) = (review_jurisdiction IS NULL)
  )
);
INSERT INTO einvoice_retention (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- When the retention run cleared a sent document past the period: its
-- stored payload, the buyer's details and LHDN's reasons as given are gone;
-- what the books need stays (number, kind, dates, total, the receipts it
-- covered, LHDN's submission ID, UUID and long ID, what it corrects and
-- replaces, its last state). Set once, by the retention run only
-- (migration 0226).
ALTER TABLE e_invoices ADD COLUMN IF NOT EXISTS cleared_at TEXT;
