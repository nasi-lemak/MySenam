-- What a venue offers besides its courts, and what each court is like
-- (lib/facilities.ts), so players can compare venues and filter by them.

-- From a fixed list, so they can be compared and searched; never free text.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS amenities TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE courts ADD COLUMN IF NOT EXISTS setting TEXT CHECK (setting IN ('indoor', 'outdoor'));
ALTER TABLE courts ADD COLUMN IF NOT EXISTS aircon INTEGER NOT NULL DEFAULT 0;
ALTER TABLE courts ADD COLUMN IF NOT EXISTS floodlit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE courts ADD COLUMN IF NOT EXISTS surface TEXT
  CHECK (surface IN ('wood', 'mat', 'hard', 'clay', 'turf', 'tiles', 'concrete'));

-- The four starter venues, described, so a fresh install shows what this looks like.
UPDATE venues SET amenities = '{showers,changing_rooms,lockers,toilets,free_parking,surau,drinking_water,cafe,equipment_rental,wifi}'
 WHERE amenities = '{}' AND name = 'Arena MySenam @ Petaling Jaya' AND address = '12 Jalan SS2/61, 47300 Petaling Jaya, Selangor';
UPDATE courts SET setting = 'indoor', aircon = 1, surface = CASE sport WHEN 'badminton' THEN 'mat' WHEN 'pickleball' THEN 'hard' WHEN 'futsal' THEN 'tiles' ELSE NULL END
 WHERE setting IS NULL AND venue_id = (SELECT id FROM venues WHERE name = 'Arena MySenam @ Petaling Jaya' AND address = '12 Jalan SS2/61, 47300 Petaling Jaya, Selangor');

UPDATE venues SET amenities = '{showers,toilets,paid_parking,transit,surau,pro_shop,stringing,coaching}'
 WHERE amenities = '{}' AND name = 'SmashPoint Sports Centre' AND address = '8 Persiaran Kewajipan, USJ 1, 47600 Subang Jaya, Selangor';
UPDATE courts SET
    setting = CASE sport WHEN 'badminton' THEN 'indoor' ELSE 'outdoor' END,
    floodlit = CASE sport WHEN 'tennis' THEN 1 ELSE 0 END,
    surface = CASE sport WHEN 'badminton' THEN 'mat' WHEN 'tennis' THEN 'hard' ELSE NULL END
 WHERE setting IS NULL AND venue_id = (SELECT id FROM venues WHERE name = 'SmashPoint Sports Centre' AND address = '8 Persiaran Kewajipan, USJ 1, 47600 Subang Jaya, Selangor');

UPDATE venues SET amenities = '{showers,changing_rooms,lockers,toilets,paid_parking,transit,cafe,pro_shop,coaching,seating}'
 WHERE amenities = '{}' AND name = 'Bangsar Racquet Club' AND address = '3 Jalan Maarof, Bangsar, 59000 Kuala Lumpur';
UPDATE courts SET
    setting = CASE sport WHEN 'tennis' THEN 'outdoor' ELSE 'indoor' END,
    aircon = CASE sport WHEN 'pickleball' THEN 1 ELSE 0 END,
    floodlit = CASE sport WHEN 'tennis' THEN 1 ELSE 0 END,
    surface = 'hard'
 WHERE setting IS NULL AND venue_id = (SELECT id FROM venues WHERE name = 'Bangsar Racquet Club' AND address = '3 Jalan Maarof, Bangsar, 59000 Kuala Lumpur');

UPDATE venues SET amenities = '{changing_rooms,lockers,toilets,free_parking,first_aid,drinking_water}'
 WHERE amenities = '{}' AND name = 'Putrajaya Lakeside Watersports' AND address = 'Presint 5, Persiaran Perdana, 62000 Putrajaya';
UPDATE courts SET setting = 'outdoor'
 WHERE setting IS NULL AND venue_id = (SELECT id FROM venues WHERE name = 'Putrajaya Lakeside Watersports' AND address = 'Presint 5, Persiaran Perdana, 62000 Putrajaya');
