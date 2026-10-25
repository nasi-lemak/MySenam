# ADR 0019: Approval applications are their own record; a slot is held, not booked; nothing pending opens a door

- **Status:** current, decided 2026-10-25 by the product owner. How customers,
  staff and coaches use it is
  [registering online for approval](../../features/activities.md#registering-online-for-approval).
- **Context:** an activity whose booking rules ask for a sign-off or a
  certification ([sign-offs](../../features/activities.md#sign-offs)) could be
  booked online only by somebody who already held one; everybody else was
  sent to the counter, even just to register or ask for a first lesson. The
  owner decided customers must be able to register and be approved remotely,
  by staff or by the independent instructors the venue lists, without
  weakening any safety rule, reserving courts indefinitely, charging for
  something not yet confirmed, or opening a door to somebody not yet
  approved.
- **Decision:**
  - **A separate record, not new booking statuses.** An application
    (`approval_requests`, migration 0114) belongs to a customer's account, an
    activity and a venue, and carries its own status (`pending`, the
    `PENDING_APPROVAL` of the request; `info_requested`; `in_person_due`;
    `approved`; `rejected`; `withdrawn`; `expired`). Bookings keep their
    statuses and meaning; no booking exists for an application until it is
    booked.
  - **Approving writes what the booking rules already check.** An approval
    writes a sign-off or certification (`sign_offs`, `addSignOff`) linked to
    the account, with the venue's period as its end. No booking path learns
    about applications: the waiting list, weekly bookings, rescheduling, open
    games and the venue's API keep checking `signOffHolds` exactly as before.
    Renewal is a new application; expiry is the sign-off's own end.
  - **What is asked is data, per venue and activity**
    (`approval_requirements`): questions, an online declaration, documents
    staff review, a video briefing, an in-person step, the waiver, the
    validity, how long an application may wait and how long a slot is held,
    and which coaches may review. No branch on the activity.
  - **An in-person step is never replaced online.** Accepting the online part
    of an application with an in-person step leaves it `in_person_due`; only
    a reviewer recording the step completes it.
  - **A slot is held by an expiring claim, not a booking.** A slot asked for
    is a claim of its own kind (`approval`, with a required `expires_at`),
    under the same exclusion constraint and capacity trigger as every claim,
    so it is never sold twice and lapses on its own. On approval the
    ordinary booking path (`createBookingSeries`) lets the hold go and claims
    the booking in one transaction; if the slot went after the hold lapsed,
    the database refuses and the customer is offered the waiting list or
    another time. Each decision locks the application's row, so one
    application is decided, and booked, once.
  - **The in-person session is the one booking not held to the sign-off.**
    Once the online part is accepted, the slot is booked as the session at
    which staff do the in-person step (`approval.assessment`, set only by
    lib/approvals.ts). It opens no door: the door-code check now asks for a
    sign-off in force wherever the activity needs one.
  - **Nothing pending grants anything.** Not a booking of the activity, not a
    door code, not a place: an unmanned resource's code is withheld
    (`approval-needed`) for an activity that needs a sign-off until one is in
    force for the number booked, whoever made the booking.
  - **Reviewers are the venue's staff and the coaches it names.** Staff
    decide as they give sign-offs (manager or front desk); what is asked is
    the managers'. A coach decides at their private link only applications
    for activities the venue authorised them for, with no other powers.
    Every decision is in the application's history and the staff activity
    log, a coach's and the system's under their own names.
  - **Documents live in the database, not the photo store.** They are
    private, small (images, redrawn as venue photos are, at most three) and
    short-lived (deleted 90 days after the decision), and the photo store is
    built for public files. In the database they are in the encrypted backup
    set, served only through checked routes, erased with the record.
- **Consequences:** nothing is charged until a booking exists, so refusing or
  lapsing an application has nothing to refund, and a booking made on
  approval is paid, refunded and cancelled the ordinary ways; it is not held
  for payment at venues asking payment to hold, since the customer was not
  there to pay. Approval and the slot are independent: an application can be
  approved and its slot found gone. A booking a manager makes past the rules
  for an activity needing a sign-off no longer gets an unmanned door's code
  without one. Database backups grow with documents in the 90-day window.
  A parent cannot yet apply for a child from the parent's own account, and a
  coach's lesson is not held with an application (court time is).
