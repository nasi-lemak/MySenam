-- One invoice a month per business, with a line for each branch, instead of
-- one per branch. A venue on its own is still invoiced on its own, and
-- invoices already issued stay as they were.
--
-- Both kinds live in venue_invoices, so they share one numbering, and paying
-- online, the gateway's callback, "mark paid" and "void" work on either.
ALTER TABLE venue_invoices ALTER COLUMN venue_id DROP NOT NULL;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id);
ALTER TABLE venue_invoices ADD CONSTRAINT venue_invoices_for_one CHECK ((venue_id IS NULL) <> (business_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS venue_invoices_business_period ON venue_invoices(business_id, period)
  WHERE business_id IS NOT NULL;

-- What each branch contributed to its business's invoice. A branch is billed
-- once a month, whichever kind of invoice it is on.
CREATE TABLE IF NOT EXISTS invoice_lines (
  invoice_id INTEGER NOT NULL REFERENCES venue_invoices(id) ON DELETE CASCADE,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  period TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (venue_id, period)
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);
