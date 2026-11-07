# ADR 0069: The terms a booking was sold on govern it; a customer who has arrived cancels through staff; an edit of the hours or the rules and a booking meet in one transaction

- **Status:** current, decided 2026-11-07 in the post-audit hardening round on the owner's authorisation (audit 9: B12 / DEC-09, B14, E18 / DEC-45); built in migration 0330. What a
  customer and staff see is in [the terms a booking was sold on](../../features/booking.md#the-terms-a-booking-was-sold-on-govern-it),
  [cancelling after the customer has arrived](../../features/booking.md#cancelling-after-the-customer-has-arrived) and
  [the hours and a booking at the same moment](../../features/booking.md#booking-rules-starts-lengths-buffers). Builds on [ADR 0002](0002-database-enforced-concurrency.md)
  (the database decides, transactions are serializable), [ADR 0053](0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md) (a closure and a booking meet in one
  transaction) and [ADR 0058](0058-safety-and-access-after-a-booking-is-made.md) (what a customer's own check-in proves; its decision 5 is replaced here). The smallest change that gives
  the owner's outcome; no new table, no new engine.
- **Context:** (1) The cutoff, the late-cancel share and the give-back were read from the venue at the moment of cancelling, so a manager raising the cutoff from 2 hours to 48
  made every existing booking uncancellable and changing *keep 50%* to *keep 100%* changed what an existing customer lost; nothing recorded what the customer was shown. (2) A
  customer could reveal the door code or check themselves in, cancel on a venue's late terms and still use a court that was then offered to somebody else. (3) A manager's edit of the
  hours or the rules checked the bookings and then wrote, outside one transaction, and a booking checked its hours before its own transaction began, so each could pass its check and
  commit over the other.

## Decision 1 (B12 / DEC-09): the terms shown at booking govern that booking

- **Snapshot at booking, honoured at cancelling.** Every booking is made by one statement (`createBookingSeries`), and it writes `bookings.cancel_terms` (JSONB, nullable, migration
  0330) in the booking's own transaction, read in that transaction: the free-cancellation cutoff in hours (the sport's own where the venue gave the sport rules), the share the venue keeps of
  a late cancellation (`lateKeep`, null: no late cancelling online), the give-back flag, and, as **evidence only**, the digest of what the customer was shown (`version`: the terms
  endpoint's, so a dispute can match them), when it was taken, the strike limit and window, how money paid online goes back and how long staff take, the hold and deposit terms. A database
  check keeps it an object.
- **What binds:** the cutoff, the late share and the give-back, through one reader (`bookingCancelTerms`, `src/lib/cancel-policy.ts`) used by a customer's cancelling, a series' weeks, taking
  a person off a booking, the deadline for changing a booking's time (`cancelCutoffForBooking`, `changeDeadline`, `customerChangeRefusal`), an account's closure, the counter's *keep the late
  share* option, `/my-booking` and the account's list. A policy edit changes what the **next** booking is sold on. It works **both ways** ("what the customer was shown is what binds"): a venue that
  later allows late cancelling does not change a booking sold without it; staff can still cancel it in full, which is an explicit, logged choice.
- **What stays the venue's setting of the day:** how money paid online goes back (card, credit, by hand) and how long staff take, and the strike rules. The *amount* owed is the same whichever way
  it goes back; a strike limit is about a number, not a booking. They are kept as evidence on the booking. (Honouring the method would touch the refund engine's every caller for a change of
  presentation; it is recorded in known limitations.)
- **A series:** one snapshot, taken once in the series' transaction, for all its weeks: the terms current when the series was **booked**, not week by week. A policy edit racing a booking
  gives the booking the old terms or the new ones in full, never a mix (the reads are inside the serializable transaction).
- **A reschedule keeps the original terms** (customer-protective: moving is not a new sale); the cutoff is measured against the new time. A class move, a lesson's move and a coach's change keep
  them too.
- **Staff overrides stay explicit and audited.** The counter's preview shows whose terms it shows (`terms`: `booked` or `current`, `termsVersion`). Staff may still choose *back* past the cutoff,
  which waives the late share; the activity log (`booking.cancelled`) says it was past the cutoff the booking was sold on, and whether the customer had checked in.
- **Bookings made before the migration** carry NULL and are read on the venue's current terms at cancelling, as they always were. **Nothing is backfilled**: what such a customer was shown is not
  recorded anywhere, and stamping today's terms on them would invent past terms. A customer-better choice between "live" and "none" is not derivable (there is no "none"). Recorded as a known
  limitation; it fades as those bookings are played. A snapshot that is not an object this code wrote (hand-edited data) is no snapshot, and the current terms apply.
- **Alternatives (DEC-09):** (b) the better of the booking's and the current terms for the customer: rejected, the owner decided (a); (c) live terms with a notice: today's behaviour.

## Decision 2 (E18 / DEC-45): a customer who has arrived does not get both a full refund and the court

What was given decides (`accessGivenTo`, `src/lib/store.ts`), the strongest first:

| Given | A customer's online cancel | Reason |
| --- | --- | --- |
| a desk's check-in, or a self check-in staff confirmed (`verified`) | refused, `CANCEL_AFTER_ARRIVAL`: ask staff | verified attendance |
| their own QR check-in, unconfirmed (`self_checked_in`) | refused, `CANCEL_AFTER_ARRIVAL`: ask staff | not verified, but a deliberate arrival; a person decides |
| the door code shown on their phone only (`code_viewed`) | the booking's own terms | looking proves nothing; **a refund is never taken for having looked** |
| nothing | the booking's own terms | |
| venue-cancelled (closure, rain-out, outage, staff's cancel) | not this path | the venue's decision; the customer is refunded as the venue chose |
| genuine inability, emergency | staff cancel and refund, on the record | the exception is a person's |

- The refusal is a **route to a person, never a forfeit**: nothing is confiscated or kept. Staff's cancellation (`/api/admin/bookings/cancel`) is unchanged and is the venue-approved exception; its
  preview carries `access` and the log says the customer had checked in or been shown the code.
- It is the same on a **series** (the week *stays*, reason `arrived`, whether the arrival came before the plan or between the plan and the cancel), on **taking a person off a booking**, and the
  check-in and the cancel each ask the booking again **in their own transactions**: an arrival and a cancel at the same moment end as one or the other (serializable: one is run again), never as a
  refunded booking that was also arrived at; a code is never given to a booking cancelled at that moment.
- **Revocation:** the code is given only for a booking that is confirmed, paid and in its window (`accessCodeFor`), so a cancelled booking is given no code. The physical code is **one for the
  whole resource** and stays known to anybody who saw it; no IoT is built (staffed pilot). A venue that cannot let a cancelled customer walk in relies on the counter, not the code.
  Recorded as a known limitation (*No turnstile or per-person door credentials*).
- Not changed: an account's closure (`cancelForErasure`) cancels on the customer's own terms as before, and a rescheduled booking was already refused once checked in.

## Decision 3 (B14): an edit and a booking meet in one transaction

- The check that lists the bookings an edit would strand and the save that follows are **one transaction**: `updateVenue` (it was two statements), `updatePolicyKeepingBookings` (it read the bookings
  before its transaction and skipped it when there were none), and, already so, `setHoursChange`, `withdrawHoursChange`, `setCourtHoursChange`, `withdrawCourtChange`.
- A booking (`createBookingSeries`), a class's first session (`createClassSessions`), a reschedule and a class move ask the hours, the closed day and the court's rules **again inside their own
  transaction, from the court as it is now** (its own dated hours were read once, before), the first week of a booking included (later weeks already were). Serializable isolation does the rest:
  the edit read what is booked, the booking read the hours it was written against, so one of the two sees the other or is run again. No new lock, no broad lock; the claims constraints are untouched.
- A manager's override (`staff.override`) goes past what it went past before and is recorded; it never goes past a closed day or a change of the clocks. A reschedule refuses only what is **new**
  since it was checked (a notice is a matter of the clock, not an edit).
- Not covered, recorded: narrowing the venue's hours does not list **classes** (it never did: `strandedByHours` reads bookings only), so a class and an edit can still pass each other; a launch or tide
  window and a sign-off are checked once, as before. An unrelated pre-existing matter: a class series is checked for hours on its first session only.

## What was left open

- Whether the confirmation email and the receipt repeat the terms (the evidence is stored; the wording is not added).
- Honouring the refund *method* snapshot; a backfill of bookings made before 0330 (the owner could choose to stamp today's terms on upcoming bookings, knowing it is an assumption).
- Whether self check-in alone should refuse (a stricter reading than "code viewed only") or only a staff-verified arrival: the principle allows either; the stricter, which routes to a person without
  forfeiting anything, was chosen.
- A per-person door credential or a turnstile (out of scope: no IoT).
