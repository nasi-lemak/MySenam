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
- **Claims on court time** ([booking time model](interval-booking-review.md#claims)).
  Everything that occupies a court is a row in `claims`. An exclusion
  constraint refuses two active claims whose time (buffers included)
  overlaps on the same space, and a trigger that locks the court refuses a
  claim that would put a shared facility over its capacity at any moment.
  Both raise `23P01`, which every path turns into "taken"; a path that reads
  first and writes after (blocking around bookings) works it out again.
- **Linked courts.** A court over others covers their spaces, so its claims
  and theirs meet in the same constraint, at any number of courts sharing
  one.
- **Coaches.** `coach_claims` has the same constraint per coach.
- **Claiming money.** Money-moving updates claim their row first
  (`… WHERE status = 'confirmed'`, `… WHERE status = 'pending'`), so a second
  attempt changes nothing.

## Status of each guarantee

| Guarantee | Status | Evidence | Gaps |
| --------- | ------ | -------- | ---- |
| A minute of an exclusive court is sold once | Verified on Postgres | Exclusion constraint `claims_no_overlap` (migration 0089); raw SQL refused in `tests/capacity.test.ts` "is still the database that prevents overbooking"; `tests/concurrency.test.ts` "sells the last court to one person"; `tests/intervals.test.ts` "race for the same minutes, and only one gets them" | Eight parallel requests only. |
| A shared facility never holds more than its capacity | Verified on Postgres | Capacity trigger `claims_capacity` under a court-row lock, counting bookings, offers and partial blocks; raw SQL refused in `tests/capacity.test.ts`; "sells a shared floor's places once each"; `tests/intervals.test.ts` "fills a shared facility to its places at every moment" | — |
| Linked courts take each other | Verified on Postgres | Shared spaces; `tests/court-links.test.ts` including a two-request race and two wholes over one part; `tests/intervals.test.ts` "holds the court over it too" | Linking is one level deep (a rule of the editor, not of storage). |
| Nothing overlaps a block, class, outage, offer or buffer | Verified on Postgres | All are claims under the same constraint; `tests/outages.test.ts` "a booking made while a court is being taken out"; `tests/move.test.ts` "never leave a booking inside the block"; `tests/intervals.test.ts` buffers | — |
| A coach is in one lesson at a time | Verified on Postgres | `coach_claims_no_overlap`; `tests/coaching.test.ts` "will not put the coach in two places at once"; `tests/concurrency.test.ts` "puts a coach in one lesson at a time, and lets the other courts go" (eight lessons on eight courts at once: one sold, the other courts left free) | — |
| A freed hour goes to one of a reschedule and a new booking | Verified on Postgres | Both claim under the same constraint in their own transactions; `tests/concurrency.test.ts` "gives a freed hour to one of a move and a new booking, never both" | — |
| A court offering several activities is sold for one at a time | Verified | Every activity claims the court's same spaces; `tests/activities.test.ts` "is booked for one activity at a time" | — |
| Bookings and held time agree | Checked daily | `src/lib/integrity.ts` from the scheduler; each race test above ends with it finding nothing; `tests/integrity.test.ts` | Finds, does not repair: putting a mismatch right is the platform owner's call. |
| Every path sees the same availability | Met | Grid, search, any court, waiting lists, the move picker and rescheduling read one list of claims (`occupantsOn` in `src/lib/claims.ts`); the database refuses whatever a stale read lets through | — |
| A group booking (several courts) is all or nothing | Verified | One transaction; `tests/group-bookings.test.ts` "even when something breaks part-way" | — |
| A cancellation refunds once | Verified for the claim | Claim on `status = 'confirmed'`: three cancels at once, one succeeds (`tests/booking-rules.test.ts`, "happens once, however many times it is asked for at once", on an unpaid booking); each refund path once (`tests/auto-refunds.test.ts`, sequential) | No concurrent cancel of a *paid* booking is tested; the refund steps run after the claim commits, not in its transaction (M15) |
| Credit and pass entries are spent once | Verified on Postgres | "spends credit once", "refunds a pass entry once" | No database constraint against a negative balance (chargebacks may make one deliberately). |
| A payment notification settles once | Verified | Claim on `status = 'pending'`; unique `bill_id`; `tests/payments.test.ts`, `tests/stripe.test.ts` | No test of two identical callbacks at the same instant. |

The defects these once had (B…, M…) are listed, with the tests that now
cover them, in [known limitations](../roadmap/known-limitations.md#fixed-since-the-audit).

## Rules for changing this code

- Put every read that decides a write inside the same `withTransaction`.
- Do no external side effect (a message, an HTTP call) inside a transaction:
  it may run more than once. Queue messages in the outbox instead.
- Anything new that occupies a court is a claim (`claim` in
  `src/lib/claims.ts`), never a check of its own; catch `isConflict` where a
  refusal means "taken". Add the case to the tests of every path listed
  above.
- Add a concurrent test (`Promise.all`) for any new check-then-write path, and
  run the suite on Postgres (`TEST_DATABASE_URL`) before relying on it.
