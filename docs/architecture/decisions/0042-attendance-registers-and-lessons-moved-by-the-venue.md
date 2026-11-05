# ADR 0042: Attendance registers, and a lesson the venue moves

- **Status:** current, decided 2026-11-05 (the owner asked for "a lesson's time moved
  by staff" and "an attendance register", two of the roadmap's proposed class and
  coaching items). Built in migration 0282. What people see is
  [a lesson moved by the venue](../../features/programmes.md#a-lesson-moved-by-the-venue)
  and [attendance registers](../../features/programmes.md#attendance-registers).
  Moving a class, and a class's instructor as one of the venue's coaches, are a
  separate piece of work and are not decided here.
- **Context:** staff could already move a lesson ("Change time"): its coach goes with it,
  the coach's week and other lessons are checked, the booking keeps its code and
  payment. Three things were missing for a venue to rely on it: a lesson moved to a
  dearer hour was silently repriced (unpaid) or silently not (paid), so what the
  customer owed depended on whether they had paid; a customer whose lesson the venue
  moved had no way out but the ordinary cancellation terms, which may keep a late
  share for a change the customer did not ask for; and a reminder already sent for the
  old time stopped the reminder for the new one. And nobody could say who came: a class
  had a roster of who was *enrolled* and a check-in the customer or the desk did at the
  door, a lesson nothing at all.
- **Decision:**
  - **A venue's move of a lesson is the booking's own staff move, not a second flow.**
    `rescheduleBooking` already refuses what must be refused (the coach's hours and time
    off, `coach_claims` under its exclusion constraint, the court's claims); it gains
    two refusals for lessons moved by staff (started: `LESSON_STARTED`; somebody marked
    present or late: `LESSON_ATTENDED`) and, in the same transaction as the move, one
    row in `lesson_moves` and the re-arming of the lesson's reminders. A preview and a
    race refuse or roll back with nothing written (the row is inside the transaction).
  - **The price stays as agreed**, unpaid or paid, for a lesson *staff* move, whatever
    the new court time costs. The customer is neither charged more nor given back less
    without a choice; staff are shown the difference before they confirm and it is kept
    on the record. The only thing that changes the price of a moved lesson is another
    coach's fee (the owner's earlier decision, unchanged). Changing the price stays the
    manager's logged [price adjustment](../../features/pricing.md#a-managers-price-adjustment)
    (recorded as [ADR 0026](0026-same-policies-on-every-path-with-manager-overrides.md)
    records an override), never a side effect. A lesson its *customer* moves keeps the old rule (repriced
    unpaid, never dearer once paid). This is an intentional change of behaviour for an
    unpaid lesson staff move to a differently priced hour: it used to be repriced.
  - **The customer may cancel with everything back, and it is their act.** A
    `lesson_moves` row carries a window: the venue's days after the move
    (`venues.lesson_move_refund_days`, default 7, 0 to 60, 0 offers none) or the
    lesson's old time if sooner, never past the new start. Nothing is cancelled or
    refunded unless the customer presses the button. It runs through `venueCancel`, the
    path every venue cancellation uses (cause `lesson_moved`, a new value of
    `counter_refunds_owed.cause`): no late share, no strike, online money back through
    the gateway where it can and otherwise owed, credit and pack entries restored, a
    counter payment owed back for staff to hand over. That reuse is deliberate: a
    second refund path for lessons would be a second place for money to go wrong.
  - **The notice carries the offer in its existing wording.** The customer's notice of a
    booking the venue changed (`booking_rescheduled`, the one they acknowledge) gets one
    more sentence in its `money` variable. WhatsApp templates are approved per kind with
    fixed parameters, so adding a sentence to a parameter needs no new template and no
    new approval.
  - **A register is kept per session, by the session's own identifier.** A session is a
    class session (`classes.id`) or a lesson (`bookings.id` with a coach). Neither
    identifier changes when the session moves, so a register stays with it without
    the class mover's code or the lesson mover's code having to move anything. The
    tables carry the session's date only for retention.
  - **A mark is declared, never verified, and nothing reads it.** Present, absent, late,
    excused, a note, who and when. It is not a rating, a result, a level, an eligibility
    input, a late-cancel, a no-show or a charge: no function outside the register, its
    report and the owner of the data reads `attendance_marks`, and a test snapshots
    payments, credit, passes, receipts, strikes, no-show flags, claims and messages
    around every kind of mark. Managers are shown what a venue might do about absences
    (how many, in a row, the entries left on a pass); *absent uses a pass entry* is a
    separate decision for the venue, recorded in the roadmap and not built.
  - **Who may mark, and when, is one rule in one function** (`phaseOf`, `mayWrite`):
    the instructor through their private link (only sessions of theirs; a session that
    is not theirs is "not found", never "forbidden"), the desk and managers from the
    dashboard; from the session's day; editable for the venue's days after
    (`attendance_lock_days`, default 14) or until a manager locks it; after that, or
    before the day, a manager only, and after it with a reason. Every change after a
    first mark is kept with what it was (`attendance_changes`), and a correction of a
    closed register is also logged. The write is made under the session's row (a row
    of `attendance_sessions` made on first use), so a lock and a mark take turns.
  - **Privacy.** A mark names a person only through the booking's own places (the
    customer, or a participant of a managed person, by their participant record), or a
    walk-in's typed name. A child's full name is shown to staff and to the session's own
    instructor, never publicly; the coach's view has no phone number. A customer sees
    their own marks, a guardian their children's, never the note. The export includes
    them; erasing an account or a participant anonymises their marks (no account,
    participant, booking, name or note), kept as counts; marks go 730 days after the
    session with the booking's own names. Nothing leaves the country; nothing is sent
    when somebody is marked.
  - **Reports are for managers.** Per session and per person, with a rate that leaves
    excused sessions out, a "missed in a row" that an excused session neither counts nor
    breaks, and a spreadsheet of the marks. A person is the same across sessions by
    participant record or account; a guest only by the name and number as booked, which
    the report says, since contact details are attributes and never proof of identity
    elsewhere in the product.
- **Not decided here:** a class's instructor being one of the venue's coaches. The
  register reads `classes.coach_id` if that column exists (`classCoachId`, the one
  place to change), so the coach's own link can mark a class once an instructor can be
  a coach; until then the desk and managers mark classes. Open games hosted by staff
  have no register. A venue-defined *absent = pass entry used* is a roadmap item.
- **Consequences:** one migration (0282: two venue settings, `lesson_moves`,
  `attendance_sessions`, `attendance_marks`, `attendance_changes`, a new refund cause).
  A lesson moved by staff to a differently priced hour no longer changes an unpaid
  price. A reminder is re-armed by setting aside the key of one already sent
  (`:moved<id>`), not by deleting it, so the message history is complete.
