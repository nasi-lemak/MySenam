# Business-process inventory, 6 November 2026

The first of four records of the business-process audit of MySenam at commit
`2aabdd406626c9f1bdbd32e65addf599d0751c6f` (6 November 2026): every business
workflow the auditors found, who starts it, where it enters the system, the
states it moves through, and how far the audit followed it. The others are
the [cross-domain consistency matrix](cross-domain-consistency-2026-11-06.md),
the [state-transition and failure-recovery audit](state-transitions-and-recovery-2026-11-06.md)
and the [remaining business decisions](business-decisions-2026-11-06.md). The
findings are collected in the [findings register](findings-register-2026-11-06.md)
and what is left to do after the fix round is ordered in the
[remediation roadmap](remediation-roadmap-2026-11-06.md); the
[status after the fix round](#status-after-the-fix-round) is at the end.

This is a dated record. It says what was inventoried and how far each part was
examined at that commit; it does not say what is fixed now. Findings are cited
by the identifiers the auditors gave them (A1 to A15, B1 to B16, C1 to C19,
D1 to D24, E1 to E19, F1 to F14, G1 to G20, H1 to H13); a finding found by two
or more auditors is written `B1=E9=H3`, and
[the equivalences](cross-domain-consistency-2026-11-06.md#the-same-defect-found-more-than-once)
are listed once, in the consistency matrix.

## Method

- **Baseline.** Commit `2aabdd406626c9f1bdbd32e65addf599d0751c6f`, the end of
  round 13 (6 November 2026).
- **Eight auditors, one letter each.**

| Auditor | Area |
| ------- | ---- |
| A | The marketplace lifecycle (sign-up, going live, billing, suspension, closure, deletion), and tenancy, roles and permissions |
| B | The court-reservation core: booking, holds, payment on a booking, waiting lists, rescheduling, cancelling, closures, outages, hours, time |
| C | Money: online payment, refunds, credit, pricing at the point of payment, tax, documents, company accounts, hire deposits, cash-up, e-invoice consolidation |
| D | Memberships, passes, entitlements, pricing rules, discounts, loyalty, customer standing and reviews |
| E | Classes, coaching, venue operations (check-in, door access, hire, waivers, enquiries) and safety (sign-offs, approvals, rosters) |
| F | Competitions (tournaments, leagues, ladders, ratings), matchmaking (open games), player messaging and its moderation |
| G | Customer identities, communications (the outbox, marketing, WhatsApp credit), reports and exports, integrations, the scheduler, privacy and retention |
| H | Adversarial scenarios across modules and the state machines they share; the booking, payment, refund, pass, class, tournament and venue-lifecycle sequences raced against each other |

- **Read-only.** No product code, migration, document or existing test was
  changed. Each auditor read the code of the area, the feature documents,
  decision records and known limitations, and wrote a repro test for each
  defect that could be exercised. A repro asserts the *intended* outcome, so it
  fails at the baseline; a test written to show something is sound passes. The
  repros are working files of the audit, not part of the test suite at the
  baseline.
- **Engines.** Repros ran on PGlite (the development and test database). The
  race tests ran on a real Postgres as well. Three defects (E1, E9 and the
  stress form of B3) show only there, because PGlite serialises the race away;
  F1 was run on Postgres only.
- **What "traced end to end" means.** The auditor followed the workflow from
  its entry point (a route, a library function or a scheduled job) through the
  library code to the database writes and to the effects a person or an
  accountant would see (message, refund, receipt, credit note, log entry),
  reading every step on both the success path and at least one failure or race
  path, and exercised it where a test could. A row marked *traced* may still
  hide a defect the auditor did not think to look for.
- **"Read, not traced".** The code or its documentation was read and the
  workflow is understood, but not every step was followed; claims in the
  documents were taken from them or from existing tests that were not re-run.
- **"Not reviewed".** Nobody looked at it. The reason is given.
- **Merging.** Each auditor listed workflows in their own numbering. The rows
  below merge the eight lists, are numbered `W-001` onward, and take the
  strongest coverage any auditor reached for a workflow; the *Audit coverage*
  column names who covered it and how. A workflow that does not exist (a
  missing capability) is listed where an auditor confirmed its absence by
  search, and counted as traced.

### Limits of the audit

- **No real provider was called.** Email, WhatsApp, SMS, Billplz, Stripe,
  MyInvois, Google sign-in, Xero and off-site storage were exercised only
  through the stand-ins in the test suite. Nothing here is a live check; for
  example, whether Billplz can report an amount that differs from the bill
  (C19) is unverified.
- **No browser walk.** Unlike the [operations audit of 28 October](operations-2026-10-28.md),
  this audit did not run the production build in a browser. Screens were read
  as code. What a customer or staff member sees is inferred, and the findings
  about screens (C4, for one) were found by reading.
- **Existing suites were relied on, not re-run,** except where a row says
  they were (the tenant sweep, the membership-suspension tests, some
  concurrency tests on Postgres).
- **No load, performance or backup-restore test, and no legal assessment.**
  Where a finding turns on a legal or tax view (C2, C15, G6, the youth
  messaging gate), the auditors recorded the question and did not answer it.
- **Time zones.** The design was read and existing tests relied on; no sold
  country changes its clocks, so clock-change behaviour was not exercised.

## The inventory

Coverage: **T** traced end to end, **R** read, not traced, **N** not
reviewed. The last column lists the findings that arose at that workflow.

### Marketplace

How a venue joins, stays on and leaves the shared marketplace, and what the platform bills it.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-001 | Venue sign-up, email confirmation, draft account | Applicant | `submitApplication`, `confirmApplicationEmail`, `/api/venue-applications` | waiting, unsent, confirmed; draft | Traced end to end: A | A12 |
| W-002 | Draft set-up and test bookings, kept or cleared at go-live | Business manager | `lib/test-bookings.ts`, `/api/admin/test-bookings` | test, kept as real, cleared | Read, not traced: A: docs and tests relied on for the money side | A15 |
| W-003 | Ask to go live, owner approval or rejection, auto-approved branch | Manager, owner | `requestGoLive`, `approveApplication`, `rejectApplication`, `/api/admin/go-live` | draft, pending, approved, rejected | Traced end to end: A | A11 |
| W-004 | Stale-draft purge inside the retention run | Scheduler | `deleteStaleDrafts`, `pruneOldData`, `pruneIfDue` | stale, deleted | Traced end to end: A, H | A1=H2, A15 |
| W-005 | Platform invoicing: monthly invoices, tiers, free months, platform tax | Scheduler, owner | `issueDueInvoices`, `startBilling`, `setVenuePlan` | due, paid, void | Traced end to end: A; C read it (flat monthly fee, no commission) | A6=G12, A7, G14 |
| W-006 | Venue pays a platform invoice online, settlement, owed back | Venue manager, gateway | `payInvoiceOnline`, `settleInvoice`, `/api/admin/billing` | pending, paid, owed back | Read, not traced: A: gateway callback not traced | A6=G12 |
| W-007 | Overdue warning, payment hold, lift | Scheduler | `lib/payment-holds.ts` | held for payment (`suspended_by` payment) | Traced end to end: A | A7, G14 |
| W-008 | Owner suspends or lifts a venue or a business | Owner | `lib/suspensions.ts`, `/api/admin/suspensions` | suspended by owner; business suspended | Traced end to end: A | A4, A7 |
| W-009 | What a suspension does to customers' bookings, passes, memberships, credit and enrolments | Customers | `lib/listing.ts` consumers, `payments.ts` `isOpen`, `venueIsOpen` | none (a listing flag only) | Traced end to end: A (every `isOpen` and `venueIsOpen` use), H | A4=H8 |
| W-010 | Close a venue for good, leave the marketplace, delete a live venue | Owner, venue | none exists | none (no closed state) | Traced end to end: A, H (the absence was confirmed by search) | A5=H8 |
| W-011 | Branch copy, add a branch, group venues into a business | Business manager, owner | `addBranch`, `branch-copy.ts`, `groupIntoBusiness` | draft branch | Read, not traced: A: authorisation checked; the copy itself not reviewed | A6=G12 |
| W-012 | Reviews: invitation, writing, moderation | Customer, venue, platform | `reviews.ts` | confirmed, played, reported, hidden | Traced end to end: D | D5 |

### Court reservations

Booking a court and everything that changes a booking afterwards.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-013 | Customer or guest booking: one court, weekly series | Customer, guest | `POST /api/bookings`, `createBookingSeries`, `policyCheck` | confirmed unpaid, held, cancelled | Traced end to end: B | B4, B8, B10=C16, C3, C4 |
| W-014 | Any-court and multi-court group booking | Customer, staff | `createBookingOnAnyCourt`, `createGroupBooking` | all or none | Traced end to end: B | - |
| W-015 | Counter booking and manager overrides | Desk, manager | same route, `policy-overrides.ts` | override recorded | Read, not traced: B | - |
| W-016 | Claims engine: intervals, buffers, linked courts, shared facilities | System | `claims.ts`, exclusion and capacity triggers in the database | active claim, `expires_at` | Read, not traced: B (race tests on both engines pass) | - |
| W-017 | Pay-to-hold: hold, extension on the payment page, release sweep | Customer, scheduler | `holds.ts`, `startBookingPayment`, `scheduler.ts` | `hold_until`, extended, released unpaid | Traced end to end: B, C, H (raced on Postgres) | B10=C16, C18=H7, B15 |
| W-018 | Pay a booking from stored credit or a pass, at booking or later | Customer | `payBookingFromWallet`, `payBookingWithPasses`, `claimPayment` | unpaid to paid | Traced end to end: B; C read the pass part | B3, C3, C4 |
| W-019 | Slot waiting list: join, offer, claim, decline, expire | Customer, desk, API, scheduler | `joinSlotWaitlist`, `offerSlotPlace`, `claimWaitlistOfferOnce`, `expireStaleOffers` | waiting, offered, claimed, expired | Traced end to end: B, H | B6, B7, B13, B1=E9=H3 |
| W-020 | Reschedule: date, time or court, by customer or staff; the price effect | Customer, staff | `rescheduleBookingOnce` | repriced, kept, refused | Traced end to end: B, C, D, H | B11, C1=H1, C5, C12=B16=D15, D3, G7 |
| W-021 | Move a court; weekly-series moves | Staff | `moveBookingOnce`, `series-moves.ts` | moved | Read, not traced: B | - |
| W-022 | Cancel: customer (free, late, give back), staff, strikes | Customer, staff | `customerCancel`, `adminCancelBookingOnce`, `cancel-policy.ts` | cancelled, late cancelled | Traced end to end: B, C | B12, C14=D14=H6, C17, H12, E18 |
| W-023 | Weekly series: cancel, pay, extend | Customer, staff | `seriesCancelPlan`, `cancelSeries`, `paySeries` | weeks confirmed, cancelled | Read, not traced: E followed the class-term end of `cancelSeries`; B did not review the court series (time) | E6 |
| W-024 | Close a venue day | Manager (`MANAGER_ONLY`) | `POST /api/admin/venues/[id]/closures`, `closeVenueDay` | closure row | Traced end to end: B, E, H | B1=E9=H3, B5=E8, E14 |
| W-025 | Court out of service (outage), open-ended or for a range | Manager | `createOutage`, `endOutage` in `outages.ts` | outage and its claim | Traced end to end: B, E, F | B1=E9=H3, B2, E14, F3 |
| W-026 | Rain-out, repeat blocks, one-off blocks | Desk | `rainOut`, `blockSlots` | blocks | Traced end to end: B (rain-out traced; blocks read), E, H | B1=E9=H3, E14, H13 |
| W-027 | Hours, weekday hours, hours and rates from a date, holidays | Manager | `updateVenue`, `dated-changes.ts`, `week-hours.ts`, `holiday-calendar.ts`, `peak.ts` | hours in force by date | Traced end to end: B (hours traced; holidays read) | B4, B14 |
| W-028 | Time: midnight, time zones, clock changes | System | `time.ts`, `interval.ts` | n/a | Read, not traced: B, H: design read, existing tests relied on; no country sold changes its clocks | - |
| W-029 | Booking references and signed links | Customer | `booking-access.ts` | n/a | Read, not traced: B | - |
| W-030 | Staff correction of a booking's name, phone or email | Staff | `booking-corrections.ts` | n/a | Read, not traced: B | - |
| W-031 | Availability grid, search and API availability against the booking path | All | `getAvailability`, `searchAvailability`, `startOptions` | n/a | Read, not traced: B (no differential test written) | B15 |

### Money

Paying, refunding, crediting and documenting money.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-032 | Pay a booking online (Billplz, Stripe): deposit, series bill | Customer | `startBookingPayment`, `settleBill`, `/api/payments/[provider]/callback`, `/payments/return` | pending, paid, refund due; deposit and shares paid | Traced end to end: C, H | C19 |
| W-033 | Callback and redirect idempotency, replay, concurrent settlement | Gateway | `settleBill` claim on `status = 'pending'` | pending, paid | Traced end to end: C, G, H (race tests pass on both engines) | - |
| W-034 | Customer cancellation refunds: free or late share, to credit, pass, online, deposit, shares | Customer | `customerCancel`, `refundBooking`, `noteOnlineRefundDue` | cancelled, late cancelled, credit note | Traced end to end: C | C13, C14=D14=H6, C17, G13 |
| W-035 | Venue-initiated cancellation refunds: closure, outage, rain-out, class, tournament | System, staff | `refundCancelled`, `refundOwedByVenue`, `venueCancel`, `cancelTournament` | owed, refunded, counter owed | Traced end to end: C (bookings and tournaments traced; classes read) | C11=F4=H4, B1=E9=H3, B5=E8 |
| W-036 | Gateway refund: claim, crash recovery, reconciliation, daily digest | Scheduler, staff | `refundOnline`, `settleRefundClaims`, `reconcileRefunds`, `markRefunded` | claimed, pending, made, failed, by hand | Read, not traced: C, G, H: existing `refund-crash` and `refund-recovery` tests relied on, not re-run | G13 |
| W-037 | Manual (Billplz) refund and escalation | Staff, platform | `markRefunded`, `overdueRefunds`, `refundWorkload` | owed, overdue, marked | Read, not traced: C | C18=H7, G13 |
| W-038 | Disputes and chargebacks, also on platform invoices | Gateway, staff | `recordDispute`, `disputeLost`, `takeBackWhatItBought` | open, lost, won | Traced end to end: C (refund then chargeback tested) | - |
| W-039 | Stored credit: top-up (counter, online), spend, refund, per-venue pots | Customer, desk | `topUpWallet`, `refundBookingToWallet`, `findUserForWallet` | wallet ledger | Traced end to end: C (race test), A (look-up) | A2 |
| W-040 | Gift vouchers: sell, activate, redeem, void, expire | Customer, desk, manager | `vouchers.ts`, `/api/my/vouchers` | pending, active, redeemed, expired, void | Traced end to end: D; C read it | C15, D21, G16 |
| W-041 | Money effects of a price change after payment: deposit, shares, paid booking moved, lesson | Customer, staff | `rescheduleBookingOnce`, `applyPromo`, `price-adjustments.ts` | `priceChange`, uncharged difference | Traced end to end: C, D, H | C1=H1, C12=B16=D15, D3 |
| W-042 | Tax: inclusive SST and GST, rounding, platform tax on top | All | `tax.ts`, `documents.ts`, `reports.ts` | rate stored per booking | Traced end to end: C (rounding analysed) | C13 |
| W-043 | Receipts and credit notes | Desk, manager | `documents.ts` | receipt, credit note | Traced end to end: C, D | D16 |
| W-044 | Company or school account: charge, invoice, credit notes, pay, withdraw | Desk, manager | `accounts.ts`, `/api/admin/accounts/*` | uninvoiced, invoiced, paid; credit waiting, applied, settled | Traced end to end: C; H read it | C5, C6, C7 |
| W-045 | Counter payment, money owed back at the counter, payouts | Desk | `counter-refunds.ts`, `setPaymentStatus` | owed, settled | Read, not traced: C (partly traced; existing tests) | C11=F4=H4 |
| W-046 | Membership and pass purchase online, owed back when it buys nothing | Customer, guardian | `makePaidMembership`, `passForPayment`, `membership-purchases.ts`, `pass-purchases.ts` | pending, issued, owed back | Read, not traced: C, D | - |
| W-047 | Tournament and league fees: online and counter, withdraw, call off | Player, desk | `settleBill` entry and league branches, `setEntry`, `takeOut`, `cancelTournament` | `paid_at`, refund due | Traced end to end: C (counter side), F, H | C11=F4=H4, F12 |

### Prices

How a price is worked out and changed.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-048 | Quote, charge, stored price, receipt | Customer, staff | `quoteFor`, `createBookingSeries`, `bookingSale` | `total_price` stored | Traced end to end: D, C | C3, D20 |
| W-049 | Peak, holiday, last-minute, per-player, fixed and step prices | System | `pricing.ts`, `peak.ts`, `time.ts` | n/a | Read, not traced: D (arithmetic read; `pricing.test.ts` not re-run) | B11, D19 |
| W-050 | Manager price adjustment, complimentary booking, counter price override | Manager | `price-adjustments.ts`, `counter-prices.ts` | adjusted, paid | Read, not traced: D; B did not review it (pricing domain) | C5 |
| W-051 | Asking for discounts at booking: promo code, concession, add-ons, coach fee | Customer, desk | `applyAskedDiscounts`, `applyPromo`, `concessions.ts`, `/api/quote` | promo unpaid or paid; check due, seen, refused | Traced end to end: C, D | C3, C4, D2, D3, D20 |

### Memberships

Plans, terms, family cover, suspension and benefits.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-052 | Sell at the counter: plan or override, overlap and cover checks | Desk, manager | `sellMembership`, `/api/admin/memberships` | active, void, expired | Traced end to end: D | D10 |
| W-053 | Buy online: hold, pay, settle, owed back, renewal terms | Customer | `membership-purchases.ts`, `membership-plans.ts`, `payments.ts` | pending, made, released, owed back | Read, not traced: D: the settle code left to C | D23 |
| W-054 | Auto-renewal by Stripe subscription | Gateway | `settleSubscription` | renewed, carried | Not reviewed: not reviewed: D left the settle code to C, C ran out of time; tests per the docs | D12 |
| W-055 | Family cover changes, next-term covers, manager correction | Customer, manager | `changeCovers`, `setNextCovers`, `correctCover` | places used and left | Traced end to end: D | - |
| W-056 | Suspend, reactivate, carry to renewal, extend on suspension | Manager, system | `membership-suspensions.ts` | open, dated, lifted, carried | Traced end to end: D (20 existing tests re-run on Postgres) | D12 |
| W-057 | Void (with or without money back), extend days, staff flags | Manager | `voidMembership`, `extendMembership`, `membership-flags.ts` | void, flagged | Traced end to end: D (flags code read only) | D7, D22 |
| W-058 | Member price, tier price, booking window | System | `memberPricing`, `activeMembership`, `pricing.ts` | tier percent, member rate | Traced end to end: D | D6, D7, D19 |
| W-059 | Members-only participation checks at check-in and the door | System, desk | `entitlements.ts` `participationLapses` | n/a | Read, not traced: D: out of time | - |

### Passes

Pass products, spending, restoring, voiding, loyalty hours.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-060 | Sell at the counter: list product or manager override | Desk, manager | `issuePass`, `counter-prices.ts`, `/api/admin/passes` | active, void | Traced end to end: D | D8, D10 |
| W-061 | Sell online; owed back if it buys nothing | Customer, guardian | `pass-purchases.ts`, `/api/my/passes` | pending, issued, owed back | Read, not traced: D: gateway paths left to C | - |
| W-062 | Spend a pass on a booking: one pass, per place, several | Customer, desk | `payBookingWithPasses`, `pass-rules.ts`, `/api/bookings` | remaining entries, spent ledger | Traced end to end: D; C read it | D4, D9, D18 |
| W-063 | Restore entries on customer cancel, venue cancel, place withdrawal, class cancel | Customer, staff, system | `refundBookingToPass`, `refundBooking`, `place-withdrawals.ts` | settled and unsettled spend | Traced end to end: D, H | D1=H5, C14=D14=H6, D16 |
| W-064 | Void a pass, with or without the unused part handed back | Manager | `voidPass`, `/api/admin/passes/[id]/void` | void | Traced end to end: D, H | D1=H5 |
| W-065 | Gym and day-pass entry spend | Desk, customer | `entries.ts` `admitEntry`, `admittingPasses` | day used on | Traced end to end: D | D10, D18 |
| W-066 | Pass expiry, extension, correction, transfer | Staff | none exists | none | Traced end to end: D (the absence confirmed by search of every `UPDATE passes`) | D10 |
| W-067 | Loyalty free hour grant | Scheduler | `loyalty.ts` `grantLoyalty` | reward pass | Traced end to end: D, G (run twice at once) | G19, D8 |

### Classes

Group classes, terms, waiting lists and registers.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-068 | Schedule a class or weekly term | Manager | `createClassSessions`, `POST /api/admin/classes` | scheduled, cancelled | Traced end to end: E | - |
| W-069 | Enrol: self, children, staff at the counter | Customer, guardian, desk | `enrolPeopleOnce`, `POST /api/classes/enrol` | confirmed unpaid or paid, cancelled | Traced end to end: E; B traced the hold and policy part | B9=E10 |
| W-070 | Term enrolment | Customer | `enrolInTerm`, `classTerm`, `/api/classes/term` | per-session bookings sharing a series code | Traced end to end: E | E15 |
| W-071 | Class waiting list: join, offer, claim, expiry, pass-on | Customer, desk, scheduler | `joinClassWaitlist`, `offerClassPlace`, `claimWaitlistOfferOnce`, `passOnExpiredOffers` | waiting, offered, claimed, expired, cancelled | Traced end to end: E, B, H | B6, B7=E5, E6, E12=H9 |
| W-072 | Cancel an enrolment: customer, series, desk | Customer, desk | `customerCancel`, `cancelSeries`, `adminCancelBookingOnce` | confirmed, cancelled, late | Traced end to end: E | E6, E18 |
| W-073 | Venue calls a class off: by hand, closure, outage, rain-out | Manager, system | `cancelClassSession`, `cancelClassAndTell` | scheduled, cancelled | Traced end to end: E, H | E1, B5=E8, E12=H9, E14 |
| W-074 | Change a class, move a class, desk move approval | Manager, desk | `changeClass`, `moveClasses`, `moveOrRequest` | moved, requested | Read, not traced: E: docs and ADR claims checked only where they touch a finding | E7, E12=H9 |
| W-075 | Class instructor as a venue coach; coach conflicts worklist | Manager | `class-coaches.ts` | held, conflict | Traced end to end: E (notifications) | E12=H9 |
| W-076 | Attendance registers: marks, locks, reports | Coach, desk, manager | `attendance.ts` | present, absent, late, excused | Read, not traced: E (confirmed that nothing outside `attendance.ts` and `privacy.ts` reads the marks) | E16 |
| W-077 | Instructor pay for classes | none | none (not built) | none | Not reviewed: not reviewed: not built; the docs say coach payouts are for lessons only | E19 |

### Coaching

One-to-one lessons and coaches.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-078 | Lesson booking, assignment, reschedule, venue move, coach change | Customer, desk, manager | `lesson-coaches.ts`, `coaching.ts`, `lesson-venue-moves.ts` | confirmed, cancelled, moved | Read, not traced: E | E11 |
| W-079 | Coach availability, time off, hours, retirement | Coach (private link), manager | `addTimeOff`, `setCoachHours`, `retireCoach`, `/api/coach/[token]/*` | active, time off, retired | Traced end to end: E | E11 |
| W-080 | Coach alerts and calendar | Scheduler | `notifyCoaches`, `notifyLessonMoved` | told, untold | Traced end to end: E | E16 |
| W-081 | Coach payouts report | Manager | `coachPayouts`, `/api/admin/coach-payouts` | went ahead, no-show, late | Traced end to end: E (C did not review it) | E7, E16 |
| W-082 | Lesson packs, coach substitution and absence | Manager | `applyCoachChange`, `passes.coach_id` | pack bound to a coach | Read, not traced: E | E11 |

### Competitions

Tournaments, leagues, ladders and ratings.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-083 | Create a tournament, hold courts, change its details | Manager | `createTournament`, `checkHold`, `placeHold`, `changeTournament` | open, closed | Traced end to end: F | F7 |
| W-084 | Entry, waiting list, payment (online and counter) | Player, guardian, desk | `enterAs`, `startEntryPayment`, `settleBill`, `setEntry` | entered, waitlisted, withdrawn; `paid_at` | Traced end to end: F, H | F7, C11=F4=H4 |
| W-085 | The draw: knockout, groups, round robin, double elimination, performance | Manager | `makeDraw`, `releaseUnneeded` | open or closed to drawn | Traced end to end: F (race tested) | F1 |
| W-086 | Withdrawal, retirement, disqualification, replacement from the waiting list | Player, desk, manager | `withdraw`, `takeOut`, `takeOutOnce`, `previewTakeOut` | withdrawn, out stage and reason | Traced end to end: F, H | F5, C11=F4=H4 |
| W-087 | Venue calls a tournament off; refunds | Manager | `cancelTournament`, `refundOwedByVenue` | cancelled | Traced end to end: F, H | C11=F4=H4 |
| W-088 | Results, walkovers, corrections after progression | Desk, manager, officials, players | `recordResult`, `previewResult`, `applyCorrection`, `match-reports.ts` | done, walkover, retired; issues | Traced end to end: F (results and reports traced; issues read) | F10 |
| W-089 | Tournament day: check-in, calling, no-show forfeit | Desk, official | `tournament-day.ts` `forfeit`, `officialDay`, `announceAll` | called, started | Read, not traced: F | F5, F14 |
| W-090 | Court time against customers: holds, release, outage, closure | Manager, desk | `placeHold`, `releaseUnneeded`, `createOutage`, the closures route | blocks | Traced end to end: F | F3 |
| W-091 | Swiss draws and rounds | Manager | `swiss.ts` | rounds | Read, not traced: F (shares the draw path) | F1 |
| W-092 | Box leagues: join, seasons, results, leave, fee | Player, desk, manager | `leagues.ts` | forming, running, finished | Read, not traced: F | F12 |
| W-093 | Teams and team leagues: fixtures, line-ups, results, forfeit requests | Captains, desk, manager | `team-leagues.ts`, `team-forfeits.ts`, `teams.ts`, `fixtures.ts` | fixture and forfeit-request states | Read, not traced: F (the forfeit decision traced) | F3 |
| W-094 | Ladders: challenges, ignored-challenge forfeit, court-time holds, corrections | Players, manager, scheduler | `ladders.ts` `ladderHousekeeping`, `decideForfeit`, `ladder-holds.ts` | pending, accepted, reported, walkover; hold tentative, confirmed, released | Read, not traced: F (forfeit traced; holds read) | F9 |
| W-095 | Ratings: ledger, correction, erasure | System | `ratings.ts` `forgetSubject`, `ratedAfter` | rated results voided or replaced | Read, not traced: F | - |

### Matchmaking

Open games and the money inside them.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-096 | Open games: open, join, last place, leave, remove, host cancels, venue cancels, move | Host, player, venue | `games.ts`, `game-moves.ts`, `store.ts` | requested, accepted, declined, left, removed, invited, waitlisted, offered, expired | Traced end to end: F (race tested), H | F6, F11 |
| W-097 | Invitations by name or email, matchmaking suggestions | Player | `mayInvite`, `inviteByEmail`, `acceptGameInvitation`, `matchmaking.ts` | invited | Read, not traced: F | - |
| W-098 | Host marks a player a no-show | Host | `decide(..., "no_show")`, `recentNoShows` | no-show set | Traced end to end: F | F6 |
| W-099 | Shares to the venue and refunds on leave, remove, cancel, move | Players, host, venue | `shareOwedBack`, `unpayShare`, `settleBill` share branch, `splits.ts` | refund due | Traced end to end: F; C read the rounding | F11, C13 |

### Customer identities

Who a customer is to the system: numbers, accounts, guardians, standing, privacy.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-100 | Phone proof by SMS or WhatsApp; a number moves to the account that proves it | Account holder | `phone-check.ts` | verified phone | Traced end to end: G | G20 |
| W-101 | A guest booking shown to the account with the confirmed email | Guest, account | `ACCOUNT_BOOKING` in `store.ts` | `user_id` empty with email match | Traced end to end: G | G20 |
| W-102 | Guardians recorded by name and number, claim code, participants and children | Venue staff, guardian | `contact-guardians.ts`, `guardian-requests.ts`, `participants.ts` | contact, claimed, suspended | Read, not traced: G, E (design read; each step needs a proved number and staff) | - |
| W-103 | Customer standing: no-show flag, late-cancel strikes, forgiveness, struck-out holds | Desk, system | `setNoShow`, `cancel-policy.ts` `strikesFor`, `limits.ts` | no-show, late cancelled | Traced end to end: D, E | D13, D11, E7 |
| W-104 | Customer notes | Desk | `customer-notes.ts`, `/api/admin/customer-notes` | note | Traced end to end: D | D24 |
| W-105 | Staff look-up of a customer by email or phone (credit, passes, memberships, access list) | Staff | `findUserForWallet`, `findAccountToLink` | n/a | Traced end to end: A | A2 |
| W-106 | Privacy: export, erasure, retention, erasure ledger | Customer, manager | `privacy.ts`, `erasure-ledger*.ts` | erased, anonymised | Traced end to end: G (a scan of every text column after erasure); H read it | G6, G20 |
| W-107 | Customer registration, sign-in and password reset | Customer | `/api/auth/*` (customer side) | n/a | Not reviewed: not reviewed: outside every brief; earlier audits S21 and S22 cover the enumeration answers | - |

### Venue operations

The day-to-day running of a venue.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-108 | Check-in by desk, QR self-check-in, door; no-shows and strikes | Customer, desk | `checkIn`, `checkInByToken`, `setNoShow`, `markPlace` | checked in, checked out, no-show | Traced end to end: E | E7, E18 |
| W-109 | Unstaffed access: door code reveal, inductions | Customer, manager | `accessCodeFor`, `recordInduction`, `/api/access` | revealed, or refused for one of 11 reasons | Traced end to end: E; B read the door-code part | E2, E3, E4 |
| W-110 | Equipment hire: take, return, deductions, kept deposit sold | Desk | `takeHire`, `returnHire`, `deposit-deductions.ts` | held, returned, withheld, kit out | Traced end to end: C, E, H | C10=E13=H10, E14 |
| W-111 | Add-ons with stock | Customer | `attachAddons`, `priceChoice` | stock | Read, not traced: E (serializable transactions read; oversell not forced) | - |
| W-112 | Waivers: versions, signatures | Manager, customer | `waivers.ts` | version, signed | Traced end to end: E | - |
| W-113 | Private hire enquiries | Public, desk | `enquiries.ts` | new, replied, booked, declined | Traced end to end: E | E17 |
| W-114 | Walk-in entries with no set time, other than the pass spend | Desk, customer | `entries.ts` | admitted, ended | Not reviewed: not reviewed: E ran out of time (D traced the pass spend) | - |
| W-115 | Emergency procedures and house rules | Venue | `venues.emergency_*`, `house-rules.ts` | n/a | Read, not traced: E | - |

### Safety

Eligibility to use a place, supervision and the protection of children.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-116 | Sign-offs, certifications and their revocation | Desk, manager | `sign-offs.ts`, `/api/admin/sign-offs` | in force, revoked, expired | Traced end to end: E | E3, E4 |
| W-117 | Approvals: applications, revocation, flags | Customer, reviewer, manager | `approvals.ts` | applied, approved, revoked, flagged | Read, not traced: E: only `afterRevocation` and `signOffRevoked` | E4 |
| W-118 | Rosters, supervision, qualifications | Manager | `rosters.ts` | covered, uncovered | Read, not traced: E: documents only; ADR 0036 'nothing cancelled, nobody told' is deliberate | - |
| W-119 | Blocked numbers | Manager | `limits.ts` `blockPhone`, `isBlocked` | blocked | Traced end to end: D, E | E2 |
| W-120 | Youth messaging: launch gate, guardians, supervisors, reports, protective restriction, review, appeals | Guardian, supervisor, safeguarding admin, owner | `youth-*.ts`, ADR 0052 | cases, mutes, appeals | Read, not traced: F: gate and scheduler wiring checked, not traced end to end; legal questions not assessed | F2, F8 |
| W-121 | Public names of minors | Public | `public-names.ts`, `/api/tournaments/[id]` | short or full name | Read, not traced: F | F13 |

### Communications

Messages to customers, players, coaches and staff.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-122 | Outbox: write, send with retries, give up, resend | Customer, staff | `outbox.ts`, `drainOutbox`, `retryMessage`, `notify.ts` `tickOutbox` | queued, failed, sent, abandoned | Traced end to end: G; H read it | G1, G7, G8, G9, G10, G11, A3, H11 |
| W-123 | Booking messages: confirmation, cancel, venue cancel, move, reschedule, waitlist offer, reminder, receipt | Customer, venue | `notify.ts` `notify*` | dedupe keys, notices | Traced end to end: G | G7, G11, C17, G13 |
| W-124 | Marketing consent: double opt-in, campaign, unsubscribe | Customer, manager | `marketing.ts`, `/api/unsubscribe` | consent unconfirmed, confirmed, withdrawn | Traced end to end: G | G8 |
| W-125 | WhatsApp credit, packs, urgent against paid kinds, delivery receipts | Venue, platform | `whatsapp-credit.ts`, `/api/whatsapp/webhook` | credit balance, pack due, paid | Traced end to end: G | G9, G20, H11 |
| W-126 | Player messages between adults: send, block, report, review, mute, suspend, auto-suspend | Players, venue manager, owner | `messages.ts`, `message-moderation.ts` | report open, reviewed; suspension | Traced end to end: F | F2, F8 |
| W-127 | Customer notices for expiry, renewal, strikes, low balance | System | `outbox.ts` `MessageKind` | none exist | Traced end to end: D (the absence confirmed) | D11, G16 |

### Reports

What a manager or accountant reads.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-128 | Venue report: revenue, outstanding, collected by, tax, utilisation, liabilities | Manager | `reports.ts` `venueReport`, `walletLiability` | per period | Traced end to end: C, G | C8=G4, C9, G3, G5, G16 |
| W-129 | Sales journal, summary, CSV export | Accountant | `accounting.ts`, `export.ts` | receipts and credit notes | Traced end to end: G, C | G2 |
| W-130 | Cash-up | Desk, manager | `cash-up.ts` | the day's journal by method | Traced end to end: C, G | C10=E13=H10 |
| W-131 | Customer report: top customers, no-show rate | Owner | `customer-report.ts` | n/a | Traced end to end: D | D17 |

### Integrations

External services and the venue's own systems.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-132 | Public API (`/api/v1`): keys, scope, availability, booking, cancel | Venue systems | `api-keys.ts`, `key-bookings.ts`, `apiCaller` | key scope, revoked | Traced end to end: G; A read the tenant checks | G12, A13, B15 |
| W-133 | Outgoing webhooks: sweep, sign, pin the address, retry, switch off | Venue systems | `webhooks.ts` | queued, delivered, exhausted, endpoint off | Traced end to end: G (by reading) | G17, G6 |
| W-134 | MCP and OAuth: assistants acting as staff | Staff, AI assistants | `/api/mcp`, `lib/mcp/*`, `asDelegate`, `/api/admin/assistants` | grant | Read, not traced: G, A (existing tests; logging checked) | - |
| W-135 | Google sign-in | Customer | `oauth.ts` | identity link | Traced end to end: G | - |
| W-136 | Reserve with Google feeds | Venue | `google-feeds.ts` | feed | Not reviewed: not reviewed: draft, time | - |
| W-137 | MyInvois: consolidation, submission, check, unknown outcome, retention | Scheduler, venue, LHDN | `myinvois.ts` `runEInvoicing`, `submitOne`, `consolidate` | pending, submitted, valid, invalid, failed, rejected, cancelled | Traced end to end: G, C (consolidation traced; states read) | C2, G15 |
| W-138 | Accounting push to Xero | Manager, scheduler | `accounting-push.ts` | queued, sending, sent, failed, held, skipped | Read, not traced: G (gated and off by default); C did not review it (time) | - |

### Platform, tenancy and permissions

Who may do what, where, and what is recorded.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-139 | Role model: owner, business manager, branch manager, front desk; `MANAGER_ONLY`; `requireAdmin` | Staff | `lib/roles.ts`, `lib/admin-auth.ts` | n/a | Traced end to end: A, H (all 211 admin routes scanned) | A9, H13 |
| W-140 | Venue and business boundary on every admin route | Staff | `denyVenue`, `canAccessVenue`, `tests/tenant-sweep.test.ts` | n/a | Traced end to end: A (sweep re-run: 249 pass), H | A2 |
| W-141 | Staff accounts: invite, resend, withdraw, accept, correct, change role, remove | Owner, business and branch managers | `lib/staff-accounts.ts`, `/api/admin/admins*` | invitation open, accepted, withdrawn | Traced end to end: A | A3, A8, A13 |
| W-142 | Staff sign-in, sessions, password change and reset, TOTP, login tickets, 2FA reset | Staff | `admin-auth.ts`, `two-factor.ts`, `two-factor-reset.ts`, `password-reset.ts` | session (7 days), ticket | Traced end to end: A | A10, A14 |
| W-143 | Platform administrator powers and their logging | Owner | billing, businesses, venues, storefronts, retention, backup, demo, system routes | n/a | Traced end to end: A (logging coverage) | A6=G12, A7 |
| W-144 | Staff activity log: scope and coverage | Managers | `lib/activity.ts`, `/api/admin/activity` | `staff_actions` | Traced end to end: A, C, G (coverage scan of `/api/admin` and `/api/v1`) | A8, G12, G20 |
| W-145 | Alerts to the owners | Owner | `alerts.ts` `raiseAlert` | `system_alerts` | Traced end to end: G | G1 |
| W-146 | Backups, off-site copies, backup health | Owner | `backup.ts`, `offsite.ts`, `backup-health.ts` | local, off-site | Read, not traced: G: alert wiring checked; no restore run | G18 |

### Scheduler

Work the system does by itself.

| ID | Workflow | Actors | Entry points | Key states | Audit coverage | Findings |
| -- | -------- | ------ | ------------ | ---------- | -------------- | -------- |
| W-147 | Lease, tick, the order of every periodic job | System | `scheduler.ts` `runScheduledWork`, `withSchedulerLease` | lease row; each job derives its work from data | Traced end to end: G, H | G10, G18 |
| W-148 | Re-run safety of the jobs: loyalty, platform invoices, payment holds, refund settling | System | `loyalty.ts`, `billing.ts`, `payment-holds.ts`, `payments.ts` `settle*` | per job | Traced end to end: G (refund settling read) | G19, G14 |
| W-149 | Retention run: pruning personal data by rule | System | `privacy.ts` `pruneOldData`, `pruneIfDue` | not due, run, failed | Traced end to end: A, G, H | A1=H2, G6, G20 |

## Totals


**149 workflows inventoried** in 18 domains.

| Coverage | Workflows |
| -------- | --------- |
| Traced end to end | 103 |
| Read, not traced | 41 |
| Not reviewed | 5 |
| Total | 149 |

By domain:

| Domain | Workflows | Traced | Read, not traced | Not reviewed |
| ------ | --------- | ------ | ---------------- | ------------ |
| Marketplace | 12 | 9 | 3 | 0 |
| Court reservations | 19 | 11 | 8 | 0 |
| Money | 16 | 12 | 4 | 0 |
| Prices | 4 | 2 | 2 | 0 |
| Memberships | 8 | 5 | 2 | 1 |
| Passes | 8 | 7 | 1 | 0 |
| Classes | 10 | 7 | 2 | 1 |
| Coaching | 5 | 3 | 2 | 0 |
| Competitions | 13 | 7 | 6 | 0 |
| Matchmaking | 4 | 3 | 1 | 0 |
| Customer identities | 8 | 6 | 1 | 1 |
| Venue operations | 8 | 5 | 2 | 1 |
| Safety | 6 | 2 | 4 | 0 |
| Communications | 6 | 6 | 0 | 0 |
| Reports | 4 | 4 | 0 | 0 |
| Integrations | 7 | 4 | 2 | 1 |
| Platform, tenancy and permissions | 8 | 7 | 1 | 0 |
| Scheduler | 3 | 3 | 0 | 0 |

Three of the traced rows are about something that does not exist: closing a
venue for good (W-010), correcting or extending a pass (W-066) and customer
notices for expiry and strikes (W-127). They are counted as traced because the
auditors confirmed the absence by search and followed the workarounds staff are
left with. One traced row, the outgoing webhooks, was traced by reading only.

## What was not reviewed

Everything below was either not examined at all or examined less than a
workflow row suggests. Nothing here may be taken as sound.

### Workflows nobody reviewed

| Workflow | Reason |
| -------- | ------ |
| Auto-renewal by Stripe subscription (`settleSubscription`), W-054 | Auditor D left the settlement code to C, and C ran out of time; the docs say tests cover it |
| Instructor pay for classes, W-077 | Not built; the documents say coach payouts are for lessons only (E19 records it) |
| Customer registration, sign-in and password reset, W-107 | Outside every brief; the earlier audits S21 and S22 dealt with the enumeration answers |
| Walk-in entries with no set time, other than the pass spend, W-114 | Auditor E ran out of time |
| Reserve with Google feeds, W-136 | The feature is a draft; time |

### Read, not traced, or partly reviewed

| Area | What was left |
| ---- | ------------- |
| Message moderation, youth groups and document-policy route bodies | Auditor A read the guards only, not the bodies of these routes |
| Branch copy | Authorisation checked; the copy's internals not reviewed |
| Weekly series: pay and extend for court bookings | B: time; E followed only the class-term end of `cancelSeries` |
| Manager price adjustments and counter price overrides | B: pricing domain; D read them |
| Time zones, midnight, clock changes | Read; existing tests relied on; no country sold changes its clocks |
| The pricing arithmetic (`pricing.ts`, `peak.ts`) | D read it; `pricing.test.ts` not re-run |
| Class moves, desk move approvals, class registers | E read them only where they touch a finding |
| Lessons: booking, venue moves, packs and coach substitution | E: read, not traced |
| Tournament day, Swiss, box leagues, team leagues, ratings | F: read; the forfeit decisions and the draw were traced |
| Ladder court-time holds | F: read; no finding recorded |
| Open-game invitations and suggestions | F: read |
| Guardians, participants and the claim code | G and E: design read |
| Safety approvals, rosters, qualifications | E: documents read; ADR 0036 is deliberate |
| Youth messaging | F: gate and scheduler wiring checked against ADR 0052; legal questions not assessed |
| MCP and OAuth for staff, Xero push | G and A: existing tests relied on; Xero is gated and off by default |
| Backups and off-site copies | G: alert wiring checked; no restore run |
| Gateway refund recovery and manual refunds | C, G, H relied on `refund-crash` and `refund-recovery`; not re-run |
| Add-on stock oversell | Read: transactions are serializable; not forced |
| Team-league fixture blocks under an outage (F3) | By reading the same SQL; not run |

### Limits that apply to every row

- No real email, WhatsApp, SMS, Billplz, Stripe, MyInvois, Google, Xero or
  off-site provider was called.
- No browser walk.
- No legal, tax-adviser or consumer-law opinion was sought; the questions
  recorded as open (e-invoicing prepaid credit, voucher expiry, erasure of
  payer details, youth messaging) stay open.

## Status after the fix round

*Added after the fix round that followed this audit; the inventory above is
unchanged and still describes the baseline commit.* Where each finding stands is in
the [findings register](findings-register-2026-11-06.md); what is left is in the
[remediation roadmap](remediation-roadmap-2026-11-06.md).

**Coverage totals are unchanged.** The inventory is a record of what the audit
examined, and the fix round examined nothing new: 149 workflows, 103 traced end to
end, 41 read and not traced, 5 not reviewed. The five workflows nobody reviewed
(Stripe subscription settlement W-054, instructor pay W-077, customer sign-in W-107,
walk-in entries W-114, Reserve with Google W-136) were not reviewed by the fix round
either, except that W-054's venue-suspension pause was built and tested against a
stand-in (ADR 0063). The fixes were verified by new tests by their authors on PGlite
and, for races and money, Postgres; the lead's full validation is in
[testing](../development/testing.md#release-records).

**86 of the 149 workflows behave differently** because a finding recorded at one of
them was fixed or partly fixed; the other 63 are unchanged. Workflows by domain, with
what is different now (findings in the register; a decision record for each fix
worker is linked there):

| Domain | Changed of total | Workflows | What is different now |
| ------ | ---------------- | --------- | --------------------- |
| Marketplace | 10 of 12 | W-001, W-003, W-004, W-005, W-006, W-007, W-008, W-009, W-011, W-012 | Sign-up answers every address alike (A12). A branch is auto-approved only under a business in good standing (A11). A draft that cannot be deleted is skipped and reported, and the dashboard no longer fails with it (A1 = H2). The owner's billing, grouping and approval actions are logged, and marking an invoice paid or void needs a reason (A6 = G12). The owner can give an overdue invoice time without marking it paid (A7). A platform invoice is emailed when issued and before it is due (G14). A suspension tells customers once, refuses new sales of passes, memberships, credit and vouchers, and pauses subscription charges at the gateway (A4, partly). Review invitations ask the question the link asks (D5) |
| Court reservations | 11 of 19 | W-013, W-017, W-018, W-019, W-020, W-022, W-023, W-024, W-025, W-026, W-027 | A closed day, rain-out and outage are written first, leave what was played alone and name what could not be cancelled (B1 = E9 = H3, B2, B5 = E8, E14). A weekly series is checked week by week (B4). Credit and pass payment are decided in the paying transaction (B3). A request that dies after the booking is swept (B10 = C16). A booking carries `expectedTotal` and a refused discount refuses (C3, C4). Court-time offers are per time, capped at the start and told when they lapse (B6 in part, B7 = E5, B13). A move below a deposit owes the excess back (C1 = H1). A customer's cancel message is owed and swept (C17). Cancelling weeks of a class term sends the freed places to the class's waiting list (E6) |
| Money | 10 of 16 | W-034, W-035, W-036, W-037, W-039, W-040, W-041, W-044, W-045, W-047 | Refunds are told to the customer (G13). Fees paid at the counter are owed back when a tournament is called off (C11 = F4 = H4). A price change never leaves paid above price (C1 = H1; B16 in part). Company accounts apply credit part by part, can be part-paid, are reminded and may be blocked when overdue, and an issued invoice no longer drifts (C5 in part, C6, C7). Stored credit and vouchers are not sold at a suspended venue, and vouchers show in the liabilities (A4, G16 in part). Staff find only their own customers (A2) |
| Prices | 2 of 4 | W-048, W-051 | The quoted price is checked (C3, D20); a concession is decided once (D2) |
| Memberships | 4 of 8 | W-054, W-056, W-057, W-058 | An open-ended suspension of a renewing membership gives its days back (D12). Giving days back refuses to run into the next term (D7) |
| Passes | 4 of 8 | W-062, W-063, W-064, W-066 | A pass is judged on the session's date (D4). Entries given back to an ended pass reopen it (30 days), and one cancelled with a refund is not revived but credited (D1 = H5). A manager can extend a pass (D10, in part) |
| Classes | 5 of 10 | W-071, W-072, W-073, W-074, W-075 | A class called off locks its roster, leaves a held class alone, closes its waiting list and tells its coach (E1, B5 = E8, E12 = H9). Offers are not made after the start (B7 = E5). Freed places reach the class list (E6). A self check-in no longer freezes a move (E7) |
| Coaching | 1 of 5 | W-081 | A self check-in no longer makes a lesson count as held (E7). Coach absence is unchanged (E11) |
| Competitions | 11 of 13 | W-083, W-084, W-085, W-086, W-087, W-088, W-089, W-090, W-091, W-093, W-094 | The draw is made under the tournament's lock (F1). An undrawn tournament stops taking entries after its first day and is flagged (F7). Entrants removed or forfeited are told (F5). A lost court or closed day answers the fixtures, tells each side and can postpone the day (F3). Counter fees are owed back (C11 = F4 = H4). A reported walkover is reminded and flagged (F10, in part); a ladder challenge is reminded (F9) |
| Customer identities | 3 of 8 | W-103, W-105, W-106 | Staff lookups are bounded to the venue's customers and throttled (A2). Erasure and retention reach payments, messages and webhook deliveries (G6). A self check-in does not clear a strike (E7) |
| Venue operations | 3 of 8 | W-108, W-109, W-110 | Self and door check-in are not verified attendance until staff confirm (E7). A refused number gets no door code, and an unstaffed slot asks for the sign-off at booking (E2, E3; E4 in part). A hire deposit has a recorded method, shows in the cash-up and never defaults to cash (C10 = E13 = H10) |
| Safety | 2 of 6 | W-116, W-119 | Eligibility taken back flags the person's bookings and tells them (E4, in part). A blocked number is listed with its upcoming bookings (E2) |
| Communications | 5 of 6 | W-122, W-123, W-124, W-125, W-126 | A provider outage is waited out for up to 7 days with a bulk resend; urgent news is uncapped; a reminder follows its booking; a campaign yields to a confirmation and respects withdrawn consent; the tick's steps are isolated; owed messages are swept (G1, G7 to G11). Account links are never in a staff list (A3). WhatsApp credit is spent once per message (H11). Adult-thread reports are told and an automatic suspension can be reviewed (F2; F8 in part) |
| Reports | 3 of 4 | W-128, W-129, W-130 | The period report's money is the journal's; pass-paid is shown apart; deposits and shares count; the liabilities are in ringgit and provisional (C8 = G4, C9, G3, G5, G16 in part). The journal export writes negatives as numbers (G2). The cash-up has deposits and counted cash (C10 = E13 = H10) |
| Integrations | 3 of 7 | W-132, W-133, W-137 | An API key's bookings are logged and can carry `expectedTotal` (G12, C3). Webhook deliveries about an erased person are dropped (G6). E-invoicing is isolated per venue, retried and alerted, and consolidates on any day (G15), on a stand-in |
| Platform, tenancy and permissions | 6 of 8 | W-139, W-140, W-141, W-143, W-144, W-145 | Every admin route is classified in one table and two moved to manager-only (A9). Lookups are scoped (A2). Invitation links are masked (A3). Business-level changes are visible to the business (A8). The owner's actions are logged (A6 = G12, A7). A message given up alerts the owners (G1) |
| Scheduler | 3 of 3 | W-147, W-148, W-149 | The outbox tick isolates its steps (G10); the platform invoice and payment-hold warnings are told-then-stamped (G14); retention skips an undeletable draft (A1 = H2) and reaches payer details (G6). New sweeps: stranded holds, owed notices, renewal pauses, e-invoice retry |

**Workflows whose gaps remain.** Eight workflows have no fix at all, or only a part
that is not what their row is about: the exit of a venue (W-010, A5 = H8), customer
notices for expiry and strikes (W-127, D11), correcting a pass or membership at the
desk (W-052, W-060, W-065, D10, where only a manager's extension of a pass was
built), approvals and youth messaging (W-117, W-120: unchanged; the adult-thread
fixes F2 and F8 sit beside them), and manager price adjustment and counter price
override (W-050). The stale-draft purge (W-004) changed, but still deletes a draft's
counter receipts (A15).
