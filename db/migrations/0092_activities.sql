-- Activities as data (ADR 0011). What a resource can be booked for — a
-- sport, a class, kit to hire — is a row in `activities`, no longer a list in
-- the code. The platform's built-ins are written into it by the application
-- (lib/activities.ts, on every start, and by the step after this migration);
-- operators add their own beside them. A resource (still `courts`) offers one
-- or more activities, each at its own rates if it has them, and a booking or
-- class records which it is for.

CREATE TABLE IF NOT EXISTS activities (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- An operator's own: their business's (every branch), or, for a venue in
  -- no business, that venue's. Both NULL: the platform's.
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  -- Written from the code on every start (src/lib/activity-catalogue.ts).
  builtin BOOLEAN NOT NULL DEFAULT false,
  category TEXT NOT NULL CHECK (category IN ('racket', 'team', 'aquatic', 'water', 'fitness', 'studio', 'specialist')),
  icon TEXT NOT NULL,
  -- JSON: its name in each language ({"en": "Bouldering", "zh": "抱石"}).
  names TEXT NOT NULL,
  -- JSON: other words it is searched by.
  aliases TEXT NOT NULL DEFAULT '[]',
  -- JSON: what a new resource for it starts as (lib/activity-catalogue.ts).
  template TEXT NOT NULL,
  -- JSON: its usual booking rules, beneath every venue's own.
  policy TEXT NOT NULL DEFAULT '{}',
  surfaced BOOLEAN NOT NULL DEFAULT false,
  supervised BOOLEAN NOT NULL DEFAULT false,
  -- JSON: the court filters search offers for it.
  filters TEXT NOT NULL DEFAULT '[]',
  support TEXT NOT NULL CHECK (support IN ('full', 'basic', 'specialised')),
  support_note TEXT,
  -- JSON: names, aliases and filters by country, where they differ.
  country TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 1000,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TEXT NOT NULL DEFAULT datetime('now'),
  updated_at TEXT NOT NULL DEFAULT datetime('now'),
  CHECK (business_id IS NULL OR venue_id IS NULL),
  CHECK (NOT (builtin AND (business_id IS NOT NULL OR venue_id IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS idx_activities_business ON activities(business_id) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_venue ON activities(venue_id) WHERE venue_id IS NOT NULL;

-- Whatever is already named somewhere gets a row, so the references below
-- hold; the step after this migration fills in the built-ins properly.
INSERT INTO activities (key, category, icon, names, template, support)
SELECT DISTINCT used.sport, 'specialist', '📍', json_build_object('en', initcap(replace(used.sport, '_', ' ')))::text,
       '{"model":"exclusive","noun":"court","capacity":1,"count":1,"perPlayer":false,"maxPlayers":null,"setting":null,"signOff":false}',
       'basic'
  FROM (
    SELECT sport FROM courts
    UNION SELECT sport FROM passes WHERE sport IS NOT NULL
    UNION SELECT sport FROM promo_codes WHERE sport IS NOT NULL
    UNION SELECT sport FROM player_levels
    UNION SELECT sport FROM tournaments
    UNION SELECT sport FROM leagues
    UNION SELECT sport FROM venue_addons WHERE sport IS NOT NULL
    UNION SELECT sport FROM concessions WHERE sport IS NOT NULL
    UNION SELECT sport FROM sport_rules
    UNION SELECT sport FROM booking_policies WHERE sport IS NOT NULL
  ) used
 WHERE used.sport ~ '^[a-z][a-z0-9_]{1,39}$'
ON CONFLICT (key) DO NOTHING;

-- Every name of an activity anywhere is one the catalogue has.
ALTER TABLE courts ADD CONSTRAINT courts_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE passes ADD CONSTRAINT passes_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE player_levels ADD CONSTRAINT player_levels_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE leagues ADD CONSTRAINT leagues_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE venue_addons ADD CONSTRAINT venue_addons_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE concessions ADD CONSTRAINT concessions_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE sport_rules ADD CONSTRAINT sport_rules_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;
ALTER TABLE booking_policies ADD CONSTRAINT booking_policies_sport_fk FOREIGN KEY (sport) REFERENCES activities(key) ON UPDATE CASCADE;

-- ------------------------------------------------------------ resources

-- What one resource is called ("Lane 3", "Bay 2"); NULL: what its activity's are.
ALTER TABLE courts ADD COLUMN IF NOT EXISTS noun TEXT;

-- The activities a resource offers. `courts.sport` is its main one and is
-- always among them; each may have rates of its own (NULL: the court's).
CREATE TABLE IF NOT EXISTS court_activities (
  court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
  sport TEXT NOT NULL REFERENCES activities(key) ON UPDATE CASCADE,
  off_peak_rate NUMERIC(12,2) CHECK (off_peak_rate IS NULL OR off_peak_rate >= 0),
  peak_rate NUMERIC(12,2) CHECK (peak_rate IS NULL OR peak_rate >= 0),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (court_id, sport),
  CHECK ((off_peak_rate IS NULL) = (peak_rate IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_court_activities_sport ON court_activities(sport);
INSERT INTO court_activities (court_id, sport) SELECT id, sport FROM courts ON CONFLICT DO NOTHING;

-- A court's main activity is always one it offers, however the court is written.
CREATE OR REPLACE FUNCTION court_main_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO court_activities (court_id, sport) VALUES (NEW.id, NEW.sport) ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS courts_main_activity ON courts;
CREATE TRIGGER courts_main_activity AFTER INSERT OR UPDATE OF sport ON courts
  FOR EACH ROW EXECUTE FUNCTION court_main_activity();

-- And it cannot be taken off while it is the main one.
CREATE OR REPLACE FUNCTION court_keeps_main_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM courts WHERE id = OLD.court_id AND sport = OLD.sport) THEN
    RAISE EXCEPTION 'activity % is the main one of court %', OLD.sport, OLD.court_id USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS court_activities_keep_main ON court_activities;
CREATE TRIGGER court_activities_keep_main BEFORE DELETE ON court_activities
  FOR EACH ROW EXECUTE FUNCTION court_keeps_main_activity();

-- The list on the court row too, kept by the database, so everything that
-- reads a court has it: JSON [{sport, offPeakRate, peakRate}], main first.
ALTER TABLE courts ADD COLUMN IF NOT EXISTS activities TEXT NOT NULL DEFAULT '[]';
CREATE OR REPLACE FUNCTION court_activities_list(court INTEGER) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(json_agg(json_build_object('sport', ca.sport, 'offPeakRate', ca.off_peak_rate, 'peakRate', ca.peak_rate)
                           ORDER BY (ca.sport = c.sport) DESC, ca.position, ca.sport)::text, '[]')
    FROM court_activities ca JOIN courts c ON c.id = ca.court_id
   WHERE ca.court_id = court
$$;
CREATE OR REPLACE FUNCTION court_activities_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE courts SET activities = court_activities_list(OLD.court_id) WHERE id = OLD.court_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE courts SET activities = court_activities_list(NEW.court_id) WHERE id = NEW.court_id;
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS court_activities_list ON court_activities;
CREATE TRIGGER court_activities_list AFTER INSERT OR UPDATE OR DELETE ON court_activities
  FOR EACH ROW EXECUTE FUNCTION court_activities_changed();
-- A new main activity reorders the list.
CREATE OR REPLACE FUNCTION court_main_reorders() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE courts SET activities = court_activities_list(NEW.id) WHERE id = NEW.id;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS courts_main_reorders ON courts;
CREATE TRIGGER courts_main_reorders AFTER UPDATE OF sport ON courts
  FOR EACH ROW EXECUTE FUNCTION court_main_reorders();
UPDATE courts SET activities = court_activities_list(id);

-- ------------------------------------------------------------ bookings and classes

-- What was booked: one of the activities its court offered then.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sport TEXT REFERENCES activities(key) ON UPDATE CASCADE;
UPDATE bookings b SET sport = c.sport FROM courts c WHERE c.id = b.court_id AND b.sport IS NULL;
ALTER TABLE bookings ALTER COLUMN sport SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_sport ON bookings(sport);

ALTER TABLE classes ADD COLUMN IF NOT EXISTS sport TEXT REFERENCES activities(key) ON UPDATE CASCADE;
UPDATE classes cl SET sport = c.sport FROM courts c WHERE c.id = cl.court_id AND cl.sport IS NULL;
ALTER TABLE classes ALTER COLUMN sport SET NOT NULL;

-- Written without one, a class is for its court's main activity, and a
-- booking for its class's or its court's.
CREATE OR REPLACE FUNCTION class_default_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sport IS NULL THEN
    SELECT sport INTO NEW.sport FROM courts WHERE id = NEW.court_id;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS classes_default_activity ON classes;
CREATE TRIGGER classes_default_activity BEFORE INSERT ON classes
  FOR EACH ROW EXECUTE FUNCTION class_default_activity();
CREATE OR REPLACE FUNCTION booking_default_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sport IS NULL AND NEW.class_id IS NOT NULL THEN
    SELECT sport INTO NEW.sport FROM classes WHERE id = NEW.class_id;
  END IF;
  IF NEW.sport IS NULL THEN
    SELECT sport INTO NEW.sport FROM courts WHERE id = NEW.court_id;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS bookings_default_activity ON bookings;
CREATE TRIGGER bookings_default_activity BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION booking_default_activity();

-- ------------------------------------------------------------ policies

-- A booking product's own rules: one activity on one resource, over the
-- court's and the activity's at the venue.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'booking_policies'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%business_id IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE booking_policies DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE booking_policies ADD CONSTRAINT booking_policies_level CHECK (
  (court_id IS NOT NULL AND venue_id IS NULL AND business_id IS NULL) OR
  (court_id IS NULL AND venue_id IS NOT NULL AND business_id IS NULL) OR
  (court_id IS NULL AND venue_id IS NULL AND sport IS NULL AND business_id IS NOT NULL)
);
DROP INDEX IF EXISTS uq_policy_court;
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_court ON booking_policies(court_id) WHERE court_id IS NOT NULL AND sport IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_court_sport ON booking_policies(court_id, sport) WHERE court_id IS NOT NULL AND sport IS NOT NULL;

-- Customers need a staff sign-off for it first (a belay check, a range briefing).
ALTER TABLE booking_policies ADD COLUMN IF NOT EXISTS sign_off BOOLEAN;

-- ------------------------------------------------------------ sign-offs

-- Staff have checked this person may do this activity here unsupervised (or
-- anything here, where `sport` is NULL).
CREATE TABLE IF NOT EXISTS sign_offs (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  sport TEXT REFERENCES activities(key) ON UPDATE CASCADE,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  note TEXT,
  expires_on TEXT,
  created_at TEXT NOT NULL DEFAULT datetime('now'),
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sign_offs_live ON sign_offs(venue_id, phone_key(phone), COALESCE(sport, '')) WHERE revoked_at IS NULL;
