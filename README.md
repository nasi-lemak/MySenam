# MySenam 🏸

**Gelanggang, gim dan kelas — satu tempahan.** Online booking and
venue-management software for sports and activity venues in Malaysia and
Singapore: courts and pitches, pools, lanes and bays, gyms and walls, water
and bike hire, and studio classes, from a catalogue of activities operators
can add to ([which are fully supported](docs/features/activities.md#support-matrix)).
It runs as a shared marketplace of independent venues or as one business's
own booking site.

## What it does

- **Booking**: live availability per venue and across venues; exclusive
  courts and shared facilities with places; courts offering several
  activities; linked courts; bookings to the
  minute within each court's booking rules (starts, lengths, buffers),
  "any court", several courts at once and weekly series; waitlists; moving,
  cancelling and late-cancel rules; public,
  members-only and private venues.
- **Pricing and money**: peak bands and holidays, last-minute prices,
  concessions, promo codes, memberships, passes, stored credit and gift
  vouchers; paying online into each venue's own Billplz or Stripe account, or
  at the counter; refunds, receipts, credit notes and company accounts
  invoiced monthly.
- **Running a venue**: a staff dashboard with check-in, equipment hire,
  unstaffed hours with door codes, classes, coaching, tournaments and leagues,
  reports, exports and an activity log, with manager and front-desk roles.
- **Customers and messages**: optional accounts, Google sign-in, phone checks,
  email/WhatsApp/SMS confirmations and reminders, in English, Bahasa
  Malaysia, Chinese and Tamil.

The full picture is in the [product overview](docs/product/overview.md).
What exists and how well it is verified is in
[feature status](docs/product/feature-status.md).

## Tech stack

Next.js 15 (App Router), React 19, TypeScript and Tailwind CSS 4. PostgreSQL
16+ in production; [PGlite](https://pglite.dev) (Postgres in WebAssembly) for
development and tests. Vitest. No external auth, queue or cache service.
See the [architecture overview](docs/architecture/overview.md).

## Run it locally

Node 22 (`.nvmrc`).

```bash
npm install
cp .env.example .env.local   # optional: every value has a working default
npm run dev                  # http://localhost:3000; staff dashboard at /admin
```

With no `DATABASE_URL`, the database is PGlite in `data/pglite`, created and
seeded on first request. Sign in at `/admin` as `admin@mysenam.my` /
`mysenam-admin` and load the demo data. More in
[getting started](docs/development/getting-started.md).

## Test and build

```bash
npm run typecheck
npm test                                                     # on PGlite
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test   # on Postgres
npm run docs:check                                           # documentation links and references
npm run build
npm run verify -- full                                       # all of it, with a report
npm run stage -- run                                         # on a staging copy with Docker
```

Tests never call live payment, messaging or e-invoicing services; see
[testing](docs/development/testing.md).

## Deploying

Build, set `DATABASE_URL` to a PostgreSQL 16+ server, and `npm start` behind a
TLS-terminating proxy; migrations run on start. The ready-made path is one
DigitalOcean Droplet set up by [`deploy/digitalocean`](deploy/digitalocean/README.md).
Read [deployment](docs/operations/deployment.md),
[configuration](docs/development/configuration.md) and
[backups](docs/operations/backups.md) first.

## Before production

- **Set `ADMIN_EMAIL` and an `ADMIN_PASSWORD` of 12+ characters** before the
  first start: in production the published default opens nothing and no owner
  is made without one. Set `MYSENAM_SECRET` and keep it out of
  backups. Turn on two-factor sign-in for owners.
- **No external integration has been verified against a live account**:
  Billplz, Stripe, WhatsApp, SMS, email delivery, MyInvois and Google sign-in
  are tested against fakes only. Work through the
  [launch checklist](docs/operations/deployment.md#before-going-live-what-only-a-live-account-can-prove).
- **Known gaps and open questions** are listed in
  [known limitations](docs/roadmap/known-limitations.md).
- The terms at `/terms` and privacy notice at `/privacy` are drafts that
  describe the software; have a lawyer review them.

## Documentation

Start at [`docs/index.md`](docs/index.md). It maps every subject to the one
document that is authoritative for it.

- [Feature status](docs/product/feature-status.md) — every capability, its
  status (implemented and tested, needing live verification, partial,
  planned…), its code and its tests.
- [Known limitations](docs/roadmap/known-limitations.md) and
  [roadmap](docs/roadmap/roadmap.md) — what is missing, broken or planned,
  kept apart from what works.
- [`AGENTS.md`](AGENTS.md) — how documentation is kept accurate as the code
  changes; it applies to people as much as to AI agents.
