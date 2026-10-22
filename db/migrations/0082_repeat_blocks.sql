-- Repeating blocks (lib/repeat-blocks.ts): the same hours taken out every
-- week. Each week is an ordinary block; the code ties a run together so the
-- rest of it can be listed and ended at once.
ALTER TABLE slot_blocks ADD COLUMN IF NOT EXISTS repeat_code TEXT;
CREATE INDEX IF NOT EXISTS idx_slot_blocks_repeat ON slot_blocks (repeat_code, date) WHERE repeat_code IS NOT NULL;
