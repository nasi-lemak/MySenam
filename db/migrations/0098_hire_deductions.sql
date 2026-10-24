-- Why money was kept from a hire deposit (lib/deposit-deductions.ts): each
-- reason is a counter sale of its own, receipted with the tax its nature
-- carries at the venue, under its own heading in the books. A return can
-- keep money for more than one reason (damage, and cleaning).
ALTER TABLE counter_sales ADD COLUMN IF NOT EXISTS hire_reason TEXT;
DROP INDEX IF EXISTS uq_counter_sales_hire;
CREATE UNIQUE INDEX IF NOT EXISTS uq_counter_sales_hire_reason ON counter_sales (hire_record_id, (COALESCE(hire_reason, '')))
  WHERE hire_record_id IS NOT NULL;

-- A venue's own choice of which reasons carry its tax, where it differs from
-- the country's usual treatment: {"cleaning": true, "damage": false}.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS deduction_tax TEXT;
