-- The language a guardian recorded by name and number reads
-- (lib/contact-guardians.ts; docs/integrations/messaging.md#guardian-notices).
--
-- Staff choose the language of the code they send to such a guardian's
-- number. Once a code in that language has come back, a later WhatsApp
-- notice to them (template `mysenam_guardian_notice`, one translation per
-- language) is written in it too. NULL: no code has come back yet, or one
-- sent before this was kept: the install's first language, as before.

-- The language each code was sent in.
ALTER TABLE guardian_contact_codes ADD COLUMN IF NOT EXISTS locale TEXT;

-- The language of the last code that came back from the number recorded for them.
ALTER TABLE participant_guardians ADD COLUMN IF NOT EXISTS contact_locale TEXT;
