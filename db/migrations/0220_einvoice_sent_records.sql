-- An e-invoice that reached LHDN is never rewritten (lib/myinvois.ts;
-- docs/integrations/myinvois.md#states-and-what-never-changes).
--
-- "Send again" used to send the same row once more: a document LHDN had
-- found invalid had its stored payload, submission ID, UUID and sent time
-- replaced by the new attempt's. A correction is now a new row, linked to
-- the one it replaces, under its own number; the one LHDN refused or found
-- invalid stays as it was sent, with LHDN's identifiers and reasons.

-- LHDN refused it when it was sent (it has a submission ID but no UUID), as
-- against `failed`, which never reached LHDN; and LHDN reported it cancelled.
ALTER TABLE e_invoices DROP CONSTRAINT IF EXISTS e_invoices_status_check;
ALTER TABLE e_invoices ADD CONSTRAINT e_invoices_status_check
  CHECK (status IN ('pending', 'submitted', 'valid', 'invalid', 'failed', 'rejected', 'cancelled'));

-- A fresh document sent in place of one LHDN refused, found invalid or
-- reported cancelled: the row it replaces, and the number of the first of
-- them (its series), which lookups by the original number follow.
ALTER TABLE e_invoices ADD COLUMN IF NOT EXISTS replaces_id INTEGER REFERENCES e_invoices(id);
ALTER TABLE e_invoices ADD COLUMN IF NOT EXISTS series_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS e_invoices_replaced_once ON e_invoices (replaces_id) WHERE replaces_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS e_invoices_series ON e_invoices (venue_id, (COALESCE(series_code, code_number)));

-- A consolidated document or consolidated credit note: the receipt or credit
-- note numbers its lines covered when it was sent (a JSON list), so a
-- customer's own e-invoice is never replaced for a sale a consolidated one
-- already carries.
ALTER TABLE e_invoices ADD COLUMN IF NOT EXISTS covers TEXT;

-- Leave people's names out of the lines of e-invoices not yet sent (a
-- customer's own, and a large sale's): each line then says the receipt's
-- number and the kind of sale. Off unless the venue turns it on.
ALTER TABLE einvoice_settings ADD COLUMN IF NOT EXISTS leave_names_out INTEGER NOT NULL DEFAULT 0;

-- Once a row has reached LHDN (it holds a document, a submission ID or a
-- UUID), what it said and LHDN's identifiers do not change, and it is not
-- deleted. Only LHDN's verdict moves on: submitted to valid, invalid or
-- cancelled; valid to cancelled; its long ID set once; when it was last
-- asked about.
CREATE OR REPLACE FUNCTION e_invoices_sent_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.document IS NULL AND OLD.submission_uid IS NULL AND OLD.uuid IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an e-invoice sent to LHDN is kept (%)', OLD.code_number USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.type_code IS DISTINCT FROM OLD.type_code OR NEW.code_number IS DISTINCT FROM OLD.code_number
     OR NEW.period IS DISTINCT FROM OLD.period OR NEW.receipt_ref IS DISTINCT FROM OLD.receipt_ref
     OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number OR NEW.buyer IS DISTINCT FROM OLD.buyer
     OR NEW.total IS DISTINCT FROM OLD.total OR NEW.document IS DISTINCT FROM OLD.document
     OR NEW.submission_uid IS DISTINCT FROM OLD.submission_uid OR NEW.uuid IS DISTINCT FROM OLD.uuid
     OR NEW.refers_uuid IS DISTINCT FROM OLD.refers_uuid OR NEW.refers_code IS DISTINCT FROM OLD.refers_code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.replaces_id IS DISTINCT FROM OLD.replaces_id OR NEW.series_code IS DISTINCT FROM OLD.series_code
     OR NEW.covers IS DISTINCT FROM OLD.covers
     OR (OLD.long_id IS NOT NULL AND NEW.long_id IS DISTINCT FROM OLD.long_id) THEN
    RAISE EXCEPTION 'an e-invoice sent to LHDN does not change (%)', OLD.code_number USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'submitted' AND NEW.status IN ('valid', 'invalid', 'cancelled'))
     AND NOT (OLD.status = 'valid' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'an e-invoice sent to LHDN does not go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS e_invoices_sent_frozen ON e_invoices;
CREATE TRIGGER e_invoices_sent_frozen BEFORE UPDATE OR DELETE ON e_invoices
  FOR EACH ROW EXECUTE FUNCTION e_invoices_sent_frozen();
