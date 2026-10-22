# Known limitations and gaps

Authoritative list of what is known to be wrong, missing or unverified, kept
apart from what works ([feature status](../product/feature-status.md)) and
from ideas ([roadmap](roadmap.md)). Recorded during the
[documentation audit](../documentation-audit.md) of October 2026 from reading
the code and running its tests; **no application code was changed by that
audit**, so every defect below is still open unless a later change says
otherwise.

Priorities:

- **P0** — critical security, data-integrity or financial-correctness issue.
- **P1** — required for a reliable production launch.
- **P2** — important for broader adoption or operational efficiency.
- **P3** — optional enhancement.

## Suspected defects

"Confirmed" means the cause was confirmed by reading the code (and, where
noted, reproduced); none has a failing test in the repository yet. Each has
the test that should be written before it is fixed.

### Operations and security (S)

| ID | Pri | What goes wrong | Evidence | Launch blocker | Recommended test |
| -- | --- | --------------- | -------- | -------------- | ---------------- |
| S3 | P2 | The scheduler lease (three minutes) is renewed when a tick starts, not during it; a long tick (large `pg_dump` plus upload) lets a second instance start the same work. Webhook deliveries have no per-delivery claim, so they could go out twice. | `src/lib/scheduler.ts`, `src/lib/webhooks.ts` | Only for several instances | Hold the lease, stall past it, assert a second instance does no work |

Also: there is **no CSRF token or `Origin` check**; cross-site requests are
stopped by `SameSite=Lax` cookies alone (P3).

### Booking and availability (B)

| ID | Pri | What goes wrong | Evidence | Launch blocker | Recommended test |
| -- | --- | --------------- | -------- | -------------- | ---------------- |
| B1 | P2 | Two big courts over the same small one: booking one does not mark the other taken in the grid, search or any-court; booking it then fails as "filling up". The database still prevents the double booking. Blocks on one big court do not reach the other either. | `db/migrations/0072_linked_courts.sql` trigger shadows whole↔part only | No | Link W1→P and W2→P; book W1; assert W2 shows taken |
| B2 | P2 | Waiting-list holds are respected only by the grid and the booking path, not by search, any court, moving, rescheduling or the move picker, so a held place can be taken and the waiter's claim then fails. | `offerHolds` callers in `src/lib/store.ts` | No | Offer a slot; move or reschedule another booking into it; expect refusal |
| B3 | P3 | A partly blocked shared facility with a waiting-list hold can be booked past what the grid shows. | `freeSeat` vs `blockedOut` in `src/lib/store.ts` | No | Capacity 3, one blocked, one held, one booked: expect refusal |
| B4 | P2 | Creating an outage is not one transaction (check, cancel, insert), and classes on a linked court are not listed; a booking made meanwhile lands in the outage untold. Tournament clash checks are similarly outside their transaction. | `src/lib/outages.ts`, `src/lib/tournaments.ts` | No | On Postgres, create an outage and a booking at once; assert no confirmed booking inside it |
| B5 | P3 | Changing a venue's slot length can race a booking made with the old length. | `createBookingSeries` reads the step outside its transaction | No | — |
| B6 | P3 | Courts may allow bookings up to twelve hours, but search and waiting lists accept at most four. | `src/lib/store.ts`, `src/app/api/search/route.ts` | No | Search for a five-hour slot on a court that allows it |
| B7 | P3 | Moving and rescheduling check blocks and classes outside their transaction. | `moveBooking`, `rescheduleBooking` in `src/lib/store.ts` | No | Concurrent block and move |
| B8 | P3 | A booking of several courts is undone by compensating deletes rather than one transaction; an exception part-way leaves earlier courts booked. | `createGroupBooking` in `src/lib/store.ts` | No | Force a failure on the third court |

Also: cancelling a weekly series skips weeks inside the cancellation cutoff
silently rather than applying the late-cancel policy to them; rescheduling
does not check the target court's booking-length limits (P3, unconfirmed
whether intended).

### Money (M)

No numbered money defect is open; see [fixed since the audit](#fixed-since-the-audit).

Also: if a manual "refunded" mark and a Stripe one-click refund race, money
can go back twice at the gateway (reported, not prevented); disputes on the
platform's own Stripe account (venue invoices) are ignored; a deposit charged
back after the rest was paid at the counter is credited, but the booking stays
paid and staff must collect the difference by hand (P3).

### Fixed since the audit

IDs are not reused. Each fix came with the test recommended above.

| ID | Fixed by | Test |
| -- | -------- | ---- |
| S1 | Script-loaded modules import with file extensions | `tests/backup-scripts.test.ts` |
| S2 | Erasure takes the account off waiting lists before deleting it | `tests/privacy.test.ts` |
| S4 | Session expiry is written in `datetime()` form, so it compares to the second | `tests/auth.test.ts` |
| S5 | Wrong passwords for one account are also counted from any address | `tests/login-limits.test.ts` |
| S7 | Sessions keep the SHA-256 of their token; a migration converted those issued | `tests/auth.test.ts` |
| S8 | The retention run deletes phone check codes after a day | `tests/privacy.test.ts` |
| S6 | Documented: several instances share one `MYSENAM_SECRET` ([architecture](../architecture/overview.md#more-than-one-instance)) | — (configuration) |
| M1 | A handed-back share leaves the booker owing it; what they paid online gets its own receipt, dated when paid | `tests/games.test.ts` |
| M2 | A lost dispute takes back only what went back, and unwinds deposits and parts paid | `tests/stripe-disputes.test.ts` |
| M4 | A lost dispute is claimed once, in the transaction that acts on it | `tests/stripe-disputes.test.ts` |
| M3 | Marking a series paid at the counter is one statement that skips weeks already paid | `tests/series-payment.test.ts` |
| M5 | The set-up text is built from the events the webhook handles | `tests/stripe-disputes.test.ts` |
| M6 | A booking that stops being paid keeps its receipt, dated when paid | `tests/stripe-disputes.test.ts` |
| M7 | A receipt covering several bookings is credited one booking's part at a time, never past its total | `tests/deposits.test.ts` |
| M8 | A refund as credit goes into the pot the credit scope names | `tests/auto-refunds.test.ts` |

## Integrations awaiting live verification or a partner

Implemented and tested against fakes only. Each needs one real check before it
is relied on ([launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)).

| Integration | State | Blocks launch |
| ----------- | ----- | ------------- |
| Billplz (FPX, cards, callbacks, X-Signature) | Needs sandbox verification | Yes, for online payment in Malaysia |
| Stripe Checkout, webhooks, refunds, disputes, renewals | Needs test-mode verification | Yes, for online payment in Singapore and renewals |
| WhatsApp Cloud API (templates must be approved by Meta) | Needs approval and a live send | No: email works without it |
| Email (SMTP), including SPF/DKIM and calendar invites | Needs a live send | Yes: confirmations go by email |
| SMS (Twilio or HTTP gateway) for phone codes | Needs a live send | Only where phone checks use SMS |
| LHDN MyInvois | Needs sandbox (preprod) verification | Only for venues that must e-invoice |
| Google sign-in | Needs a registered redirect URI | No: password sign-in works |
| S3-compatible off-site backups and photo storage | Needs a real bucket | Off-site backups: yes, for production |
| Reserve with Google | Feeds only; needs Actions Center partner approval and a booking server that is **not built** | No |
| Smart locks (TTLock, Igloohome) | Not built; blocked on vendor credentials | No |
| Stripe Connect payouts, Singapore InvoiceNow, web push, LINE, Zalo | Not built; each needs a partner or contract | No |

## Deliberately unsupported

- **Demand-based ("surge") pricing.** Raising prices when busy teaches regulars
  to wait and reads as a trick where a court is a known price. Venues have
  fixed peak and off-peak bands, holidays, an opt-in last-minute discount and
  a free hour for regulars instead.
- **Referral credit** ("give RM10, get RM10"): with bookings by phone number
  and no proof two numbers are two people, it pays people to refer themselves.
- **One country per install.** Malaysia and Singapore are separate installs
  ([regions](../product/regions-and-tax.md)).
- **Storefront domains are not data separation.** A business needing its own
  customers and database gets its own install
  ([ADR 0005](../architecture/decisions/0005-shared-marketplace-and-own-installs.md)).
- **No turnstile or per-person door credentials**: unstaffed access is one
  code per lock, and software can attribute an entry but not prevent
  tailgating ([venue operations](../features/venue-operations.md)).

## Gaps in verification and documentation

| Gap | Consequence | Priority |
| --- | ----------- | -------- |
| No automated browser (end-to-end) tests | Pages are checked by hand only | P2 |
| No ESLint configuration; `npm run lint` is not a working check | Style and some bug classes unchecked | P3 |
| `.env.example` lists about half the variables | New installs miss settings; [configuration](../development/configuration.md) is complete | P3 |
| [HTTP routes](../architecture/http-api.md) lists a subset of routes | Developers read the `route.ts` files for the rest | P3 |
| `/terms` and `/privacy` are drafts that describe the software; not reviewed by a lawyer; PDPA expects a Malay notice and a named contact | Legal exposure | P1 before public launch |
| Cross-venue `403` checks are tested on about a dozen routes; the rest rely on the `401` sweep plus code review | A wrong venue comparison in an untested route would not be caught | P2 |
