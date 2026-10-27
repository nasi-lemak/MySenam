# Database

Authoritative for how the schema is kept and changed. Why Postgres (and PGlite
in development) is [ADR 0001](decisions/0001-postgres-in-production-pglite-in-development.md);
why not TimescaleDB is [ADR 0004](decisions/0004-plain-postgres-not-timescaledb.md).

## Migrations

- The schema is the numbered SQL files in `db/migrations/`
  (`0001_initial.sql` onwards), applied in name order, each once, recorded in
  `schema_migrations` (`src/lib/db.ts`).
- They run on the first database query after the app starts. On Postgres they
  run under an advisory lock, so two instances starting together do not both
  apply one; each file runs in its own transaction.
- **A released migration is never edited or deleted.** Change the schema with
  a new file; write it to be safe to run on a database that already holds
  data (`IF NOT EXISTS`, backfills in the same file).
- There is no down-migration. Take a backup before deploying a version with
  new migrations ([deployment](../operations/deployment.md#upgrading)).

## Conventions that matter

- **Times are text.** Timestamps are stored as UTC text
  `YYYY-MM-DD HH:MM:SS`, produced by an SQL function `datetime()` defined in
  `0001_initial.sql`, so they sort and compare as strings. A value written in
  another shape (for example ISO text with a `T`) compares wrongly against
  `datetime('now')`, so write such columns through `datetime()` or in that
  exact form.
- **Dates and times of day are the venue's own.** A booking's `date` and
  `start_min`/`end_min` are its business day and minutes from that day's
  midnight in the venue's time zone, past 1440 after midnight
  ([booking](../features/booking.md#hours-by-weekday-and-after-midnight)).
  Court time itself is a `tstzrange` of real moments on each claim
  ([booking time model](booking-time-model.md#time)).
- **Money** is `NUMERIC(12,2)` in the currency's major unit (ringgit or
  dollars); arithmetic is rounded to the cent (`roundMoney` in
  `src/lib/region.ts`).
- **Phone numbers** are compared through the SQL function `phone_key()`
  (latest definition in `0066_phone_key_00.sql`), stored as a generated
  column where a table is searched by number.
- **Ledgers are append-only.** Stored credit (`wallet_entries`) and pass
  entries are sums of rows, never a balance column.
- **Court time is claims.** `claims` and `coach_claims` carry the database's
  own refusals of overlapping time (exclusion constraints), of time within a
  neighbour's minimum separation (`claim_gaps_apart` on `claim_gaps`, rows
  triggers keep in step with `claims`, migration 0119), of a shared
  facility over capacity (trigger `claims_capacity`) and of anyone in a
  facility while it is turned over whole (`facility_gaps_clear` and
  `facility_gaps_work` on `facility_gaps`, migration 0131); triggers keep a claim's
  court, space and venue consistent and a court's own space in step with its
  capacity (migrations 0089 and 0090).
- **Activities are a table.** Every column naming an activity (`sport`, kept
  under that name) has a foreign key to `activities(key)`; what a court offers
  is `court_activities`, and triggers keep its main activity among them and
  the `courts.activities` list in step. `bookings.sport` and `classes.sport`
  default to the court's main activity when not given (migration 0092,
  [ADR 0011](decisions/0011-activities-as-data.md)). The built-in rows are
  written by the application at every start. Checks on `courts` refuse a
  resource with places priced per player and a court booked whole priced
  flat (migration 0093).
- **People are ids, never contact details.** A participant (somebody who
  takes part other than the account holder) is a row in `participants`;
  who may act for them is `participant_guardians` (migration 0138). Who takes
  a place on a booking is `booking_participants` (migration 0139):
  `bookings.participant_id` and `participant_name` are a summary a trigger
  keeps in step with it, never written by code. A waiting-list entry names its people
  the same way (`waitlist_participants`, with `waitlist.places`, migration
  0146), and attendance per person hangs off a booking's places
  (`place_attendance`, 0147). Inductions, sign-offs and
  waiver signatures name a participant by id, a flag keeping a participant's
  record a participant's when their row goes (migration 0140). A phone number
  finds the number holder's own records, or candidates for staff to choose
  from; it never merges people or moves a record between them
  ([ADR 0023](decisions/0023-participants-apart-from-accounts.md)).
- **Migration steps.** Where a migration needs the application (a venue's
  time zone from its pin, checking a conversion), a step in
  `src/lib/db-steps.ts` runs straight after that migration's SQL in the same
  transaction; if it throws, the migration is undone.

## Engines

The same migrations run on PGlite and on Postgres 16+, and CI runs the suite
on both ([testing](../development/testing.md)). Anything engine-specific must
work on both; PGlite has no extensions beyond what it bundles.

On Postgres the app keeps a pool of connections (`DATABASE_POOL_SIZE`, ten by
default). A connection cut while it waits in the pool is thrown away and
replaced; one cut while a transaction holds it (the server restarting, an
administrator ending it) fails that transaction, which is not committed, and
is thrown away rather than handed to the next request, without stopping the
process (`tests/db-connection-lost.test.ts`). The server needs
`max_locks_per_transaction` of 256 or more for a restore, which locks every
table, index and sequence in one transaction
([`deploy/digitalocean/postgresql.conf`](../../deploy/digitalocean/postgresql.conf)).
