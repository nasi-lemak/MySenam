# MySenam launch audit, 23 October 2026

A second pass over the market-coverage matrix of the October go-to-market
research (section 2 of
[the product audit](../research_notes/MySenam%20go%20to%20market%20research/product_audit.md)
and the feature and gap tables of
[the report](MySenam%20go%20to%20market%20research.md)), after the launch
batches recorded under *Delivered* in the
[roadmap](../docs/roadmap/roadmap.md#delivered). What works is in
[feature status](../docs/product/feature-status.md); what is wrong or
unverified is in [known limitations](../docs/roadmap/known-limitations.md).
This report does not repeat them; it says, for each gap the research named,
where it stands now, and lists what is still open in three separate groups.

## Summary

Of the 28 gaps the research named, 18 are closed and tested; 5 are closed in
part (online sales but not passes, an accounting export but no live link,
four customer languages but an English admin, two gateways but not the other
Malaysian ones, a manifest but no service worker); and 5 are open: DUPR, IoT
lighting, Apple sign-in, a native app, and customers. Every security and
trust gap the research said would surface before any feature gap (password
reset, 2FA, the activity log, the default password, headers, the Origin
check, hashed sessions, backup alerts) is closed. What stands between this
code and a paying venue is no longer mostly code: it is live checks of
twenty integrations, a lawyer's read of the terms and privacy notice, the
decisions listed at the end, and the customer evidence the research's
30-day plan is for.

## The matrix, then and now

"Then" is the research of 18 October; "now" is the code on this branch.

| Gap named by the research | Now | Evidence |
| ------------------------- | --- | -------- |
| No password reset or change | Built | `tests/password-reset.test.ts` |
| No 2FA | Built, optional, or required by `MYSENAM_STAFF_2FA` | `tests/two-factor.test.ts` |
| Nothing records which staff member marked a booking paid | Built: staff activity log | `tests/roles.test.ts` |
| Default owner password published, only a warning | Refused in production; no owner made without a proper one | `tests/launch-security.test.ts`, `tests/e2e/launch.e2e.ts` |
| No CSP, HSTS or framing headers; no Origin check | Built | `tests/launch-security.test.ts`, `tests/e2e/launch.e2e.ts` |
| Session tokens stored in plain text | Stored as SHA-256 | `tests/auth.test.ts` |
| Rate limits in process memory | Optional shared counters in Postgres | `tests/scale-out.test.ts` |
| No email when a backup fails; no error tracking | Alerts by email and webhook; errors listed, optionally to Sentry | `tests/alerts.test.ts`, `tests/error-log.test.ts` |
| No reminders | Built | `tests/urgent.test.ts` |
| No deposits or required prepayment | Built: pay to hold, deposits | `tests/holds.test.ts`, `tests/deposits.test.ts` |
| No online pass, membership or credit sales | Memberships, credit top-ups and gift vouchers online; **passes still only at the counter** | `tests/membership-join.test.ts`, `tests/topups.test.ts` |
| No recurring member billing | Built through Stripe | `tests/membership-renewal.test.ts` |
| No refunds through an API | Built through Stripe, now race-free | `tests/stripe-refunds.test.ts` |
| No SST/GST; no MyInvois | Built | `tests/tax.test.ts`, `tests/myinvois.test.ts` |
| No accounting export | Export for SQL Account, AutoCount, Xero, QuickBooks to import; **no live integration** | `tests/accounting.test.ts` |
| No coach accounts or payouts | Built (coach links, payouts report) | `tests/coaching.test.ts` |
| No walk-in POS | Built: counter sales | `tests/counter-sales.test.ts` |
| No CSV export or audit log (multi-site operators) | Built | `tests/export.test.ts`, `tests/roles.test.ts` |
| Only EN/MS | Customer side in EN, MS, ZH, TA (TA awaiting a native speaker); **admin English only** | `tests/i18n.test.ts` |
| Stripe absent; one Malaysian gateway | Billplz and Stripe; **no iPay88, senangPay, toyyibPay, Curlec, eGHL, HitPay** | `tests/payments.test.ts`, `tests/gateways.test.ts`, `tests/stripe.test.ts` |
| No PWA manifest | Manifest and icons; **no service worker, offline mode or push** | — |
| No browser end-to-end tests | Six browser tests of the main journeys on the production build; CI is set to run them | `tests/e2e/launch.e2e.ts` |
| No padel; no 90-minute slots; no squash, basketball, volleyball, table tennis or sepak takraw | Built: padel, squash, table tennis, football, basketball, volleyball, netball and sepak takraw, in four languages; padel sold by the half hour beside sports sold by the hour, and searched in its 90 minutes ([ADR 0009](../docs/architecture/decisions/0009-half-hour-diary-sold-by-sport.md)) | `tests/sports.test.ts`, `tests/e2e/sports.e2e.ts` |
| No DUPR or player ratings | **Not built**: levels and box leagues only | — |
| No IoT lighting (competitors sell it at RM199) | **Not built** | — |
| No Apple sign-in | **Not built** (the identity table allows it) | — |
| No native app | **Not built**: responsive site | — |
| Zero venues, zero users | **Unchanged**: no customer evidence yet | — |

Every test file named in the evidence column was checked to exist when this
was written.

## Unresolved: market gaps

What competitors offer and MySenam still does not. None of these is a launch
blocker for the segment the research recommends (independent badminton and
futsal halls that book by WhatsApp); each is a reason a particular venue might
choose someone else.

| Gap | Who it costs | What it would take |
| --- | ------------ | ------------------ |
| **Admin in English only** (0 of 63 admin components translated) | Older or Chinese-speaking hall owners, the research's segment 1 | Moving the admin strings into the dictionaries, as the customer side was; large but mechanical |
| **Passes not sold online** (memberships, credit and vouchers are) | Venues selling 10-visit passes | A `pass` payment purpose (migration to the CHECK), checkout, and issuing the pass when paid |
| **Malaysian gateways beyond Billplz** (iPay88, senangPay, toyyibPay, Curlec, eGHL, HitPay) | Venues already contracted to one | An adapter each behind the gateway layer (`src/lib/gateways`), and a live check each |
| **No DUPR or player ratings** | Pickleball venues (segment 2) | A rating model, or DUPR's partner API |
| **No IoT court lighting** (local competitors sell it at RM199) | Venues wanting lights on with a booking | A hardware partner (Tuya or a relay controller), like smart locks |
| **No Apple sign-in** | iPhone users who will not use Google or a password | An Apple developer account; the identity table already allows `apple` |
| **No native app, service worker, offline mode or web push** | Players expecting an app icon that works offline | Web push and a service worker first (see the roadmap); a native app is a separate product |
| **No live accounting integration** (export only) | Multi-site operators | Xero or QuickBooks API clients; SQL Account and AutoCount have no common API |
| **No marketplace demand**: zero venues, zero players | Every venue that buys software to get bookings | Not software: the research's 30-day validation plan |

## Unresolved: live verification

Twenty capabilities are tested against fakes only and stay
`INTEGRATION_VERIFICATION_REQUIRED` until checked against the real service
([go-live checklist](../docs/operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)):
Billplz bills and callbacks; Stripe Checkout, webhooks, refunds, disputes
(now including the platform's own account) and renewals; MyInvois connection,
consolidated invoices and customers' own e-invoices; Google sign-in; off-site
backup copies; the photo bucket; WhatsApp templates, webhook and chat replies;
SMS codes; email; geocoding; and the error and alert sinks. Each needs an
account only the operator can open; none was opened here.

## Unresolved: decisions for review

Not changed here, because each changes a business rule, payment behaviour or
the product's shape. Each is recorded where it lives.

1. **A lost dispute on what a venue paid the platform** is recorded and put to
   the owners, but the invoice stays paid and a WhatsApp pack stays credited.
   Undoing them automatically would also start the overdue clock that unlists
   a venue ([payments](../docs/features/payments-and-credit.md#paying-online)).
2. **A deposit charged back after the rest was paid at the counter** now
   leaves the booking owing the deposit's part (the cash keeps its own
   receipt). This is new payment behaviour, matching what already happened
   when the whole booking was paid online. **After the rest was paid online**
   the booking still stays paid
   ([business rules](../docs/product/business-rules.md)).
3. **A Stripe refund with no clear answer** (a timeout, Stripe's own error)
   now stays claimed and is asked again after ten minutes under the same key,
   rather than being owed again at once; staff see a message saying so.
4. **Inline scripts** are still allowed by the content security policy;
   per-request nonces would make every page render on request
   ([security](../docs/architecture/security.md#response-headers)).
5. **In production the published default owner password opens nothing**, and
   an owner still on it is given `ADMIN_PASSWORD` at start; an install without
   a proper `ADMIN_PASSWORD` starts with no owner.
6. **Pricing defaults** (`MYSENAM_VENUE_FEE=0`, one free month, the WhatsApp
   pack price) are unchanged; the research's price cards are a decision, not a
   code change.
7. **Two booking rules await a decision**: cancelling a weekly series skips
   weeks inside the cutoff rather than charging them as late, and rescheduling
   does not check the target court's length limits
   ([known limitations](../docs/roadmap/known-limitations.md#booking-and-availability-b)).
8. **Web push** is a feature with a migration, a service worker and a product
   question (what is worth a push beside email and WhatsApp), not a launch
   requirement; it is left PLANNED.
9. **The half-hour diary** ([ADR 0009](../docs/architecture/decisions/0009-half-hour-diary-sold-by-sport.md))
   replaced ADR 0008 before production, as agreed, and is the one item here
   that was changed rather than left: migration 0088 rewrites every slot
   stored by the hour into its two halves, and the public API's booking
   `hours` are starts of each court's `unit`, now given in its availability.
10. **Legal**: `/terms` and `/privacy` are drafts; no lawyer has read them or
   their translations. The privacy notice now names the operator to write to
   once `OPERATOR_NAME` and `OPERATOR_EMAIL` are set.

## How this was verified

Locally, in this session: the whole suite (1,786 tests) on PGlite and on
Postgres 16, the end-to-end tests on a production build in Chromium,
`npm run lint`, `npm run typecheck` and `npm run docs:check`. **Not in CI:**
every GitHub Actions run on this branch since 22 October (run 156 onwards)
ended within seconds of starting with no log, before any step ran, which is
what Actions does when the account has no minutes or hits its spending limit.
That is a setting on the GitHub account, not something in this repository;
until it is fixed, CI's checks are not running.

## Dependencies

`npm audit --omit=dev` finds nothing in what runs in production. In
development tools: Next.js's ESLint plugin pins a `fast-glob` whose `braces`
is flagged (it only ever reads this repository's own patterns; the only fix
offered is an older Next.js config), and an advisory on the Vite version in the
test toolchain predates this work (its fix upgrades the test toolchain, left
for a deliberate update).
