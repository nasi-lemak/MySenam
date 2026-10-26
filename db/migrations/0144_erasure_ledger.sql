-- Erasures, recorded so a restore cannot bring back what was erased
-- (lib/erasure-ledger.ts; docs/operations/backups.md#after-a-restore; ADR 0024).
--
-- A backup taken before somebody closed their account still holds them. After
-- a restore, every erasure recorded since is applied again, from this table
-- and from the copy of it kept beside the backup sets (a file the restore
-- does not overwrite). An entry names the account by its number and the time
-- it was created, so it is applied only to that account, never to a later
-- one that happens to get the same number; it holds no name, email or phone.

CREATE TABLE IF NOT EXISTS erasure_ledger (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('customer')),
  subject_id INTEGER NOT NULL,
  subject_created_at TEXT NOT NULL,
  erased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Applied again after a restore, and how that went.
  reapplied_at TIMESTAMPTZ,
  reapply_outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_erasure_ledger_erased ON erasure_ledger (erased_at);
