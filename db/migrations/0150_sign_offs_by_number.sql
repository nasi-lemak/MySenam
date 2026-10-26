-- Search says, for a signed-in account, whether it may book what needs the
-- venue's sign-off (lib/eligibility.ts): one query for the page, finding the
-- account holder's own sign-offs by account, by participant, or by the number
-- the account proved. The first two had indexes (0093, 0135); this is the third,
-- so the query reads that person's rows and never the table.
CREATE INDEX IF NOT EXISTS idx_sign_offs_phone_key ON sign_offs (phone_key(phone)) WHERE revoked_at IS NULL;
