# ADR 0036: Who supervises a session: rosters, qualifications and supervision rules, asked in the one booking path

- **Status:** current, decided 2026-11-05. **The sentence that until a person's certificate is recorded their shifts count for nothing
  is superseded by [ADR 0046](0046-strength-of-a-requirement-advisory-windows-and-qualification-levels.md)**: it holds for a qualification
  the venue requires or declares a legal requirement, not for a recommended one, which counts and is flagged. Decided (the owner asked for staffing a session, a range officer, a
  lifeguard or an instructor, among eight roadmap items). Built in migration 0277. What staff and customers
  see is [who supervises a session](../../features/venue-operations.md#who-supervises-a-session).
- **Context:** the catalogue marks pools, open water, ranges and climbing walls as supervised
  (`activities.supervised`): never left to run in unstaffed hours, whatever a venue asks for. That says the
  venue is staffed. It does not say that somebody with the right qualification is on, nor who. A range that
  sells a lane at 7 PM when nobody holds the range-officer certificate that evening is open, staffed hours
  and all. A venue needs to say which activity needs whom, to roster the people, and to be unable to sell the
  hours nobody covers; and when a person is away after bookings exist, to find what that left, without
  anything being cancelled behind its customers' backs.
- **Decision:**
  - **Roles are data** (`roster_roles`), never code: a venue's own, and three starters made for every venue
    on first use (*range officer*, *lifeguard*, *instructor*). A role may name the qualification a holder
    must have; the starters come with a suggested one (*Range officer certificate*, and so on) that the venue
    may change or clear. Secure by default: until a person's certificate is recorded, their shifts in that role
    count for nothing and the roster says so. A role rules still ask for cannot be turned off.
  - **Qualifications are the venue's record of a person, not a sign-off.** A [sign-off](../../features/activities.md#sign-offs)
    (`src/lib/sign-offs.ts`) is a customer's clearance to book, keyed on a phone number, a participant or an
    account; a member of staff is neither. `roster_qualifications` holds what the venue saw (the name, a
    reference, never a document, and the last day it holds), for a staff account or a coach
    (`person_kind`). A qualification's name is compared without case. Two with different last days: the longest
    holds.
  - **People rostered** are the venue's own staff accounts (`admins` with that `venue_id`; owners and business
    managers have no shifts) and its coaches who still take lessons. A person who is no longer on that list
    gives no cover and is flagged.
  - **Shifts** are a weekly pattern (`roster_shifts`: person, role, weekday, from, to) with dated exceptions
    (`roster_exceptions`: an extra shift, or leave). A shift is the venue's wall clock on a calendar day; its end
    may run past midnight (to at most a day after its start: 22:00 to 06:00 is 1320 to 1800) and means the
    instants `instantOf` gives for that day, so it follows the zone's own offset on the day (the maths takes any
    zone; a night across a change of clocks is as long as the night was). Leave takes a person off from the time
    it names, the whole day (midnight to midnight) when it names none; it also cuts a shift that began the evening
    before. A coach's own time off (coaching) takes them off too. A qualification's last day is the end of that
    local day: a shift that outlasts it counts only until then, never silently valid.
  - **The rule** (`supervision_rules`): a venue marks an activity, a resource, or a resource's activity as
    needing *n* people (default 1, up to 20) in a role. A session of an activity on a resource is subject to every
    rule that matches (a resource's, the activity's, both): one entry per role, the largest *n* any of them asks.
    A session is bookable only where, at every moment of it, at least *n* qualified people are on shift in
    that role, a person counting once however they are rostered. Several roles are all required.
  - **It composes with staffed hours and unmanned use by being stricter, never looser.** Staffed hours (the
    venue's `staffed_from`/`staffed_to`) say *when the venue is staffed*; a resource's `unmanned` says whether it
    may be used outside them; the roster says *by whom and with what qualification*. The roster adds a condition
    to a booking and takes none away: a rostered person does not make hours bookable that opening hours, a
    closure, a members-only session, a sign-off or the court's booking rules refuse, and being staffed does not
    make hours bookable that no qualified person is rostered for. An activity the catalogue marks supervised
    is still refused unmanned; the roster does not lift that.
  - **One booking path asks it.** `supervisionRefusal` (`src/lib/rosters.ts`) is asked, in the session's own
    transaction and before its claims, by every way a session is made or moved: a booking through
    `createBookingSeries` (the customer online, the counter, the venue's API key, a waiting-list claim, an
    approval's booking, a lesson, a group of courts, any-court booking, each week of a series), a class session
    (`createClassSessions`, each week of a term), a booking moved to another time or court (`rescheduleBooking`,
    its preview and a game's held proposal included, so a series move previews which weeks are refused and why;
    `moveBooking`, and the lane given on arrival) and games added to a booking (`addGames`: the longer session is
    asked). An open game rides on its booking. An enrolment is its class's. A change of coach alone moves nothing
    the roster is asked about. The refusal is the code `SV1_NO_SUPERVISOR` naming the role and the number (`SV1_NO_SUPERVISOR_ON`,
    with the date, for a term of classes); a series without "skip unavailable weeks" is refused naming the first week and why; with it, each refused week is skipped and named (`no <role> rostered`); a series
    every week of which is refused says so. The grid and every list of starts agree before anybody asks:
    `CourtDay.unsupervised` (`courtDays`) is the gaps of the day, no start overlaps one, a slot in one is
    `unsupervised` and not available (and not offered the waiting list), search, the any-court chooser, move
    targets, reschedule options, "book again", and an approval's slot hold all read it. **A manager's override of
    a court's booking rules goes past none of it**: to sell an hour nobody is rostered for, roster somebody (an
    extra shift). A booking made on a shift that was real stays valid; nothing here is retroactive except what
    the worklist lists.
  - **No race lets a booking in under a shift taken away at the same moment.** A check takes the venue's
    roster lock (an advisory transaction lock, key 4, shared) before it reads, only where a rule applies, so
    ordinary venues pay nothing; a change to the roster takes it whole. Locks are always taken in the
    order roster, then spaces and courts, then coaches. Transactions are serializable as everywhere
    (`src/lib/db.ts`), so the two orders are the only two: a booking made first is in the diary when the change
    lists what it uncovered; a change made first is seen and refuses the booking. What is uncovered is
    worked out from the roster as it is each time it is read, never stored, so a session that slipped through by any
    other road (a rule added later, a qualification taken back, a person deleted) is listed too.
  - **Absence after bookings exist never cancels.** Removing a shift, adding leave, taking a qualification
    back, changing a role or adding a rule returns `affected`, the sessions it newly left without cover, and
    `uncoveredSessions` lists every session to come (120 days) that has too few qualified people on shift and
    no decision of a manager: on the Courts tab, on the needs-attention panel, and for the desk to read. A manager can
    **cover** a session (name another person: on the venue's list, holding the role's qualification through the
    whole session, not teaching a lesson then; they need not be rostered, they are being called in), **let it
    stand** with a reason (required, kept, in the log), or move or cancel it by the existing paths; either decision
    can be taken back (kept as history, no longer counted). Nobody is emailed about a roster change: the worklist
    is for staff.
  - **Who supervises is a record.** A session made or moved names the people on shift who cover it: the fewest
    that do (staff before coaches, then those covering most of it, then by id: the same answer for the same
    roster), one row per piece (`session_supervisors`, `how = 'rostered'`), with the role's name as it was.
    The record is kept whatever the roster does afterwards; a session re-checked or moved deactivates its rows
    (history, never deleted) and writes new ones. Staff see it on the booking, the day's list and the schedule's
    entries. A customer is shown the role (`supervisedBy`: key and name), never the person or their contact
    details.
  - **A coach is one person with one schedule.** A coach teaching a lesson (`coach_claims`) is not available to
    supervise another session at that time (a lesson's own coach is available to it: one person doing one session
    of theirs, so a lesson with a coach who is rostered as instructor there is supervised by them). A
    coach named to supervise another session at that time cannot be taken for a lesson then
    (`attachCoach` and a lesson's move refuse with `COACH_TAKEN`; a cover is refused the same way). Supervising
    does not stop a second session at the same time (a lifeguard watches several lanes): only teaching
    excludes. `lockCoach` is taken for it, after the courts. The coach's lesson hours (`coach_hours`) are for lessons,
    not for the roster. **Composition with a class's instructor as one of the venue's coaches** (a separate
    change): a class does not claim a coach's time in `coach_claims` today (a lesson does); when it does,
    `supply` already treats those claims as the coach being busy for any session but the class's own booking id,
    and `coachSupervising` must also look at the class's claims, which is the one place it is joined.
  - **Everything is in the log.** `roster.role`, `roster.qualification`, `roster.shift_added`,
    `roster.shift_removed`, `roster.exception_added`, `roster.exception_removed`, `roster.rule_set`,
    `roster.rule_removed`, `roster.cover`, `roster.override`, `roster.decision_undone` and `roster.calendar_link`,
    each with the person who made it. The roster's writes are a manager's (`MANAGER_ONLY`); the desk
    reads the roster and the worklist, and any member of staff makes the link to their own shifts.
  - **A person's own shifts on a calendar**, on their own link only: a member of staff makes it
    (`/api/roster-calendar/<token>.ics`, only its hash kept, shown once, a year), a coach's own shifts are on
    their own coach calendar. Nobody's else's shifts and no customer's name or number are in it.
- **Not decided here, and not built:** blocks and holds that are not bookings (a tournament's court time, an
  outage, a maintenance block) are not sessions and are not asked; a venue that runs a tournament on a
  supervised range rosters for it by the rules of the activity, which its bookings do ask. A person
  supervising is not a capacity: two sessions at once on one officer is allowed (n is how many are on, not
  how many sessions each may watch); a venue that wants one officer per lane asks for as many officers as
  lanes. The weekly pattern has no start or end date: a change applies from now, the record on past and
  future sessions stays as made, and the worklist shows what it left. Role names are English in a customer's refusal
  where the venue named the role itself (the starters are translated). No messages to customers or staff about the
  roster.
- **Consequences:** a venue that never marks an activity as needing somebody is unchanged, down to the queries
  (one rules lookup per day shown). A venue that does, finds its range's lanes bookable exactly where a
  qualified person is on, and finds out the minute a shift goes what that left. The roster is configuration the
  manager keeps true: an expired certificate or a left-off shift makes hours unbookable, loudly, which is the
  point.
