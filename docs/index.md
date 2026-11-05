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
| Messages between players: the contexts a conversation can be in, adults who opted in, text with no contact details, limits, notices that never carry the message, blocking, reports, moderation by the venue that owns the context | [Messages between players](features/player-messages.md) |
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
[0043 Moving a class, and a class's instructor as one of the venue's coaches](architecture/decisions/0043-moving-a-class-and-a-class-coach.md)
[0045 Front desk may move a class; a consequential or exceptional move waits for a manager](architecture/decisions/0045-front-desk-class-moves-with-approval.md)
[0042 Attendance registers, and a lesson the venue moves](architecture/decisions/0042-attendance-registers-and-lessons-moved-by-the-venue.md)
[0037 Launch and tide windows narrow the bookable hours of water hire](architecture/decisions/0037-launch-and-tide-windows.md)
[0041 Live accounting: a venue's sales pushed to Xero, optional, behind a provider interface](architecture/decisions/0041-live-accounting-push-to-xero.md)
[0040 Court time held for ladder challenges, and ladders of persistent teams](architecture/decisions/0040-ladder-court-time-and-team-ladders.md)
[0038 Swiss: accelerated pairing, a tie-break screen, and Swiss for performance events](architecture/decisions/0038-swiss-acceleration-tie-break-screen-and-performance-swiss.md)
[0036 Who supervises a session: rosters, qualifications and supervision rules, asked in the one booking path](architecture/decisions/0036-who-supervises-a-session.md)
[0048 Ladder court-time holds: configurable limits, tentative holds that expire, no overlap, limits that only refuse](architecture/decisions/0048-ladder-hold-limits-and-expiry.md)

## Integrations

| Subject | Authoritative document |
| ------- | ---------------------- |
| Billplz and Stripe set-up | [Payment gateways](integrations/payment-gateways.md) |
| Which payment, email, phone-check and storage providers to launch with, and why | [Launch providers](integrations/launch-providers.md) |
| Email, WhatsApp and SMS: what is sent when, delivery, costs, marketing email | [Messaging](integrations/messaging.md) |
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
| What to do when something goes wrong: severity, containment, evidence, recovery, breach notification in Malaysia and Singapore | [Incident response](operations/incident-response.md) |
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
