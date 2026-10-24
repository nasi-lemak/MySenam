# Known limitations and gaps

Authoritative list of what is known to be wrong, missing or unverified, kept
apart from what works ([feature status](../product/feature-status.md)) and
from ideas ([roadmap](roadmap.md)). First recorded by the
[documentation audit](../audits/documentation-2026-10-22.md) of October 2026. The numbered
defects it found (S1–S8, B1–B8, M1–M11) have since been fixed, each with a
test. So have those found since (S9–S11, B9, B10, B12–B16, M12–M15), all but
B11; every fixed one is under [fixed since the audit](#fixed-since-the-audit).
Reconciled against the code and tests on 24 October 2026.

[What the launch depends on](#what-the-launch-depends-on) sorts what is open
by whether it affects the first launch, and gives each consequential item an
action for the owner or a decision to make. The sections after it hold the
detail.

Priorities:

- **P0** — critical security, data-integrity or financial-correctness issue.
- **P1** — required for a reliable production launch.
- **P2** — important for broader adoption or operational efficiency.
- **P3** — optional enhancement.

## What the launch depends on

The first launch is taken to be one Malaysian install in marketplace mode
with a few pilot venues, whose customers pay at the counter or online through
each venue's own Billplz account, with no fee charged to venues until the owner
sets a price
([launch providers](../integrations/launch-providers.md#launch-stack-and-what-is-still-to-decide),
[pricing](../business/pricing.md#free-trials-and-pilot-offers)). A Singapore
install is a later launch of its own; for it, Stripe moves into the first
table. No P0 is open.

### Blockers for any launch

Each must be done, or its risk accepted by the owner and recorded here,
before the first real customer. The rest of the
[launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)
(secrets, the scheduler's heartbeat, monitoring, a real venue end to end)
applies too; these are the items where something is missing today.

| Blocker | Why it matters | Owner action |
| ------- | -------------- | ------------ |
| Continuous integration has not run on any commit since 16 October 2026 ([production readiness](#production-readiness)) | Every check is run by hand; a regression is found only when somebody runs the suites | Raise or remove the GitHub Actions budget, then see the CI and Docs runs pass on the commit to be launched. Launching from a commit checked by hand instead is a decision to record here |
| Email has never been sent through a real provider ([integrations](#integrations-awaiting-live-verification-or-a-partner)) | Booking confirmations, password resets and every game, tournament and league message go by email | Open the SMTP account, set SPF, DKIM and DMARC on the sending domain, set `SMTP_URL` and `MAIL_FROM`, and pass the email check |
| Off-site backups have never been written to a real bucket, and where they may go is not decided ([backup and restore](#production-readiness)) | Without an off-site copy, losing the server loses every booking and balance | Choose the provider and country (Backblaze B2 is abroad, so it waits on a lawyer and `OFFSITE_TRANSFER_APPROVED`; Amazon S3 in Malaysia does not), set `OFFSITE_DATA_LOCATION`, pass `npm run verify-offsite -- --go` and the drill on an isolated server ([backups](../operations/backups.md#verifying-a-real-bucket)) |
| `/terms` and `/privacy` are unreviewed drafts ([gaps](#gaps-in-verification-and-documentation)) | Legal exposure from the first customer | A Malaysian lawyer reviews both and their translations; set `OPERATOR_NAME` and `OPERATOR_EMAIL` |
| The breach-notification rules are not confirmed, and nobody is named to lead an incident ([gaps](#gaps-in-verification-and-documentation)) | A breach could be reported late, or to the wrong party | A lawyer confirms the Malaysian rules in [incident response](../operations/incident-response.md#a-suspected-breach-of-personal-data); the owner names the incident lead |
| The operating company and where the data is hosted are not decided ([launch providers](../integrations/launch-providers.md#operating-company-and-jurisdictions)) | The privacy notice, the provider contracts and the gateway accounts all name them | The owner decides the entity, its tax registration and the hosting country, and has them written into the privacy notice and venue agreement |

### Blockers only where a feature is switched on

None of these stops a launch that leaves the feature off. Each must be done
before the feature is used with real customers.

| Feature, and what switches it on | What must happen first | Owner action |
| -------------------------------- | ---------------------- | ------------ |
| Online payment at a Malaysian venue: the venue connects Billplz | The Billplz check: a sandbox bill paid by FPX and by card, a tampered callback refused, an expired hold's bill expiring. Refunds are by hand (accepted for a small launch, [launch providers](../integrations/launch-providers.md#launch-stack-and-what-is-still-to-decide)) | Pass the check before the first venue takes money online; until then venues take payment at the counter |
| Stripe: a Singapore install, membership renewals, or the platform's own invoices through Stripe | The Stripe test-mode check: checkout, webhook, refunds, a dispute, a renewal. Refund reconciliation is tested against a stand-in only ([money](#money-m)) | Pass the check before switching any of them on |
| Charging venues a fee: `MYSENAM_VENUE_FEE`, plan tiers, or a venue's own fee | The price decided. Once a fee or tiers are set, `/pricing` says "no setup fee, no contract": commercial terms nobody has decided ([pricing](../business/pricing.md#open-decisions)). The platform's invoices need a verified gateway | The owner decides the price and those two claims before setting any fee |
| Phone checks by WhatsApp or SMS: `WHATSAPP_TOKEN`, `SMS_TWILIO_ACCOUNT_SID` or `SMS_HTTP_URL` | A live send; every WhatsApp template approved by Meta word for word; in Malaysia, a registered SMS sender | Pass the phone check. Without phone checks, numbers are taken as given (a decision below) |
| Money kept from a hire deposit: a venue deducts from one | The venue's tax adviser's review recorded under *Tax*; until then every amount kept is marked provisional ([money](#money-m)) | Each venue's manager records it before the first real deduction; the owner tells pilot venues so |
| E-invoicing: `MYINVOIS_CLIENT_ID` | The MyInvois sandbox check with the venue's own TIN and certificate | Only for venues that must e-invoice, and for the platform if it must |
| Google sign-in: `GOOGLE_CLIENT_ID` | The redirect URI registered | Register it before switching on |
| Photos in a bucket: `PHOTOS_S3_BUCKET` | A photo uploaded and served from the real bucket | Needed before running more than one instance |
| More than one app instance | Not measured; shared rate limits, one secret and a photo bucket are needed ([production readiness](#production-readiness)) | Re-run the benchmark on the production set-up before scaling out |
| A tournament under a governing body's rules | Sport templates are club practice ([tournaments](#booking-and-availability-b)) | The organiser checks and sets the rules before the draw |

### Decisions the owner has to make

Consequential limitations with no fix planned for the launch. The code's
present behaviour stands until the owner decides; each row gives a
recommendation, not a decision. A decision is recorded by changing the row to
*accepted* (with the date) or by moving the work into the
[roadmap](roadmap.md).

| Limitation | What happens today | Recommendation |
| ---------- | ------------------ | -------------- |
| Without WhatsApp or SMS no number can be proved ([production readiness](#production-readiness)) | A typed number grants nothing online any more; members, sign-offs and company accounts work online only once staff link them to the customer's account | Switch on WhatsApp phone checks once Meta approves the templates; until then staff link members' accounts when they sell or renew |
| Email bounces are not read back ([operations and security](#operations-and-security-s)) | *Sent* means the mail server took it; a venue's own cancellations and moves stay under *Needs attention* until staff know the customer heard | Accept; the owner looks at bounces in the provider's dashboard each week |
| Messages in English only: company-account invoices and the terms; the staff dashboard. Not reviewed by a native speaker: Tamil, built-in activity names in Malay and Chinese, and the game, tournament and league emails in Malay, Chinese and Tamil ([languages](#languages)) | Booking messages, programme emails and the customer pages are in the customer's language; the rest are not | Decide which languages the launch promises. At least have a native speaker review the Malay customer pages and messages first |
| Defaults marked *for review*: adjacent buffers add up; at most eight places per booking unless the venue sets more; a first lesson needing a sign-off is booked at the counter ([booking time model](#booking-and-availability-b), [activities](#activities)) | As described | Accept as the launch defaults |

### Accepted

Decided, with the reason recorded where they are described:
[deliberately unsupported](#deliberately-unsupported) (including no daylight
saving, one country per install, and no multipart uploads off-site); no
CSRF token, by design ([security](../architecture/security.md#requests-from-another-site));
Billplz refunds by hand for a small Malaysian launch
([launch providers](../integrations/launch-providers.md#launch-stack-and-what-is-still-to-decide));
negative stored credit after a chargeback, reported apart (M14).

### Not affecting the first launch

Everything else on this page is P2 or P3: an improvement, a known edge, or a
verification to add. Each names where its work is tracked (a test to write,
or the [roadmap](roadmap.md)), and none changes what the first launch can
promise. The P2 items among them:

- The marketplace benchmark is run by hand ([booking time model](#booking-and-availability-b)):
  it is re-run with the launch checklist's performance row, and could run
  on a schedule once CI does.
- Ways basic and specialised activities are commonly sold ([activities](#activities)):
  roadmap rows; operators see the note as they pick one.
- Browser tests cover a few journeys ([gaps](#gaps-in-verification-and-documentation)):
  [users and journeys](../product/users-and-journeys.md#what-the-journeys-show)
  names the two to add first.

## Suspected defects

A new defect gets a row here with its evidence and the test to write before
it is fixed, and moves to *fixed since the audit* with that test.

### Operations and security (S)

| ID | Defect | Evidence | Test to write first | Priority |
| -- | ------ | -------- | ------------------- | -------- |
| — | None open | | | |

Also: an email the mail server accepted is recorded as sent; that is not
proof it reached the inbox (spam folders, a full mailbox, a bounce later).
Bounces are not read back from any provider ([messaging](../integrations/messaging.md)) (P2; a [decision for the owner](#decisions-the-owner-has-to-make)).

Also: a venue's own access list (a members-only or private venue's numbers,
`venue_access_list`) is matched on an account's number. Where the install
checks numbers (WhatsApp or SMS), an account must prove its number before it
books, so that is a proved number; where it does not, it is the number as
typed, and an account registered with a listed number could see or book a
private venue. Unlike memberships, list entries have no account to link to.
Depends on an external service: the next action is to switch phone checks on
([launch checklist](../operations/deployment.md#launch-integration-checklist)) (P2).

Also: there is no CSRF token, by design: cross-site writes are refused by
`SameSite=Lax` and an `Origin` check ([security](../architecture/security.md#requests-from-another-site)).
The content security policy still allows inline *styles* (a style cannot run
code); scripts need the response's nonce (resolved below).

### Booking and availability (B)

| ID | Defect | Evidence | Test to write first | Priority |
| -- | ------ | -------- | ------------------- | -------- |
| — | None open | | | |

Also, in [tournaments](../features/tournaments.md):

- A correction never rewrites a match already played. Where it means the
  wrong competitor went on, the tournament is held under review until a
  manager lets the results stand or replays them; a replay that changes who
  goes on again is a correction, and possibly an issue, of its own (by
  design). Replaying is refused where the right competitor has left or is
  already elsewhere in the knockout (P3).
- Sport templates are common club practice, not federation regulations:
  an event run under a governing body's rules needs its rules checked and
  set before the draw. Counts of tops and zones (bouldering) cannot be
  expressed yet ([roadmap](roadmap.md)) (P3).
- Divisions of a competition all play its match length, are added before
  any draw, and keep a player apart only by account: a partner named in
  doubles, or a roster name, is not known to be the same person in two
  divisions. Ages come from dates of birth entrants declare, not checked
  against a document; the level is shown, not enforced; a team's roster is
  names its captain typed, not accounts (P3).
- In a performance event, competitors level for the final's last place wait
  for the organiser's choice; a heat correction that would change who swam a
  final with results is refused, and a re-swim is arranged by hand (P3).
- An official's link is a bearer link: whoever holds it can enter that
  tournament's results until staff withdraw it or the tournament ends
  (P3, by design: officials are often volunteers without an account).
- Box leagues share the competition rules for scores and tables, but are
  still their own engine for seasons and boxes; a league match always has a
  winner (P3).

Also, in [open games](../features/matchmaking.md#moving-a-game-to-another-time):

- A host's proposal to a time that overlaps the game's own, on a different
  court sharing its floor (a pitch over its court), is refused as taken:
  only the part of the new time outside the booking's own claim on the same
  court is held (P3).
- A proposal waits a day at most (or until the new start, or the
  cancellation cutoff), not a time the venue sets (P3).
- A venue's change of a game's time, from the staff screen, is tested by
  route and component tests, not driven in a browser (P3).


Known limits of the [booking time model](../architecture/booking-time-model.md)
(the owner's decisions and the defaults chosen for open questions are listed
there):

- **Measured at marketplace size by hand** ([results](../development/testing.md#results)),
  before and after B12–B14 were fixed; not in CI, so a slower query is
  noticed only when somebody runs it again. `tests/query-plans.test.ts`
  checks the indexes are used, not the timings (P2).
- **Independent bookings are retried, rarely.** Inserting a claim checks
  its booking exists, which reads the page of the bookings index every new
  booking is written to, and Postgres's serializable checks work by the
  page; two unrelated bookings committing at that moment can make one of
  them run again. Measured at 2 retries in 1,920 bookings; a booking that
  is still in conflict after ten tries is refused as busy (`BUSY`, 503 with
  `Retry-After`), never half done ([booking concurrency](../architecture/booking-concurrency.md)) (P3).
- **Staffed hours are whole hours** (`staffed_from`/`staffed_to`): a desk that
  shuts at 9:30 PM is entered as 9 PM or 10 PM. Whether a booking is staffed
  is judged by its whole time, and one staffed for only part of it gets the
  door code or the counter as the venue sets (resolved below); only the
  half-hour granularity remains (P3, deliberate simplicity: a lock code is
  set for the hour, and no venue has asked for finer).
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
  night too"). Only data written before migration 0090 is affected, so no
  install created since can have it, and no production install exists yet.
  Not repaired in place: a migration extending those claims could collide
  with bookings since sold in the late hours. Next action, if an install from
  before 0090 is ever upgraded: end and recreate its running outages, which
  claims them the new way (P3, legacy data only).
- **Adjacent buffers add up**: two bookings each with a 10-minute buffer on
  the side they meet are 20 minutes apart, not 10 (by design, for review; a
  [decision for the owner](#decisions-the-owner-has-to-make)).
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
  review; a [decision for the owner](#decisions-the-owner-has-to-make)). A group of places on such an activity is booked at the counter,
  since one sign-off covers one person.
- **One booking takes at most eight places** unless the venue sets the most
  per booking, even on a fleet of twenty (by design, for review; a
  [decision for the owner](#decisions-the-owner-has-to-make)).
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

### Languages

The customer pages, booking messages and refusals are in English, Malay,
Chinese and Tamil ([feature status](../product/feature-status.md)). Not yet:

- **Company-account invoices and the terms** are in English whatever the
  customer's language (P2). Game, tournament, league and group emails are in
  the player's language; in them, round names ("Semi-final 2") and what
  staff typed stay as written (P3).
- **Not reviewed by a native speaker:** the Malay, Chinese and Tamil wording
  of game, tournament, league and group emails (machine-assisted) (P2).
- **The staff dashboard** is English only ([roadmap](roadmap.md)) (P2).
- **Not reviewed by a native speaker:** the Tamil dictionary, and the
  built-in activity names in Malay and Chinese (machine-assisted) (P2).

Which languages the launch promises is a
[decision for the owner](#decisions-the-owner-has-to-make).

### Money (M)

None open.

Also: a refund made by hand (every Billplz refund) depends on the venue's
staff. MySenam tracks it — the date customers are told, overdue refunds on
the dashboard and in a daily reminder, and the workload month by month
([payments](../features/payments-and-credit.md#refunds-made-by-hand)) — but
cannot make it, and does not collect the customer's bank account, which an
FPX refund needs, so staff may have to ask for it. Refunds paid by DuitNow QR
would stay manual even with HitPay.

Also: refunding to credit has no unique index of its own; it is refunded
once because it runs inside the transaction that claims the cancellation
(`refundBooking` in `src/lib/store.ts`; `tests/refund-recovery.test.ts`).

Also: a refund sent to the gateway is written down as owed first and asked
for after the cancellation commits, since the gateway cannot take part in the
transaction. Refunds are reconciled for every venue; the scheduler finishes
what a crash interrupted — an owed refund never asked for (only where the
venue refunded automatically when it was first owed), a claim with no
answer, a refund the gateway left pending — under the same key, so it is
made once, and tells a venue's staff daily what waits for them
([payments](../features/payments-and-credit.md#refunds-that-are-interrupted)).
A refund the gateway reports failed is owed again, raised by the integrity
check and listed for staff; it is not resent on its own. Verified against a
stand-in for Stripe only; Billplz has no refund API, so its refunds are
always by hand (P2).

Also: the tax treatment of money kept from hire deposits starts from
provisional country defaults that no tax adviser has reviewed. A venue
records its adviser's review in its Tax settings; until it does, every
amount kept is marked provisional in the journal and exports. Recording the
review is a launch requirement, not a software check
([launch checklist](../operations/deployment.md#launch-integration-checklist)) (P1 before
real deductions, at a venue that
[deducts from deposits](#blockers-only-where-a-feature-is-switched-on)).

Also: a dispute on what a venue paid the platform that is lost only *in
part* is reported to the owners and settled by hand; lost in full, the invoice
or pack is owed again (resolved below) (P3).

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
| S9 | Tournament, league and open-game emails are queued in the outbox with the change that causes them, so they are retried, capped and listed like any other message. The emails to staff and applicants it also named became S11, fixed below | `tests/outbox.test.ts` |
| S10 | Photos kept on the server's disk go into an archive beside each snapshot, checked before it is kept, pruned and copied off-site with it, and put back by the restore | `tests/backup.test.ts`, `tests/backup-scripts.test.ts`, `tests/offsite.test.ts` |
| B9 | A group result put right fills the knockout again while none of it has been played; once a match in it has, a change to who is in it is refused | `tests/tournaments.test.ts` |
| B10 | A withdrawal after the draw gives walkovers for the matches left, keeps the results already played where the tournament's rules say they stand (the entrant is flagged and does not go through, not put last), refills a knockout not yet played, and settles later rounds as soon as the opponent is known | `tests/tournaments.test.ts` |
| B12 | Claims are read court by court with indexes on the court or space and the end of the claim (migration 0094), in two queries for any number of courts; at 400 venues a search near a point takes 98 ms (p50), not 2.4 s ([results](../development/testing.md#results)) | `tests/query-plans.test.ts`, `tests/contention.test.ts` |
| B13 | Independent bookings no longer read each other's claims, expired offers are let go only when a claim conflicts, and retries back off; a booking that still cannot finish is refused as busy (503), never a 500 | `tests/contention.test.ts`, `tests/db.test.ts` |
| B15 | The admin route passes who enters a tournament's results; before, one set up for the players' results from the dashboard was saved as staff's. Found and fixed in the same change | `tests/fixtures.test.ts` |
| B16 | Joining an open game, and a host accepting a player, counted the places and then wrote, with nothing between: on Postgres six people joining a one-place game at once were all let in. Every change that takes or frees a place now runs in one transaction that locks the game's row first. Found and fixed in the same change | `tests/matchmaking.test.ts` ("lets exactly one of many people joining at once") |
| B14 | A booking takes advisory locks on its spaces, shared courts and coach, in one order, before claiming, so racing bookings queue rather than deadlock | `tests/contention.test.ts`, `tests/concurrency.test.ts` |
| B11 | Utilisation measures the courts' floor once: each piece sellable on its own is a unit, in use whenever any booking covers it (as the court or the pitch over it) and out where a block or outage covers it; the pitch's own space is not more floor. Each court also shows its hours in use; takings per hour of floor are given beside ([reporting](../features/reporting.md)) | `tests/reports-floor.test.ts`, `tests/court-links.test.ts` |
| M12 | A fee paid online for something already paid (a tournament entry, a WhatsApp pack, a platform invoice) is recorded as owed back, with no second receipt or revenue, and refunded once through the gateway or marked refunded | `tests/tournaments.test.ts`, `tests/billing.test.ts`, `tests/whatsapp-usage.test.ts` |
| M13 | Money kept from a hire deposit is a receipted counter sale per reason linked to the hire, taxed by its reason's nature and the venue's tax settings, under its own heading in the takings, the journal and exports ([venue operations](../features/venue-operations.md#money-kept-from-a-deposit)) | `tests/hire.test.ts` |
| M14 | Credit reports give what customers hold and what customers below nothing owe, apart and never netted; the two together equal the ledger | `tests/wallet.test.ts` |
| M15 | A cancellation and its refunds are one transaction; a refund sent to the gateway is owed first, and one unanswered or overdue is raised by the integrity check and listed for staff | `tests/refund-recovery.test.ts` |
| S11 | Emails to applicants, password reset links, alerts to the platform's owners and a venue's staff, and WhatsApp credit alerts go through the outbox: retried with backoff, listed for the platform's owners, given up unsent once a reset link has run out, and a reset link is not kept after it goes | `tests/platform-messages.test.ts`, `tests/applications.test.ts`, `tests/password-reset.test.ts` |
| S12 | An account's *My waiting lists* listed every place queued on the account's phone number, proved or only typed in, so registering with somebody's number showed where and when they were queuing. Now the places the account joined, or on its proved number. Found and fixed in the same change | `tests/member-identity.test.ts` ("a number on an account's own lists") |
| S13 | A members-only venue or tournament let in any account whose typed number matched a member's. Now only the account the membership is linked to, or whose number it is, proved. Found and fixed in the same change | `tests/member-identity.test.ts` |
| S14 | A password reset or address-confirmation email was marked sent, and its link wiped, in two statements: a server stopping between them (and, for a moment, any reader) kept a sent message with a working link in the database and its backups. Found by a full run on Postgres; now one statement | `tests/platform-messages.test.ts` |

### Resolved limitations without a number

Limitations recorded as prose rather than as numbered defects, and how each
was resolved. Kept so the register shows what changed, not only what is left.

| Limitation | Resolved by | Evidence |
| ---------- | ----------- | -------- |
| A booking that started while the desk was staffed and ran on after it shut got no door code, judged by its start alone | Staffing is judged over the booking's whole time, after midnight too; a booking staffed for part of it gets the code, or the counter where the venue keeps somebody on the desk until such bookings end (`partly_unstaffed`, migration 0110); the booking's page says which beforehand ([venue operations](../features/venue-operations.md)) | `tests/access.test.ts` ("a booking across the staffed boundary") |
| Cancelling a weekly series asked to confirm cancelling *all* upcoming sessions, then silently kept the weeks inside the cutoff | Each week's terms are previewed (free, late at the venue's share, or staying and why, with what is owed); the customer picks the weeks; late ones go only on terms accepted; a week whose terms changed refuses the lot (`SERIES_CHANGED`) ([booking](../features/booking.md#cancellation-and-no-shows)) | `tests/series-cancel.test.ts` |
| Two cancellations of a paid booking at once were listed as untested | Already tested; the register was out of date | `tests/refund-recovery.test.ts` |
| A waiting-list offer on a court under a pitch was listed as untested | Test added: the offer keeps the pitch from being sold over it and leaves the court beside it free | `tests/waitlist.test.ts` ("on a court under a pitch…") |
| A member of staff who lost both phone and recovery codes was locked out until the database was edited | An audited reset by a superior (an owner, or the business's manager; an owner only by another owner) with their own two-factor code and a reason; signs out, recorded, emailed to the account and every owner; the last owner from the server's console (`npm run reset-two-factor`) ([authentication](../architecture/authentication.md#two-factor-sign-in)) | `tests/two-factor-reset.test.ts` |
| The content security policy allowed inline scripts, so an injected script would run | A fresh nonce per response with `'strict-dynamic'`; Next.js puts it on its own scripts ([security](../architecture/security.md#response-headers)) | `tests/launch-security.test.ts`; `tests/e2e/launch.e2e.ts` (production build: a different nonce per page, on every script; a court booked with nothing blocked) |
| A member's rate and longer booking window went to whoever typed the member's number online (a decision of the time, reversed by the owner in October 2026) | Online, only for the account the membership is linked to or whose number it is, proved; at the counter, the number on staff's word ([privacy](../architecture/privacy.md#a-phone-number-is-not-identity)) | `tests/member-identity.test.ts`, `tests/impersonation.test.ts` |
| A deposit charged back after the rest was paid online left the booking showing paid in full | The booking owes the deposit's part again; the rest keeps its receipt under its own payment's key, so a later cancellation still owes it back ([payments](../features/payments-and-credit.md)) | `tests/stripe-disputes.test.ts` ("lost on a deposit after the rest was paid online…") |
| A lost dispute on a platform invoice or WhatsApp pack left it showing paid | Lost in full: the invoice is due again in 14 days (voidable by an owner); the pack is due again and its messages taken back, below nothing for any already sent | `tests/stripe-disputes.test.ts` ("…lost, the invoice is owed again") |
| A refund on withdrawing from a tournament before the draw, and a league fee paid after leaving, were untested | Tests added: owed back in full where the rules say so; a fee paid after leaving is owed back with no receipt and the place not marked paid | `tests/tournaments.test.ts`, `tests/leagues.test.ts` |
| Players moved into or out of a knockout filled again were not messaged | Those newly through and those no longer through are emailed; somebody who left is not ([tournaments](../features/tournaments.md#corrections-after-the-knockout-has-begun)) | `tests/tournaments.test.ts` ("tells who is newly through…", "tells the one who takes their place…") |
| Ranking by set or point ratios, and a forfeit score, could not be expressed | Rank keys `set_ratio` and `point_ratio`; a walkover's score in the rules, checked against the match as set up, used in the tables of tournaments and box leagues; the volleyball and goals templates carry one ([tournaments](../features/tournaments.md)) | `tests/brackets.test.ts` ("ratios and forfeit scores"), `tests/competitions.test.ts` |
| A player's tournament report waited for the other side with no time limit | The other side is emailed; unanswered for 24 hours it stands through the same checks, or goes to staff as disputed if it no longer can ([tournaments](../features/tournaments.md#results)) | `tests/match-reports.test.ts` ("a report nobody answers") |
| Game, tournament and league emails were in English whatever the player's language | Written in the language the account last used the site in (`users.locale`, migration 0112), greeting and all ([messaging](../integrations/messaging.md)) | `tests/outbox.test.ts` ("a programme email in the player's language"), `tests/tournaments.test.ts` ("emails in each entrant's language") |

## Production readiness

Implementation status ([feature status](../product/feature-status.md)) says
what is built and tested; this is what that does not show. Evidence is from
the code and tests as of 24 October 2026. What each row means for the launch
is under [what the launch depends on](#what-the-launch-depends-on).

| Concern | State | Evidence and what remains |
| ------- | ----- | ------------------------- |
| Load at marketplace size | Measured on one machine, not in production | At 400 venues and 918,000 bookings: a search near a point in 98 ms (p50) and 155 ms (p99), a booking in 12 ms, fifty bookings at once with no errors, and mixed traffic at 84 operations a second on four cores with no errors ([benchmark](../development/testing.md#results)). Bookings racing for one court, a shared floor, a hall or a coach end with the right number through and the rest refused within a second (`tests/contention.test.ts`). Not yet measured: more than one app instance, a managed database, real network latency |
| Double booking and capacity | Enforced by the database | An exclusion constraint on held time per space and a capacity trigger refuse overlaps whatever writes them, raw SQL included (`tests/capacity.test.ts`, "is still the database that prevents overbooking"); expired offers are let go before a claim. Truly parallel only on the Postgres run ([booking concurrency](../architecture/booking-concurrency.md)) |
| Spending credit and pass entries | Spent once | Serializable transactions with retry; `tests/concurrency.test.ts` ("spends credit once", "refunds a pass entry once") on Postgres |
| Refund races and crashes | A cancellation and its refunds are one transaction (M15); Stripe refunds are claimed before Stripe is asked (M9) and finished by the scheduler after a crash; a second payment for something paid is owed back, not kept (M12) | Two cancellations of a paid booking at once, and a class called off while a place in it is cancelled, refund once (`tests/refund-recovery.test.ts`). A crash before the request, after Stripe accepted it but before it was recorded, while recording, and during reconciliation each end in one refund; no transaction is open while Stripe is asked (`tests/refund-crash.test.ts`). Against a stand-in for Stripe only |
| Negative stored credit | Possible on purpose after a chargeback | Reported apart, as owed by customers, never netted against credit held (M14); no database guard |
| Money outside the books | None known | Money kept from hire deposits is receipted (M13); everything else that takes money is receipted |
| Linked courts in reports | The floor counted once (B11, fixed) | `tests/reports-floor.test.ts`: a hall sold as one pitch reads full; a block on the pitch comes off both courts' floor once |
| Identity | Accounts are identities; phone numbers are not, unless proved | A number is proved only where WhatsApp or SMS is configured, and those are tested against fakes. Online, membership benefits, sign-offs and an account's waiting-list places need the account's proved number or a link to the account (S12, S13); at the counter staff take the number on their word ([authentication](../architecture/authentication.md), [privacy](../architecture/privacy.md)) |
| Integrations | None checked against the live service | Every payment, message, e-invoice, sign-in and storage integration is tested against fakes ([below](#integrations-awaiting-live-verification-or-a-partner)); rows that take money or send messages name their leg in feature status |
| Backup and restore | Restored and compared on both engines, locally; off-site restore not verified against a real bucket | The scripts test backs up a venue's settings, a customer's credit, a paid booking and a photo, changes them all, restores, and compares every row of the main tables, each balance and each photo's hash (`tests/backup-scripts.test.ts`). Each snapshot is a set with a manifest of hashes; a set is fetched back from a stand-in S3 service, checked, and restored in a drill aside without touching the live data; a damaged part is caught. A `pg_dump` copy made by the app is listed, not loaded, before it is kept (the drill loads it). RPO up to 24 hours; RTO measured locally at about 2 minutes' restore for the benchmark database. Remains: the off-site drill against the real provider with a read key, on an isolated server ([backups](../operations/backups.md#restoring-from-the-off-site-copy)) |
| Continuous integration | Not running; not executed for any change since 16 October 2026 | Every CI and Docs job since 16 October 2026 has been refused before a runner was given to it: "The job was not started because an Actions budget is preventing further use" (the repository is private, on a personal account); the runs of 24 October 2026 still ended within three seconds, with no step run. The account owner raises or removes the Actions budget, or waits for the monthly minutes to reset ([testing](../development/testing.md#continuous-integration)). Until then every check here is run by hand |
| Open games and matchmaking | The last place goes to one person; a game moves only with its players' answers; suggestions bounded | Every change that takes or frees a place locks the game's row first (B16, `tests/matchmaking.test.ts` on Postgres). Moving a game with players holds the new time as a claim until each has answered; two moves at once, and a join racing a proposal, leave one outcome (`tests/game-moves.test.ts` on Postgres). A ranking reads at most 300 candidate games, and a host's suggestions at most 500 opted-in players; neither is measured at marketplace size. Levels and ages are self-declared and never verified; a link to a private game is a bearer link until withdrawn or expired. Emails of invitations, held places and suggested games go through the outbox, so their delivery is the email integration's |
| Staging | On this machine, proven by hand; remote never run | `npm run stage -- run` builds the image, runs it on Postgres 16 with synthetic data, passes smoke, browser and acceptance suites and removes everything ([testing](../development/testing.md#staging-and-real-services)). It needs a Docker daemon. The DigitalOcean variant is tested against a stand-in API only, and no provider credential has been available to run the real-service checks |
| Operational dependencies | Documented | The scheduler runs inside a long-running `next start` (or the operator's cron with `MYSENAM_SCHEDULER=off`); more than one instance needs `MYSENAM_RATE_LIMITS=shared`, one `MYSENAM_SECRET`, a photo bucket, and accepts a minute's lag on catalogue changes ([architecture](../architecture/overview.md#more-than-one-instance)) |

## Integrations awaiting live verification or a partner

Implemented and tested against fakes only. Each needs one real check before it
is relied on ([launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)).

| Integration | State | Launch impact |
| ----------- | ----- | ------------- |
| Billplz (FPX, cards, callbacks, X-Signature) | Needs sandbox verification | Where a Malaysian venue takes payment online |
| Stripe Checkout, webhooks, refunds, disputes, renewals | Needs test-mode verification | A Singapore install; renewals; the platform's invoices through Stripe |
| WhatsApp Cloud API (templates must be approved by Meta) | Needs approval and a live send | Only where switched on: email works without it |
| Email (SMTP), including SPF/DKIM and calendar invites | Needs a live send | Any launch: confirmations go by email |
| SMS (Twilio or HTTP gateway) for phone codes | Needs a live send | Only where phone checks use SMS |
| LHDN MyInvois | Needs sandbox (preprod) verification | Only for venues (or a platform) that must e-invoice |
| Google sign-in | Needs a registered redirect URI | Only where switched on: password sign-in works |
| S3-compatible off-site backups and photo storage | Needs a real bucket. Tested against stand-ins for S3 and B2 only: B2's acceptance of a `writeFiles`-only key for uploads, its signing region, Object Lock default retention and versions listing are unverified until `npm run verify-offsite -- --go` passes against a real B2 (preferred) or S3 bucket | Off-site backups: any launch. A photos bucket: before more than one instance |
| DigitalOcean (remote staging only) | Needs a token for a separate team, scoped to droplets, tags and registry read, and an agreed spend; tested against a stand-in API | None: local staging works without it |
| Reserve with Google | Feeds only; needs Actions Center partner approval and a booking server that is **not built** | None |
| Smart locks (TTLock, Igloohome) | Not built; blocked on vendor credentials | None |
| Stripe Connect payouts, Singapore InvoiceNow, web push, LINE, Zalo | Not built; each needs a partner or contract | None |

## Deliberately unsupported

- **Demand-based ("surge") pricing.** Raising prices when busy teaches regulars
  to wait and reads as a trick where a court is a known price. Venues have
  fixed peak and off-peak bands, holidays, an opt-in last-minute discount and
  a free hour for regulars instead.
- **Referral credit** ("give RM10, get RM10"): with bookings by phone number
  and no proof two numbers are two people, it pays people to refer themselves.
- **No multipart uploads off-site.** Each backup part goes in one PUT, which
  every provider caps at about 5 GB; a larger part (usually a photos archive)
  is refused and the copy reported failed. The owners are warned when a part
  passes 80% of that. Keep photos in their own bucket (`PHOTOS_S3_*`) rather
  than on the server's disk.
- **Off-site copies need a declared location.** Nothing is copied until
  `OFFSITE_DATA_LOCATION` is set, while it disagrees with the country a B2 or
  S3 endpoint names, and nothing abroad until the transfer is approved and
  encrypted ([backups](../operations/backups.md#where-the-data-may-go)). For
  other providers the declaration is not checked. With Backblaze B2 (no Asian
  region) every copy is a transfer abroad, and the legal points in
  [privacy](../architecture/privacy.md#backups-held-abroad) are open.
- **A signed backup set proves the server made it, not that the server was
  sound.** After a server compromise, sets made since may carry altered
  data under a valid signature; a recovery point from before it is chosen by
  upload time ([backups](../operations/backups.md#threat-model-what-each-protection-proves)).
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
| Browser tests cover a few journeys only: eleven end-to-end checks ([testing](../development/testing.md#end-to-end-tests)) and fifteen acceptance scenarios ([testing](../development/testing.md#visual-acceptance-scenarios)) | Most pages are checked by route and component tests, not a browser; no test sets a phone-sized screen, though staff and customers use phones. [Users and journeys](../product/users-and-journeys.md#what-the-journeys-show) names the journeys to add first | P2 |
| Untested paths named in feature status: the two-year prune of the staff activity log, the daily venue shuffle's order | Code exists without a test | P3 |
| `/terms` and `/privacy` are drafts that describe the software; not reviewed by a lawyer, nor are their translations; the terms are English only. The privacy notice names a contact only once `OPERATOR_NAME` and `OPERATOR_EMAIL` are set | Legal exposure | P1: [blocks any launch](#blockers-for-any-launch) |
| The [incident-response procedure](../operations/incident-response.md)'s breach-notification rules for Malaysia and Singapore are summarised from the regulators' guidance, partly through law-firm summaries (Malaysia's regulator's site was unreachable when it was written), and who must notify for which data is not settled | An operator could notify late or the wrong party | P1: [blocks any launch](#blockers-for-any-launch) until a lawyer confirms it |
