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
| Booking rules (starts, lengths, buffers, notice), availability, capacity, linked courts, waitlists, moving, cancelling, opening hours, outages, who may book | [Booking](features/booking.md) |
| Prices to the minute, fees, peak bands, holidays, last-minute prices, concessions, promo codes, memberships, passes | [Pricing](features/pricing.md) |
| Paying online, holds and deposits, stored credit and its ownership, gift vouchers, split costs, extras, counter sales, company accounts | [Payments and credit](features/payments-and-credit.md) |
| Classes and terms, one-to-one coaching, women-only and men-only (for every programme) | [Programmes](features/programmes.md) |
| Tournaments, competitions with divisions, competition rules and templates, results, corrections, box leagues | [Tournaments and leagues](features/tournaments.md) |
| Open games, suggested games and players, invitations, private games, weekly games, community groups, blocking and reporting | [Open games and matchmaking](features/matchmaking.md) |
| Check-in, unstaffed hours, equipment hire, notes, waivers, hire enquiries | [Venue operations](features/venue-operations.md) |
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
| Sign-in, sessions, two-factor, Google, phone checks, passwords | [Authentication](architecture/authentication.md) |
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
[0019 Approval applications apart from bookings](architecture/decisions/0019-approval-requests-apart-from-bookings.md)

## Integrations

| Subject | Authoritative document |
| ------- | ---------------------- |
| Billplz and Stripe set-up | [Payment gateways](integrations/payment-gateways.md) |
| Which payment, email, phone-check and storage providers to launch with, and why | [Launch providers](integrations/launch-providers.md) |
| Email, WhatsApp and SMS: what is sent when, delivery, costs, marketing email | [Messaging](integrations/messaging.md) |
| WhatsApp set-up and every template, word for word | [WhatsApp templates](integrations/whatsapp-templates.md) |
| LHDN MyInvois e-invoicing | [MyInvois](integrations/myinvois.md) |
| Public API, outgoing webhooks, Reserve with Google feeds | [External API](integrations/external-api.md) |

## Development and operations

| Subject | Authoritative document |
| ------- | ---------------------- |
| Running it locally, everyday commands | [Getting started](development/getting-started.md) |
| Every environment variable | [Configuration](development/configuration.md) |
| Tests, what they prove, the verification runner, staging, real-service checks, acceptance scenarios, CI, documentation checks | [Testing](development/testing.md) |
| Where documentation belongs, statuses in plain words, the feature-document outline, names, keeping history | [Documentation](development/documentation.md) |
| Production, proxies, upgrading, staging before a release, the launch checklist | [Deployment](operations/deployment.md); kit in [`deploy/digitalocean`](../deploy/digitalocean/README.md) |
| Backups, off-site copies, restoring (disaster recovery) | [Backups](operations/backups.md) |
| Alerts, errors, health checks | [Monitoring](operations/monitoring.md) |
| What to do when something goes wrong: severity, containment, evidence, recovery, breach notification in Malaysia and Singapore | [Incident response](operations/incident-response.md) |
| Installs from before Postgres or before the rename from MudahTempah, and outages from before migration 0090 | [Legacy installs](archive/migrations/legacy-installs.md) |

## Plans, research and audits

| Subject | Document |
| ------- | -------- |
| Work not built: planned (accepted) and proposed (ideas), blocked and deferred | [Roadmap](roadmap/roadmap.md) |
| What is wrong, missing or unverified now | [Known limitations](roadmap/known-limitations.md) |
| Go-to-market research, October 2026: competitors, costs, pricing, segments, and what became of its recommendations | [Go-to-market research](research/go-to-market/index.md) |
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
| Public API and webhooks, Reserve with Google | [External API](integrations/external-api.md) |
| Audit fixes | [Business rules](product/business-rules.md) |
| Roadmap ideas, Deliberately not built | [Roadmap](roadmap/roadmap.md), [known limitations](roadmap/known-limitations.md) |
| Every other feature section | The feature documents under [`features/`](features/) |
