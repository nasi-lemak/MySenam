# ADR 0053: A closure, a rain-out and an outage are written first; what has been played is left alone; a weekly series is checked week by week

- **Status:** current, decided 2026-11-06 from the owner's principles for the audit-9 round. Built in migration 0295. What staff and customers see is in
  [closed days](../../features/booking.md#operating-hours-and-closed-days), [courts out of service](../../features/booking.md#courts-out-of-service) (and *Rained off*
  beneath it) and [classes](../../features/programmes.md). Builds on [ADR 0010](0010-interval-booking.md) (court time as claims under exclusion constraints),
  [ADR 0002](0002-database-enforced-concurrency.md) and [ADR 0027](0027-hours-and-rates-from-a-date.md) (the date asked about decides).
- **Context:** the venue's three ways of taking time away (closing a day, a rain-out, taking a court out of service) each cancelled what was booked and **then** wrote the
  closure, block or outage. Every cancellation offered the freed slot to the waiting list, so a waiter could be offered, and could claim, time the venue was closing (a
  confirmed booking in a rained-off hour); an outage could fail with "bookings keep arriving" after every booking was already cancelled, refunded and messaged; a booking
  made between the cancelling and the closing stayed confirmed on a closed day. A class called off read its roster before locking it, so an enrolment at the same moment
  stayed confirmed in a cancelled class. What had already been played was cancelled and refunded as if it had not (classes, and for an outage any booking earlier that day), and a
  past date was refused only after everything had been cancelled. A weekly series was checked against the hours and weekdays of its first date only.

## Decision 1: the closure is the decision, and it exists before anything else is done

- **A closed day** writes `venue_closures` first, in a transaction that also reads what is booked that day (the transactions are serializable, so a booking made at the
  same moment and this closure cannot both miss each other: the booking path now asks for the closure inside its own transaction, for the first week as for the others).
  Only then are bookings and classes cancelled, refunded and told, with **nothing offered to the waiting list**; the sweep goes round again for anything that was booked
  before the closure was written. Live offers for the day are let go: the entry goes **back to waiting** (its place is not burned), its hold on the court is released,
  and `offerSlotPlace` and `offerClassPlace` refuse a closed day, so nothing can be offered again. Waiting entries on a closed day are **left waiting** (for a day that
  is opened again), not dropped and not messaged; the owner may decide otherwise (open question below).
- **A rain-out** blocks the hours first (letting go live offers in them), then calls off each booking and class in a transaction that also blocks the time it frees, so the freed
  time is never open between the two, and offers it to nobody. Bookings that slipped in before the block are found by going round again.
- **A court out of service** is one transaction: the bookings and classes in the way are cancelled and refunded, live offers on the court are let go, the outage is written and
  the court claimed, or none of it is. Customers are told and online money refunded once it has committed. Because the claim is what keeps bookings out, a booking that
  arrives first makes the claim refuse and the whole transaction goes round again (a few times, then it says so, with nothing changed). Its claim starts from the moment it was
  taken out (`court_outages.claimed_from`), so hours already played on its first day are never in its way, and ending it later claims the same time again.
- **What cannot be cancelled** (kit still out) is never skipped silently. A closed day and a rain-out finish what they can and **name** the booking (`left`) for the desk; the day is
  closed and the hours blocked around it. A court cannot go out over a standing booking, so taking it out is refused naming it, with nothing changed.

## Decision 2: what has been played is left alone

A booking or class that has **ended** is history. It is never listed as affected, never cancelled, never refunded and never messaged, by a closed day, a rain-out, an outage or a
manual cancel (`CANCEL_PLAYED` for bookings, as before; a class says so too). One **under way** may still be called off (a leak, a power cut), as bookings always could. An
outage "from now" is therefore not refused because earlier-today bookings were played, and a past date is refused before anything is cancelled.

## Decision 3: calling a class off takes the class lock

`cancelClassSession` locks the class row and reads its roster inside the transaction. An enrolment or a waiting-list claim at the same moment either lands first (and is
cancelled, refunded and told with the rest) or is refused `CLASS_CANCELLED`; no confirmed enrolment remains in a cancelled class.

## Decision 4: a weekly series is checked against each week's own date

Each later week is checked against the hours, closed weekdays and court rules in force on its own date (`courtDay` for that date, so a change of hours set from a later date reaches
it). A week that does not fit is skipped with its reason where the customer chose to skip unavailable weeks, as a clash or a closed day is, and refuses the series otherwise; staff who may go past the court's rules book it anyway, recorded as an override.

## Consequences

- No change to the claims constraints, refunds or credit notes; refunds and counter payments owed back use the paths they always did.
- Open question for the owner: whether waiting entries for a closed day should be **dropped with a message** (the audit's recommendation) rather than left waiting. They are left waiting
  now because that needs customer text in four languages and a decision about what the customer is told; nothing can be offered for the closed day either way.
- Hours already played inside an *outage that began before this change* are unchanged (its claim has no `claimed_from`).
