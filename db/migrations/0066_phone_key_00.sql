-- phone_key() also for a number dialled with the international 00 prefix
-- (0060 12-345 6789, 0065 9123 4567): the same person as +60 / +65, and as
-- the national form. The same rule as src/lib/phone.ts.
CREATE OR REPLACE FUNCTION phone_key(phone text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d LIKE '60%' AND length(d) >= 10 THEN '0' || substr(d, 3)
    WHEN d LIKE '65%' AND length(d) = 10 THEN substr(d, 3)
    ELSE d
  END
  FROM (
    SELECT CASE WHEN raw LIKE '00%' THEN substr(raw, 3) ELSE raw END AS d
      FROM (SELECT regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS raw) AS r
  ) AS digits
$$;

-- Stored keys were worked out by the old rule: work them out again where they
-- differ. Keys kept without the number they came from are keys already, and
-- the rule leaves a key as it is, so it is applied to them; one that would
-- become a key the venue already holds is left alone.
UPDATE bookings SET phone = phone WHERE phone_key IS DISTINCT FROM phone_key(phone);
UPDATE venue_access_list SET phone = phone WHERE phone_key IS DISTINCT FROM phone_key(phone);
UPDATE venue_blocked_phones t SET phone_key = phone_key(t.phone)
 WHERE t.phone_key IS DISTINCT FROM phone_key(t.phone)
   AND NOT EXISTS (SELECT 1 FROM venue_blocked_phones o WHERE o.venue_id = t.venue_id AND o.phone_key = phone_key(t.phone));
UPDATE strike_forgiveness t SET phone_key = phone_key(t.phone_key)
 WHERE t.phone_key LIKE '00%'
   AND NOT EXISTS (SELECT 1 FROM strike_forgiveness o WHERE o.venue_id = t.venue_id AND o.phone_key = phone_key(t.phone_key));
UPDATE venue_reviews t SET phone_key = phone_key(t.phone_key)
 WHERE t.phone_key LIKE '00%'
   AND NOT EXISTS (SELECT 1 FROM venue_reviews o WHERE o.venue_id = t.venue_id AND o.phone_key = phone_key(t.phone_key));
REINDEX INDEX idx_messages_recipient_day;
