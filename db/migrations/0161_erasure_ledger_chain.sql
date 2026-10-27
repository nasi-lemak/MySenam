-- The erasure ledger as a numbered, hash-chained record that also goes
-- off-site (lib/erasure-ledger.ts, lib/erasure-ledger-offsite.ts;
-- docs/operations/backups.md#after-a-restore; ADR 0024).
--
-- Every entry takes the next number (seq) and the SHA-256 of the entry before
-- it (prev_hash), and its own hash covers both: an entry changed, removed or
-- slipped in breaks the chain, and a number missing is a gap. The app
-- computes the hashes (lib/erasure-chain.ts); entries made before this
-- migration are numbered here in the order they were made and hashed by its
-- step (lib/db-steps.ts). Entries are copied off-site in signed segments soon after they
-- are made and with every backup set, so a restore after losing the server
-- can still apply them.
--
-- Besides accounts ('customer'), the ledger now records participants erased
-- with an account ('participant', by number and creation moment, as an
-- account) and changes to the install's retention periods
-- ('retention_policy', the periods only), so that a restore of an older
-- backup applies the newer periods; and an acknowledged recovery that lost
-- entries ('recovery': which numbers were lost and that it was acknowledged).
-- No entry holds a name, email or phone.

ALTER TABLE erasure_ledger ADD COLUMN IF NOT EXISTS seq BIGINT;
ALTER TABLE erasure_ledger ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE erasure_ledger ADD COLUMN IF NOT EXISTS hash TEXT;
-- For a retention_policy or recovery entry: what it says, as JSON (no personal data).
ALTER TABLE erasure_ledger ADD COLUMN IF NOT EXISTS detail TEXT;
ALTER TABLE erasure_ledger ALTER COLUMN subject_id DROP NOT NULL;
ALTER TABLE erasure_ledger ALTER COLUMN subject_created_at DROP NOT NULL;
ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS erasure_ledger_kind_check;
ALTER TABLE erasure_ledger ADD CONSTRAINT erasure_ledger_kind_check CHECK (kind IN ('customer', 'participant', 'retention_policy', 'recovery'));
ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS erasure_ledger_subject;
ALTER TABLE erasure_ledger ADD CONSTRAINT erasure_ledger_subject CHECK (
  (kind IN ('customer', 'participant') AND subject_id IS NOT NULL AND subject_created_at IS NOT NULL)
  OR (kind IN ('retention_policy', 'recovery') AND detail IS NOT NULL)
);

-- Entries already there, numbered in the order they were made.
UPDATE erasure_ledger e SET seq = n.seq
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY erased_at, id) AS seq FROM erasure_ledger) n
 WHERE e.id = n.id AND e.seq IS NULL;
ALTER TABLE erasure_ledger ALTER COLUMN seq SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_erasure_ledger_seq ON erasure_ledger (seq);

-- The newest entry, and how far the off-site copy reaches. One row, locked
-- by each entry made, so numbers are taken one at a time.
CREATE TABLE IF NOT EXISTS erasure_ledger_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq BIGINT NOT NULL DEFAULT 0,
  -- The newest entry's hash; the chain's start (64 zeros) while there is none.
  hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  -- Every entry up to this number is in a segment the bucket accepted.
  shipped_seq BIGINT NOT NULL DEFAULT 0,
  shipped_at TIMESTAMPTZ,
  -- A copy under way, so two do not send the same entries at once.
  shipping_until TIMESTAMPTZ
);
INSERT INTO erasure_ledger_head (id, seq) SELECT 1, COALESCE(MAX(seq), 0) FROM erasure_ledger ON CONFLICT (id) DO NOTHING;

-- Once hashed, an entry stays as it was made: only whether and how it was
-- applied again after a restore may be written. Entries past their time are
-- deleted by the retention run.
CREATE OR REPLACE FUNCTION erasure_ledger_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.hash IS NOT NULL AND (
       NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.subject_created_at IS DISTINCT FROM OLD.subject_created_at
    OR NEW.erased_at IS DISTINCT FROM OLD.erased_at OR NEW.detail IS DISTINCT FROM OLD.detail
    OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash OR NEW.hash IS DISTINCT FROM OLD.hash) THEN
    RAISE EXCEPTION 'An erasure ledger entry cannot be changed once it is recorded (entry %).', OLD.seq;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS erasure_ledger_immutable ON erasure_ledger;
CREATE TRIGGER erasure_ledger_immutable BEFORE UPDATE ON erasure_ledger FOR EACH ROW EXECUTE FUNCTION erasure_ledger_immutable();

-- Each restore's reading of the ledger: where the restored copy's ledger ended
-- (anchor), how far a whole, unbroken and verified chain reaches from there,
-- the newest number known from anywhere else, and what was wrong. A restore
-- that could not show the ledger complete is 'blocked': the app does not
-- serve until somebody acknowledges it (scripts/restore.mjs --acknowledge-ledger).
CREATE TABLE IF NOT EXISTS erasure_ledger_recoveries (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  backup TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('complete', 'blocked')),
  anchor_seq BIGINT NOT NULL,
  verified_seq BIGINT NOT NULL,
  known_seq BIGINT,
  brought_in INTEGER NOT NULL DEFAULT 0,
  -- Problems and where entries came from; numbers only, no personal data.
  detail TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  acknowledgement TEXT,
  CHECK ((acknowledged_at IS NULL) = (acknowledgement IS NULL))
);
