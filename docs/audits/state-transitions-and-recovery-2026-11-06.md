# State-transition and failure-recovery audit, 6 November 2026

The third of four records of the business-process audit of MySenam at commit
`2aabdd406626c9f1bdbd32e65addf599d0751c6f`. The others are the
[business-process inventory](business-process-inventory-2026-11-06.md), the
[cross-domain consistency matrix](cross-domain-consistency-2026-11-06.md) and
the [remaining business decisions](business-decisions-2026-11-06.md).

Every long-lived object in MySenam (a booking, a payment, a pass, a message, a
venue) is a small state machine, and most business defects the audit found are
a transition that is missing, a state with no way out, or a failure halfway
through a change with nothing to pick it up. This record lists, for each
machine, what the code allows, what it does not, where something can be
stranded, and who or what recovers it. It reads the schema and the code at the
baseline commit; where a machine was not traced end to end by any auditor, it
says so. It is a dated record: it does not say what has been fixed since.

Findings are cited by the auditors' identifiers; `B1=E9=H3` is one defect found
by three auditors
([equivalences](cross-domain-consistency-2026-11-06.md#the-same-defect-found-more-than-once)).
Machines were read by auditor H (cross-module sequences, raced on Postgres) and
by the auditor of the area; the coverage of each workflow is in the
[inventory](business-process-inventory-2026-11-06.md). No real provider was
called and no browser was used.

How to read each machine:

- **States** are the values the code keeps (a status column, a timestamp, a
  ledger row).
- **Transitions that exist** are the ones the code performs.
- **Missing transitions** are changes a business would expect that nothing
  performs, or that happen without the checks a sibling path has.
- **No exit** names states a record can reach and never leave without a
  person or the database.

## The state machines

### Booking

- **States.** `status` confirmed or cancelled; `payment_status` unpaid or paid; `hold_until` (a hold to pay); released unpaid; late cancelled; no-show; check-in rows; `deposit_paid` and `shares_paid` (money received while still unpaid); concession check due, seen or refused.
- **Transitions that exist.** Confirmed to cancelled by the customer, the desk, a venue bulk cancel, the hold sweep, erasure and a class cancel. Unpaid to paid by the gateway, the counter, a pass, credit, a company invoice, a series payment, or a deposit that completes. Paid to unpaid for counter-paid bookings only. A hold set shortly after the booking commits and cleared by payment. Price changes by reschedule, promo, concession and manager adjustment.
- **Missing transitions.** Cancelled back to confirmed (H12). A *played* state: a finished booking stays confirmed, so every bulk cancel needs its own filter and two lack it (B2, B5=E8). A partly paid state: a deposit leaves the booking `unpaid` with money received, and the price can fall below it (C1=H1) while the report ignores it (C8=G4). A hold and a confirmation written in the same transaction as the booking (B10=C16). A check that credit or pass payment is taken only from a confirmed booking (B3). Cancellation after the door code was shown (E18).
- **No exit.** Cancelled (by design). A confirmed unpaid booking with no hold at a venue without pay-to-hold stands until the day, held back only by the unpaid brake, which counts the typed number only (B8). After a crash between creation and hold, the same state at a venue that does hold (B10=C16).
- **Findings.** B3, B8, B10=C16, B2, B5=E8, C1=H1, C8=G4, E18, H12.

### Concession check

- **States.** Due, seen, refused (a refused one adds the concession back to the price, as a counter sale if the booking is paid).
- **Transitions that exist.** Due to seen; due to refused.
- **Missing transitions.** The outcome decided once, under the booking's lock: two double-clicks on "no proof shown" charge the concession back twice (RM30 for a RM20 booking, two receipts), and a booking marked seen can be flipped to refused later (D2).
- **No exit.** Refused (a manager voids the counter sale and adjusts the price by hand).
- **Findings.** D2.

### Online payment and refund

- **States.** A payment pending or paid; `refund_due` and `refunded`; refund claims (claimed, pending, made, failed, marked by hand); a counter refund owed or settled; wallet ledger rows; credit notes.
- **Transitions that exist.** Pending to paid by callback or return (one claim, one receipt, replayed safely); owed (`refund_due`) on cancel, late payment or withdrawal; claim to made; claim released on refusal; failed back to owed; stale claims asked again by the scheduler under the same key; a pending refund read back; a daily digest to staff.
- **Missing transitions.** `failed` or `expired` for booking pages, which stay pending (acceptable: only the 24-hour window ends their effect). A page closed when its booking is cancelled, so a customer can still pay a dead booking, owed back (by hand on Billplz). A payment revived into its booking where the slot is free (C18=H7). A counter-paid fee owed back on a tournament called off (C11=F4=H4). A message to the customer when the refund is made, fails or is late (G13). One computed refundable amount, so the credit note and the amount owed agree to the sen (C13). A comparison of the amount the gateway reports with the bill (C19, unverified). A refund of an overpayment when a deposit exceeds a price that fell (C1=H1).
- **No exit.** Booking pages pending for ever. A failed refund until staff act (deliberate: staff see it). A Billplz refund owed until staff mark it; the digest and the overdue list escalate, and the customer's bank details are not collected (DEC-24).
- **Findings.** C18=H7, C11=F4=H4, G13, C13, C19, C1=H1.

### Waiting-list offer (court slots and classes)

- **States.** Waiting, offered, claimed, expired, cancelled.
- **Transitions that exist.** Waiting to offered on a cancellation, an expiry or a refused claim; offered to claimed or expired; offered back to waiting when the venue is not open or the slot was taken; leave; passing on an unanswered offer to the next person in the queue.
- **Missing transitions.** Waiting to cancelled when a class or the time is called off (E12=H9, B1=E9=H3). A refusal to offer a closed day, a blocked or out-of-service time, or a class that has started (B1=E9=H3, B7=E5). An offer lifetime capped at the start (B7=E5). Offering the next person after a claim (B6) and several places at once (B6). A message when a place on the list ends (B13). Offering a freed class place from `cancelSeries` and from a released hold, which offer the slot instead (E6).
- **No exit.** A `waiting` entry on a cancelled or past class is listed on the customer's account until retention, 90 days later (E12=H9, B7=E5). An unanswered offer drops the person from the queue by design.
- **Findings.** B6, B7=E5, B13, E6, E12=H9, B1=E9=H3.

### Class session and enrolment

- **States.** A class `scheduled` or `cancelled`; an enrolment is a booking with a class; a term is bookings sharing a series code.
- **Transitions that exist.** Enrol, with the class row locked; cancel (refund, offer the next); a class called off, in one transaction with every enrolment refunded and told; term moves.
- **Missing transitions.** A *completed* class, so a class that already ran can be called off and refunded (B5=E8). The roster read under the class lock, so an enrolment racing the cancel stays confirmed in a cancelled class, unrefunded and untold (E1, Postgres). A hold on direct enrolment, though a waiting-list claim of the same place is held (B9=E10). Closing the class's waiting list and telling the instructor on a cancel or a change of instructor (E12=H9). A discount that follows the number of sessions kept (E15).
- **No exit.** An unpaid enrolment confirmed until the class starts (B9=E10). Enrolments left in a cancelled class (E1).
- **Findings.** B5=E8, E1, B9=E10, E12=H9, E15, E6.

### Membership

- **States.** Active or void, by date (expiry is by date only); suspensions open, dated, lifted or carried; family cover places used and left; next-term covers.
- **Transitions that exist.** Sell, with an overlap check; void (money back optional, owed back in the same transaction); extend; suspend and reactivate; carry a suspension into a renewal; renew; cover changes under the membership lock; flags for staff at members-only venues.
- **Missing transitions.** Un-void. An extension that refuses to overlap a later term, as the suspension extension does (D7). A pause of Stripe collection for an open-ended suspension, or a default extension (D12). A correction of holder, phone or account (D10). Benefits copied onto the term at sale (D6). A pro-rata void (D22).
- **No exit.** Void. A suspension "until reactivated" on a renewing plan that nobody reminds anyone of (D12).
- **Findings.** D7, D12, D10, D6, D22, D23.

### Pass

- **States.** Active or void, with dates and an entries ledger (spends settled and unsettled); a loyalty reward pass.
- **Transitions that exist.** Sell; spend on a booking; restore entries on cancel (customer, venue, place withdrawal, class cancel); void with or without the unused part handed back; expire by date; a free hour granted by the scheduler.
- **Missing transitions.** Extension, correction, transfer and reversal of an entry spend: no code writes them (D10). A restoration to a pass that can still be used, or a money credit (D1=H5). Void refusing or flagging while pass-paid bookings stand (D1=H5). A pass judged on the date played, as memberships are (D4). Restriction to off-peak, days or courts (D8).
- **No exit.** Void; and an expired or void pass that holds restored entries nobody can spend (D1=H5).
- **Findings.** D1=H5, D4, D8, D10, D18, G19.

### Tournament, entry and fixture

- **States.** Tournament open, closed, drawn, finished, cancelled; entry entered, waitlisted, withdrawn (re-entry is a new row); fixture scheduled, done, walkover, bye, retired.
- **Transitions that exist.** Open to closed by date or by hand; closed back to open; to drawn; to finished; to cancelled (online fees owed); waitlisted to entered on a withdrawal; results, walkovers and corrections with a preview and a state token; replacement from the waiting list.
- **Missing transitions.** The draw under the tournament's row lock and conditional on `open` or `closed`: two draws at once make two brackets, and a withdrawal can land inside a draw (F1; matches cannot be deleted). An implicit last day for entries and an alert for an undrawn event (F7). A payment deadline for a promoted entrant (F7). Counter fees owed back on a call-off or a pre-draw withdrawal (C11=F4=H4). A message to an entrant taken out, disqualified or forfeited by staff (F5). A notice, a warning and a postpone for drawn matches when a court or day is lost (F3). A player-reported walkover that does not stand by silence (F10).
- **No exit.** Withdrawn. A tournament that took entries and fees past its first day, which can then never be drawn or finished (F7). A corrupt bracket (F1).
- **Findings.** F1, F3, F5, F7, F10, C11=F4=H4, F12.

### Open-game seat

- **States.** Seat requested, accepted, declined, left, removed, invited, waitlisted, offered, expired; the game open, closed or cancelled; a no-show flag on the seat.
- **Transitions that exist.** As in `games.ts`: join, accept, decline, leave, remove, invite, waitlist and offer; the last place under the game row lock (raced, sound); a share owed back when a player leaves, is removed or the booking is cancelled or moved; a game with players is never moved behind their backs.
- **Missing transitions.** Clearing a no-show mark, and telling the player of one (F6). A cutoff on a leaver's share (F11).
- **No exit.** Declined, left, removed and expired are terminal (whether re-joining works was not checked by H). A no-show mark is removable only in the database (F6).
- **Findings.** F6, F11. Coverage: F traced it, H read it only.

### Ladder court-time hold

- **States.** Tentative (held until both players or a manager confirm, and lapsing at its confirm-by moment), confirmed, expired, released (the reason recorded, among them expired and lost); a temporary pause on new holds for a player whose own cancellations of real holds pass a limit.
- **Transitions that exist.** Made at an accepted challenge with a time; confirmed by both or a manager; moved new-time-first in one savepoint; extended; lapsed lazily by the claim and by the scheduler, with the players told once (`expiry_told_at`); lost to an outage with the players told (`tellLostHolds`, [ADR 0048](../architecture/decisions/0048-ladder-hold-limits-and-expiry.md)); live holds of one court cannot overlap, by a constraint.
- **Missing transitions.** None found. Auditor F read this machine and did not trace it; no finding was recorded. It is the machine against which the tournament and team-league fixtures are measured (F3).
- **No exit.** None found.

### Outbox message

- **States.** Queued, failed (with the next attempt time), sent, abandoned. A crash during a send shows as queued again after a 10-minute lease (at least once, by design).
- **Transitions that exist.** Claim by moving the next attempt on; send; retry with backoff of 1, 5, 30 and 120 minutes; abandon after five attempts; abandon for the daily cap; staff retry (per message, up to 8 a day).
- **Missing transitions.** A retry policy that waits out a provider outage, and "resend all failed" (G1). An account email that can be resent (G1). A check that a reminder still describes a confirmed booking at its date and time (G7). A consent check when a campaign is sent (G8). Suppression of messages to an erased person (G6). Urgent kinds that bypass the cap (G9). A credit spend idempotent per message (H11, G20). Isolation of the tick's preparatory steps so a failing one cannot stop the drain (G10). Retry of a message abandoned for no WhatsApp credit when a pack is bought (G20).
- **No exit.** Abandoned, until staff retry it one by one; account emails never.
- **Findings.** G1, G7, G8, G9, G10, H11, G20, G6.

### Scheduler jobs

- **States.** A lease row in `settings` (taken, renewed by a timer, expiring); each job derives its work from data rather than from a stored cursor; no per-job last-run state.
- **Transitions that exist.** Lease take, renew, and takeover on expiry; each job in its own `try`, with an alert on failure; invoices idempotent by `(venue, period)`; holds and offers re-derived each tick; refund claims re-asked; e-invoice submission claimed.
- **Missing transitions.** Per-job last-run state, so a job failing every tick shows only as repeated alerts (H). Work stopped when lease renewal fails, so two instances can overlap (G18, G19). A separate lease or interval for the backup and off-site upload (G18). An idempotent loyalty grant (G19). Per-venue isolation and a catch-up for e-invoicing (G15). Per-business isolation in the retention run (A1=H2).
- **No exit.** None; a failing job is retried every tick, which is the problem for A1=H2.
- **Findings.** G18, G19, G10, G15, A1=H2.

| Job | If interrupted | If run twice | Findings |
| --- | -------------- | ------------ | -------- |
| Refund claims, reconciliation, digest | Re-asked under the same key; sound | One refund (claim, key, `ON CONFLICT`); sound | G13 (customer not told) |
| Hold release | Re-derived each tick | One release (single `UPDATE`, one transaction); sound | B10=C16, C18=H7 |
| Platform invoices | Re-derived; sound | One invoice per venue and month (`ON CONFLICT`); sound | G14 (never sent), A6=G12 |
| Payment holds and warnings | `warned_at` is stamped before telling, so a crash loses the warning for good | Heals at the next run | G14, A7 |
| Company account invoices (early in the month) | Not reviewed: C traced the account's invoices and credits, not the job | Not reviewed | C5, C6, C7 |
| Loyalty grant | A stop between issuing the pass and recording it | A second free hour (two passes for five hours played) | G19 |
| Retention (once a day) | Rolled back as one transaction | Fails again for the same draft, daily | A1=H2, A15, G6, G20 |
| Outbox tick | Prep steps unguarded, so one failing step stops all draining | Claimed per message (10-minute lease); no duplicate send | G10, G1, G7, G8, G9 |
| E-invoicing | One venue's error stops the loop for every venue; consolidation only on days 1 to 7 | Claimed; sound | G15 |
| Webhooks | Exhausted events never redelivered | Claimed before send | G17 |
| Backup and off-site copy | A long tick delays the outbox, refunds and hold release | Not reviewed (no restore was run) | G18 |

### Venue lifecycle

- **States.** Draft, application pending, live, suspended (by the owner or for payment); a business may be suspended too.
- **Transitions that exist.** Draft to pending to live (an auto-approved branch where enabled); live to suspended and back (a payment hold heals itself when the invoices are paid; the owner's is lifted only by the owner); a stale draft deleted by the retention run.
- **Missing transitions.** Live to draft, to closed, or to archived, and any offboarding of customers' credit, passes and memberships (A5=H8). A grace date on an overdue invoice, and a message that is true when the owner tries to lift a payment hold (A7). A customer-facing state and notice for a suspended venue (A4). A draft purge that cannot block retention (A1=H2) and does not delete counter receipts of real money (A15). An auto-approved branch that counts only open siblings (A11).
- **No exit.** Suspended for ever, with customers' credit, passes and memberships unusable and unable to be erased (A5=H8, A4).
- **Findings.** A1=H2, A4, A5=H8, A7, A11, A15.

### Platform invoice and payment hold

- **States.** Invoice due, paid, void; paid after a void goes to owed back; hold derived from invoices, so it cannot drift.
- **Transitions that exist.** Issue, mark paid, void, pay online, warn, hold, lift.
- **Missing transitions.** Sending the invoice on issue (G14). Extending the due date, with a reason (A7). A logged actor and reason for marking paid, voiding and setting fees (A6=G12).
- **No exit.** None; the owner can always mark paid or void, which falsifies or forgives (A7).
- **Findings.** A6=G12, A7, G14.

### Company invoice and credit

- **States.** Booking uninvoiced, invoiced, paid; invoice withdrawn; credit waiting, applied or settled.
- **Transitions that exist.** Issue, mark paid, withdraw (refused after a cancellation credit; withdrawing restores waiting credits), credit on cancellation or place withdrawal, apply credit whole and oldest first.
- **Missing transitions.** Lines fixed at issue (an issued invoice drifts when a booking on it is rescheduled, C5). Partial allocation of credit and part payment (C6). Overdue handling (C7).
- **No exit.** Credit larger than the next invoice, or stuck behind a larger one, waits until settled by hand; credit of an account that never books again waits likewise (a manual "paid back by hand" exists).
- **Findings.** C5, C6, C7.

### E-invoice (MyInvois)

- **States.** Pending, submitted, valid, invalid, failed (not sent, or sent with the outcome unknown), rejected, cancelled.
- **Transitions that exist.** Consolidate into pending; claim and submit; check to valid or invalid; an outcome unknown is shown as needing verification, reconciled against LHDN first and never resent blindly; failed back to pending by staff; a refused document replaced, never resent.
- **Missing transitions.** An automatic retry of a transient failure with an alert, and an alert when a month's consolidated e-invoice is not valid by day 5 (G15). Consolidation catching up outside days 1 to 7 (G15). Per-venue isolation of a failing venue (G15). A consolidation that follows the journal's revenue flag (C2).
- **No exit.** `failed` (not sent), silently, until staff send it. Invalid, rejected and cancelled are final by design.
- **Findings.** C2, G15.

### Hire record

- **States.** No record, open (kit out), returned; kept deposit sold as a sale; returned as lost.
- **Transitions that exist.** Take (also checks in), return with condition and deductions, kept amount receipted; an open hire blocks cancel and move.
- **Missing transitions.** A method recorded when kit goes out, a cash-up line for deposits held and returned, a refusal to return with an amount kept and no stated method (C10=E13=H10). A bulk cancel that names a booking it skipped for kit out (E14).
- **No exit.** An open hire blocks cancelling or moving until it is returned, if need be as lost.
- **Findings.** C10=E13=H10, E14.

### Staff invitation and account

- **States.** Invitation open, accepted, withdrawn, expired (7 days); accounts active or removed; sessions; 2FA tickets.
- **Transitions that exist.** Invite, resend, withdraw, accept, correct, change role, remove (ending sessions and OAuth grants), an address change that invites the new address and tells the old.
- **Missing transitions.** An invitation link that is never readable through a staff-facing list while unsent or failed (A3). Offering revocation of API keys and webhook secrets when a manager is removed (A13). Counting 2FA ticket attempts before the check (A14). A business id on business-level staff changes (A8).
- **No exit.** Removed.
- **Findings.** A3, A8, A13, A14.

### Message report, suspension and appeal

- **States.** A report open or reviewed (outcome); a suspension manual (venue-scoped) or automatic (`venue_id` empty, platform-wide), in force or lifted; for youth threads, an urgent report, escalation, a protective restriction with a review date, an appeal.
- **Transitions that exist.** Report; review; suspend; lift (by the venue for its own); automatic suspension at three counted reports in 30 days; for youth: staff emailed, escalation to the owner, a restriction told to the owners past its review date and never lifted by the system, an appeal, a conflicted staff login unable to see its own case.
- **Missing transitions.** For adults: the owner reading the reports behind an automatic suspension; re-evaluating it when a contributing report is dismissed; an owner notice and a review date; an appeal (F2). An alert, an age, a ranking of "unsafe", an escalation and a reporter notice for adult-thread reports (F8).
- **No exit.** An automatic suspension that stays in force after all three reports were found to need no action (F2). A report unseen where a venue has no manager (accepted, [known limitations](../roadmap/known-limitations.md)).
- **Findings.** F2, F8.

### Retention run

- **States.** Not due, run, failed.
- **Transitions that exist.** One transaction wraps every rule, including the stale-draft purge; success stamps the run; failure stamps nothing and is retried every tick with an alert.
- **Missing transitions.** A per-business savepoint that skips and reports a draft that cannot be deleted (A1=H2). A guard around the call in `/api/admin/auth/me`, which runs it on every dashboard load (A1=H2). A catalogue-driven test that fails when a new foreign key to `venues` or `courts` is neither deleted nor listed (A1=H2). Exclusion of receipts and counter money from a draft's deletion (A15). Erasure of payer details, queued messages and webhook payloads (G6).
- **No exit.** A daily failure with no automatic fix, and a dashboard that answers 500 for every staff account (A1=H2).
- **Findings.** A1=H2, A15, G6, G20.

## Failure-recovery rows

What can strand something, who or what recovers it today, and the gap. "None"
means no person is shown the stranded thing and no job finds it.

### Booking, payment and money

| Process | What can strand | Recovery today | Gap | Findings |
| ------- | --------------- | -------------- | --- | -------- |
| Booking form request | The request dies after the booking commits and before the hold, discounts, payment or confirmation | None until staff notice an unpaid, unheld booking; the customer retries and may be refused by their own slot | No sweep for unheld unpaid online bookings at a hold venue, nor for a confirmed booking with no confirmation | B10=C16, G11 |
| Pay from credit or a pass | Cancelled between the status read and the debit | None: staff must spot "paid and cancelled" | Credit or entries taken silently | B3 |
| Hold lapses, then payment lands | The payment arrives on a released booking | Owed back; the return page says so; hand refund on Billplz | No revival where the slot is free | C18=H7 |
| Move or promo below a deposit | Deposit above the new price | None; the counter marks it paid | The excess is not owed back | C1=H1 |
| A booking moved to a cheaper time while paid | The difference | A manager credits by hand | Not offered or said | B16=C12=D15 |
| Staff cancel a booking by mistake | The booking, the court, the credit note, the offer sent | A new booking and a new payment; the customer has a cancellation email | No reinstate | H12 |
| Cancellation message | A crash after the refund is written | The customer sees the state on `/my-booking`; the refund pipeline re-runs | The "refund due by" message is lost | C17, G11 |
| Concession "no proof shown" | A double-click or `seen` then `refused` | Staff void a counter sale or adjust the price | Decided outside the booking's lock | D2 |
| Gateway refund | The answer is lost after the gateway acted | Claim re-asked under the same key; sound | None | none (sound) |
| Refund by hand (Billplz) | The venue never acts | The dashboard, the digest, the overdue list, the workload report | The customer is told only on the return page; no bank-details channel | G13, DEC-24 |
| Counter-paid fee, tournament called off | No obligation exists | Staff unmark each entry if they remember | An invisible liability | C11=F4=H4 |
| Hire deposit | Cash held and handed back, never in the cash-up | The open-hire list | No age alert, no ledger | C10=E13=H10 |
| Company invoice | Credit larger than the next invoice; a booking moved after issue | The manager's "paid back by hand" for credit; nothing for drift | Stranded credit; no snapshot | C5, C6 |
| Company account arrears | Booking continues on credit | A staff list filter | No reminder, no block | C7 |
| Consolidated e-invoice | Includes prepaid credit as well as the bookings it paid | Replace or credit note afterwards | Reported twice | C2 |
| Pass voided with refund, then a booking it paid is cancelled | The entry's value | None | Value lost | D1=H5 |
| Restoration to an expired pass | Entries nobody can spend | None | Value lost | D1=H5 |

### Closures, classes and waiting lists

| Process | What can strand | Recovery today | Gap | Findings |
| ------- | --------------- | -------------- | --- | -------- |
| Close a day, rain-out | An error or crash after some cancels; a booking landing before the closure row; a waiter offered the closing day | Staff repeat the closure (the route lists what remains) | No recheck, no atomicity, offers on a closed day | B1=E9=H3 |
| Outage | A played booking, kit out, or a live offer after others were cancelled and refunded | Staff retry later (an offer lives 30 minutes; a played booking never goes) | The court never goes out of service; a misleading "try again" | B2, B1=E9=H3 |
| Booking with kit still out | A bulk cancel skips it silently | The desk takes the kit back, then cancels by hand | The skipped booking is not named | E14 |
| Class called off | An enrolment racing the cancel | None: it sits in a cancelled class, listed nowhere | Not refunded, told or listed | E1 |
| Class closed after it ran | Refunds and "cancelled" notices for service delivered | None | Money paid out for a class delivered | B5=E8 |
| Class waiting list | A place never re-offered; an entry for a cancelled or started class stays `waiting` | Another cancellation; retention after 90 days | Dead lists; empty places | B7=E5, E6, E12=H9 |
| Waiting-list offer lapses | The person leaves the queue untold | Rejoin by hand | A silent lapse | B13 |
| A claim leaves another slot free | The slot is never offered | The next unrelated cancellation | Unsold utilisation | B6 |
| Unpaid class enrolment | Held until the class | Staff cancel by hand; strikes | A phantom place | B9=E10 |
| Series across a dated hours change | Weeks outside the hours | None recorded; staff must find and cancel | The promised guard covers only existing bookings | B4 |
| Self check-in | A recorded strike is cleared; a class cannot be moved | The manager cancels the class | A remote tap overrides the desk | E7 |
| Competition fixtures on a lost court or day | Matches on a dead court | The manager moves each by hand, if they find out | Nobody is warned or told | F3 |

### Customers, safety and venue operations

| Process | What can strand | Recovery today | Gap | Findings |
| ------- | --------------- | -------------- | --- | -------- |
| A blocked number | A confirmed booking, a door code, QR check-in | None | The door still opens | E2 |
| A sign-off or induction taken back | Future bookings stay confirmed; the customer is untold; the desk has no signal | The door refuses at night; nothing for staffed hours | Flags exist only for the approval path | E4 |
| Unstaffed slot sold with no induction | The customer discovers it at the door, paid | None | No check at booking | E3 |
| Coach on leave, hours shortened, retired | Lessons stand with no coach; nobody told | Staff notice from the log or a call | No worklist, no notice, no bulk fix | E11 |
| Class instructor cancelled or replaced | The coach is not told | None | A coach arrives at a cancelled class | E12=H9 |
| Strike recorded | The customer is unaware and later struck out | A manager forgives | No notice; the number is shared | D11, D13 |
| Counter sale with a wrong phone | The customer cannot benefit; a stranger might | A manager voids with refund and resells | No correction | D10 |
| Gym entry spent on the wrong person or pass | The entry | None | No reversal | D10 |
| Membership extended into a later term | Two live terms | Manual void and resell | An arbitrary tier prices the overlap | D7 |
| Open-ended suspension of a renewing membership | Charged each period for nothing | The manager reactivates; nobody reminds them | Chargeback exposure | D12 |
| Tier edited | Terms already paid change | None | No snapshot | D6 |
| Review invitation | A link that the review page refuses | None | One invitation, spent | D5 |
| Online pass or membership paid late or buying nothing | Money | The *Refunds owed* list (by hand on Billplz) | Outside the audit's scope for the gateway | none recorded |

### Platform, communications, competitions and scheduler

| Process | What can strand | Recovery today | Gap | Findings |
| ------- | --------------- | -------------- | --- | -------- |
| Retention run | One undeletable stale draft fails the whole transaction daily | An alert each tick; nobody can fix it but a developer or by SQL | No skip; dashboards answer 500 | A1=H2 |
| Draft deletion | Counter money taken on test bookings; receipts deleted with the venue | None | Contradicts "a receipt is never deleted" | A15 |
| Overdue hold | A venue held indefinitely; customers' passes and credit unusable | Pay, or the owner marks paid or voids | No grace, no customer notice, a false "not suspended" | A7, A4 |
| Owner suspension | Customer holds, renewals, credit, passes | Customers cancel their bookings; nothing else | No customer notice; nothing pauses validity | A4 |
| Venue closure for good | Memberships, passes, credit, tournaments, owed refunds, invoices | Manual per item by staff who may have left | No closing flow | A5=H8 |
| Staff invitation | The link is visible to the desk while unsent or failed | Withdraw and resend after the fact | Desk to manager escalation | A3 |
| Business manager removed | A co-manager cannot see who or when | The platform owner's log | Not visible to co-managers | A8 |
| Outbox message | The fifth failure after about 2.6 hours | `retryMessage` per id by staff | No bulk resend; account emails never | G1 |
| Booking confirmation, venue cancellation | A stop between the commit and the message | Refunds recover; the message does not | No sweep | G11 |
| Refund made or failed | The customer is not told | A digest to staff after a day | The customer is untold until they ask | G13 |
| Platform invoice | Issued and not sent; `warned_at` stamped before telling | The owner marks paid or voids, unlogged | The venue is never billed in writing; no actor recorded | G14, A6=G12 |
| E-invoice | MyInvois down on days 1 to 7; a failing venue ahead in the loop; `failed` never retried | Staff "Send" per document | Silent, no automatic retry | G15 |
| Webhook delivery | An endpoint down for more than about 2 hours | None: no replay | Exhausted events are never redelivered | G17 |
| Campaign | An unsubscribe after queueing; a long list ahead of confirmations | None | Consent not rechecked; confirmations queue behind it | G8 |
| Reminder | Sent for a cancelled booking; none for the new time | None | A reminder for a booking that no longer stands as it was | G7 |
| Loyalty reward | Two runs, or a stop between pass and record | None | A second free hour | G19 |
| WhatsApp credit | A crash after the spend | Retried in 10 minutes | Spent twice | H11, G20 |
| Backup | A long tick | Alerts `backup`, `offsite`, `backup-stale` | Delay only | G18 |
| Erasure | The person stays in payer fields, messages, webhook payloads | Retention at 90 or 30 days; never for payer fields | The person stays in payer fields, messages for 90 days, webhook payloads for 30 | G6 |
| Tournament lifecycle | The start date passes while open or closed | The manager must notice and cancel | No alert, no auto-stop, fees held | F7 |
| Draw | A concurrent second draw; a withdrawal inside the draw | None: matches cannot be deleted | No lock on the draw | F1 |
| Staff-removed entrant | Withdrawn, not told | None | No notice, no reason, no way to answer | F5 |
| No-show mark on an open game | A wrong mark | The database only | No notice and no clear | F6 |
| Automatic message suspension | Reports dismissed; the owner cannot see them | The owner lifts blind; the person cannot ask | The promised review cannot be done; no appeal | F2 |
| Adult message report | Open, no alert, no escalation | The manager opens a panel | No alert, age or escalation | F8 |
| Player-reported walkover | A silent opponent | Staff correct it after the fact | Stands by silence after 24 hours | F10 |
| Box-league removal | A paid fee | None | No refund trail | F12 |
| Ladder ignored challenge | A player who never saw the email forfeits | A manager's correction, if the player knows to ask | One email, no reminder, no way for the player to contest | F9 |

## States with no exit

Collected from the machines above: places where a record can arrive and nothing
in the product moves it on.

| State | Where it comes from | What leaves it today | Findings |
| ----- | ------------------- | -------------------- | -------- |
| Abandoned message | Five failed sends, the daily cap, an expired token | Staff, per message; never for account emails | G1, G9 |
| `failed` (not sent) e-invoice | MyInvois refusing sign-in or answering 503 | Staff "Send" per document | G15 |
| Suspended for ever | An owner suspension or a payment hold on a venue nobody pays or lifts | The owner; and the venue's customers have no way out | A5=H8, A7 |
| `waiting` on a cancelled or past class | Cancelling a class or a place offered after the start | Retention, 90 days | E12=H9, B7=E5 |
| Enrolment in a cancelled class | An enrolment racing the cancel | Nothing lists it | E1 |
| Entries on a void or expired pass | A cancel after the pass lost its validity | Nothing | D1=H5 |
| Strike on a number | An open-game no-show mark | The database | F6 |
| Automatic message suspension in force | Three reports, then all dismissed | The owner, blind | F2 |
| Booking pages `pending` | A page paid or abandoned after the booking changed | The 24-hour window ends their effect | acceptable (H) |
| Undrawn tournament past its first day | No entries-close date | A manager's cancel | F7 |
| A corrupt bracket | Two draws, or a withdrawal inside a draw | Nothing (matches cannot be deleted) | F1 |
| Credit behind a larger credit | A company credit note that does not fit the next invoice | The manager's "paid back by hand" | C6 |
| Cancelled booking | Any cancel | Nothing: a new booking is the only route | H12 |
| Unpaid, unheld confirmed booking | A crash after creation, or no pay-to-hold | Staff by hand | B10=C16, B8 |
| Open-ended suspension on a renewing plan | A manager who forgot | The manager reactivates | D12 |
