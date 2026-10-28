-- Whether customers may message the venue's own phone number on WhatsApp
-- (audit R8 X2-10; docs/features/venue-operations.md#the-venues-number): shown
-- as a click-to-chat link beside the number wherever a customer is told to
-- call the venue. Off until the venue says its number takes WhatsApp, so no
-- customer is sent to chat with a landline.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS phone_whatsapp BOOLEAN NOT NULL DEFAULT false;
