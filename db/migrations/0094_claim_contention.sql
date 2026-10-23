-- Claims read by the court they are on, not only by time (known limitations
-- B12, B13; docs/architecture/booking-concurrency.md).

-- Waiting-list offers past their time are let go before every claim. Without
-- an index of live offers that meant reading every claim, which under
-- SERIALIZABLE locks the whole table against every other booking.
CREATE INDEX IF NOT EXISTS idx_claims_live_offers ON claims (expires_at) WHERE active AND kind = 'offer';

-- What holds a court's time on a day, read court by court (lib/claims.ts,
-- occupantsOn): by the space or shared court, from the claims that end after
-- the day begins. The GiST indexes behind the constraints answer the same
-- question about ten times slower, being poor at telling one space from the
-- next; this reads only a court's claims from now on, however long its past.
CREATE INDEX IF NOT EXISTS idx_claims_space_ends ON claims (space_id, (COALESCE(upper(occupied), 'infinity'::timestamptz)))
  WHERE active AND space_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_court_ends ON claims (court_id, (COALESCE(upper(occupied), 'infinity'::timestamptz)))
  WHERE active AND space_id IS NULL;

-- The capacity check on a shared facility: the same rule as before (0089),
-- now asked through the court part of idx_claims_court_during as well as the
-- time, so it reads that court's claims and nobody else's.
CREATE OR REPLACE FUNCTION claim_within_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap INTEGER;
  peak INTEGER;
BEGIN
  IF NEW.space_id IS NOT NULL OR NOT NEW.active THEN
    RETURN NEW;
  END IF;
  SELECT capacity INTO cap FROM courts WHERE id = NEW.court_id FOR NO KEY UPDATE;
  SELECT COALESCE(max(load), 0) INTO peak FROM (
    SELECT sum(d) OVER (ORDER BY t, d) AS load FROM (
      SELECT greatest(lower(c.occupied), lower(NEW.occupied)) AS t, c.places AS d
        FROM claims c
       WHERE int4range(c.court_id, c.court_id, '[]') && int4range(NEW.court_id, NEW.court_id, '[]')
         AND c.active AND c.occupied && NEW.occupied
         AND c.space_id IS NULL AND c.id <> COALESCE(NEW.id, -1)
         AND (c.expires_at IS NULL OR c.expires_at > now())
      UNION ALL
      SELECT least(COALESCE(upper(c.occupied), 'infinity'), COALESCE(upper(NEW.occupied), 'infinity')), -c.places
        FROM claims c
       WHERE int4range(c.court_id, c.court_id, '[]') && int4range(NEW.court_id, NEW.court_id, '[]')
         AND c.active AND c.occupied && NEW.occupied
         AND c.space_id IS NULL AND c.id <> COALESCE(NEW.id, -1)
         AND (c.expires_at IS NULL OR c.expires_at > now())
    ) edges
  ) loads;
  IF peak + NEW.places > cap THEN
    RAISE EXCEPTION 'court % has % places; % are held then', NEW.court_id, cap, peak USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END
$$;
