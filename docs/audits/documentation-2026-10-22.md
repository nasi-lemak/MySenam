# Documentation audit, October 2026

> **Audit record, 22 October 2026.** Moved from `docs/documentation-audit.md`
> on 24 October 2026; its links were adjusted to the new folder, its findings
> are as written then. The documentation conventions it established are now
> maintained in [documentation](../development/documentation.md).

A one-off record of how the documentation was checked against the code and
restructured. It is not maintained; the documents it points to are.
Defects found here are tracked, and marked fixed, in
[known limitations](../roadmap/known-limitations.md#fixed-since-the-audit); this
report describes the state when it was written.
**No application behaviour was changed**: the only edits outside documentation
are three source comments that named README sections, two tests that read the
WhatsApp templates from their new home, the documentation checks, a
`docs:check` script and a CI workflow for them.

## Executive summary

**Problems found.** All documentation lived in one 4,459-line `README.md`
that mixed product description, set-up, operations, a history of fixes
("Audit fixes"), plans and research. Several statements had gone stale as the
code moved on, a few overstated what is guaranteed, and nothing recorded which
capabilities were verified against real services and which only against
fakes.

**Important contradictions** (full list under
[discrepancies](#implementation-discrepancies)):

- The README called double booking "proven impossible". The database does
  prevent two bookings of one slot, but around it several paths check outside
  their transaction or ignore holds and linked courts
  ([booking concurrency](../architecture/booking-concurrency.md)).
- It told operators to switch the scheduler off on all but one instance; the
  code now takes a lease, and switching it off everywhere leaves nightly work
  undone.
- It described rate limits as per-process and needing Redis; they can be
  shared through Postgres (`MYSENAM_RATE_LIMITS=shared`).
- It said pay-to-hold and top-ups need Billplz, in whole ringgit; either
  gateway works, and top-ups take sen.
- It pointed deployers at a Render kit folder (deploy/render) that does not exist.
- The backup, restore and SQLite-import scripts it documents do not start on
  Node 22 ([S1](../roadmap/known-limitations.md#operations-and-security-s)).

**Restructuring.** The README is now 103 lines: what MySenam is, how to run,
test and deploy it, the warnings that matter before production, and links.
Everything else moved into `docs/` with one authoritative document per subject
([index](../index.md), which also maps every old README section to its new
home). New: a [feature-status matrix](../product/feature-status.md), a
[known-limitations register](../roadmap/known-limitations.md), eight
[decision records](../architecture/decisions/), [`AGENTS.md`](../../AGENTS.md) and
automated [documentation checks](../development/testing.md#documentation-checks).

**Remaining uncertainties.** Suspected defects other than S1, S2, S4, M1, M5,
B1 and B4 (which were confirmed by reading the code, S1 also by running it)
come from systematic code reading and have not each been reproduced. Whether
two behaviours are intended (cancelling a series skips weeks inside the
cutoff; rescheduling ignores booking-length limits) could not be settled from
the code. Nothing was tested against a live external service.

## Changes

### Created

| Document | Why |
| -------- | --- |
| [`docs/index.md`](../index.md) | Entry point: authoritative home per subject; old-section map |
| [Feature status](../product/feature-status.md) | Every capability with status, code and tests |
| [Known limitations](../roadmap/known-limitations.md) | Suspected defects (S/B/M), unverified integrations, exclusions, gaps |
| [Booking concurrency](../architecture/booking-concurrency.md) | What is and is not guaranteed under concurrent requests |
| [Database](../architecture/database.md) | Engines, migrations, conventions |
| [Decision records 0000–0007](../architecture/decisions/) | Why SQLite was left, Postgres and PGlite, database-enforced concurrency, scheduler lease, not TimescaleDB, marketplace and own installs, per-venue payment accounts, credit ownership |
| [`AGENTS.md`](../../AGENTS.md) | The twelve documentation-maintenance rules for coding agents |
| `tests/docs.test.ts`, `npm run docs:check`, `.github/workflows/docs.yml` | Automated reference checks, also on Markdown-only changes the main CI skips |
| This report | Record of the audit |

### Moved out of the README (and corrected where noted)

| Material | New home | Edited? |
| -------- | -------- | ------- |
| Features, tech stack, structure | [Product overview](../product/overview.md), [architecture overview](../architecture/overview.md) | Rewritten; glossary added |
| Feature sections | [`features/`](../features/) (booking, pricing, payments and credit, programmes, venue operations, discovery, reporting) | Booking and payments corrected (below) |
| Marketplace, regions and tax | [Marketplace](../product/marketplace.md), [regions and tax](../product/regions-and-tax.md) | Moved |
| Roles, branches, own installs | [Tenancy](../architecture/tenancy.md) | Terms and enforcement added |
| Sign-in, sessions, two-factor, Google, phone checks | [Authentication](../architecture/authentication.md) | Corrected |
| Rate limiting | [Security](../architecture/security.md) | Corrected |
| Personal data | [Privacy](../architecture/privacy.md) | Corrected; S2 noted |
| API tables | [HTTP routes](../architecture/http-api.md) | Marked partial; checked |
| Getting started, configuration, CI | [`development/`](../development/) | Rewritten; missing variables added |
| Deploying, backups, monitoring | [`operations/`](../operations/) | Corrected; S1 noted |
| Gateways, messaging, WhatsApp templates, MyInvois, public API | [`integrations/`](../integrations/) | Gateway notes corrected |
| Plans by size | [Business: pricing](../business/pricing.md) | Moved |
| "Audit fixes" | [Business rules](../product/business-rules.md) | Rewritten from a fix history into present-tense rules |
| Roadmap ideas, deliberately not built | [Roadmap](../roadmap/roadmap.md), [known limitations](../roadmap/known-limitations.md#deliberately-unsupported) | Statuses added |

### Archived

- Moving from SQLite and the rename from MudahTempah →
  [legacy installs](../archive/migrations/legacy-installs.md). Still needed by
  anyone upgrading an old install, so kept, but out of the main path.

### Removed

- No information was deleted outright. Repetition (the same rule stated in
  several sections) was reduced to one statement plus links, and the
  fix-by-fix narrative of "Audit fixes" was replaced by the rules it
  established. The original README is in git history at commit `4f98fe5`.

### Outside `docs/`

- `README.md`: rewritten (above).
- `deploy/digitalocean/README.md`: S1 warning; backup time stated as local.
- `tests/transports.test.ts`, `tests/impersonation.test.ts`: read or name the
  templates' new document.
- `src/lib/plans.ts`, `src/lib/storefront.ts`, `src/lib/transports.ts`:
  comments only, pointing at the new documents.
- `package.json`: `docs:check` script.

## Implementation discrepancies

Type: **Outdated** documentation, **Incomplete** feature, or potential
**Defect**.

| Documented claim | Observed implementation | Evidence | Type | Action |
| ---------------- | ----------------------- | -------- | ---- | ------ |
| Double booking proven impossible | Slot uniqueness is enforced by the database; linked-court shadows, holds, outages and moves have gaps | `db/migrations/0072_linked_courts.sql`, `src/lib/store.ts`, `src/lib/outages.ts` | Outdated + Defect (B1–B8) | Reworded; [booking concurrency](../architecture/booking-concurrency.md); B1–B8 recorded |
| Bookings up to 4 hours | Up to 4 by default; courts can allow up to 12; search still caps at 4 | `src/lib/store.ts`, `src/app/api/search/route.ts` | Outdated + Defect (B6) | Corrected; B6 |
| 14-day window, Malaysia time zone | Per-venue window (up to 90 days) and per-venue time zone | `MAX_VENUE_AHEAD_DAYS` in `src/lib/types.ts`, `src/lib/region.ts` | Outdated | Corrected |
| Two roles: customer and staff | Customers, staff (manager / front desk), business managers, coaches, platform owner | `src/lib/admin-auth.ts`, `tests/roles.test.ts` | Outdated | [Tenancy](../architecture/tenancy.md) |
| Scheduler must be off on all but one instance | A Postgres lease lets one instance run each tick | `src/lib/scheduler.ts` | Outdated | Corrected; [ADR 0003](../architecture/decisions/0003-scheduler-lease.md); S3 |
| Rate limits per process; need Redis for several | Shared mode stores them in Postgres | `src/lib/rate-limit.ts` | Outdated | Corrected |
| Sign-in limited per IP and per email | Limited per pair of IP and email | `src/lib/rate-limit.ts` | Outdated + Defect (S5) | Corrected; S5 |
| Deploy with the deploy/render kit | No such folder; DigitalOcean kit only | `deploy/` | Outdated | Removed |
| CI runs on every push and PR | PRs, pushes to `main` and the demo branch, by hand; skips Markdown-only | `.github/workflows/ci.yml` | Outdated | Corrected; docs workflow added |
| `.env.example` lists all settings | It lists about half | `.env.example` | Outdated | [Configuration](../development/configuration.md) is complete and checked |
| Nothing verifies phone numbers | Phone checks by WhatsApp or SMS code exist (`verified_phone`) | `src/lib/phone-check.ts`, `tests/impersonation.test.ts` | Outdated | Corrected |
| Phone codes gone within a day | Deleted only when the next code is requested | `src/lib/phone-check.ts` | Defect (S8) | S8 |
| Schema created on first start | Migrations run on the first database query | `src/lib/db.ts` | Outdated | Corrected |
| Startup warns when the backup folder is missing | No such warning | `src/lib/db.ts`, `src/instrumentation.ts` | Outdated | Corrected |
| Pay-to-hold and top-ups need Billplz, whole ringgit | Either gateway; top-ups in sen | `src/lib/gateways/`, `isAmount` in `src/lib/region.ts` | Outdated | Corrected |
| Venues should subscribe to the Stripe events listed in settings | The list omits `charge.dispute.*`, which the code handles | `src/lib/gateways/stripe.ts` | Defect (M5) | Documentation lists them; M5 |
| `npm run backup` / `restore` / `import-sqlite` work | Fail with `ERR_MODULE_NOT_FOUND` on Node 22 | Ran `node scripts/backup.mjs` | Defect (S1) | Warnings in README, backups, deployment, DigitalOcean kit |
| Erasing a customer removes their data | Fails while they have a waiting-list entry | `db/migrations/0001_initial.sql`, `src/lib/privacy.ts` | Defect (S2) | Noted in [privacy](../architecture/privacy.md) |
| A player leaving an open game is owed back their share | Refunded, but the booking stays paid | `src/lib/games.ts` | Defect (M1) | Noted in business rules |
| Sessions expire after 30 / 7 days | Valid until the end of the UTC day of expiry | `src/lib/auth.ts` | Defect (S4) | S4 |
| "Three notes" on legacy installs; `blocks_between` defined in a later migration | Four notes; first defined in `0009` | `db/migrations/0009_outages_suspensions.sql` | Outdated | Corrected |

## Feature inventory

From [feature status](../product/feature-status.md) (133 capabilities):

| Status | Count |
| ------ | ----- |
| IMPLEMENTED_AND_TESTED | 104 |
| INTEGRATION_VERIFICATION_REQUIRED | 20 |
| PARTIALLY_IMPLEMENTED | 3 |
| IMPLEMENTED_UNTESTED | 3 |
| BLOCKED | 2 |
| UNSUPPORTED | 1 |

`IMPLEMENTED_AND_TESTED` means automated tests against the code and fakes,
and several such capabilities carry suspected defects recorded against them.

- **Partially implemented:** privacy notice and terms (drafts awaiting legal
  review), Reserve with Google feeds (no upload, no partner), Tamil (machine
  translation awaiting review).
- **Implemented, untested:** installing as an app; the backup, restore and
  import scripts (broken, S1); the DigitalOcean kit (blocked by S1).
- **Needing live verification (20):** Billplz bills and callbacks; Stripe
  Checkout, webhooks, refunds, disputes and renewals; MyInvois connection,
  consolidated invoices and credit notes, customers' own e-invoices; Google
  sign-in; off-site backups and the photo bucket; WhatsApp templates, webhook
  and replies; SMS codes; email; geocoding; error and alert sinks.
- **Launch blockers:** S1 (no working restore), S2 (erasure under PDPA), M1
  (for open games with online shares), a live check of each payment gateway
  and of email, M2/M5 before taking Stripe deposits, and legal review of the
  terms and privacy notice.

## Verification

| Check | Command | Result |
| ----- | ------- | ------ |
| Documentation references | `npm run docs:check` | 56 checks pass; a deliberate broken link, anchor, path and route were each caught |
| Type-check | `npx tsc --noEmit -p .` | Passes, no errors |
| Tests on PGlite | `MYSENAM_DB=":memory:" npx vitest run` | 155 files, 1,566 tests pass |
| Tests on Postgres 16 | `TEST_DATABASE_URL=… npx vitest run` | 155 files, 1,566 tests pass |
| Build | `npx next build` | Succeeds |
| Backup script | `node scripts/backup.mjs` | Fails, `ERR_MODULE_NOT_FOUND` (S1) |
| Application code unchanged | `git diff --stat -- src` | Three files, comments only |

**Not performed:** no live call to any external service; no browser
session; no restore of a real backup; no check of external links (no
network); no legal review. Areas inspected: `src/lib/`, the routes under
`src/app/api/`, `db/migrations/`, `scripts/`, `deploy/`, `.github/` and
`tests/`. Page components under `src/app/` were read only where a feature
needed it.

**Manual checks that remain** (no script can do them): that each
authoritative document still describes the code; that a status reflects real
verification; that external links resolve.

## Remaining work

In order of impact:

1. **Fix S1** and add the restore drill it recommends; until then there is
   no tested way back from data loss.
2. **Fix S2** (erasure) and **M1** (open-game shares), each with the test in
   [known limitations](../roadmap/known-limitations.md).
3. **Verify live:** Billplz sandbox, Stripe test mode (including disputes,
   after fixing M5), an SMTP send with SPF/DKIM, then the rest of the
   [launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove).
4. **Legal review** of `/terms` and `/privacy`, with a Malay notice.
5. **Money defects M2–M4, M6, M7** before relying on the sales journal or
   Stripe deposits.
6. **Booking defects B1–B8**, starting with B1, B2 and B4.
7. **Settle the two open questions:** whether cancelling a series should apply
   the late-cancel policy to weeks inside the cutoff, and whether rescheduling
   should respect booking-length limits.
8. **Reproduce** the suspected defects that were found by reading only, each
   with its recommended test, before fixing.
9. Smaller gaps: an ESLint configuration, the rest of the HTTP route
   reference, `.env.example` completeness, browser tests, wider cross-venue
   `403` coverage.
