# Remaining business decisions, 6 November 2026

The fourth of four records of the business-process audit of MySenam at commit
`2aabdd406626c9f1bdbd32e65addf599d0751c6f`. The others are the
[business-process inventory](business-process-inventory-2026-11-06.md), the
[cross-domain consistency matrix](cross-domain-consistency-2026-11-06.md) and
the [state-transition and failure-recovery audit](state-transitions-and-recovery-2026-11-06.md).
The findings are collected in the [findings register](findings-register-2026-11-06.md)
and ordered in the [remediation roadmap](remediation-roadmap-2026-11-06.md); which of
these decisions the fix round implemented is at the end, under
[status after the fix round](#status-after-the-fix-round).

Most findings of the audit are defects with one right answer. These are the
ones where the right answer is a business choice: the code does something that
is arguable, or a fix would change a rule the documents state. The eight
auditors listed 61 such questions between them, many of them the same one.
Merged, with seven questions they left implicit added (marked *added*), there
are 59. The numbering here is new (`DEC-01` to `DEC-59`) and groups them by
domain.

A recommendation is not a decision. Nothing here is a requirement until the
owner decides and it is written where it applies (a feature document, a
decision record, the [roadmap](../roadmap/roadmap.md)), as the
[documentation rules](../development/documentation.md) say. Where a
recommendation would change a documented or recorded rule, it says so and does
not choose between the code and the document.

Findings are cited by the auditors' identifiers; `B1=E9=H3` is one defect found
by three auditors
([equivalences](cross-domain-consistency-2026-11-06.md#the-same-defect-found-more-than-once)).

**Status** says whether the behaviour in question is already a recorded
decision:

- **Deliberate today** names the document, decision record or known limitation
  that records it. The question is then whether to *change* a decision.
- **Decided in part** means a decision covers some of the question; the rest is
  new.
- **New** means no document records a decision.
- **Defect, not a decision** marks a sub-question the auditors raised that has
  one right answer; it is listed only for the choice that remains.

Tax, consumer-law and data-protection questions (DEC-19, DEC-23, DEC-57,
DEC-58) need a qualified adviser; the project rule is never to treat a legal
question as settled in code, and a recommendation here does not settle one.

## Summary

| ID | Domain | Question | Blocks | Status |
| -- | ------ | -------- | ------ | ------ |
| DEC-01 | Marketplace | Do customers hear when a venue is suspended? | A4 | New |
| DEC-02 | Marketplace | Pass and membership validity, and counter sales, while a venue is suspended | A4, D12 | New |
| DEC-03 | Marketplace | How a venue leaves and what happens to customers' credit | A5=H8 | New |
| DEC-04 | Marketplace | Time for an overdue venue without falsifying the books | A7 | New |
| DEC-05 | Platform | Staff two-factor by default | A10 | Deliberate today |
| DEC-06 | Platform | Who staff may look up by email or phone | A2 | New |
| DEC-07 | Platform | Front desk: allow-list or deny-list | A9 | Deliberate today |
| DEC-08 | Platform | Front desk and rain-outs | H13 | Deliberate today |
| DEC-09 | Reservations | Cancellation terms: the ones shown at booking or the live ones | B12 | New |
| DEC-10 | Reservations | The waiting-list offer window | B13 | Deliberate today |
| DEC-11 | Classes | Unpaid class places and pay-to-hold | B9=E10 | Deliberate today |
| DEC-12 | Reservations | The unpaid-bookings brake: number, account or both | B8 | Decided in part |
| DEC-13 | Reservations | How a closure is made safe, and the waiting entries on a closed day | B1=E9=H3 | Defect, not a decision |
| DEC-14 | Reservations | A payment after the hold lapsed | C18=H7 | Deliberate today |
| DEC-15 | Reservations | Undoing a staff cancellation | H12 | New |
| DEC-16 | Reservations | A paid booking moved to a cheaper time | B16=C12=D15 | Deliberate today |
| DEC-17 | Money | A price below money already paid | C1=H1 | New |
| DEC-18 | Money | Counter-paid fees when a tournament or league is called off or a player is removed | C11=F4=H4, F12 | Decided in part |
| DEC-19 | Money | E-invoicing prepaid credit and vouchers | C2 | New |
| DEC-20 | Money | A company account with overdue invoices | C7 | New |
| DEC-21 | Money | Company credit notes: whole or partial; part payment | C6 | Deliberate today |
| DEC-22 | Money | Hire deposits in the till | C10=E13=H10 | Deliberate today |
| DEC-23 | Money | Gift voucher expiry and counter redemption | C15, D21 | Deliberate today |
| DEC-24 | Money | The refund route for Billplz money | C18=H7, G13 | Deliberate today |
| DEC-25 | Reports | One revenue basis for the report and the journal | G3, C8=G4, G5 | New |
| DEC-26 | Money | A quoted-price check at booking | C3, D20 | Decided in part |
| DEC-27 | Communications | Telling customers money has moved, and venues what they owe | G13, G14 | New |
| DEC-28 | Passes | Pass validity: the day played or the day booked | D4 | New |
| DEC-29 | Passes | Entries restored to an expired or voided pass | D1=H5 | Deliberate today |
| DEC-30 | Passes | Late cancellation of a pass-paid booking | C14=D14=H6 | Deliberate today |
| DEC-31 | Passes | Passes limited to off-peak, days or courts | D8 | New |
| DEC-32 | Passes | Setup and cleaning fees on a pass-paid booking | D9 | New |
| DEC-33 | Prices | A discount when an unpaid booking moves | D3 | Deliberate today |
| DEC-34 | Memberships | Editing a tier under members who already paid | D6 | Deliberate today |
| DEC-35 | Memberships | An open-ended suspension of a membership that renews itself | D12 | Deliberate today |
| DEC-36 | Memberships | Voiding a membership: whole refund or by days left | D22 | Deliberate today |
| DEC-37 | Memberships | The end of a term that starts on the 31st | D23 | Documentation and code disagree |
| DEC-38 | Memberships and passes | Expiry reminders and a ringgit liability line | D11, G16, C9 | New |
| DEC-39 | Standing | The phone number as a customer's identity for strikes | D13 | Deliberate today |
| DEC-40 | Safety | How far a blocked number reaches | E2 | Decided in part |
| DEC-41 | Safety | Induction and sign-off checked at booking | E3 | New |
| DEC-42 | Safety | What revoking a sign-off or induction does to bookings | E4 | New |
| DEC-43 | Classes | The term discount after most sessions are cancelled | E15 | New |
| DEC-44 | Venue operations | What a customer's own check-in proves | E7 | Decided in part |
| DEC-45 | Venue operations | Cancelling after the door code was shown | E18 | New |
| DEC-46 | Coaching | A lesson pack when its coach is absent or retired | E11 | Decided in part |
| DEC-47 | Messaging | The adult automatic suspension | F2 | Decided in part |
| DEC-48 | Messaging | Alerts and escalation for reports in adult threads | F8 | Added; decided in part |
| DEC-49 | Competitions | A closed day or a dead court over a drawn tournament | F3 | New |
| DEC-50 | Matchmaking | A host's no-show mark | F6 | Deliberate today |
| DEC-51 | Matchmaking | Leaving a game late: the share back | F11 | Deliberate today |
| DEC-52 | Competitions | Walkover claims and ladder reminders | F9, F10 | Decided in part |
| DEC-53 | Competitions | A tournament nobody drew, and entries after its start | F7 | New |
| DEC-54 | Competitions | A minor's name on a tournament's main page | F13 | Documentation conflict |
| DEC-55 | Communications | When the outbox gives up | G1 | New |
| DEC-56 | Communications | Urgent news and the daily message cap | G9 | New |
| DEC-57 | Privacy | What erasure removes: payer details, messages, webhook payloads | G6 | New |
| DEC-58 | Privacy | How long the activity log is kept | G20 | Decided in part |
| DEC-59 | Identities | A guest booking found by email | G20 | Decided in part |

## Marketplace and platform

### DEC-01 Do customers hear when a venue is suspended?

- **Question.** An owner or payment suspension today tells only the venue's staff. Confirmed bookings stand and can still be cancelled and refunded, but a customer with an unpaid held booking cannot pay and it lapses, and customers learn by failing.
- **Alternatives.**
  (a) One factual message to customers with upcoming confirmed bookings (venue unavailable on MySenam, existing bookings stand, how to cancel or contact), once per customer per suspension. Smallest change.
  (b) The same, and also to holders of passes, memberships and stored credit. Wider, and tells people about money the venue may not be able to honour.
  (c) Nothing, with the policy written in the terms. Customers keep learning by failure.
- **Recommended default.** (a), because the customer with a booking is the one for whom a surprise costs a court, and the owner can show the counts of passes, memberships and credit beside the existing count of upcoming bookings so (b) can follow.
- **Blocks.** A4.
- **Status.** Decided in part: "bookings already made stand, cancel them separately if they should not" is recorded ([marketplace](../product/marketplace.md)); the silence is not stated as a decision.

### DEC-02 Pass and membership validity, and counter sales, while a venue is suspended

- **Question.** While a venue is off the marketplace its passes and memberships keep ticking down, stored credit cannot be spent, Stripe renewals are not stopped, and the counter can still sell new credit and passes. A venue held for an overdue invoice can stay dark indefinitely.
- **Alternatives.**
  (a) Extend validity automatically by the suspension's length when the cause is the platform's, and stop the counter selling credit and passes while suspended.
  (b) An owner button per case, with the same counter rule.
  (c) Leave it.
- **Recommended default.** (a) for suspensions that end in a lift (the platform's act should not cost customers days); no new credit or passes at the counter while suspended, because it takes fresh money from people for a venue that is delisted. Owner decision on whether renewals at the gateway stop.
- **Blocks.** A4; related to D12 (DEC-35).
- **Status.** New.

### DEC-03 How a venue leaves and what happens to customers' credit

- **Question.** There is no closing state. Lifecycle is draft, live, suspended. A venue whose staff walk away strands credit, passes, memberships, tournament fees and owed refunds, keeps being invoiced, and customers holding credit cannot erase their accounts. The owner can only suspend.
- **Alternatives.**
  (a) An owner-run and venue-requested close-down: a screen that lists every liability by type with counts and amounts, cancels, refunds or converts them as chosen using the existing cancel, void and refund primitives, stops renewals and billing at a `closed_at` date, tells customers, keeps records for the retention period, then archives. Credit refunded in cash through the owner.
  (b) The same, with credit honoured at the business's other branches.
  (c) Keep it manual.
- **Recommended default.** (a), with billing stopping at closure and a customer-visible "venue closed" state that releases the erasure block. Effort is large (A5) and needs a state column.
- **Blocks.** A5=H8.
- **Status.** New. The suspension is documented; the exit is not.

### DEC-04 Time for an overdue venue without falsifying the books

- **Question.** An invoice has no way to extend its due date or pause the hold. To restore a held venue the owner must mark the invoice paid (recorded as paid, which it was not) or void it (forgives it, no reason recorded). `liftVenue` on a payment hold answers "not suspended", which is untrue.
- **Alternatives.** (a) A logged `grace_until` on the invoice, with a reason, honoured by the overdue query, and an accurate message. (b) Keep mark-paid and void only.
- **Recommended default.** (a): it keeps the hold derived from invoices (a deliberate design, so it cannot drift) and removes the only reason to record a false payment.
- **Blocks.** A7 (and the records A6=G12 needs).
- **Status.** New.

### DEC-05 Staff two-factor by default

- **Question.** Staff two-factor is off unless `MYSENAM_STAFF_2FA` is set, including for the owner who approves venues and marks invoices paid.
- **Alternatives.** (a) Default to `owners` when the marketplace is on in production. (b) Default to `managers`. (c) Stay opt-in, with a persistent warning to the owner.
- **Recommended default.** (a); the owner account moves money and listings and a single password is the weakest point. Whether managers must also be required is the owner's.
- **Blocks.** A10.
- **Status.** Deliberate today: "Unset, each account chooses" ([configuration](../development/configuration.md)); the risk is not recorded.

### DEC-06 Who staff may look up by email or phone

- **Question.** Any staff account, including one from a self-registered draft venue, can look a customer up across the whole platform by exact email or phone and receive name, email, phone and balance, with no rate limit. The design intent is that staff are looking at the person who has just said the number.
- **Alternatives.**
  (a) Restrict to customers with a row at the caller's venues or business (a booking, credit, pass, membership, participant), else answer a bare "not found"; throttle per staff account; refuse for venues that have never gone live.
  (b) Keep the global look-up for walk-ins who have an account elsewhere, but throttle it and show only a masked name.
- **Recommended default.** (a), with (b)'s masked name where creation at the counter is the aim (a top-up of a new customer). It closes the enumeration that S21 and S22 closed on the customer side.
- **Blocks.** A2.
- **Status.** New: the behaviour is described in code comments only.

### DEC-07 Front desk: allow-list or deny-list

- **Question.** The desk may do anything not on `MANAGER_ONLY`, so a new route is desk-open until someone lists it.
- **Alternatives.** (a) Add a test with an explicit `DESK_OK` list that fails for any route in neither list, with no behaviour change. (b) Keep the deny-list and rely on review.
- **Recommended default.** (a): cheap, and no current route contradicts the documented table. One route to confirm as intended: `POST /api/admin/inductions` grants out-of-hours, unstaffed door access to the desk.
- **Blocks.** A9.
- **Status.** Deliberate today: "anything not on that list is open to front desk" ([tenancy](../architecture/tenancy.md)); the omission risk is not recorded.

### DEC-08 Front desk and rain-outs

- **Question.** A rain-out over every court is a bulk cancel and refund like a closed day, which is manager-only, but the desk may declare one, `safety` included.
- **Alternatives.** (a) Keep it (documented). (b) The desk may preview; a manager or a second confirmation is needed for a safety rain-out or one covering more than N bookings.
- **Recommended default.** (b), because the harm of a mistaken safety closure or a whole-afternoon cancel is large and a second confirmation costs seconds. It changes a documented rule, so it is the owner's.
- **Blocks.** H13.
- **Status.** Deliberate today ([tenancy](../architecture/tenancy.md), [booking](../features/booking.md): "front-desk staff can do it").

## Court reservations and classes

### DEC-09 Cancellation terms: the ones shown at booking or the live ones

- **Question.** The cutoff, the late-keep share and give-back are read when the customer cancels; the booking stores no terms. A manager who raises the cutoff from 2 to 48 hours makes every existing booking uncancellable.
- **Alternatives.** (a) Snapshot the cutoff, share, give-back and the terms version on the booking and honour them (a migration). (b) Honour whichever is better for the customer. (c) Live terms, with a notice (today).
- **Recommended default.** (a): what the customer was shown is what binds, and it gives evidence in a dispute. (b) is the cheaper alternative if no migration is wanted.
- **Blocks.** B12.
- **Status.** New. Series cancels already detect a change of terms; single bookings do not.

### DEC-10 The waiting-list offer window

- **Question.** An offer lasts a fixed 30 minutes at any hour. At 23:50 it lapses at 00:20; an offer made 10 minutes before the start holds the court 20 minutes into the session; a lapse is silent.
- **Alternatives.** (a) A venue setting: default 30 minutes by day, paused overnight (for example 22:00 to 07:00) or extended to the morning for sessions more than 12 hours away. (b) Fixed 30 minutes. (c) The lesser of 30 minutes and the time to the start.
- **Recommended default.** (a), with a "your place on the list ended" message. Capping an offer at the session's start is a defect fix (B7=E5) whichever is chosen.
- **Blocks.** B13 (the window; the cap at the start is B7=E5).
- **Status.** Deliberate today: the 30-minute hold is documented ([booking](../features/booking.md), waiting lists).

### DEC-11 Unpaid class places and pay-to-hold

- **Question.** An online class enrolment is never held until paid, whatever the venue's pay-to-hold setting; a place claimed from the waiting list is. An unpaid enrolment keeps its place until the class starts. A full class can be held by enrolments that never pay.
- **Alternatives.** (a) Hold enrolments exactly like court bookings, one hold path, one release. (b) Keep them unheld, and release unpaid places N hours before the start with a reminder, or cap unpaid class places per number at 1 or 2. (c) Leave it and make the waiting-list claim behave like direct enrolment.
- **Recommended default.** (a) for venues that take payment online. Consequence: unpaid enrolments vanish at the end of the hold; the customer can still enrol at the counter, paid.
- **Blocks.** B9=E10 (and the release path calls `offerSlotPlace` where a class needs `offerClassPlace`, E6).
- **Status.** Deliberate today: [booking](../features/booking.md) waiting lists ("an enrolment is never held until paid") and the enrol route's comment. Known limitation B43 covers only the struck-out number.

### DEC-12 The unpaid-bookings brake: number, account or both

- **Question.** The brake counts unpaid bookings by the typed phone number only. A signed-in account with a verified number can hold any number of unpaid bookings by typing different numbers; the house rules count the number and the account.
- **Alternatives.** (a) Count by account as well as number. (b) Force a signed-in booking's number to the account's verified one unless staff book. (c) Accept it.
- **Recommended default.** (a); it is the smallest change and matches the house rules. Venues without pay-to-hold have no other protection.
- **Blocks.** B8.
- **Status.** Decided in part: "a brake", with the number-only design in `limits.ts` ([ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md)); the account bypass is not mentioned.

### DEC-13 How a closure is made safe, and the waiting entries on a closed day

- **Question.** The ordering of closure, rain-out and outage (cancel first, close last) is a defect, not a choice. Two choices remain: how to fix the order, and what happens to waiting-list entries for the closed time.
- **Alternatives.** Order: (a) write the closure or block first, then cancel what exists, and refuse new bookings in the meantime; (b) keep the order and loop until clear, as the outage does. Entries: (c) drop them with a message; (d) keep them waiting for a reopening.
- **Recommended default.** (a) and (c): a closure is the decision, and an offer for time the venue is closing is a false promise.
- **Blocks.** B1=E9=H3.
- **Status.** Defect, not a decision (order); New (entries).

### DEC-14 A payment after the hold lapsed

- **Question.** A payment that lands after a pay-to-hold booking was let go is recorded as owed back, even if the slot is still free; on Billplz it is refunded by hand and the customer is told only on the return page. An approval booking in the same case is turned back into the booking.
- **Alternatives.** (a) Revive the booking if the slot is free and the customer is the same (the approval rule), within the day; otherwise owe back. (b) Keep refund-by-hand.
- **Recommended default.** (a): it matters most while every Billplz refund is manual. The money is never lost today; this is utilisation and customer experience.
- **Blocks.** C18=H7.
- **Status.** Deliberate today: [payments](../features/payments-and-credit.md), "Paying online to hold a booking".

### DEC-15 Undoing a staff cancellation

- **Question.** Nothing sets a cancelled booking, a voided membership or a voided pass back. A desk cancelling the wrong booking frees the court at once (with a waiting-list offer in the same call), issues the credit note and owes the payment back.
- **Alternatives.** (a) A manager's "reinstate" within N minutes while the slot is free and no offer was made. (b) A confirmation step before cancelling a paid booking. (c) Neither.
- **Recommended default.** (b) first (cheapest, prevents the mistake), then (a) if desks report the need.
- **Blocks.** H12.
- **Status.** New.

### DEC-16 A paid booking moved to a cheaper time

- **Question.** A paid booking moved to a cheaper slot keeps the price paid; a customer cannot move to a dearer one. A peak RM60 booking moved to RM25 off-peak loses RM35 with no warning, while an online page whose price fell while open is refunded the difference.
- **Alternatives.** (a) Refund the difference as stored credit when the customer moves to a cheaper band before the cutoff, with a message. (b) Keep it (today, documented), and say so before the move is confirmed. (c) Forbid cross-band moves.
- **Recommended default.** (a), with (b)'s message in every case.
- **Blocks.** B16=C12=D15.
- **Status.** Deliberate today: a paid booking keeps what was paid ([booking](../features/booking.md), moving a booking; [pricing](../features/pricing.md)).

## Money and reports

### DEC-17 A price below money already paid

- **Question.** After a deposit or friends' shares are paid, a reschedule to a cheaper time or a promo can bring the price below what was paid. The excess is kept with no obligation, no credit note, and the venue's revenue and tax are overstated. A manager's price adjustment already refuses this (`P8B_ADJUST_BELOW_PAID`).
- **Alternatives.** (a) Refuse the customer's move or promo with a clear message. (b) Accept and owe the excess back on the deposit payment automatically. (c) Keep it (today).
- **Recommended default.** (b) for a deposit; refuse for friends' shares, whose payers would need telling. One helper that lowers a price used by all three writers keeps the rule in one place.
- **Blocks.** C1=H1.
- **Status.** New.

### DEC-18 Counter-paid fees when a tournament or league is called off or a player is removed

- **Question.** Online fees are owed back when a tournament is called off or a player withdraws before the draw. A fee paid in cash or by transfer at the desk is not: no credit note, no owed-back row, no list entry. The owed-back table is for bookings only. A box-league fee has no refund trail when staff remove a player mid-season or close the league.
- **Alternatives.** (a) Generalise the owed-counter-refund row to entries and league places: a named person confirms handing it back, with a credit note. (b) Keep it manual: staff unmark each entry by hand, and the called-off email and the manager's screen say so.
- **Recommended default.** (a) for a call-off. For withdrawal before the draw, follow `refundBeforeDraw` for counter money as for online; for a staff removal from a league, owe back the unplayed share or ask staff to decide explicitly.
- **Blocks.** C11=F4=H4, F12.
- **Status.** Decided in part: the owner's decision of 29 October 2026 owes back what the venue cancels, "a class or tournament called off", and a counter payment until a named person confirms ([known limitations](../roadmap/known-limitations.md), accepted); the code covers bookings and classes only. The withdrawal case is deliberate as worded (online money only).

### DEC-19 E-invoicing prepaid credit and vouchers

- **Question.** The consolidated e-invoice includes the credit top-up receipt and the booking paid from it, so RM130 is reported for RM30 of sales; the journal marks credit as owed to customers and the booking as the sale. A pass is handled the other way: the pass is the sale and the booking it pays is not a row.
- **Alternatives.** (a) Exclude credit and voucher receipts (and their credit notes) from consolidated e-invoices and e-invoice the booking they pay for. Matches the journal. Nothing is sent for unspent credit. (b) E-invoice at receipt and exclude credit-paid bookings, as for passes. Bookings paid from credit have no e-invoice row.
- **Recommended default.** (a), subject to the venue's or platform's tax adviser, because it agrees with the journal and with tax on spend. The treatment of prepayment under MyInvois is unverified and is not settled here.
- **Blocks.** C2.
- **Status.** New. The inclusion of credit is documented ([MyInvois](../integrations/myinvois.md)); the double count is not.

### DEC-20 A company account with overdue invoices

- **Question.** A company or school account with no credit limit stays bookable on credit with an invoice 90 days overdue; nothing reminds the account or reaches *Needs attention*. The platform does hold a venue for overdue invoices.
- **Alternatives.** (a) Block new bookings when any invoice is more than N days overdue (default 14 after due), with a manager override recorded. (b) Warn only: a dashboard line and a reminder. (c) Rely on the optional credit limit.
- **Recommended default.** (b) on by default, and (a) as a per-account setting.
- **Blocks.** C7.
- **Status.** New.

### DEC-21 Company credit notes: whole or partial; part payment

- **Question.** A credit note is applied whole, oldest first, only if it fits the next invoice, and the loop stops at the first that does not (credits of 60 and 20 against an invoice of 20 apply neither). An invoice can be recorded fully paid or not paid, never part-paid.
- **Alternatives.** (a) Apply as far as the invoice goes, remainder waiting, skip credits that do not fit, and record received amounts on mark-paid (a migration). (b) Keep "whole" and add a one-click "settle by hand" for the stranded credit.
- **Recommended default.** (a): "whole" strands credit and starves the exact-fit one behind a large one.
- **Blocks.** C6.
- **Status.** Deliberate today: "whole and oldest first, as far as its total goes" ([payments](../features/payments-and-credit.md), company accounts); not listed as a limitation. Added.

### DEC-22 Hire deposits in the till

- **Question.** A hire deposit held in cash is in the drawer but not in the cash-up, and when returned, money leaves the drawer the cash-up never shows. The method of a kept deposit defaults to cash. The cash-up stores no counted cash or variance.
- **Alternatives.** (a) Record the method when kit goes out; add a memo block of deposits held and returned by method (not takings) to the cash-up; refuse a return with an amount kept and no method; store counted cash and variance. (b) Treat deposits as customer liabilities in the journal. (c) Keep them a record only.
- **Recommended default.** (a); (b) if the accountant wants the liability on the books.
- **Blocks.** C10=E13=H10, E14.
- **Status.** Deliberate today in part: the deposit is "deliberately not a wallet movement" ([venue operations](../features/venue-operations.md)); that argument is about credit, not the till.

### DEC-23 Gift voucher expiry and counter redemption

- **Question.** A voucher expires after 12 months; the credit it becomes never expires. Expired voucher money stays a liability the report cannot see and never becomes income. Only an account can redeem, and only at its account page, so a printed voucher given to someone with no account cannot be used at the desk.
- **Alternatives.** Expiry: (a) none, as credit; (b) 12 months, with the breakage recognised as income when it lapses, venue-confirmed; (c) 12 months minimum, extended on request. Counter redemption: add it, and a pre-expiry email to the buyer; or not.
- **Recommended default.** None until a lawyer has advised on the consumer-law position on expiry of prepaid vouchers; meanwhile add the desk action and the reminder, which carry no legal risk.
- **Blocks.** C15, D21 (and G16 for the figure).
- **Status.** Deliberate today: the 12-month expiry is in `vouchers.ts` and described under gift vouchers ([payments](../features/payments-and-credit.md)); its effect on liabilities is not discussed.

### DEC-24 The refund route for Billplz money

- **Question.** Every Billplz refund at launch is by hand and needs the customer's bank account, which MySenam does not collect. The customer is told on the return page only.
- **Alternatives.** (a) A one-time secure "refund details" link per refund that deletes the data when the refund is marked done. (b) The venue phones the customer (today). (c) Credit instead of cash by default for Billplz, with (a) as an opt-in.
- **Recommended default.** (c), with (a) opt-in; the customer chooses and no new personal data is held by default.
- **Blocks.** Nothing directly; it is the standing limitation behind C18=H7 and G13.
- **Status.** Deliberate today: refunds by hand are accepted for a small launch ([known limitations](../roadmap/known-limitations.md), accepted; [launch providers](../integrations/launch-providers.md)).

### DEC-25 One revenue basis for the report and the journal

- **Question.** The venue report counts booking price by played date, netting credit notes only for late cancellations. The journal counts receipts by payment date. So the report misses a goodwill adjustment's credit note (G3), counts the deposit as neither collected nor reducing outstanding (G4, C8), and counts a pass-paid booking as collected while the pass sale is the money (G5).
- **Alternatives.** (a) Cash basis matching the journal: collected is receipts less credit notes including deposits and shares, a pass counted at its sale, and the adjustments shown as a line. (b) Usage basis: count pass hours used at value and say so on the page; the report and journal then always differ and the page must show the bridge.
- **Recommended default.** (a): one number for the accountant and the venue.
- **Blocks.** G3, C8=G4, G5; and the figure in C9.
- **Status.** New. The report document says deposits are not in the report ([reporting](../features/reporting.md)).

### DEC-26 A quoted-price check at booking

- **Question.** The booking is charged at the server's price at that moment. No path takes the quoted total, so a last use of a promo, a rate or tier edit between quote and Book changes the charge silently, and a refused discount still lets credit settle at full price (C3).
- **Alternatives.** (a) Accept an optional expected total on the booking and the venue API and refuse with the new price on a mismatch. (b) Only skip settling from credit or a pass when a requested discount failed. (c) Keep it.
- **Recommended default.** (b) now, because it removes the money harm, and (a) with it.
- **Blocks.** C3, D20.
- **Status.** Decided in part: "best-effort" is deliberate ([payments](../features/payments-and-credit.md)); the consequence for a failed discount is not discussed. Added.

### DEC-27 Telling customers money has moved, and venues what they owe

- **Question.** No message says a refund was made, failed or is late. The platform's monthly invoice is never sent to the venue; the first notice is a warning a week after the due date, and the venue is off the marketplace a week after that.
- **Alternatives.** Send both by email (and by WhatsApp only where the venue already pays for it), or neither.
- **Recommended default.** Both by email: a `refund_made` message deduplicated by refund, and the invoice on issue with warnings at 3 days before and 1 day after the due date, to every manager of the business.
- **Blocks.** G13, G14.
- **Status.** New.

## Passes, memberships, prices and standing

### DEC-28 Pass validity: the day played or the day booked

- **Question.** A pass is judged against today. A pass expiring in 2 days pays a booking 10 days away, or a weekly series for every week at once. Memberships are judged on the session's date.
- **Alternatives.** (a) Judge on the booking date, as memberships, so expiry means "play by"; combine with a grace extension (DEC-29). (b) Keep today and say "book by" on the pass and product. (c) Allow bookings up to N days past expiry.
- **Recommended default.** (a): consistent with memberships and it removes the stretching of validity by the booking window.
- **Blocks.** D4 (and makes D1 rarer).
- **Status.** New.

### DEC-29 Entries restored to an expired or voided pass

- **Question.** A cancelled pass-paid booking writes entries back to an expired or void pass, where nothing can spend them, and no money is returned. A pass voided with the unused part refunded, while a pass-paid booking stands, loses that booking's entry on a later cancellation (RM100 paid, RM50 back, RM50 gone).
- **Alternatives.** (a) Extend the pass by a grace (default 14 days, a venue setting) on restoration; if void, credit the entries' share as a credit note or credit; and refuse or warn when voiding with a refund while pass-paid bookings stand. (b) Credit the money share instead of extending. (c) Leave it and document it.
- **Recommended default.** (a) with the refusal; the venue-initiated case (a rain-out) is the worst.
- **Blocks.** D1=H5.
- **Status.** Deliberate today in part: "an expired pass is still credited: the ledger stays honest" ([pricing](../features/pricing.md)); the stranded value is not stated as accepted.

### DEC-30 Late cancellation of a pass-paid booking

- **Question.** The venue's kept share is rounded to whole entries against the customer: a 1-entry booking with any non-zero kept percentage returns nothing; a venue keeping 10% keeps the whole entry while the screen says it kept RM2.50.
- **Alternatives.** (a) Round the kept share to the nearest entry, or return the entry from a 50% share. (b) Return the fraction as stored credit priced from the pass. (c) Round against the customer (today), and say "your entry was kept".
- **Recommended default.** (a) (rounding in the customer's favour), with the screen saying what was kept.
- **Blocks.** C14=D14=H6.
- **Status.** Deliberate today: documented as "whole entries, rounded down" ([pricing](../features/pricing.md)).

### DEC-31 Passes limited to off-peak, days or courts

- **Question.** A pass product carries sport, coach, length and validity only. One entry pays RM20 off-peak or RM60 peak; the loyalty free hour is the same. The common Malaysian off-peak 10-hour pass cannot be sold.
- **Alternatives.** (a) `off_peak_only` and a court list on products, passes and the loyalty reward, checked with a refusal that names the rule. (b) Peak hours cost more entries. (c) Neither.
- **Recommended default.** (a), because venues will otherwise not sell passes or price them at the peak rate.
- **Blocks.** D8.
- **Status.** New.

### DEC-32 Setup and cleaning fees on a pass-paid booking

- **Question.** A pass settles the whole booking, fee included, though fees are never discounted and a fee is how a venue charges for setting up.
- **Alternatives.** (a) Charge the fee beside the pass, as extras are. (b) Waive the fee and state it.
- **Recommended default.** (b) if venues price passes to include fees; (a) otherwise. The venue's pricing intention decides.
- **Blocks.** D9.
- **Status.** New: the interaction is undocumented.

### DEC-33 A discount when an unpaid booking moves

- **Question.** A concession or promo is kept as an amount on a move (decided 27 October 2026). Moving a RM60 booking with RM30 off to a RM20 hour makes it RM0; a 20% code keeps RM12 on a RM20 hour; moving dearer leaves the customer paying more than the percentage promised.
- **Alternatives.** (a) Recompute a percentage discount on the new court time for an unpaid booking; a paid one stays as paid. (b) Cap the kept amount at the new court time. (c) Keep it and refuse a move that takes the total below what the percentage implies.
- **Recommended default.** (a), because nothing has been paid and no history exists.
- **Blocks.** D3.
- **Status.** Deliberate today: "a move keeps what was charged" ([pricing](../features/pricing.md), decided and kept, 27 October 2026); the RM0 outcome is not discussed.

### DEC-34 Editing a tier under members who already paid

- **Question.** A tier's price percentage, booking window, scope and entry flag are read live, so editing Gold from 70% to 95% changes the price for every existing Gold member on their next booking, though family cover limits and the suspension flag are snapshotted per term.
- **Alternatives.** (a) Snapshot the benefits at sale (a migration); edits apply to new terms, with an "apply an improvement to current members" tick. (b) Keep live, but refuse a downward edit while members hold live terms. (c) Live as today.
- **Recommended default.** (a): a paid term is a contract, and the product is inconsistent with itself.
- **Blocks.** D6.
- **Status.** Deliberate today: "changing a tier's benefits applies to its members from then on" ([pricing](../features/pricing.md), tiers); the downward edit was probably not weighed.

### DEC-35 An open-ended suspension of a membership that renews itself

- **Question.** A suspension "until reactivated" on a plan that does not extend on suspension keeps charging each period through Stripe and gives nothing; nobody reminds the manager and the customer's email does not say charges continue.
- **Alternatives.** (a) When suspending a renewing membership, show the next charge date and require a choice: extend the end by the suspended days (default), pause collection in Stripe, or proceed knowingly. (b) Leave it.
- **Recommended default.** (a) with the extension as the default and a periodic reminder to the manager.
- **Blocks.** D12 (related A4, DEC-02).
- **Status.** Deliberate today: the owner's decision of 28 October 2026 suspends and reactivates memberships "without automatic cancellation, refund or extension" ([known limitations](../roadmap/known-limitations.md), accepted) and "nothing pauses a subscription's charges" ([pricing](../features/pricing.md)). The recommendation would change a recorded decision.

### DEC-36 Voiding a membership: whole refund or by days left

- **Question.** A refund on voiding credits the whole receipt ("nothing is prorated"); bookings already made at the member price keep it. Passes refund the unused share.
- **Alternatives.** (a) Offer a pro-rata refund by days left. (b) A venue setting. (c) Keep it.
- **Recommended default.** (b) with whole as the default, so a venue can choose pro-rata.
- **Blocks.** D22.
- **Status.** Deliberate today ([pricing](../features/pricing.md), membership void). Added.

### DEC-37 The end of a term that starts on the 31st

- **Question.** The documents say 31 January plus one month ends on the last day of February; the code (`addDays(addMonths(start, 1), -1)`) gives 27 February and the anchor then drifts to the 28th.
- **Alternatives.** Make the code match the document, or the document the code.
- **Recommended default.** The document: customers buy a calendar month. The decision is which is intended, and it is the owner's (rule 9 of the project's documentation rules: do not pick silently).
- **Blocks.** D23.
- **Status.** Documentation and code disagree ([pricing](../features/pricing.md), joining). Added.

### DEC-38 Expiry reminders and a ringgit liability line

- **Question.** Nothing tells a customer that a pass, voucher or membership is about to expire, a strike was recorded, or a number was struck out. The venue report shows pass entries in hours and membership counts but no ringgit, nothing for vouchers, refunds owed, counter refunds owed, account credits waiting or hire deposits held.
- **Alternatives.** (a) One email 14 and 3 days before expiry of a pass, voucher, membership or credit that expires, a message when a strike is recorded and when the limit is reached (reason, how to dispute), and a "what the venue owes" block in ringgit. (b) Reminders only. (c) Neither, with the position in the terms.
- **Recommended default.** (a), at launch scope for reminders and for the accountant's liability line.
- **Blocks.** D11, G16, C9.
- **Status.** New.

### DEC-39 The phone number as a customer's identity for strikes

- **Question.** Strikes, blocks, notes, remembered concession proofs and one-review-per-number all key on the number. Numbers are recycled and families share a phone, so three no-shows by a number's earlier owner strike out the next; a guest can type a victim's number and no-show.
- **Alternatives.** (a) Keep it, and add the booking each strike came from for the desk, account-owned standing for signed-in verified numbers, and concession proof by number only when a manager chose "remember". (b) Move strikes to participants.
- **Recommended default.** (a): cheap and consistent, and it removes the worst unfairness.
- **Blocks.** D13 (and the notice in D11).
- **Status.** Deliberate today: the number as identity is a stated principle (`limits.ts`, [ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md)); the consequences are not.

## Safety, classes, coaching and venue operations

### DEC-40 How far a blocked number reaches

- **Question.** A blocked number cannot book, join a waiting list or play open games, but keeps its door code, QR check-in and every confirmed booking, and the manager is not shown them.
- **Alternatives.** (a) Refuse the door code and check-in with "see the venue", and list the number's upcoming bookings when blocking so the manager can cancel and refund. (b) Auto-cancel and refund them.
- **Recommended default.** (a): at an unattended door the code is the access control.
- **Blocks.** E2.
- **Status.** Decided in part: the owner's decision of 28 October 2026 says nothing overrides a blocked number ([ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md)); that decision was not applied to the door.

### DEC-41 Induction and sign-off checked at booking

- **Question.** A customer without an induction books and pays for an unstaffed hour; the door refuses at the time, with the counter shut. Sign-offs are already refused at booking for activities that ask for one.
- **Alternatives.** (a) Refuse online (and name the rule), allow it at the counter with a note. (b) Warn only, to keep conversion.
- **Recommended default.** (a), keeping the door check as the second line.
- **Blocks.** E3.
- **Status.** New. The documents describe only the door check.

### DEC-42 What revoking a sign-off or induction does to bookings

- **Question.** A sign-off written by an approval flags the person's bookings; a plain sign-off or an induction taken back does nothing to bookings, and a staffed desk has no check at all.
- **Alternatives.** (a) Flag only: write flags for the person's upcoming bookings of that activity, show them in *Needs attention* and on the day list, tell the customer, and warn before a certification's expiry. (b) Auto-cancel with refund when a manager ticks "unsafe".
- **Recommended default.** (a).
- **Blocks.** E4.
- **Status.** New. Rosters' "nothing cancelled, nobody told" is deliberate ([ADR 0036](../architecture/decisions/0036-who-supervises-a-session.md)) and is a different matter.

### DEC-43 The term discount after most sessions are cancelled

- **Question.** A customer can join a term, cancel all but one session free before the cutoff, and keep that one at the term price (RM15 against RM30). Full sessions are left out of a term and are not named in the confirmation.
- **Alternatives.** (a) Keep it. (b) Re-price the remaining sessions when fewer than N remain. (c) Forbid cancelling a term session individually after the cutoff.
- **Recommended default.** (b), and name the sessions not joined whichever is chosen (the document says they are named).
- **Blocks.** E15.
- **Status.** New.

### DEC-44 What a customer's own check-in proves

- **Question.** The QR link carries no proof of presence, yet it clears a no-show the desk recorded, freezes a class move (any enrolment with a check-in), and turns a lesson into "went ahead" for coach pay, reviews and loyalty.
- **Alternatives.** (a) Self check-in counts for the headcount only; a desk check-in or a register mark is what clears a no-show and freezes a move (one column on `check_ins`). (b) It counts for attendance too. Also: whether a desk can undo a check-in.
- **Recommended default.** (a).
- **Blocks.** E7.
- **Status.** Decided in part: self check-in is deliberate for the headcount ([venue operations](../features/venue-operations.md)), and a class mover counting a check-in rather than a register mark is accepted ([known limitations](../roadmap/known-limitations.md)); the remote-tap consequences are not.

### DEC-45 Cancelling after the door code was shown

- **Question.** A customer who has revealed the door code or checked in can still cancel on late terms. At the default 2-hour cutoff nothing can happen; with a cutoff of 0 or 1 hour, or late cancelling that keeps a share, the court can be used and refunded and re-offered.
- **Alternatives.** (a) Refuse a customer's cancel once the code was revealed or the booking checked in. (b) Leave it, as it depends on the venue's settings.
- **Recommended default.** (a): it is a customer's right being narrowed, so it is the owner's to decide.
- **Blocks.** E18.
- **Status.** New. Added.

### DEC-46 A lesson pack when its coach is absent or retired

- **Question.** A pack works only with its own coach, so pack customers of an absent or retired coach cannot continue; a lesson paid by a pack, a deposit or shares cannot go to another coach ("cancel and book again").
- **Alternatives.** (a) A venue setting letting a pack be spent on any coach of the sport while its coach is absent or retired. (b) A pack may name two coaches. (c) Keep it.
- **Recommended default.** (a), alongside a lesson worklist and a bulk reassign (E11, not a decision).
- **Blocks.** E11.
- **Status.** Decided in part: "a paid lesson keeps its coach when moved, another coach only by a manager's explicit change" (owner, 27 October 2026, [programmes](../features/programmes.md)).

## Competitions, matchmaking and messaging

### DEC-47 The adult automatic suspension

- **Question.** Three reports against one adult in 30 days suspend them everywhere "pending the platform owner's review". The owner cannot see the reports behind it, the venue cannot lift it, nothing prompts a review, nothing lifts it when all three are dismissed, and the person cannot appeal. Three accounts can silence somebody, including a team captain, indefinitely.
- **Alternatives.** (a) Keep the rule and add: the owner can read the linked reports; auto-lift when fewer than three counted reports remain; an owner notice and a 14-day review date; an appeal from the notice. (b) Replace the automatic sanction with an alert to the venue and the owner (fairest, slower). (c) Leave it and record it as accepted: the documented review cannot be done.
- **Recommended default.** (a); (c) is not recommended.
- **Blocks.** F2, F8.
- **Status.** Decided in part: that three accounts can trigger an automatic suspension is accepted ([known limitations](../roadmap/known-limitations.md), messages between players); the inability to review it is not recorded.

### DEC-48 Alerts and escalation for reports in adult threads

- **Question.** Only youth-thread reports email staff. A report in a game, tournament, ladder or team thread waits for a manager to open a panel, has no ageing, no ranking of "unsafe", no way to escalate to the owner, and the reporter is not told it was reviewed.
- **Alternatives.** (a) Email the manager on a report (counts only, no message text), rank "unsafe" first, add an age flag at 3 days, let a manager escalate, and send the reporter a neutral "reviewed". (b) Leave it.
- **Recommended default.** (a); the columns exist.
- **Blocks.** F8.
- **Status.** Added. Decided in part: reports are unseen where a venue has no manager and the reporter is not told the outcome of an automatic suspension ([known limitations](../roadmap/known-limitations.md)); the lack of any notice or escalation is not recorded.

### DEC-49 A closed day or a dead court over a drawn tournament

- **Question.** An outage or closure after the draw releases competition blocks, leaves matches on a dead court, and tells nobody; a ladder's holds are handled properly (ADR 0048). There is no "postpone the day": dates are fixed after creation.
- **Alternatives.** (a) Warn the manager and tell entrants and captains now; build a postpone-the-day tool later. (b) Build postponement first.
- **Recommended default.** (a).
- **Blocks.** F3.
- **Status.** New. Only the pre-draw case is recorded.

### DEC-50 A host's no-show mark

- **Question.** A host's no-show mark on an open game is silent and cannot be cleared; three in 90 days bar the player from every open game at every venue.
- **Alternatives.** (a) Tell the player, let the host clear it for 7 days and venue staff always, and show the count to the player. (b) Remove the platform-wide effect and keep it per venue.
- **Recommended default.** (a).
- **Blocks.** F6.
- **Status.** Deliberate today ([matchmaking](../features/matchmaking.md), no-shows); notice and undo are not.

### DEC-51 Leaving a game late: the share back

- **Question.** A leaver, a removed player and a host cancelling get the full share back at any time; the venue's late-cancellation share applies only to the host's own part, so a court paid by three players can be abandoned an hour before with no money kept.
- **Alternatives.** (a) Keep full refunds. (b) Apply the venue's cutoff and late share to leavers (unless the place is refilled) and to the host's late cancellation of the whole price.
- **Recommended default.** (b) for venues. It changes a documented rule.
- **Blocks.** F11.
- **Status.** Deliberate today: "owed back when the game does not happen to them" ([matchmaking](../features/matchmaking.md)).

### DEC-52 Walkover claims and ladder reminders

- **Question.** A player-reported walkover stands after 24 hours of the opponent's silence, with one email; a ladder challenge ignored for three days forfeits with one email and no reminder.
- **Alternatives.** Walkover: stands (today), or goes to staff as disputed after 24 hours. Ladder: one reminder at half the window and a line "if this is wrong, ask a manager" in the forfeit email, or none.
- **Recommended default.** A reported walkover never auto-stands; one ladder reminder at half the window.
- **Blocks.** F9, F10.
- **Status.** Decided in part: the ladder forfeits are the owner's decisions of 4 November 2026 ([known limitations](../roadmap/known-limitations.md), forfeits, officials and ladders); the 24-hour rule is a tournament choice not discussed there.

### DEC-53 A tournament nobody drew, and entries after its start

- **Question.** With no entries-close date a tournament takes entries and fees after its last day, holds courts until then, can never be drawn once its first day has gone, and nobody is alerted. A promoted waiting-list entrant has no payment deadline; the draw includes unpaid entrants without warning.
- **Alternatives.** Make the day before `starts_on` the implicit last day for entries; email managers 2 days before for an undrawn event and the day after with a one-click cancel (refunds); or leave it to the manager.
- **Recommended default.** The implicit last day, the alerts and the one-click cancel.
- **Blocks.** F7.
- **Status.** New.

### DEC-54 A minor's name on a tournament's main page

- **Question.** A known limitation says the main page shows entry names in full, including declared minors, "open for the owner". The code, the tournament document and the privacy document say the page shortens a declared minor. The real gap: an event with no age range and an entrant with no declared age shows the full name of whoever typed an age under 18 elsewhere.
- **Alternatives.** Correct the limitation's text to match the code, then decide the remaining case: shorten any name whose declared age is unknown, or leave it.
- **Recommended default.** Correct the text, and shorten when age is unknown.
- **Blocks.** F13.
- **Status.** Documentation conflict ([known limitations](../roadmap/known-limitations.md), tournament day; [tournaments](../features/tournaments.md), names of minors on public pages). The code wins. Added.

## Communications, privacy and identities

### DEC-55 When the outbox gives up

- **Question.** After five failures over about 2.6 hours a message is abandoned and never tried again. Resend is one message at a time by venue staff, and account emails cannot be resent at all. One expired token abandons every message queued across venues.
- **Alternatives.** (a) Retry transient errors (provider, auth, 5xx, timeouts) for up to about 48 hours with backoff capped near 2 hours, give up by content expiry (a reminder at its start time, a confirmation at 48 hours), and abandon fast only for permanent errors; add "Resend all failed". (b) Keep five attempts and add the bulk resend. (c) Keep it. Consequence of (c): every outage over 2.6 hours needs a manual hunt.
- **Recommended default.** (a), with the bulk resend.
- **Blocks.** G1.
- **Status.** New.

### DEC-56 Urgent news and the daily message cap

- **Question.** After 8 messages to one address or number in 24 hours, a waitlist offer, a venue cancellation, a move or a guardian notice is written off. Two lists exist for one concept: the urgent kinds are sent by WhatsApp at the platform's cost, but only some kinds are uncapped.
- **Alternatives.** (a) One list: urgent kinds, safeguarding and team decisions bypass the cap. (b) Keep the cap on everything.
- **Recommended default.** (a), accepting the abuse risk (a guest booking typed with a victim's address already costs a message each, bounded by the unpaid-booking limits).
- **Blocks.** G9.
- **Status.** New.

### DEC-57 What erasure removes: payer details, messages, webhook payloads

- **Question.** After erasure the person remains in `online_payments` (payer name and phone, never touched by any rule or export), in `messages` (recipient and body, for up to 90 days, and a queued message is still sent) and in `webhook_deliveries` (full name, email and phone for 30 days).
- **Alternatives.** (a) Anonymise the payer fields with the booking (the money row stays), scrub message recipients, abandon queued messages and drop pending webhooks, add the payer fields to the 730-day rule and the export. (b) Keep the payer name for 7 years as a tax record and say so in the privacy notice and the export.
- **Recommended default.** (a). The retention basis is a legal question for the venue's adviser.
- **Blocks.** G6.
- **Status.** New. The retention table in [privacy](../architecture/privacy.md) does not list `online_payments`.

### DEC-58 How long the activity log is kept

- **Question.** The staff activity log is kept 730 days, and a failed write is only logged to the console, while receipts and e-invoices are kept for the statutory period: "who refunded, voided or adjusted" disappears first.
- **Alternatives.** (a) Keep money, permission and policy entries for the statutory period (7 years), the rest 730 days. (b) Keep it as is.
- **Recommended default.** (a). The legal basis is the adviser's.
- **Blocks.** G20 (the retention point).
- **Status.** Decided in part: the 730 days is the recorded rule ([privacy](../architecture/privacy.md)); the mismatch with the statutory period is not.

### DEC-59 A guest booking found by email

- **Question.** A signed-in account whose email matches a guest booking's typed email sees the booking and may cancel it. A wrong or malicious email on someone else's booking gives that stranger cancel rights.
- **Alternatives.** (a) Show it, but allow cancelling only with the booking code and phone, as for guests. (b) Keep it.
- **Recommended default.** (a).
- **Blocks.** G20 (the guest-email point).
- **Status.** Decided in part: showing a guest booking to the account with the confirmed email was the fix for a 28 October finding ([operations audit](operations-2026-10-28.md), X2-12); cancel rights were not discussed.

## Status after the fix round

*Added after the fix round that followed this audit; the decisions above are
unchanged and still say what was open at the baseline.* The fix workers implemented a
recommended default only where their brief said to, and left the rest. Each row below says what happened; the findings are in the
[findings register](findings-register-2026-11-06.md) and what is left is in the
[remediation roadmap](remediation-roadmap-2026-11-06.md). **A decision built into
the code by a fix worker is a default taken for the audit round, recorded in a decision
record; it is the owner's to confirm or change**, and nothing here settles a tax,
consumer-law or data-protection question.

Of the 59 decisions: the recommended default was **implemented in 19**, **in part in
13**, and **27 remain for the owner**. Every implemented one was verified by new tests
on PGlite and (races and money) Postgres by the fix workers; none by a real provider.

| Outcome | Decisions |
| ------- | --------- |
| Implemented | DEC-01, DEC-04, DEC-06, DEC-07, DEC-12, DEC-17, DEC-21, DEC-22, DEC-25, DEC-26, DEC-28, DEC-40, DEC-42, DEC-44, DEC-47, DEC-49, DEC-55, DEC-56, DEC-57 |
| Implemented in part | DEC-02, DEC-10, DEC-13, DEC-18, DEC-20, DEC-27, DEC-29, DEC-35, DEC-38, DEC-41, DEC-48, DEC-52, DEC-53 |
| For the owner (not built) | DEC-03, DEC-05, DEC-08, DEC-09, DEC-11, DEC-14, DEC-15, DEC-16, DEC-19, DEC-23, DEC-24, DEC-30, DEC-31, DEC-32, DEC-33, DEC-34, DEC-36, DEC-37, DEC-39, DEC-43, DEC-45, DEC-46, DEC-50, DEC-51, DEC-54, DEC-58, DEC-59 |

### Per decision

The records are [ADR 0053](../architecture/decisions/0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md),
[0054](../architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md),
[0055](../architecture/decisions/0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md),
[0056](../architecture/decisions/0056-outbox-reliability-messages-survive-outages-and-stops.md),
[0057](../architecture/decisions/0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md),
[0058](../architecture/decisions/0058-safety-and-access-after-a-booking-is-made.md),
[0059](../architecture/decisions/0059-competition-notices-fees-owed-fixtures-lost-and-message-review.md),
[0060](../architecture/decisions/0060-waiting-list-offers-windows-starts-and-closing.md),
[0061](../architecture/decisions/0061-company-accounts-and-the-cash-up.md),
[0062](../architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md) and
[0063](../architecture/decisions/0063-a-suspended-venue-tells-its-customers-sells-nothing-new-and-an-overdue-one-can-be-given-time.md).

| ID | Outcome | What was built, and what remains for the owner |
| -- | ------- | ---------------------------------------------- |
| DEC-01 | Implemented, wider | Customers with a booking, class, lesson, active pass, active membership or credit are emailed once per suspension (the recommended default (a) plus the holders of (b)), as urgent news; four languages. ADR 0063 |
| DEC-02 | In part | The counter and online no longer sell passes, memberships, credit or vouchers while suspended; Stripe subscriptions are paused at the gateway (`pause_collection`), **unverified against real Stripe**. **Owner:** whether validity is extended for the time a venue was off (not built; a manager can extend a membership by hand). ADR 0063 |
| DEC-03 | Owner | No close-down workflow was built (A5 = H8). ADR 0063 records it as left to the owner |
| DEC-04 | Implemented | `billing_grace_until` with a reason, honoured by the overdue query; an accurate lift message. ADR 0063 |
| DEC-05 | Owner | Not changed (A10). Configurable today by `MYSENAM_STAFF_2FA` |
| DEC-06 | Implemented | Lookups find only customers with a relationship to the venue and are throttled; linking is refused from a draft. The masked-name alternative was not taken. ADR 0057 |
| DEC-07 | Implemented | The classification test (`desk`, `manager`, `owner`, `account`) fails for an unlisted route; the deny-list stays; `inductions` left as a desk tool; two routes moved to manager-only. ADR 0057 |
| DEC-08 | Owner | Not changed (H13); rain-out stays a desk tool |
| DEC-09 | Owner | Not changed (B12) |
| DEC-10 | In part | A venue setting (5 to 120 minutes, default 30), the offer capped at the start, and a lapse notice (email only). **Owner:** the overnight pause or extension, not built. The WhatsApp template changed and must be resubmitted. ADR 0060 |
| DEC-11 | Owner | Not changed (B9 = E10) |
| DEC-12 | Implemented | Unpaid bookings counted by number or account. ADR 0054 |
| DEC-13 | In part | (a) the closure first, built; the order was a defect. **Owner:** (c) against (d): waiting entries on a closed day are left waiting, not dropped with a message. ADR 0053 |
| DEC-14 | Owner | Not changed (C18 = H7) |
| DEC-15 | Owner | Not changed (H12) |
| DEC-16 | Owner | Not changed; ADR 0054 leaves a paid booking moved cheaper alone (B16 = C12 = D15) |
| DEC-17 | Implemented | (b) for a deposit, refuse for friends' shares, in one helper used by every writer of the price. ADR 0054 |
| DEC-18 | In part | A call-off and a pre-draw withdrawal owe a counter fee back (a sibling table, settled by staff once with a credit note). **Owner:** a league's place fee on a staff removal (F12). ADR 0059 |
| DEC-19 | Owner | Not changed (C2); a tax adviser's question |
| DEC-20 | In part | Overdue accounts are reminded and shown in *Needs attention* (on); the block is a **per-venue** setting, default off, not per account. **Owner:** whether to default it on or make it per account. ADR 0061 |
| DEC-21 | Implemented | Credit allocated part by part; invoices part-paid. ADR 0061 |
| DEC-22 | Implemented | The method recorded at take, a deposits block and counted cash in the cash-up; nothing defaults to cash. Whether held deposits are a liability in the books stays with the adviser. ADR 0061 |
| DEC-23 | Owner | Not changed (C15, D21); needs a lawyer. The desk redemption and the reminder were not built |
| DEC-24 | Owner | Not changed; Billplz refunds stay by hand and the customer's bank details are not collected (G13's notice is email) |
| DEC-25 | Implemented | A cash basis matching the journal; pass-paid apart; adjustments and liabilities reported. ADR 0055 |
| DEC-26 | Implemented | (b) and (a): a refused discount no longer settles; `expectedTotal` / `PRICE_CHANGED`. ADR 0054 |
| DEC-27 | In part | The refund notice (email) and the platform invoice on issue and before due. **Owner:** a warning one day after the due date was not added. ADR 0056 |
| DEC-28 | Implemented | A pass is judged on the session's date. ADR 0062 |
| DEC-29 | In part | Extension on restoration (venue setting, default 30 days, not 14) and a credit when the pass was cancelled with a refund. **Owner:** refusing to void a pass that pays future bookings was not built; a pass cancelled without a refund still forfeits restored entries. ADR 0062 |
| DEC-30 | Owner | Not changed (C14 = D14 = H6) |
| DEC-31 | Owner | Not changed (D8) |
| DEC-32 | Owner | Not changed (D9) |
| DEC-33 | Owner | Not changed (D3) |
| DEC-34 | Owner | Not changed (D6) |
| DEC-35 | In part | An open-ended suspension of a renewing membership extends its end when lifted. **Owner:** pausing collection at the gateway, a dated suspension's default, telling the member at suspension that charges continue. ADR 0062 |
| DEC-36 | Owner | Not changed (D22) |
| DEC-37 | Owner | Not changed (D23); documentation and code still disagree |
| DEC-38 | In part | The liabilities line in ringgit (provisional). **Owner:** the expiry reminders, not built (D11, G16). ADR 0055 |
| DEC-39 | Owner | Not changed (D13) |
| DEC-40 | Implemented | A refused number loses the door code and self check-in and its upcoming bookings are listed, not cancelled. **Owner:** whether the desk may check one in (today yes). ADR 0058 |
| DEC-41 | In part | Sign-off and certification refused at booking for unstaffed time; an induction is told, not refused. ADR 0058. **Owner:** refusing an induction online |
| DEC-42 | Implemented | Flag and tell; nothing cancelled. A certification's expiry is not warned. ADR 0058 |
| DEC-43 | Owner | Not changed (E15) |
| DEC-44 | Implemented | A self check-in counts for the headcount only until staff confirm it. ADR 0058 |
| DEC-45 | Owner | Not changed (E18); recorded as a limitation in ADR 0058 |
| DEC-46 | Owner | Not changed (E11) |
| DEC-47 | Implemented | The owner reads the reports, a 14-day review date, auto-lift under three reports, a review on request. Legal questions stay pending. ADR 0059 |
| DEC-48 | In part | Managers are told of a report (counts only) and the panel shows the age of the oldest. **Owner:** escalation to the owner and a reporter notice, not built. ADR 0059 |
| DEC-49 | Implemented | Warn, tell once and postpone the day. ADR 0059 |
| DEC-50 | Owner | Not changed (F6) |
| DEC-51 | Owner | Not changed (F11) |
| DEC-52 | In part | A ladder reminder at half the window. A walkover is reminded 12 hours before it stands and flagged, but still stands after 24 hours. **Owner:** whether a walkover ever stands by silence. ADR 0059 |
| DEC-53 | In part | A tournament with no closing date stops taking entries after its first day, is closed and flagged. **Owner:** the day before the start, an alert two days ahead, a one-click cancel. ADR 0059 |
| DEC-54 | Owner | Not changed (F13); the stale limitation text remains |
| DEC-55 | Implemented | Transient failures wait (7 days by default, `MYSENAM_MESSAGE_MAX_AGE_DAYS`, not 48 hours); staff resend everything that failed. ADR 0056 |
| DEC-56 | Implemented | One urgent list, exempt from the daily 8, with a ceiling of its own (default 30). ADR 0056 |
| DEC-57 | Implemented | Payer details, messages and webhook deliveries reached by erasure and the 730-day rule (provisional: not a statement of what the law requires). ADR 0057 |
| DEC-58 | Owner | Not changed (G20) |
| DEC-59 | Owner | Not changed (G20) |

## Status after the hardening round

*Added on 7 November 2026, after the [hardening round](hardening-2026-11-07.md) the
owner authorised in writing; the sections above still say what was open at the
baseline.* The owner authorised these decisions by name; each is built in the way its
[decision record](../architecture/decisions/) says, and **remains the owner's to
confirm or change where the record names a choice the brief did not settle**. None of
it settles a tax, consumer-law or data-protection question, and none was checked
against a real provider.

One decision was added: **DEC-60**, below. Of the now 60 decisions, **27** are
implemented, **14** in part and **19** remain for the owner.

| ID | Outcome now | What was built, and what stays with the owner |
| -- | ----------- | --------------------------------------------- |
| DEC-05 | Implemented | On a production marketplace the owner, business managers and branch managers must enrol in two-factor by default, the front desk may; `off` is refused (enforcement stays on, logged, owner alert), not an exit at start, which the owner may prefer; a staging override exists for synthetic data only. ADR 0064 |
| DEC-09 | Implemented | The terms shown at booking govern that booking (alternative (a)); earlier bookings use the current terms, nothing invented; refund method and strike rules stay live. ADR 0069 |
| DEC-11 | Implemented | Online class enrolments are held for payment like courts and released to the waiting list; staff and counter enrolments are not held. ADR 0070 |
| DEC-14 | Implemented | A payment after the hold lapsed never revives the booking; it is owed back, listed and told to a confirmed address. Billplz refunds stay manual (DEC-24). ADR 0065 |
| DEC-16 | In part | The difference is shown first and given back the way it was paid. **Owner:** that staff (managers only) may keep it after the cutoff; stored credit offered in the app; pass-paid returns nothing; the venue's own court move keeps the price. ADR 0067 |
| DEC-19 | Owner | **Not decided.** The memo, the guard on enabling e-invoicing at a venue that sells credit or vouchers, and a test pinning the current RM130 for RM30 of sales are in; the treatment is a tax adviser's. ADR 0065 |
| DEC-33 | Owner | A kept amount never makes the time free (built); whether percentages should always be recomputed is open. ADR 0067 |
| DEC-34 | Implemented | A term keeps the benefits it was sold with; renewals take the plan then; legacy terms are backfilled from the current plan and marked. **Owner:** telling a member before a renewal; a way to give current members an improvement. ADR 0071 |
| DEC-38 | In part | Needs-attention lists and one email each for an ending pass or membership and a recorded no-show. **Owner:** voucher emails, a second reminder, the ringgit liability line. ADR 0072 |
| DEC-40 | Implemented | The desk is included: no check-in of a refused number, with no override. ADR 0064 |
| DEC-45 | Implemented | A customer's own or verified check-in sends a cancellation to staff, nothing forfeited; a shown code alone changes nothing. **Owner:** the stricter reading that an unconfirmed self check-in also goes to staff was taken. ADR 0069 |
| DEC-50 | Implemented | A mark needs a reason, the player is told and answers, a manager reviews, the host can take it back, it counts at its venue; platform-wide only by the owner with a written reason. ADR 0072 |
| DEC-60 | Implemented | See below. ADR 0067 |

### DEC-60 Discounts when a booking moves

- **Question.** A rescheduled booking lost the last-minute discount a fresh booking at that time would get (audit B11), and a kept concession amount could make the new time free (D3). No decision record existed.
- **Alternatives.** (a) The discount is an entitlement fixed when the booking was made and tied to its time: a move re-prices a marked booking as it was made, minute by minute, and a booking never earns one by moving. (b) Recompute the discount at the new time for every booking. (c) Drop any discount on a move.
- **Decided (the owner's principle of 7 November: do not silently create or remove a discount on a reschedule).** (a), shown before the customer confirms; a concession or code stays at its amount but never makes the time free.
- **Status.** Implemented, [ADR 0067](../architecture/decisions/0067-a-paid-booking-moved-cheaper-gives-the-difference-back-and-a-move-never-silently-changes-a-discount.md). Open: DEC-33, whether percentages are recomputed.
