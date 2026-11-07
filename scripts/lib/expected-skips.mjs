/**
 * Tests that are skipped on purpose, and where. A release run accepts no other
 * skip: a test that is skipped without being listed here is a test that did not
 * run, and a step that skipped it does not pass (scripts/verify.mjs).
 *
 * The suite runs twice, on PGlite and on a real Postgres server. These files
 * test what only a real server can do (connection pools, advisory locks, many
 * connections at once, a cut connection), so they are skipped on PGlite with
 * `skipIf(!process.env.TEST_DATABASE_URL)` and must all run on Postgres:
 * on Postgres NOTHING may be skipped. The counts are the number of tests
 * skipped in the file, so a new skip inside a listed file is caught too.
 */
export const PGLITE_EXPECTED_SKIPS = {
  "tests/booking-references-deferred.test.ts": 3,
  "tests/db-connection-lost.test.ts": 2,
  "tests/migration-lock.test.ts": 4,
  "tests/policy-edit-races.test.ts": 2,
  "tests/postgres-pool.test.ts": 1,
  "tests/refund-crash.test.ts": 1,
  "tests/separation.test.ts": 1,
  "tests/shared-turnover.test.ts": 1,
};

/**
 * Outside the providers' own checks (scripts/verify-integrations.mjs and the
 * others), a verification run never calls a real service. Said in every
 * report, so a pass is never read as more than it is.
 */
export const INTEGRATIONS = [
  ["Billplz (FPX and cards, refunds)", "node scripts/verify-integrations.mjs billplz"],
  ["Stripe (cards, refunds, disputes, subscriptions, pause_collection)", "node scripts/verify-integrations.mjs stripe"],
  ["Email through Amazon SES or SMTP", "node scripts/verify-integrations.mjs email --send"],
  ["WhatsApp (templates, delivery)", "node scripts/verify-integrations.mjs whatsapp --send"],
  ["SMS", "node scripts/verify-integrations.mjs sms --send"],
  ["Backblaze B2 / S3 off-site storage", "node scripts/verify-integrations.mjs b2; npm run verify-offsite"],
  ["MyInvois (LHDN e-invoicing)", "no harness: needs the venue's sandbox credentials (docs/integrations/myinvois.md)"],
  ["Xero accounting push", "node scripts/verify-xero.mjs"],
  ["Google sign-in", "no harness: needs the owner's OAuth client"],
  ["ClamAV on a Droplet (document scanning)", "docs/operations/deployment.md"],
];
