# ADR 0058: Safety and access after a booking is made: a refused number, eligibility taken back, and what counts as attendance

- **Status:** current, decided 2026-11-06 on an audit's findings (audit 9, auditor E: E2, E3, E4, E7, E18); built in migration 0303. What staff and customers
  see is in [check-in](../../features/venue-operations.md#check-in-and-live-crowd-levels),
  [unstaffed hours and door codes](../../features/venue-operations.md#resources-nobody-is-standing-next-to) and
  [bookings that need a decision](../../features/venue-operations.md#bookings-that-need-a-decision). Builds on [ADR 0020](0020-approval-to-booking-payment-and-authority.md)
  (a door code never bypasses eligibility), [ADR 0026](0026-same-policies-on-every-path-with-manager-overrides.md) (nothing overrides a refused number: "no path books it now")
  and [ADR 0002](0002-database-enforced-concurrency.md). Every default below is the audit's recommended one; where a venue could reasonably choose otherwise it is
  listed under *What was left open*.
- **Context:** the booking path was careful, and the safety checks that follow it were not. A venue could refuse a number and the number's paid booking still opened an
  unattended door; an unstaffed hour was sold to somebody the door would turn away, with the money taken; a sign-off taken back left the person's bookings as if nothing had
  happened (only an approval's revocation flagged them); and one `check_ins` row served the headcount, the strikes and "attendance taken", so a tap on a link on a customer's
  phone cleared a no-show the desk had recorded, froze a class that needed moving and made a lesson count as held for the coach's pay.

## Decision 1: a refused number loses the unattended ways in at once, and its bookings are listed, not cancelled

- `accessCodeFor` and the QR self check-in (`checkInByToken`) refuse a booking whose number the venue refuses (`isBlocked`): `FX9_DOOR_BLOCKED`, "see the venue", whatever else
  holds (paid, inducted, signed off). The desk's own check-in is a person looking at the customer, so it is not refused; the desk sees the booking in the list below.
- Refusing a number (`blockPhone`) lists its confirmed bookings at that venue that have not ended (classes and lessons are bookings too) in the **needs-attention list**, once
  each, and **returns the count**, which the manager is shown at once ("N upcoming bookings left for you to decide"). **None is cancelled, none refunded by the system.**
- The manager decides each: **cancel with a refund** (the ordinary staff cancellation, `POST /api/admin/bookings/cancel`: what was paid goes back as it was paid, the customer is
  told; the booking then leaves the list) or **leave it**, with a note kept on record (`safety.flag_resolved`). Leaving is a manager's, not the front desk's. Taking the number off the
  refused list settles what was listed for it.
- Why not auto-cancel: refusing a number is a quick safety lever and a refund is money and a customer's day; the venue knows whether the booking is a coach's class, a
  supervised session or a mistake. The system removes the *unattended* risk now and leaves the *decision* to a person.

## Decision 2: an unstaffed hour asks at booking what the door will ask

- Where the door code is the way in (an unmanned resource with a code, at a time the counter is not staffed; `doorFor` says `code`), a customer is asked at booking for the sign-off
  or certification the activity needs: the activity's booking rules, **and** an activity the venue takes approval applications for (the same `signOffNeeded` the door uses, so
  they cannot disagree). Refused at booking with the existing `SIGN_OFF_NEEDED` / `CERTIFICATION_NEEDED` words, before any payment. A manager going past the rules still can, on
  record, and the door still waits for the person's own sign-off (ADR 0020, unchanged).
- A **staffed** time keeps its flow: nothing new is asked, the counter is there.
- An **induction** is taken in person, at the desk, while it is open, so it can be satisfied after booking: the booking is **allowed and the customer is told clearly**, on the
  confirmation and on the booking's page, that the time is unstaffed and a run-through at the desk comes first (`inductionNeeded`). The door's check stays the second line
  (`no-induction`).

## Decision 3: eligibility taken back is flagged, and the customer told once

- A sign-off or certification taken back in the Sign-offs tab, and an induction withdrawn, **flag the person's upcoming confirmed bookings it affects** (the activity it was for,
  on a resource whose activity asks for one; for an induction, on a resource with a door code), unless another sign-off or induction still covers them. A flag records **what, who
  took it back, when and the reason**, shows in the needs-attention list, and the **customer is emailed once** (`booking_safety_notice`; a booking with no email is shown as "not
  told: tell them"). Nothing is cancelled. A sign-off written by an approval keeps the approval's own flagging (ADR 0020).
- The **door code is not issued** for a flagged booking until staff decide (`FX9_DOOR_FLAGGED`); a **staffed** venue's flagged booking is not blocked at all (the desk is there).
  Recording the sign-off or induction again **settles the flag by itself** ("granted again"), so no door waits on a decision nobody needs to make.
- A waiver is not here: no person's waiver is ever taken back (a new version is agreed afresh at the next booking), so there is nothing to flag.

## Decision 4: a customer's own check-in is recorded as such and is not verified attendance

- `check_ins.source` is `desk` (the default, and every row from before: verified), `self` (the QR link) or `door` (a door code revealed on the customer's phone). A `self` or
  `door` row is **verified attendance only once staff confirm it** (`confirmed_at`, by whom): **one tap** on the Bookings tab's Attendance chip (the same Check-in call: a desk
  check-in of a booking already self-checked-in is the confirmation), the class roster, kit handed over, or a person marked arrived in the register.
- Until then a self check-in or door code **counts for the headcount** (who is in the building) and is **visible to staff** as the customer's own, but it: **does not clear a no-show
  the desk recorded**, **does not freeze a class move** (`CLSA_MOVE_ATTENDANCE` counts verified attendance only), and **does not count as having played** for a review of an unpaid,
  priced booking. The no-show flag stays the one "did not come" signal for coach pay, reviews and loyalty, so none of them changes meaning. Staff may still mark a no-show after
  a remote tap; once they confirmed the arrival they cannot. Confirming clears a no-show.
- **Recommended default, not a decision recorded in the documents:** the venue-operations page called check-in "arrivals do not depend on a staff member pressing a button" for the
  headcount, which this keeps; nothing in the documents or an earlier ADR gives self check-in the power to undo a strike.

## Decision 5 (E18): late cancellation after the code was revealed or a self check-in is left as it is

> **Superseded by [ADR 0069](0069-the-terms-a-booking-was-sold-on-govern-it-arrival-goes-to-staff-and-edits-meet-bookings-in-one-transaction.md), decision 2**, on the owner's principle (DEC-45):
> a customer's own check-in or a staff-verified arrival sends the customer's online cancellation to staff; a door code only shown is not a reason to refuse or to take a refund. What follows is
> what was decided here and is kept as written.

A customer can still cancel on the venue's late terms after revealing the door code or checking themselves in. At the default two-hour cutoff nothing can happen (check-in opens 60
minutes before the start); a venue that sets a cutoff under an hour or late-cancel terms can see a customer reveal the code, cancel and use the court. No small clear rule exists in the
documents (refusing the cancel would also trap somebody who revealed the code and cannot come), so this is **recorded as a known limitation and left**: a refusal, a fee or a rule that
a revealed code ends free cancellation is the owner's to choose, and could now sit on `source` as a rule.

## What was left open

- Whether the desk may check in a refused number (today: yes, it is a person looking at them).
- Whether the induction ask at booking becomes a refusal online (the audit's alternative); today it is told, not refused, because it can be satisfied before play.
- A certification that **expires** before the booking date is checked when the booking is made (the sign-off must hold on the day) but not warned about afterwards.
- The confirmation email and WhatsApp for a booking do not yet repeat the induction note; the confirmation page and the booking's page do.
