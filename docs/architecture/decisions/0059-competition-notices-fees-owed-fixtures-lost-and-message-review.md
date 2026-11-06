# ADR 0059: Competitions tell the people they change, owe back what they took, and say when a court is lost; reports of messages are told, and an automatic suspension can be reviewed

- **Status:** current, decided in the ninth audit round (audit findings F1 to F5, F7 to F10 and C11). Built in migrations 0304 and 0305. What people see is in
  [tournaments](../../features/tournaments.md) and [messages between players](../../features/player-messages.md#every-report-is-told-and-an-automatic-suspension-can-be-reviewed).
  Builds on [ADR 0002](0002-database-enforced-concurrency.md) (the database's locks), [ADR 0013](0013-competition-framework.md) (competitions are data),
  [ADR 0039](0039-messages-between-players.md) (messages between players) and [ADR 0052](0052-youth-messaging-interim-safeguards-pending-legal-review.md) (a neutral
  review that promises no legal right). **Legal questions stay pending legal review: nothing here is a legal conclusion** (see *Messages*).
- **Context:** an independent audit found that the competitions code told the people it affected only when they were the opponent or on the waiting list, owed back only
  what was paid online, left drawn fixtures on a court that no longer existed, and let a draw race a withdrawal; and that an automatic suspension of somebody's messaging,
  which the published rule says the platform owner reviews, could not be reviewed (the owner could not see its reports, the venue could not lift it, nothing prompted anyone, the
  person could not ask). Each had a smallest change that gives the intended outcome; this record keeps the choices that were not obvious.

## Competitions

1. **The draw is made under the tournament's row lock** (`makeDraw`): one transaction, `SELECT … FOR UPDATE` on the tournament first (the order every other mutation takes), the
   entries read as of the lock, the final status change conditional on the tournament still being open or closed. A withdrawal at the same moment lands before it (the
   entrant is not drawn) or after it (the existing rules for leaving a drawn event); of two draws, one is made and the other is refused ("made already"). A serialisation
   failure is retried by the transaction wrapper, or answered as busy with nothing written. Not a new engine: the same lock, the same wrapper.
2. **A fee taken at the counter is owed back, written down, never paid out by itself.** A tournament the venue calls off, and an entrant taken out before the draw where the
   tournament's rules refund before the draw, write a row in `counter_fee_refunds_owed` (one per entry: how much, how it was paid, why). It is a *sibling* of the bookings'
   `counter_refunds_owed`, not a generalisation of it: that table, its payout table and its settling code are keyed to a booking and the cash-up reads them, so widening
   them would touch money paths that are not part of the defect; the cost is a second list, shown in the same panel. Staff settle it (handed back the way it was paid, who and
   when kept, a credit note on the entry's receipt written then, an activity entry), once, the front desk only for a fee taken today, as for a booking. Only a fee **receipted at the
   counter** is owed this way (the receipt says how much and how); a fee paid online stays the gateway's (`refund_due`). A box league's place fee (audit finding F12) is not
   covered: it needs the owner's decision on mid-season removals.
3. **Whoever staff take out of an event is told, once**, with the reason staff gave, what it means for the fee as the tournament's rules have it, and who to contact. A player's own
   withdrawal is not told back to them; a no-show walkover tells the side that did not come (one message if they are also taken out). The notice is keyed by the entry (or the
   match and entry), so a repeat tells nobody twice. The text states what the venue decided; it says nothing of rights to a hearing.
4. **A tournament with no entries-close date stops taking entries and entry fees after its first day**, and the scheduler closes it then; it is a **needs-attention** line for the
   venue's managers and the owner from that day until it is drawn or called off, with the court time still held for it listed. (The audit suggested the day before the first day
   and an email two days ahead; this is the narrower reading the owner's brief gave: nothing is refused before the event has started, and the dashboard is the reminder.)
5. **A court lost after the draw is shown, told and postponed**, in three parts. (a) *Warn at the time, without refusing:* taking a court out and closing a day answer the
   fixtures still drawn there; they do not refuse, as they do for bookings, because bookings are cancelled by the same action and fixtures are not (they are moved, which needs
   the day to move them to). (b) *Tell once:* each side, and both captains, by the outbox, keyed by the fixture's place and time and the person. (c) *One action:* `postpone_day`
   moves a tournament's day all-or-nothing by the checks of `placeMatch`, and a team league's night fixture by fixture by `moveFixture`'s (`left` says what could not be placed). The
   list on the dashboard is **derived** from the outages and closures as they stand, never a second record that can go stale. Ladder holds already had their own notice.
6. **A walkover a player reports is reminded to the silent side once, 12 hours before it stands**, and a result that stood by silence is flagged as such, with who reported it and
   when, for staff. It still stands after 24 hours: the owner's recommended default in the audit notes (a walkover never auto-stands) was not taken, because the brief chose the
   notice; the flag and the evidence are what let staff see and correct one that was wrong.
7. **An unanswered ladder challenge is reminded once before it forfeits**, half the response window before it ends by default (the ladder's `remind_days` overrides it), claimed for
   the last day to answer so a repeat reminds nobody and a counter-proposal's new day reminds again.

## Messages

8. **A report of a message in an ordinary conversation is told when it is made**, to the managers of the venue (the platform's owners where there is no venue): that a message was
   reported, how many reports are open, where to look, **with no text, no names and no reason**, once per report, never to a member of staff who is the person reported. It is the same alert for
   every report: nothing reads the reporter's chosen reason or note, so "I feel unsafe" is not special-cased by text. The needs-attention panel shows the open count and the age
   of the oldest.
9. **An automatic suspension can be reviewed**, within the existing case workflow and authorisation model:
   - it is told to the owners and the managers of the venue whose report completed the count, with a review date (14 days: operational, not a legal period, and nothing lifts by itself);
   - the owner reads the reports behind it (the one place the owner reads a venue's reports), and a venue's manager lifts one that rests on that venue's reports alone (otherwise it
     is the owner's: a suspension is platform-wide);
   - it is lifted when fewer than the rule's number of different people's reports are left to count after reports are found to need no action;
   - the suspended person can ask for a review from the line that says their messages are paused: the same neutral route as a youth restriction (ADR 0052), decided by somebody who did not
     apply it, answered *lifted* or *stands* in neutral words. **No legal right to a review or to notification is promised, and nothing about it is a legal conclusion: those
     questions are pending legal review (ADR 0052, `docs/operations/legal-review-youth-messaging.md`).**

## What this does not do

- It does not make a venue's manager able to escalate an adult-thread report to the owner (finding F8's escalation), notify the reporter of the outcome, or change what three accounts
  can do between them (accepted, known limitations).
- It does not generalise the bookings' counter-refund tables, pay anything out, or cover a box league's place fee.
- It does not move the draw's other callers (Swiss and counted-Swiss draws) out from under the lock: they run inside it now, in the same transaction.
- A staff screen setting for the ladder reminder lead exists; the walkover reminder is a constant.

## Alternatives considered

- **Refuse an outage or closure over fixtures until staff acknowledge them** (as for bookings): rejected as a first step because it needs a confirmation screen on two routes and
  changes a flow the venue relies on in an emergency; the warning, the notice and the derived list give the outcome without a new refusal.
- **Generalise `counter_refunds_owed` to a source (booking, entry, place)**: rejected for the reasons in 2.
- **A new moderation workflow for adult suspensions**: rejected; the existing report, suspension and review-by-another-login model already has everything but the visibility, the re-check
  and the person's request.
