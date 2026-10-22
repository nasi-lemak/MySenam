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
  another shape (for example ISO text with a `T`) compares wrongly; see S4 in
  [known limitations](../roadmap/known-limitations.md#suspected-defects).
- **Dates and hours are the venue's own.** A booking's `date` and
  `start_hour`/`end_hour` are in the venue's local time zone; hours may run
  past 24 for opening hours after midnight
  ([booking](../features/booking.md#hours-by-weekday-and-after-midnight)).
- **Money** is `NUMERIC(12,2)` in the currency's major unit (ringgit or
  dollars); arithmetic is rounded to the cent (`roundMoney` in
  `src/lib/region.ts`).
- **Phone numbers** are compared through the SQL function `phone_key()`
  (latest definition in `0066_phone_key_00.sql`), stored as a generated
  column where a table is searched by number.
- **Ledgers are append-only.** Stored credit (`wallet_entries`) and pass
  entries are sums of rows, never a balance column.
- **Shared SQL functions**: `blocks_between` / `own_blocks_between` (what is
  blocked on a day, including outages and linked courts) and the linked-court
  trigger in `0072_linked_courts.sql`.

## Engines

The same migrations run on PGlite and on Postgres 16+, and CI runs the suite
on both ([testing](../development/testing.md)). Anything engine-specific must
work on both; PGlite has no extensions beyond what it bundles.
