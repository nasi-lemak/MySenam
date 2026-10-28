-- An e-invoice that reached LHDN is never rewritten (migration 0220), with one
-- narrow exception: the retention run, once the install's statutory period
-- (einvoice_retention.years, migration 0225) has passed since the document
-- was issued, clears what the law no longer requires and keeps a tombstone
-- for the books (lib/myinvois.ts pruneEInvoices;
-- docs/architecture/privacy.md#e-invoice-records).
--
-- The exception allows exactly one change, once: `cleared_at` set, the stored
-- payload (`document`), the buyer's details (`buyer`) and LHDN's reasons as
-- given (`error`) emptied, and nothing else touched. It holds only
--   * inside a transaction that said it is the retention run
--     (set_config('mysenam.einvoice_retention', 'on', true)), and
--   * when the document was issued (sent; a row from before sending was
--     recorded, created) longer ago than the period the database holds.
-- Anything else, from any path, is refused as before; a tombstone is never
-- deleted, filled in again, or cleared twice. A draft that never reached
-- LHDN is not a tombstone: it may still be changed or deleted as before.

CREATE OR REPLACE FUNCTION e_invoices_sent_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept_years INTEGER;
BEGIN
  IF OLD.document IS NULL AND OLD.submission_uid IS NULL AND OLD.uuid IS NULL AND OLD.cleared_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.cleared_at IS NOT NULL THEN
      RAISE EXCEPTION 'only an e-invoice sent to LHDN is cleared after the statutory period (%)', OLD.code_number USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an e-invoice sent to LHDN is kept (%)', OLD.code_number USING ERRCODE = 'check_violation';
  END IF;

  -- The retention run's one exception.
  IF OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL THEN
    IF current_setting('mysenam.einvoice_retention', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'only the retention run clears an e-invoice sent to LHDN (%)', OLD.code_number USING ERRCODE = 'check_violation';
    END IF;
    SELECT years INTO kept_years FROM einvoice_retention WHERE id = 1;
    IF COALESCE(OLD.submitted_at, OLD.created_at) >= datetime('now', '-' || COALESCE(kept_years, 7) || ' years') THEN
      RAISE EXCEPTION 'an e-invoice sent to LHDN is kept for the statutory period (%)', OLD.code_number USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.document IS NOT NULL OR NEW.buyer IS NOT NULL OR NEW.error IS NOT NULL
       OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.type_code IS DISTINCT FROM OLD.type_code OR NEW.code_number IS DISTINCT FROM OLD.code_number
       OR NEW.period IS DISTINCT FROM OLD.period OR NEW.receipt_ref IS DISTINCT FROM OLD.receipt_ref
       OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.submission_uid IS DISTINCT FROM OLD.submission_uid OR NEW.uuid IS DISTINCT FROM OLD.uuid
       OR NEW.long_id IS DISTINCT FROM OLD.long_id OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.refers_uuid IS DISTINCT FROM OLD.refers_uuid OR NEW.refers_code IS DISTINCT FROM OLD.refers_code
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.checked_at IS DISTINCT FROM OLD.checked_at
       OR NEW.replaces_id IS DISTINCT FROM OLD.replaces_id OR NEW.series_code IS DISTINCT FROM OLD.series_code
       OR NEW.covers IS DISTINCT FROM OLD.covers THEN
      RAISE EXCEPTION 'clearing an e-invoice after the statutory period empties its payload, buyer and reasons and nothing else (%)', OLD.code_number
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
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
     OR NEW.covers IS DISTINCT FROM OLD.covers OR NEW.cleared_at IS DISTINCT FROM OLD.cleared_at
     OR (OLD.cleared_at IS NOT NULL AND NEW.error IS NOT NULL)
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
