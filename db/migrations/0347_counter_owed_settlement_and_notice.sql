-- What the list of counter money owed back records about a customer's cancellation (hardening round, brief REFUND; ADR 0074):
--
--   * `settled_via`: the way the money actually went back when staff settled it, where it is not the way it was paid (the customer agreed
--     to be given it another way: cash, QR, transfer or card). `via` stays what the customer paid with. The payout row (`counter_payouts`)
--     says the same, with the amount, who and when; this keeps it beside the obligation for the panel.
--   * `customer_notified_at`: when the customer was told the venue will return the money at the counter (the cancellation message, by
--     email or WhatsApp where they left an address). Null: not told (no address, or the message was not sent), so staff tell them.
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS settled_via TEXT CHECK (settled_via IS NULL OR settled_via IN ('cash', 'qr', 'transfer', 'card'));
ALTER TABLE counter_refunds_owed ADD COLUMN IF NOT EXISTS customer_notified_at TIMESTAMPTZ;
