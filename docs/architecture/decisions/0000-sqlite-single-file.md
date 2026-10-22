# ADR 0000: One SQLite file

- **Status:** superseded by [ADR 0001](0001-postgres-in-production-pglite-in-development.md).
- **Context:** the first version (then called MudahTempah) needed to run
  anywhere with nothing to install.
- **Decision (historical):** keep everything in one SQLite file
  (`data/mysenam.db`, set by `MYSENAM_DB`).
- **Why it was replaced:** one writer at a time, no managed hosting path for a
  web service's disk, and no row-level locking for concurrent bookings and
  balances.
- **What remains:** `npm run import-sqlite` and the start-up check that
  refuses an unimported SQLite install
  ([legacy installs](../../archive/migrations/legacy-installs.md)).
