-- How an existing guardian's agreement to a request was given (ADR 0023;
-- lib/guardian-requests.ts, lib/contact-guardians.ts):
--
-- * `online`: a guardian with an account agreed on their people page;
-- * `guardian_code`: the guardian started it by giving their own code;
-- * `staff_assisted_phone_code`: a guardian a venue recorded by name and
--   number agreed through its staff, reading back a one-time code sent to
--   the number recorded for them; the staff member who entered it is kept;
-- * `staff_in_person`: where no code can be sent from this install, a
--   manager recorded that guardian's agreement given in person, with a
--   reason; recorded as such, never as proof of authority.
--
-- The agreeing guardian's relationship is kept too, so that an agreement
-- whose guardian has since withdrawn or been paused never makes anybody a
-- guardian.

ALTER TABLE guardian_requests ADD COLUMN IF NOT EXISTS consent_method TEXT
  CHECK (consent_method IS NULL OR consent_method IN ('online', 'guardian_code', 'staff_assisted_phone_code', 'staff_in_person'));
ALTER TABLE guardian_requests ADD COLUMN IF NOT EXISTS consent_guardianship_id INTEGER REFERENCES participant_guardians(id) ON DELETE SET NULL;
ALTER TABLE guardian_requests ADD COLUMN IF NOT EXISTS consent_staff_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE guardian_requests ADD COLUMN IF NOT EXISTS consent_staff_name TEXT;
ALTER TABLE guardian_requests ADD COLUMN IF NOT EXISTS consent_reason TEXT;
ALTER TABLE guardian_requests DROP CONSTRAINT IF EXISTS guardian_requests_consent_staff;
ALTER TABLE guardian_requests ADD CONSTRAINT guardian_requests_consent_staff
  CHECK (consent_method IS NULL OR consent_method NOT IN ('staff_assisted_phone_code', 'staff_in_person') OR consent_staff_name IS NOT NULL);
ALTER TABLE guardian_requests DROP CONSTRAINT IF EXISTS guardian_requests_in_person_reason;
ALTER TABLE guardian_requests ADD CONSTRAINT guardian_requests_in_person_reason
  CHECK (consent_method IS DISTINCT FROM 'staff_in_person' OR consent_reason IS NOT NULL);

-- Agreements already given, as they were given.
UPDATE guardian_requests SET consent_method = CASE WHEN initiated_as = 'guardian' THEN 'guardian_code' ELSE 'online' END
 WHERE consented_at IS NOT NULL AND consent_method IS NULL;
