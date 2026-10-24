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
requests truly interleaving (`tests/concurrency.test.ts`). On Postgres that file
sometimes times out at 30 seconds, a real stall in the code rather than a
slow machine ([known limitations](../roadmap/known-limitations.md), B14).

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

## Three ways to check a change

One runner does the same checks here, on a staging machine and in CI, and
writes what it tested to `artifacts/verify/<commit>-<time>.json`: the commit,
whether the tree had uncommitted changes, a digest of the exact content, and
each step's result and time. A step it could not run (no Postgres, no
browser) is reported as blocked, never as passed.

```bash
npm run verify -- fast                 # typecheck, lint, the tests touched by uncommitted changes (about 30 s)
npm run verify -- fast tests/games.test.ts
npm run verify -- full                 # typecheck, lint, docs, PGlite, Postgres, build, browser tests
npm run verify -- pg                   # the suite on Postgres only
npm run verify -- e2e                  # browser tests; builds only when the source digest changed
npm run verify -- uat                  # the visual acceptance scenarios (below)
npm run verify -- uat "C:"             # one scenario, by its title
```

Postgres comes from `TEST_DATABASE_URL`, `--pg <url>`, or else a throwaway
`postgres:16-alpine` container labelled `mysenam.purpose=verify`, removed
when the run ends however it ends.

### Staging and real services

**On this machine, with Docker** (`npm run stage -- …`, `scripts/stage.mjs`):
the app as an immutable image built from this source, its own Postgres,
synthetic data, the tests run against it, the evidence kept, and everything
made removed again.

```bash
npm run stage -- run                   # image → up → seed → smoke + e2e → evidence → down
npm run stage -- run --keep --suite smoke,e2e,uat
npm run stage -- status                # deployments, their expiry, and leftovers
npm run stage -- down <id>             # remove one deployment, and check nothing of it is left
npm run stage -- gc --images 3         # remove expired deployments; keep the newest 3 images
```

- The image is tagged `mysenam:src-<digest>`, the digest of the exact source
  (tracked files, uncommitted changes and untracked files), and labelled with
  it; a deployment refuses an image whose label does not match. One image per
  source is built once (about 165 s cold, with npm and Next caches mounted
  into the build) and reused until any file, the lock file or the
  `Dockerfile` changes. No credential is baked into the image or its cache:
  the proxy's CA reaches `npm ci` as a build secret.
- Each deployment has an id (`stg-<yymmddhhmm>-<hex>`) labelled on every
  container, network and volume it makes, with an expiry (`--ttl`, default
  4 h). `down` and `gc` remove only what carries those labels; nothing else on
  the machine is touched. Its record (image, digest, commit, address, owner
  credentials made for it, timings) is `artifacts/staging/<id>/deployment.json`.
- The database is fresh and synthetic, never a copy of production:
  `scripts/seed-synthetic.mjs` signs the generated owner in, fills the demo
  fortnight through the app, and adds players named `player<seed>-<n>@seed.mysenam.test`
  (the same seed makes the same people).
- `smoke` checks health, that venues are listed, that every migration
  applied, and that the data survives an app restart; `e2e` and `uat` run the
  browser suites against the deployment (`E2E_URL`).

Measured on this container (the latest run): the image built in 124 s (a
source already built is reused at once), started in 10.2 s, seeded in 25 s
(24 players with profiles and levels, the demo fortnight, 6 open games, one
of them private, and 5 requests), then smoke 5 of 5, e2e 11 of 11 and the
acceptance scenarios 14 of 14 against it on Postgres 16, and teardown with
nothing left.

**Remote, on demand, on DigitalOcean** (`scripts/stage-remote.mjs`): one
droplet running the same image, its own Postgres and Caddy on
`<ip>.sslip.io`, seeded synthetic data, destroyed by its own tag.

```bash
node scripts/stage-remote.mjs plan --ttl 2h --size s-1vcpu-2gb
node scripts/stage-remote.mjs up --approve-usd 0.10 --ttl 2h
node scripts/stage-remote.mjs test <id>
node scripts/stage-remote.mjs down <id>
node scripts/stage-remote.mjs gc               # destroy expired staging droplets, and only those
```

- It refuses to create anything until `--approve-usd` covers the estimate,
  and never above `STAGING_MAX_USD` (default 1). The sizes are an allowlist;
  s-1vcpu-2gb costs $0.01786 an hour, so a two-hour run is about $0.04.
  Droplets are billed by the second up to a monthly cap, and a spending alert
  does not stop charges: `status` lists what is still billable.
- Droplets carry `mysenam-staging`, `mysenam-stg-<id>` and `expires-<epoch>`
  tags. `down` deletes by its own tag and checks the droplet is gone; `gc`
  deletes only expired staging droplets that also carry a deployment tag.
  Tags are bookkeeping, not a security boundary: the token should belong to a
  separate DigitalOcean team used for nothing else, scoped to
  `droplet:create`, `droplet:read`, `droplet:delete`, `tag:*` and
  `registry:read`.
- `DIGITALOCEAN_TOKEN` and `STAGING_REGISTRY_AUTH` (a read-only registry
  credential) come from the environment's secret store; neither is written
  into the droplet's user data, the record or the logs.

`tests/stage-remote.test.ts` runs it against a stand-in DigitalOcean API.
**It has not been run against DigitalOcean itself**: that needs a token and
an agreed spend.

**Real services** (`scripts/verify-integrations.mjs`): checks each provider
with test-mode or sandbox credentials only, and reports PASS, FAIL, PARTIAL
or BLOCKED (with what is missing) to `artifacts/integrations/`.

```bash
node scripts/verify-integrations.mjs all
node scripts/verify-integrations.mjs stripe --through https://<staging-address>
node scripts/verify-integrations.mjs email --send
```

- Stripe refuses any key that is not a test key before making a call; with
  `--through` it registers a webhook on the staging address, pays a booking
  in the browser with the 4242 test card, waits for the app to mark it paid,
  cancels it and refunds it through the gateway, then deletes the webhook.
- Billplz uses its sandbox only; paying a bill through the app is a step done
  by hand.
- Email checks the sending domain's SPF, DKIM (`DKIM_SELECTOR`) and DMARC
  records and the SMTP login, and sends only with `--send`, to
  `VERIFY_EMAIL_TO`. WhatsApp and SMS send one message each only to
  `VERIFY_WHATSAPP_TO` and `VERIFY_SMS_TO`, numbers the operator owns.
- B2 runs `scripts/verify-offsite.mjs` against the real bucket, with
  synthetic data.
- Every secret the environment holds is masked in anything printed or saved.

`tests/verify-integrations.test.ts` runs it against stand-ins. A provider is
live-verified only when its own run passes with real sandbox credentials; see
[feature status](../product/feature-status.md) for which have.

## Visual acceptance scenarios

```bash
npm run build && npm run uat                       # all of them, against the production build
npm run uat -- tests/uat/matchmaking.uat.ts        # one file
npm run uat -- -t "D:"                             # one scenario, by its title
UAT_SLOWMO=300 UAT_HEADED=1 xvfb-run npm run uat   # watch it, where there is a display
npm run stage -- run --suite uat                   # against a staging deployment
```

`tests/uat/` drives several people at once, each in a browser context of
their own (their own cookies and address, so sessions and rate limits behave
as for different people), through the real pages. Setup that is not what a
scenario is about (an account, a tournament's draw) goes through the app's
API from that person's browser; what it is about goes through the pages.
Every step is logged with who did it and how long it took and ends with a
screenshot; every person's browser records a video and a Playwright trace
(`npx playwright-core show-trace <trace.zip>`). Evidence goes to
`UAT_ARTIFACTS`, or `artifacts/uat/<time>/<scenario>/`, with a
`summary.json` for the run. Courts and hours are taken from what the venue
page offers, so the scenarios run on a fresh database or a seeded one.

| Scenario | What happens |
| -------- | ------------ |
| Booking 1–4 | Booked from the venue page and found under the account; two people racing for one court and hour, one getting it; a cancellation freeing the court; a manager seeing none of another venue's bookings and refused its report |
| Tournament 1–2 | Players enter on the page; one reports a result, the other confirms it to a winner; a disputed result settled by staff; a stranger refused reporting |
| Community | A group started, asked to join, let in, and invited to a private game in one go; the member says yes |
| Matchmaking A | A player's preferences set on the page; the game suggested with its reasons; asked to join from the suggestion |
| Matchmaking B | A request accepted by the host; the player in |
| Matchmaking C | A full game's waiting list; a place freed, held for the next, taken |
| Matchmaking D | An invitation accepted; another withdrawn and then unusable; a link to a private game opened, withdrawn, and then leading nowhere |
| Matchmaking E | A weekly booking made a weekly game; last week's player invited, not enrolled |
| Matchmaking F | A private game invisible to others; only opted-in players suggested; a blocked player turned down; another host refused the roster |
| Matchmaking G | The share shown, paid at the venue (no online payment configured), nothing charged on joining, the court kept when the game is called off |
| Matchmaking H | A host moves a game with two players: the new time previewed with who is in it, proposed and held; one keeps their place, the other leaves, and only then does the game move |

Last run: 14 of 14 against the production build on PGlite, and 14 of 14
against a staging deployment on Postgres 16 with seeded data. Not driven from
a browser: an invitation or held place running out by itself, which needs the
clock moved (`tests/matchmaking.test.ts` covers it); and paying a share
online, which needs a gateway (the gateway legs are the real-service checks).

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
through the same functions the routes call, and prints each as
p50/p95/p99/max milliseconds with the database queries it took, also written
to `mysenam-bench.json` in the system's temporary folder. A booking is timed
from the request, after a free time for it has been found. Last come fifty
bookings at once and a spell of mixed traffic. Places on shared floors go in with the capacity trigger off for that
one insert (they cannot exceed capacity), because checked one at a time they
take hours (see below). The database is kept between runs (drop it to start again);
`BENCH_VENUES` and `BENCH_RUNS` change the size and the repetitions;
`BENCH_WORKERS` and `BENCH_SECONDS` the mixed traffic (16 workers for 20
seconds unless set; the results below used 30).

### Results

Run on 23 October 2026 on this branch: 4 CPUs, 15 GB, Postgres 16.15 on its
default settings (128 MB of shared buffers), the app in the same container.
The data: 404 venues, 2,846 resources, 918,624 bookings each holding its
claim, 829 MB. *Before* is the code before B12–B14 were fixed (twenty runs
of each); *after* is with the fixes (a hundred runs; queries are database
round trips per operation, counted in `src/lib/db.ts`). Milliseconds:

| What | Before p50 / p95 | After p50 / p95 / p99 | Queries |
| ---- | ---------------: | --------------------: | ------: |
| Venue grid, every resource | 102 / 154 | 12 / 18 / 55 | 9 |
| Venue grid, one activity | 87 / 351 | 1.2 / 14 / 16 | 5 |
| Search: badminton in an area, soonest | 667 / 958 | 34 / 56 / 75 | 9 |
| Search: badminton in an area, cheapest | 680 / 856 | 32 / 53 / 65 | 9 |
| Search: near a point, 5 km | 2,392 / 3,709 | 98 / 136 / 155 | 9 |
| Search: a rarer activity nationwide (archery) | 888 / 1,070 | 48 / 63 / 76 | 9 |
| Search: courts counted nationwide | 2.5 / 2.7 | 2.9 / 4.0 / 4.4 | 1 |
| Home: activities by popularity | 201 / 223 | 0 / 0 / 0.1 (cached; the first call each ten minutes still takes about 200) | 0 |
| Home: venue list, first page | 4.7 / 9.4 | 5.4 / 8.0 / 12 | 3 |
| Search page: activities offered | 3.5 / 3.7 | 2.2 / 3.6 / 5.3 | 1 |
| Book a court | 203 / 229 | 12 / 17 / 194 | 14 |
| Book a place on a shared floor | 221 / 342 | 11 / 18 / 156 | 15 |
| Reschedule: free times on a day | 94 / 108 | 12 / 16 / 17 | 20 |
| Daily integrity check | 5,082 / 5,110 | 5,224 / 5,362 (three runs) | 7 |

The p99 of a booking is the first one at a venue after the others: its
pages are not yet in memory.

**Fifty customers booking at once**, each at a different venue: before, 7.8 s,
26 booked, 1 refused, 6 found nothing free and **17 got an error** (a
serialization failure after eight tries). After, 0.35 s: 43 booked, 1
refused, 6 found nothing free, no errors.

**Mixed traffic** (after only): sixteen workers for 30 seconds through a
pool of ten connections, six in ten operations a search, two a venue grid
and two a booking. 83.6 operations a second; search p50/p95/p99 149/217/242 ms, grid
122/181/203 ms, booking 244/336/397 ms; 457 booked, 7 refused, none busy,
no errors, 1 retry and no deadlocks; 12.3 queries an operation. The app
used one CPU core throughout (30.1 s of CPU in 30 s; peak memory 304 MB),
so it, not the database, is the limit on this machine: the database did
30,403 commits and read 2,180 blocks from disk against 26.4 million from
memory.

What was wrong, and what changed ([known limitations](../roadmap/known-limitations.md#fixed-since-the-audit)):

- **Claims were read by time, not by court** (B12): each venue's day read
  every claim in the window across the marketplace (about 20,000 rows and
  88 ms), once per venue. Claims are now read court by court, for all the
  courts asked about in two queries, through indexes on the space or shared
  court and the claim's end (migration 0094); the capacity trigger asks by
  court too. Search also leaves out venues outside the circle before
  reading their courts, and keeps the popularity count for ten minutes.
- **Bookings at different venues conflicted** (B13): wide reads under
  serializable transactions, a scan of every claim to let expired offers go
  before each booking, and eight retries with almost no backoff. See
  [booking concurrency](../architecture/booking-concurrency.md).
- **Bookings racing for one court or coach deadlocked** (B14): now they
  queue on advisory locks.
- The integrity check takes five seconds once a day, which is fine.

Proposed targets, for a launch on one app server and a database of this
size, to be re-measured on the production machine: search p95 under 300 ms
and p99 under 500 ms; a venue grid p95 under 150 ms; a booking p95 under
400 ms and p99 under 1 s under mixed load; no errors and no `BUSY` refusals
at 50 simultaneous bookings at different venues; at least 50 mixed
operations a second per app core. On this machine every one is met.

## Documentation checks

`npm run docs:check` runs `tests/docs.test.ts`, which needs no network and
checks that:

- every relative link in `README.md`, `AGENTS.md` and `docs/` points at a file
  that exists, and every `#anchor` at a heading in it;
- every repository path written in backticks in those files exists (paths
  under `src/`, `tests/`, `db/`, `scripts/`, `deploy/`, `docs/`);
- every `npm run <script>` named in them is a script in `package.json`;
- dated audits and research (under `docs/audits/` and `docs/research/`,
  except their `index.md` pages) have their links checked but not their
  paths or scripts, since they describe the repository as it was when written
  ([documentation](documentation.md#history-is-kept-not-rewritten));
- every environment variable the code reads is in
  [configuration](configuration.md), and every one listed there is read by the
  code;
- every route listed in [HTTP routes](../architecture/http-api.md) has a
  `route.ts`, every `route.ts` is listed, and the methods listed for each are
  exactly the ones it exports;
- in [feature status](../product/feature-status.md): every capability is
  named once with a known status and every column filled; everything built
  names its code, and every code path exists (root files included); every
  `IMPLEMENTED_AND_TESTED` row names test files (`.test`, `.e2e` or `.uat`, not
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
demo branch, and by hand. It runs `node scripts/verify.mjs ci` against a
Postgres 16 service: type-check, lint, documentation, the suite on PGlite and
again on Postgres, the build, and the end-to-end tests against that build,
and keeps the run's report as an artifact. It
skips changes that touch only Markdown, so
`.github/workflows/docs.yml` runs the documentation checks on those (and on
every other pull request) instead.

Both run on `ubuntu-24.04`, pinned: `ubuntu-latest` moves to Ubuntu 26 from
October 2026, and the browser install and the Postgres service are only known
to work on the image they were written for.

**Not running since 16 October 2026.** Every job since then has been refused
before a runner was given to it, in about three seconds, with no log: the
check run's annotation reads "The job was not started because an Actions
budget is preventing further use". The repository is private on a personal
account, so its jobs spend that account's included Actions minutes, and a
budget set to stop usage stops them once the minutes are gone. Nothing in the
repository can change that. The account owner, on GitHub: **Settings →
Billing and licensing → Budgets and alerts**, edit the Actions budget to raise
its amount or clear *Stop usage when budget limit is reached* (with a payment
method on the account); or wait for the included minutes to reset at the
start of the next billing cycle. Then re-run the latest CI run from the
Actions tab. Until a run passes, CI is not evidence of anything; the suites
are run by hand (above) and reported with each change.
