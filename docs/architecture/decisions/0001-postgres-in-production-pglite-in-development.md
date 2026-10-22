# ADR 0001: PostgreSQL in production, PGlite in development and tests

- **Status:** current. Supersedes [ADR 0000](0000-sqlite-single-file.md).
- **Context:** MySenam began on one SQLite file. Production needs concurrent
  writers, row-level locking and a managed-hosting path; developers and CI
  should not need a database server to run the suite.
- **Decision:** production runs PostgreSQL 16 or later (`DATABASE_URL`).
  Development and the test suite run [PGlite](https://pglite.dev) — Postgres
  compiled to WebAssembly, inside the app — by default, and the same suite runs
  against a real server when `TEST_DATABASE_URL` is set. One SQL dialect and
  one set of migrations (`db/migrations`) serve both.
- **Rationale:** the same engine everywhere means no dialect shims, and
  constraints, triggers and SQL functions behave identically.
- **Consequences:** CI runs the suite twice (PGlite and Postgres 16).
  Migrations are applied in order at start-up, each once, under a lock
  (`src/lib/db.ts`). An install still on SQLite refuses to start until it is
  imported ([legacy installs](../../archive/migrations/legacy-installs.md)).
- **Known limitations:** PGlite runs one connection, so concurrency is only
  really exercised by the Postgres run. PGlite inside the app costs close to
  a gigabyte of memory, so it is not for production.
