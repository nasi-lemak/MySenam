-- Any payment gateway, not only Billplz. A venue's account keeps whatever
-- that gateway needs as one JSON object, each secret in it sealed on its own
-- (lib/secrets.ts) exactly as the Billplz keys already were, so moving them
-- across needs no unsealing.
ALTER TABLE venue_payment_accounts DROP CONSTRAINT IF EXISTS venue_payment_accounts_provider_check;
ALTER TABLE venue_payment_accounts ADD COLUMN IF NOT EXISTS credentials TEXT;
UPDATE venue_payment_accounts
   SET credentials = json_build_object('apiKey', api_key, 'collectionId', collection_id, 'xSignatureKey', x_signature_key)::text
 WHERE credentials IS NULL;
ALTER TABLE venue_payment_accounts ALTER COLUMN credentials SET NOT NULL;
ALTER TABLE venue_payment_accounts DROP COLUMN IF EXISTS api_key;
ALTER TABLE venue_payment_accounts DROP COLUMN IF EXISTS collection_id;
ALTER TABLE venue_payment_accounts DROP COLUMN IF EXISTS x_signature_key;

