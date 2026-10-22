# ADR 0002: Concurrency is the database's job

- **Status:** current.
- **Context:** two customers can try to book the last free hour, spend the
  same balance or take the last class place at the same moment, possibly on
  different app instances.
- **Decision:** every check-then-write path runs in one `SERIALIZABLE`
  transaction, retried on serialization failure (`40001`) or deadlock
  (`40P01`) — `withTransaction` in `src/lib/db.ts`. Exclusive court-hours are
  also guarded by a unique key on `booking_slots (court_id, date, hour)`, and
  linked courts by triggers and SQL functions (migration
  `0072_linked_courts.sql`).
- **Rationale:** application-level locks do not hold across instances;
  serializable isolation makes the read-then-write paths behave as if they ran
  one at a time without hand-written locking.
- **Consequences:** a transaction may run more than once, so code inside it
  must not have side effects outside the database (messages are queued in the
  outbox table and sent afterwards).
- **Known limitations:** what is actually demonstrated under concurrency, and
  what is not, is in [booking concurrency](../booking-concurrency.md).
