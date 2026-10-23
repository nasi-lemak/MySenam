# Testing and CI

How the tests run, what they do and do not prove, and what CI checks.

## Running the tests

```bash
npm test                                   # every test file, each on its own in-memory PGlite
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test
                                           # the same suite on a real Postgres server: each file
                                           # gets a throwaway database, dropped when it finishes
MYSENAM_DB=":memory:" npx vitest run tests/booking-rules.test.ts   # one file
npm run coverage                           # with a coverage report in coverage/
```

The suite is Vitest (`vitest.config.mts`, `tests/setup-db.ts`). Route
handlers are called directly with `NextRequest`s, so most tests exercise the
real route, its authorisation and the database together. Component tests
(`tests/components/`) render React components against a stubbed `fetch`.

Run it on both engines before relying on a change that touches SQL or
concurrency: PGlite runs one connection, so only the Postgres run shows
requests truly interleaving (`tests/concurrency.test.ts`).

## What the tests do not prove

- **External services are never called.** Payment gateways, WhatsApp, SMS,
  email, MyInvois, Google sign-in, object storage and geocoding are exercised
  against fakes or recorded answers. A passing test shows MySenam's side of
  the exchange, not that the live service accepts it. What still needs a live
  check is listed in [feature status](../product/feature-status.md) and in the
  [launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove).
- **Browsers** drive only a few journeys ([end-to-end tests](#end-to-end-tests)):
  most pages are covered by their route and component tests, not a browser.
- **Restoring** is tested on a fresh database only:
  `tests/backup-scripts.test.ts` runs `scripts/backup.mjs` and
  `scripts/restore.mjs` with `node`, as an operator would, on both engines.
  Nothing restores a full-size production backup; try one before relying on
  it ([backups](../operations/backups.md)).

## End-to-end tests

```bash
npm run build && npm run e2e
```

`tests/e2e/` runs the production build with `next start` (`NODE_ENV=production`,
an in-memory database with the starter venues, `MYSENAM_SEND=log`) and drives
a headless Chromium through it with `playwright-core`
(`vitest.e2e.config.mts`, `tests/e2e/server.ts`). The browser is this
container's `/opt/pw-browsers/chromium`, `CHROMIUM_PATH`, or Playwright's own
download (`npx playwright-core install chromium`).

What they cover, and nothing more: the security headers and that pages load
under the content security policy; a customer booking a court from the venue
page to a booking code; the owner refused with the default password and signed
in with their own; a signed-in request from another site refused; padel found
at its 90 minutes (`sports.e2e.ts`); golf bays made from a template, a court
offering a second activity, an activity found by a typed word, and a floor
sold for one activity at a time (`activities.e2e.ts`). Each
roadmap batch adds the journeys it changes (see the
[roadmap](../roadmap/roadmap.md#delivered)).

## Marketplace benchmark

```bash
BENCH_DATABASE_URL=postgresql://postgres@localhost/mysenam_bench npm run bench
```

`tests/bench/marketplace.bench.ts` (its own config, `vitest.bench.config.mts`;
not part of `npm test`) fills the named Postgres database once with a
multi-tenant marketplace — 400 venues in 25 areas, 100 of them branches of 20
businesses, about 2,800 resources across the catalogue's activities, and six
weeks of bookings (two past, four ahead) at evening-heavy occupancy, each
holding its claim — then times what customers, staff and the scheduler do,
through the same functions the routes call, and prints each as p50/p95/max
milliseconds, also written to `mysenam-bench.json` in the system's temporary
folder. Places on shared floors go in with the capacity trigger off for that
one insert (they cannot exceed capacity), because checked one at a time they
take hours (see below). The database is kept between runs (drop it to start again);
`BENCH_VENUES` and `BENCH_RUNS` change the size and the repetitions.

### Results

Run once, on 23 October 2026, on this branch: 4 CPUs, 15 GB, Postgres 16.15 on
its default settings (128 MB of shared buffers), the app in the same
container. The data: 404 venues, 2,846 resources, 918,435 bookings each
holding its claim, 802 MB. Twenty runs of each read, in milliseconds:

| What | p50 | p95 |
| ---- | --: | --: |
| Venue grid, every resource | 102 | 154 |
| Venue grid, one activity | 87 | 351 |
| Search: badminton in an area, soonest | 667 | 958 |
| Search: badminton in an area, cheapest | 680 | 856 |
| Search: near a point, 5 km | 2,392 | 3,709 |
| Search: a rarer activity nationwide (archery) | 888 | 1,070 |
| Search: courts counted nationwide | 2.5 | 2.7 |
| Home: activities by popularity | 201 | 223 |
| Home: venue list, first page | 4.7 | 9.4 |
| Search page: activities offered | 3.5 | 3.7 |
| Book a court | 203 | 229 |
| Book a place on a shared floor (before the day's other bookings) | 221 | 342 |
| Reschedule: free times on a day | 94 | 108 |
| Daily integrity check | 5,082 | 5,110 |

Fifty customers booking at once, each at a different venue, took 7.8 s: 26
booked, 1 refused, 6 found nothing free, and **17 got an error**, a
serialization failure still there after eight tries.

What this shows ([known limitations](../roadmap/known-limitations.md)):

- **Claims are read by time, not by court** (B12). The queries ask for a
  venue's courts with `court_id IN (…)` or through `court_spaces`, which the
  claims indexes cannot use (they index `int4range(court_id)` and
  `int4range(space_id)` with the time), so each reads every claim in the
  window across the marketplace and filters: about 20,000 rows and 88 ms for
  one venue's day. Search does that once per venue, hence seconds near a
  point. The capacity trigger's check has the same shape: 55 ms per check
  against 0.03 ms when written against the index, which made the fill load
  shared places at about ten a second (the fill now turns the trigger off
  for that one insert; whole courts went in at thousands a second).
- **Concurrent bookings at different venues conflict** (B13). Serializable
  transactions that read wide time ranges see each other's writes as
  conflicts; eight retries are not enough at fifty at once.
- The integrity check takes five seconds once a day, which is fine.

## Documentation checks

`npm run docs:check` runs `tests/docs.test.ts`, which needs no network and
checks that:

- every relative link in `README.md`, `AGENTS.md` and `docs/` points at a file
  that exists, and every `#anchor` at a heading in it;
- every repository path written in backticks in those files exists (paths
  under `src/`, `tests/`, `db/`, `scripts/`, `deploy/`, `docs/`);
- every `npm run <script>` named in them is a script in `package.json`;
- every environment variable the code reads is in
  [configuration](configuration.md), and every one listed there is read by the
  code;
- every route listed in [HTTP routes](../architecture/http-api.md) has a
  `route.ts`;
- in [feature status](../product/feature-status.md): every capability is
  named once with a known status and every column filled; everything built
  names its code, and every code path exists (root files included); every
  `IMPLEMENTED_AND_TESTED` row names test files (`.test` or `.e2e`, not
  helpers or benchmarks), and untested or unbuilt rows name none; the summary
  counts match the rows;
- every defect cited in parentheses, such as (M12), anywhere in the
  documentation is a row of [known limitations](../roadmap/known-limitations.md),
  and no identifier there is used twice.

They are part of `npm test` too. Checked by hand, because no script can:
that each authoritative document still describes the code; that statuses
reflect real verification and a cited test exercises the claim; that a row
taking money or sending messages names its integration leg; that external
links are alive (no network is used).

It cannot check that documented *behaviour* is true: that a route exists says
nothing about what it does. That is what the feature tests and review are for.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests, on pushes to `main` and the
demo branch, and by hand. It type-checks, lints, runs the suite on PGlite and again
on Postgres 16, builds, and runs the end-to-end tests against that build. It
skips changes that touch only Markdown, so
`.github/workflows/docs.yml` runs the documentation checks on those (and on
every other pull request) instead.
