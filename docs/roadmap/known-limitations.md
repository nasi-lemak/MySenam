# Known limitations and gaps

Authoritative list of what is known to be wrong, missing or unverified, kept
apart from what works ([feature status](../product/feature-status.md)) and
from ideas ([roadmap](roadmap.md)). First recorded by the
[documentation audit](../documentation-audit.md) of October 2026. The numbered
defects it found (S1–S8, B1–B8, M1–M11) have since been fixed, each with a
test, and are listed under [fixed since the audit](#fixed-since-the-audit). The
feature inventory audit later that month found B9–B13, M12–M15 and S9–S10,
open below; what stands between the code and a production launch is under
[production readiness](#production-readiness).

Priorities:

- **P0** — critical security, data-integrity or financial-correctness issue.
- **P1** — required for a reliable production launch.
- **P2** — important for broader adoption or operational efficiency.
- **P3** — optional enhancement.

## Suspected defects

A new defect gets a row here with its evidence and the test to write before
it is fixed, and moves to *fixed since the audit* with that test.

### Operations and security (S)

| ID | Defect | Evidence | Test to write first | Priority |
| -- | ------ | -------- | ------------------- | -------- |
| S9 | Tournament, league and open-game emails (and venue applications, password reset and owner alerts) are sent once, directly, not through the [outbox](../integrations/messaging.md): no retry when SMTP fails, no daily cap, not in the venue's delivery list | `sendPlainEmail` in `src/lib/transports.ts` logs a failure and returns; called from `src/lib/tournaments.ts`, `src/lib/leagues.ts`, `src/lib/games.ts` | A failing transport leaves a tournament draw email queued for retry | P2 |
| S10 | Photos kept on the server's disk (no `PHOTOS_S3_*` bucket) are in no backup: they are files, not database rows, and the backup is the database | `src/lib/photo-store.ts`; [discovery](../features/discovery.md); [backups](../operations/backups.md) | — (documented; a production install sets a bucket) | P2 |

Also: a staff member who loses both their phone and their recovery codes is
locked out until somebody edits the database; there is no owner reset of two-factor
(`disableTwoFactor` needs the account's own code) (P3).

Also: there is no CSRF token, by design: cross-site writes are refused by
`SameSite=Lax` and an `Origin` check ([security](../architecture/security.md#requests-from-another-site)).
The content security policy allows inline scripts; moving to per-request
nonces is open for review (P3).

### Booking and availability (B)

| ID | Defect | Evidence | Test to write first | Priority |
| -- | ------ | -------- | ------------------- | -------- |
| B9 | In a groups-then-knockout tournament, a group result changed after the knockout is filled does not refill it: the old group placings stay in the knockout | `fillKnockoutIfGroupsDone` returns once round one is filled (`src/lib/tournaments.ts`) | Correcting the last group result changes who is in the knockout, or is refused once it is filled | P2 |
| B10 | A withdrawal after the draw settles only matches whose opponent is known: later rounds wait for staff to enter a walkover, and the withdrawn player's group wins still count in the standings | `withdraw` and `settleMatch` in `src/lib/tournaments.ts` | A player withdrawn in the groups loses their remaining group matches and their later knockout match by walkover | P2 |
| B12 | Claims are read by time, not by court: search, grids and the capacity trigger read every claim in the time asked for across the marketplace and then filter by court. At 400 venues a search near a point takes 2.4 s (p50) and 3.7 s (p95), an area search 0.7 s, and each capacity check 55 ms where 0.03 ms is possible | `src/lib/claims.ts` (`court_id IN`, `court_spaces` joins), `claim_within_capacity` in `db/migrations/0089_interval_schema.sql`; the indexes key on `int4range(court_id)`/`int4range(space_id)`; [marketplace benchmark](../development/testing.md#results) | `tests/query-plans.test.ts` asserts the court or space is in the index condition, not only the time | P1 for the marketplace; P3 for one venue's install |
| B13 | Fifty bookings at once, each at a different venue, left 17 customers with an error (a serialization failure after eight tries) rather than a booking or a refusal | `src/lib/db.ts` retries `40001` eight times; the reads in B12 span the marketplace, so unrelated bookings conflict; [marketplace benchmark](../development/testing.md#results) | The benchmark's burst ends with no errors; a route answers a lost race with a refusal, never a 500 | P1 for the marketplace |
| B11 | Utilisation counts a pitch and the courts under it as separate sellable hours, so a hall sold as one pitch every evening shows its courts idle then and its utilisation low; time sold is counted once | `src/lib/reports.ts` sums open hours × capacity per court; `tests/court-links.test.ts` ("counts time sold once") | A pitch booked for an evening shows the floor as used, not half idle | P3 |

Also, **awaiting a decision** (the code may be intended): cancelling a weekly
series skips weeks inside the cancellation cutoff silently rather than
applying the late-cancel policy to them (P3, unconfirmed whether intended).


Known limits of the [booking time model](../architecture/interval-booking-review.md)
(the owner's decisions and the defaults chosen for open questions are listed
there):

- **Measured at marketplace size once, by hand** ([results](../development/testing.md#results)),
  which found B12 and B13; not in CI, so a slower query is noticed only when
  somebody runs it again. `tests/query-plans.test.ts` checks the indexes are
  used, not the timings or which columns they are used for (P2).
- **Unstaffed hours are whole hours** (`staffed_from`/`staffed_to`), and
  whether a booking is unstaffed is decided by its start alone
  (`isUnstaffedHour`): a booking from 21:30 to 23:00 at a venue staffed
  until 22:00 counts as staffed, so it gets no door code and its last hour
  depends on the counter letting them stay. Confirmed in the code; still
  open (P3).
- **Daylight saving is not supported**, deliberately: a wall-clock time that
  never happens or happens twice has no defined meaning for a booking.
  Malaysia and Singapore have none. Such a zone cannot be configured by
  accident: staff can only pick one of the country's zones and one that
  keeps a single offset (`keepsOneOffset`), a zone stored any other way is
  ignored for the country's, and `tests/time-zones.test.ts` fails if one is
  added to the region table. The clock functions already work for any
  fixed-offset zone; the path to supporting daylight saving is in the
  [roadmap](roadmap.md) (P3 until a country with it is planned).
- **Outages migrated from the half-hour diary** cover whole calendar days of
  their dates, so at a venue open past midnight their last night's late
  hours stay bookable. Outages made since take those hours too
  (`claimOutage`; `tests/outages.test.ts`, "takes the late hours of its last
  night too"). Only installs with outages from before migration 0090 are
  affected (P3).
- **Adjacent buffers add up**: two bookings each with a 10-minute buffer on
  the side they meet are 20 minutes apart, not 10 (by design, for review).
- **The old tables are gone** (migration 0091): rolling back the upgrade is
  restoring the backup taken before it
  ([deployment](../operations/deployment.md#upgrading)).

### Activities

What the [activity catalogue](../features/activities.md) does not yet do:

- **Basic and specialised activities lack a way they are commonly sold**:
  bowling by the game, gym entry on a membership without a booked session,
  day passes for climbing and bouldering, launch and tide windows for water
  hire, range officers per archery session, cycling heats. Each is in the
  [support matrix](../features/activities.md#support-matrix) and the
  [roadmap](roadmap.md); operators see the note as they pick one (P2).
- **An operator's own activity** is named in English unless they give the
  other languages, and is *basic* until someone reviews whether its
  workflow fits the models (P3).
- **Sign-offs online rest on the customer's account.** A sign-off counts
  online only for the account staff linked it to or one that has proved the
  number; where an install has neither WhatsApp nor SMS to prove numbers
  with, only linked sign-offs work online. At the counter and through the
  venue's API key the number is taken on the staff's or the venue's word.
  Bookings with a coach are held to the rule like any other, so a first
  lesson on a wall that needs a sign-off is booked at the counter (P3, for
  review). A group of places on such an activity is booked at the counter,
  since one sign-off covers one person.
- **One booking takes at most eight places** unless the venue sets the most
  per booking, even on a fleet of twenty (by design, for review).
- **Kinds of kit within one fleet** (single and double kayaks in one booking
  list) are not built: each kind is a resource of its own (P3).
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

| ID | Defect | Evidence | Test to write first | Priority |
| -- | ------ | -------- | ------------------- | -------- |
| M12 | A tournament entry fee paid online after staff marked it paid at the counter is kept as a second payment, with a second receipt, instead of being owed back (league places get this right) | The `entry` branch of settlement in `src/lib/payments.ts` checks for a withdrawal or call-off, not `tournament_entries.paid_at` | Mark an entry paid at the counter, settle its pending online bill: the bill is owed back and no second receipt is issued | P1 |
| M13 | Money kept back from a hire deposit on return is recorded only on the hire: no receipt, no tax, not in takings, reports or the accounting export | `returnHire` in `src/lib/store.ts` writes `hire_records.withheld`; nothing in `src/lib/reports.ts`, `src/lib/accounting.ts` or `src/lib/documents.ts` reads it | Keeping RM20 back appears in the day's takings and the sales journal with a receipt | P2 |
| M14 | A chargeback on credit already spent leaves the account below nothing, deliberately ([business rules](../product/business-rules.md)), but the liability reports count only balances above nothing, so what customers owe in credit appears nowhere | `takeBackWhatItBought` in `src/lib/payments.ts`; `HAVING SUM(amount) > 0` in `src/lib/reports.ts`; no database constraint on `wallet_entries` | A top-up charged back after being spent shows as owed in a report | P2 |
| M15 | Refunding a cancelled booking (receipt credit, credit, pass, online refund owed, promo, game shares, split shares) runs as separate steps after the cancellation commits: a crash between them leaves the booking cancelled and part refunded, and the integrity check looks at time held, not money | `refundBooking` in `src/lib/store.ts`; `src/lib/integrity.ts` | A failure injected after the credit step is found by the integrity check or completed on retry | P2 |

Also: refunding to credit checks "already refunded" outside its transaction
and has no unique index; it is safe only because its one caller runs after
the cancellation is claimed (`refundBookingToWallet` in `src/lib/store.ts`).

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

## Production readiness

Implementation status ([feature status](../product/feature-status.md)) says
what is built and tested; this is what that does not show. Evidence is from
the code and tests as of the feature inventory audit.

| Concern | State | Evidence and what remains |
| ------- | ----- | ------------------------- |
| Load at marketplace size | Not ready | Search takes seconds near a point (B12), and a burst of fifty bookings gave seventeen errors (B13), at 400 venues ([benchmark](../development/testing.md#results)). One venue's install is not affected in the same way: its claims are only its own |
| Double booking and capacity | Enforced by the database | An exclusion constraint on held time per space and a capacity trigger refuse overlaps whatever writes them, raw SQL included (`tests/capacity.test.ts`, "is still the database that prevents overbooking"); expired offers are let go before a claim. Truly parallel only on the Postgres run ([booking concurrency](../architecture/booking-concurrency.md)) |
| Spending credit and pass entries | Spent once | Serializable transactions with retry; `tests/concurrency.test.ts` ("spends credit once", "refunds a pass entry once") on Postgres |
| Refund races | Stripe refunds claimed before Stripe is asked (M9, `tests/stripe-refunds.test.ts`); a cancellation claimed once (`tests/booking-rules.test.ts`, on an unpaid booking) | No test races two cancellations of a *paid* booking; the refund steps are not atomic (M15); an online tournament fee after a counter mark is kept (M12) |
| Negative stored credit | Possible on purpose after a chargeback | Not in liability reports (M14); no database guard |
| Money outside the books | Hire deposits kept back (M13) | Everything else that takes money is receipted |
| Linked courts in reports | Time sold counted once; sellable time counted per court (B11) | Utilisation reads low for halls sold as one floor |
| Identity | Accounts are identities; phone numbers are not, unless proved | A number is proved only where WhatsApp or SMS is configured, and those are tested against fakes; without them numbers are taken as given. A member's number typed by anyone gets the member rate (by design); reviews are one per number; sign-offs online need the account's own or proved number ([authentication](../architecture/authentication.md), [privacy](../architecture/privacy.md)) |
| Integrations | None checked against the live service | Every payment, message, e-invoice, sign-in and storage integration is tested against fakes ([below](#integrations-awaiting-live-verification-or-a-partner)); rows that take money or send messages name their leg in feature status |
| Backup and restore | Scripts run on both engines | The restore test checks the scripts succeed on a database with no bookings, not that what comes back matches; a `pg_dump` copy made by the app is listed, not loaded; nothing restores from the off-site copy (`src/lib/offsite.ts` only uploads); photos on disk are in no backup (S10). Try a full restore before launch ([backups](../operations/backups.md)) |
| Operational dependencies | Documented | The scheduler runs inside a long-running `next start` (or the operator's cron with `MYSENAM_SCHEDULER=off`); more than one instance needs `MYSENAM_RATE_LIMITS=shared`, one `MYSENAM_SECRET`, a photo bucket, and accepts a minute's lag on catalogue changes ([architecture](../architecture/overview.md#more-than-one-instance)); programme emails are not retried (S9) |

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
| End-to-end tests cover a few journeys only ([testing](../development/testing.md#end-to-end-tests)) | Most pages are checked by route and component tests, not a browser; no test sets a phone-sized screen, though staff and customers use phones | P2 |
| The restore test does not compare data before and after ([backups](../operations/backups.md)) | A restore that loses rows would pass | P1 before launch |
| [Booking concurrency](../architecture/booking-concurrency.md) cites a cancellation race on an unpaid booking only | A double refund of a paid booking under concurrent cancels is prevented by the claim but not tested | P2 |
| Untested paths named in feature status: refund on tournament withdrawal before the draw, a league fee paid after leaving, removing a player from a game, a waiting-list offer keeping a court linked to its own, the two-year prune of the staff activity log, the daily venue shuffle's order | Code exists without a test | P3 |
| `/terms` and `/privacy` are drafts that describe the software; not reviewed by a lawyer, nor are their translations; the terms are English only. The privacy notice names a contact only once `OPERATOR_NAME` and `OPERATOR_EMAIL` are set | Legal exposure | P1 before public launch |
