# Roadmap

Ideas not yet built, and a record of what has been delivered from them.
**Nothing in the ideas table is operational.** What works is in
[feature status](../product/feature-status.md); what is broken or unverified
is in [known limitations](known-limitations.md), and fixing those comes before
anything here.

| Idea | Status | Why, and what it needs |
| ---- | ------ | ---------------------- |
| Per-person credentials through a smart-lock vendor (TTLock, Igloohome; Igloohome's offline algoPIN suits a door with no wifi), so an unstaffed resource issues one credential per person instead of one code per lock | BLOCKED | Vendor credentials. The induction record and the customer's entry screen are already the right shape for it. It is what 24-hour gym chains use, and the biggest gap in unstaffed access. |
| A turnstile rather than a door | DEFERRED | The only real answer to tailgating (one credential, one body); a hardware decision for each venue. |
| Reserve with Google's real-time Booking Server, and uploading the feeds | BLOCKED | Actions Center partner approval. The feeds exist as a draft ([external API](../integrations/external-api.md#reserve-with-google-readiness-only)). |
| Stripe Connect payouts to venues | DEFERRED | Venues take payment into their own accounts today ([ADR 0006](../architecture/decisions/0006-per-venue-payment-accounts.md)). |
| Singapore InvoiceNow (Peppol) e-invoicing | BLOCKED | An agreement with a Peppol access point provider; MyInvois covers Malaysia. |
| Web push notifications | PLANNED | No provider account: VAPID keys of the install's own, a service worker (the app has a manifest but none yet), a stored subscription per browser, and an opt-in on the confirmation screen. A migration and a new dependency or an encryption routine; a product decision on what is worth a push, since email and WhatsApp already carry every message. |
| LINE and Zalo messaging | BLOCKED | Each needs its own business account with the provider (LINE Official Account; Zalo OA), and both matter for a move into Thailand or Vietnam rather than Malaysia or Singapore, where customers are reached by WhatsApp and email. |

## Delivered

Work taken from this page and from [known limitations](known-limitations.md),
in the order it was done, with what shows it works and what is still open.
Done means the acceptance criterion below was checked, not that code exists.

| Batch | Acceptance criterion | Evidence | Still open |
| ----- | -------------------- | -------- | ---------- |
| 1. Trust blockers before a venue sees it (from the market research's first five days) | Every response carries a content security policy that forbids framing and foreign scripts, HSTS, `nosniff`; a signed-in write from another site gets `403`; in production the published default owner password opens nothing and no owner is made without a proper one; a browser books a court and signs in on the production build | `tests/launch-security.test.ts`; `tests/e2e/launch.e2e.ts` (production build, Chromium) | Inline scripts still allowed by the policy (nonces: for review). Uptime monitoring is outside the app (`/api/health` is ready for one) |
| 2. Tenant isolation proven on every route | No admin route, called by another venue's manager with this venue's identifiers, shows or changes anything of it; the same between customers on `/api/my`; well-formed money and court-sheet writes refused with `403`/`404` | `tests/tenant-sweep.test.ts` (143 checks; fails when a venue check is removed, tried three times) | No defect found. Routes answering for the caller's own venue (13 calls) are not a leak but are not a refusal either |
| 3. The last money gaps (known limitations M9–M11) | A hand mark made while a Stripe refund is in flight is refused, so the money goes back once; a refund interrupted mid-call, or answered with a server error, stays claimed and is asked again under the same idempotency key, then recorded or owed again; a dispute signed with the platform's secret is recorded and emailed to the owners, not the venue; a deposit charged back after the rest was paid at the counter leaves the booking owing the deposit's part, with the cash on its own receipt and the books balanced once collected | `tests/stripe-refunds.test.ts` (the race test fails without the claim), `tests/stripe-disputes.test.ts` (the platform test fails without the new path) | All against a fake Stripe, and called through the webhook route rather than a browser (no end-to-end test: it needs a Stripe to talk to); needs the test-mode check in [deployment](../operations/deployment.md). For review: a lost platform dispute is not undone automatically, and a deposit charged back after the rest was paid online leaves the booking paid |
| 5. Webhooks connect only where they were checked (the one PLANNED item buildable without an outside account) | A webhook's host is looked up by the connection itself, every address must be public, and the connection goes to one of those; a name that answers publicly once and privately the next time is refused; numeric private addresses are refused without a lookup | `tests/public-api.test.ts` ("connect only to an address the check passed…", which fails with the check removed) | Web push assessed, not built: it is a feature with a migration, a service worker and a product decision, not a launch requirement (for review). InvoiceNow, LINE and Zalo are BLOCKED on provider accounts |

Deliberate exclusions (surge pricing, referral credit) are recorded under
[known limitations](known-limitations.md#deliberately-unsupported), not here.
