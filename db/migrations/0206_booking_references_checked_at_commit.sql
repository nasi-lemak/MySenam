-- Rows that point at a booking have it checked when the transaction commits,
-- not when each row is written (docs/architecture/booking-concurrency.md,
-- "Independent bookings").
--
-- A booking's transaction writes the booking, then its claim (and, as the
-- booking needs, its people, shares and coach) pointing at it. Checked at
-- once, each of those rows reads the page of the bookings index that every
-- new booking is written to, and under SERIALIZABLE that read stays locked
-- while the transaction runs. Two bookings with nothing in common then look
-- to Postgres as if each read what the other wrote; with a third, the middle
-- one is cancelled as a pivot and run again. On a loaded server, where every
-- transaction runs longer, those retries come in runs (the contention test
-- once counted 36 for 24 bookings). Checked at commit, the read comes after
-- everything the transaction writes, and nothing in common remains.
--
-- What is checked is unchanged: a row pointing at a booking that is not there
-- still fails, at commit, and the whole transaction with it. What happens to
-- those rows when a booking is deleted (ON DELETE) is not deferred and is as
-- before.
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
