-- Audit 9, D1/H5 (ADR 0062): entries given back to a pass that is over must not be dead.
--
-- 1. `venues.pass_restore_grace_days`: when a cancellation (the customer's, or the venue's) gives entries back to a pass that has
--    expired, its validity is extended to today plus this many days so the entries can be used (the extension is written in the pass's
--    history with its reason). 0 turns it off: the entries go back to the ledger and the pass stays over. Default 30, the recommended
--    value. A void pass is never revived by it.
-- 2. `passes.void_refunded`: whether the pass was cancelled with the unused part handed back (`voidPass`, `refund: true`), including
--    when that part was nothing because every entry was spent on a booking still ahead. A booking of such a pass that is cancelled
--    afterwards gives the customer the entry's value in money (a credit note, owed back where the pass was bought online) instead of
--    returning the entry to a pass that can no longer be used. A pass cancelled without a refund, or before this column, is read from
--    its credit notes: one written against its sale means it was refunded.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS pass_restore_grace_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_pass_restore_grace_days_check;
ALTER TABLE venues ADD CONSTRAINT venues_pass_restore_grace_days_check CHECK (pass_restore_grace_days BETWEEN 0 AND 365);
ALTER TABLE passes ADD COLUMN IF NOT EXISTS void_refunded BOOLEAN NOT NULL DEFAULT FALSE;
