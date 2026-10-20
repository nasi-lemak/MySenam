-- phone_key() for Singapore as well as Malaysia (the same rule as
-- src/lib/phone.ts). A Malaysian number written nationally starts with its
-- trunk 0, never 60, so 60 and ten or more digits is the international form;
-- a Singaporean number is eight digits, so 65 and eight more is the
-- international form. The old rule also took 60 off a Singapore landline
-- (6012 3456), and off anything at all that began 60.
CREATE OR REPLACE FUNCTION phone_key(phone text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d LIKE '60%' AND length(d) >= 10 THEN '0' || substr(d, 3)
    WHEN d LIKE '65%' AND length(d) = 10 THEN substr(d, 3)
    ELSE d
  END
  FROM (SELECT regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS d) AS digits
$$;

-- Stored keys were worked out by the old rule: work them out again where
-- they differ, and rebuild the index that keys messages by it.
UPDATE bookings SET phone = phone WHERE phone_key IS DISTINCT FROM phone_key(phone);
UPDATE venue_access_list SET phone = phone WHERE phone_key IS DISTINCT FROM phone_key(phone);
REINDEX INDEX idx_messages_recipient_day;
