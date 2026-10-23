-- Money kept back from a hire deposit on return is a sale of its own
-- (known limitations M13; docs/features/venue-operations.md): receipted,
-- taxed as the venue says, counted in the day's takings, and in the books
-- under its own heading. The hire record keeps what was held and kept; the
-- sale is what was earned.
ALTER TABLE counter_sales ADD COLUMN IF NOT EXISTS hire_record_id INTEGER REFERENCES hire_records(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_counter_sales_hire ON counter_sales (hire_record_id) WHERE hire_record_id IS NOT NULL;
