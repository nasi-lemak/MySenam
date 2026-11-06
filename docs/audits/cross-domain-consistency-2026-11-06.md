# Cross-domain consistency matrix, 6 November 2026

The second of four records of the business-process audit of MySenam at commit
`2aabdd406626c9f1bdbd32e65addf599d0751c6f`. The others are the
[business-process inventory](business-process-inventory-2026-11-06.md), the
[state-transition and failure-recovery audit](state-transitions-and-recovery-2026-11-06.md)
and the [remaining business decisions](business-decisions-2026-11-06.md). The
findings are in the [findings register](findings-register-2026-11-06.md); what
is left to do is in the [remediation roadmap](remediation-roadmap-2026-11-06.md); and
which differences the fix round removed is at the end, under
[status after the fix round](#status-after-the-fix-round).

A business rule is only as good as its weakest path. This matrix puts the same
concept side by side where two parts of MySenam handle it, says whether they
differ, whether the difference has a reason, and what the audit concluded.
Eight auditors (A to H) each wrote the rows they met; the rows here are merged
and grouped by concept. It is a dated record of one commit: it does not say
what has been fixed since.

How to read it:

- **Different?** Do the two behaviours differ in a way a customer, a venue or
  an accountant could meet?
- **Justified?** *Yes* means a reason is written down (a decision record, the
  feature documents, a known limitation or an owner decision, cited);
  *Partly* means the reason covers some of the difference; *No* means no
  reason was found and the difference is a defect or an oversight;
  *Owner decision* means it is a policy choice not yet taken (see the
  [business decisions](business-decisions-2026-11-06.md)).
- **Verdict** is the audit's conclusion in a few words, with the finding
  where the difference is a defect. A finding is named by the identifier its
  auditor gave it; two auditors who found one defect are written
  `B1=E9=H3`.
- This audit did not run a browser or call a real provider
  ([limits](business-process-inventory-2026-11-06.md#limits-of-the-audit)).

## The same defect found more than once

Where two or more auditors found one defect they are written with `=` in every
record. This is the one place the equivalences are explained.

| Defect | Findings | Note |
| ------ | -------- | ---- |
| One abandoned draft with a ladder (or another unlisted child row) makes the daily retention run fail for ever | A1=H2 | Same cause and same repro shape; A adds that `/api/admin/auth/me` runs housekeeping unguarded, so every staff dashboard load fails |
| Closing a day, a rain-out and an outage cancel and re-offer before the closure exists; new bookings slip in | B1=E9=H3 | B names all three operations and the offers; E9 is the closure race on Postgres; H3 is the closure and rain-out ordering and the offer on a closed day |
| A deposit or friends' shares end up larger than the price after a move or a promo; nothing is owed back | C1=H1 | H adds the promo path; B16 noted the same shape unverified |
| Counter-paid tournament fees are not owed back when the venue calls the event off | C11=F4=H4 | The owner's decision of 29 October names tournaments; H4 adds the withdrawal case, which is deliberate as worded |
| Hire deposits are outside the cash-up and every report | C10=E13=H10 | C and E add that the method of a kept deposit defaults to cash; C adds that the cash-up stores no counted cash |
| A cancelled class leaves its waiting list `waiting` for ever | E12=H9 | H9 is the waiting-list part of E12; E12 adds that the instructor is not told |
| Closing a day or taking a court out cancels and refunds classes already held | B5=E8 | B5 adds that a past date does all this and is then refused |
| Class offers are made after the class has started | B7=E5 | B7 adds that a slot offer's fixed 30 minutes runs past the start; E5 adds that the desk cannot fill the place and the queue is passed down |
| Unpaid class places are never held for payment | B9=E10 | Same finding; E10 notes the docs call it deliberate |
| Booking creation is a chain of commits, with the hold and confirmation last | B10=C16 | G11 is the same gap for the customer's message (related, not the same) |
| A paid booking moved to a cheaper time keeps what was paid | B16=C12=D15 | Documented behaviour; the three ask the same owner question |
| A late cancellation of a pass-paid booking rounds the venue's share against the customer | C14=D14=H6 | H6 adds that the screen states a kept sum while the whole entry is forfeited |
| Entries restored to a pass that has expired or been voided cannot be used | D1=H5 | H5 is the void-with-refund case |
| The revenue report's `outstanding` ignores deposits and shares paid | C8=G4 | G4 adds that `collected` is also understated |
| A payment after the hold lapsed is refunded by hand even when the slot is free | C18=H7 | Documented as deliberate |
| The platform owner's billing actions leave no actor or log entry | A6=G12 | G12 adds the venue API's booking and cancel calls |
| No way for a venue to leave; a suspended venue strands credit, passes and memberships | A5=H8 | H8 also covers the stranded-customer half of A4 |

Related, not the same defect: B2 and E14 (a booking that cannot be cancelled
stops or is skipped by a bulk cancel); B6 and E6 (a class place freed but the
queue not offered it); C3 and D20 (no quoted-price check); C9, D11, D21 and G16
(prepaid value with no notice and no figure for what is owed); C15, D21 and G16
(voucher expiry); A9 and H13 (what the front desk may do); F3 and the closure
group (competition fixtures on a closing day).

## Payment

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| Marking a booking paid at the counter (`setPaymentStatus`): status read inside the serializable transaction | Paying from stored credit or a pass: status read before the transaction, and `claimPayment` guards only `payment_status` | Yes | No | **B3**: credit or entries are taken for a booking cancelled a moment earlier, and never refunded. Online settlement (`settleBill`) reads and writes in one transaction and is sound against a cancel (C, H raced it); the wallet and pass paths are the ones with the gap |
| A court booking at a pay-to-hold venue is held after it commits | A class enrolment online is never held; the same class place claimed from the waiting list is held | Yes | Partly: the class rule is documented ([booking](../features/booking.md), the enrol route's comment); the difference between two paths to one place is not | **B9=E10**; and the hold itself comes after the commit (**B10=C16**) |
| A payment that lands after the hold lapsed on an approval booking: made the booking again where it still can ([payments](../features/payments-and-credit.md)) | The same on an ordinary held booking: owed back, by hand on Billplz | Yes | Partly: documented, with no reason given | **C18=H7**; owner decision |
| A credit or pass payment that fails: the API returns `walletError`, the coach form shows it | The main booking form never shows it; a refused promo or concession still lets the credit settle at full price | Yes | Partly: "best-effort" is deliberate ([payments](../features/payments-and-credit.md)); its consequences are not discussed | **C4**, **C3** |
| Online payment records for passes, memberships and coach pages: `page_closed_at`, release on failure | Booking pages stay `pending` for ever; only the 24-hour window ends their effect | Yes | Yes: acceptable (H) | No finding |
| Refund of online money through Stripe: automatic or one click | Billplz: by hand, and MySenam does not collect the bank details | Yes | Yes: accepted for a small launch ([known limitations](../roadmap/known-limitations.md), accepted) | Deliberate; the owner question of how the customer is told and paid is open (DEC-24) |
| Prepaid value in the consolidated e-invoice: a pass is the sale, the booking it pays is not a row | Stored credit and vouchers: sold at top-up and the booking paid from them is a row too, though the journal marks credit "owed to customers" | Yes | No | **C2**: sales over-reported (RM130 for RM30). The tax treatment of prepayment is unverified |
| Overdue invoices: the platform holds a venue off the marketplace | A company account stays bookable on credit while its invoices are overdue; no reminder | Yes | No | **C7** |
| The amount a gateway reports | `settleBill` compares nothing: `paid` is the gateway's state | n/a | Unverified | **C19**: check with the Billplz sandbox |

## Cancellation

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| Venue cancels something already played: a booking is refused (`CANCEL_PLAYED`), and the rain-out skips finished bookings | A class has no check; an outage's `affectedBy` lists today's finished bookings and then fails | Yes | No | **B5=E8** (classes), **B2** (outage cannot be created from today if one booking was played) |
| Cancellation terms when a series is cancelled: changed terms are detected (`SERIES_CHANGED`) | A single booking: the live terms at the moment of cancelling, nothing stored | Yes | No | **B12**; the same question for benefits is D6 under *Price change* |
| Late-cancel share on cash, credit and online money: pro rata to the sen | A pass: whole entries, rounded down | Yes | Partly: entries are indivisible; the customer is not told | **C14=D14=H6** |
| Late cancellation of a booking: the venue's cutoff and late share | An open-game share: no cutoff; a leaver gets the full share back | Yes | Partly: documented as intended ([matchmaking](../features/matchmaking.md)) | **F11**; owner decision |
| Customer cancel: ignores check-in and the door-code reveal | The door code is for a paid, in-window booking only | Yes | No | **E18** (matters where the cutoff is 0 or 1 hour) |
| A venue cancellation: the obligation is written inside the transaction | The customer's message is written after the commit; a crash loses it | Yes | Partly: the obligation survives and the refund is re-run (H calls it acceptable) | **C17**, **G11** |
| A staff cancellation frees the court and sends an offer at once | No path sets a booking, membership or pass back; nothing undoes a mistaken cancel | Yes | Owner decision | **H12** |
| Money-paid booking cancelled: credit note | Pass-paid booking cancelled: a credit note too, with no original receipt, hidden from the journal | Yes | No | **D16** (number gaps in the journal) |
| Class called off: enrolments refunded and told | Its waiting list left `waiting`, nobody told; its instructor is not told; an enrolment racing the cancel survives unrefunded | Yes | No | **E12=H9**, **E1** |
| A lesson's cancellation is emailed to its coach (`notifyCoaches`); a class move tells its coach | A class's cancellation, and a change of instructor, tell no coach | Yes | No | **E12=H9** |

## Refund

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| The venue cancels a booking or a class paid at the counter: owed back in `counter_refunds_owed`, listed for the desk, credit note when handed back | Tournament and league fees, memberships, passes, vouchers voided or called off: nothing owed, no list | Yes | No: the owner's decision of 29 October 2026 names a class or tournament called off ([known limitations](../roadmap/known-limitations.md), accepted) | **C11=F4=H4**; the table is bookings-only (`booking_id NOT NULL`) |
| A cheaper coach: the difference refunded, receipts credited | A booking moved to a cheaper time with a deposit paid: nothing returned | Yes | No | **C1=H1** |
| Manager price adjustment: refused below what deposits and shares paid (`P8B_ADJUST_BELOW_PAID`) | Reschedule and promo: allowed below it | Yes | No | **C1=H1** (the guard exists in one writer of `total_price`, not the other two) |
| An online page that came down in price while open: the difference owed back | A paid booking moved to a cheaper time: kept | Yes | Partly: documented (a paid week keeps what was paid) | **B16=C12=D15**; owner decision |
| Pass entries returned to a pass that has expired or been voided | Credit returned to a live wallet; a promo's use released | Yes | No | **D1=H5** |
| An entry withdrawn before the draw: online money owed on a staff list, by the rule's own wording | Venue-initiated cancel: refunded through the gateway automatically | Yes | Yes: a customer's own withdrawal follows the venue's policy | Sound; counter money in the withdrawal case is the open half of **C11=F4=H4** |
| Gateway refund made: nothing said to the customer | Cancellation says "will be refunded" | Yes | No | **G13**: no message when the refund is made, fails or is late |
| A membership void: all or nothing (nothing prorated) | A pass void: the unused share refunded | Yes | Partly: documented ([pricing](../features/pricing.md)) | **D22** |
| Box-league removal by staff or a league closed mid-season | A fee paid online is not set owed back; a counter fee has no record | Yes | Unclear | **F12** (read, not run) |
| Company credit notes: allocated whole, oldest first, stopping at the first that does not fit | Refunds and receipts elsewhere settle to the sen or part-pay | Yes | Partly: "whole" is stated in the docs | **C6**; invoices cannot be part-paid either |
| A credit note's amount: JavaScript `roundMoney` | The amount owed back: SQL `ROUND`; they differ by 1 sen at half-sen inputs | Yes | No | **C13** |

## Eligibility

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| Review invitation: any confirmed, not-no-show booking | Review submission: paid or checked in; and the invitation is deduped once per venue and number | Yes | No | **D5**: a dead link, and never invited again |
| A blocked number: booking, waiting list, open games and matchmaking refuse it | The door code, QR check-in and existing bookings ignore it | Yes | No: the owner's decision of 28 October says nothing overrides a blocked number ([ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md)) | **E2** |
| A sign-off is checked at booking (`SIGN_OFF_NEEDED`) | An induction is checked only at the door | Yes | No | **E3**: the customer finds out at the door, paid |
| A sign-off written by an approval: revoking it flags the person's bookings and tells them | A plain sign-off or an induction: revoking does nothing to bookings; staffed hours have no check | Yes | No | **E4** (rosters' "nothing cancelled, nobody told" is deliberate, ADR 0036, and is not this) |
| The unpaid-bookings brake and the house rules: "the number and the account" | The unpaid brake counts the typed number only; the guest brake exempts signed-in users | Yes | Partly: "a brake" is stated; the account bypass is not | **B8** |
| Customer sign-up and reset answer alike for any address (S21, S22) | Venue sign-up says an email already has an account; staff look-ups by phone or email return names from the whole platform with no limit | Yes | No | **A12**, **A2** |
| Cancelling a guest booking: the code and phone on the booking page | An account with the same typed email sees and may cancel it | Yes | Partly: owner decision | **G20** (smaller points) |
| A tier prices a member at its percentage of the public rate | A court's member rate | Yes | No | **D19**: a tier can price above the member rate, with no warning |
| Pass products carry sport, coach, length and validity | Nothing restricts a pass to off-peak, days or courts; the loyalty hour is the same | Yes | No | **D8** (missing capability) |
| League: entry any time | Tournament: entry cut-off is optional, with no implicit stop at the start | Yes | No | **F7** |
| Minors' names on tournament, league and ladder pages: the short form | A known limitation says the main tournament page shows them in full | Docs conflict | No: the code shortens; the limitation is stale | **F13** (rule 9 of the project's documentation rules) |

## Check-in

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| A desk check-in: a staff act that clears a no-show on purpose | A customer's own QR tap uses the same function, clears the desk's no-show, freezes a class move and re-labels a lesson as held for coach pay | Yes | Partly: self check-in is deliberate for the headcount ([venue operations](../features/venue-operations.md)); the consequences are not | **E7** |
| One `check_ins` row serves headcount, strikes and "attendance taken" | The register's marks feed nothing but their own reports (by design) | Yes | Yes for the register; a class move counts a check-in rather than a register mark (accepted, [known limitations](../roadmap/known-limitations.md)) | Part of **E7** |
| The door-code reveal is the arrival and checks in | A blocked number still gets the code | Yes | No | **E2** |

## Rescheduling and changing a booking

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| A series' price is worked out per week | Hours, a closed weekday, court rules and dated hours are checked for the first date only | Yes | No: ADR 0027 says the date asked about decides | **B4** |
| A new booking gets the last-minute discount | A reschedule prices the new time with no booking time, so the discount never applies there | Yes | No | **B11** |
| An unpaid booking moved keeps a discount as an amount (decided 27 October 2026, [pricing](../features/pricing.md)) | The amount can take the new price to RM0, or leave a percentage code worth less than promised | Yes | Partly: the amount-keeping is decided; the RM0 outcome is not discussed | **D3**; owner decision |
| A manager's price adjustment is refused on an invoiced booking (`P8B_ADJUST_INVOICED`) | Reschedule reprices it, so the issued invoice drifts from its lines | Yes | No | **C5** |
| A lesson move re-keys and abandons the unsent reminder | A court reschedule or cancel leaves the reminder: sent for a cancelled booking, none for the new time | Yes | No | **G7** |
| An open game with players is never moved behind their backs | n/a | No | Yes | Sound (F) |
| A lesson moved by staff keeps its price | n/a | No | Yes: decided ([programmes](../features/programmes.md)) | Sound (B) |

## Notification

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| Urgent news (`URGENT_KINDS`, `whatsapp-credit.ts`): sent by WhatsApp, the platform pays | The daily cap (`UNCAPPED_KINDS`, `outbox.ts`) omits most of those kinds, so after 8 messages they are written off | Yes | No: two lists for one concept | **G9** |
| Marketing consent checked when a campaign is queued | Not checked when it is sent; a campaign queues ahead of transactional mail, oldest first | Yes | No | **G8** |
| The outbox retries five times over about 2.6 hours | A provider outage longer than that abandons every waiting message; resend is per message | Yes | No | **G1** |
| The platform's message list masks account links (`listPlatformMessages`) | The venue's list returns the stored body, link and all; the front desk can read a manager invitation's link | Yes | No | **A3**: desk to manager escalation during an email outage |
| Cancelling by the venue notifies customers | Suspending a venue notifies only staff; customers with bookings, passes, credit hear nothing | Yes | Partly: "bookings stand" is stated ([marketplace](../product/marketplace.md)); the silence is not | **A4**; owner decision |
| Booking confirmation, cancellation, reminder | Expiry of a pass, voucher or membership, renewal reminders, strikes: nothing | Yes | No | **D11**, **G16** |
| Ladders, leagues and bookings tell the person affected on a staff decision | A tournament disqualification, withdrawal or forfeit by staff: only the promoted waiting-list entrant is told | Yes | No | **F5** |
| Youth reports email staff and escalate, with review dates and appeals | Adult reports and the automatic suspension: no alert, no escalation, no appeal, and the owner cannot read the reports behind it | Yes | Partly: youth care is by decision (ADR 0052); adults have none | **F8**, **F2** |
| A waitlist offer is emailed | A lapse is silent: the entry leaves the queue untold | Yes | No | **B13** |
| Cancellation text says "will be refunded" | A refund made, failed or late | Yes | No | **G13** |
| The platform warns an overdue venue at due plus 7 days | The monthly invoice itself is never sent to the venue | Yes | No | **G14** |
| A coach is emailed by `notifyCoaches` for lessons created in the last 2 days | A coach whose email is added later never hears of earlier ones | Yes | No | **E16** |
| Classes have a coach-conflict worklist (`classCoachConflicts`) | A lesson with an absent or retired coach has none | Yes | No | **E11** |
| A customer's booking confirmation is written inline after the commit | Waiting-list offers and reminders are swept; a confirmation lost in a crash is never found again | Yes | Partly: documented trade-off in `outbox.ts` | **G11** |

## Expiry

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| Membership benefits are judged on the session's date (`membersOnlyRefusal`) | A pass is judged against today (`passBlocked`), not the date it pays for | Yes | No | **D4**; owner decision |
| Holds expire and release; offer claims expire in the database itself | Pass and membership validity ignores a suspension; renewals at the gateway are not stopped | Yes | Unclear | **A4**, **D12** |
| Family cover limit and the suspension-extension flag are copied onto the term at sale | A tier's price percentage, window, scope and entry flag are read live, so editing the tier changes a term already paid for | Yes | Partly: stated in [pricing](../features/pricing.md) ("applies to its members from then on") | **D6**; owner decision |
| A membership's suspension extension refuses to overlap a later term (`laterTerm`) | "Give days back" (`extendMembership`) does not ask | Yes | No | **D7** |
| Gift voucher: 12 months | Credit never expires; a pass expires with no refund | Yes | Owner decision | **C15**, **D21**, **G16** |
| An offer lasts 30 minutes whatever the hour or the time to the start | A class offer after the start; a slot offer that outlives the start | Yes | No | **B7=E5**, **B13** |
| Entries (gym and day passes) use the venue's time zone for "today" | Passes and memberships use the install's zone | Yes | Yes for a one-country install | D noted a risk if Singapore is added beside Malaysia |
| A tournament with an entries-close date closes on it | A tournament without one takes entries after its last day and holds courts until then | Yes | No | **F7** |

## Permissions

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| Staff accounts: allow by role and place (`mayManage`) | Front desk against manager: a deny-list (`MANAGER_ONLY`); a new route is desk-open until someone lists it | Yes | Partly: "anything not on that list is open to front desk" is stated ([tenancy](../architecture/tenancy.md)); the omission risk is not | **A9** |
| Closing a day, an outage and blocking a number are manager-only | A rain-out over every court is the same bulk cancel and refund and is open to the desk | Yes | Partly: documented | **H13**. (B's inventory lists closures as desk or manager; `roles.ts` lists the closures route as manager-only) |
| A customer's data is reached through the customer's own account | Any venue staff account, including a self-registered draft, can look a customer up platform-wide by email or phone | Yes | No | **A2** |
| Owner suspensions are logged; refunds record the admin | Marking an invoice paid, voiding it, setting fees and tiers, grouping venues and promoting staff record nothing | Yes | No: allow-listed as "the platform owner's own records" in a test, not decided in an ADR | **A6=G12** |
| Staff two-factor: each account chooses unless `MYSENAM_STAFF_2FA` is set | The owner approves venues and marks invoices paid | Yes | Partly: documented as optional | **A10** |
| Removing a manager ends their sessions and OAuth grants | Their API keys and webhook secrets keep working | Yes | No | **A13** |
| Venue actions are visible to the venue's managers in the activity log | Business-level staff changes are logged with no venue; only the owner reads them | Yes | No | **A8** |
| Desk, MCP, class and counter actions are logged | API-key bookings and cancels are not | Yes | No | **G12** |
| Bookings can be corrected (`booking-corrections.ts`) | A pass or membership cannot: wrong phone, wrong account, wrong entry | Yes | No | **D10** |
| Staff two-factor tickets: attempts counted | After the check, so parallel requests pass the cap | Yes | No | **A14** (unverified) |

## Closure and venue lifecycle

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| An outage loops until the court is clear, then closes it in one transaction (recorded as fixed under B4 in [known limitations](../roadmap/known-limitations.md)) | A day closure and a rain-out cancel first and write the closure or block last; no re-check; the waiting list is offered the closing day | Yes | No | **B1=E9=H3**. H lists the outage as sound; B shows its loop fails on a played booking (B2) and on an offered slot |
| The booking path refuses a closed or blocked day | `offerSlotPlace` and `offerClassPlace` never look at closures, blocks or outages | Yes | No | **B1=E9=H3** |
| Ladder court-time holds: players told when an outage loses them (`tellLostHolds`, ADR 0048) | Tournament matches and team-league fixtures: blocks released, nobody told, the manager not warned, no way to postpone a day | Yes | No | **F3** |
| A booking with kit still out is refused by `venueCancel` | A rain-out and a closure skip it silently; an outage fails with "bookings keep arriving" | Yes | No | **E14**, **B2** |
| A class called off: enrolments cancelled in a transaction | The roster is read before the transaction and without the class lock, so a racing enrolment stays confirmed | Yes | No | **E1** (Postgres only) |
| Drafts are purged after 90 days with their data | Live venues can never be removed; a suspended venue strands credit, passes and memberships | Yes | No | **A1=H2**, **A15** (the purge can delete counter receipts), **A5=H8** |
| The web grid, search and booking route release lapsed holds on the way past | The venue API's availability and booking do not, for up to a minute | Yes | Minor | **B15** |
| An owner suspension survives a payment; a payment hold heals itself | `liftVenue` answers "not suspended" for a payment hold; the owner can only mark paid or void | Yes | No | **A7** |
| The venue-level billing hold is derived from invoices | An auto-approved branch checks only that another branch was ever published | Yes | No | **A11** |

## Waiting list and offers

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| `customerCancel` and `adminCancelBookingOnce` offer a freed class place with `offerClassPlace` | `cancelSeries` and `releaseExpiredHolds` call `offerSlotPlace`, so the class queue is never offered the place | Yes | No | **E6** (and the same line in B10) |
| One live offer per court and day, documented as intended | It blocks an independent slot the same day, and a claimed offer never triggers the next | Yes | No: the claim row already prevents overlap | **B6** |
| Class offers: one at a time | Several places may be free | Yes | No | **B6** |
| A waitlist offer holds court time until the claim or 30 minutes | A class offer counts as capacity, so the desk turns away a walk-in while the offered person is on the way | Yes | Partly | **E5** |
| A cancelled class closes its enrolments | Its waiting entries stay for 90 days, listed on the customer's account | Yes | No | **E12=H9** |
| An unanswered offer drops the person from the queue | n/a | No | Yes: deliberate (H) | Sound |
| Waitlist claim at a venue gone unlisted: the entry waits and the offer passes on | n/a | No | Yes | Sound (existing test) |

## Deposit

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| The sales journal and the cash-up count deposit receipts | The venue report's `collected` ignores deposits and shares; `outstanding` stays at the full price | Yes | Partly: the doc says deposits are not in the report; it does not say the journal counts them | **C8=G4** |
| A deposit never exceeds the price (the docs: a receipt is never credited for more than it was) | Moving a deposit-paid booking cheaper, or a promo, leaves the deposit above the price | Yes | No | **C1=H1** |
| A hire deposit is a record in `hire_records`, deliberately not a wallet movement ([venue operations](../features/venue-operations.md)) | The till holds it: no cash-up line, no method at handover, kept money defaults to cash | Yes | Partly: the wallet argument does not cover the till | **C10=E13=H10** |
| Open-game shares are owed back in full when a player leaves, is removed or the booking is cancelled | A booking's late-cancel share applies to the host's own part only | Yes | Partly: documented | **F11** |

## Price change

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| The server charges the price at that moment | No path takes an expected total from the quote; a rate edit, tier edit or lapsed code changes the charge silently | Yes | No | **D20**, **C3** |
| Concessions and promo codes are never applied to fees | A pass pays the whole booking, fees included | Yes | Undecided | **D9** |
| The booking form lists passes newest first | The counter lists oldest first; the gym entry desk soonest-expiry first | Yes | No | **D18** |
| History is sound: stored `total_price`, tax rate and amounts drive receipts and reports | n/a | No | Yes | Sound (D) |
| The journal counts receipts by payment date, less credit notes | The report counts booking price by played date, netting credit notes only for late cancellations; a goodwill adjustment is missed | Yes | Partly: the basis differs by design; adjustments, deposits and passes are not explained | **G3**, **G4** (=C8), **G5** |
| The report's `tax` excludes pass-paid bookings | Its `collected` includes them | Yes | No | **G5** |
| The report's liabilities: pass entries in hours, counts of memberships, credit shown apart | No ringgit for vouchers, refunds owed, counter refunds owed, account credits waiting, hire deposits held | Yes | No | **C9**, **G16** |
| The sales-journal CSV guards text cells against formulas | The same guard turns every negative amount into text (`'-40.00`) | Yes | No | **G2** |
| "Spent" in the customer report | Counts unpaid, no-show and pass-paid bookings at face value | Yes | No | **D17** |

## Standing and strikes

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| Strikes, blocks, notes, concession proofs and review slots are keyed on the phone number | Numbers are recycled and families share a phone; a guest can type a victim's number | Yes | Partly: the number as identity is a stated principle (ADR 0026, `limits.ts`); the consequences are not | **D13**; owner decision |
| A desk no-show is visible and can be forgiven by a manager | A host's no-show mark on an open game is silent, cannot be cleared, and bars the player platform-wide after three | Yes | Partly: documented as a feature ([matchmaking](../features/matchmaking.md)); notice and undo are not | **F6** |
| A strike is recorded | The customer is not told, and learns when the next booking is held or refused | Yes | No | **D11** |
| A ladder's ignored challenge forfeits after 3 days, with a challenge email and a result email | A tournament's player-reported walkover stands after 24 hours of silence | Yes | Partly: owner decisions of 4 November 2026 ([known limitations](../roadmap/known-limitations.md), forfeits) | **F9**, **F10** |
| Youth restriction: review date, appeal, escalation | Adult automatic suspension: none of these | Yes | Partly: youth by decision | **F2** |
| Venue-initiated cancellations are not strikes | n/a | No | Yes | Sound (D) |
| A customer note is overwritten or erased with no history | Other staff records keep before and after | Yes | No | **D24** |

## Audit trail, idempotency and retention

| Concept in one place | Concept in another | Different? | Justified? | Verdict |
| -------------------- | ------------------ | ---------- | ---------- | ------- |
| Receipts and e-invoices kept for 7 years; erasure anonymises the booking | The staff activity log is kept for 2 years and a failed write goes to the console; `online_payments` payer name and phone are never touched; messages and webhook payloads keep the person for 90 and 30 days | Yes | No | **G6**, **G20** |
| Refunds, invoices and e-invoices are idempotent by key or claim | The loyalty grant is idempotent by a marker written afterwards; WhatsApp credit is spent before the send | Yes | No | **G19**, **H11**, **G20** |
| A scheduler job fails inside its own `try` and alerts | `tickOutbox` runs its preparatory steps unguarded before draining; every route that awaits it can answer 500 | Yes | No | **G10** |
| E-invoice submission is claimed and never resent blindly | A failing venue stops the loop for every venue; a month is consolidated only on days 1 to 7; `failed` is not retried or alerted | Yes | No | **G15** |
| The stale-draft purge runs inside the retention transaction | One undeletable draft rolls back every retention rule daily, and `me` runs it unguarded | Yes | No | **A1=H2** |
| Webhooks: signed, claimed, switched off after a day | Exhausted events are never redelivered; resuming replays nothing | Yes | No | **G17** |
| A scheduler lease renewed by a timer | A long backup and off-site upload sits in the same tick as the outbox and refund jobs; work is not cancelled if renewal fails | Yes | No | **G18** |
| The retention run is once a day | An unlisted FK blocks it; no per-business savepoint | Yes | No | **A1=H2** |

## Where the auditors disagreed

Four places where two auditors' notes did not agree were checked in the code.

| Question | The notes | What the code says |
| -------- | --------- | ------------------ |
| Can a customer still pay an existing booking at a suspended venue? | A: online payment is refused and a held booking lapses. H: "suspension keeps bookings and pages payable: sound" | A is right for starting a payment: `startBookingPayment` returns "is not taking payment online at the moment" when `isOpen` is false (`payments.ts`). Confirmed bookings and online refunds are unaffected, as both say |
| Is a payment against a cancel safe? | C and H: sound, raced on Postgres. B: credit and pass payments race a cancel | Both hold. C and H raced the online settlement, which reads and writes in one serializable transaction. B3 is in the credit and pass paths, where `claimPayment` is `UPDATE ... WHERE payment_status = 'unpaid'` with no status guard and the status is read before the transaction |
| Who may close a day? | B's inventory: desk or manager. H13: manager | `roles.ts` lists `/api/admin/venues/<id>/closures` and `/api/admin/outages` as manager-only; a rain-out is not listed and is open to the desk. H is right |
| Is an outage sound? | H: loops until clear, then closes. B: the loop fails after cancelling | Both: it does loop and re-check bookings (the 28 October fix), and it fails on a played booking, a booking with kit out and a live waiting-list offer, after the others were refunded (**B2**, **B1=E9=H3**) |

## Status after the fix round

*Added after the fix round that followed this audit; the matrix above is unchanged
and describes the baseline commit.* Where each finding stands is in the
[findings register](findings-register-2026-11-06.md); what is left is in the
[remediation roadmap](remediation-roadmap-2026-11-06.md). The fixes were verified by
new tests by their authors (PGlite, and Postgres for races and money); the lead's
validation is in [testing](../development/testing.md#release-records). A removed
difference means two paths now do the same thing, not that either was run against a
real provider: payment, message, e-invoice and subscription rows stay
`INTEGRATION_VERIFICATION_REQUIRED`.

Of the matrix's rows, those whose verdict was a defect are listed below as removed,
narrowed or remaining; rows that were already sound, deliberate or "no finding" are
unchanged and not listed.

| Concept | Difference removed (findings) | Difference narrowed or remaining (findings) |
| ------- | ----------------------------- | ------------------------------------------ |
| Payment | Credit or pass payment now decides on the booking's status in the paying transaction, as the counter does (B3). A failed credit or pass payment and a refused promo no longer settle at full price or hide (C3, C4). An unpaid booking whose request died is held or let go by the scheduler (B10 = C16). Company accounts that are overdue are seen, reminded and may be blocked (C7) | A payment after the hold lapsed is still refunded by hand where an approval's would be revived (C18 = H7). Class places are held when claimed from a waiting list and not when enrolled directly (B9 = E10). Prepaid value in the consolidated e-invoice (C2). The amount a gateway reports is unchecked (C19) |
| Cancellation | A venue no longer cancels what was played: bookings and classes alike (B2, B5 = E8). A class called off refunds, tells and closes its waiting list, and tells its coach as a lesson's cancellation does (E1, E12 = H9). A venue's cancellation and a customer's message are written with the fact or swept (C17, G11) | Terms are read live at cancellation (B12). A pass-paid late cancel rounds against the customer (C14 = D14 = H6). Open-game shares ignore the venue's cutoff (F11). A customer can cancel after the code was revealed (E18). A staff cancel cannot be undone (H12). A credit note is written for a pass-paid booking (D16) |
| Refund | Counter fees are owed back when a tournament is called off or an entrant is taken out before the draw (C11 = F4 = H4). A cheaper move, a promo or a concession owes a deposit's excess back and refuses friends' shares, so the three writers of the price share the manager adjustment's rule (C1 = H1). Entries given back to an expired pass reopen it, and a voided pass's entry is credited (D1 = H5). The customer is told when a refund is made, fails or is late, by email (G13). Company credit is taken off part by part (C6) | A paid booking moved cheaper keeps the price paid, and an online page's price coming down is owed (B16 = C12 = D15). A membership void is all or nothing (D22). A box league's fee on a staff removal (F12). Half-sen rounding between JavaScript and SQL (C13). A refund on a payment with no booking cannot be told to the customer |
| Eligibility | A blocked number loses the door and self check-in (E2). An unstaffed slot asks for the sign-off or certification at booking (E3). Taking back a sign-off or induction flags and tells (E4). The unpaid brake counts the account (B8). The review invitation asks the question the link asks (D5). Venue sign-up and staff lookup no longer reveal who has an account, apart from the throttled linking flows (A12, A2) | An induction is told at booking, not refused; a certification's expiry is not warned (E3, E4). A tier can price above the member rate (D19). Passes cannot be limited to off-peak or courts (D8). League entry with no start (F7, tournaments only). Minors' names on a tournament's main page (F13). A guest booking found by email (G20) |
| Check-in | A self or door check-in is recorded as such and is not verified attendance until staff confirm it: it does not clear a no-show, freeze a class move, or count a lesson as held (E7) | The desk can still check in a refused number (E2) |
| Rescheduling and changing a booking | A weekly series is checked against each week's hours (B4). A reminder follows a move or a cancel (G7). A cheaper reschedule of an invoiced booking is a credit on the account (C5, in part) | A moved booking loses the last-minute discount a fresh one gets (B11). An unpaid booking keeps a discount as an amount (D3). A dearer reschedule of an invoiced booking is reported, not billed (C5) |
| Notification | One urgent list, uncapped by the daily limit (G9). Campaigns yield to transactional mail and respect withdrawn consent (G8). A provider outage is waited out up to seven days (G1). Account links are masked in every staff list (A3). A suspension tells customers (A4). Staff decisions on a tournament entry are told (F5). An offer's lapse is told, by email (B13). The platform invoice is told on issue and before due (G14). Adult-thread reports are told to managers (F8, in part) | Expiry, renewal, strikes and low balance send nothing (D11, G16). A coach is told only of recent lessons (E16). Lessons have no coach-conflict worklist (E11). Reports in adult threads cannot be escalated and the reporter is not told the outcome (F8). WhatsApp has no template for the lapse and refund notices |
| Expiry | A pass is judged on the session's date, as a membership is (D4). Giving days back never runs a membership into its next term (D7). An offer lasts no longer than the time to the start (B7 = E5). A tournament without a closing date stops taking entries after its first day (F7) | The suspension of a venue does not extend validity (A4). A membership's benefits are read live while cover is snapshotted (D6). Gift voucher expiry (C15, D21, G16) |
| Permissions and audit | Every admin route is classified in one table (A9). Staff lookups are scoped to the venue's customers (A2). The owner's billing, grouping and approval actions, and an API key's bookings, are logged (A6 = G12). A business's managers read business-level changes (A8) | Two-factor is opt-in (A10). Removing a manager leaves API keys live (A13). Ticket attempts are counted after the check (A14). The desk may rain out a whole afternoon (H13). A pass cannot be corrected at the desk (D10, partly: a manager can extend) |
| Closure and venue lifecycle | A closure, rain-out and outage are written first, leave the played alone and name what was skipped (B1 = E9 = H3, B2, E14). A class called off locks its roster first (E1). Fixtures drawn on a lost court are shown, told and postponable (F3). The owner can give an overdue invoice time without marking it paid (A7). A branch is judged on its open siblings (A11). The draft purge skips what it cannot delete (A1 = H2) | A venue cannot be closed for good (A5 = H8). The draft purge still deletes counter receipts (A15). The venue API releases lapsed holds only at the minute (B15). Waiting entries on a closed day stay waiting |
| Waiting list and offers | Freed class places from a term cancel or a released hold reach the class list (E6). Court-time offers are per time (B6, in part), capped at the start (E5), and a cancelled class closes its list (E12 = H9) | Class queues still offer one place at a time (B6) |
| Deposit | The report counts deposits and shares like the journal (C8 = G4). A deposit never ends above the price (C1 = H1). Hire deposits are in the cash-up by method (C10 = E13 = H10) | Open-game shares are owed back in full (F11) |
| Price change and reports | The booking can carry the price the customer saw (C3, D20). The report's money is the journal's, a pass-paid booking is shown apart, adjustments and liabilities are reported, and the CSV writes negatives as numbers (G3, G5, C9, G2) | "Spent" in the customer report counts unpaid (D17). Concessions and codes are not applied to fees, a pass waives a fee (D9). The booking form lists passes newest first (D18) |
| Standing and strikes | An automatic suspension of an adult can be reviewed: the owner reads the reports, it lifts when fewer than three remain, the person can ask (F2) | Strikes follow the phone number (D13). A host's no-show mark is silent (F6). A silent strike (D11). A customer note is overwritten (D24). Ladder challenges are reminded once (F9, fixed); a reported walkover still stands after 24 hours (F10) |
| Audit trail, idempotency and retention | Erasure reaches payments, messages and webhook deliveries (G6). WhatsApp credit is spent once per message (H11). The tick's steps and each venue's e-invoicing are isolated (G10, G15). The retention run no longer stops for one draft (A1 = H2) | The loyalty grant is not idempotent (G19). Exhausted webhooks are never redelivered (G17). A long backup pauses the tick (G18). The activity log is kept for two years (G20) |

Rows whose verdict was "Owner decision" stay undecided except where a fix is listed
above; the status of each decision is in the
[status per decision](business-decisions-2026-11-06.md#status-after-the-fix-round).
