-- Two big courts over the same small one (a netball court and a futsal pitch
-- both over the middle badminton court) take each other through it. Booking
-- one already took the small court, so the other could not be booked; now it
-- also shows as taken, in the grid, search and any-court, and a block on one
-- closes the other, as a block across a link does.
--
-- A big court's hour is mirrored onto each other big court sharing a part
-- with it, at seat -(the booked court's id): its own namespace, like a part's
-- shadow on its whole, so it reads as full and collides with nothing else.

CREATE OR REPLACE FUNCTION shadow_linked_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shadow = 0 THEN
    INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span, shadow)
      SELECT NEW.booking_id, l.part_id, NEW.date, NEW.hour, 0, NEW.span, 1
        FROM court_links l WHERE l.whole_id = NEW.court_id
      UNION ALL
      SELECT NEW.booking_id, l.whole_id, NEW.date, NEW.hour, -NEW.court_id, NEW.span, 1
        FROM court_links l WHERE l.part_id = NEW.court_id
      UNION ALL
      SELECT DISTINCT NEW.booking_id, o.whole_id, NEW.date, NEW.hour, -NEW.court_id, NEW.span, 1
        FROM court_links a JOIN court_links o ON o.part_id = a.part_id AND o.whole_id <> a.whole_id
       WHERE a.whole_id = NEW.court_id;
  END IF;
  RETURN NULL;
END
$$;

-- What is already sold from today takes the other big courts too.
INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span, shadow)
SELECT DISTINCT s.booking_id, o.whole_id, s.date, s.hour, -s.court_id, s.span, 1
  FROM booking_slots s
  JOIN court_links a ON a.whole_id = s.court_id
  JOIN court_links o ON o.part_id = a.part_id AND o.whole_id <> a.whole_id
 WHERE s.shadow = 0 AND s.date >= substr(datetime('now', '-1 day'), 1, 10)
ON CONFLICT DO NOTHING;

-- Blocks: carried between big courts sharing a part, as across a link.
CREATE OR REPLACE FUNCTION blocks_between(d_from text, d_to text)
RETURNS TABLE (court_id integer, date text, hour double precision, reason text, places integer, span double precision)
LANGUAGE sql STABLE AS $$
  -- A court's own block first; else one carried across a link, whole. Driven
  -- from the links court by court, so a venue with none reads nothing more.
  SELECT DISTINCT ON (b.court_id, b.date, b.hour) b.court_id, b.date, b.hour, b.reason, b.places, b.span
    FROM (
      SELECT o.court_id, o.date, o.hour, o.reason, o.places, o.span, 0 AS carried FROM own_blocks_between(d_from, d_to) o
      UNION ALL
      SELECT l.court_id, o.date, o.hour, o.reason, NULL::integer, o.span, 1
        FROM (SELECT whole_id AS court_id, part_id AS other FROM court_links
              UNION ALL SELECT part_id, whole_id FROM court_links
              UNION ALL SELECT a.whole_id, o.whole_id FROM court_links a
                          JOIN court_links o ON o.part_id = a.part_id AND o.whole_id <> a.whole_id) l
        JOIN own_blocks_between(d_from, d_to) o ON o.court_id = l.other
    ) b
   ORDER BY b.court_id, b.date, b.hour, b.carried
$$;
