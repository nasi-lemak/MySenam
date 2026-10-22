# Booking concurrency: what is guaranteed

Authoritative for what the system guarantees when requests race, and how far
each guarantee is proven. The decision behind it is
[ADR 0002](decisions/0002-database-enforced-concurrency.md); the booking rules
themselves are in [booking](../features/booking.md).

## Mechanisms

- **Serializable transactions.** On Postgres every `withTransaction` runs
  `BEGIN ISOLATION LEVEL SERIALIZABLE` and is retried on `40001`/`40P01`
  (`src/lib/db.ts`). On PGlite there is one connection and transactions run
  one after another, so the PGlite test run cannot show a race; the Postgres
  run in CI can.
- **One row per place per slot.** `booking_slots` has
  `UNIQUE (court_id, date, hour, seat)` (`db/migrations/0001_initial.sql`). A
  booking picks the lowest free seat inside its transaction and retries on a
  unique violation (`createBookingSeries` in `src/lib/store.ts`).
- **Linked courts.** A trigger writes shadow slots: a whole's hour onto each of
  its parts, and a part's hour onto its wholes
  (`db/migrations/0072_linked_courts.sql`).
- **Claims.** Money-moving updates claim their row first
  (`… WHERE status = 'confirmed'`, `… WHERE status = 'pending'`), so a second
  attempt changes nothing.

## Status of each guarantee

| Guarantee | Status | Evidence | Gaps |
| --------- | ------ | -------- | ---- |
| An exclusive court hour is sold once | Verified on Postgres | Unique key; `tests/concurrency.test.ts` "sells the last court to one person"; `tests/capacity.test.ts` | Eight parallel requests only. Holds only if every row of a court uses the same slot size (B5). |
| A shared facility never holds more than its capacity | Partial | Seat chosen below capacity inside the serializable transaction; "sells a shared floor's places once each" | No database `CHECK`; capacity net of partial blocks and waiting-list holds is computed in two places that disagree (B3). |
| Linked courts take each other | Partial | Trigger; `tests/court-links.test.ts` including a two-request race | Two wholes over one part are prevented only by the key, not shown as taken (B1). |
| Every path sees the same availability | Not met | Grid, search, any court, booking, moving, rescheduling and the waiting list each compute it | Waiting-list holds are seen only by the grid and booking (B2); search caps length at four hours (B6). |
| An outage or block does not land on a booking made at the same moment | Not met | `createOutage` checks, cancels and inserts without a transaction; moving and rescheduling check blocks outside theirs | B4, B7. |
| A group booking (several courts) is all or nothing | Partial | Compensating deletes on refusal | Not one transaction; an exception part-way leaves earlier bookings (B8). |
| A cancellation refunds once | Verified | Claim on `status = 'confirmed'`; `tests/concurrency.test.ts`, `tests/auto-refunds.test.ts` | — |
| Credit and pass entries are spent once | Verified on Postgres | "spends credit once", "refunds a pass entry once" | No database constraint against a negative balance (chargebacks may make one deliberately). |
| A payment notification settles once | Verified | Claim on `status = 'pending'`; unique `bill_id`; `tests/payments.test.ts`, `tests/stripe.test.ts` | No test of two identical callbacks at the same instant; `paySeries` can overwrite an online settlement (M3). |

The defects (B…, M…) are described in
[known limitations](../roadmap/known-limitations.md#suspected-defects).

## Rules for changing this code

- Put every read that decides a write inside the same `withTransaction`.
- Do no external side effect (a message, an HTTP call) inside a transaction:
  it may run more than once. Queue messages in the outbox instead.
- When availability changes, change the shared computation, and add the case
  to the tests of every path listed above.
- Add a concurrent test (`Promise.all`) for any new check-then-write path, and
  run the suite on Postgres (`TEST_DATABASE_URL`) before relying on it.
