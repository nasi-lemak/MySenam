# Known limitations and gaps

Authoritative list of what is known to be wrong, missing or unverified, kept
apart from what works ([feature status](../product/feature-status.md)) and
from ideas ([roadmap](roadmap.md)). First recorded by the
[documentation audit](../documentation-audit.md) of October 2026. The numbered
defects it found (S, B, M) have since been fixed, each with a test, and are
listed under [fixed since the audit](#fixed-since-the-audit); what remains
below is open.

Priorities:

- **P0** — critical security, data-integrity or financial-correctness issue.
- **P1** — required for a reliable production launch.
- **P2** — important for broader adoption or operational efficiency.
- **P3** — optional enhancement.

## Suspected defects

A new defect gets a row here with its evidence and the test to write before
it is fixed, and moves to *fixed since the audit* with that test.

### Operations and security (S)

No numbered operations or security defect is open; see
[fixed since the audit](#fixed-since-the-audit).

Also: there is no CSRF token, by design: cross-site writes are refused by
`SameSite=Lax` and an `Origin` check ([security](../architecture/security.md#requests-from-another-site)).
The content security policy allows inline scripts; moving to per-request
nonces is open for review (P3).

### Booking and availability (B)

No numbered booking defect is open; see
[fixed since the audit](#fixed-since-the-audit).

Also, **awaiting a decision** (the code may be intended): cancelling a weekly
series skips weeks inside the cancellation cutoff silently rather than
applying the late-cancel policy to them (P3, unconfirmed whether intended).

**Decided, for the owner to confirm:** a customer's reschedule is now held to
the target court's booking rules, its length included, where before the
length was kept even if those rules would not offer it. A manager can still
move it outside the rules, on record ([business rules](../product/business-rules.md#bookings)).

Known limits of the [booking time model](../architecture/interval-booking-review.md)
(the owner's decisions and the defaults chosen for open questions are listed
there):

- **No load benchmark yet** of availability and search on claims at
  marketplace size (hundreds of venues, weeks of bookings); `tests/query-plans.test.ts`
  checks the indexes are used, not the timings (P2).
- **Unstaffed hours are whole hours** (`staffed_from`/`staffed_to`), while
  bookings are to the minute: a booking from 21:30 at a venue staffed until
  22:00 counts as staffed (P3).
- **Daylight saving** is not handled: a wall-clock time that never happens or
  happens twice has no defined meaning for a booking. No zone in any
  supported country has it, and `tests/time-zones.test.ts` fails if one is
  added, so it cannot reach a venue unnoticed (P3 until a country with it
  is planned).
- **Outages migrated from the half-hour diary** cover whole calendar days of
  their dates; outages made since also cover the late hours past midnight
  (P3).
- **Adjacent buffers add up**: two bookings each with a 10-minute buffer on
  the side they meet are 20 minutes apart, not 10 (by design, for review).
- **The old tables are gone** (migration 0091): rolling back the upgrade is
  restoring the backup taken before it
  ([deployment](../operations/deployment.md#upgrading)).

### Activities

What the [activity catalogue](../features/activities.md) does not yet do:

- **Basic and specialised activities lack part of their usual workflow**:
  bowling by the game, day passes for climbing and bouldering, kinds and
  sizes in one fleet, launch and tide windows, range officers per session,
  fencing bouts and track heats. Each is listed in the
  [support matrix](../features/activities.md#support-matrix) and planned in
  the [roadmap](roadmap.md); operators see the note as they pick one (P2).
- **An operator's own activity** is named in English unless they give the
  other languages, and is *basic* until someone reviews whether its
  workflow fits the models (P3).
- **Sign-offs are checked by phone number.** Without phone checks, anyone who
  types a signed-off number can book as that person; staff see who arrives
  (P2, as for every rule keyed on a number).
- **One booking takes at most eight places** unless the venue sets the most
  per booking, even on a fleet of twenty (by design, for review).
- **A catalogue change** made on one instance reaches the others within a
  minute (the cache), and the browser on its next page (P3).
- **Country names exist for countries the app is not yet sold in** (sepak
  takraw in Thailand and the Philippines); they take effect only once that
  country is added ([regions](../product/regions-and-tax.md)).
- **The column is still called `sport`** in the database, URLs and the public
  API, for compatibility; it holds any activity
  ([ADR 0011](../architecture/decisions/0011-activities-as-data.md)).
- **The integrity check** looks from yesterday on and lists up to 50 problems
  of each kind ([monitoring](../operations/monitoring.md)).

### Money (M)

No numbered money defect is open; see [fixed since the audit](#fixed-since-the-audit).

Also: a deposit charged back after the rest was paid online leaves the
booking paid, and staff collect the difference by hand; a lost dispute on
what a venue paid the platform (an invoice, a WhatsApp pack) is reported to
the owners but not undone, by design until decided otherwise (P3).

### Fixed since the audit

IDs are not reused. Each fix came with the test recommended above.

| ID | Fixed by | Test |
| -- | -------- | ---- |
| S1 | Script-loaded modules import with file extensions | `tests/backup-scripts.test.ts` |
| S2 | Erasure takes the account off waiting lists before deleting it | `tests/privacy.test.ts` |
| S3 | The lease is renewed every minute while a tick runs; each webhook delivery is claimed before it is sent | `tests/scale-out.test.ts`, `tests/public-api.test.ts` |
| S4 | Session expiry is written in `datetime()` form, so it compares to the second | `tests/auth.test.ts` |
| S5 | Wrong passwords for one account are also counted from any address | `tests/login-limits.test.ts` |
| S7 | Sessions keep the SHA-256 of their token; a migration converted those issued | `tests/auth.test.ts` |
| S8 | The retention run deletes phone check codes after a day | `tests/privacy.test.ts` |
| S6 | Documented: several instances share one `MYSENAM_SECRET` ([architecture](../architecture/overview.md#more-than-one-instance)) | — (configuration) |
| B1 | Big courts sharing a part shadow each other, and their blocks carry; migration 0087 | `tests/court-links.test.ts` |
| B2 | Search, any court, the move picker, moving and rescheduling count waiting-list offers through one function | `tests/waitlist.test.ts` |
| B3 | Choosing a place counts blocked places as well as offers | `tests/waitlist.test.ts` |
| B4 | An outage is saved in a transaction that re-checks; classes on linked courts are listed; tournament clashes are re-checked in theirs | `tests/outages.test.ts`, `tests/court-links.test.ts` |
| B5 | Court time is exact intervals under one database constraint, so bookings of any length meet correctly ([ADR 0010](../architecture/decisions/0010-interval-booking.md); first fixed by half-hour rows under ADR 0009) | `tests/intervals.test.ts` |
| B6 | Search and the waiting list take as long a booking as the court allows | `tests/booking-lengths.test.ts` |
| B7 | Moving and rescheduling check blocks, classes and offers inside their transaction | `tests/move.test.ts` (guards the outcome; the race is not forced) |
| B8 | A group booking is one transaction | `tests/group-bookings.test.ts` |
| M1 | A handed-back share leaves the booker owing it; what they paid online gets its own receipt, dated when paid | `tests/games.test.ts` |
| M2 | A lost dispute takes back only what went back, and unwinds deposits and parts paid | `tests/stripe-disputes.test.ts` |
| M4 | A lost dispute is claimed once, in the transaction that acts on it | `tests/stripe-disputes.test.ts` |
| M3 | Marking a series paid at the counter is one statement that skips weeks already paid | `tests/series-payment.test.ts` |
| M5 | The set-up text is built from the events the webhook handles | `tests/stripe-disputes.test.ts` |
| M6 | A booking that stops being paid keeps its receipt, dated when paid | `tests/stripe-disputes.test.ts` |
| M7 | A receipt covering several bookings is credited one booking's part at a time, never past its total | `tests/deposits.test.ts` |
| M8 | A refund as credit goes into the pot the credit scope names | `tests/auto-refunds.test.ts` |
| M9 | A Stripe refund is claimed before Stripe is asked, so a hand mark or second click cannot send it twice; an interrupted one is asked again under its key | `tests/stripe-refunds.test.ts` |
| M10 | Disputes on the platform's own Stripe account are recorded and put to the platform owners | `tests/stripe-disputes.test.ts` |
| M11 | A deposit charged back after the rest was paid at the counter leaves the booking owing the deposit's part | `tests/stripe-disputes.test.ts` |

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
| End-to-end tests cover a few journeys only ([testing](../development/testing.md#end-to-end-tests)) | Most pages are checked by route and component tests, not a browser | P2 |
| `/terms` and `/privacy` are drafts that describe the software; not reviewed by a lawyer, nor are their translations; the terms are English only. The privacy notice names a contact only once `OPERATOR_NAME` and `OPERATOR_EMAIL` are set | Legal exposure | P1 before public launch |
