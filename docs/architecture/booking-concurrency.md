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
| An exclusive court hour is sold once | Verified on Postgres | Unique key; `tests/concurrency.test.ts` "sells the last court to one person"; `tests/capacity.test.ts` | Eight parallel requests only. Relies on every row being half an hour, whatever the sport is sold by ([ADR 0009](decisions/0009-half-hour-diary-sold-by-sport.md)); `tests/half-hour.test.ts` books overlapping hour and half-hour units against each other. |
| A shared facility never holds more than its capacity | Verified | Seat chosen inside the serializable transaction below capacity net of booked, blocked and offered places; "sells a shared floor's places once each"; `tests/waitlist.test.ts` "partly blocked" | No database `CHECK`. |
| Linked courts take each other | Verified on Postgres | Trigger (`0072_linked_courts.sql`, `0087_wholes_over_one_part.sql`); `tests/court-links.test.ts` including a two-request race and two wholes over one part | One level deep. |
| Every path sees the same availability | Met | Grid, search, any court, the move picker and the room checks of moving and rescheduling count booked and offered places through one function (`countTakenPlaces`); `tests/waitlist.test.ts` "a place offered to somebody waiting" | Each path still applies its own blocks and classes. |
| An outage or block does not land on a booking made at the same moment | Met | `createOutage` saves the outage in a transaction that re-checks for bookings and classes; moving and rescheduling check blocks, classes and offers inside theirs; `tests/outages.test.ts` "a booking made while a court is being taken out" | The move and reschedule race is guarded but not forced by a test. |
| A group booking (several courts) is all or nothing | Verified | One transaction; `tests/group-bookings.test.ts` "even when something breaks part-way" | — |
| A cancellation refunds once | Verified | Claim on `status = 'confirmed'`; `tests/concurrency.test.ts`, `tests/auto-refunds.test.ts` | — |
| Credit and pass entries are spent once | Verified on Postgres | "spends credit once", "refunds a pass entry once" | No database constraint against a negative balance (chargebacks may make one deliberately). |
| A payment notification settles once | Verified | Claim on `status = 'pending'`; unique `bill_id`; `tests/payments.test.ts`, `tests/stripe.test.ts` | No test of two identical callbacks at the same instant. |

The defects these once had (B…, M…) are listed, with the tests that now
cover them, in [known limitations](../roadmap/known-limitations.md#fixed-since-the-audit).

## Rules for changing this code

- Put every read that decides a write inside the same `withTransaction`.
- Do no external side effect (a message, an HTTP call) inside a transaction:
  it may run more than once. Queue messages in the outbox instead.
- When availability changes, change the shared computation
  (`countTakenPlaces`, `blockedPlacesFor`, `blocks_between`), and add the case
  to the tests of every path listed above.
- Add a concurrent test (`Promise.all`) for any new check-then-write path, and
  run the suite on Postgres (`TEST_DATABASE_URL`) before relying on it.
