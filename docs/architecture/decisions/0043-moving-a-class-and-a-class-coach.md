# ADR 0043: Moving a class, and a class's instructor as one of the venue's coaches

- **Status:** current, decided 2026-11-05 (the owner asked for the roadmap item "moving a class … a class's instructor as one
  of the venue's coaches"). Built in migration 0281. What staff and customers see is in
  [classes](../../features/programmes.md#moving-a-class). Extends [ADR 0010](0010-interval-booking.md) (court time as
  claims) and the coach claims of [one-to-one coaching](../../features/programmes.md#one-to-one-coaching).
- **Context:** a class held its court by a claim, each enrolment was a booking with no claim of its own, and the instructor was
  a typed name. A class that had to move was cancelled and enrolled again: a refund to sort out, a new code and the risk that
  the time the customer had went in between. And a coach could be booked for a lesson over the same coach's class, because
  nothing but a name tied them together.
- **Decision 1: a move is the class's claim made again, in one transaction, never a parallel path.** The enrolments are
  moved with it (court, date, minutes, moments), so every code, payment, pass spend and credit note stays as it was. The old
  claims are let go and the new ones claimed in the same transaction under the classes' row locks (the lock every enrolment
  takes), as a booking is moved (`reclaimBooking`); a time that is taken rolls everything back. All of a series' old claims go
  first, so a weekly series moved by a week lands on its own old times. A session shifts by what the chosen one does, so a
  series' exceptions stay exceptions. The preview and the early refusal read the same rules the database enforces; the
  database, not the preview, is what refuses a double booking.
- **Decision 2: nobody is refunded because the venue moved a class; they are given the choice, once, by their own tap.** The
  message carries a private link good for the install's window (7 days, `class_move_rules`, install data) or until the
  session's original start, whichever is first. The tap is the venue's own cancellation of an enrolment, the one a class
  called off makes, so refunds, credit, pass entries, counter payments owed back and credit notes are the existing machinery,
  never a second one, and a second tap finds it cancelled. A manager decides whether to move; nobody else is asked.
- **Decision 3: a class's coach is claimed in `coach_claims`, the table that keeps a coach in one lesson at a time.** A claim
  belongs to a booking or to a class (a check keeps it to exactly one), and the same exclusion constraint therefore refuses a
  class over a lesson, a lesson over a class and a class over a class, to the minute, whatever the rooms, with no check
  written twice. `classes.coach_id` has no ON DELETE action: a coach is retired, never deleted, and one teaching a class cannot
  lose it. The typed name stays for venues that want one; nothing was migrated; a name that is an active coach's is offered as
  a one-click link.
- **Decision 4: a coach who can no longer teach a class is said, never dropped.** A coach retired, on days off or working other
  hours after the class was set leaves the class as it is; a worklist names the sessions and why until staff change the
  instructor or the coach's hours.
- **Not decided here:** what a coach is paid for a class (payouts are for lessons only), a class roster shown to a coach (the
  coach sees how many places are taken, never who), and an attendance register (attendance taken is, for now, a check-in). Per-session staffing rosters: `classRosterRefusal` asks them
  (ADR 0036), and a coach named to supervise another session then is not taken to teach a class.
- **Consequences:** moving a class on a members-only venue is refused where anyone's membership would not cover the new date
  (ADR 0026: no override goes past it), which can hold up a whole series for one person until their membership is extended or
  their place cancelled. The refund window is not settable per venue.
