-- How a number is being proved: a code sent to it ('code', by SMS — or by
-- WhatsApp where there is no SMS), or a message the customer sends us from it
-- on WhatsApp ('whatsapp'), carrying this token.
ALTER TABLE phone_codes ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'code';
ALTER TABLE phone_codes ADD COLUMN IF NOT EXISTS token TEXT;
CREATE INDEX IF NOT EXISTS idx_phone_codes_token ON phone_codes(token);
