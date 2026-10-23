# Architecture overview

How the application is put together, and how it behaves with one or several
instances. Decisions behind the larger choices are recorded in
[`decisions/`](decisions/).

## Tech stack

- [Next.js 15](https://nextjs.org/) (App Router) + React 19 + TypeScript. Pages
  and API routes live in one application; there is no separate backend
  service.
- [Tailwind CSS 4](https://tailwindcss.com/).
- PostgreSQL 16 or later in production (`DATABASE_URL`), and
  [PGlite](https://pglite.dev) — Postgres compiled to WebAssembly and run
  inside the app — for development and the tests, so neither needs a server.
  See [ADR 0001](decisions/0001-postgres-in-production-pglite-in-development.md).
- No external auth service, queue or cache: sessions, rate limits, the message
  outbox and the scheduler's lease are tables in the same database.

## Project structure

```
src/
  app/                 # Pages and API routes (App Router)
    api/               # Route handlers; admin/ is staff-only, my/ needs a customer session,
                       # v1/ is the key-authenticated public API
    admin/             # The staff dashboard
    venue/[id]/        # A venue's page: availability grid and booking form
    search/, classes/, games/, tournaments/, leagues/, account/, my-booking/ …
  components/          # React components; admin/ holds the dashboard's tabs and panels
  lib/                 # Business logic, one module per subject (about 125 files), e.g.
    db.ts              #   Postgres or PGlite, migrations, serializable transactions with retry
    store.ts           #   Courts, availability, bookings, blocks, classes, credit, passes
    payments.ts        #   Online payments, refunds owed, settlement
    gateways/          #   Billplz and Stripe adapters
    outbox.ts, notify.ts, transports.ts   # Messages: queue, wording, email/WhatsApp/SMS
    scheduler.ts       #   The once-a-minute tick and its lease
    privacy.ts         #   Export, erasure, retention
    i18n*.ts           #   en and ms (i18n.ts), zh, ta
db/migrations/         # The schema: numbered .sql files applied in order, never edited after release
scripts/               # backup, restore, import-sqlite
deploy/digitalocean/   # One-server kit: Postgres, the app and Caddy on a Droplet
tests/                 # Vitest; each file gets its own database (PGlite, or Postgres with TEST_DATABASE_URL)
docs/                  # This documentation
```

## Data and consistency

Everything is in one Postgres database ([database](database.md)). Every path
that checks and then writes — a court's last free hour, a wallet balance, a
pass entry, a class's last place — runs in one `SERIALIZABLE` transaction,
retried on a serialization failure or deadlock (`withTransaction` in
`src/lib/db.ts`). Overlapping court time is additionally refused by the
database itself: everything that occupies a court is a claim, under an
exclusion constraint for exclusive courts and a capacity trigger for shared
facilities ([booking time model](interval-booking-review.md)). What is
and is not proven about this is in
[booking concurrency](booking-concurrency.md).

## More than one instance

Several app instances can share one database. Four things need attention:

- **Rate limits** are counted in each process's memory by default. Behind
  several instances, set `MYSENAM_RATE_LIMITS=shared` so the counters live in
  Postgres ([security](security.md#rate-limiting)).
- **Scheduled work** (messages, released holds, interrupted refunds, invoices,
  overdue checks, league housekeeping, retention, the nightly backup): each instance ticks,
  but only the one holding the **scheduler's lease** works. The lease is a row
  in `settings` naming the instance and when it runs out
  (`holdSchedulerLease` in `src/lib/scheduler.ts`). The holder renews it every
  minute; if it stops, another instance takes over within three minutes. No
  setting is needed; `MYSENAM_SCHEDULER=off` is only for an install that runs
  the work from its own cron instead.
- **`MYSENAM_SECRET`** must be the same on every instance. Without it, each
  instance makes its own `secret.key`, and payment keys, reset tokens, phone
  codes and recovery codes sealed or hashed by one cannot be read by another
  (`src/lib/secrets.ts`). The DigitalOcean kit sets it.
- **Photos** are files in the data folder unless a bucket is set
  (`PHOTOS_S3_*`), so behind several instances each would see only its own
  uploads. Set the bucket ([discovery](../features/discovery.md)).

The lease (three minutes) is renewed when a tick starts and every minute while
it runs, so a long tick (a large `pg_dump` plus its upload) keeps it. Outgoing
webhook deliveries are each claimed before they are sent, so two instances
delivering at once send each one once.

Backups are written to the data folder of whichever instance holds the lease,
so with several instances set up an [off-site copy](../operations/backups.md#off-site-copies)
to keep them in one place.

## One codebase, two shapes

The same code runs as the shared marketplace (`MYSENAM_MARKETPLACE=on`) and as
one business's own install with its own database. See
[tenancy](tenancy.md) and [ADR 0005](decisions/0005-shared-marketplace-and-own-installs.md).
