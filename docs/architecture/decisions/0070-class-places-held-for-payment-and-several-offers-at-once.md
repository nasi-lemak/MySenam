# ADR 0070: A venue that holds for payment holds class places too, a class offers every free place at once

- **Status:** current, decided 2026-11-07 in the post-audit hardening round (owner decision DEC-11, audit findings B9 = E10; and B6 for classes). No migration: the venue's
  existing settings are used. What people see is in [programmes](../../features/programmes.md#classes), [waitlists](../../features/booking.md#waitlists) and
  [paying online to hold a booking](../../features/payments-and-credit.md#paying-online-to-hold-a-booking); the route is in [the HTTP API](../http-api.md). Builds on
  [ADR 0060](0060-waiting-list-offers-windows-starts-and-closing.md) (offers: windows, never past the start; amended here: a class no longer has one live offer at a time),
  [ADR 0054](0054-money-paid-never-above-price-and-no-silent-price.md) (holds and the stranded-booking sweep) and [ADR 0002](0002-database-enforced-concurrency.md).
- **Context:** `POST /api/classes/enrol` never held an unpaid enrolment, whatever the venue's pay-to-hold setting, so an unpaid online place kept its capacity until the class
  began; a place claimed from the class's waiting list *was* held until paid. The same place was held or not according to the way it was got. A venue that asks for payment
  online to hold courts could not get the same for its scarcest capacity. Separately, a class with three places free and five people waiting offered one place and left the rest
  until that offer was taken up or lapsed.

## Decision 1: one hold, the booking hold

- An enrolment made **online by a customer** and still to pay is held when the venue holds (`holdPolicy().active`, or a number past its no-shows, through the same `claimHold` a waiting-list
  claim asks) for the venue's own `hold_minutes` (5 to 60, default 15): `bookings.hold_until`, set by `holdNewBookings` after the enrolment and any payment from credit. There is no second hold engine and
  no new setting. Nothing else is different about the booking: the capacity count, the capacity trigger and the class's row lock treat a held place as a taken place, so it cannot be sold twice.
- **It covers every kind of enrolment alike**: one session; a term (each session's enrolment held, the bill one, so one payment settles all, and each session let go on its own); a family's or
  group's places (one enrolment per person, held and let go together); and a waiting-list claim (already held, now capped as below). Group *court* bookings were already held with the rest of
  the booking route.
- **Never past the start.** A class place's hold is cut to the start of its class (`capHoldsAtClassStart`, in `holdNewBookings` and in `extendHolds`): a place nobody paid for is not kept into the
  lesson, an open payment page does not extend it past the start, and the release has time to offer the place on. A class that has begun is refused at enrolment as ever.
- **Paid** settles as any booking does (`settleBill`: once, whichever of the callback and the return comes first), clears the hold and sends the confirmation (the generic booking confirmation, as for a
  claimed place; nothing is said before). **Not paid in time**, the scheduler's sweep (and the read-through calls that already run it) lets it go (`releaseExpiredHolds`: cancelled, `released_unpaid`, its claim
  released, its promo and shares settled), once and idempotently, and offers the freed place to the class's waiting list (`offerFreedPlace`, which the sweep already used for a class place).
- **Not held**: enrolments the venue's staff make (at the counter, paid as made, or on the venue's word to pay later: staff-approved pay-later stays as configured), ones paid in full at once from credit or a
  pass, free ones, and venues that do not ask for it (the default).
- **A payment after the place was let go** follows the booking's existing late path unchanged (DEC-14 is not decided here): the money is recorded as owed back (`refund_due`), the place is not revived and
  not taken from whoever has it since. If the billing round adds a shared late-payment helper, a class booking goes through it like any other, since an enrolment is a booking: that is the seam.
- **Left as it was:** a struck-out number or a guest in a flood of guest bookings is still refused online for a class (known limitation B43, *a class place cannot be held*). Holding class places makes it
  possible to offer them the court's way out (pay to hold) instead; that loosens a restriction and is the owner's to decide. The request-died-between-commit-and-hold gap (B10) is not closed for classes:
  `holdStrandedBookings` still skips class places, since it would otherwise let go, on its first run, unpaid enrolments made under the old rule within the last three hours.

## Decision 2: a class offers every free place at once

- `offerClassPlace` takes the class's row lock (the one enrolling, claiming and calling off take), counts the free places (capacity less enrolments, held for payment or not, less the places of live offers),
  and offers each waiting entry in turn that fits the places left, until none is left. An entry for two people holds two places; one that does not fit waits and a later one that does is offered. Each offer
  has its own window (ADR 0060, never past the start). Three places freed with five waiting make three offers; the fourth place freed makes a fourth. The lock makes the count safe: two places freed at the same moment
  cannot promise four, and every offer made can be claimed (a claim counts the *other* offers as held, so over-promising would have made each refuse the other).
- A taken-up offer, a lapse, a leave and a release already ran `offerClassPlace` again; they now fill every place that is free. The test that said "one at a time" (`tests/waitlist.test.ts`) was changed.

## Consequences

- A pay-to-hold venue's unpaid online class places now vanish at the end of the hold; the customer can still enrol at the counter, paid.
- A customer enrolling a term minutes before its first class has a first-session hold that ends at that class's start while the rest keep the venue's minutes; paying the one bill later settles what is still
  held and owes back the part for a session let go.
- Verified with a fake gateway on PGlite and Postgres 16 (`tests/class-pay-to-hold.test.ts`, `tests/class-offers-several-places.test.ts`); no real Billplz or Stripe check (`INTEGRATION_VERIFICATION_REQUIRED`).
