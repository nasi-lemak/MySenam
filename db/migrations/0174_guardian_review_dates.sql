-- A manager's reminders (lib/contact-guardians.ts guardianAttention): an
-- exception's date to look at it again, once it has come, for a relationship
-- it made that still stands.
CREATE INDEX IF NOT EXISTS idx_guardian_requests_review_on ON guardian_requests (exception_review_on)
  WHERE status = 'active' AND exception_review_on IS NOT NULL;
