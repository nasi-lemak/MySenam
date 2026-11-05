-- The same rule as 0206 (docs/architecture/booking-concurrency.md, "Independent bookings"), for the tables that came after it:
-- every row that points at a booking is checked when the transaction commits, not as each row is written. Round 10 added
-- four (session_supervisors, class_move_offers, lesson_moves, attendance_marks), each with an immediate foreign key.
-- Nothing else changes: a row pointing at a booking that is not there still fails, at commit, and ON DELETE is as before.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT con.conname, cls.relname
      FROM pg_constraint con JOIN pg_class cls ON cls.oid = con.conrelid
     WHERE con.contype = 'f' AND con.confrelid = 'bookings'::regclass
       AND NOT (con.condeferrable AND con.condeferred)
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', fk.relname, fk.conname);
  END LOOP;
END
$$;
