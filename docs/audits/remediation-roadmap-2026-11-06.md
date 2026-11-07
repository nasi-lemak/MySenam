# Remediation roadmap, 6 November 2026

What is left to do after the fix round of the business-process audit of MySenam
at commit `2aabdd406626c9f1bdbd32e65addf599d0751c6f`, ordered by when it
matters: before a controlled pilot, before general availability, and for the
venue types, sports and markets that come later. It is built from the
[findings register](findings-register-2026-11-06.md)
([E to H](findings-register-2026-11-06-e-to-h.md)) and the
[business decisions](business-decisions-2026-11-06.md), and it ends with an
honest view of whether a pilot can start and on what conditions.

This is an audit record, not the project's plan. **Nothing here is a
requirement until the owner decides it and it is written where it applies**
([documentation rules](../development/documentation.md)): accepted work belongs in
the [roadmap](../roadmap/roadmap.md), what is wrong now in
[known limitations](../roadmap/known-limitations.md). The two documents carry the
open items from this audit (the roadmap has rows for the deferred and proposed
ones, known limitations a section listing every open item). Where this page says
"before the pilot" it is the audit's recommendation.

Of 140 findings, 77 are fixed, 10 are partly fixed, 20 wait for a decision of
the owner, an adviser or a lawyer, and 33 are open
([totals](findings-register-2026-11-06.md#totals)). No P0 was found. The one P1
not closed is C2, a tax question. The fix round also left a list of narrower
items its workers noticed, which are counted with the finding they belong to.
The fixes were verified by new tests on PGlite and Postgres run by the fix
workers; the lead's full validation of the integration branch is recorded in
[testing](../development/testing.md#release-records). None of it is a check
against a real provider.

Sizes are the auditors': S is a small change, M a day or more with tests, L a
workflow. "Migration" means the change needs a new migration.

## A. First-launch (controlled pilot) blockers still open

The audit found no P0 or P1 that is open for want of code. What stands between
the code and a first real customer is, first, the launch blockers
[known limitations](../roadmap/known-limitations.md#what-the-launch-depends-on) already
lists and that this audit did not change: email and off-site backups never run
against a real service, `/terms` and `/privacy` unreviewed, the breach-notification rules
unconfirmed, the four languages unreviewed by native speakers, the operating
company undecided. Second, these items from the audit, each either to be done or
accepted in writing by the owner before the first customer:

| Item | Findings | Why it matters in a pilot | What to do | Size, gate |
| ---- | -------- | ------------------------- | ---------- | ---------- |
| Owner and manager sign-in is a password alone unless configured | A10 | The owner account approves venues, gives invoices time, suspends and sees the platform's money; the owner's decisions are now logged (A6) but not prevented | Set `MYSENAM_STAFF_2FA=owners` (or `managers`) before the first venue; a configuration, not code. Whether to make it the default is DEC-05 | Configuration; DEC-05 |
| The consolidated e-invoice may over-report prepaid credit | C2 | If a pilot venue e-invoices, every stored-credit ringgit spent is reported twice (RM130 for RM30 of sales) | Do not switch e-invoicing on for a venue that sells stored credit or vouchers until the adviser has answered DEC-19; or exclude non-revenue rows once answered | S to M; DEC-19, adviser |
| No way for a venue to leave | A5, H8 | A pilot venue that stops trading strands customers' credit, passes, memberships and fees; the owner can only suspend, which also stops customers using what they hold | Say so in the pilot agreement; keep what customers can hold at a pilot venue small (see F); the owner reads the venue's liabilities in the report before agreeing to anything. The workflow is a general-availability item (B) | L, migration; DEC-03 |
| Every Billplz refund is by hand, and a late payment is refunded by hand even when the slot is free | C18 = H7, C19, G13, O5 of the decisions | Customers wait for a person; the amount Billplz reports is unchecked against the bill | Pass the Billplz sandbox check (including `paid_amount`, C19) first; name one person who clears *Refunds owed* daily; DEC-14 and DEC-24 | M; DEC-14, DEC-24 |
| WhatsApp offer template changed | B13 | `mysenam_waitlist_offer` gained a parameter (the offer's minutes) and must be resubmitted to Meta; until it is approved the WhatsApp offer is not live-verified | Resubmit, or run the pilot on email only. The lapse notice (`waitlist_ended`) and refund notices are email only whatever is chosen | Owner action |
| Policies edited while customers hold the old ones | B12, D6, B14 | Cancellation terms and tier benefits are read live; hours edits check then write | Freeze the cancellation cutoff, late share and tier benefits for the pilot; change hours only with no bookings in the way | Operating rule; DEC-09, DEC-34 |
| The scheduler is now doing real work | Fix round | Stranded-booking holds, owed notices, e-invoice retry, renewal pauses, retention and the draft purge all run on it | The scheduler's heartbeat and alert address must be live before any venue is told it can rely on the new behaviour ([monitoring](../operations/monitoring.md)) | Configuration |

The other P2 and P3 items that remain open do not block a pilot with the
restrictions in [F](#f-controlled-pilot-recommendation), because each either
costs a venue manual work it can be told about or affects a feature the pilot
leaves off.

## B. Required before general availability

Open work, grouped. Every row names its findings; "decision" means the answer is
the owner's (the question is a `DEC-nn`), so building before it is decided would
choose silently.

### Money and customers' standing

| Item | Findings | What is missing | Size, gate |
| ---- | -------- | --------------- | ---------- |
| Paid booking moved to a cheaper time | B16, C12, D15 | The customer keeps paying the old price with no warning; credit the difference or say so first | S to M; DEC-16 |
| Late cancel of a pass-paid booking | C14, D14, H6 | Whole entries rounded down; the screen states a sum that was not the loss | S; DEC-30 |
| A payment that lands after the hold lapsed | C18, H7 | Refunded by hand even when the slot is free | M; DEC-14 |
| A discount when an unpaid booking moves | D3 | Can make an hour free by a self-service move | M; DEC-33 |
| Cancellation terms shown at booking | B12 | Not snapshotted; a policy edit changes what existing customers lose | M, migration; DEC-09 |
| Tier edits under paid members | D6 | A paid term's benefits can be edited downward | M, migration; DEC-34 |
| Passes limited to off-peak, days, courts; fees on pass-paid bookings | D8, D9 | The common off-peak pass cannot be sold; the setup fee is waived | M, migration; DEC-31, DEC-32 |
| Last-minute price on a move | B11 | A moved booking loses the discount a fresh one would get | S; no `DEC` written (the status file calls it a decision) |
| Phone number as standing | D13 | Recycled and shared numbers carry strikes | M; DEC-39 |
| Correcting a pass or membership | D10 | Holder phone, account link and entries cannot be corrected (a manager can only extend a pass) | M, migration |
| Gift voucher expiry and desk redemption | C15, D21 | Expiry is a legal question; a printed voucher cannot be used at the desk | M; DEC-23, lawyer |
| Membership void by days left; term end on the 31st | D22, D23 | All-or-nothing refund; documentation and code disagree on the end date | M; DEC-36, DEC-37 |
| Unpaid class places | B9, E10 | Pay-to-hold does not apply to online class enrolments | M; DEC-11 |
| Undoing a staff cancellation | H12 | A mistaken cancel has no way back | M; DEC-15 |
| Half-sen rounding | C13 | A credit note and the refund can differ by 1 sen | S to M |
| Small report and document defects | D16, D17, D18, D19, D24 | A credit note on a pass-paid booking, "spent" counting unpaid, pass order, a tier above the member rate, notes overwritten | S each |

### Venue lifecycle, platform and privacy

| Item | Findings | What is missing | Size, gate |
| ---- | -------- | --------------- | ---------- |
| Closing a venue for good | A5, H8 | The exit workflow, a closed state, billing stopped at closure, a customer-visible state that releases the erasure block | L, migration; DEC-03 |
| Pass and membership validity across a suspension | A4 | Validity is not paused or extended for the time a venue was off; no "renewal paused" marker; no "venue is back" email | M; DEC-02 |
| Customer notices for expiry, renewal, strikes, low balance | D11, G16 | Nothing is sent before a pass, voucher or membership lapses or when a strike is recorded | M; DEC-38 |
| Draft purge keeps counter receipts | A15 | A draft's receipts and owed-back rows can still be deleted with it | S |
| API keys outlive the manager who could read them; ticket attempts counted after the check | A13, A14 | No offer to revoke on removal; attempt cap soft under parallel requests | S each |
| Activity log retention; guest booking by email; phone code cap | G20 | The log is kept two years while receipts are kept seven; an email-matched guest booking can be cancelled by a stranger's account; a number's daily code allowance can be burned by anyone | S each; DEC-58, DEC-59 |
| Residual enumeration and retention | A2, G6, A8 | The email-existence oracle in linking flows (throttled); staff-alert messages naming a customer keep the name for 90 days; business-level log entries before migration 0301 have no business | S to M |
| Webhook replay, scheduler isolation, loyalty idempotency | G17, G18, G19 | Exhausted events are never redelivered; a long backup pauses the outbox; the free hour can be granted twice | S to M each; G19 needs a migration |
| Venue API sees a lapsed hold for up to a minute | B15 | `v1/availability` and `v1/bookings` do not release lapsed holds | S |

### Reservations, classes, coaching and safety

| Item | Findings | What is missing | Size, gate |
| ---- | -------- | --------------- | ---------- |
| Waiting entries on a closed day; offers withdrawn by a closure | B1 | Left waiting silently, not dropped and told; offers withdrawn are not told; `class-moves.ts` does not re-ask the closure check in its transaction | S to M; DEC-13 |
| Class queues offer one place at a time | B6 | Several freed places go one after the other | S |
| Overnight pause or extension of an offer | B13 | An offer lapses at night; no pause was built | S; DEC-10 |
| The booking's hold inside its own transaction | B10 | Only the scheduler sweep exists; a lost confirmation is the owed-notice sweep's | M |
| Coach absence | E11 | No lesson worklist, no bulk reassign, packs tied to one coach | M; DEC-46 |
| Coach alerts and payouts; hire enquiries; term discount | E15, E16, E17 | Late alerts; "went ahead" for future lessons; no nudge on enquiries; the term discount kept for one session | S each; DEC-43 |
| Door and cancellation after arrival | E18 | A customer can reveal the code, cancel and still use the court where the cutoff is under an hour | S; DEC-45 |
| Safety follow-ups | E3, E4, E2 | A certification that expires is not warned; moving a booking into an unstaffed slot does not re-ask the sign-off; the induction note is not in the confirmation email; the desk can still check in a refused number | S to M each; DEC-40, DEC-41, DEC-42 |
| Instructor pay for classes | E19 | Not built; a roadmap row exists | Proposed |
| Hours edits against concurrent bookings | B14 | Check then write | S |

### Competitions, matchmaking and messaging

| Item | Findings | What is missing | Size, gate |
| ---- | -------- | --------------- | ---------- |
| A host's no-show mark | F6 | Silent, irreversible, platform-wide | S to M; DEC-50 |
| Leaving a game late | F11 | Full refund of the share whatever the venue's cutoff | M; DEC-51 |
| Walkovers that stand by silence | F10 | Still stands after 24 hours; the audit's default was not taken | S; DEC-52 |
| Reports in adult threads | F8 | A manager cannot escalate to the owner; the reporter is not told the outcome | M; DEC-48 |
| League fees on a staff removal or a league closed mid-season | F12 | No refund trail | DEC-18 |
| Minors' names on a tournament's main page | F13 | The known-limitations text and the code disagree; the unknown-age case shows the full name | S; DEC-54 |
| Competition notices on one channel | F14 | Email only, none by WhatsApp for time-critical messages | Waits on WhatsApp verification |
| Postponing a team-league night; fee refunds in the till's payout list | F3, C11 | The postponement is not atomic; a refunded fee is not on the payout list | S to M |
| Three accounts can suspend a person platform-wide | F2 | Accepted; the review path now exists | Accepted |

### Company accounts, tax and reports

| Item | Findings | What is missing | Size, gate |
| ---- | -------- | --------------- | ---------- |
| Dearer reschedule of an invoiced booking | C5 | Reported, not billed: a debit line on the next invoice needs its own receipt in the journal | M; owner decision |
| Part payments on company invoices | C6 | Reach the journal only as whole bookings are covered; the customer's invoice page does not show them | M |
| Counter-sold pass or membership void | D1, C11 | The refund value is a credit note and a log line, not a task on a cash list | S to M |
| Hire deposits taken before migration 0308 | C10 | Show "not recorded" and need the method said to keep an amount | Operating rule |
| What the books call these liabilities | C9, G16 | The liabilities block is provisional (voucher expiry, pass value estimate); whether held deposits are a liability is the adviser's | Adviser |
| Late consolidated e-invoice; prepaid credit | C2, G15 | LHDN's timing after day 7 is unverified; DEC-19 | Adviser |

## C. Needed for later venue types, sports and markets

The audit looked at a Malaysian install in marketplace mode, with the Singapore
differences read, not exercised ([limits](business-process-inventory-2026-11-06.md#limits-of-the-audit)).
What its open items mean for what comes next:

- **Singapore.** One install serves one country ([regions and tax](../product/regions-and-tax.md)), so a Singapore install is a second install with Stripe as its first-table integration. What the audit makes first: the Stripe checks (below), including the subscription pause for a suspended venue; the erasure and retention basis for payer details under the Singapore PDPA (G6's 730 days is an operational choice, not a legal one); the tax questions C2 and C15 under Singapore's rules; InvoiceNow is blocked on a provider agreement. DEC-19, DEC-23, DEC-57 and DEC-58 need the adviser of each country.
- **Multi-currency.** Nothing in the audit exercised it: an install is one country and one currency, and the reports, liabilities, credit and vouchers are in that currency. A group with venues in two countries is two installs: one country per install is a recorded, deliberate limit ([known limitations](../roadmap/known-limitations.md#deliberately-unsupported)). The audit raises no finding against that, and records it here so multi-currency is not assumed to work.
- **Staffed against unmanned venues.** The door, blocked number, induction at booking and self check-in rules are fixed (E2, E3, E7). Before a 24-hour or unmanned venue is added: a certification that expires must warn existing bookings (E4); moving a booking into an unstaffed slot must re-ask the sign-off (E3); the induction note must be in the confirmation email (E3); the desk must not check in a refused number (E2); a customer who revealed the code must not cancel for a refund (E18, DEC-45); and the desk's right to record an induction (A9) should be confirmed as intended.
- **Academies and coaching.** Coach absence has no workflow (E11), a pack works with one coach, class queues offer one place at a time (B6), unpaid class places are not held (B9, DEC-11), the term discount survives one session (E15), instructor pay is not built (E19), standing is by phone number, which families share (D13), and notices of expiry, strikes and low balance do not exist (D11). Youth messaging stays off in production until its legal review, a separate blocker ([known limitations](../roadmap/known-limitations.md#youth-messaging-pending-legal-verification)).
- **Hotels and resorts.** Their guests rarely have accounts, they use company or group accounts, equipment hire with deposits, vouchers and seasonal closures. The open items that bite: a guest booking can be found by an email match (G20, DEC-59); company accounts' part payments reach the journal late and a dearer move is reported, not billed (C5, C6); hire deposits are fixed in the till but earlier ones show "not recorded" (C10); vouchers cannot be redeemed at the desk and their expiry is undecided (D21, C15); closing a venue or a season for good is manual (A5); an offer lapses overnight (B13).
- **Many venues on one platform.** The scheduler runs everything in one tick (G18), exhausted webhooks are never redelivered (G17), the owner's console is a single account without default 2FA (A10), and a venue cannot leave (A5). None was measured at marketplace load by this audit.

## D. The owner decisions that gate each

Of the 59 decisions in the [business decisions](business-decisions-2026-11-06.md), the
fix round implemented the recommended default in 19, part of it in 13, and left 27 to
the owner ([status per decision](business-decisions-2026-11-06.md#status-after-the-fix-round)). The ones that
gate the work above:

| Gate | Decisions | What they unlock |
| ---- | --------- | ---------------- |
| Before the pilot (an answer or a written acceptance) | DEC-05 (owner two-factor default), DEC-19 (e-invoicing prepaid credit, adviser), DEC-03 (a stated stance on leaving, even if only "manual"), DEC-14 and DEC-24 (late payments and the Billplz refund route) | Setting the pilot's configuration and agreement; a venue that e-invoices; a venue that takes Billplz money |
| Before general availability | DEC-02, DEC-09, DEC-11, DEC-15, DEC-16, DEC-23 (lawyer), DEC-30, DEC-31, DEC-32, DEC-33, DEC-34, DEC-36, DEC-37, DEC-38, DEC-39, DEC-43, DEC-45, DEC-46, DEC-50, DEC-51, DEC-54, DEC-58, DEC-59 | Each lets its finding be fixed without choosing for the owner |
| Narrowing a fix already built | DEC-10 (overnight pause), DEC-13 (drop waiting entries on a closed day), DEC-18 (league fees), DEC-20 (a per-account overdue block), DEC-27 (a warning after the due date), DEC-29 (refuse voiding a pass with paid future bookings), DEC-35 (extend a dated suspension too), DEC-41 (refuse an induction at booking), DEC-48 (escalation, reporter notice), DEC-52 (walkovers never stand by silence), DEC-53 (the day before the start, a one-click cancel) | The built behaviour is in force; the decision would widen it |
| Needs an adviser or lawyer, not only the owner | DEC-19, DEC-23, DEC-57, DEC-58, and the 730-day payer period | Tax and consumer-law treatment; nothing in code settles them |

## E. Integrations that still need real-provider verification

Every row below is `INTEGRATION_VERIFICATION_REQUIRED` in
[feature status](../product/feature-status.md#integrations) and stays so until its
own check passes against the real service
([real-service verification](../roadmap/integration-workstream.md)). The fix round
added behaviour behind each of them that its tests exercise only against a stand-in.

| Provider | Existing feature-status rows | What the fix round added that only a real check can prove |
| -------- | ---------------------------- | --------------------------------------------------------- |
| Billplz | Billplz bill creation; Billplz callback verification | A deposit excess above a lowered price is owed back (ADR 0054) and, like every Billplz refund, is made by hand. Whether `paid_amount` can differ from the bill (C19). A bill that stays payable after its hold lapsed (C18). Billplz refunds and subscriptions are `UNSUPPORTED` |
| Stripe | Stripe Checkout; Stripe webhook and return verification; Stripe refunds; Stripe disputes; Stripe membership renewals | `pause_collection` with behaviour `void` for subscriptions of a suspended venue, and resuming (ADR 0063; the key needs *Subscriptions: write*; a refusal alerts the owner and is tried again). That a membership suspension does **not** pause collection and extends the end instead (ADR 0062). Gateway refunds for cancellations, owed-back deposits and pass voids |
| Amazon SES (and SMTP) | Email (SMTP, Amazon SES) | The outbox now waits out a provider for up to seven days, treats SES's account-level refusals as the provider's and gives up only on a bad address; refund, invoice, suspension, owed-notice and waitlist-lapse emails; the daily cap's urgent ceiling. SES's real error codes decide whether the permanent-error list is right |
| WhatsApp | WhatsApp template messages; WhatsApp webhook | The changed `mysenam_waitlist_offer` template (one more parameter) to resubmit to Meta; the short list of Meta codes treated as permanent; the credit spend now once per message. No template exists for the waitlist-lapse or refund notices; `mysenam_guardian_notice` is prepared, not submitted |
| MyInvois (LHDN) | MyInvois connection; MyInvois consolidated and credit notes; MyInvois customer's own e-invoice; MyInvois sent records and corrections | Consolidation of the month before on any day, not only days 1 to 7, an automatic back-off retry of a document that did not reach LHDN, per-venue isolation; late consolidated e-invoice treatment is `UNVERIFIED`; C2's prepaid credit. The journal export now writes credit notes as numbers |
| Backblaze B2 (and S3) off-site | Off-site backup copies | Nothing in the fix round touched backups; the real bucket has still never been written, the B2 key's scope, Object Lock and region are unverified, and the erasure ledger's off-site part is tested against a stand-in |
| Xero | Live accounting push to Xero | The push reads the sales journal; the fix round changed the report and the CSV export but not the push, and the push has never run against a Xero demo company |

## F. Controlled pilot recommendation

**Verdict: not ready to open to real customers today; ready to begin the pilot's
preparation, and in a position to run a narrow controlled pilot once the
integration checks below pass and the restrictions hold.**

The reasons are specific. For: the audit's 19 P1 findings are all fixed except one
tax question, the money paths that lost customers' money silently (credit taken for
a cancelled booking, a deposit above a price, a late payment, erased personal
data left behind, a closed day that still offered slots) now have regression tests
on both engines, every new behaviour has a decision record, and what the fix round
did not build is written down. Against: no provider has ever been called, so
every message, refund, e-invoice and subscription behaviour added in this round is
proven against a stand-in only; the audit walked no browser and this record has no browser
walk of the fixes; no CI run has passed on any commit; and the launch blockers that pre-date this audit
(email, off-site backup, legal drafts, reviewed languages) are still open. A fix
round of eleven decision records and thirteen migrations also changes a lot at
once; its first week in front of real users is the test it has not had.

Conditions for the pilot, each tied to what is open:

1. **Venues.** One to three independent venues, no multi-branch business. All staffed during every
   opening hour, with no unmanned or 24-hour access. The door, blocked-number and
   induction rules are fixed, but the follow-ups in C (certification expiry, the
   confirmation email, the desk checking in a refused number) are not.
2. **Sign-in.** Two-factor required for the owner and every manager
   (`MYSENAM_STAFF_2FA`), by configuration (A10).
3. **Payments.** Counter payment and, only after the Billplz sandbox check
   passes, online payment through each venue's own Billplz. **Refunds are
   manual and need a named person** who clears *Refunds owed* every day and tells the
   customer; assume a late payment after a hold lapses is refunded by hand (C18) and that
   a deposit above a lowered price is too (C1). No reliance on automatic refunds.
4. **No gateway auto-renewal.** Memberships are sold as terms paid at the counter or
   at checkout; no Stripe subscription is switched on in a Malaysian pilot (Stripe is
   a Singapore-install item and the pause behaviour is unverified). A suspended
   venue's customers are told, but pass and membership days are not extended for them (A4):
   the owner must be ready to extend by hand.
5. **No e-invoicing and no Xero push** at a pilot venue that sells stored credit,
   vouchers or passes, until C2 is answered by an adviser and the sandbox checks
   pass.
6. **Stored value kept small.** Credit, passes, vouchers and memberships are
   customers' money at a venue that cannot yet be wound down (A5). Pilot venues sell them
   sparingly, the owner reads the report's *what the venue owes* weekly, and the
   pilot agreement says closing is manual. A pass cancelled without a refund
   still forfeits restored entries, and voucher expiry is undecided.
7. **Youth and minors.** Youth messaging stays off (its production gate). No youth
   groups. Declared ages and guardians are the entrant's word.
8. **Policies frozen.** No edit of cancellation terms, tier benefits or hours with
   bookings in the way for the pilot (B12, D6, B14); strikes, expiry and renewals
   are told by staff by hand (D11); a pass bought for a mistyped phone number is
   voided and sold again (D10); a mistaken cancel cannot be undone (H12), so staff
   confirm a paid cancel; an absent coach is covered by hand (E11).
9. **Messaging.** Email first. WhatsApp only after `mysenam_waitlist_offer` is
   resubmitted and approved; customers with only a phone number are not told when a
   waiting-list offer lapses or a refund is made.
10. **Operations.** The scheduler heartbeat and the alert address live before day one;
    the retention alert (a draft that cannot be deleted) and the outbox alerts read daily;
    a backup restored and an off-site copy proved on a real bucket before the first
    booking, not after.

What would change the verdict: Billplz sandbox, SES and off-site checks passing and
recorded in a release record, with the lead's validation of this integration branch;
a week of a pilot venue's own use with the daily *Refunds owed* and *Needs attention*
clear; and the owner's written answers to DEC-05, DEC-03 (a stance), DEC-14 and DEC-24.
What would make it worse: a first venue that wants unmanned hours, online payment
before the sandbox check, or stored credit in volume.

## Status after the hardening round

*Added on 7 November 2026. The findings above are kept as written (audit records are
never rewritten).* What the [hardening round](hardening-2026-11-07.md) did to each
remaining finding, with its tests and what remains, is in
[that record](hardening-2026-11-07.md#2-what-the-round-did-to-each-remaining-finding), and
the open items are in [known limitations](../roadmap/known-limitations.md#business-process-audit-6-november-2026-open-items).
