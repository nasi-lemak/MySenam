# ADR 0045: Front desk may move a class; a consequential or exceptional move waits for a manager

- **Status:** current, decided 2026-11-05 (the owner: "Allow front desk staff to reschedule classes within their authorized venue.
  Require additional approval for financially consequential or exceptional changes. Maintain audit logs and notify affected
  participants."). Built in migration 0287. What staff see is in
  [front-desk moves and approval](../../features/programmes.md#front-desk-moves-and-approval). **Amends
  [ADR 0043](0043-moving-a-class-and-a-class-coach.md) decision 2's last sentence** (*a manager decides whether to move; nobody else is
  asked*): a desk may move a class at its own venue, and a manager is asked only for what is consequential or exceptional.
- **Context:** moving a class was a manager's alone (`MANAGER_ONLY`), as scheduling and cancelling one are, because it tells everyone
  enrolled and opens a refund window. A desk is who is asked to move a class on the day, so it asked a manager to stand at the screen
  for what is, most of the time, a plain change of time.
- **Decision 1: the desk uses the one path.** A desk's move is `moveClasses`, preview first, under every check, lock and refusal a
  manager's has (the venue's hours and closed days, what holds the court, the instructor, a members-only venue, the roster at the new
  time, attendance taken). Nothing is relaxed: this changes *who may ask*, never *what may happen*. A venue's scope is the existing
  one (`denyVenue`); a request is found by `venue_id`, and one at a venue the staff member does not manage is "not found". The route
  is no longer in `MANAGER_ONLY`; the one setting that returns today's behaviour is per venue, `venues.desk_may_move_classes`
  (on by default, as the owner decided): off, the desk is turned away with the same 403 `MANAGER_ONLY` body as from any manager's
  route, byte for byte, the preview too.
- **Decision 2: what needs approval is computed from the preview, against the venue's numbers.** The numbers are data on the venue
  with the owner's defaults (`class_move_max_days` 14, `class_move_max_series` 4, `class_move_within_hours` 24,
  `class_move_paid_people` not asked, `class_move_price_check` on, `class_move_request_days` 7), and every test is "more than", so 0
  is any. *Financially consequential*: the new time or court prices differently (court time by the venue's rates, `computePrice`; the
  class's own per-place price never changes, and nobody enrolled is repriced); a term or series with paid enrolments; and, where the
  venue asks (`class_move_paid_people` set), more paying people than that. *Exceptional*: a session moved more days than the venue's
  number, more sessions than its number, one that starts or would start within its hours, people waiting, a session moved before.
  A same-price, same-length move with notices is not consequential, and an enrolment having been paid is not by itself a reason (every
  move opens the refund window; nobody is refunded unless they cancel, ADR 0043 decision 2). A manager's own move never needs approval.
- **Decision 3: a request changes nothing and tells nobody.** A desk's move that meets a test is stored (`class_move_requests`: who,
  what, the reasons with their kind, the preview as the desk saw it with counts and no person's name, and a fingerprint of what it was
  computed from), a manager is emailed in their own staff language, and it appears in *Needs attention* and on the classes screen.
  No participant is told, nothing is claimed or released, no refund window opens: that happens only when a move is applied.
- **Decision 4: approving is the move, in the same transaction.** Approval calls `moveClasses` with two hooks (`MoveHooks`): under the
  classes' row locks it locks the request row, refuses if the request is no longer open, and recomputes the fingerprint (the sessions
  and where each goes, who is enrolled, who is waiting) from the database; if the class, its enrolments or its waiting list changed
  since the desk asked, it refuses as changed and the request is closed; in the same transaction, once moved, it marks the request
  approved with the move's id. Two managers approving at once therefore make one move and the other is told it is decided; an
  enrolment at the moment of approval either goes before (refused as changed) or after (it is in the moved class), never half. A move
  that something now stands in the way of is refused with the move's own refusal and the request waits. Declining needs a reason and
  changes nothing.
- **Decision 5: requests close themselves.** After the venue's days (7), never past the class's start; or at once, with the reason
  (`started`, `cancelled`, `changed`), when the class has begun, been cancelled or been moved or changed another way. Closing is run on
  every read and decision and logged by *System*.
- **Decision 6: audit and notice.** Asking, approving, declining and closing are in the staff activity log (`class.move_requested`,
  `class.move_approved`, `class.move_declined`, `class.move_request_closed`), and the applied move is `class.moved` with who
  asked, who approved and why it needed approval; the request keeps its snapshot. The notice to participants is the existing one
  (`sendClassMoveNotices`), written by the venue, never naming a member of staff. The desk is told the outcome by email and on its
  dashboard for three days.
- **Not decided here:** a move across a closed day or outside the hours is refused for everyone, as before (there is no override for a
  class move, so there is nothing to approve); a request cannot be withdrawn by the desk that made it (a manager declines it, or it
  closes); the approval of a request is not an override of any safeguard.
- **Consequences:** a venue that wants the earlier rule sets one switch. A desk that moves a class whose waiting list or paid term is
  involved gets a request instead of an answer, and a manager must act on it within the venue's days or it lapses.
  `staffMay("desk").classMove` is true whatever the venue's switch says: the classes screen reads the setting for the venue it shows,
  and the route enforces it.
