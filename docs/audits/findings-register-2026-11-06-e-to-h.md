# Findings register, 6 November 2026: E to H

The second half of the [findings register](findings-register-2026-11-06.md) of the
business-process audit of MySenam at commit
`2aabdd406626c9f1bdbd32e65addf599d0751c6f`: auditors E to H (classes, coaching,
venue operations and safety; competitions, matchmaking and messaging;
communications, reports, privacy and the scheduler; adversarial sequences). The
summary, the severity and status definitions, the totals, the list of fix records
and the way a block is laid out are in the
[first half](findings-register-2026-11-06.md#summary), which also holds A to D.
The order of what is still open is in the
[remediation roadmap](remediation-roadmap-2026-11-06.md).

Like the first half this is a dated record: the finding text describes the baseline
commit and only each block's **Status** line says what has changed since.

## E: classes, coaching, venue operations and safety

Auditor E. Classes, coaching, check-in, door access, hire, waivers, enquiries and
safety. Merged elsewhere: E5 is in the block of B7, E8 in B5, E9 in B1, E10 in
B9, E13 in C10.

### E1 · P1 · FIXED

- **Domain and scenario.** A class called off while customers are still enrolling, or while someone claims a waiting-list offer (a closure calls this once per class in a loop).
- **Observed and expected.** `cancelClassSession` read the enrolment list outside its transaction and without the class row lock, then looped over the stale list, while `enrolPeopleOnce` did lock the class row; on Postgres at least one confirmed enrolment survived in a cancelled class in 12 of 12 rounds (and the waiting-list claim race in 1 of 12): not refunded, not told, in no roster the venue acted on, in no worklist. Expected: calling off cancels, refunds and tells every enrolment that exists when the class becomes cancelled; a later enrolment is refused `CLASS_CANCELLED`.
- **Matters to.** Customer: paid, holds a place in a class that will not run, no refund and no message; venue: its "everyone refunded and told" claim is false for that person.
- **Evidence.** `src/lib/store.ts cancelClassSession` (about line 6864): `const enrolments = await db.prepare("SELECT id FROM bookings WHERE class_id = ? AND status = 'confirmed'").all(classId)` then `db.transaction(...)`.
- **Classification.** Verified defect (Postgres only; PGlite serialises it away).
- **Reproduction.** `audit9-E-1.test.ts` E4 (Postgres: `expected 12 to be +0`, `expected 1 to be +0`; scratch). Regression: `tests/closure-races.test.ts` (Postgres).
- **Root cause.** The roster read sat outside the lock and the transaction.
- **Recommended resolution.** Lock the class row first, re-check status, select the enrolments inside the transaction.
- **Status.** FIXED. `tests/closure-races.test.ts`; [ADR 0053](../architecture/decisions/0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md) decision 3: `cancelClassSession` locks the class row and reads its roster inside the transaction; an enrolment or claim at the same moment either lands first (and is cancelled, refunded and told) or is refused `CLASS_CANCELLED`. No migration beyond 0295's.

### E2 · P1 · FIXED

- **Domain and scenario.** An unstaffed venue: a manager blocks a number after it has booked, paid and been inducted.
- **Observed and expected.** `accessCodeFor` still returned `{ ok: true, accessCode: '4821' }` for that number's booking; blocking only stopped new bookings and withdrew waiting-list offers; QR self check-in and class or lesson enrolments of that number were untouched and no list of the number's upcoming bookings was shown. Expected: a refused number gets no door code, and the manager is shown (or the system cancels) the bookings that remain.
- **Matters to.** Safety: at an unattended door the code is the access control; the venue's only tool against a dangerous member left a paid booking that still opened the door, and staff believed the person excluded.
- **Evidence.** `src/lib/store.ts:5326-5480 accessCodeFor` (never `isBlocked`), `blockPhone` (`src/lib/limits.ts:377`); `isBlocked` read only in `policyCheck`, waiting-list, games and matchmaking; [ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md) says nothing overrides a blocked number.
- **Classification.** Verified defect (a path that admits a refused number).
- **Reproduction.** `audit9-E-5.test.ts` E11 (scratch). Regression: `tests/safety-and-access.test.ts`.
- **Root cause.** The blocked-number rule existed only at booking creation.
- **Recommended resolution.** Check `isBlocked` in `accessCodeFor` and `checkInBooking`; list the number's upcoming bookings for the manager (refuse and list, or auto-cancel) (DEC-40).
- **Status.** FIXED. `tests/safety-and-access.test.ts`; [ADR 0058](../architecture/decisions/0058-safety-and-access-after-a-booking-is-made.md) decision 1, migration 0303: `accessCodeFor` and the QR self check-in refuse a refused number's booking (`FX9_DOOR_BLOCKED`, "see the venue"); `blockPhone` lists its confirmed, not-yet-ended bookings at that venue (classes and lessons included) in *Needs attention*, once each, and returns the count to the manager; none is cancelled by the system; the manager cancels with refund or leaves it with a note (a manager's decision, not the desk's). Left open: whether the desk may check in a refused number (today yes: a person looking at them).

### E3 · P2 · FIXED

- **Domain and scenario.** Safety prerequisites when an unstaffed slot is sold.
- **Observed and expected.** `createBooking` succeeded for an un-inducted number on an unstaffed slot; the door later answered `no-induction` or `approval-needed`; nothing at booking, in availability or on the booking page warned, and there was no refund path. Expected: refuse or warn before payment, as sign-offs are already refused at booking (`SIGN_OFF_NEEDED`).
- **Matters to.** Customer: pays for an hour they cannot use and finds out at 11 pm with the counter shut; venue: disputes and chargebacks.
- **Evidence.** `placesInducted` called only in `accessCodeFor` (`src/lib/store.ts:5368`); nothing in `createBookingSeries`.
- **Classification.** Verified defect (missing workflow).
- **Reproduction.** `audit9-E-3.test.ts` E7 (`booked: "OK"`; scratch). Regression: `tests/safety-and-access.test.ts`.
- **Root cause.** Induction treated as a door-time check only.
- **Recommended resolution.** Run the same checks at booking for a wholly or partly unstaffed time; refuse online, allow at the counter (DEC-41).
- **Status.** FIXED for sign-off and certification; induction told, not refused. ADR 0058 decision 2: where the door code is the way in, the customer is asked at booking for the sign-off or certification the activity needs (the same `signOffNeeded` the door uses), refused with the existing `SIGN_OFF_NEEDED` / `CERTIFICATION_NEEDED` words before payment; a manager may go past on record. An **induction** is taken in person so it can follow the booking: the booking is allowed and the customer told on the confirmation page and booking page that the time is unstaffed and a run-through comes first (`inductionNeeded`). Left open: the induction note is not in the confirmation email or WhatsApp; moving a booking into an unstaffed slot does not re-ask the sign-off.

### E4 · P2 · PARTLY

- **Domain and scenario.** A sign-off, certification or induction taken back after bookings were made.
- **Observed and expected.** Only an approval-written sign-off flagged bookings (`approval_booking_flags`); a plain sign-off's delete did nothing to future bookings, expiry passed silently, and staffed venues' day list and desk check-in never asked for sign-offs. At unstaffed hours the door fails closed but the customer was not told in advance. Expected: revocation lists upcoming bookings on that activity for the person and tells the customer; an expiring certification warns before the booking date.
- **Matters to.** Safety: a person the venue just judged unsafe stays booked and is let in by a desk with no signal; customer: surprised at the door.
- **Evidence.** `src/app/api/admin/sign-offs/route.ts` DELETE then `signOffRevoked` (`src/lib/approvals.ts:1891` returns early when no approval wrote it); `grep -n signOff BookingsTab.tsx` finds nothing. ([ADR 0036](../architecture/decisions/0036-who-supervises-a-session.md)'s "nothing cancelled, nobody emailed" for rosters is deliberate and not this.)
- **Classification.** Verified defect (the approval path flags, the plain path does not).
- **Reproduction.** `audit9-E-4.test.ts` E9 (`flaggedBookings`; scratch). Regression: `tests/safety-and-access.test.ts`.
- **Root cause.** Flagging was built inside the approval workflow only.
- **Recommended resolution.** Flag on any revocation; nightly flag certifications that expire before a booking date (DEC-42).
- **Status.** PARTLY. ADR 0058 decision 3, migration 0303: a sign-off or certification taken back and an induction withdrawn flag the person's upcoming confirmed bookings it affects (what, who, when, why), show them in *Needs attention*, and email the customer once (`booking_safety_notice`; a booking with no email shows "not told: tell them"); nothing is cancelled; the door code is not issued for a flagged booking until staff decide (`FX9_DOOR_FLAGGED`), a staffed venue's flagged booking is not blocked; recording the sign-off again settles the flag. **Open:** a certification that *expires* is checked when the booking is made but not warned about afterwards; a waiver is never taken back, so none is flagged.

### E6 · P2 · FIXED

- **Domain and scenario.** Two ways a class place is freed that never reach the class's waiting list.
- **Observed and expected.** `releaseExpiredHolds` offered every released booking as court time (`offerSlotPlace(court, date)`), including class enrolments, and `cancelSeries` did the same for class term enrolments, so the next person in the class queue stayed `waiting` while the place sat empty; `customerCancel` and `adminCancelBookingOnce` correctly use `offerClassPlace`. Expected: one helper for every cancellation path.
- **Matters to.** Venue: empty places in a full class; customers not served.
- **Evidence.** `src/lib/holds.ts:118-150`; `src/lib/store.ts cancelSeries` (`:2805-2806`).
- **Classification.** Verified defect.
- **Reproduction.** `audit9-E-1.test.ts` E2, E2b (scratch). Regression: `tests/class-waitlist-closing.test.ts`, `tests/waitlist-offer-races.test.ts`.
- **Root cause.** Each path hand-picked slot or class offer; two missed the class case.
- **Recommended resolution.** One `offerFreed(booking)` used by all.
- **Status.** FIXED. [ADR 0060](../architecture/decisions/0060-waiting-list-offers-windows-starts-and-closing.md) decision 4: `offerFreedPlace({classId, courtId, date})` offers a freed class place to the class's list and court time to the court's; `cancelSeries`, `releaseExpiredHolds`, a place withdrawn from a booking and a taken-up offer use it.

### E7 · P2 · FIXED

- **Domain and scenario.** A customer's own QR check-in treated as verified attendance.
- **Observed and expected.** The check-in token is a link on the customer's phone with no proof of presence, yet one tap (1) cleared a no-show the desk had recorded (`checkInBooking` set `no_show = 0`, even unattended), (2) froze a class move (`CLSA_MOVE_ATTENDANCE` counted any `check_ins` row and check-in opens 60 minutes early), and (3) because `no_show` is the only "did not come" signal, made a lesson count as "went ahead" for coach pay and re-qualified it for reviews and loyalty. Expected: a self check-in must not override a staff mark; staff attendance should be what freezes a move.
- **Matters to.** Strikes and coach pay can be gamed or lost; a venue cannot relocate a flooded class when it most needs to.
- **Evidence.** `src/lib/store.ts:5036-5057 checkInBooking`; `src/lib/class-moves.ts:221-224, 411-412`; `src/lib/coach-schedule.ts:398-403`. The documented check-in is "arrivals do not depend on a staff member pressing a button" (headcount).
- **Classification.** Verified defect (1, 2); operational risk (3).
- **Reproduction.** `audit9-E-2.test.ts` E5 (scratch). Regression: `tests/safety-and-access.test.ts`.
- **Root cause.** One `check_ins` row serves headcount, strikes and "attendance taken".
- **Recommended resolution.** A source on `check_ins` (desk, self, door); a self check-in must not clear `no_show` or freeze a move (DEC-44).
- **Status.** FIXED. ADR 0058 decision 4, migration 0303: `check_ins.source` is `desk` (default; every earlier row), `self` or `door`; a self or door row is verified attendance only once staff confirm it (`confirmed_at`, by whom: one tap on the Bookings tab's Attendance chip, the roster, kit handed over, or the register); until then it counts for the headcount and is visible to staff as the customer's own, but does not clear a no-show, does not freeze a class move, and does not count as having played for a review of an unpaid priced booking.

### E11 · P2 · OPEN (decision DEC-46 on packs)

- **Domain and scenario.** Coach absence: time off, an hours change or retirement while lessons are booked.
- **Observed and expected.** `addTimeOff` returns a `clashes` count to the coach's page only; `setCoachHours` silently deletes and re-inserts hours and accepts an empty list; `retireCoach` says "lessons already booked stand". Classes have a worklist (`classCoachConflicts`, *Needs attention*); lessons have none. Customers are told nothing; a manager must change each lesson one by one (`applyCoachChange` is per booking); a lesson paid with a pack, a deposit or others' shares cannot be given to another coach at all (`LESSON_COACH_PASS`, `LESSON_COACH_PART_PAID`), and a pack works only with its own coach. Coach payouts keep counting an unattended lesson as "went ahead".
- **Matters to.** Customer: shows up and nobody teaches; prepaid lessons are the venue's liability, unresolved until staff look.
- **Evidence.** `src/lib/coaching.ts addTimeOff/setCoachHours/retireCoach`; `src/app/api/coach/[token]/hours/route.ts`; `classCoachConflicts` only in class screens and `attention`.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only.
- **Root cause.** The class worklist was built after round 12; lessons never got one.
- **Recommended resolution.** `lessonCoachConflicts` in *Needs attention*; clashes returned from `setCoachHours`; a bulk reassign or cancel for a coach and date range; owner decision whether a pack may be spent on any coach of the sport (DEC-46).
- **Status.** OPEN. Not changed. A roadmap row.

### E12 = H9 · P2 (E12), P3 (H9) · FIXED

- **Domain and scenario.** A class is cancelled or its instructor changed.
- **Observed and expected.** `cancelClassAndTell` told enrolled customers only: the coach whose `coach_claims` was released was never emailed, `changeClass` told neither coach, and waiting-list entries stayed `waiting` (shown in "My waiting lists" and the staff list) for 90 days with nobody told the class was off. Expected: coach told; list entries closed and told.
- **Matters to.** Instructor turns up to a cancelled class; people think they are still queueing.
- **Evidence.** `src/lib/notify.ts cancelClassAndTell` (`:1085-1105`); `src/lib/class-changes.ts`; `src/lib/store.ts:6892-6903 cancelClassSession`, `listWaitlist` (`:9461`).
- **Classification.** Verified defect.
- **Reproduction.** `audit9-E-3.test.ts` E8, `audit9-H-5.test.ts` (scratch). Regression: `tests/class-waitlist-closing.test.ts`.
- **Root cause.** The class cancel path predates coach instructors and was never extended.
- **Recommended resolution.** Mark entries cancelled and email them; email the coach; same on a change of instructor.
- **Status.** FIXED. ADR 0060 decision 5: `cancelClassSession` ends the class's waiting and offered entries (`cancelled`, link dead, unsent offer given up) in the same transaction after the class lock; `tellClassCancelled` tells each once and the class's coach once (`coach_lesson`, email, keyed by entry and class); `changeClass` tells the coach who stops and the coach who starts. Lesson and open-game waiting lists were looked at and not changed.

### E14 · P3 · FIXED

- **Domain and scenario.** A rain-out or closure over a booking with kit still out.
- **Observed and expected.** `venueCancel` refuses ("kit still out"); `rainOut`, the closure route and `createOutage` did `if (!done.ok) continue;`, so the booking stayed confirmed on a blocked or closed day and the response did not name it. Expected: unresolved bookings are named for the desk.
- **Matters to.** Venue and customer: a confirmed booking on a closed day, unnoticed.
- **Evidence.** `src/lib/rain-outs.ts`, `src/app/api/admin/venues/[id]/closures/route.ts`, `src/lib/outages.ts`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-E-4.test.ts` E10 (scratch). Regression: `tests/venue-closures-first.test.ts`, `tests/rain-out-closes-first.test.ts`.
- **Root cause.** A silent `continue`.
- **Recommended resolution.** Name them. Size S.
- **Status.** FIXED. ADR 0053 decision 1: a closed day and a rain-out finish what they can and **name** the booking (`left`) for the desk, with the day closed and the hours blocked around it; a court cannot go out over a standing booking, so taking it out is refused naming it, with nothing changed.

### E15 · P3 · OPEN decision (DEC-43)

- **Domain and scenario.** Term enrolment.
- **Observed and expected.** `enrolInTerm` discounts each session it enrols (up to 50%); a customer can join the term, cancel all but one session free before the cutoff and keep that one at the term price (remaining total 15 against a class price of 30); sessions that are full are left out by `classTerm` and never appear in `skipped`, though the docs say they are named.
- **Matters to.** Venue: discount kept for a lone session; customer: not told which sessions were not joined.
- **Evidence.** `enrolInTerm`, `classTerm`.
- **Classification.** Questionable policy plus a documentation mismatch.
- **Reproduction.** `audit9-E-1.test.ts` E3 (`expected 15 to be 30`; scratch).
- **Root cause.** The discount is per session enrolled, not per term kept.
- **Recommended resolution.** Re-price when fewer than N sessions remain, or document it; name the sessions not joined whichever is chosen (DEC-43). Size S.
- **Status.** OPEN decision, DEC-43. Not changed.

### E16 · P3 · OPEN

- **Domain and scenario.** Coach alerts and payouts.
- **Observed and expected.** `notifyCoaches` tells only bookings with `created_at` in the last two days, so a coach whose email is added later, or reassigned lessons whose previous coach never heard, never hear of earlier lessons; `coachPayouts` counts every confirmed lesson in the period as "went ahead" unless marked no-show, including lessons in the future and ones the instructor's register marks absent.
- **Matters to.** Coach and venue: missed lessons; payouts that overstate.
- **Evidence.** `src/lib/notify.ts notifyCoaches`; `src/lib/coach-schedule.ts coachPayouts`.
- **Classification.** Operational risk.
- **Reproduction.** By reading.
- **Root cause.** A two-day window; no "held" test.
- **Recommended resolution.** Tell all untold future lessons when an email is set; restrict "went ahead" to dates before today. Size S.
- **Status.** OPEN. Not changed.

### E17 · P3 · OPEN

- **Domain and scenario.** Hire enquiries.
- **Observed and expected.** An enquiry appears on the Bookings tab and is emailed only if the venue set an alert email; a venue with only a WhatsApp alert, or none, gets nothing outside the tab; nothing in *Needs attention*, no age warning, no acknowledgement to the enquirer.
- **Matters to.** Venue: lost hire business.
- **Evidence.** The hire enquiry route and `BookingsTab`.
- **Classification.** Missing workflow.
- **Reproduction.** By reading.
- **Root cause.** Alert-by-email only.
- **Recommended resolution.** Add open enquiries to *Needs attention* with an age; acknowledge to the enquirer. Size S.
- **Status.** OPEN. Not changed.

### E18 · P3 · OPEN

- **Domain and scenario.** Cancelling after the door code was revealed or a self check-in.
- **Observed and expected.** `customerCancel` ignores check-in and reveal: at the default 2-hour cutoff nothing can happen (check-in opens 60 minutes before), but a venue with a cutoff of 0 to 1 hours or late-cancel terms lets a customer reveal the code, cancel for a refund and still use a court re-offered to someone else.
- **Matters to.** Venue: config-dependent revenue loss.
- **Evidence.** `customerCancel`.
- **Classification.** Operational risk.
- **Reproduction.** By reading.
- **Root cause.** No rule linking arrival to cancellation.
- **Recommended resolution.** Refuse a customer cancel once the code was revealed or the booking checked in (DEC-45). Size S.
- **Status.** OPEN, recorded. [ADR 0058](../architecture/decisions/0058-safety-and-access-after-a-booking-is-made.md) decision 5 left it as a known limitation: refusing the cancel would also trap somebody who revealed the code and cannot come, so a rule is the owner's.

### E19 · P3 · OPEN

- **Domain and scenario.** Instructor pay for classes.
- **Observed and expected.** Coach payouts are for lessons only; a venue paying instructors per class has no report, and a class register is an input to nothing. Recorded so the lead knows instructor payment errors cannot occur because nothing is computed.
- **Matters to.** Venues paying instructors per class.
- **Evidence.** `docs/features/programmes.md` "Out of scope".
- **Classification.** Missing workflow (documented, deliberate).
- **Reproduction.** Not applicable.
- **Root cause.** Not built.
- **Recommended resolution.** A roadmap row (it already exists as *Coach pay for classes*, PROPOSED).
- **Status.** OPEN. Not built; deliberate and documented.

## F: competitions, matchmaking and messaging

Auditor F. Tournaments, leagues, ladders, ratings, open games, player messaging
and its moderation. F4 is in the block of C11.

### F1 · P2 · FIXED

- **Domain and scenario.** Tournaments: two managers (or one double submit) press "Make the draw" together, or a desk withdrawal commits while the draw is computed.
- **Observed and expected.** `makeDraw` read the entries, computed and scheduled, then wrote the matches and set `status = 'drawn'` with no `FOR UPDATE` and no `WHERE status IN ('open','closed')`, while every other mutation takes the lock. On Postgres two concurrent draws of a 4-entry knockout left 6 matches (two brackets) and both returned ok; a withdrawal between the draw's read and write left the withdrawn entrant in a scheduled match (fee marked owed, the promoted waiter not in the draw). Expected: one draw; entries as of the lock.
- **Matters to.** Venue and entrants: a corrupted bracket on the day cannot be repaired by the app (matches are not deletable); a refunded player appears in the bracket.
- **Evidence.** `src/lib/tournaments.ts:2118 makeDraw` (no lock), `:2356` (unconditional UPDATE); route `src/app/api/admin/tournaments/[id]/route.ts:158`; Swiss and counted-Swiss draws are called from the same unlocked function.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-F-1.test.ts` (Postgres; scratch). Regression: `tests/tournament-draw-lock.test.ts`.
- **Root cause.** The draw predates the locking convention.
- **Recommended resolution.** `SELECT ... FOR UPDATE` at the start of a transaction wrapping read and write; conditional final UPDATE.
- **Status.** FIXED. `tests/tournament-draw-lock.test.ts`; [ADR 0059](../architecture/decisions/0059-competition-notices-fees-owed-fixtures-lost-and-message-review.md) decision 1: `makeDraw` runs in one transaction with `SELECT ... FOR UPDATE` on the tournament first (the order every other mutation takes), the entries read as of the lock and the final status change conditional; of two draws one is made and the other refused ("made already"); Swiss and counted-Swiss draws run inside it. No new engine.

### F2 · P1 · FIXED

- **Domain and scenario.** Adult player messaging: three people report the same adult within 30 days in games, ladders or tournaments of one venue; the published rule suspends them everywhere "pending the platform owner's review".
- **Observed and expected.** The suspension was written platform-wide (`venue_id NULL`) but its evidence was venue-scoped: the owner saw the suspension but none of the reports behind it; a venue manager could mark all three "no action" but could not lift a platform-wide suspension, and nothing re-evaluated it; no notice reached the owner when one was created, no review date, no needs-attention line; the suspended adult had no appeal (`askForReview` was youth only); three accounts could silence somebody everywhere, indefinitely. Expected: whoever reviews can see what they review; a suspension whose reports were all dismissed does not persist; the person can ask for a review; an unreviewed suspension surfaces with a date.
- **Matters to.** A customer sanctioned by a rule that nobody can examine and the customer cannot contest; venues blamed for what they cannot undo.
- **Evidence.** `src/lib/message-moderation.ts:45-51 reportScope`, `:302 liftSuspension`; `src/lib/messages.ts:752 autoSuspend`, `:730`; `src/lib/youth-restrictions.ts:42 askForReview`; `docs/features/player-messages.md` lines 160-164, 187.
- **Classification.** Verified defect (the promised review cannot be performed) plus missing workflow (appeal).
- **Reproduction.** `audit9-F-2.test.ts` (PGlite; scratch). Regression: `tests/message-suspension-review.test.ts`.
- **Root cause.** Automatic suspension is platform-wide but its evidence venue-scoped; the youth module got escalation, review dates and appeals (ADR 0049, 0052) and the ordinary one did not.
- **Recommended resolution.** Owner reads linked reports; auto-lift when fewer than three counted reports remain; owner notice and review date; appeal (DEC-47).
- **Status.** FIXED. `tests/message-suspension-review.test.ts`; ADR 0059 decision 9, migration 0305: an automatic suspension is told to the owners and the managers of the venue whose report completed the count, with a 14-day review date (operational, not a legal period; nothing lifts by itself); the owner reads the reports behind it; a venue's manager lifts one that rests on that venue's reports alone; it is lifted when fewer than the rule's number of different people's reports remain after reports are found to need no action; the suspended person can ask for a review from the "messages are paused" line (the youth route of ADR 0052), answered *lifted* or *stands* in neutral words. **No legal right to a review or to notification is promised; the legal questions stay pending legal review.** Still open: three accounts can suspend a person platform-wide (accepted); the reporter is not told the outcome (F8).

### F3 · P2 · FIXED

- **Domain and scenario.** A court outage or venue closure after a tournament or team league is drawn.
- **Observed and expected.** `createOutage` listed and cancelled bookings and classes only, then released every block on the court in the span including the tournament's and team league's fixture blocks; drawn matches kept `court_id` and date; nobody was told and the manager was not warned; the closures route counted bookings and classes only; entrants still saw the match on a closed day; there was no "postpone the tournament day" (dates are fixed after creation). The ladder side told players (`tellLostHolds`, ADR 0048). Expected: the same treatment as a booking: show, tell, and ideally postpone a day.
- **Matters to.** Entrants travel to a closed venue; the venue meets angry customers with no record it told anyone.
- **Evidence.** `src/lib/outages.ts:121-130 affectedBy`, `:260-267`; `src/app/api/admin/venues/[id]/closures/route.ts:53-70`; `src/lib/ladders.ts tellLostHolds` for contrast.
- **Classification.** Verified defect (notification gap) plus missing workflow (postpone).
- **Reproduction.** `audit9-F-3.test.ts` (scratch; team-league blocks by reading). Regression: `tests/competition-fixes.test.ts`, `tests/team-league-fixtures-lost.test.ts`.
- **Root cause.** Outage and closure code predate competition-owned blocks.
- **Recommended resolution.** Add fixtures to `affectedBy` and the closure pre-check; email entrants and captains; later a "move the day" tool (DEC-49).
- **Status.** FIXED. ADR 0059 decision 5: taking a court out and closing a day **answer** the fixtures still drawn there (a warning, not a refusal); each side and both captains are told once; one action, `postpone_day`, moves a tournament's day all-or-nothing by the checks of `placeMatch`, and a team league's night fixture by fixture by `moveFixture`'s (`left` says what could not be placed); the dashboard list is derived from outages and closures as they stand. Open: postponing a team-league night is not atomic.

### F5 · P2 · FIXED

- **Domain and scenario.** Entrants removed, disqualified or forfeited by staff.
- **Observed and expected.** `takeOutOnce` emailed only the waiting-list entrant who was promoted; the person taken out as "disqualified" (reason in `out_note`), "retired" or "withdrawn" by the desk, and the person given a walkover loss for "did not come when called", received no email and no screen said why; guardians of minors got nothing. Expected: an email stating what was decided, by whom, the reason, what it means for the fee and who to contact.
- **Matters to.** The entrant: no notice and no way to answer, so no chance to dispute with evidence; for a child, the guardian learns at the venue.
- **Evidence.** `src/lib/tournaments.ts:1589-1700` (only `tellEntry(... mail.tour.promoted ...)`); `src/lib/tournament-day.ts:726-755`.
- **Classification.** Verified defect (notification gap).
- **Reproduction.** `audit9-F-9.test.ts` (scratch). Regression: `tests/competition-fixes.test.ts`.
- **Root cause.** Notifications were written for opponents and the waiting list.
- **Recommended resolution.** A message for staff-initiated outs, including `out_note` for disqualification, and for walkovers for absence.
- **Status.** FIXED. ADR 0059 decision 3: whoever staff take out of an event is told once, with the reason staff gave, what it means for the fee as the tournament's rules have it, and who to contact; a player's own withdrawal is not told back to them; a no-show walkover tells the side that did not come (one message if they are also taken out); keyed by entry so a repeat tells nobody twice; the text states what the venue decided and says nothing of rights to a hearing. Email only (the unverified Email row).

### F6 · P2 · OPEN decision (DEC-50)

- **Domain and scenario.** Open games: a host's no-show mark.
- **Observed and expected.** After the start the host may mark any accepted player `no_show`; the player is not told, there is no way to clear it, and nothing records who marked it; three marks in 90 days refuse the player every open game at every venue; a host's misclick, or a player whose game the venue moved, gets a strike only the database can remove; staff cannot see or clear it. Expected: the player is told, the host or staff can clear, the refusal names how to ask.
- **Matters to.** A punishment on one person's word with no notice or appeal; a rival host can drive people off the platform.
- **Evidence.** `src/lib/games.ts decide` (no_show branch, no `tellPlayer`), `recentNoShows`, `eligibility` (`MAX_NO_SHOWS = 3`, `NO_SHOW_DAYS = 90`); documented as a feature in `docs/features/matchmaking.md`.
- **Classification.** Missing workflow; questionable policy.
- **Reproduction.** `audit9-F-6.test.ts` (test 1 decisive; scratch).
- **Root cause.** No notice or reversal designed.
- **Recommended resolution.** Email the player; host clear for 7 days, staff always; show the count in the profile (DEC-50). Size S to M.
- **Status.** OPEN decision, DEC-50. Not changed.

### F7 · P2 · FIXED

- **Domain and scenario.** A tournament nobody drew.
- **Observed and expected.** `entries_close_on` is optional; `closeDueEntries` closes only tournaments that have one; `enterLocked` and `startEntryPayment` accepted entries and fees after `starts_on` and `ends_on` passed; after the first day the draw cannot place any match, so the event can never be drawn, finished or reported, and fees sit until a manager cancels; no alert when entries close below the draw's minimum, no reminder before the start, no deadline for a promoted waiter to pay. Expected: entries stop when the event starts; the manager is told when the draw is impossible.
- **Matters to.** Customers pay for an event that cannot run; courts stay held on prime days with nobody reminded.
- **Evidence.** `src/lib/tournaments.ts:1217, 1324-1325`; `src/lib/payments.ts:2012-2017`; scheduler has no tournament lifecycle task beyond `closeDueEntries`/`announceAll`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-F-7.test.ts` (scratch). Regression: `tests/competition-fixes.test.ts`.
- **Root cause.** No implicit last day.
- **Recommended resolution.** `starts_on` as the implicit last day; alert two days before and a one-click cancel (DEC-53).
- **Status.** FIXED, narrower than recommended. ADR 0059 decision 4: a tournament with no entries-close date stops taking entries and fees after its first day and the scheduler closes it then; it is a *Needs attention* line for the venue's managers and the owner from that day until drawn or called off, listing the court time still held. Not built: refusing entries the day before the start, an email two days ahead, a one-click cancel with refunds, a payment deadline for a promoted waiter.

### F8 · P2 · PARTLY

- **Domain and scenario.** Reports of messages in ordinary (adult) contexts.
- **Observed and expected.** `reportMessage` notified staff only for youth-thread reports; for a game, tournament, ladder or team thread there was no email, no dashboard badge, no age, no ordering by reason; where a venue has no manager the reports are unseen (accepted); a manager cannot escalate an adult-thread report to the owner; the reporter is never told the outcome; no conflict guard for a report naming the venue's own staff outside youth threads. Expected: the manager is emailed (with no message text), unsafe reports rank first, open reports age onto a line, a manager can escalate, the reporter hears "reviewed".
- **Matters to.** Harassment or threats between adults at a venue are reported to nobody who will see them in time; the venue has no record it was told.
- **Evidence.** `src/lib/messages.ts:727-740`; `src/app/admin/page.tsx:300`; `src/lib/message-moderation.ts:168 reviewMessageReport`; `docs/features/player-messages.md` lines 160-196.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only. Regression: `tests/message-suspension-review.test.ts`.
- **Root cause.** Alerts built for youth only.
- **Recommended resolution.** `tellVenueStaffEach` on a new report (counts only); an age flag at 3 days; a manager "escalate"; a neutral reporter notice on review (DEC-48).
- **Status.** PARTLY. ADR 0059 decision 8: a report of a message in an ordinary conversation is told when made to the venue's managers (the owners where there is no venue): that a message was reported, how many are open, where to look, with no text, no names and no reason, once per report, never to the person reported; the needs-attention panel shows the open count and the age of the oldest. Nothing reads the reporter's chosen reason, so "unsafe" is not special-cased. **Open:** a manager still cannot escalate an adult-thread report to the owner; the reporter is not told the outcome.

### F9 · P3 · FIXED

- **Domain and scenario.** A ladder challenge ignored for the response window.
- **Observed and expected.** `ladderHousekeeping` forfeits a challenged player (default 3 days) with the challenge email and a result email afterwards: no reminder before, no WhatsApp, no player-side way to contest. Deliberate (owner's 4 November decisions). Recommended: one reminder at half the window and a "ask a manager" line.
- **Matters to.** Players: a forfeit after one email.
- **Evidence.** `ladderHousekeeping`; `docs/roadmap/known-limitations.md` "Forfeits, officials and ladders".
- **Classification.** Questionable policy.
- **Reproduction.** By reading. Regression: `tests/ladders.test.ts` (changed).
- **Root cause.** One notice by design.
- **Recommended resolution.** One reminder at half the window (DEC-52).
- **Status.** FIXED. ADR 0059 decision 7: an unanswered challenge is reminded once before it forfeits, half the response window before it ends by default (the ladder's `remind_days` overrides), claimed for the last day to answer so a repeat reminds nobody. Email only.

### F10 · P3 · PARTLY

- **Domain and scenario.** A player-reported walkover.
- **Observed and expected.** In a tournament with player-entered results either side may report a walkover; `standUnansweredReports` records it after `REPORT_STANDS_HOURS = 24` and the opponent is out of that match with progression; the opponent was emailed ("silence lets it stand") but once it stands only staff can change it; in a one-day event the loser may be eliminated while playing on another court. Recommended: a reported walkover never auto-stands.
- **Matters to.** The silent opponent.
- **Evidence.** `src/lib/match-reports.ts:123, 217-262`.
- **Classification.** Questionable policy.
- **Reproduction.** Not tested; by reading. Regression: `tests/match-reports.test.ts` (changed).
- **Root cause.** Silence counts as consent.
- **Recommended resolution.** A walkover never auto-stands; it goes to staff as disputed after 24 hours (DEC-52).
- **Status.** PARTLY. ADR 0059 decision 6: a walkover a player reports is reminded to the silent side once, 12 hours before it stands, and a result that stood by silence is flagged as such, with who reported it and when, for staff. **It still stands after 24 hours**: the audit's recommended default (a walkover never auto-stands) was not taken because the brief chose the notice (DEC-52, the owner).

### F11 · P3 · OPEN decision (DEC-51)

- **Domain and scenario.** Leaving an open game minutes before the start.
- **Observed and expected.** `leaveGame`, host `remove` and `cancelGame` set `refund_due = amount` on the share with no cut-off and the booking becomes unpaid for that share; when the host cancels late, `refundBooking` applies the venue's late-cancel retention to the host's own part only, so players' shares are owed back in full: a court paid by three players' shares can be abandoned an hour before with nothing kept. Documented as intended (`matchmaking.md` "Owed back when the game does not happen to them").
- **Matters to.** Venue: late-abandonment costs; players: none.
- **Evidence.** `src/lib/games.ts`, `shareOwedBack(..., true)`.
- **Classification.** Questionable policy.
- **Reproduction.** By reading.
- **Root cause.** Shares follow a separate rule from the venue's cutoff.
- **Recommended resolution.** Shares follow the venue's cutoff for the leaver; a late-cancelling host owes the venue's late share on the whole price (DEC-51). Size M.
- **Status.** OPEN. Not changed; changes a documented rule, so it is the owner's.

### F12 · P3 · OPEN decision (DEC-18)

- **Domain and scenario.** Box-league fees on a staff removal or a league closed mid-season.
- **Observed and expected.** `leave()` (also a staff "remove a player") sets `withdrawn_at` and walkovers only and `closeLeague` deletes the forming season; a fee paid online before the removal is not set `refund_due` (only one arriving after leaving is), and a counter-paid fee has no record (see C11). Read, not run.
- **Matters to.** Players: a paid fee with no refund trail.
- **Evidence.** `src/lib/leagues.ts`.
- **Classification.** Unverified assumption.
- **Reproduction.** Not run.
- **Root cause.** The fee path was written for the player's own leaving.
- **Recommended resolution.** Owe back the unplayed share on a staff removal or ask staff to decide explicitly (DEC-18).
- **Status.** OPEN decision, DEC-18. ADR 0059 says a box league's place fee is not covered: it needs the owner's decision on mid-season removals.

### F13 · P3 · OPEN decision (DEC-54)

- **Domain and scenario.** Two opposite statements about minors' names on a tournament's main public page.
- **Observed and expected.** `known-limitations.md` (Tournament day) says the main page shows entry names in full, including declared minors, "Open for the owner"; the code (`src/app/api/tournaments/[id]/route.ts:31 namedForThePublic`), `docs/features/tournaments.md` and `privacy.md` say it shortens a declared minor. The code wins; the stale limitation hides the real gap: an event with no age range and an entrant with no declared age shows the full name of someone who typed an age under 18 elsewhere.
- **Matters to.** Children: a name shown that the rule says is shortened.
- **Evidence.** The files above.
- **Classification.** Documentation conflict (AGENTS.md rule 9).
- **Reproduction.** By reading.
- **Root cause.** A limitation not updated when the code was.
- **Recommended resolution.** Correct the text; shorten when age is unknown (DEC-54). Size S.
- **Status.** OPEN, with the documentation conflict corrected. The stale statement in known limitations (*Tournament day*) was corrected on 6 November 2026 by the documentation worker, on the evidence of the code, [tournaments](../features/tournaments.md#names-of-minors-on-public-pages) and [privacy](../architecture/privacy.md#minors-names-on-public-pages); the code was not changed. What stays open is the unknown-age case (DEC-54).

### F14 · P3 · OPEN

- **Domain and scenario.** Competition-day and results race controls.
- **Observed and expected.** Not a defect. A reminder that no alert reaches staff when a called fixture's wait ends (recorded in known limitations), and all result and forfeit notices travel by the unverified email outbox only (no WhatsApp for time-critical competition messages).
- **Matters to.** Organisers and players on the day.
- **Evidence.** `docs/roadmap/known-limitations.md`.
- **Classification.** Operational risk.
- **Reproduction.** Not applicable.
- **Root cause.** Single channel.
- **Recommended resolution.** Keep recorded; a second channel once WhatsApp is verified.
- **Status.** OPEN. Reminder only.

## G: communications, reports, privacy and the scheduler

Auditor G. Customer identities, communications (the outbox, marketing, WhatsApp
credit), reports and exports, integrations, the scheduler, privacy and
retention. G4 is in the block of C8, and G12 in A6. All message fixes are
tested against stand-ins: email, WhatsApp and SMS are never live-verified (the
messaging rows in [feature status](../product/feature-status.md#integrations)).

### G1 · P1 · FIXED

- **Domain and scenario.** Communications: a WhatsApp token expires overnight, SES is suspended, or DNS fails, for all venues.
- **Observed and expected.** `MAX_ATTEMPTS = 5` with backoff of 1, 5, 30 and 120 minutes meant the fifth failure (about 156 minutes) set `abandoned` for good; recovery was `retryMessage`, one message per click by venue staff, refused past 8 a day, with no "resend all that failed since X", and account emails could not be resent at all. Expected: transactional messages survive an outage of a day and give up on staleness of content, not on count; or one bulk resend.
- **Matters to.** Customer: no confirmation, venue-cancellation or waitlist notice (the offer window is minutes); venue: staff resend one by one; platform: hundreds of rows across tenants after one expired token. The `messages` alert fires only on at least five failures and none sent in the hour, by email through the failing channel.
- **Evidence.** `src/lib/outbox.ts:212-219, 596-601, 624-659`; `src/lib/alerts.ts:147-160`.
- **Classification.** Verified defect (retry policy) plus missing workflow (bulk resend).
- **Reproduction.** `audit9-G-12.test.ts` (three queued messages `abandoned` after an outage; scratch). Regression: `tests/outbox-reliability.test.ts`.
- **Root cause.** An attempt-count give-up with a short backoff; no distinction between a bad address and an unavailable provider.
- **Recommended resolution.** Classify errors: transient retry up to about 48 hours; only permanent errors abandon fast; "Resend all failed" (DEC-55).
- **Status.** FIXED. `tests/outbox-reliability.test.ts`; [ADR 0056](../architecture/decisions/0056-outbox-reliability-messages-survive-outages-and-stops.md) decisions 1 and 2: no count of tries gives a message up; the backoff grows to two hours and stays there; a message is given up when older than `MYSENAM_MESSAGE_MAX_AGE_DAYS` (default 7, not 48 hours), with staff and owners told; a transport marks a failure permanent (`PermanentSendError`) only for an address that is not an address, a number WhatsApp says it cannot deliver to, or a message for the other channel; staff can send again everything that failed in a window, per venue, audited, with the single resend's refusals; an account email (whose link is not kept) is never put back. Still true: the outbox is at-least-once (a process that dies mid-send re-sends after ten minutes).

### G2 · P1 · FIXED

- **Domain and scenario.** The accountant's export.
- **Observed and expected.** `toCsv` prefixed any cell starting `=`, `+`, `-` or `@` with an apostrophe, including numeric columns, so every credit note's gross and net came out as the text `'-40.00`: in Excel or Sheets a text cell with a visible apostrophe that sums and imports skip. The docs say "Credit notes are negative". Also bookings "Price adjusted" and the summary CSV. Expected: names and free text guarded, numbers written as numbers.
- **Matters to.** Venue and accountant: the export meant to reconcile takings overstates them by every refund, silently.
- **Evidence.** `src/lib/export.ts:19-22`; `src/lib/accounting.ts:380-403`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-G-14.test.ts` (scratch). Regression: `tests/export-credit-note-numbers.test.ts`.
- **Root cause.** One escaping rule for every column type.
- **Recommended resolution.** Guard text columns only.
- **Status.** FIXED. `tests/export-credit-note-numbers.test.ts`; [ADR 0055](../architecture/decisions/0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md) decision 5: a JavaScript number, and a string of only a minus sign, digits and one decimal point, is a number and written as it is; any other string starting `=`, `+`, `-`, `@`, tab or CR is still guarded (`-1+1` is guarded). Every `toCsv` caller was read; the ratings ledger's negative changes are now numbers too.

### G3 · P1 · FIXED

- **Domain and scenario.** Reports.
- **Observed and expected.** A paid booking of RM40 adjusted to RM30 after payment (a credit note; `total_price` unchanged) showed `collected` 40 in `venueReport` against 30 in the journal, because the report summed `total_price` and netted credit notes only for late-cancelled bookings. Goodwill adjustments are routine. Expected: the same money in both, or the difference named.
- **Matters to.** Venue manager reconciling the month: the report RM10 above the journal and the till; tax (journal-based) and `collected` disagree.
- **Evidence.** `src/lib/reports.ts:459, 480-493`; `src/lib/price-adjustments.ts:166-169`; `src/lib/accounting.ts:199-203`.
- **Classification.** Verified defect (cross-report disagreement).
- **Reproduction.** `audit9-G-11.test.ts` (`collected` 40, expected 30; scratch). Regression: `tests/report-reconciliation.test.ts`.
- **Root cause.** Two bases (booking row against receipts and credit notes) joined only for late cancels.
- **Recommended resolution.** `bookingGross - bookingCredited` for confirmed bookings (DEC-25).
- **Status.** FIXED. ADR 0055 decisions 1 and 3: one definition of each money figure (`bookingMoney`), a booking adjusted down shows the adjusted amount, the tax of an adjusted booking has the credit note's tax taken off. The report counts a booking on the day it was played, the journal counts money on the day it was paid: they agree over any period holding both dates, and the page says why they can differ otherwise.

### G5 · P2 · FIXED

- **Domain and scenario.** A booking paid with a pass in the report.
- **Observed and expected.** Pass RM180 sold; one RM40 booking paid with it. The journal's takings were 180 ("a booking paid with a pass is not a row: the pass was the sale"); the report's `collected` was 40 with a "pass" line in `collectedBy`, the pass sale in neither, while the report's `tax` excluded pass-paid bookings: two bases in one report. Expected: pass-paid excluded from collected and shown separately.
- **Matters to.** Venue: monthly "collected" matches neither bank nor journal.
- **Evidence.** `src/lib/reports.ts:459, 462`; `docs/features/reporting.md:35`.
- **Classification.** Verified defect against the docs.
- **Reproduction.** `audit9-G-10.test.ts` (scratch). Regression: `tests/report-reconciliation.test.ts`.
- **Root cause.** No `paid_via <> 'pass'`.
- **Recommended resolution.** Cash basis matching the journal (DEC-25).
- **Status.** FIXED. ADR 0055 decision 2: a booking paid with a pass is not collected; the report leaves it out of *collected*, its split, its tax and *outstanding*, and shows it as `passPaid` (how many, at their price) beside *collected*. The usage basis was the alternative and was not chosen.

### G6 · P1 · FIXED

- **Domain and scenario.** "Forget me" and the 730-day anonymisation.
- **Observed and expected.** A scan of every text column after `eraseCustomer` found `online_payments.payer_name` and `payer_phone` (never touched by erasure or any retention rule, not in the export), `messages.recipient` (and a body with first name and booking detail) for up to 90 days with any queued message still sent after erasure, and `webhook_deliveries.payload` (full name, email, phone) for 30 days; `privacy.md` listed retention per table and not `online_payments`. Expected: payer fields anonymised with the booking, pending messages and webhooks abandoned, delivered ones scrubbed.
- **Matters to.** Customer: the right to erasure and a DSAR export that omits payments; platform and venue: PDPA exposure from a table nobody listed.
- **Evidence.** `src/lib/privacy.ts` (no `online_payments` reference; erasure list `:1121-1245`); `db/migrations/0001_initial.sql:389-390`; `src/lib/webhooks.ts:154`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-G-1.test.ts` (scratch). Regression: `tests/erasure-scan.test.ts`.
- **Root cause.** Retention written table by table; one table missing.
- **Recommended resolution.** Anonymise payer fields with the booking (money rows stay), scrub message recipients, drop pending webhooks (DEC-57).
- **Status.** FIXED. `tests/erasure-scan.test.ts`; [ADR 0057](../architecture/decisions/0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md) decision 6 (`src/lib/erasure-traces.ts`): payer name and number on a payment provably the account's become `(removed)` and nothing (the payment, its amount, refunds and gateway bill stay); messages to the account's email or proved number or about its bookings are scrubbed and any queued one given up; webhook deliveries about its bookings are dropped if unsent and reduced to id, type and time if sent; urgent notices lose the name, number and email; payer fields are anonymised after the bookings' 730 days; the export lists the account's payments and deliveries. The test scans every text column of every table and holds the list of every table with a person's details (`HOLDS_PEOPLE`). **Provisional:** 730 days is an operational choice, not a statement of what the law requires for payment records (the audit's alternative, seven years, was not chosen). Residual, open: staff-alert messages naming a customer without a booking link keep the name for the 90-day retention.

### G7 · P2 · FIXED

- **Domain and scenario.** A booking reminder.
- **Observed and expected.** A reminder was written once per booking code (`reminder:<code>`): a reminder stuck behind a failing provider was sent for a booking cancelled meanwhile (the outbox never looked at the booking again), and one sent for Saturday blocked a second for the booking moved to the next Wednesday. Lesson moves re-key and abandon; court bookings did not. Expected: a reminder states the booking as it stands, once per code, date and start; unsent ones abandoned on cancel or reschedule.
- **Matters to.** Customer: a reminder for a cancelled booking, none for the new time.
- **Evidence.** `src/lib/notify.ts:1038, 1068`; `src/lib/lesson-venue-moves.ts:98-99`; `src/lib/outbox.ts:553-611`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-G-2.test.ts` (both tests; scratch). Regression: `tests/outbox-reliability.test.ts`.
- **Root cause.** The dedupe key is the code alone; no look at the booking at send.
- **Recommended resolution.** Key by code, date and start; skip a booking not confirmed.
- **Status.** FIXED. ADR 0056 decision 3: a message is looked at again as it is sent; a reminder is for one booking at one time.

### G8 · P2 · FIXED

- **Domain and scenario.** A venue's campaign and queue order.
- **Observed and expected.** `sendCampaign` queued one message per subscriber at once and `dueMessages` was `ORDER BY id LIMIT 25`, so a 60-person campaign put a customer's booking confirmation or waitlist offer behind it (a 2,000-person list held back everything after it for tens of minutes to hours); and a subscriber who unsubscribed after queuing still received it because consent was not rechecked at send. Expected: transactional first, consent checked at send.
- **Matters to.** Customer: late confirmations; venue and platform: consent is a legal matter.
- **Evidence.** `src/lib/marketing.ts:266-274`; `src/lib/outbox.ts:518-529, 553`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-G-3.test.ts` (both tests; scratch). Regression: `tests/outbox-reliability.test.ts`.
- **Root cause.** One FIFO queue; no send-time consent check.
- **Recommended resolution.** Order campaigns last; re-read consent at send.
- **Status.** FIXED. ADR 0056 decision 3: queue order puts what somebody waits for ahead of bulk news; a campaign needs the consent still standing when sent.

### G9 · P2 · FIXED

- **Domain and scenario.** The 8-messages-a-day cap.
- **Observed and expected.** `UNCAPPED_KINDS` excluded `team_decision`, `safeguarding_notice` and others but not `waitlist_offer`, `booking_cancelled_by_venue`, `booking_moved`, `booking_rescheduled` or `guardian_notice`, which `URGENT_KINDS` treats as news a customer must not miss, so after 8 messages to one address in 24 hours (reminders, campaigns from several venues) they became `abandoned` with no retry; anyone could push a victim's address to the cap with guest bookings. Expected: one list; urgent kinds bypass the cap.
- **Matters to.** Customer: misses a cancellation or an offer.
- **Evidence.** `src/lib/outbox.ts:111` against `src/lib/whatsapp-credit.ts:73`; `enqueue :297-298`.
- **Classification.** Verified defect (two lists for one concept).
- **Reproduction.** `audit9-G-5.test.ts` (first test; scratch). Regression: `tests/outbox-reliability.test.ts`.
- **Root cause.** Two lists.
- **Recommended resolution.** One list, uncapped (DEC-56).
- **Status.** FIXED. ADR 0056 decision 4: `URGENT_NEWS_KINDS` (venue's cancellation, move and change, waitlist offer, guardian's notice, refund notice, and since ADR 0063 the suspension notice) is exempt from the 8 a day but has a ceiling of its own (`MYSENAM_URGENT_PER_RECIPIENT_PER_DAY`, default 30), so a stranger cannot flood a number with them.

### G10 · P2 · FIXED

- **Domain and scenario.** The outbox tick.
- **Observed and expected.** `tickOutbox` ran `processResetRequests`, `processRegistrationRequests`, `notifyPendingOffers`, reminders and `remindPlayers` unguarded before `drainOutbox`: a throw in any earlier step stopped all draining platform-wide while the row stayed, and each admin route awaiting `tickOutbox` after committing answered 500 though its action succeeded. Likelihood unproven (no organic poison row found). Expected: each step isolated; the drain always runs.
- **Matters to.** Platform: blast radius of one bad row.
- **Evidence.** `src/lib/notify.ts:644-663`; callers e.g. `src/app/api/admin/bookings/cancel/route.ts:61`.
- **Classification.** Operational risk.
- **Reproduction.** `audit9-G-5.test.ts` (second test, with a step mocked to throw; scratch). Regression: `tests/outbox-tick-isolation.test.ts`.
- **Root cause.** Sequential unguarded steps.
- **Recommended resolution.** try/catch each step with `raiseAlert`, always drain.
- **Status.** FIXED. `tests/outbox-tick-isolation.test.ts`; ADR 0056 decision 5.

### G11 · P2 · FIXED

- **Domain and scenario.** A committed booking or venue cancellation whose message was never written.
- **Observed and expected.** Confirmations were written inline after the booking commit and the venue-cancel route ran `refundCancelled` (a gateway call) before writing the log and the notice; a stop between left a customer with a booking or cancellation and no message, and no row on the desk's urgent-notice list. Waitlist offers and reminders were swept; these were not. Money obligations in the same gap were recovered, the customer's message was not.
- **Matters to.** Customer: told nothing.
- **Evidence.** `src/app/api/bookings/route.ts:633`; `src/app/api/admin/bookings/cancel/route.ts:55-59`; `src/lib/outbox.ts:280-287`.
- **Classification.** Operational risk.
- **Reproduction.** `audit9-G-8.test.ts` (both tests; scratch). Regression: `tests/notices-owed.test.ts`.
- **Root cause.** The message is a step after the commit.
- **Recommended resolution.** A sweep for venue cancellations and confirmations.
- **Status.** FIXED. ADR 0056 decision 6, migration 0299 (`notices_owed`): a message owed to a customer is recorded with the fact in the same transaction and a sweep writes it if the request never did; only the paths that tell the customer owe the row (the booking route, the staff cancel route and closures, the customer's own cancel). Open: series cancellations and class enrolments owe no recovery row; a message recovered by the sweep lacks the reason staff typed and how a counter payment was settled.

### G13 · P2 · FIXED

- **Domain and scenario.** The customer is never told a refund was made, failed or is late.
- **Observed and expected.** The only refund wording was at cancellation; nothing when the gateway refund succeeded, failed ("closed card") or staff marked it refunded; the digest went to staff after a day. Customers then ask the venue or dispute the charge. Expected: one message when money has gone back, and one if the venue cannot refund to the card.
- **Matters to.** Customer: unsure whether they were refunded; venue: queries and chargebacks.
- **Evidence.** `src/lib/payments.ts` (`recordRefund`, `finishClaim`, `markRefunded` contain no notify call); `src/lib/i18n.ts`.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only. Regression: `tests/refund-notices.test.ts`.
- **Root cause.** No notice designed.
- **Recommended resolution.** A `refund_made` message deduplicated by refund (DEC-27).
- **Status.** FIXED, email only. `tests/refund-notices.test.ts`; ADR 0056 decision 7: the customer is told what became of money paid back, once per change (`refund_notice`, keyed by payment, state and amount), read from the refund's own state so a stop between refund and message is found again. Limits: only a customer who left an email is reached (WhatsApp needs an approved template); refunds on payments with no booking (tournament fees, shares) cannot be told to the customer.

### G14 · P2 · FIXED

- **Domain and scenario.** The platform's monthly invoice to a venue.
- **Observed and expected.** `issueDueInvoices` wrote `venue_invoices` and told nobody; the first message was `warnOverdue` at due plus 7 days and the venue came off the marketplace at due plus 14; `warnOverdue` stamped `warned_at` before telling (a crash lost the warning) and told only the first venue's staff of a business. Expected: email the invoice on issue; warn before and after the due date; tell all of a business's managers.
- **Matters to.** Platform revenue (late payments); venue: delisted without having been billed in writing.
- **Evidence.** `src/lib/billing.ts:254-330`; `src/lib/payment-holds.ts:95-135`.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only. Regression: `tests/platform-invoice-notices.test.ts`.
- **Root cause.** No notice on issue.
- **Recommended resolution.** Email on issue and warn at 3 days before and 1 day after (DEC-27).
- **Status.** FIXED, narrower. `tests/platform-invoice-notices.test.ts`; ADR 0056 decision 8, migration 0300: the invoice is told to the venue's managers when issued and a few days before it falls due, once each, told-then-stamped under the outbox's dedupe key; the overdue warning is made crash-safe the same way; no new warning one day after the due date. Limit: a business's invoice goes to its managers through its first branch; a venue with no manager is told nothing (the owners see it on the billing page).

### G15 · P2 · FIXED

- **Domain and scenario.** E-invoicing.
- **Observed and expected.** `runEInvoicing` looped venues calling `consolidate` without a per-venue try/catch, so one throwing venue skipped the rest and `submitPending`/`checkSubmitted` that tick; consolidation was attempted only on days 1 to 7; a `failed` (not sent) document was never retried and nobody was alerted. The submission mechanics (claim, unknown outcome, never resend blindly) are sound.
- **Matters to.** Venue: late or missing consolidated e-invoices; platform: one venue's error stops all.
- **Evidence.** `src/lib/myinvois.ts:1342-1351, 927-953, 1172`; `docs/integrations/myinvois.md:97`.
- **Classification.** Operational risk.
- **Reproduction.** By reading only. Regression: `tests/einvoice-resilience.test.ts`.
- **Root cause.** No per-venue isolation, a once-only window, no retry.
- **Recommended resolution.** Per-venue try/catch, retry `failed` automatically, alert once by day 5, catch up the previous month.
- **Status.** FIXED against the stand-in only. `tests/einvoice-resilience.test.ts`; [ADR 0055](../architecture/decisions/0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md) decision 6: each venue's consolidation and each document's send is isolated, a failure alerts the owner (told again every `RESEND_HOURS`) and the venue's staff; the month before is consolidated on any day (every run in the first seven days, then once an hour, only for a venue that e-invoiced before the month began); a document that certainly did not reach LHDN goes back to waiting after a back-off (15, 30, 60, 120, 240 minutes, then 6 hours) and is sent by the same claim; an unknown outcome is never retried by itself. **MyInvois stays a stand-in** (`INTEGRATION_VERIFICATION_REQUIRED`); LHDN's timing for a consolidated e-invoice is `UNVERIFIED`, so what a late (after day 7) one means is for the adviser. A month further back is not made by itself.

### G16 · P2 · PARTLY

- **Domain and scenario.** Prepaid value expiring without warning, and vouchers in no liability figure.
- **Observed and expected.** No job reminded a customer before a pass, gift voucher or membership expired (vouchers had a staff "lapsing" filter only); reports' `liabilities` showed pass entries in hours and counts of memberships, no ringgit, and nothing for vouchers. Expected: an email 14 and 3 days before expiry; voucher balance and pass value in `liabilities`.
- **Matters to.** Customer: loses money unaware and disputes; venue and accountant: an unrecorded liability.
- **Evidence.** `src/lib/reports.ts:133-139, 678-704`; `src/lib/scheduler.ts` job list.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only. Regression: `tests/report-venue-owes.test.ts`.
- **Root cause.** No expiry notices designed; liabilities in hours.
- **Recommended resolution.** Reminders and a ringgit liability line (DEC-38).
- **Status.** PARTLY. The liabilities block in ringgit was built (see C9; ADR 0055 decision 4, provisional; voucher expiry and the pass value estimate stay open). **Open:** customer reminders before a pass, voucher or membership expires are not built (D11, DEC-38).

### G17 · P3 · OPEN

- **Domain and scenario.** Webhook redelivery.
- **Observed and expected.** Events that exhausted their 8 attempts (about 2 hours) are never redelivered; an endpoint failing a day is switched off (staff told) and `resumeEndpoint` re-enables but replays nothing; bookings created while it was off and older than 2 days are "noted without an event"; the sweep reads only dates between yesterday and +120 days. The payload carries name, phone and email.
- **Matters to.** Integrators: missed events, no replay.
- **Evidence.** `src/lib/webhooks.ts:222-257, 316-326, 115-118`.
- **Classification.** Operational risk.
- **Reproduction.** By reading only.
- **Root cause.** No replay designed.
- **Recommended resolution.** "Resend failed events" per endpoint; list events missed. Size M.
- **Status.** OPEN. Not changed.

### G18 · P3 · OPEN

- **Domain and scenario.** The scheduler.
- **Observed and expected.** `runScheduledWork` is one sequential tick guarded by `busy`: a long backup and off-site upload sit after the messaging and refund jobs and pause the next tick (the outbox, refund settling, hold release); work is not cancelled if lease renewal fails, so two instances can overlap.
- **Matters to.** Platform: delays under load.
- **Evidence.** `src/lib/scheduler.ts:80-383, 445-475`.
- **Classification.** Operational risk.
- **Reproduction.** By reading only.
- **Root cause.** One chain, one lease.
- **Recommended resolution.** Run backup and off-site in a separate lease or interval. Size S to M.
- **Status.** OPEN. Not changed.

### G19 · P3 · OPEN

- **Domain and scenario.** The loyalty grant.
- **Observed and expected.** `grantLoyaltyIfDue` marks "done today", then `grantLoyalty` does `issuePass` and a separate `INSERT INTO loyalty_rewards` (no transaction, no unique key): two concurrent runs, or a stop between issuing and recording, give the free hour twice.
- **Matters to.** Venue: a free hour (low impact).
- **Evidence.** `src/lib/loyalty.ts:84-132, 138-147`.
- **Classification.** Verified defect (low impact).
- **Reproduction.** `audit9-G-6.test.ts` (2 free passes, expected 1; PGlite and Postgres; scratch).
- **Root cause.** No atomicity or unique key.
- **Recommended resolution.** One transaction per reward with `UNIQUE (venue_id, phone_key, n)`. Size S, migration.
- **Status.** OPEN. Not changed.

### G20 (first point = H11) · P3 · OPEN, H11 FIXED

- **Domain and scenario.** Four smaller points.
- **Observed and expected.** (a) **WhatsApp credit and a crash** (also H11): `spendCredit` before `send`; a process that dies mid-send re-tries after 10 minutes and spends again; a message abandoned for "no WhatsApp credit" is not retried when the pack is bought. (b) **The phone code cap can be burned by anyone**: 5 codes per number a day counted across all accounts, so an account can use up a number's day and send the holder 5 codes (`src/lib/phone-check.ts:150-154`). (c) **A guest booking is attached to whoever holds the typed email**: `ACCOUNT_BOOKING` lets a confirmed account cancel any email-matched guest booking (`src/lib/store.ts:4764`); a wrong or malicious email gives a stranger cancel rights. (d) **The activity log is kept two years and a failed write is only logged to the console** (`src/lib/privacy.ts:456`, `src/lib/activity.ts:34-38`) while receipts and e-invoices are kept seven years, so "who refunded, voided or adjusted" disappears first.
- **Matters to.** (a) cents; (b) customer verifying a number; (c) a guest's booking; (d) venue and platform: evidence of money actions.
- **Evidence.** As above; `src/lib/outbox.ts:557-586`, `src/lib/whatsapp-credit.ts:124-136`.
- **Classification.** (a) operational risk; (b) operational risk; (c) questionable policy; (d) questionable policy.
- **Reproduction.** By reading only.
- **Root cause.** Four separate small gaps.
- **Recommended resolution.** (a) Idempotent spend per message id; (c) show but cancel only with the booking code and phone (DEC-59); (d) keep money, permission and policy entries seven years, the rest two (DEC-58).
- **Status.** (a) The double spend is FIXED as H11: `tests/whatsapp-usage.test.ts` (also found by the reports worker); that a message abandoned for "no WhatsApp credit" is not retried when a pack is bought is not recorded as changed. Points (b), (c) and (d) OPEN (DEC-58, DEC-59), not changed. The G20 identifier as a whole is counted OPEN, as in the status file.

## H: adversarial sequences across modules

Auditor H raced the state machines of the booking, payment, refund, pass, class,
tournament and venue-lifecycle sequences against each other. Eleven of its
thirteen findings were found by another auditor too and are blocks above; this is
where each is found.

| H finding | Severity | Is | Block | Status |
| --------- | -------- | -- | ----- | ------ |
| H1 | P1 | A deposit or friends' shares end above the price | C1 = H1 | FIXED |
| H2 | P1 | One stale draft with a ladder stops retention | A1 = H2 | FIXED |
| H3 | P2 | Closing a day and a rain-out cancel first, close last | B1 = E9 = H3 | FIXED |
| H4 | P2 | Counter fees not owed back when a tournament is called off | C11 = F4 = H4 | FIXED |
| H5 | P2 | Voiding a pass with refund while it pays a future booking | D1 = H5 | FIXED |
| H6 | P2 | Late cancel of a pass-paid booking keeps the whole entry | C14 = D14 = H6 | OPEN decision |
| H7 | P2 | A payment after the hold lapsed is refunded by hand | C18 = H7 | OPEN decision |
| H8 | P2 | No way for a venue to leave; a suspended venue strands customers | A5 = H8 (exit), A4 (suspension) | PARTLY |
| H9 | P3 | A cancelled class leaves its waiting list `waiting` | E12 = H9 | FIXED |
| H10 | P3 | The cash-up knows nothing of hire deposits | C10 = E13 = H10 | FIXED |
| H11 | P3 | A paid WhatsApp message tried again after a crash is charged twice | G20, first point | FIXED |
| H12 | P3 | A staff cancellation, a membership void and a pass void cannot be undone | below | OPEN |
| H13 | P3 | Front desk may rain out a whole afternoon but not close a day | below | OPEN decision |

H8 is the one that is two things: the suspension half is fixed under A4 (customers
told, nothing new sold, renewals paused, with its limits there) and the exit half
is open under A5 (DEC-03).

### H12 · P3 · OPEN decision (DEC-15)

- **Domain and scenario.** Undoing a mistaken cancellation.
- **Observed and expected.** No write sets a booking back to `confirmed` (only the insert does), nor a membership or pass back to `active`. A desk cancelling the wrong booking frees the court at once (a waiting-list offer sent in the same call), issues the credit note and owes back the payment; recovery is a new booking, a new payment and a customer who got a cancellation email. Expected: a manager's "reinstate" within N minutes while the slot is still free and no offer was made, or a confirmation step on cancelling a paid booking.
- **Matters to.** Customer and staff: an accident with no way back; the customer is told their booking was cancelled.
- **Evidence.** By reading and search: no `UPDATE bookings SET status = 'confirmed'`; `adminCancelBookingOnce` offers the slot in the same call.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only.
- **Root cause.** Cancellation is one-way by design.
- **Recommended resolution.** A confirmation step on cancelling a paid booking first, then a short-window reinstate if desks report the need (DEC-15). Size M.
- **Status.** OPEN decision, DEC-15. Not changed.

### H13 · P3 · OPEN decision (DEC-08)

- **Domain and scenario.** Front desk and bulk cancellation.
- **Observed and expected.** `MANAGER_ONLY` lists `venues/:id/closures` and `outages` but not `rain-out`; `docs/architecture/tenancy.md` and `booking.md` say "Front-desk staff can do it" for rain-outs, so this is deliberate. A rain-out over the opening hours of every court is the same bulk cancel and refund as a closed day, and `safety: true` makes blocks nothing can override. Recommended: the desk may preview; a manager (or a second confirmation) for a rain-out over a threshold of bookings, and for `safety`.
- **Matters to.** Venue: a mistaken whole-afternoon cancel with refunds, by the least senior role.
- **Evidence.** `src/lib/roles.ts` `MANAGER_ONLY`; the tenancy and booking documents. After ADR 0057 the route classes are written down in `tests/admin-route-classes.test.ts` and rain-out is classed as a desk tool.
- **Classification.** Questionable policy (documented).
- **Reproduction.** By reading.
- **Root cause.** A documented role decision.
- **Recommended resolution.** Keep, or require a manager for safety and for more than N bookings (DEC-08); it changes a documented rule, so it is the owner's.
- **Status.** OPEN decision, DEC-08. Not changed.

