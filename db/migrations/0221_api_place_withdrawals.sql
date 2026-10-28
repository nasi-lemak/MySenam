-- Taking one person off a booking through the venue's API key
-- (`POST /api/v1/bookings/:code/withdraw`; lib/place-withdrawals.ts;
-- docs/features/booking.md#taking-one-person-off-a-booking).
--
-- The venue's own system does what its counter does, on the counter's terms:
-- the same refusals and the same money. The record says it was the API
-- (`by_kind = 'api'`) and which key (`by_api_key_id`), as the activity log
-- does.
--
-- A request may carry an `Idempotency-Key`: kept with the withdrawal it made
-- (`request_key`), once per key, so the same request sent again (a timeout,
-- a retry) answers with that withdrawal instead of taking somebody else off.
-- `request_outcome` is what the first answer said (JSON), given back as it was.
ALTER TABLE place_withdrawals DROP CONSTRAINT IF EXISTS place_withdrawals_by_kind_check;
ALTER TABLE place_withdrawals ADD CONSTRAINT place_withdrawals_by_kind_check CHECK (by_kind IN ('customer', 'staff', 'api'));
ALTER TABLE place_withdrawals ADD COLUMN IF NOT EXISTS by_api_key_id INTEGER REFERENCES venue_api_keys(id) ON DELETE SET NULL;
ALTER TABLE place_withdrawals ADD COLUMN IF NOT EXISTS request_key TEXT CHECK (request_key IS NULL OR length(request_key) BETWEEN 1 AND 255);
ALTER TABLE place_withdrawals ADD COLUMN IF NOT EXISTS request_outcome TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_place_withdrawals_request ON place_withdrawals (by_api_key_id, request_key) WHERE request_key IS NOT NULL;
