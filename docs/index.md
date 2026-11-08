# MySenam documentation

Each subject has **one** authoritative document; others link to it rather than
repeating it. If you change behaviour, change the document listed here as its
home ([`AGENTS.md`](../AGENTS.md)). How the documentation is organised, and
where something new belongs, is in [documentation](development/documentation.md).

## Start here

- [Product overview](product/overview.md): what MySenam is, who uses it, and
  the terms these documents use.
- [Feature status](product/feature-status.md): every capability, how far it is
  implemented and verified, its code and tests.
- [Known limitations](roadmap/known-limitations.md): suspected defects,
  unverified integrations, deliberate exclusions.
- [Getting started](development/getting-started.md).

## The areas

| Folder | What it holds |
| ------ | ------------- |
| [`product/`](product/) | What MySenam is, rules that span features, the marketplace, regions and tax, feature status |
| [`features/`](features/) | How each capability behaves now, one specification per domain |
| [`architecture/`](architecture/) | How the system is built, and why ([decision records](architecture/decisions/)) |
| [`integrations/`](integrations/) | External services: payments, messaging, e-invoicing, the public API |
| [`development/`](development/) | Working on the code: setup, configuration, testing, documentation conventions |
| [`operations/`](operations/) | Running it: deployment, backups and recovery, monitoring |
| [`business/`](business/) | Commercial decisions: venue pricing and open business decisions |
| [`roadmap/`](roadmap/) | Work not built (planned or proposed) and what is known to be wrong or unverified |
| [`research/`](research/) | Dated research and its sources; explains why, never a requirement |
| [`audits/`](audits/index.md) | Dated assessments, and where their findings stand now |
| [`archive/`](archive/) | Superseded material kept for reference |

## Product

| Subject | Authoritative document |
| ------- | ---------------------- |
| Who uses MySenam, their roles as the code has them, and the main journeys through it | [Users and journeys](product/users-and-journeys.md) |
| Rules that span features and must not break | [Business rules](product/business-rules.md) |
| What can be booked: the activity catalogue, resource templates, operators' own activities, resources offering several, quantity, sign-offs and registering online for approval, localised names, and which activities are fully supported | [Activities](features/activities.md) |
| Booking rules (starts, lengths, buffers, notice), availability, capacity, linked courts, waitlists, moving, cancelling, opening hours, outages, launch and tide windows for water hire, who may book | [Booking](features/booking.md) |
| Prices to the minute, fees, peak bands, holidays, last-minute prices, concessions, promo codes, memberships, passes | [Pricing](features/pricing.md) |
| Paying online, holds and deposits, stored credit and its ownership, gift vouchers, split costs, extras, counter sales, company accounts | [Payments and credit](features/payments-and-credit.md) |
| Classes and terms, one-to-one coaching, women-only and men-only (for every programme) | [Programmes](features/programmes.md) |
| Tournaments, competitions with divisions, competition rules and templates, results, corrections, box leagues, teams that persist across events, leagues of teams and fixture lists | [Tournaments and leagues](features/tournaments.md) |
| Open games, suggested games and players, invitations, private games, weekly games, community groups, blocking and reporting | [Open games and matchmaking](features/matchmaking.md) |
| Messages between players: the contexts a conversation can be in, adults who opted in, text with no contact details, limits, a digest of notices that never carry the message, blocking, reports, moderation by the venue that owns the context; supervised youth groups (minors, with a guardian's consent, supervisors, never private; guardians who disagree; a reported adult is not told; the interim safeguards pending legal review: the launch switch, recorded custody decisions, restrictions and reviews, evidence and legal holds) | [Messages between players](features/player-messages.md) |
| Check-in, unstaffed hours, equipment hire, notes, waivers, hire enquiries, booking alerts | [Venue operations](features/venue-operations.md) |
| Check-in, unstaffed hours, who supervises a session (rosters, qualifications), equipment hire, notes, waivers, hire enquiries, booking alerts | [Venue operations](features/venue-operations.md) |
| How MySenam fits a kind of venue (public), the adaptive setup journey, the personalised operating playbook, contextual help | [The venue guide](features/venue-guide.md) |
| Search, near me, facilities, photos, reviews, notices, SEO, installing as an app | [Discovery](features/discovery.md) |
| Reports, exports, sales journal, activity log | [Reporting](features/reporting.md) |
| The marketplace: sign-up, going live, venue billing, suspension, storefronts | [Marketplace](product/marketplace.md) |
| Countries, languages, SST/GST | [Regions and tax](product/regions-and-tax.md) |
| Venue pricing tiers and cost assumptions | [Business: pricing](business/pricing.md); research in [go-to-market research](research/go-to-market/index.md) |

## Architecture

| Subject | Authoritative document |
| ------- | ---------------------- |
| Stack, structure, several instances | [Overview](architecture/overview.md) |
| Schema, migrations, conventions | [Database](architecture/database.md) |
| What is guaranteed under concurrent requests | [Booking concurrency](architecture/booking-concurrency.md) |
| Court time as intervals: claims, spaces, booking policies, prices from minutes, the migration from half hours | [Booking time model](architecture/booking-time-model.md) |
| Platform, business, branch, venue; staff roles; how boundaries are enforced | [Tenancy](architecture/tenancy.md) |
| Sign-up, sign-in, sessions, two-factor, Google, phone checks, passwords | [Authentication](architecture/authentication.md) |
| Rate limits and abuse controls | [Security](architecture/security.md) |
| Export, erasure, retention | [Privacy](architecture/privacy.md) |
| The app's own HTTP routes (partial reference) | [HTTP routes](architecture/http-api.md) |
| Why things are the way they are | [Decision records](architecture/decisions/) |

Decision records: [0000 SQLite (superseded)](architecture/decisions/0000-sqlite-single-file.md) ·
[0001 Postgres and PGlite](architecture/decisions/0001-postgres-in-production-pglite-in-development.md) ·
[0002 Database-enforced concurrency](architecture/decisions/0002-database-enforced-concurrency.md) ·
[0003 Scheduler lease](architecture/decisions/0003-scheduler-lease.md) ·
[0004 Not TimescaleDB](architecture/decisions/0004-plain-postgres-not-timescaledb.md) ·
[0005 Marketplace and own installs](architecture/decisions/0005-shared-marketplace-and-own-installs.md) ·
[0006 Per-venue payment accounts](architecture/decisions/0006-per-venue-payment-accounts.md) ·
[0007 Stored-credit ownership](architecture/decisions/0007-stored-credit-ownership.md) ·
[0008 Slot length per venue](architecture/decisions/0008-slot-length-per-venue.md) (superseded) ·
[0009 Half-hour diary, sold by sport](architecture/decisions/0009-half-hour-diary-sold-by-sport.md) (superseded) ·
[0010 Interval booking](architecture/decisions/0010-interval-booking.md) ·
[0011 Activities as data](architecture/decisions/0011-activities-as-data.md) ·
[0012 Competition rules and corrections](architecture/decisions/0012-competition-rules-and-corrections.md) ·
[0013 Competition framework](architecture/decisions/0013-competition-framework.md) ·
[0014 Off-site backups encrypted and located](architecture/decisions/0014-off-site-backups-encrypted-and-located.md) ·
[0015 Backblaze B2 preferred; signed backup sets](architecture/decisions/0015-backblaze-b2-preferred-signed-backup-sets.md) ·
[0016 Matchmaking on open games](architecture/decisions/0016-matchmaking-on-open-games.md) ·
[0017 Staging and verification modes](architecture/decisions/0017-staging-and-verification-modes.md) ·
[0018 Moving open games by consent](architecture/decisions/0018-moving-open-games-by-consent.md) ·
[0019 Approval applications apart from bookings](architecture/decisions/0019-approval-requests-apart-from-bookings.md) ·
[0020 Approval to booking, payment and authority](architecture/decisions/0020-approval-to-booking-payment-and-authority.md) ·
[0021 Approval retention by purpose; PDF documents](architecture/decisions/0021-approval-retention-and-pdf-documents.md) ·
[0022 Children managed from an adult's account](architecture/decisions/0022-children-managed-from-an-adults-account.md) ·
[0023 Participants apart from accounts](architecture/decisions/0023-participants-apart-from-accounts.md) ·
[0024 Supporting documents scanned before release; retention by configured purpose](architecture/decisions/0024-documents-scanned-before-release-retention-by-purpose.md) ·
[0025 Benefits and privileges by the scope they apply to](architecture/decisions/0025-benefits-and-privileges-by-scope.md) ·
[0026 The same venue policies on every booking path, with audited manager overrides](architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md) ·
[0027 Opening hours and rates from a date](architecture/decisions/0027-hours-and-rates-from-a-date.md) ·
[0028 The venue guide as read models over the real configuration](architecture/decisions/0028-venue-guide-as-read-models-over-real-configuration.md) ·
[0029 An MCP server over the existing functions](architecture/decisions/0029-mcp-server-over-existing-functions.md) ·
[0030 Signing staff in from AI assistants with an authorization server inside the app](architecture/decisions/0030-oauth-sign-in-for-ai-assistants.md) ·
[0031 Ratings are a deterministic function of a ledger of results, never learned](architecture/decisions/0031-ratings-from-a-ledger-of-results.md) ·
[0033 Swiss tournaments and club ladders, specified before they were built](architecture/decisions/0033-swiss-tournaments-and-club-ladders.md)
[0032 Consolation draws and double elimination, on the knockout graph](architecture/decisions/0032-consolation-draws-and-double-elimination.md)
[0034 An advanced feed-in consolation draw, on the knockout graph](architecture/decisions/0034-feed-in-consolation-draws.md)
[0035 Rating policy: rankings published by choice, a venue's number to be ranked, and which results count](architecture/decisions/0035-rating-policy-published-rankings-and-counted-results.md)
[0039 Messages between players: only inside a context they share, adults who opted in, text with no contact details, moderated by the venue that owns the context](architecture/decisions/0039-messages-between-players.md)
[0044 Supervised group messaging for eligible minors, guardian controls, and a real notification digest](architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md)
[0049 Guardians in conflict, and a reported adult is not told (amends 0044)](architecture/decisions/0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md) ·
[0052 Youth messaging: interim safeguards, prepared for legal review (amends 0049 and 0044)](architecture/decisions/0052-youth-messaging-interim-safeguards-pending-legal-review.md)
[0059 Competitions tell the people they change, owe back what they took and say when a court is lost; reports of messages are told and an automatic suspension can be reviewed](architecture/decisions/0059-competition-notices-fees-owed-fixtures-lost-and-message-review.md)
[0043 Moving a class, and a class's instructor as one of the venue's coaches](architecture/decisions/0043-moving-a-class-and-a-class-coach.md)
[0045 Front desk may move a class; a consequential or exceptional move waits for a manager](architecture/decisions/0045-front-desk-class-moves-with-approval.md)
[0047 FIDE's Baku Acceleration Method, an optional pairing for chess Swiss events](architecture/decisions/0047-baku-acceleration-for-chess.md) ·
[0055 The period report's money is the sales journal's, the venue's liabilities in ringgit, and e-invoicing keeps going](architecture/decisions/0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md)
[0046 The strength of a requirement: advisory windows a manager may override with a reason, and qualification levels](architecture/decisions/0046-strength-of-a-requirement-advisory-windows-and-qualification-levels.md)
[0042 Attendance registers, and a lesson the venue moves](architecture/decisions/0042-attendance-registers-and-lessons-moved-by-the-venue.md)
[0037 Launch and tide windows narrow the bookable hours of water hire](architecture/decisions/0037-launch-and-tide-windows.md)
[0041 Live accounting: a venue's sales pushed to Xero, optional, behind a provider interface](architecture/decisions/0041-live-accounting-push-to-xero.md)
[0040 Court time held for ladder challenges, and ladders of persistent teams](architecture/decisions/0040-ladder-court-time-and-team-ladders.md)
[0038 Swiss: accelerated pairing, a tie-break screen, and Swiss for performance events](architecture/decisions/0038-swiss-acceleration-tie-break-screen-and-performance-swiss.md)
[0036 Who supervises a session: rosters, qualifications and supervision rules, asked in the one booking path](architecture/decisions/0036-who-supervises-a-session.md)
[0048 Ladder court-time holds: configurable limits, tentative holds that expire, no overlap, limits that only refuse](architecture/decisions/0048-ladder-hold-limits-and-expiry.md) ·
[0050 Ladder court time: an existing agreement counts as confirmation; expired and released holds do not count towards the active allowance](architecture/decisions/0050-ladder-agreement-counts-and-expired-holds-do-not.md) ·
[0051 Ladder court time: a counter-proposal is its maker's agreement and holds nothing; an expired or unanswered hold is no one's fault](architecture/decisions/0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md)
[0060 Waiting-list offers: a window of the venue's own, never past the start, one per time, told when they lapse; a class called off closes its list and tells its coach](architecture/decisions/0060-waiting-list-offers-windows-starts-and-closing.md)
[0053 A closure, a rain-out and an outage are written first; what has been played is left alone; a weekly series is checked week by week](architecture/decisions/0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md)
[0058 Safety and access after a booking is made: a refused number, eligibility taken back, and what counts as attendance](architecture/decisions/0058-safety-and-access-after-a-booking-is-made.md)
[0051 Ladder court time: a counter-proposal is its maker's agreement and holds nothing; an expired or unanswered hold is no one's fault](architecture/decisions/0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md) ·
[0057 Staff find only their own customers, secrets are never in a staff view, the owner's decisions are logged, and a draft that cannot be deleted never stops the day](architecture/decisions/0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md)
[0054 Money paid never above the price, credit never taken for a cancelled booking, no silent price, a booking whose request died is held or let go](architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md)
[0061 Company accounts and the cash-up: credit notes taken off part by part, an issued invoice never drifts, overdue accounts reminded and optionally blocked, hire deposits and the counted till](architecture/decisions/0061-company-accounts-and-the-cash-up.md)
[0069 The terms a booking was sold on govern it; a customer who has arrived cancels through staff; an edit of the hours or the rules and a booking meet in one transaction](architecture/decisions/0069-the-terms-a-booking-was-sold-on-govern-it-arrival-goes-to-staff-and-edits-meet-bookings-in-one-transaction.md)
[0063 A suspended venue tells its customers and sells nothing new; an overdue one can be given time; a branch is not approved on its own under a business not in good standing](architecture/decisions/0063-a-suspended-venue-tells-its-customers-sells-nothing-new-and-an-overdue-one-can-be-given-time.md)
[0062 Passes judged on the session's date and entries given back are not dead; a membership's days given back never run into its renewal; a suspension of a renewing membership gives its days back; the concession check and the review invitation are decided once](architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md)
[0070 A venue that holds for payment holds class places too, never past the class's start; a class offers every free place at once (amends 0060)](architecture/decisions/0070-class-places-held-for-payment-and-several-offers-at-once.md)
[0071 A membership keeps the benefits it was sold with; renewals take the plan as it is then; a plan is not silently priced above the member rate; one order in which passes are offered](architecture/decisions/0071-a-membership-keeps-the-benefits-it-was-sold-with.md)
[0066 A free hour is given once by the database's rule, a failed webhook delivery can be sent again, the backup has a lease of its own, lapsed holds are let go for the venue's API, and an unanswered hire enquiry is on the worklist](architecture/decisions/0066-operations-hardening-grants-deliveries-leases-and-the-worklist.md)
[0068 A credit note is not cash paid; a booking a pass paid takes back entries and no money; "spent" is money paid; the till lists every payout; a hire deposit's method can be stated once; an invoice shows what was paid](architecture/decisions/0068-money-hardening-credit-notes-are-not-cash-spent-is-money-paid-and-the-till-lists-every-payout.md)
[0067 A paid booking moved to a cheaper time gives the difference back; a move never silently creates, removes or wastes a discount; a dearer move of an invoiced booking is refused](architecture/decisions/0067-a-paid-booking-moved-cheaper-gives-the-difference-back-and-a-move-never-silently-changes-a-discount.md)
[0064 Credentials follow their owners, staff two-factor is on by default for managers of a production marketplace, second-factor attempts are counted before they are checked, a refused number is admitted by nobody](architecture/decisions/0064-credentials-follow-their-owners-two-factor-by-default-and-counted-attempts.md)
[0062 Passes judged on the session's date and entries given back are not dead; a membership's days given back never run into its renewal; a suspension of a renewing membership gives its days back; the concession check and the review invitation are decided once](architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md) ·
[0072 A host's no-show mark is told, answered and reviewed, and counts at its own venue; coaches are told of every lesson; what ends and what is struck is seen](architecture/decisions/0072-a-hosts-no-show-mark-is-told-answered-and-reviewed-and-counts-at-its-venue.md) ·
[0073 Security mail is its own class with an allowance of its own; a production marketplace with email that cannot deliver refuses sign-up and forgotten-password requests, honestly](architecture/decisions/0073-security-mail-is-its-own-class-and-a-production-marketplace-needs-email-that-can-deliver.md)
[0065 A payment is settled for the amount the gateway took and never into a lapsed hold; stored value and e-invoicing wait for the adviser](architecture/decisions/0065-a-payment-is-settled-for-the-amount-the-gateway-took-and-never-into-a-lapsed-hold.md)
[0074 A customer's cancellation of a booking paid at the counter is an obligation to hand the money back; a credit note is the record of the cancellation, not the refund](architecture/decisions/0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md)
[0075 The till is compared with the cash received and the cash actually handed back that day; a credit note is the record of a cancellation, not a payout; an unpaid refund is shown as still owed](architecture/decisions/0075-the-till-is-compared-with-cash-received-and-cash-handed-back-and-a-credit-note-is-not-a-payout.md)
[0077 Staff taking a person off a booking at the counter hand the money over then, and it is written as the payout it is, by the member of staff who did it](architecture/decisions/0077-staff-taking-a-person-off-at-the-counter-hand-the-money-over-then-and-it-is-written-as-the-payout-it-is.md)

## Integrations

| Subject | Authoritative document |
| ------- | ---------------------- |
| Billplz and Stripe set-up | [Payment gateways](integrations/payment-gateways.md) |
| Which payment, email, phone-check and storage providers to launch with, and why | [Launch providers](integrations/launch-providers.md) |
| Email, WhatsApp and SMS: what is sent when, delivery, costs, marketing email; what happens when a provider is down ([ADR 0056](architecture/decisions/0056-outbox-reliability-messages-survive-outages-and-stops.md)) | [Messaging](integrations/messaging.md) |
| WhatsApp set-up and every template, word for word | [WhatsApp templates](integrations/whatsapp-templates.md) |
| LHDN MyInvois e-invoicing | [MyInvois](integrations/myinvois.md) |
| Live accounting: sending a venue's sales to Xero (set-up, mapping, the queue, the reconciliation, verifying against a demo company) | [Xero](integrations/xero.md) |
| Public API, outgoing webhooks, Reserve with Google feeds | [External API](integrations/external-api.md) |
| Using MySenam from an AI assistant: the MCP server, its tools, keys, signing in from a connector (OAuth), changing settings, and personal data | [MCP server](integrations/mcp.md) |

## Development and operations

| Subject | Authoritative document |
| ------- | ---------------------- |
| Running it locally, everyday commands | [Getting started](development/getting-started.md) |
| Every environment variable | [Configuration](development/configuration.md) |
| Tests, what they prove, the verification runner, staging, real-service checks, acceptance scenarios, CI, documentation checks | [Testing](development/testing.md) |
| Where documentation belongs, statuses in plain words, the feature-document outline, names, keeping history | [Documentation](development/documentation.md) |
| MySenam's pictures: the glyph standard (24-unit grid, line drawings in the text's colour), tiles and their tone tokens, accessibility, where pictures are used and not, replacing a glyph, their cost | [Images](development/images.md) |
| Production, proxies, upgrading, staging before a release, the launch checklist | [Deployment](operations/deployment.md); kit in [`deploy/digitalocean`](../deploy/digitalocean/README.md) |
| Backups, off-site copies, restoring (disaster recovery) | [Backups](operations/backups.md) |
| Alerts, errors, health checks | [Monitoring](operations/monitoring.md) |
| Setting up Amazon SES for a production marketplace: region, sender identity, DKIM, SPF, DMARC, tracking off, permissions, sandbox, quota, bounces, the controlled delivery check and how it is recorded | [Email with SES: the checklist](operations/email-ses-checklist.md) |
| What the consolidated e-invoice does with stored credit and gift vouchers today, where it counts them twice, what LHDN's FAQ and Guideline say (read 7 November 2026), and the questions for a Malaysian tax adviser (audit C2, DEC-19; no treatment chosen) | [E-invoicing and stored value: a memo for the tax adviser](operations/einvoice-stored-credit-memo.md) |
| The questions to put to a Malaysian lawyer before youth messaging is enabled, with the interim measure for each, and the launch gate | [Legal review: youth messaging](operations/legal-review-youth-messaging.md) |
| What to do when something goes wrong: severity, containment, evidence, recovery, breach notification in Malaysia and Singapore | [Incident response](operations/incident-response.md) |
| Whether a restricted pilot can start: the capability matrix, integrations, operating conditions, acceptance criteria | [Pilot readiness](operations/pilot-readiness-2026-11-07.md) |
| What was checked against the real services and the environment in the pilot-activation round, and what is still open | [Pilot activation record](operations/pilot-activation-2026-11-08.md) |
| What must be proven against the real services before the pilot (SES, B2, Billplz): the checks, the proof, today's results | [Pilot provider verification](operations/pilot-provider-verification.md) |
| The questions for a Malaysian lawyer and, separately, the venue's tax adviser before the pilot takes a real customer: terms, privacy, payments and refunds, stored value, closure, retention, erasure, backups abroad, breach notification, providers, cancellation terms, liability, youth (pointer), and the unresolved MyInvois treatment of stored value; each item NOT REVIEWED | [Legal and tax review packet](operations/legal-review-packet-2026-11-08.md) |
| What the named pilot operator does each day and week, the incident procedures (application down, email failing, paid with no booking, not refunded, double claim, venue closing, provider failing, backup failing, breach, lost access), the start and end of day sheet and the escalation table | [Pilot daily operations](operations/pilot-daily-operations.md) |
| Installs from before Postgres or before the rename from MudahTempah, and outages from before migration 0090 | [Legacy installs](archive/migrations/legacy-installs.md) |

## Plans, research and audits

| Subject | Document |
| ------- | -------- |
| Work not built: planned (accepted) and proposed (ideas), blocked and deferred | [Roadmap](roadmap/roadmap.md) |
| The next workstream: checking what is built against real services, in order, with what each needs from the owner | [Real-service verification](roadmap/integration-workstream.md) |
| What is wrong, missing or unverified now | [Known limitations](roadmap/known-limitations.md) |
| Go-to-market research, October 2026: competitors, costs, pricing, segments, and what became of its recommendations | [Go-to-market research](research/go-to-market/index.md) |
| Where to store and scan supporting documents, and at what cost (October 2026): object storage, on-demand scanners and GuardDuty compared with clamd on the 4 GB Droplet; a recommendation, not a decision | [Document storage and scanning costs](research/2026-10-27-document-storage-and-scanning-costs.md) |
| Audits by date, and a tracker of the launch audit's open items | [Audits](audits/index.md) |
| The business-process audit of 6 November 2026: every finding with evidence and status, and what is left in order | [Findings register](audits/findings-register-2026-11-06.md) ([E to H](audits/findings-register-2026-11-06-e-to-h.md)), [remediation roadmap](audits/remediation-roadmap-2026-11-06.md), [the hardening round that followed](audits/hardening-2026-11-07.md) |
| The same audit's workflow inventory, consistency matrix, state machines and owner decisions | [Inventory](audits/business-process-inventory-2026-11-06.md), [cross-domain consistency](audits/cross-domain-consistency-2026-11-06.md), [state transitions and recovery](audits/state-transitions-and-recovery-2026-11-06.md), [business decisions](audits/business-decisions-2026-11-06.md) |

## Where new information belongs

| You have | It goes in |
| -------- | ---------- |
| Changed how a capability behaves | Its feature document above, and its row in [feature status](product/feature-status.md) |
| A new capability | Its domain's feature document (a new one only for a new domain), a feature-status row with its code and tests |
| A design choice that constrains future work | A new [decision record](architecture/decisions/) |
| A defect, gap or unverified dependency | [Known limitations](roadmap/known-limitations.md) |
| Accepted work not yet built, or an idea | [Roadmap](roadmap/roadmap.md), as planned or proposed |
| Research, a competitor study, a feasibility note | A dated file under [`research/`](research/) |
| A dated review of the product or code | A dated file under [`audits/`](audits/index.md), its open items tracked there |
| A business decision (prices, launch policy) | [Business](business/pricing.md) |
| How to deploy, recover or watch it | [Operations](operations/deployment.md) |

## Where the old README sections went

The README used to hold everything. Sections it named in passing (*see
"Whose credit it is"*) now live here:

| Old README section | Now in |
| ------------------ | ------ |
| Features, Tech stack, Project structure, What one box gives you | [Product overview](product/overview.md), [architecture overview](architecture/overview.md) |
| Getting started, Configuration, Continuous integration | [Getting started](development/getting-started.md), [configuration](development/configuration.md), [testing](development/testing.md) |
| Deploying, Behind a proxy, Upgrading, Before going live | [Deployment](operations/deployment.md) |
| Backups, Off-site copies, Restoring | [Backups](operations/backups.md) |
| Being told when something breaks, Errors | [Monitoring](operations/monitoring.md) |
| Moving from SQLite, Renamed from MudahTempah | [Legacy installs](archive/migrations/legacy-installs.md) |
| Running the marketplace, Checking a venue is real, Storefront domains | [Marketplace](product/marketplace.md) |
| Plans by size | [Business: pricing](business/pricing.md) |
| Two-factor sign-in, Admin access, Session cookies, Signing in with Google, Checking a customer's phone number, Forgotten passwords | [Authentication](architecture/authentication.md) |
| Managers and front desk, Businesses with several branches, A venue business's own copy | [Tenancy](architecture/tenancy.md) |
| Spreadsheets, sales journal, staff activity log, Reporting | [Reporting](features/reporting.md) |
| API | [HTTP routes](architecture/http-api.md) |
| Personal data | [Privacy](architecture/privacy.md); its size and TimescaleDB part in [ADR 0004](architecture/decisions/0004-plain-postgres-not-timescaledb.md) |
| Rate limiting, Limits that follow the phone number | [Security](architecture/security.md) |
| More than one instance | [Architecture overview](architecture/overview.md#more-than-one-instance) |
| Messages to customers, News from venues | [Messaging](integrations/messaging.md); templates in [WhatsApp templates](integrations/whatsapp-templates.md) |
| Payments (holds, paying online) / Payment gateways, Stripe | [Payments and credit](features/payments-and-credit.md) / [payment gateways](integrations/payment-gateways.md) |
| Stored credit, Whose credit it is, Topping up, Gift vouchers, Splitting the cost, Extras, Counter sales, Company and school accounts | [Payments and credit](features/payments-and-credit.md) |
| Countries, Tax | [Regions and tax](product/regions-and-tax.md) |
| E-invoicing (MyInvois) | [MyInvois](integrations/myinvois.md) |
| Live accounting (Xero) | [Xero](integrations/xero.md) |
| Public API and webhooks, Reserve with Google | [External API](integrations/external-api.md) |
| AI assistants (MCP) | [MCP server](integrations/mcp.md) |
| Audit fixes | [Business rules](product/business-rules.md) |
| Roadmap ideas, Deliberately not built | [Roadmap](roadmap/roadmap.md), [known limitations](roadmap/known-limitations.md) |
| Every other feature section | The feature documents under [`features/`](features/) |
