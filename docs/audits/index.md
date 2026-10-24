# Audits

Dated assessments of MySenam: what was found at one point in time. An audit is
never rewritten to match later code; where its findings stand now is tracked
here, and accepted work is carried to the [roadmap](../roadmap/roadmap.md) or
[known limitations](../roadmap/known-limitations.md), which are maintained.

| Audit | Date | What it covered |
| ----- | ---- | --------------- |
| [Documentation audit](documentation-2026-10-24.md) | 24 October 2026 | This reorganisation: research and audits into `docs/`, programmes split into tournaments and matchmaking, conventions, discrepancies found |
| [Launch audit](launch-2026-10-23.md) | 23 October 2026 | The research's 28 market gaps, where each stood after the launch batches, and what was still open |
| [Documentation audit](documentation-2026-10-22.md) | 22 October 2026 | The README split into `docs/`; the feature-status matrix, known limitations, decision records and documentation checks created |
| [Product audit](../research/go-to-market/product-audit.md) | 18 October 2026 | What the code did, written for the go-to-market research (kept with that research) |

Earlier audits of defects (the S, B and M identifiers) are tracked, fixed or
open, in [known limitations](../roadmap/known-limitations.md).

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

## Adding an audit

Name it `<subject>-<yyyy-mm-dd>.md`, say what it covered and how it was
verified, and never edit its findings afterwards. Carry accepted work into the
roadmap or known limitations, and add its open items to a table here
([documentation](../development/documentation.md)).
