-- The platform's monthly invoice to a venue is told to the venue's managers when it is issued, and again before it falls due
-- (audit 9, G14), once each: stamped here after the emails are written (the outbox's own dedupe key makes a repeat after a stop
-- write nothing twice). `warned_at` (0009) is the overdue warning, as before.
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS issued_notified_at TEXT;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS due_soon_notified_at TEXT;
-- Invoices issued before this change were never told: they are not told now (a week-old invoice is not "just issued").
UPDATE venue_invoices SET issued_notified_at = datetime('now') WHERE issued_notified_at IS NULL;
