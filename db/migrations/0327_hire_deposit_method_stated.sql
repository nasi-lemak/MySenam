-- A hire deposit taken before its method was recorded (migration 0308), and the way staff can say how it was held (hardening round, brief MONEY: C10;
-- docs/features/payments-and-credit.md#cash-up, ADR 0068).
--
-- Rows taken before 0308 keep `deposit_via` NULL: shown as "not recorded", never as cash, and that marker stays as it is. What staff say about such a
-- deposit afterwards is written beside it, once: how it was held, who said so and when, so the deposit can be counted under its own till and an amount
-- kept from it goes in the takings under the right method. Nothing already written is changed: `deposit_via` is not filled in, and a statement is never
-- replaced (a deposit whose method is recorded, or already stated, takes no statement).
ALTER TABLE hire_records ADD COLUMN IF NOT EXISTS deposit_via_stated TEXT CHECK (deposit_via_stated IS NULL OR deposit_via_stated IN ('cash', 'qr', 'transfer', 'card'));
ALTER TABLE hire_records ADD COLUMN IF NOT EXISTS deposit_via_stated_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE hire_records ADD COLUMN IF NOT EXISTS deposit_via_stated_by_name TEXT;
ALTER TABLE hire_records ADD COLUMN IF NOT EXISTS deposit_via_stated_at TIMESTAMPTZ;
