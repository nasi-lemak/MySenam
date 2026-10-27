-- Supporting documents: scanning fails closed, with no opt-out; documents
-- waiting only for a scanner are kept; failed documents may go back into
-- quarantine to be scanned again (lib/document-scanning.ts;
-- docs/architecture/security.md#malware-scanning; ADR 0024, amended
-- 27 October 2026).
--
-- - The operator opt-out (MYSENAM_DOCUMENT_SCAN=off, `not_scanned`) is
--   withdrawn: supporting documents are safety and guardian application
--   documents, and none is released without a scan. Documents taken unscanned
--   under it go back into quarantine (`pending`), to be scanned; until then
--   nobody can open them.
-- - A failed document says why (`scan_failure`): `scanner_unavailable` (no
--   scanner configured, or it did not answer: kept, never released, and put
--   back in quarantine automatically once a scanner answers) or `unscannable`
--   (a working scanner could not scan it, or its bytes no longer match their
--   hash: terminal, and the quarantine period applies).
-- - Documents stored before scanning existed (before migration 0142), and those
--   taken unscanned under the withdrawn opt-out, are marked (`legacy_reason`)
--   so their progress can be followed; they are never treated as clean until a
--   scan passes them, and never deleted because no scanner was there, only by
--   their own retention.

ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_failure TEXT;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS legacy_reason TEXT;
-- How many times the document has been put in quarantine for scanning: 1 when stored, one more for each retry.
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_rounds INTEGER NOT NULL DEFAULT 1;

-- A settled document stays settled, with one way back: a failed document may
-- return to quarantine (`pending`) to be scanned again, only with its bytes
-- intact (present, and matching the hash recorded when they were checked).
-- Going back never releases it: only a scan of exactly those bytes does
-- (approval_documents_scan_clean). The recorded hash never changes either.
CREATE OR REPLACE FUNCTION approval_documents_scan_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content AND NOT (NEW.scan_status = 'rejected' AND octet_length(NEW.content) = 0) THEN
    RAISE EXCEPTION 'a stored document''s content does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'a stored document''s hash does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.scan_status <> 'pending' AND NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
    IF NEW.scan_status = 'pending' AND OLD.scan_status IN ('failed', 'not_scanned')
       AND octet_length(NEW.content) > 0 AND NEW.sha256 IS NOT NULL AND NEW.sha256 = encode(sha256(NEW.content), 'hex') THEN
      RETURN NEW;
    END IF;
    -- Taken unscanned under the withdrawn opt-out, and no longer intact: failed for good.
    IF OLD.scan_status = 'not_scanned' AND NEW.scan_status = 'failed' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a document''s scan is settled (%)', OLD.scan_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Stored before scanning existed: before migration 0142 was applied (where the migration runner recorded it).
DO $$
BEGIN
  IF to_regclass('schema_migrations') IS NOT NULL THEN
    EXECUTE $q$UPDATE approval_documents d SET legacy_reason = 'before_scanning'
                 FROM schema_migrations m
                WHERE m.version = '0142_document_scanning' AND d.created_at < m.applied_at AND d.legacy_reason IS NULL$q$;
  END IF;
END
$$;
UPDATE approval_documents SET legacy_reason = 'scanning_off' WHERE scan_status = 'not_scanned' AND legacy_reason IS NULL;

-- Taken unscanned under the withdrawn opt-out: back into quarantine, to be scanned like any new document.
UPDATE approval_documents SET scan_status = 'failed', scanned_at = now(), scan_error = 'integrity: content does not match its hash', scan_next_at = NULL
 WHERE scan_status = 'not_scanned' AND (octet_length(content) = 0 OR sha256 IS NULL OR sha256 <> encode(sha256(content), 'hex'));
UPDATE approval_documents SET scan_status = 'pending', scan_attempts = 0, scan_next_at = now(), scan_claimed_until = NULL, scanned_at = NULL, scan_error = NULL
 WHERE scan_status = 'not_scanned';

-- Why each failed document failed. Those whose last try found no scanner are kept and wait for one.
UPDATE approval_documents
   SET scan_failure = CASE WHEN scan_error LIKE 'unavailable:%' THEN 'scanner_unavailable' ELSE 'unscannable' END
 WHERE scan_status = 'failed' AND scan_failure IS NULL;

ALTER TABLE approval_documents DROP CONSTRAINT IF EXISTS approval_documents_scan_status;
ALTER TABLE approval_documents ADD CONSTRAINT approval_documents_scan_status
  CHECK (scan_status IN ('pending', 'clean', 'rejected', 'failed'));
ALTER TABLE approval_documents DROP CONSTRAINT IF EXISTS approval_documents_scan_failure;
ALTER TABLE approval_documents ADD CONSTRAINT approval_documents_scan_failure
  CHECK ((scan_status = 'failed') = (scan_failure IS NOT NULL) AND (scan_failure IS NULL OR scan_failure IN ('scanner_unavailable', 'unscannable')));
ALTER TABLE approval_documents DROP CONSTRAINT IF EXISTS approval_documents_legacy_reason;
ALTER TABLE approval_documents ADD CONSTRAINT approval_documents_legacy_reason
  CHECK (legacy_reason IS NULL OR legacy_reason IN ('before_scanning', 'scanning_off'));

-- Documents waiting for a scanner, found when one answers again.
CREATE INDEX IF NOT EXISTS idx_approval_documents_scan_waiting ON approval_documents (id) WHERE scan_status = 'failed' AND scan_failure = 'scanner_unavailable';
