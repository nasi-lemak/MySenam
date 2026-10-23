# Feature status

The inventory of what MySenam does, how far each capability is implemented,
and what verifies it. It describes what exists; ideas are in the
[roadmap](../roadmap/roadmap.md), and defects and gaps in
[known limitations](../roadmap/known-limitations.md) (IDs such as B1, M1, S1
below refer there). Built from the code and test suite in the October 2026
[documentation audit](../documentation-audit.md); keep it current as
[`AGENTS.md`](../../AGENTS.md) describes.

## Statuses

| Status | Meaning |
| ------ | ------- |
| IMPLEMENTED_AND_TESTED | Exists, and automated tests meaningfully exercise the behaviour |
| IMPLEMENTED_UNTESTED | Exists, but no meaningful automated test |
| INTEGRATION_VERIFICATION_REQUIRED | Exists and is tested against fakes only; the live third-party service has never been exercised |
| PARTIALLY_IMPLEMENTED | Some of what is needed exists |
| PLANNED | Intended, not built |
| BLOCKED | Cannot proceed without a partner, credential, approval or decision |
| DEFERRED | Postponed on purpose |
| UNSUPPORTED | Deliberately excluded |
| UNKNOWN | Not enough evidence |

Rules used: a test file's existence is not coverage; a mocked integration test
does not prove the live service; a migration or route alone does not prove a
working workflow. "Tested" means the library behaviour is tested; many admin
routes are covered only by the authorisation sweeps (`tests/routes.test.ts`,
`tests/roles.test.ts`) and through the library functions they call. A known
defect does not change a status by itself; it is named in the gaps.

## Summary

| Status | Capabilities |
| ------ | ------------ |
| IMPLEMENTED_AND_TESTED | 107 |
| INTEGRATION_VERIFICATION_REQUIRED | 20 |
| PARTIALLY_IMPLEMENTED | 3 |
| IMPLEMENTED_UNTESTED | 2 |
| BLOCKED | 2 |
| UNSUPPORTED | 1 |

## Booking and availability

Authoritative: [booking](../features/booking.md), [booking concurrency](../architecture/booking-concurrency.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Availability grid | IMPLEMENTED_AND_TESTED | Per venue, sport and day: slots, price, places left, member price, closures | `src/lib/store.ts`, `src/app/api/availability/route.ts`, `src/components/BookingBoard.tsx` | `tests/store.test.ts`, `tests/components/booking-board.test.tsx` | — |
| Booking and the double-booking guard | IMPLEMENTED_AND_TESTED | Server-priced booking with an `MS-` code; unique place per slot; serializable retry | `src/lib/store.ts`, `src/app/api/bookings/route.ts`, `db/migrations/0001_initial.sql` | `tests/store.test.ts`, `tests/concurrency.test.ts` | Truly parallel only on the Postgres CI run |
| Shared facilities (capacity > 1) | IMPLEMENTED_AND_TESTED | Places sold per hour; capacity cannot shrink below what is booked | `src/lib/store.ts` | `tests/capacity.test.ts` | — |
| Blocks, whole or partial places | IMPLEMENTED_AND_TESTED | Staff block hours with a reason; partial places for fleets; never over bookings | `src/lib/store.ts`, `src/app/api/admin/blocks/route.ts` | `tests/partial-blocks.test.ts` | Occupancy counts full blocks only |
| "Any court" | IMPLEMENTED_AND_TESTED | Cheapest court free for the whole slot, re-read on the server | `src/lib/store.ts` | `tests/anycourt.test.ts` | — |
| Weekly series and booking lengths | IMPLEMENTED_AND_TESTED | `SR-` series of 8 weeks (up to 26 where allowed), skip or fail clashes and closed weeks; per-court shortest and longest | `src/lib/store.ts`, `src/app/api/bookings/cancel-series/route.ts` | `tests/booking-lengths.test.ts`, `tests/booking-rules.test.ts` | Series needs an account; series cancel skips late weeks silently |
| Several courts in one booking | IMPLEMENTED_AND_TESTED | 2–6 courts, `GR-` code, one bill and one confirmation | `src/lib/store.ts` | `tests/group-bookings.test.ts` | One date, no extras or coach |
| Half-hour slots | IMPLEMENTED_AND_TESTED | 30-minute selling; switching splits or merges the diary | `src/lib/store.ts`, `src/lib/time.ts`, `src/app/api/admin/slot-length/route.ts` | `tests/half-hour.test.ts` | Classes and tournaments stay hourly |
| Courts that share a floor | IMPLEMENTED_AND_TESTED | Whole and part courts take each other through shadow slots written by a trigger | `src/lib/court-links.ts`, `db/migrations/0072_linked_courts.sql`, `db/migrations/0087_wholes_over_one_part.sql` | `tests/court-links.test.ts` | One level deep; utilisation double-counts the floor |
| Opening hours, weekday hours, closures | IMPLEMENTED_AND_TESTED | Hours per venue and per weekday, past midnight; whole-day closures on every path | `src/lib/store.ts`, `src/lib/week-hours.ts`, `src/app/api/admin/venues/[id]/closures/route.ts` | `tests/hours.test.ts`, `tests/week-hours.test.ts` | — |
| Look up and cancel by code and phone | IMPLEMENTED_AND_TESTED | `/my-booking`; cancel before the cutoff; claimed once | `src/app/my-booking/page.tsx`, `src/app/api/bookings/cancel/route.ts` | `tests/store.test.ts`, `tests/booking-rules.test.ts` | — |
| Late cancels, strikes, booking terms, rules by sport | IMPLEMENTED_AND_TESTED | Late share kept; strikes force online pay or the counter; terms box; per-sport cutoff and peak | `src/lib/cancel-policy.ts`, `src/lib/booking-terms.ts`, `src/lib/sport-rules.ts` | `tests/cancel-policy.test.ts`, `tests/booking-terms.test.ts`, `tests/sport-rules.test.ts` | — |
| Moving, rescheduling, booking again | IMPLEMENTED_AND_TESTED | Move court keeping code and payment; change date or time with repricing; "book again" | `src/lib/store.ts`, `src/app/api/admin/bookings/move/route.ts`, `src/app/api/bookings/reschedule/route.ts`, `src/app/api/bookings/again/route.ts` | `tests/move.test.ts`, `tests/reschedule.test.ts` | — |
| Waitlists | IMPLEMENTED_AND_TESTED | Queue for a full class or taken slot; 30-minute held offer, passed on by the scheduler | `src/lib/store.ts`, `src/app/api/waitlist/route.ts`, `src/app/api/waitlist/claim/route.ts` | `tests/waitlist.test.ts` | — |
| House rules, booking window, free courts | IMPLEMENTED_AND_TESTED | Per-person or household limits; up to 90 days ahead; members' longer window; free courts | `src/lib/house-rules.ts` | `tests/house-rules.test.ts`, `tests/booking-window.test.ts` | Counter bookings exempt |
| Who a venue is for, residents' guests | IMPLEMENTED_AND_TESTED | Public, members-only, private; list by phone; residents invite guests | `src/lib/access.ts`, `src/lib/listing.ts`, `src/lib/guest-invites.ts` | `tests/visibility.test.ts`, `tests/guest-invites.test.ts` | Without phone checks, a listed number can be typed by anyone |
| Phone limits, blocked numbers, guest flood | IMPLEMENTED_AND_TESTED | 3 unpaid per venue, 6 overall; block list; flood → pay or sign in | `src/lib/limits.ts` | `tests/limits.test.ts`, `tests/guest-surge.test.ts` | — |
| Extras with a booking | IMPLEMENTED_AND_TESTED | Hire and sale items; rental stock per hour | `src/lib/addons.ts`, `src/components/AddonPicker.tsx` | `tests/addons.test.ts` | Sale items have no stock count |

## Pricing

Authoritative: [pricing](../features/pricing.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Peak bands and holidays | IMPLEMENTED_AND_TESTED | Weekday and weekend windows; holiday list; gazetted MY/SG holidays filled in | `src/lib/peak.ts`, `src/lib/holiday-calendar.ts` | `tests/peak-rules.test.ts`, `tests/holiday-calendar.test.ts` | Holiday data ends 2027 and is updated by hand; Malaysian 2027 dates from a secondary source |
| Last-minute prices | IMPLEMENTED_AND_TESTED | 5–50% off hours still free shortly before; loopholes closed | `src/lib/store.ts` | `tests/last-minute.test.ts` | — |
| Promo codes | IMPLEMENTED_AND_TESTED | Percent or fixed, scoped, use and per-customer limits | `src/lib/store.ts`, `src/app/api/admin/promos/route.ts` | `tests/promo.test.ts`, `tests/money-rules.test.ts` | — |
| Concession prices | IMPLEMENTED_AND_TESTED | Share off; proof seen at the desk, nothing stored | `src/lib/concessions.ts` | `tests/concessions.test.ts` | — |
| Member rates | IMPLEMENTED_AND_TESTED | Per-court member price by phone, on the session's date | `src/lib/store.ts` | `tests/membership.test.ts` | A member's number typed by anyone gets the rate (by design) |
| Per-player pricing | IMPLEMENTED_AND_TESTED | Court priced per head up to a maximum | `src/lib/store.ts` | `tests/per-player.test.ts` | Not for shared facilities |
| A free hour for regulars | IMPLEMENTED_AND_TESTED | Every N paid hours earns a one-hour pass | `src/lib/loyalty.ts` | `tests/loyalty.test.ts` | Off by default |

## Payments and money

Authoritative: [payments and credit](../features/payments-and-credit.md), [business rules](business-rules.md#money).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Counter payments and the day's takings | IMPLEMENTED_AND_TESTED | Mark paid by method, a whole series; expected, collected, outstanding; un-marking rules | `src/lib/store.ts`, `src/app/api/admin/payments/route.ts`, `src/components/admin/BookingsTab.tsx` | `tests/payment-methods.test.ts`, `tests/staff-tools.test.ts`, `tests/components/bookings-tab.test.tsx` | `paySeries` race with an online payment (M3) |
| Paying online to hold, and deposits | IMPLEMENTED_AND_TESTED | Online booking held, released if unpaid; optional deposit share | `src/lib/holds.ts`, `src/lib/payments.ts` | `tests/holds.test.ts`, `tests/deposits.test.ts` | Live gateway leg below; deposit series credit note (M7) |
| Split the cost | IMPLEMENTED_AND_TESTED | 2–10 shares by link; friends pay the venue | `src/lib/splits.ts`, `src/app/split/[token]` | `tests/splits.test.ts` | Pay route not tested directly |
| Settlement and refunds owed | IMPLEMENTED_AND_TESTED | Settle once; what each page billed; owed-back list | `src/lib/payments.ts`, `src/components/admin/OnlinePaymentsPanel.tsx` | `tests/payments.test.ts`, `tests/money-rules.test.ts` | Manual and one-click refunds can race (reported, not prevented) |
| Refund when a customer cancels | IMPLEMENTED_AND_TESTED | By staff, through Stripe, or as venue credit; idempotent | `src/lib/payments.ts` | `tests/auto-refunds.test.ts` | Credit ignores `MYSENAM_CREDIT_SCOPE` (M8) |
| Receipts, credit notes, venue tax | IMPLEMENTED_AND_TESTED | Per-venue numbering; signed receipt links; SST/GST inside prices | `src/lib/documents.ts`, `src/lib/receipts.ts`, `src/lib/tax.ts` | `tests/receipts.test.ts`, `tests/tax.test.ts` | — |
| Gateway layer and sealed keys | IMPLEMENTED_AND_TESTED | One interface; per-venue keys sealed with `MYSENAM_SECRET` | `src/lib/gateways/index.ts`, `src/lib/secrets.ts` | `tests/gateways.test.ts` | Keys must be re-entered after a restore without the secret |
| Open-game shares | IMPLEMENTED_AND_TESTED | Players pay their share to the venue | `src/lib/games.ts` | `tests/games.test.ts` | Shares to real gateways need live verification |

## Memberships, passes and credit

Authoritative: [pricing](../features/pricing.md), [payments and credit](../features/payments-and-credit.md), [ADR 0007](../architecture/decisions/0007-stored-credit-ownership.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Memberships sold at the counter | IMPLEMENTED_AND_TESTED | By phone, no overlaps, void, days back, every branch | `src/lib/store.ts`, `src/app/api/admin/memberships/route.ts` | `tests/membership.test.ts`, `tests/branches.test.ts` | — |
| Membership plans and tiers online | IMPLEMENTED_AND_TESTED | Join or renew online; tiers with price share and booking window | `src/lib/membership-plans.ts`, `src/components/JoinMembership.tsx` | `tests/membership-join.test.ts`, `tests/membership-tiers.test.ts` | Not sold at private venues |
| Multi-visit passes and lesson packs | IMPLEMENTED_AND_TESTED | Entry ledger, one entry per hour | `src/lib/store.ts`, `src/lib/coaching.ts` | `tests/passes.test.ts`, `tests/concurrency.test.ts` | A half hour spends a whole entry |
| Stored credit and its scope | IMPLEMENTED_AND_TESTED | Append-only ledger; sold at the counter; spent once; venue or platform scope | `src/lib/store.ts`, `src/lib/mode.ts` | `tests/wallet.test.ts`, `tests/credit-scope.test.ts` | No database guard against a negative balance |
| Online top-ups | IMPLEMENTED_AND_TESTED | Into the venue's account; credited once on settlement | `src/lib/payments.ts`, `src/app/api/my/wallet/route.ts` | `tests/topups.test.ts` | Gateway leg below |
| Gift vouchers | IMPLEMENTED_AND_TESTED | Sold at the counter or online; printable; redeemed as credit | `src/lib/vouchers.ts` | `tests/vouchers.test.ts` | — |
| Company and school accounts | IMPLEMENTED_AND_TESTED | Named bookers, limit, monthly emailed invoice, mark paid | `src/lib/accounts.ts`, `src/app/account-invoice/[token]` | `tests/accounts.test.ts` | Invoice email and page in English only |

## Classes, coaching and programmes

Authoritative: [programmes](../features/programmes.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Classes and terms | IMPLEMENTED_AND_TESTED | One-off or weekly classes; enrol, roster, cancel; whole term at a discount | `src/lib/store.ts`, `src/app/api/classes/enrol/route.ts`, `src/app/api/classes/term/route.ts` | `tests/classes.test.ts`, `tests/class-terms.test.ts` | Term route not tested directly |
| One-to-one coaching | IMPLEMENTED_AND_TESTED | A lesson is a booking plus the coach's time | `src/lib/coaching.ts`, `src/app/api/coaching/slots/route.ts` | `tests/coaching.test.ts`, `tests/coaching-two.test.ts` | Customers cannot move a lesson |
| Coach link, feed, alerts, payouts | IMPLEMENTED_AND_TESTED | Private coach page and calendar; own hours and time off; payouts | `src/lib/coach-schedule.ts`, `src/app/coach/[token]` | `tests/coaching-two.test.ts`, `tests/coach-self.test.ts` | Email delivery live-unverified |
| Tournaments | IMPLEMENTED_AND_TESTED | Courts held; entries and fees; draws; results; call-off | `src/lib/tournaments.ts`, `src/lib/brackets.ts` | `tests/tournaments.test.ts`, `tests/brackets.test.ts` | — |
| Box leagues | IMPLEMENTED_AND_TESTED | Seasons, boxes, promotion, results | `src/lib/leagues.ts`, `src/lib/boxes.ts` | `tests/leagues.test.ts`, `tests/boxes.test.ts` | — |
| Open games | IMPLEMENTED_AND_TESTED | Host opens a booking; players join | `src/lib/games.ts` | `tests/games.test.ts` | — |
| Women-only and men-only | IMPLEMENTED_AND_TESTED | Self-declared gates on games, leagues, classes, tournaments | `src/lib/who.ts` | `tests/who.test.ts` | Cannot be verified |

## Venue operations

Authoritative: [venue operations](../features/venue-operations.md), [booking](../features/booking.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Check-in, no-shows, live crowd | IMPLEMENTED_AND_TESTED | Check in and out; no-show flags; public "here right now" | `src/app/api/admin/check-in/route.ts`, `src/app/api/venues/[id]/live/route.ts` | `tests/checkin.test.ts` | — |
| QR self check-in | IMPLEMENTED_AND_TESTED | Token per booking | `src/app/checkin/[token]` | `tests/checkin.test.ts` | QR image route untested |
| Unstaffed hours and door codes | IMPLEMENTED_AND_TESTED | Code shown to an inducted, paid customer; every look logged | `src/app/api/access/route.ts`, `src/app/api/admin/inductions/route.ts` | `tests/access.test.ts` | One code per lock; no lock integration |
| Equipment hire and deposits | IMPLEMENTED_AND_TESTED | Hand over against a deposit; return with condition | `src/app/api/admin/hire/route.ts` | `tests/hire.test.ts` | — |
| Counter sales | IMPLEMENTED_AND_TESTED | Receipted walk-in sales; manager void | `src/lib/counter-sales.ts` | `tests/counter-sales.test.ts` | No stock count |
| Notes on a customer | IMPLEMENTED_AND_TESTED | One note per number per venue | `src/lib/customer-notes.ts` | `tests/customer-notes.test.ts` | — |
| Waivers | IMPLEMENTED_AND_TESTED | Versioned; ticked when booking or enrolling; paper signatures | `src/lib/waivers.ts`, `src/components/WaiverTick.tsx` | `tests/waivers.test.ts` | Waiver page route untested |
| Private hire enquiries | IMPLEMENTED_AND_TESTED | Venue-page form; staff list and email; status | `src/lib/enquiries.ts`, `src/components/HireEnquiry.tsx` | `tests/enquiries.test.ts` | Staff book the courts by hand |
| Rain-outs | IMPLEMENTED_AND_TESTED | Preview, then cancel, refund, notify and block | `src/lib/rain-outs.ts` | `tests/rain-outs.test.ts` | No weather feed |
| Weekly blocks | IMPLEMENTED_AND_TESTED | Same hours every week up to 52 weeks | `src/lib/repeat-blocks.ts` | `tests/repeat-blocks.test.ts` | — |
| Courts out of service | IMPLEMENTED_AND_TESTED | Outage over dates; cancel and refund on request | `src/lib/outages.ts` | `tests/outages.test.ts` | — |
| Booking link and QR poster | IMPLEMENTED_AND_TESTED | Venue link, QR, printable poster | `src/lib/venue-link.ts` | `tests/booking-link.test.ts` | Poster page untested |
| First-run checklist and demo data | IMPLEMENTED_AND_TESTED | Checklist; one-click demo fortnight | `src/lib/setup.ts`, `src/lib/demo.ts` | `tests/setup.test.ts`, `tests/demo.test.ts` | — |

## Customer accounts and authentication

Authoritative: [authentication](../architecture/authentication.md), [privacy](../architecture/privacy.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Register, sign in, sessions | IMPLEMENTED_AND_TESTED | scrypt passwords; HttpOnly cookie, Secure on HTTPS | `src/lib/auth.ts`, `src/lib/session-cookie.ts` | `tests/auth.test.ts`, `tests/session-cookie.test.ts` | No CSRF token; cross-site writes refused by `Origin` (row below) |
| Security headers and cross-site check | IMPLEMENTED_AND_TESTED | CSP, framing, HSTS and others on every response; signed-in cross-site writes refused | `src/lib/security-headers.ts`, `src/lib/same-origin.ts`, `src/middleware.ts` | `tests/launch-security.test.ts`, `tests/e2e/launch.e2e.ts` | CSP allows inline scripts (nonces under review) |
| Owner password in production | IMPLEMENTED_AND_TESTED | No owner without a 12+ character `ADMIN_PASSWORD`; the default refused at sign-in; replaced at start | `src/lib/admin-auth.ts`, `src/instrumentation-node.ts` | `tests/launch-security.test.ts`, `tests/e2e/launch.e2e.ts` | — |
| Password reset and change | IMPLEMENTED_AND_TESTED | Single-use hashed token; signs out everywhere | `src/lib/password-reset.ts` | `tests/password-reset.test.ts` | Email delivery live-unverified |
| Phone verification | IMPLEMENTED_AND_TESTED | Inbound WhatsApp token or a code by SMS or WhatsApp; caps | `src/lib/phone-check.ts` | `tests/phone-methods.test.ts`, `tests/sign-in.test.ts` | Live channels below |
| Account page and phone-is-not-identity guards | IMPLEMENTED_AND_TESTED | Passes, memberships, wallet keyed on the account | `src/app/account`, `src/app/api/my/passes/route.ts` | `tests/impersonation.test.ts` | — |
| Data export, erasure, retention | IMPLEMENTED_AND_TESTED | Export and close account (books kept); retention schedule | `src/lib/privacy.ts` | `tests/privacy.test.ts`, `tests/data-request.test.ts` | Erasure clears only what is provably the account's; rows sharing just a phone number wait for retention |
| Privacy notice and terms | PARTIALLY_IMPLEMENTED | Pages describe what the software does | `src/app/privacy/page.tsx`, `src/app/terms/page.tsx` | — | Drafts; need a lawyer, a Malay version and a named contact |

## Staff, roles and tenancy

Authoritative: [tenancy](../architecture/tenancy.md), [marketplace](marketplace.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Staff accounts and venue scoping | IMPLEMENTED_AND_TESTED | Owners, managers, branch staff; every admin route scoped | `src/lib/admin-auth.ts` | `tests/admin.test.ts`, `tests/routes.test.ts` | Cross-venue `403` tested on a dozen routes |
| Manager and front-desk roles | IMPLEMENTED_AND_TESTED | One route table enforced in `requireAdmin` | `src/lib/roles.ts` | `tests/roles.test.ts` | — |
| Staff activity log | IMPLEMENTED_AND_TESTED | Who did what and when; kept two years | `src/lib/activity.ts` | `tests/roles.test.ts` | Entries mostly asserted inside feature tests |
| Two-factor sign-in for staff | IMPLEMENTED_AND_TESTED | TOTP, recovery codes, replay guard, compulsory option | `src/lib/two-factor.ts` | `tests/two-factor.test.ts` | Lost phone and codes needs a database edit |
| Businesses and branches | IMPLEMENTED_AND_TESTED | One sign-in for every branch; shared credit; one invoice | `src/lib/branches.ts` | `tests/branches.test.ts` | — |
| Suspensions and overdue-invoice holds | IMPLEMENTED_AND_TESTED | Owner suspends; overdue venues delisted until paid | `src/lib/suspensions.ts`, `src/lib/payment-holds.ts` | `tests/suspensions.test.ts` | — |

## Messaging

Authoritative: [messaging](../integrations/messaging.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Message outbox | IMPLEMENTED_AND_TESTED | Written, then sent once with backoff; 8 a day per recipient | `src/lib/outbox.ts` | `tests/outbox.test.ts` | — |
| Confirmations, reminders, receipts | IMPLEMENTED_AND_TESTED | In the customer's language, with a calendar invite | `src/lib/notify.ts`, `src/lib/booking-links.ts` | `tests/transports.test.ts`, `tests/urgent.test.ts` | Live delivery below |
| Urgent notices and acknowledgement | IMPLEMENTED_AND_TESTED | Venue cancels or moves → "seen it" link; needs-attention panel | `src/lib/urgent.ts` | `tests/urgent.test.ts` | — |
| New-booking alerts to the venue | IMPLEMENTED_AND_TESTED | Email or WhatsApp per online booking | `src/lib/notify.ts` | `tests/booking-alerts.test.ts` | — |
| WhatsApp per venue and prepaid packs | IMPLEMENTED_AND_TESTED | Off, urgent or everything; packs spent per message | `src/lib/whatsapp-credit.ts`, `src/lib/whatsapp-usage.ts` | `tests/whatsapp-usage.test.ts` | — |
| Marketing email | IMPLEMENTED_AND_TESTED | Consent kept with its wording; double opt-in; one-click unsubscribe | `src/lib/marketing.ts` | `tests/marketing.test.ts` | — |
| Staff calendar feed | IMPLEMENTED_AND_TESTED | Tokenised calendar of bookings and classes | `src/lib/staff-calendar.ts` | `tests/staff-calendar.test.ts` | — |

## Marketplace and discovery

Authoritative: [discovery](../features/discovery.md), [marketplace](marketplace.md), [business: pricing](../business/pricing.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Cross-venue search | IMPLEMENTED_AND_TESTED | Sport, day, time window; one row per venue and time | `src/lib/store.ts`, `src/app/api/search/route.ts` | `tests/store.test.ts`, `tests/browse.test.ts` | — |
| Courts near me | IMPLEMENTED_AND_TESTED | Location or typed place; distance in SQL | `src/lib/geo.ts` | `tests/near.test.ts`, `tests/geo.test.ts` | Straight-line distance |
| Venue list and fairness | IMPLEMENTED_AND_TESTED | Paged; daily shuffle; caps per venue | `src/lib/listing.ts` | `tests/browse.test.ts`, `tests/fairness.test.ts` | — |
| Facilities and court features | IMPLEMENTED_AND_TESTED | Fixed vocabulary; filters | `src/lib/facilities.ts` | `tests/facilities.test.ts` | — |
| Venue photos | IMPLEMENTED_AND_TESTED | Sniffed, re-encoded WebP, metadata stripped | `src/lib/photos.ts` | `tests/photos.test.ts` | — |
| Reviews | IMPLEMENTED_AND_TESTED | Only after a visit; replies and reports | `src/lib/reviews.ts` | `tests/reviews.test.ts` | — |
| Notices | IMPLEMENTED_AND_TESTED | Venue and site-wide notices | `src/lib/notices.ts` | `tests/notices.test.ts` | — |
| Search engines | IMPLEMENTED_AND_TESTED | Sitemap, robots, structured data | `src/lib/seo.ts`, `src/app/sitemap.ts` | `tests/seo.test.ts` | — |
| Installing as an app | IMPLEMENTED_UNTESTED | Web manifest and icons | `src/app/manifest.ts` | — | No service worker, offline mode or push |
| Storefront domains | IMPLEMENTED_AND_TESTED | Branded subset by hostname | `src/lib/storefront.ts`, `src/app/api/tls-check/route.ts` | `tests/storefront.test.ts` | A window, not a data wall |
| Venue sign-up and location checks | IMPLEMENTED_AND_TESTED | Apply, confirm email, pin and address checks | `src/lib/applications.ts` | `tests/applications.test.ts` | Geocoder live-unverified |
| Drafts and going live | IMPLEMENTED_AND_TESTED | Draft hidden; owner approves | `src/lib/drafts.ts` | `tests/drafts.test.ts` | — |
| Venue billing, tiers, platform tax | IMPLEMENTED_AND_TESTED | Monthly invoices; tiers by size; operator SST/GST | `src/lib/billing.ts`, `src/lib/plans.ts` | `tests/billing.test.ts`, `tests/plans.test.ts`, `tests/platform-tax.test.ts` | Tier prices are assumptions; disputes on the platform account ignored |

## Reporting

Authoritative: [reporting](../features/reporting.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Period reports and occupancy | IMPLEMENTED_AND_TESTED | Booked vs collected; utilisation; what is owed | `src/lib/reports.ts` | `tests/reports.test.ts` | Linked courts double-count utilisation |
| Customer report | IMPLEMENTED_AND_TESTED | New vs returning; top customers; lapsed regulars; no-shows | `src/lib/customer-report.ts` | `tests/customer-report.test.ts` | — |
| Exports and sales journal | IMPLEMENTED_AND_TESTED | Excel-safe CSV; journal by category, tax and method | `src/lib/export.ts`, `src/lib/accounting.ts` | `tests/export.test.ts`, `tests/accounting.test.ts` | — |

## Integrations

Every row here is exercised by tests against fakes only (stubbed `fetch`,
mocked mail, a fake LHDN, a local fake S3). Authoritative:
[payment gateways](../integrations/payment-gateways.md),
[messaging](../integrations/messaging.md), [MyInvois](../integrations/myinvois.md),
[external API](../integrations/external-api.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Billplz bill creation | INTEGRATION_VERIFICATION_REQUIRED | Venue and platform bills, FPX and card | `src/lib/billplz.ts`, `src/lib/gateways/billplz.ts` | `tests/payments.test.ts` | Billplz sandbox |
| Billplz callback verification | INTEGRATION_VERIFICATION_REQUIRED | X-Signature on callback and redirect; settled once | `src/app/api/payments/[provider]/callback/route.ts` | `tests/payments.test.ts` | Checked against Billplz's documented example only |
| Stripe Checkout | INTEGRATION_VERIFICATION_REQUIRED | Session in cents on the venue's key; closes with the hold | `src/lib/gateways/stripe.ts` | `tests/stripe.test.ts` | Key permissions unverified |
| Stripe webhook and return verification | INTEGRATION_VERIFICATION_REQUIRED | Signature within five minutes; return page re-checks | `src/lib/gateways/stripe.ts`, `src/app/payments/return` | `tests/stripe.test.ts` | — |
| Stripe refunds | INTEGRATION_VERIFICATION_REQUIRED | One-click and automatic, with an idempotency key | `src/lib/payments.ts` | `tests/stripe-refunds.test.ts` | Needs Refunds: Write |
| Stripe disputes | INTEGRATION_VERIFICATION_REQUIRED | Recorded once; lost → what it paid for undone | `src/lib/payments.ts` | `tests/stripe-disputes.test.ts` | Needs a test-mode dispute against real Stripe |
| Stripe membership renewals | INTEGRATION_VERIFICATION_REQUIRED | Subscription per plan; `invoice.paid` → next period | `src/lib/payments.ts` | `tests/membership-renewal.test.ts` | Stripe only |
| MyInvois connection | INTEGRATION_VERIFICATION_REQUIRED | Venue's own client or platform as intermediary | `src/lib/myinvois/client.ts` | `tests/myinvois.test.ts` | Never tried against LHDN |
| MyInvois consolidated and credit notes | INTEGRATION_VERIFICATION_REQUIRED | Monthly consolidated documents; large sales alone | `src/lib/myinvois.ts`, `src/lib/myinvois/ubl.ts` | `tests/myinvois.test.ts` | Cancelling done in the portal |
| MyInvois customer's own e-invoice | INTEGRATION_VERIFICATION_REQUIRED | Buyer details through the receipt link | `src/app/api/receipts/einvoice/route.ts` | `tests/myinvois.test.ts` | — |
| Google sign-in | INTEGRATION_VERIFICATION_REQUIRED | OIDC with PKCE, state and nonce | `src/lib/oauth.ts`, `src/app/api/auth/google/callback/route.ts` | `tests/sign-in.test.ts` | Main domain only |
| Off-site backup copies | INTEGRATION_VERIFICATION_REQUIRED | Signed streamed upload of each backup | `src/lib/offsite.ts` | `tests/offsite.test.ts` | R2, B2 or S3 bucket |
| Photo bucket | INTEGRATION_VERIFICATION_REQUIRED | Photos in their own bucket | `src/lib/photo-store.ts` | `tests/photos.test.ts` | — |
| WhatsApp template messages | INTEGRATION_VERIFICATION_REQUIRED | Templates in four languages, kept in step with the docs by a test | `src/lib/transports.ts` | `tests/transports.test.ts` | Meta approval |
| WhatsApp webhook | INTEGRATION_VERIFICATION_REQUIRED | Signed delivery statuses; inbound verification | `src/app/api/whatsapp/webhook/route.ts` | `tests/whatsapp-usage.test.ts` | — |
| WhatsApp chat replies | INTEGRATION_VERIFICATION_REQUIRED | Reply in the chat if the customer writes first | `src/lib/whatsapp-chat.ts` | `tests/whatsapp-usage.test.ts` | Pricing assumption unverified |
| SMS codes | INTEGRATION_VERIFICATION_REQUIRED | Twilio or an HTTP gateway | `src/lib/transports.ts` | `tests/phone-methods.test.ts` | — |
| Email (SMTP) | INTEGRATION_VERIFICATION_REQUIRED | nodemailer with calendar invite and unsubscribe headers | `src/lib/transports.ts` | `tests/transports.test.ts` | SPF/DKIM unverified |
| Geocoding | INTEGRATION_VERIFICATION_REQUIRED | Address and pin lookups, cached | `src/lib/geo.ts` | `tests/geo.test.ts` | Public server's usage policy |
| Error and alert sinks | INTEGRATION_VERIFICATION_REQUIRED | Sentry envelope; chat webhooks | `src/lib/error-log.ts`, `src/lib/alerts.ts` | `tests/error-log.test.ts` | — |
| Public API and keys | IMPLEMENTED_AND_TESTED | Read, write and availability keys; venue-scoped | `src/lib/api-keys.ts`, `src/lib/public-api.ts` | `tests/public-api.test.ts` | — |
| Outgoing signed webhooks | IMPLEMENTED_AND_TESTED | Sweep, HMAC, retries, private addresses refused | `src/lib/webhooks.ts` | `tests/public-api.test.ts` | Address not pinned per connection |
| Reserve with Google feeds | PARTIALLY_IMPLEMENTED | Merchant, service and availability feeds, downloaded by owners | `src/lib/google-feeds.ts` | `tests/public-api.test.ts` | No upload; field names unchecked; no partner status |
| Reserve with Google booking server | BLOCKED | Not built | — | — | Actions Center partner approval |
| Smart-lock credentials | BLOCKED | Not built | — | — | Vendor credentials |
| Billplz refunds and subscriptions | UNSUPPORTED | Billplz offers no such API; refunds are marked by hand | `src/lib/payments.ts` | — | — |

## Localisation and regions

Authoritative: [regions and tax](regions-and-tax.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| English, Malay, Chinese; translated refusals | IMPLEMENTED_AND_TESTED | Typed dictionaries; refusals carry codes | `src/lib/i18n.ts`, `src/lib/i18n-zh.ts`, `src/lib/api.ts` | `tests/i18n.test.ts`, `tests/locale.test.ts` | — |
| Tamil | PARTIALLY_IMPLEMENTED | Complete dictionary | `src/lib/i18n-ta.ts` | `tests/i18n.test.ts` | Machine translation awaiting a native speaker's review |
| Countries, money, phone numbers | IMPLEMENTED_AND_TESTED | Malaysia or Singapore per install; cents; `phone_key()` | `src/lib/region.ts`, `src/lib/phone.ts` | `tests/region.test.ts`, `tests/cents.test.ts`, `tests/phone-region.test.ts` | One country per install |
| Per-venue time zones | IMPLEMENTED_AND_TESTED | From the map pin or chosen | `src/lib/zones.ts` | `tests/time-zones.test.ts` | — |

## Operations

Authoritative: [deployment](../operations/deployment.md), [backups](../operations/backups.md), [monitoring](../operations/monitoring.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Scheduler and its lease | IMPLEMENTED_AND_TESTED | Minute tick; one instance works | `src/lib/scheduler.ts` | `tests/scheduler.test.ts`, `tests/scale-out.test.ts` | — |
| Rate limiting | IMPLEMENTED_AND_TESTED | In memory or shared in Postgres; IPv6 per /64 | `src/lib/rate-limit.ts` | `tests/rate-limit.test.ts` | — |
| Nightly backups by the app | IMPLEMENTED_AND_TESTED | `pg_dump` or PGlite snapshot; verified; kept 14 | `src/lib/backup.ts` | `tests/backup.test.ts` | A `pg_dump` copy is listed, not loaded |
| Backup, restore and import scripts | IMPLEMENTED_AND_TESTED | `npm run backup`, `npm run restore`, `npm run import-sqlite` | `scripts/backup.mjs`, `scripts/restore.mjs`, `scripts/import-sqlite.mjs` | `tests/backup-scripts.test.ts` | Backup and restore round-trip on a fresh database; the SQLite import is tested only for starting, not on a real old file |
| Alerts, health, error log | IMPLEMENTED_AND_TESTED | Alert once, again after six hours; `/api/health` | `src/lib/alerts.ts`, `src/app/api/health/route.ts` | `tests/alerts.test.ts`, `tests/error-log.test.ts` | — |
| Database layer and migrations | IMPLEMENTED_AND_TESTED | Postgres or PGlite; migrations under a lock | `src/lib/db.ts` | `tests/db.test.ts`, `tests/query-plans.test.ts` | Migration lock not tested directly |
| DigitalOcean kit and CI | IMPLEMENTED_UNTESTED | Droplet set-up, deploy with rollback; CI on both engines | `deploy/digitalocean/setup.sh`, `deploy/digitalocean/deploy.sh`, `.github/workflows/ci.yml` | — | Not run on a real droplet by any test |
| Documentation checks | IMPLEMENTED_AND_TESTED | Links, paths, scripts, variables, routes, this matrix | `tests/docs.test.ts` | `tests/docs.test.ts` | Cannot check behaviour |
