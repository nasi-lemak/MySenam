# Audits

Dated assessments of MySenam: what was found at one point in time. An audit is
never rewritten to match later code; where its findings stand now is tracked
here, and accepted work is carried to the [roadmap](../roadmap/roadmap.md) or
[known limitations](../roadmap/known-limitations.md), which are maintained.

| Audit | Date | What it covered |
| ----- | ---- | --------------- |
| [Operations audit](operations-2026-10-28.md) | 28 October 2026 | Operating a venue without support, the customer's and staff's flows, and money, security and concurrency, walked in the production build; 50 findings |
| [Documentation audit](documentation-2026-10-24.md) | 24 October 2026 | This reorganisation: research and audits into `docs/`, programmes split into tournaments and matchmaking, conventions, discrepancies found |
| [Launch audit](launch-2026-10-23.md) | 23 October 2026 | The research's 28 market gaps, where each stood after the launch batches, and what was still open |
| [Documentation audit](documentation-2026-10-22.md) | 22 October 2026 | The README split into `docs/`; the feature-status matrix, known limitations, decision records and documentation checks created |
| [Product audit](../research/go-to-market/product-audit.md) | 18 October 2026 | What the code did, written for the go-to-market research (kept with that research) |

Earlier audits of defects (the S, B and M identifiers) are tracked, fixed or
open, in [known limitations](../roadmap/known-limitations.md).

## Operations audit, 28 October 2026

Where each finding of the [operations audit](operations-2026-10-28.md) stands
after round 8 (28 October 2026). Numbers are the register's defect
identifiers.

| Finding | Status |
| ------- | ------ |
| X1-1: Cancelling a booking paid at the counter writes a full cash refund with no choice, no record of the payout, and the front desk can do it for any booking | Fixed: M22 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X1-2: Passes, memberships, credit top-ups and competition fees sold at the counter record no payment method; there is no cash-up for a shift | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-3: Staff cannot correct a booking's name, phone number or email | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-4: Closing a day, cancelling a class, blocking a court and keeping a hire deposit are missing from the staff activity log | Fixed: S28 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X1-5: Front desk is shown manager-only controls everywhere, then refused | Fixed in round 9: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-6: The schedule's "day to the minute" lists yesterday's and tomorrow's bookings as zero-minute entries | Fixed: B51 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X1-7: Membership, pass, receipt and voucher lists show the newest N with no search, so older records cannot be acted on | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-8: Reports and the accountant's exports offer only "last 30 days", "this month" and "last 3 months" | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) (a custom range already existed; *last month* added) |
| X1-9: No way to start a booking from the dashboard; clicking a free schedule cell blocks the court instead | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-10: Staff cannot cancel or move a weekly series as a whole | Fixed: the weeks left cancelled together (round 8) and moved together (round 9): [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-11: Staff are not alerted when customers cancel or change online | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-12: Classes and tournaments cannot be edited after they are set up, only cancelled | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-13: Opening hours and prices cannot be changed from a future date | Fixed in round 9: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-14: Staff accounts: a branch manager cannot add or remove desk staff; passwords are set by the manager with no invitation | Fixed in round 9: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-15: A new branch cannot copy an existing branch's set-up | Fixed in round 9: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-16: Draft-period test bookings stay in the books after going live | Fixed in round 9: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-17: No manager price adjustment or complimentary booking | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-18: The day list has no filters and hides its actions at laptop width | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X1-19: Counter memberships and passes are priced freely by the desk, not from the venue's plans | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-1: Sign-in sends people to another site: open redirect through `?next=` (and text injection through `?error=`) | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-2: A waiting-list place claimed at a venue that holds unpaid bookings is said to be "payable at the counter", and is let go | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-3: After a failed or abandoned online payment, a held booking is said to "still stand: pay at the counter" | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-4: The account page shows a held booking as "Confirmed (pay at counter)", with no way to pay, move or split it | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-5: A wrong promo code is found out only after the booking is made at full price | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-6: On a phone, the booking form covers the grid and hides its own errors; the Book button comes before what is still to be chosen | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-7: A 502 or an HTML error page shows "Unexpected token '<' … is not valid JSON" to customers and staff, in English | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-8: Emails and pages send customers to My Booking without their booking: the code and phone are typed again every time | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-9: A guest cannot leave a waiting list, and nobody can turn an offer down | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-10: "Please call the venue", with no venue number on the page that says it | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-11: Past the cancellation cutoff a customer cannot even give the court back | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number); whether it starts on is with the owner |
| X2-12: A booking made as a guest never reaches the account made later with the same email | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-13: The staff dashboard has no addresses: a reload, the Back button or a link always lands on Bookings | Partly: tab, day and venue in the address; no links to a section inside *Venue details* |
| X2-14: The front desk's day list and court schedule never refresh themselves | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-15: On a laptop the bookings table hides its actions; rows are by court, not by time | Done: the actions are in a menu that fits a laptop and the list filters; rows are in time order, then by court (`tests/series-moves.test.ts`) |
| X2-16: Dates are printed as `2026-10-31` in the booking form, confirmation, My Booking, account and emails | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) (no year shown) |
| X2-17: The booking confirmation, waiting-list and class dialogs are not dialogs to a keyboard or screen reader | Partly: one dialog for all; the grid's cells are named by price only and its hint text is pale |
| X2-18: Staff forms labelled by placeholder only | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X2-19: Enrolling in a class ends without a way to pay online | Fixed: [resolved without a number](../roadmap/known-limitations.md#resolved-limitations-without-a-number) |
| X3-1: Erasing an account cancels its paid upcoming bookings with no refund, nothing owed back and no credit note | Fixed: M24 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-2: Voiding a pass, or a membership without "money back", issues a full credit note though nothing is refunded and entries were used | Fixed: M25 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-3: A booking cancelled after its account invoice is issued stays on the invoice at full price, with no credit note; the account's "owing" figure disagrees with the invoice | Fixed: M26 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-4: A tournament takes more entries than `maxEntries` when people enter at once (`enterAs` runs outside any transaction) | Fixed: B53 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-5: The install's two-factor requirement is bypassed through public routes that act as the counter | Fixed: S26 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-6: Money a venue keeps from late cancellations is missing from the period report's revenue and tax, which then disagree with the sales journal | Fixed: M27 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-7: A venue's staff calendar feed is a plaintext bearer token that never expires (every other link is hashed) | Fixed: S27 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-8: Booking names and emails have no length bound | Fixed: B48 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-9: Eighteen routes answer 500 to a JSON body of `null` | Fixed: B49 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-10: A customer's data export leaves out the details they gave for their own e-invoice | Fixed: the export carries the e-invoice details given (`tests/einvoice-retention.test.ts`) |
| X3-11: The refund date given to customers is a UTC date, a day early for refunds noted between 00:00 and 08:00 in Malaysia | Fixed: B50 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |
| X3-12: Splitting a booking races: two first splits at once give a 500, and re-splitting can change the share after a friend has paid | Fixed: B54 in [fixed since the audit](../roadmap/known-limitations.md#fixed-since-the-audit) |

## Launch audit, 23 October 2026

Where each item the [launch audit](launch-2026-10-23.md) left open stands on
24 October 2026. *Fixed* means the code changed and a test shows it;
*unresolved* items name where they are tracked; *accepted* means behaviour is
in place and documented with no change planned; *no longer applicable* means
the question went away.

### Market gaps

| Finding | Status | Tracked in |
| ------- | ------ | ---------- |
| Admin in English only | Unresolved: none of the 63 admin components reads the dictionaries | [Roadmap](../roadmap/roadmap.md) (proposed) |
| Passes not sold online | Unresolved: no `pass` payment purpose | [Roadmap](../roadmap/roadmap.md) (proposed) |
| Malaysian gateways beyond Billplz | Unresolved | [Roadmap](../roadmap/roadmap.md) (proposed) |
| No DUPR or player ratings | Partly: self-declared levels now drive [matchmaking](../features/matchmaking.md); no earned rating | [Roadmap](../roadmap/roadmap.md): matchmaking on earned levels |
| No IoT court lighting | Unresolved; needs a hardware partner | [Roadmap](../roadmap/roadmap.md) (proposed) |
| No Apple sign-in | Unresolved; needs an Apple developer account | [Roadmap](../roadmap/roadmap.md) (proposed) |
| No native app, service worker, offline mode or web push | Unresolved | [Roadmap](../roadmap/roadmap.md): web push (planned), native app and offline (proposed) |
| No live accounting integration (export only) | Unresolved | [Roadmap](../roadmap/roadmap.md) (proposed) |
| No marketplace demand: zero venues, zero players | Unresolved; not software | [Business: pricing](../business/pricing.md#open-decisions) |

### Live verification

All still unresolved: every payment, messaging, e-invoicing, sign-in, storage
and geocoding integration is tested against stand-ins only, now 22 rows
`INTEGRATION_VERIFICATION_REQUIRED` in
[feature status](../product/feature-status.md#integrations). The real-service
checks can run them once sandbox credentials exist
([testing](../development/testing.md#staging-and-real-services)).

### Decisions for review

| # | Finding | Status | Tracked in |
| - | ------- | ------ | ---------- |
| 1 | A lost dispute on what a venue paid the platform is reported, not undone | Unresolved, awaiting a decision | [Known limitations](../roadmap/known-limitations.md#money-m) |
| 2 | A deposit charged back after the rest was paid online leaves the booking paid | Unresolved, awaiting a decision | [Known limitations](../roadmap/known-limitations.md#money-m) |
| 3 | A Stripe refund with no clear answer stays claimed and is asked again after ten minutes | Accepted: in place and documented; no review recorded | [Payments and credit](../features/payments-and-credit.md#refunds-that-are-interrupted) |
| 4 | Inline scripts allowed by the content security policy | Unresolved (P3) | [Known limitations](../roadmap/known-limitations.md#operations-and-security-s) |
| 5 | The default owner password opens nothing in production | Accepted: in place and tested | [Authentication](../architecture/authentication.md) |
| 6 | Pricing defaults unchanged | Unresolved, a business decision | [Business: pricing](../business/pricing.md#open-decisions) |
| 7a | Cancelling a weekly series skips weeks inside the cutoff | Unresolved, awaiting a decision | [Known limitations](../roadmap/known-limitations.md#booking-and-availability-b) |
| 7b | Rescheduling does not check the target court's length rules | Fixed: customers and staff are held to them, a manager may go past on record | [Booking](../features/booking.md#changing-the-date-or-time); `tests/reschedule.test.ts` |
| 8 | Web push left planned | Unresolved, planned | [Roadmap](../roadmap/roadmap.md) |
| 9 | The half-hour diary (ADR 0009) | No longer applicable: replaced by interval booking before production | [ADR 0010](../architecture/decisions/0010-interval-booking.md) |
| 10 | `/terms` and `/privacy` are drafts no lawyer has read | Unresolved (P1 before public launch) | [Known limitations](../roadmap/known-limitations.md#gaps-in-verification-and-documentation) |

## Documentation audit, 24 October 2026

Where each item the [documentation audit](documentation-2026-10-24.md) left
open stands, as of 24 October 2026 (later the same day).

| Finding | Status | Tracked in |
| ------- | ------ | ---------- |
| A booking that ever had an open game could not be moved by anybody | Fixed: decided by the owner and built; a called-off game does not block its booking, a game with players moves by its host's proposal or a manager's change with a reason | [Moving a game](../features/matchmaking.md#moving-a-game-to-another-time); `tests/game-moves.test.ts`; [ADR 0018](../architecture/decisions/0018-moving-open-games-by-consent.md) |
| Venue pricing: research prices and built tiers differ, nothing decided | Unresolved, a business decision; a comparison and recommendation are prepared, no price changed | [Business: pricing](../business/pricing.md#pricing-for-launch-comparison-and-recommendation) |
| No incident-response procedure | Fixed; its breach-notification rules await a lawyer | [Incident response](../operations/incident-response.md); [known limitations](../roadmap/known-limitations.md#gaps-in-verification-and-documentation) |
| No document of users, roles and journeys | Fixed | [Users and journeys](../product/users-and-journeys.md) |
| The HTTP route reference is partial | Partly: how every route behaves (sign-in, roles, errors), the main workflows, and a check that each route's methods are listed; fields per route remain one line each | [HTTP routes](../architecture/http-api.md) |
| The booking time model was named as a review | Fixed: renamed `booking-time-model.md`, every link updated | [Booking time model](../architecture/booking-time-model.md) |

## Adding an audit

Name it `<subject>-<yyyy-mm-dd>.md`, say what it covered and how it was
verified, and never edit its findings afterwards. Carry accepted work into the
roadmap or known limitations, and add its open items to a table here
([documentation](../development/documentation.md)).
