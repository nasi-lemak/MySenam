-- Supporting documents are scanned for malware before anybody can open them
-- (lib/document-scanning.ts; docs/architecture/security.md#supporting-documents;
-- ADR 0024).
--
-- A document is checked (ADR 0021) and stored in quarantine: `pending`, never
-- handed out. The server's own call to the scanner settles it: `clean`
-- (released), `rejected` (the scanner found something: its content is wiped
-- at once and only the fact is kept), or `failed` (the scanner could not give
-- an answer within a bounded number of tries: never released). `not_scanned`
-- is only ever written where the operator has turned scanning off on purpose
-- (MYSENAM_DOCUMENT_SCAN=off), and is shown as such to reviewers.
--
-- Documents stored before this migration were never scanned: they start
-- `pending`, and are scanned (or fail) like any new one.

ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'pending';
-- Tries so far, and when the next is due (NULL once settled).
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_next_at TIMESTAMPTZ DEFAULT now();
-- A scan in progress: another process leaves the document alone until then.
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_claimed_until TIMESTAMPTZ;
-- When it was settled, by which engine and signature version, what was found
-- (a signature's name, never the content), the last error, and the SHA-256 of
-- the bytes that were scanned.
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_engine TEXT;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_finding TEXT;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_error TEXT;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS scan_sha256 TEXT;

-- Documents from before names and hashes were kept get their hash, so a scan can be tied to the bytes.
UPDATE approval_documents SET sha256 = encode(sha256(content), 'hex') WHERE sha256 IS NULL;

ALTER TABLE approval_documents DROP CONSTRAINT IF EXISTS approval_documents_scan_status;
ALTER TABLE approval_documents ADD CONSTRAINT approval_documents_scan_status
  CHECK (scan_status IN ('pending', 'clean', 'rejected', 'failed', 'not_scanned'));
-- Clean only from a recorded scan of exactly these bytes.
ALTER TABLE approval_documents DROP CONSTRAINT IF EXISTS approval_documents_scan_clean;
ALTER TABLE approval_documents ADD CONSTRAINT approval_documents_scan_clean
  CHECK (scan_status <> 'clean' OR (scanned_at IS NOT NULL AND scan_engine IS NOT NULL AND scan_sha256 IS NOT NULL AND scan_sha256 = sha256));
-- A rejected document keeps nothing of what was sent.
ALTER TABLE approval_documents DROP CONSTRAINT IF EXISTS approval_documents_scan_rejected;
ALTER TABLE approval_documents ADD CONSTRAINT approval_documents_scan_rejected
  CHECK (scan_status <> 'rejected' OR (octet_length(content) = 0 AND scan_finding IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_approval_documents_scan_due ON approval_documents (scan_next_at) WHERE scan_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approval_documents_scan_settled ON approval_documents (scanned_at) WHERE scan_status IN ('rejected', 'failed');

-- A settled document stays settled: nothing (a forged request, a late or
-- repeated scan result, a mistaken update) turns a rejected, failed or
-- unscanned document into a clean one, or a clean one back into anything
-- else. Only `pending` moves, and its bytes never change once stored.
CREATE OR REPLACE FUNCTION approval_documents_scan_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content AND NOT (NEW.scan_status = 'rejected' AND octet_length(NEW.content) = 0) THEN
    RAISE EXCEPTION 'a stored document''s content does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.scan_status <> 'pending' AND NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
    RAISE EXCEPTION 'a document''s scan is settled (%)', OLD.scan_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS approval_documents_scan_guard ON approval_documents;
CREATE TRIGGER approval_documents_scan_guard BEFORE UPDATE ON approval_documents
  FOR EACH ROW EXECUTE FUNCTION approval_documents_scan_guard();
