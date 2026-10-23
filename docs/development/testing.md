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
in with their own; a signed-in request from another site refused. Each
roadmap batch adds the journeys it changes (see the
[roadmap](../roadmap/roadmap.md#delivered)).

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
- every source and test path in [feature status](../product/feature-status.md)
  exists, every capability there has a known status, every
  `IMPLEMENTED_AND_TESTED` row names a test file, and the summary counts match
  the rows.

They are part of `npm test` too. Checked by hand, because no script can:
that each authoritative document still describes the code; that statuses
reflect real verification; that external links are alive (no network is
used).

It cannot check that documented *behaviour* is true: that a route exists says
nothing about what it does. That is what the feature tests and review are for.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests, on pushes to `main` and the
demo branch, and by hand. It type-checks, runs the suite on PGlite and again
on Postgres 16, builds, and runs the end-to-end tests against that build. It
skips changes that touch only Markdown, so
`.github/workflows/docs.yml` runs the documentation checks on those (and on
every other pull request) instead.
