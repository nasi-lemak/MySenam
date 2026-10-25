# Booking concurrency: what is guaranteed

Authoritative for what the system guarantees when requests race, and how far
each guarantee is proven. The decision behind it is
[ADR 0002](decisions/0002-database-enforced-concurrency.md); the booking rules
themselves are in [booking](../features/booking.md).

## Mechanisms

- **Serializable transactions.** On Postgres every `withTransaction` runs
  `BEGIN ISOLATION LEVEL SERIALIZABLE` and is retried on `40001`/`40P01`, up
  to ten tries, each after a random wait of up to 10, 20, 40… ms (at most
  400), so transactions that collided do not collide again in step
  (`src/lib/db.ts`). One still in conflict after ten tries throws `BusyError`:
  nothing of it is saved, and a route answers `BUSY`, 503 with
  `Retry-After: 2`, never a 500. The booking board keeps the reason on screen
  (*busy, try again*), shows no confirmation, and sending it again sends the
  same booking, so a retry either books it once or is refused as taken
  (`tests/components/booking-board.test.tsx`). On PGlite there is one connection and
  transactions run one after another, so the PGlite test run cannot show a
  race; the Postgres run can.
- **Reading only what the booking touches.** A booking's reads are of its
  own courts' claims, through indexes on the space or shared court and the
  claim's end (migration 0094), so under serializable checks two bookings at
  different venues do not see each other. Waiting-list offers past their
  time are let go only when a claim conflicts with one, not by a scan before
  every claim. The one shared read left is the bookings index page a new
  booking's claim checks its booking against: unrelated bookings at that
  moment can make one of them retry (measured at 2 in 1,920).
- **Advisory locks, in one order.** Before claiming, a booking takes
  `pg_advisory_xact_lock` on each space it will hold, on a shared court, and
  on its coach (`lockAll` in `src/lib/claims.ts`), sorted, kinds in a fixed
  order (spaces, then shared courts, then coaches). Bookings for the same
  thing queue on the lock instead of each inserting, waiting on the other's
  uncommitted row and deadlocking; bookings for different things do not wait
  at all. The locks are released when the transaction ends.
- **Claims on court time** ([booking time model](booking-time-model.md#claims)).
  Everything that occupies a court is a row in `claims`. An exclusion
  constraint refuses two active claims whose time (operational time
  included) overlaps on the same space, a second (`claim_gaps_apart`, on rows
  triggers keep beside each claim) refuses a claim's time within another's
  minimum separation on the same space, and a trigger that locks the court
  refuses a claim that would put a shared facility over its capacity at any
  moment. All raise `23P01`, which every path turns into "taken"; a path that reads
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
| A minute of an exclusive court is sold once | Verified on Postgres | Exclusion constraint `claims_no_overlap` (migration 0089); raw SQL refused in `tests/capacity.test.ts` "is still the database that prevents overbooking"; `tests/concurrency.test.ts` "sells the last court to one person"; `tests/intervals.test.ts` "race for the same minutes, and only one gets them"; `tests/contention.test.ts`: 24 at once for one court, four rounds: one booked, the rest refused as taken (not busy), each round under 8 s, no claim left behind | Measured on one machine (four cores). The contention and concurrency files passed 20 runs in a row on Postgres 16, 7–8 s a run |
| Independent bookings do not fail each other | Verified on Postgres | `tests/contention.test.ts`: 24 at once at 24 venues, and on 24 courts of one venue, four rounds each: all booked, at most two retries a round, none out of tries; the [benchmark](../development/testing.md#results): fifty at once at 400 venues, no errors | A booking can still be retried, rarely (above) |
| A shared facility never holds more than its capacity | Verified on Postgres | Capacity trigger `claims_capacity` under a court-row lock, counting bookings, offers and partial blocks; raw SQL refused in `tests/capacity.test.ts`; "sells a shared floor's places once each"; `tests/intervals.test.ts` "fills a shared facility to its places at every moment"; `tests/contention.test.ts`: 24 at once for a floor of five, four rounds: five booked | — |
| Linked courts take each other | Verified on Postgres | Shared spaces; `tests/court-links.test.ts` including a two-request race and two wholes over one part; `tests/intervals.test.ts` "holds the court over it too"; `tests/contention.test.ts`: a pitch and its three courts asked for three times each at once, four rounds: the pitch or its courts, never both | Linking is one level deep (a rule of the editor, not of storage). |
| Nothing overlaps a block, class, outage, offer or buffer | Verified on Postgres | All are claims under the same constraint; `tests/outages.test.ts` "a booking made while a court is being taken out"; `tests/move.test.ts` "never leave a booking inside the block"; `tests/intervals.test.ts` buffers | — |
| Neighbours on a space are at least the larger of their facing separations apart | Verified on Postgres | `claim_gaps_apart` (migration 0119), an exclusion constraint that reads nothing, so it adds no serializable retries; raw SQL refused, two bookings racing for times 5 minutes apart (one of them gets it, four rounds, a court and a pitch over a court), and two raw writers without the application's locks under read committed and serializable, in `tests/separation.test.ts` | Shared facilities hold separation as places under the capacity trigger instead (it adds up there) |
| A coach is in one lesson at a time | Verified on Postgres | `coach_claims_no_overlap`; `tests/coaching.test.ts` "will not put the coach in two places at once"; `tests/concurrency.test.ts` "puts a coach in one lesson at a time, and lets the other courts go" (eight lessons on eight courts at once: one sold, the other courts left free); `tests/contention.test.ts` the same through the booking route, four rounds: one 201, no 5xx | — |
| A freed hour goes to one of a reschedule and a new booking | Verified on Postgres | Both claim under the same constraint in their own transactions; `tests/concurrency.test.ts` "gives a freed hour to one of a move and a new booking, never both" | — |
| A court offering several activities is sold for one at a time | Verified | Every activity claims the court's same spaces; `tests/activities.test.ts` "is booked for one activity at a time" | — |
| Bookings and held time agree | Checked daily | `src/lib/integrity.ts` from the scheduler; each race test above ends with it finding nothing; `tests/integrity.test.ts` | Finds, does not repair: putting a mismatch right is the platform owner's call. |
| Every path sees the same availability | Met | Grid, search, any court, waiting lists, the move picker and rescheduling read one list of claims (`occupantsOn` in `src/lib/claims.ts`); the database refuses whatever a stale read lets through | — |
| A group booking (several courts) is all or nothing | Verified | One transaction; `tests/group-bookings.test.ts` "even when something breaks part-way" | — |
| A cancellation refunds once | Verified on Postgres | The claim on `status = 'confirmed'` and every refund are one transaction; a failure part-way leaves the booking booked and nothing refunded; two cancels of a paid booking at once, and a class called off while a place in it is cancelled, refund once (`tests/refund-recovery.test.ts`); three cancels of an unpaid one (`tests/booking-rules.test.ts`) | A refund through the gateway is asked for after the commit (it cannot be in the transaction): written down as owed first, retried under its key if interrupted, raised if unanswered |
| Credit and pass entries are spent once | Verified on Postgres | "spends credit once", "refunds a pass entry once" | No database constraint against a negative balance (chargebacks may make one deliberately). |
| A payment notification settles once | Verified on Postgres | Claim on `status = 'pending'`; unique `bill_id`; `tests/payments.test.ts`, `tests/stripe.test.ts`; three reports of one payment at the same moment settle it once (`tests/tournaments.test.ts`, "at the counter, then online"); a second payment for what is already paid is owed back, not kept (M12) | — |

The defects these once had (B…, M…) are listed, with the tests that now
cover them, in [known limitations](../roadmap/known-limitations.md#fixed-since-the-audit).

## Rules for changing this code

- Put every read that decides a write inside the same `withTransaction`.
- Anything that claims a space, a shared court or a coach takes its lock
  first (`lockCourts`, `lockCoach` in `src/lib/claims.ts`), all of them
  before any claim. Read claims by court (`occupantsOn`), never by time
  alone.
- A function that can run out of tries returns `BUSY` rather than throwing
  (`busyAware` in `src/lib/store.ts`, `isBusy`).
- Do no external side effect (a message, an HTTP call) inside a transaction:
  it may run more than once. Queue messages in the outbox instead.
- Anything new that occupies a court is a claim (`claim` in
  `src/lib/claims.ts`), never a check of its own; catch `isConflict` where a
  refusal means "taken". Add the case to the tests of every path listed
  above.
- Add a concurrent test (`Promise.all`) for any new check-then-write path, and
  run the suite on Postgres (`TEST_DATABASE_URL`) before relying on it.
