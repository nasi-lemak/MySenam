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
  every claim.
- **Rows pointing at a booking are checked at commit** (migration 0206). A
  claim, the people on a booking, a coach's claim and every other row that
  points at a booking is checked against it when the transaction commits,
  not as it is written. Checked at once, each read the page of the bookings
  index every new booking is written to, and kept that read while the
  transaction ran: three bookings with nothing in common, each writing to
  that page after the one before had read it, made the middle one a pivot,
  cancelled and run again. On a loaded server every transaction runs longer
  and those retries came in runs (the whole suite on four busy cores once
  counted 36 for 24 bookings on different courts of one venue, all booked in
  the end). Checked at commit, the read comes after everything the
  transaction writes. `tests/booking-references-deferred.test.ts` replays
  that order of events on Postgres: checked at once, the middle booking is
  cancelled every time; checked at commit, all three commit. A row pointing
  at a missing booking still fails, at commit; what happens to those rows
  when a booking is deleted is not deferred.
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
  moment; two more (`facility_gaps_clear`, `facility_gaps_work`) refuse
  anyone's time in a facility while it is turned over whole, and setup on
  top of cleaning there. All raise `23P01`, which every path turns into "taken"; a path that reads
  first and writes after (blocking around bookings) works it out again.
- **Linked courts.** A court over others covers their spaces, so its claims
  and theirs meet in the same constraint, at any number of courts sharing
  one.
- **Coaches.** `coach_claims` has the same constraint per coach.
- **Claiming money.** Money-moving updates claim their row first
  (`… WHERE status = 'confirmed'`, `… WHERE status = 'pending'`), so a second
  attempt changes nothing.

## Status of each guarantee

The evidence separates guarantees from measurements. A guarantee (exactly
one booking through, the rest refused as taken, never busy, nothing left
held, the integrity check clean) holds on any machine and fails its test
whenever it does not. How long a round took and how many transactions ran
again depend on the machine and its load: `tests/contention.test.ts`
records them per round and judges them at its end, in tests of their own
(*measured on this machine*), against the bounds in the table below, never
loosened; a slow round fails there with every round's figures and does not
stand in for, or hide, a guarantee. Measurements on the development
container are not a production figure.

| Guarantee | Status | Evidence | Gaps |
| --------- | ------ | -------- | ---- |
| A minute of an exclusive court is sold once | Verified on Postgres | Exclusion constraint `claims_no_overlap` (migration 0089); raw SQL refused in `tests/capacity.test.ts` "is still the database that prevents overbooking"; `tests/concurrency.test.ts` "sells the last court to one person"; `tests/intervals.test.ts` "race for the same minutes, and only one gets them"; `tests/contention.test.ts`: 24 at once for one court, four rounds: one booked, the rest refused as taken (not busy), no claim left behind; measured: each round under 8 s | Measured on one machine (four cores). The contention and concurrency files passed 20 runs in a row on Postgres 16, 7–8 s a run |
| Independent bookings do not fail each other | Verified on Postgres | `tests/contention.test.ts`: 24 at once at 24 venues, and on 24 courts of one venue, four rounds each: all booked, none out of tries; measured: at most two retries a round; `tests/booking-references-deferred.test.ts`: the order of events that made one of three a pivot now commits all three; the [benchmark](../development/testing.md#results): fifty at once at 400 venues, no errors | Measured on one machine; a retry is still possible where two transactions really read what the other wrote |
| A shared facility never holds more than its capacity | Verified on Postgres | Capacity trigger `claims_capacity` under a court-row lock, counting bookings, offers and partial blocks; raw SQL refused in `tests/capacity.test.ts`; "sells a shared floor's places once each"; `tests/intervals.test.ts` "fills a shared facility to its places at every moment"; `tests/contention.test.ts`: 24 at once for a floor of five, four rounds: five booked | — |
| Linked courts take each other | Verified on Postgres | Shared spaces; `tests/court-links.test.ts` including a two-request race and two wholes over one part; `tests/intervals.test.ts` "holds the court over it too"; `tests/contention.test.ts`: a pitch and its three courts asked for three times each at once, four rounds: the pitch or its courts, never both | Linking is one level deep (a rule of the editor, not of storage). |
| Nothing overlaps a block, class, outage, offer or buffer | Verified on Postgres | All are claims under the same constraint; `tests/outages.test.ts` "a booking made while a court is being taken out"; `tests/move.test.ts` "never leave a booking inside the block"; `tests/intervals.test.ts` buffers | — |
| Neighbours on a space are at least the larger of their facing separations apart | Verified on Postgres | `claim_gaps_apart` (migration 0119), an exclusion constraint that reads nothing, so it adds no serializable retries; raw SQL refused, two bookings racing for times 5 minutes apart (one of them gets it, four rounds, a court and a pitch over a court), and two raw writers without the application's locks under read committed and serializable, in `tests/separation.test.ts` | Shared facilities turned over per place hold separation as places under the capacity trigger instead (it adds up there; [why](booking-time-model.md#shared-facilities-how-they-are-turned-over)) |
| Nobody is in a facility turned over whole while it is set up, cleaned or kept free, and its setup and cleaning add up | Verified on Postgres | `facility_gaps_clear` and `facility_gaps_work` (migration 0131), exclusion constraints that read nothing; raw SQL refused, a session and a booking inside its turnover racing (never both, four rounds), and two raw writers without the application's locks under read committed and serializable, in `tests/shared-turnover.test.ts` | — |
| A coach is in one lesson at a time | Verified on Postgres | `coach_claims_no_overlap`; `tests/coaching.test.ts` "will not put the coach in two places at once"; `tests/concurrency.test.ts` "puts a coach in one lesson at a time, and lets the other courts go" (eight lessons on eight courts at once: one sold, the other courts left free); `tests/contention.test.ts` the same through the booking route, four rounds: one 201, no 5xx | — |
| A slot held for an approval application is sold once, and approving never overbooks it | Verified on Postgres | The hold is an `approval` claim under the same constraint and trigger, let go and replaced by the booking in one transaction; the application row is locked for each decision. `tests/approvals.test.ts`: "holds the slot from everybody else", "lets a hold go when its time is up; approved after the slot was taken, nothing is overbooked", "two approvals racing for one place", "the same application approved twice at once" | — |
| A payment for a booking made on approval ends as one paid booking or an amount owed back, never both and never neither | Verified on Postgres | The booking is held by the ordinary booking hold; a payment after the hold was let go is turned back into the booking under the application's and the payment's row locks, through the ordinary booking path, or left owed back, and either outcome is written once, keyed to the payment. `tests/approval-workflow.test.ts`: "two approved applicants for the last place", "a payment arriving just as the hold runs out", "a payment after the hold was let go becomes the booking again … told twice, it counts once", "… slot taken is owed back", "staff cancelling the session while the customer pays", "an approval revoked before the booking is paid", "recovers a payment whose processing stopped part-way" | A late deposit stays owed back ([ADR 0020](decisions/0020-approval-to-booking-payment-and-authority.md)) |
| A freed hour goes to one of a reschedule and a new booking | Verified on Postgres | Both claim under the same constraint in their own transactions; `tests/concurrency.test.ts` "gives a freed hour to one of a move and a new booking, never both" | — |
| A court offering several activities is sold for one at a time | Verified | Every activity claims the court's same spaces; `tests/activities.test.ts` "is booked for one activity at a time" | — |
| Bookings and held time agree | Checked daily | `src/lib/integrity.ts` from the scheduler; each race test above ends with it finding nothing; `tests/integrity.test.ts` | Finds, does not repair: putting a mismatch right is the platform owner's call. |
| Every path sees the same availability | Met | Grid, search, any court, waiting lists, the move picker and rescheduling read one list of claims (`occupantsOn` in `src/lib/claims.ts`); the database refuses whatever a stale read lets through | — |
| A group booking (several courts) is all or nothing | Verified | One transaction; `tests/group-bookings.test.ts` "even when something breaks part-way" | — |
| A cancellation refunds once | Verified on Postgres | The claim on `status = 'confirmed'` and every refund are one transaction; a failure part-way leaves the booking booked and nothing refunded; two cancels of a paid booking at once, and a class called off while a place in it is cancelled, refund once (`tests/refund-recovery.test.ts`); three cancels of an unpaid one (`tests/booking-rules.test.ts`) | A refund through the gateway is asked for after the commit (it cannot be in the transaction): written down as owed first, retried under its key if interrupted, raised if unanswered |
| Credit and pass entries are spent once | Verified on Postgres | "spends credit once", "refunds a pass entry once" | No database constraint against a negative balance (chargebacks may make one deliberately). |
| A payment notification settles once | Verified on Postgres | Claim on `status = 'pending'`; unique `bill_id`; `tests/payments.test.ts`, `tests/stripe.test.ts`; three reports of one payment at the same moment settle it once (`tests/tournaments.test.ts`, "at the counter, then online"); a second payment for what is already paid is owed back, not kept (M12) | — |
| A tournament takes no more entries than its size, a division cap holds across a competition, and nobody is in a tournament or league twice | Verified on Postgres | Entering counts and inserts in one transaction under the tournament's row lock (and its competition's first, for a division); a withdrawal that promotes from the waiting list takes the same lock; joining a league runs under the league's. `tests/entry-races.test.ts`: three entering at once for the last place (one entered, two waiting), a withdrawal meeting two new entries, one player entering twice at once and two divisions of a capped competition at once, one player joining a league twice at once | — |
| A split booking is split once, and its shares never change once a friend has paid or while one is paying | Verified on Postgres | `splitBooking` decides under the booking's row lock, as a friend's share is counted (`countSplitShare` writes the booking); a first split inserts `ON CONFLICT (booking_id) DO NOTHING`. `tests/split-races.test.ts`: two first splits at once, a re-split refused while a share is being paid and once one is paid, a re-split and a share settling at once | A friend's payment page still being opened at the gateway (it is recorded once the gateway answers) when the booker re-splits keeps the share it was opened at: it counts for what it took (`shares_paid` adds money, never the split's arithmetic), so no money is lost, but the link may show a share count that no longer divides evenly |

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
