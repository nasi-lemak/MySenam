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

The Postgres server the suite runs against needs `max_locks_per_transaction`
of 256 or more (the deployment kit's setting,
[`deploy/digitalocean/postgresql.conf`](../../deploy/digitalocean/postgresql.conf)):
files run side by side, each in its own database, and the backup tests'
restores lock every table, index and sequence at once, so the default of 64
runs out of shared memory (`ALTER SYSTEM SET max_locks_per_transaction = 256`,
then restart the server).

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

## Checking a change, and releasing

One runner does the same checks on a developer's machine, on the AI development
VM and on a staging machine: `scripts/verify.mjs`. **Release verification is
done on the AI VM, with this runner. GitHub Actions does not run it** (see
[GitHub Actions](#github-actions-manual-only)): nothing is started by a push.
Use the targeted commands while developing, and the release profile at a
release checkpoint, not after every edit.

```bash
npm run verify -- fast                 # typecheck, lint, the tests touched by uncommitted changes (about 30 s)
npm run verify -- fast tests/games.test.ts
npm run verify -- pg                   # the suite on Postgres only
npm run verify -- e2e                  # browser tests; builds only when the source digest changed
npm run verify -- uat                  # the visual acceptance scenarios (below)
npm run verify -- uat "C:"             # one scenario, by its title
npm run verify -- full --pg docker     # everything below except the acceptance scenarios: a checkpoint, never a release
node scripts/verify.mjs release --pg docker   # THE RELEASE PROFILE (below)
node scripts/verify.mjs check          # is the newest release report still true of this checkout?
```

### The release profile

`node scripts/verify.mjs release --pg docker` runs, one after the other (never
two builds or suites at once), and every step even after one fails, so the
report says everything that is wrong: **type-check, lint, documentation checks,
the whole suite on PGlite, the whole suite on PostgreSQL 16, a fresh production
build (`.next` is removed first), the browser end-to-end tests, and every
acceptance scenario (UAT)**. `ci` is another name for it.

A step passes only when its process exited 0, no test or test file in it
failed, it ran tests, and nothing was skipped that
[`scripts/lib/expected-skips.mjs`](../../scripts/lib/expected-skips.mjs) does not
allow: on PGlite only the Postgres-only tests listed there (15 tests in 8 files,
which must then run on Postgres); on Postgres, the browser tests and the
acceptance scenarios, **nothing**. A process that is killed, runs past its time
limit (type-check 25 minutes, the suites 90, the build 40, the acceptance
scenarios 120) or crashes fails; so does an interrupted run (Ctrl-C or SIGTERM
write a report that says so). **There is no retry.** A test that failed in a run
failed in it; a later rerun of that test is a separate fact (record it as a
targeted rerun) and never changes the report, which stays FAIL until a complete
run passes.

**PostgreSQL is mandatory.** `--pg docker` (the default) starts a throwaway
`postgres:16-alpine` container on a free loopback port with a random password,
labelled `mysenam.purpose=verify` and removed when the run ends however it ends;
`TEST_DATABASE_URL` or `--pg <url>` names another server. A server that is not
on this machine, is the one `DATABASE_URL` names, or is not PostgreSQL 16 is
refused, and the report records the server version and how many transactions
the suite committed on it (a pass with almost none fails: Postgres was not
really exercised). With no Postgres and no Docker the run is **BLOCKED** (exit
3), never PASS.

The report, `artifacts/verify/<commit>-<time>.json` (the steps' logs and raw
vitest results are beside it, in a folder of the same name; `artifacts/` is not
committed), records: the commit, whether the tree was dirty, the digest of the
exact source tested **taken before and after the run** (a change during the run
fails it), Node, the machine (CPUs, memory, free disk), each step's result,
duration, exit code and test counts (PGlite and Postgres apart; passed, failed,
skipped, and each failure), the Postgres server used, a **list of every
provider that was not exercised** (Billplz, Stripe, SES, WhatsApp, SMS,
Backblaze B2, MyInvois, Xero, Google, ClamAV: the tests use stand-ins; each is
verified separately, with the command named in the report), and the verdict:
**PASS** (exit 0), **FAIL** (exit 1) or **BLOCKED** (exit 3).

**A release is verified only when** every mandatory step above passed; Postgres
was exercised; the build succeeded; the browser tests and the acceptance
scenarios passed; no unexplained skip remains; the tree was clean (a release is
of one commit); and `node scripts/verify.mjs check` says the report's source
digest is the checkout's. Any change to the source after a verification, a
documentation change included, invalidates it. The one exception is the release
record: a commit after the verified one that changes only this file
(`docs/development/testing.md`) leaves the verification standing (`check`
accepts it). Automated tests passing is **not** production readiness: the
providers above, and every item in the
[launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove),
need their own real-service checks.

#### Reproducing a verification on the AI VM

```bash
git status --short                       # must be empty: commit first
sudo dockerd >/tmp/dockerd.log 2>&1 &    # only if `docker info` fails; the image postgres:16-alpine must be present or pullable
docker info >/dev/null && echo docker-ok
node scripts/verify.mjs release --pg docker      # about 1½ hours on 4 CPUs / 16 GB; the exit code is the verdict
node scripts/verify.mjs check            # VERIFIED / NOT VERIFIED for the checkout
```

One acceptance scenario (*Accounts AG*, `tests/uat/round7.uat.ts`) books the next hour of the day at the venue and invoices it, and from 23:00
Malaysian time there is no such hour (an account is invoiced for what is dated up to today, and nothing is booked in an hour already begun). The
release profile therefore waits, idle, from 22:15 until just after midnight there before it starts the acceptance scenarios, and the report records
the wait (`waitedForMidnightSeconds`); run by hand, start the scenarios outside that time.

The build and the type-check need a 4 GB Node heap; the runner sets
`--max-old-space-size=4096` for every step (Node's default of about 2 GB ran
out on 6 November 2026), and the machine needs about 6 GB of memory and 3 GB of
free disk (the runner is BLOCKED without them). The preflight also reads how full the disk is: it warns at 80% and, at 95% or more, notes the build, the browser tests and the acceptance scenarios BLOCKED with the reason and ends BLOCKED (the same `MYSENAM_DISK_WARN_PERCENT` and `MYSENAM_DISK_BLOCK_PERCENT` the application's disk alert reads; a full disk once crashed a restore test on 7 November 2026). The AI VM's writable disk is a fixed allowance: old `artifacts/uat/` folders and merged agent worktrees are removed by hand, never with a blanket prune.

Postgres is `TEST_DATABASE_URL`, `--pg <url>`, or else the throwaway container
described above.

### Staging and real services

The suites are hermetic: `tests/setup-env.ts` removes every provider credential
and address from the environment they run in (email, SES, WhatsApp, SMS, payment
gateways, off-site and photo storage, MyInvois, Google, alert webhooks), and the
browser suites' server is started without them, so a cloud session that holds
real test credentials for the checks below cannot have a test send a message or
upload a file; a test that needs one sets it for itself.

The real-service checks (`scripts/verify-integrations.mjs`) read their test
credentials from the environment's secret store and print none of them. The
`email` check uses Amazon SES over HTTPS when `SES_ACCESS_KEY_ID`,
`SES_SECRET_ACCESS_KEY`, `SES_REGION` and `MAIL_FROM` are set (it reads the
account, the sender's identity and its DKIM where the key may, and with `--send`
sends one message to `VERIFY_EMAIL_TO`), otherwise SMTP, which is refused from
the cloud environment the checks run in. The domain's SPF and DMARC records are
read over DNS over HTTPS there, since raw DNS is refused too; a lookup that could
not be made is reported as such, never as a missing record, and two DMARC
records are a failure (a receiver ignores both).

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
page offers, so the scenarios run on a fresh database or a seeded one. A
person is on a laptop (1280 × 860) unless the scenario puts them on a phone
(390 × 844) or a tablet (820 × 1180), touch screens both; on those, each page
is checked to fit the screen without scrolling sideways (`fitsScreen`).

| Scenario | What happens |
| -------- | ------------ |
| Booking 1–4 | Booked from the venue page and found under the account; two people racing for one court and hour, one getting it; a cancellation freeing the court; a manager seeing none of another venue's bookings and refused its report |
| Tournament 1–2 | Players enter on the page; one reports a result, the other confirms it to a winner; a disputed result settled by staff; a stranger refused reporting |
| Tournament 3 | A manager sets up a competition and two divisions from the badminton template on the dashboard; another venue's manager can neither see nor run it |
| Tournament 4 | Players enter two divisions; the organiser closes entries and makes the draws; the public fixtures are checked for court and player clashes and against what is on sale |
| Tournament 5 | The front desk and an official's link enter results; winners reach the final, losers the third-place match, and the tournament finishes |
| Tournament 6 | A semi-final corrected after the third-place match was played: reviewed, kept on the record only, the tournament under review, finished only once the organiser lets the results stand |
| Community | A group started, asked to join, let in, and invited to a private game in one go; the member says yes |
| Matchmaking A | A player's preferences set on the page; the game suggested with its reasons; asked to join from the suggestion |
| Matchmaking B | A request accepted by the host; the player in |
| Matchmaking C | A full game's waiting list; a place freed, held for the next, taken |
| Matchmaking D | An invitation accepted; another withdrawn and then unusable; a link to a private game opened, withdrawn, and then leading nowhere |
| Matchmaking E | A weekly booking made a weekly game; last week's player invited, not enrolled |
| Matchmaking F | A private game invisible to others; only opted-in players suggested; a blocked player turned down; another host refused the roster |
| Matchmaking G | The share shown, paid at the venue (no online payment configured), nothing charged on joining, the court kept when the game is called off |
| Matchmaking H | A host moves a game with two players: the new time previewed with who is in it, proposed and held; one keeps their place, the other leaves, and only then does the game move |
| Phone 1 | On a phone: the home and venue pages fit the screen; a court booked with a tap and found on the account page |
| Tablet 1 | A venue's manager on a tablet finds an open game's booking on its day, changes its time and gives the reason; the player, on a phone, is told why and confirms; the host sees the game at its new time |
| Staff 1 | A manager is offered English, Malay and Chinese on the dashboard (not Tamil), picks Malay, is refused a wrong password in Malay, signs in to Malay tabs, and switches to Chinese still signed in |
| Venue 1 | A venue signs up at `/list-your-venue` (an install that sends no email opens the account at once), follows the set-up checklist (a court and its rates, its hours), asks to go live; the owner ticks the checks and approves; a customer books through the booking link; the operator finds it on its day. Runs only where the install is a marketplace |
| Change time 1 | A customer changes their booking's time from *My booking* (same code, a free hour); the account page and the venue's day list show the new time |
| Change time 2 | A time taken meanwhile by someone else is refused and the booking stays; inside the venue's cut-off no time is offered and the panel says why |
| Change time 3 | The venue's manager changes a customer's booking time from the dashboard, through the preview; the customer's account shows the new time |
| Participants A | A parent adds two children and applies for each; staff approve one. Each child's status stays their own on the approvals page, the booking form (one refused by name, one booked) and the door (one through to payment, one asked for his own sign-off); the day list names each child, booked by the parent |
| Participants B | A guardian books a child, may not queue for themself without a sign-off, queues both children for a full lane; one's approval is taken back; the freed place goes to the child still eligible, is claimed and booked for her, never the parent |
| Participants C | The front desk registers a walk-in's child at the counter; booking her is refused, naming her, until she has her own sign-off, which the desk may not grant (safety assessment) and a manager does; the desk books her; the activity log shows who registered and booked her, for whom, on whose number |
| Participants D | Search for an activity needing approval: anonymous and nobody-chosen show the requirement only; each child, both together, and the parent each show their own statuses, never "approved" while one is not; the venue grid follows; signing out forgets the choice |
| Documents E | A parent's certificate waits for its scan and cannot be opened or approved; once released the reviewer downloads it unchanged and approves; a file the scan refuses cannot be opened by any path or approved. Uses a scanner stand-in, not ClamAV, so it is skipped against a deployment |
| Participants F | On a phone: add a child, apply, read the approval, choose her on search, book her; every page fits, controls are within reach (24px targets) and text is readable |
| Guardians G | The front desk starts a request for an adult at the counter; a single-use code for his own account; nothing about the child reaches him (people, form, search, booking, applying) before or while pending; the existing guardian is emailed (child, what, when, how to report, the venue; never who) and agrees online; a stranger she refuses gets nothing; a change she reports is paused by a manager and booking stops |
| Guardians H | A second guardian sees the child approved on the first guardian's application and books for her; he cannot see or download that application or its certificate |
| Documents I | Scanner away: the certificate waits unopened and unapprovable, and the owner's panel says the scanner does not answer; a working scanner that cannot scan fails a document; the owner rescans it with a reason (still failing, then passing), each retry on record; the reviewer opens it unchanged. Uses the scanner stand-in; skipped against a deployment |
| Recovery J | The retention review is refused until reviewer, role, firm and written-advice reference are given; it is shown as the owner's record, not verified by MySenam, with the rest still provisional; the privacy notice says the same; changing a period lapses it. The ledger and restore gate are script-tested (`tests/erasure-ledger-restore.test.ts`) |
| Places K | One child taken off a pool session sold by the place: the other stays booked, RM10 less owed, the place offered to the waiting list and claimed, an email names who is off; the last one left and a session sold whole are refused with reasons |
| Places L | One child's concession on her place alone (the form offers no code on top), the receipt adds up; the counter checks her proof only and remembers it for 12 months, so the next booking does not ask; asked twice, refused |
| Email 1 | A booking's confirmation email is read from the server's log and its link opens My booking with nothing typed, showing that booking and its weekday date |
| Email 2 | A waiting-list offer's emailed link claims the place, the claimed booking's confirmation follows, and the spent link then says *Offer unavailable* at once and a claim is refused; meanwhile the held place is refused to the person who gave it up |
| Email 3 | A password-reset email's link sets a new password once; the old password is refused and the link then shows it has run out |
| Email 4 | Signing up through the pages: the form answers *check your email*, the emailed link makes the account once; a stranger typing the same address sees identical text, and the address is sent a notice with no link |
| Discounts M | A manager allows a code with a concession and makes one that combines; one child's junior price and the code on a booking for three: each place's share, the counter and the receipt add up; a code that does not combine is refused (`STK_NOT_COMBINABLE`); with the setting turned back the form takes the code away and the API refuses it (`ONE_DISCOUNT`), the booking standing at the concession price |
| Passes N | Each child's own pass chosen for her place on the booking form, and at the counter's payment step for another booking; balances fall one entry a place, the receipt shows the places paid by pass, and one child taken off gives back only her entry |
| Membership O | A child's own membership and a family one bought online through the Billplz stand-in: price and dates first, nobody a member until paid, the receipt naming the child; the child books a members-only session; whom the family membership covers taken off and added back, using the plan's one replacement for the term. Skipped against a deployment |
| Guardians P | A child registered at the counter on her mother's name and number; another adult asks; the desk sends the mother a code (read from the server's log), she reads it back and the request completes; later she registers, proves her number and takes her relationship over with a staff code. Runs on a second server of its own with phone checks on; skipped against a deployment |
| Access Q | A private venue's resident added by a typed number is refused online; linked to his account in the access editor he books; unlinked, refused again |
| Waitlist R | The desk queues two callers for a full class, one to be told in Malay; the first caller's number is refused meanwhile and passed over without a message; the offer email goes in Malay and she claims the place |
| Competition S | The desk enters a walk-in in a tournament at the counter; a guardian enters her child in a box league; staff decide a disputed result and both sides are emailed it; a confirmation of a result changed meanwhile is refused, then made on the new one |
| Guests T | A private venue's resident invites two guests by email, one with an account and one without: the same words on screen, the same list status and the same email (but for its link) for both; the one with an account, on a phone, follows the emailed link signed out, signs in, accepts and books the pool; the resident's list then shows her linked and the other invitation still sent |
| Coaches U | A manager gives a lesson paid in cash to a dearer coach: both fees shown first, no time offered until *keep* or *adjust* is chosen; adjusted, the RM20 owed is taken at the counter on a receipt of its own. The front desk is refused giving a lesson paid from credit to another coach; the manager gives it to a cheaper one, RM20 back to the customer's credit with a credit note on her receipts and an email. The customer moves a lesson on *My booking*: told it keeps its coach, offered none other, and it does |
| Coaches V | A manager sets *the venue assigns a free coach* under Classes; on a phone, a customer sees one *Book a tennis lesson* in place of each coach's link, the range of fees, books 10 AM by time and is told her coach (the one free then); booking a coach by name is refused (`LESSON_VENUE_ASSIGNS`) |
| Membership W | On a phone, a parent chooses her child for a members' session next month: the form says the child's membership ends before it, with a link to renew, and booking is refused with the same reason; she renews through the Billplz stand-in (from the day after it ends) and books. A manager cancels the membership the counter sold: the session today is listed under *Bookings to decide*, the one next month is not; the check-in code is refused; the desk is warned and declines; a manager admits her with a note, kept in the activity log, and marks the flag done. Skipped against a deployment |
| Family X | On a phone, a mother buys a family plan for two (no replacements) through the Billplz stand-in, takes one child off and is told no place is left this term for anybody new (the API refuses one, `MBO_NO_PLACES_LEFT`); she buys the next term naming the new list; a manager corrects a child entered wrongly, with a reason, using no place, each change in the membership's history. Skipped against a deployment |
| Places Y | A mother pays a 50% deposit through the Billplz stand-in on three children's pool places (RM30); taking one off says, before she confirms, RM10 less to pay; the next, RM5 less to pay and RM5 of the deposit back to the card it was paid with; the booking ends at RM10 with RM10 of deposit. Skipped against a deployment |
| Malay Z | A customer switches to Bahasa Malaysia and books 11:00 to noon; the confirmation email is in Malay with `11:00 PG hingga 12:00 PTG` and no AM or PM, and its link (`lang=ms`) opens *My booking* in Malay in a browser that never chose it |
| Invitations AA | A private venue's resident invites a guest by email and withdraws it after a confirm: the guest stays listed, *Invitation withdrawn*; the guest, on a phone, is emailed a notice naming neither who nor why, and her link, accepted signed in, gets word for word the answer a link that is no good gets (`GUEST_INVITATION_INVALID`, as one run out; running out itself needs the clock moved) and she still cannot book; the front desk is refused withdrawing another (`MANAGER_ONLY`), a manager withdraws it from the list with a reason, kept in the activity log |
| Invitations AB | A game's host invites a player by email and withdraws it after a confirm: the roster reads *Invited by email: withdrawn*; the player, on a phone, is emailed a notice and her link is refused (`PLAYER_INVITATION_INVALID`); a group's organiser does the same from the group's page, with the same refusal |
| Coaches AC | A manager gives a lesson paid in cash to a dearer coach and adjusts the price, told the customer may also pay online; the day shows RM20 outstanding. On a phone, signed out, the customer opens the coach-change email's link and pays RM20 through the Billplz stand-in; *My booking* shows it paid online with a receipt of its own (RM20, not the lesson's), she is emailed the receipt (queued, sent when the outbox next runs), the staff row says *paid (Online…)* and the day collects RM120 with nothing outstanding. A second lesson's difference, with no page open, is taken in cash at the counter, and its emailed link then shows it paid at the venue. Skipped against a deployment |
| Suspension AD | The front desk is refused suspending a membership (`MANAGER_ONLY`); a manager suspends it for the coming week, from today (the desk checks a booking in only in the hour before it), with a reason, her booking within the hour flagged; the member's account page (a phone) shows the suspension, she is emailed the venue's reason (queued, sent when the outbox next runs), the form says she is suspended on a session's date and booking is refused because she is suspended today (`MS7_OWN_SUSPENDED`), not asked to join; the flagged booking is under *Bookings to decide*; the desk is warned at check-in and declines; the manager reactivates with a reason and she books |
| Times AE | A manager reads a 6 PM booking as `6:00 PM – 7:00 PM`, switches to Malay (`6:00 PTG – 7:00 PTG`, the schedule headed `6 PTG`, `9 PG`, the activity log's time `… PG` or `PTG`), then Chinese (`下午6:00 – 下午7:00`, `下午6`, `上午`/`下午` in the log); a customer opening `?lang=ms` in a fresh browser gets *My booking* in Malay and the next page, without `?lang`, still in Malay |
| Credit AF | On a phone, a customer with RM200 of credit books a lesson on the coach's page, ticks *Pay from my credit balance*, and is told *Paid from your credit balance*; the lesson is paid and RM100 is off her credit |
| Accounts AG | A school's account with RM10 of credit (a place taken off after invoicing) is closed after a confirm and stays listed, marked closed, with *Paid back by hand* the only action; the desk is refused recording it (`MANAGER_ONLY`); the manager records it with how it was paid back, and the account leaves the list, in the activity log |
| Counter AH | A manager turns on *Manager overrides* for the house rules' limits; with one booking at a time allowed, the front desk booking a number that has one at the counter is refused in the counter's words (`R9_DESK_LIMIT_UPCOMING`) and told to ask a manager, with no override; the manager is offered *Override for this booking*, gives a reason and books; the Bookings tab shows *Overridden by … Why: …*, and the activity log has it; a blocked number is refused even for the manager (`R9_DESK_PHONE_BLOCKED`), with no override offered |
| Counter AI | The desk takes one booking in cash and one by QR and cancels the cash one: the panel shows what was paid, how and the venue's terms; RM20 handed back from the till is listed with its credit note and the desk's name, and the desk's cash-up reads Cash RM20 / −RM20 / RM0, QR RM20, RM40 / −RM20 / RM20 in all |
| Prices AJ | The desk is offered no *Adjust price*; a manager lowers RM20 to RM15 with a reason, a RM5 credit note in cash among the customer's receipts and in the cash-up; a later cancellation hands back only the RM15 left; the change is in the activity log |
| Late AK | A manager lets courts be given back after the cutoff; a customer on a phone gives back tomorrow's paid court after its exact confirm text, told nothing is refunded; somebody else books the hour |
| Links AL | A booking made on a phone; the email's link opens My booking on another device with nothing typed, keeps it on a refresh (the address never holds the phone) and cancels from there; the link with another booking's code shows nothing |
| Waitlist AM | Two people queue on the grid, each emailed a leave link; the freed place offered to the first, who leaves from the email; it passes at once to the second, who claims it; the leave link then does nothing |
| Alerts AN | A manager sets alerts to an inbox in Bahasa Malaysia for cancellations within a week; the desk's cancellation is not announced, the customer's online cancellation brings exactly one Malay alert with who, the number, where, the weekday date and the code |
| Classes AO | The desk is refused changing a class's instructor; the manager changes it for four sessions; the classes page shows only the new instructor and the change is in the activity log |

The acceptance server runs as a marketplace (`MYSENAM_MARKETPLACE=on`, in
`tests/uat/setup.ts`), since only a marketplace has `/list-your-venue`; a
staging deployment that is not one skips *Venue 1*. It also points
`MYSENAM_CLAMD` at a stand-in on the loopback (`tests/uat/scanner.ts`): it
speaks clamd's protocol, refuses the EICAR test string, and holds a document
marked `UAT-HOLD-SCAN` until the scenario releases it, and takes
`UAT-MODE up|down|error` to stop answering or to fail every scan (Documents
I). It is not ClamAV and
proves nothing about the engine (`tests/document-scanning-engine.test.ts`
does); it is not used against a deployment, nor where `MYSENAM_CLAMD` is set,
and *Documents E* and *I* are then skipped, as are *Email 1–4*, which read the emails from the acceptance server's log; against a deployment `scripts/stage.mjs` follows the app's output into `UAT_SIGNUP_LOG`, so that the scenarios' sign-up step (`signUp` in `tests/uat/harness.ts`) can read the link it sends. The server also loads a stand-in for Billplz's sandbox
(`tests/uat/gateway.ts`, loaded by `tests/uat/gateway-preload.mjs`): it answers
the collection check and bill creation, serves a payment page, and sends
Billplz's signed callback and redirect. It is not Billplz and proves nothing
about the live service; *Membership O*, *Membership W*, *Family X*, *Places Y*
and *Guardians P* are skipped against a deployment, as are *Guests T*,
*Malay Z*, *Invitations AA* and *AB* and *Coaches AC*, which read emails from
the server's log. *E-invoice states* on the staff screen have no scenario:
turning e-invoicing on needs MyInvois credentials, a document reaches a state
only by being sent to LHDN, and there is no MyInvois stand-in, so showing one
would be a live call to LHDN's sandbox. The app's output is kept as
`server.log` beside the evidence (`E2E_SERVER_LOG`); the server sends with
`MYSENAM_SEND=log`, so that file is where scenarios read the emails sent.

The venue guide ([venue guide](../features/venue-guide.md)) has nine scenarios in
`tests/uat/guide.uat.ts` (*Guide A* a small badminton venue set up from nothing
by its operator, a test booking, the manager's playbook, the venue made live and
its public prices and hours read, a phone, the print view and a "?" from the
keyboard; *B* a multi-sport centre with a linked pitch and prices of different
kinds; *C* a coaching academy and a coach's own guide), `guide-venues.uat.ts`
(*D* an established venue shown what it has and changed in nothing; *E* a branch
started from another's set-up with a guide of its own and nothing private
carried; *F* a manager and a front desk on a phone, the desk refused by the
routes and by the address) and `guide-changes.uat.ts` (*G* prices and hours set
from a later date, in the playbook beside today's; *H* an unsupported capability
on the public guide in English and Malay and in Discover; *I* a counter-only venue
and then online payment through the sandbox stand-in, which is Billplz-sandbox-like
and not Billplz). The venue is signed up on the real form, so *A*, *B*, *C*, *E*,
*H* and *I* are skipped against a deployment that is not a marketplace; *D*, *F*
and *G* use venues the owner made. Shared steps are in `tests/uat/guide-support.ts`.

Teams and leagues of teams ([teams](../features/tournaments.md#teams),
[team leagues](../features/tournaments.md#team-leagues)) have six scenarios. `tests/uat/teams.uat.ts`
has *Teams 1* (a captain starts a team on the page, brings people in by a shared
link and by an email read from the server's log, and the same words refuse an
account that has said it is under 18, one across a block, another account on the
emailed link and a link already used; a child goes on only through a guardian,
the captain's own or another's by that guardian accepting, and is "a junior
player" to every other member and to the public; the team is 404 until the
captain publishes it and then shows its name only; captaincy is handed over and a
member leaves, each told by email), *Teams 2* (starting a team and inviting by
email with the keyboard alone: focus order, labels, a too-short name held back,
the answer announced) and *Teams 3* (a captain enters a tournament as the team,
a member outside the age range refused by name and range, one who has not said a
date of birth refused and then saying it on their own phone, the typed team and
roster still working beside it, no member on the public page).
`tests/uat/team-leagues.uat.ts` has *Team league 1* (a manager sets a season up
on the dashboard from the badminton template, three captains on phones enter,
one with a date it cannot play and one with a home court, the fixture list is
made home and away with a bye each night, the club's own booking page shows each
fixture's court taken and the manager's move taking the old hour back, lineups
shown to each side only until a result is in, a result reported by one captain and
confirmed by the other, the table and the public page naming teams and no player,
and the front desk shown no move or forfeit button and refused by the server),
*Team league 2* (a reported result disputed and decided by the front desk, staff
and captains emailed) and *Team league 3* (a forfeit requested, nothing changing
in the table, the fixtures or the court's time; the front desk seeing the request
and refused every way to confirm it; the manager confirming it, with the table,
the fixture, the released court time and both captains' emails, and declining a
second with its reason). Only a fixture dated today can be reported, so each
league's first match night is today. All but *Teams 2* read the emails from the
server's log and are skipped against a deployment; the helpers are in
`tests/uat/teams-support.ts`.
*Climbing A* (`tests/uat/climbing.uat.ts`; [counted performances](../features/tournaments.md#counted-performances) and
[officials](../features/tournaments.md#officials-and-counted-results)): a manager's bouldering event (the counted template) drawn into two groups with a
junior entered by her guardian; an official's link opened on a phone, no account, taps the judge's grid (+, Z, T, one boulder at a time), overwrites a
line (kept on the page and in the log), and is refused another event's round, a finished round's counts, any other action and every dashboard route;
the manager puts one of two climbers level for the final's last place into the final; the official enters the final; the public page (a phone) shows
tops, zones, attempts and each boulder's tops, the junior as *Aina L.*; the official sends a correction request that the manager previews and applies
against its token (the desk refused by the server), then, after the event has finished, another (refused when it would change who was in the final,
and declined with a reason the official sees) while counts are refused (`OFC_EVENT_FINISHED`). The link's ending after seven days needs the clock moved,
so day 8 is covered below the browser (`tests/official-climbing.test.ts`). *Ladders A* and *B* (`tests/uat/ladders.uat.ts`;
[club ladders](../features/tournaments.md#club-ladders)): a ladder set up on the dashboard and joined on phones; a challenge accepted holds no court
(the booking page and the availability still offer it), is booked on the ordinary page and the booking's code added, the booking cancelled and both
players emailed; reported, confirmed, ranks moved; in every state (pending, accepted, with a booking, reported, declined) the public page and its API show
no challenge; a freeze; a manager's move refused without a reason and kept with one (the desk refused); and a junior ladder entered by guardians shows
short names and no contact. *Rankings A* and *Names D* (`tests/uat/rankings.uat.ts`; [ratings and rankings](../features/tournaments.md#ratings-and-rankings),
[minors' names](../architecture/privacy.md#minors-names-on-public-pages)): a tournament and a box league marked rated before they start and played through
the pages; the public rankings a 404 until published, then only declared adults who chose to be listed (a child, and a player who did not choose, never),
the provisional section apart and without ranks, the venue's number (3 to 30) re-classing players without changing a rating, a player's own page with each
result explained, a result left out and the rating replayed, the ledger downloaded, the desk shown nothing, and unpublishing; and a guardian authorising a
child's full name for one event after the wording, the public page then showing it, and withdrawing it (a manager and another account cannot). The
authorisation's ending with the event needs the clock moved and is covered in `tests/public-names.test.ts`. They sign people up from the server's log as
the others do, and *Ladders A* reads the cancellation emails only where that log can be read; their shared steps (and browserless people, since closing many browser contexts is slow) are in `tests/uat/uatc-support.ts`.
The tournament formats ([tournaments](../features/tournaments.md)) have three
scenarios in `tests/uat/formats.uat.ts`, each with a venue of its own, its
manager as the organiser on the dashboard, players on their phones, and the
public page: *Formats A* a double elimination set up on the form (the losers'
bracket, grand final and reset lengths; the reset on), six entries, a first-round
loss that drops a player into the losers' bracket and shows him on his phone
where he plays next, the public bracket page fitting the screen with each
bracket scrolling inside its own section, a first-round result corrected after
the winners' route has moved on (refused as a plain result, reviewed, kept on the
record only, an issue for each of the two routes) and both routes replayed
together at a court and time given, the reset appearing only once the losers'
champion has won the grand final, and the final places listing everybody; *Formats
B* a knockout with a consolation draw (the first-round losers' own final, nobody
with a bye in it), then the advanced feed-in option, whose consequences (main and
consolation matches, court hours, the held time) are shown first and which is saved only
after *Confirm* (the form will not send without the tick, the server answers
`FEED_IN_CONFIRM` without it), a draw the held time cannot hold refused with its
reason and nothing changed, and a whole event of eight played with everybody placed;
*Formats C* a Swiss event of five (the recorded seed, round 2 paired by itself with no
rematch and the bye to the lowest-ranked player without one, the standings ranked by
points and the published tie-breaks on a phone, a first-round correction that offers
*Pair the next round again* or *Keep the pairings* while round 2 has no result and
refuses the first once it has one, a round closed with a match neither side came to,
round 3 paired with nobody meeting twice, and the final table). The seed is recorded
but not shown on any screen, so it is read through the API. Shared steps are in
`tests/uat/formats-support.ts`. The scenarios run several minutes each on a busy
machine (a file-level `vi.setConfig` lengthens the timeout; the evidence's traces
take a long time to write).

`tests/uat/tournament-day.uat.ts` has *Day 1*, tournament day as an organiser,
the front desk, players, a customer and the public meet it. A tournament has to
start after today, so its day can never be today on the acceptance server, and a
browser cannot move a server's clock: the scenario runs on a second server of its
own (`tests/uat/day-support.ts`, the same build and in-memory database, skipped
against a deployment) into which `tests/uat/day-clock.mjs` is loaded to move that
one process's clock. It makes and draws the tournament for tomorrow with the real
clock (a child entered by her guardian, seeded so that she plays in the second slot),
then sets the clock twelve minutes before the first match; everything after runs at
the real speed. The customer's booking page shows the held hour as unavailable and
a booking over it is refused, before and after fixtures are brought forward; the front
desk reads the board, checks players in, and has no button (and is refused by the
server, `MANAGER_ONLY`) to call or to decide; the manager calls the first slot's
fixtures ahead of their time, the desk enters a result, the next fixtures are
announced once to each side (read from the server's output after the venue's messages
are opened, which runs the outbox, since the scheduler is off): the child's notice to
her guardian opens *This entry is for Aina Binti Lim.* and her opponent is told
*Aina L.*, never the full name; the manager calls the child's fixture to the court the
result freed; the one-minute wait for players runs out in real time (the desk sees it
and has no buttons); the manager swaps in the next ready match, waits again, and gives
a match to the player who came (a walkover, nobody taken out); the public live page on
a phone shows courts, next and recent results with the child as *Aina L.* and picks
the walkover up by itself; and nobody is told twice. The day's own clock is a
stand-in for the real one and proves nothing about a deployed scheduler (a minute
announcement by the scheduler is covered by `tests/tournament-day.test.ts`).

Last run: see the newest [release record](#release-records); 14 of 14, before
scenario H was added, against a staging deployment
on Postgres 16 with seeded data. Not driven from
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

## GitHub Actions: manual only

GitHub is for source control. `.github/workflows/ci.yml` and `docs.yml` start
**only by hand** (`workflow_dispatch`, from the Actions tab), never on a push
or a pull request, and they are not a required check for merging (and must not
be made one). Until 6 November 2026 they started on every push to the demo
branch (hundreds of runs, the CI job about half an hour each), which spent the
account's Actions minutes on checks that the AI VM does for nothing. Release
verification is [the release profile above](#the-release-profile), run on the
VM; the manual CI job runs the same profile for the exceptional case that the
VM cannot be used, and costs billed minutes when it is.

## Release records

What was run on the commit a release is cut from, by hand, on one machine.
A check not listed was not run; a real-service check is listed only if it ran
against the real service.

#### 24 October 2026, commit `d7060e0`

Not a launch: the record of the round of work that went through
[known limitations](../roadmap/known-limitations.md#every-open-limitation-by-kind)
(90 entries at `b9666dc`, 78 at `d7060e0`, no defect open). Run on one cloud
container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 96 passed |
| Suite on PGlite | 196 files; 2235 passed, 1 skipped (a Postgres-only test) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 196 files; 2236 passed |
| Build (`npm run build`) | Succeeded, after the last change to `src/` and `db/` |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), desktop, phone and tablet | 5 files; 17 passed |
| CI | Not run (deferred, above) |
| Real services: payments, messaging, MyInvois, Google sign-in, off-site storage | None checked; each stays `INTEGRATION_VERIFICATION_REQUIRED` |
| Remote staging, restore of a production backup | Not run |

The one change between `d7060e0` and the commit adding this record is in a test: `tests/backup.test.ts` set its
fake clock to dates the real clock had passed, and PGlite's Postgres, reading
the same clock, re-armed a timer every millisecond (17,232 Node
`TimeoutOverflowWarning`s in the PGlite run, none on Postgres). Its dates now
lie ahead of the real clock; that file passed again on both engines (20
tests each, no warnings), with type-check, lint and the documentation checks.

Gaps: no live integration has passed its check, so no workflow that pays or
messages is proven against its provider; the load benchmark is from one
machine; Postgres runs print `pg`'s deprecation warning about overlapping
`client.query()` calls on one client, which does not fail a test and is not
yet traced.

#### 25 October 2026, commit `a9b66af`

The staff dashboard in English, Malay and Chinese, and company-account
invoices in the account's language. Not a launch. Run on one cloud
container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 96 passed (with this record's documentation, the commit after) |
| Suite on PGlite | 197 files; 2243 passed, 1 skipped (a Postgres-only test) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 197 files; 2244 passed |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Staff 1 among them | 6 files; 18 passed |
| CI | Not run (deferred, above) |
| Real services | None checked |

Gaps: the Malay and Chinese of the staff dashboard are machine-assisted and
not reviewed by a native speaker; text the server composes on staff screens
stays English ([known limitations](../roadmap/known-limitations.md#languages));
no live integration has passed its check.

#### 25 October 2026, commit `d941850`

The owner's decisions on the booking defaults (minimum separation that does
not add up, places per booking up to every place, first lessons applied for
online and approved remotely), the server's text on staff screens in the
staff language, built-in texts in each customer's language, kinds of kit
under one heading, old outages' late hours, two browser journeys and the
Postgres pool. Not a launch. Run on one cloud container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 97 passed (with this record's documentation, the commit after) |
| Suite on PGlite | 205 files; 2338 passed, 3 skipped (Postgres-only tests) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 205 files; 2341 passed, no overlapping-query warning |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Venue 1 and Change time 1–3 among them | 8 files; 22 passed |
| CI | Not run (deferred, above) |
| Real services | None checked |

Gaps: no live integration has passed its check (approval emails go through
the same email integration as every other); machine-assisted Malay, Chinese
and Tamil await native review; the approval retention periods (90 and 365
days) await the owner; `tests/contention.test.ts`'s retry bound has been
seen exceeded under heavy parallel load on the base commit as well, once in
about a dozen runs, and passed here.

#### 26 October 2026, commit `17d2747`

The owner's approval-workflow decisions of 26 October 2026: approval
followed by payment, door codes that never bypass eligibility, who may grant
a safety approval and revoking it, applications kept by purpose with holds,
PDFs checked and never rendered, and a child applied for, booked and agreed
for from an adult's account; shared facilities turned over per place or
whole; receipts and the off-peak refusal in the customer's language; kinds
of kit under their heading in search; coach links kept as a hash; and a
tournament's whole run driven in a browser. Not a launch. Run on one cloud
container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 100 passed (with this record's documentation, the commit after) |
| Suite on PGlite | 215 files; 2465 passed, 4 skipped (Postgres-only tests) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 215 files; 2469 passed |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Tournament 3–6 among them | 9 files; 26 passed |
| CI | Not run (deferred, above) |
| Real services | None checked: payments on approval were tested against the fake gateways only |

Gaps: no live integration has passed its check; machine-assisted Malay,
Chinese and Tamil (the new approval, retention and guardian text among them)
await native review; the retention periods are provisional defaults awaiting
legal review; `tests/backup-scripts.test.ts` assumed the booking it makes
four days ahead was off-peak and failed on days it was not, on the base
commit too; it now reads the booking's price.


#### 27 October 2026, commit `07b9f9f`

The owner's decisions of 27 October 2026: another guardian only by verified
consent and the other guardians told, coaches seeing only the children they
supervise, eligibility following the participant across guardians
(ADR 0023); benefits and membership rules by their scope and taking one
person off a booking (ADR 0025); supporting documents failing closed with
safe retries, kept while no scanner runs, and clamd started on demand on the
2 GB Droplet; the erasure ledger off-site and recorded reviews with their
provenance (ADR 0024). Not a launch. Run on one cloud container, Node 22, all
on `07b9f9f`.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 104 passed (with this record's documentation, the commit after) |
| Suite on PGlite | 243 files; 2722 passed, 4 skipped (Postgres-only tests) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 243 files; 2726 passed |
| ClamAV engine, inside both suites | `tests/clamd-on-demand-engine.test.ts`: clamd 1.5.4 started on demand with ClamAV's official signatures (fetched by freshclam in this container, TLS verified), a PDF clean and the EICAR file refused as `Eicar-Test-Signature`; `tests/document-scanning-engine.test.ts`: the same clamd with a locally generated test signature |
| Off-site and recovery, inside both suites | `tests/erasure-ledger-restore.test.ts`, `tests/backup-scripts.test.ts`, `tests/offsite.test.ts` with the real scripts against a stand-in bucket on the loopback |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Guardians G and H, Documents I, Recovery J and Places K and L among them | 12 files; 38 of 38 |
| CI | Not run (deferred, above) |
| Real services | None checked: payments against the fake gateways, messages through the outbox only (the acceptance server logs them), documents scanned by a stand-in in the acceptance scenarios, buckets by a stand-in; no Droplet |

Before this run, the whole suite at `1db6fff` failed one test on both
engines: a privacy-notice phrase named MySenam instead of the install's own
site (fixed in `cd7448c`). Gaps: the scanner kit, its memory and clamd's
start time on a real Droplet; the off-site ledger against a real bucket; no
live integration has passed its check; machine-assisted Malay, Chinese and
Tamil await native review; the retention periods are product policy awaiting
Malaysian and Singaporean legal review; M16 waits on the owner.


#### 27 October 2026, commit `636eccd`

The remaining functional limitations, with further work on supporting
documents and their infrastructure deferred by the owner: discounts that
stack only by the venue's setting and the code's (M16), several passes on
the form and at the counter, memberships bought online for the account, a
child or a family, guardians recorded by name and number taken through to
agreement or an account, concession records exported, access lists linked to
accounts, the waiting list at the counter and through the API, entering
competitions for somebody at the counter, league results changed only from
the version read, occupancy totals, and several servers starting at once.
Not a launch. Run on one cloud container, Node 22. The suites ran on
`7f20b9a`; `636eccd` changed only one acceptance step's expected wording (the
return page names the child who became a member), and the build, end-to-end
tests and acceptance scenarios ran on `636eccd`.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 104 passed (with this record's documentation, the commit after) |
| Suite on PGlite | 278 files; 3027 passed, 8 skipped (Postgres-only tests) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 278 files; 3035 passed, on the second run (below) |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Membership O and scenarios M–S among them | 14 files; 48 of 48 |
| CI | Not run (deferred, above) |
| Real services | None checked: payments against the fake gateways and a stand-in for Billplz's payment page, messages through the outbox only, documents scanned by a stand-in; no Droplet, no bucket |

The first full Postgres run on `7f20b9a` failed one test:
`tests/contention.test.ts`, *all go through on different courts of one
venue*, counted 36 retried transactions in a round where it allows 2 (every
booking still went through). It passed three times on its own and the whole
suite passed on the second run, with nothing changed; it is recorded as
sensitive to the load of the whole suite on one machine, not explained. The
first acceptance run, on `7f20b9a`, failed Membership O, which waited for the
return page's old wording. Gaps: further work on supporting documents and
their infrastructure is deferred ([roadmap](../roadmap/roadmap.md)); no live
integration has passed its check; machine-assisted Malay, Chinese and Tamil
await native review; the retention periods are product policy awaiting
Malaysian and Singaporean legal review.

#### 27 October 2026, commit `7eb5aef`

The owner's round 6 decisions and the remaining functional work: guest,
game and group invitations that do not reveal whether an address has an
account (S21, S22), sign-in and password reset that take as long for an
unknown address; the contention anomaly traced and fixed (B30: rows pointing
at a booking checked at commit); lesson coaches kept, reassigned by a manager
with the money effect, or assigned by the venue; membership holds fitted to
each gateway and family dependants by the plan's policy; booking privileges
when booking and a members' place by its date, asked again at check-in and
the door; one person taken off a booking held by a deposit or charged to an
account; the venue API's discounts and checks (M18, B32) and waiting-list
claims asking what the booking asks; links and times in each language; the
guardian notice template prepared; names in receipt lines cleared (S23); and
the defects the full suites found (B31, B34–B38, S24). Not a launch. Run on
one cloud container (four cores), Node 22, all on `7eb5aef`.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 104 passed (with this record's documentation, the commit after) |
| Suite on PGlite | 300 files; 3192 passed, 12 skipped (Postgres-only tests) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server, `max_locks_per_transaction` 256) | 300 files; 3204 passed |
| Contention, inside both suites | `tests/contention.test.ts` (retries bound unchanged) and `tests/booking-references-deferred.test.ts`: the order of events that cancelled the middle of three bookings, replayed on Postgres, cancels it with the old check and commits all three now |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Guests T, Coaches U and V, Membership W, Family X, Places Y and Malay Z among them | 15 files; 55 of 55 |
| CI | Not run (deferred, above) |
| Real services | None checked: payments against the fake gateways and the Billplz stand-in, messages through the outbox only (the acceptance server logs them), the WhatsApp template not submitted |

The first full run on `58b1771` failed three Postgres tests with "out of
shared memory" (the server's default `max_locks_per_transaction` of 64, with
several test databases restoring at once; the deployment kit and this server
now set 256), two acceptance scenarios that still expected round 5's wording
(times, links and receipts are now localised), and showed two unhandled
errors from a connection cut under a background job (S24, fixed). An earlier
PGlite run after 16:00 UTC (midnight in Malaysia) found two tests comparing a
local date with a UTC one (B31, B36, fixed; B37 found by the same search).
Gaps: no live integration has passed its check; machine-assisted Malay,
Chinese and Tamil await native review, now including the times each language
is written in; the retention periods are product policy awaiting legal
review; the owner's decision on the counter's checks is open.

#### 28 October 2026, commit `21d251b`

The owner's round 7 decisions: the same venue policies on the counter and
through the venue's API as online, with audited manager overrides where the
venue permits (ADR 0026; B41–B43); sign-up by an emailed link that never says
whether an address has an account, and Google sign-in that does not either
(S25); emailed invitations withdrawn before they are accepted; a dearer
coach's difference paid online (B39); memberships suspended and reactivated
(B40); staff times in the staff language (B44); e-invoices sent to LHDN never
rewritten, corrections as new documents (M19, M20); the venue API's
withdrawal of one person, refunds made in Stripe's dashboard recorded, cover
history in the data export, lessons paid from credit, account credit paid
back by hand (M21); the lock table's memory on the 2 GB Droplet measured; and
what the acceptance scenarios found (B45, B46). Not a launch. Run on one
cloud container (four cores), Node 22, all on `21d251b`, at the first
attempt.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 105 passed (with this record's documentation, the commit after) |
| Suite on PGlite | 320 files (3 Postgres-only skipped); 3384 passed, 12 skipped |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server, `max_locks_per_transaction` 256) | 320 files; 3396 passed |
| Concurrency, money and security inside both suites | Among them: `tests/contention.test.ts` (guarantees, then its measurements judged apart against the unchanged bounds), `tests/booking-references-deferred.test.ts`, `tests/same-policies.test.ts`, `tests/registration.test.ts` (six uses of one link, a link racing Google), `tests/invitation-withdrawals.test.ts` (withdrawal racing acceptance), `tests/coach-difference-online.test.ts` (counter racing a callback), `tests/membership-suspensions.test.ts` (suspending while somebody books), `tests/account-credit-settled.test.ts` and `tests/api-withdrawals.test.ts` on Postgres; `tests/einvoice-records.test.ts` (a sent document refused any change by the database) |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Email 4 and Invitations AA and AB, Coaches AC, Suspension AD, Times AE, Credit AF, Accounts AG and Counter AH among them | 16 files; 64 of 64 |
| CI | Not run (deferred, above) |
| Real services | None checked: payments against the fake gateways and the Billplz stand-in, messages through the outbox only (the acceptance server logs them), MyInvois against a stand-in (no acceptance scenario: no state can be shown without LHDN), Google sign-in against a stand-in |

Before this run, the batches merged this round were tested file by file on
both engines as they came in; the acceptance scenarios found B44, B45 and
B46, fixed with tests before the run. Gaps: no live integration has passed
its check; machine-assisted Malay, Chinese and Tamil await native review;
the retention periods are product policy awaiting legal review; the memory
figures for the lock table come from the development container, not the
Droplet.

#### 9 November 2026, commit `f2263b1` (final bounded housekeeping, release verification on the AI VM: PASS)

`node scripts/verify.mjs release --pg docker`, on the AI development VM (4 CPUs, 16.9 GB, Node 22.22.0, Docker with `postgres:16-alpine`, PostgreSQL 16.15 on a throwaway container
on a loopback port), of commit `f2263b108dbb5b30395a3a5f893ae55728c63aeb`, tree clean, source digest `ae20182e487ff719a9f8b6e912d292bceb2265f396bcddbfc147cccb310f8385` (the same
before and after the run). Started 12:35 UTC (20:35 Malaysian time), 7646 seconds; the disk was 87.7% used (the runner's preflight warns above 80%). Report:
`artifacts/verify/f2263b108dbb-1794227713464.json` (not committed). This verifies the source of the [housekeeping round](../audits/final-bounded-housekeeping-2026-11-09.md): the
historical counter-refund records ([ADR 0078](../architecture/decisions/0078-cancellations-from-before-money-owed-back-was-written-down-are-recorded-once-and-change-no-counted-day.md),
migration 0348) and the owners' refund summary with email on *System health*
([ADR 0079](../architecture/decisions/0079-the-platform-owners-daily-refund-summary-and-email-on-system-health.md)), on top of `354f346`. **This is not CI** (no GitHub Actions job was
started) **and not production readiness.**

| Step | Result |
| ---- | ------ |
| Type-check | Passed |
| Lint (`--max-warnings 0`) | Passed |
| Documentation checks | 184 of 184 passed |
| Suite on PGlite | 7091 passed, 0 failed, 15 skipped (the 15 Postgres-only tests listed in `scripts/lib/expected-skips.mjs`), of 7106 |
| Suite on PostgreSQL 16 | 7107 passed, 0 failed, **0 skipped**, of 7107; the server committed 2490 transactions during it (Postgres was used) |
| Production build | Succeeded |
| Browser end-to-end tests | 12 of 12 passed |
| Acceptance scenarios (UAT) | 27 files; 95 of 95 passed, none skipped |
| CI | Not run: GitHub Actions workflows start only by hand |
| Real services | None checked by this run |

It passed on the first run of this source; nothing was retried and no run of it failed. Commits after `f2263b1` that change only this file leave the verification standing;
`node scripts/verify.mjs check` says so.

#### 9 November 2026, commit `354f346` (pilot completion round, release verification on the AI VM: PASS)

`node scripts/verify.mjs release --pg docker`, on the AI development VM (4 CPUs, 16.9 GB, Node 22.22.0, Docker with `postgres:16-alpine`, PostgreSQL 16.15 on a throwaway container
on a loopback port), of commit `354f3468faec48a3db1562908c2e9416adb1a9aa`, tree clean, source digest `f96d9442505700388cb4f3befc8b3fe61e91b08a189a59747fc16826a8563ecc` (the same
before and after the run). Started 09:12 UTC (17:12 Malaysian time), 7192 seconds; the disk was 87.3% used (the runner's preflight warns above 80%). Report:
`artifacts/verify/354f3468faec-1794215553097.json` (not committed). This verifies the source of the [pilot completion round](../operations/pilot-completion-2026-11-08.md): the operator-visibility
readings ([ADR 0076](../architecture/decisions/0076-three-operator-visibility-gaps-the-heartbeat-a-payment-mismatch-and-counter-refunds-owed.md)) and the staff withdrawal that writes its payout
([ADR 0077](../architecture/decisions/0077-staff-taking-a-person-off-at-the-counter-hand-the-money-over-then-and-it-is-written-as-the-payout-it-is.md)), on top of `f1c2c52`. **This is not CI** (no GitHub Actions job was
started) **and not production readiness.**

| Step | Result |
| ---- | ------ |
| Type-check | Passed |
| Lint (`--max-warnings 0`) | Passed |
| Documentation checks | 181 of 181 passed |
| Suite on PGlite | 7034 passed, 0 failed, 15 skipped (the 15 Postgres-only tests listed in `scripts/lib/expected-skips.mjs`), of 7049 |
| Suite on PostgreSQL 16 | 7050 passed, 0 failed, **0 skipped**, of 7050; the server committed 2446 transactions during it (Postgres was used) |
| Production build | Succeeded |
| Browser end-to-end tests | 12 of 12 passed |
| Acceptance scenarios (UAT) | 27 files; 95 of 95 passed, none skipped |
| CI | Not run: GitHub Actions workflows start only by hand |
| Real services | None checked by this run (see the [completion record](../operations/pilot-completion-2026-11-08.md)) |

This is the first complete run of this source to finish; nothing in it was retried. Three earlier attempts on the same commit were cut short when the machine restarted while the session was idle
(during the type-check or the PGlite suite) and are not counted: their logs show only the steps that had finished, and no step failed. Commits after `354f346` that change only
this file leave the verification standing; `node scripts/verify.mjs check` says so.

#### 8 November 2026, commit `f1c2c52` (pilot activation round, release verification on the AI VM: PASS)

`node scripts/verify.mjs release --pg docker`, on the AI development VM (4 CPUs, 16.9 GB, Node 22.22.0, Docker with `postgres:16-alpine`, PostgreSQL 16.15 on a throwaway container
on a loopback port), of commit `f1c2c5243aadbfd1700c1a50cb1a84746c25b0d4`, tree clean, source digest `b5a530117c358474c4c3c2055398d84c2f0f3d1bff4f4c2798d3d6d9b5229224` (the same
before and after the run). Started 06:52 UTC (14:52 Malaysian time), 5928 seconds; the disk was 81.8% used (the runner's new preflight warned at 80%). Report:
`artifacts/verify/f1c2c5243aad-1794120748677.json` (not committed). This verifies the source of the [pilot activation round](../operations/pilot-activation-2026-11-08.md): the cash-up that counts refunds when they are handed back
([ADR 0075](../architecture/decisions/0075-the-till-is-compared-with-cash-received-and-cash-handed-back-and-a-credit-note-is-not-a-payout.md)) and the disk-space guard. **This is not CI** (no GitHub Actions job was started) **and not production readiness.**

| Step | Result |
| ---- | ------ |
| Type-check | Passed |
| Lint (`--max-warnings 0`) | Passed |
| Documentation checks | 178 of 178 passed |
| Suite on PGlite | 6989 passed, 0 failed, 15 skipped (the 15 Postgres-only tests listed in `scripts/lib/expected-skips.mjs`), of 7004 |
| Suite on PostgreSQL 16 | 7005 passed, 0 failed, **0 skipped**, of 7005; the server committed 2449 transactions during it (Postgres was used) |
| Production build (`.next` removed first) | Succeeded |
| Browser end-to-end tests | 12 of 12 passed |
| Acceptance scenarios (UAT) | 27 files; 95 of 95 passed, none skipped |
| CI | Not run: GitHub Actions workflows start only by hand |
| Real services | See below |

It passed on the first complete run of the changed source; nothing was retried. Commits after `f1c2c52` that change only this file leave the verification standing; `node scripts/verify.mjs check` says so.

**Real-service checks of 8 November** (separate from this run, recorded in the [activation record](../operations/pilot-activation-2026-11-08.md)): Amazon SES accepted a synthetic message and the application's sign-up, password-reset and cancellation messages for one approved recipient (acceptance, not delivery: a person must confirm the inbox and the SPF, DKIM and DMARC results); the SES key cannot read the account or the identity; Backblaze B2 and Billplz were not contacted (no bucket configuration, no sandbox credentials). The suites use stand-ins for every provider.

#### 8 November 2026, commit `d844e4a` (final operational hardening, release verification on the AI VM: PASS)

`node scripts/verify.mjs release --pg docker`, on the AI development VM (4 CPUs, 16.9 GB, Node 22.22.0, Docker with `postgres:16-alpine`, PostgreSQL 16.15 on a throwaway container
on a loopback port), of commit `d844e4a7a5f22342f47c14f0f4c3389efca8fe25`, tree clean, source digest `50df113e84edcff7f56a19bd5434dc07d84e6846b7c0baa53d367d198b05ec22` (the same
before and after the run). Started 19:51 UTC on 7 November (03:51 Malaysian time on the 8th), 5477 seconds. Report: `artifacts/verify/d844e4a7a5f2-1794081060593.json` (not committed). This
verifies the source of the [final operational hardening round](../audits/final-operational-hardening-2026-11-07.md): security mail as its own class, owed-back tasks for a customer's counter-paid
cancellation, validated production email, the tournament-day helper, migrations 0342 to 0347. **This is not CI** (no GitHub Actions job was started) **and not production readiness.**

| Step | Result |
| ---- | ------ |
| Type-check | Passed |
| Lint (`--max-warnings 0`) | Passed |
| Documentation checks | 174 of 174 passed |
| Suite on PGlite | 6939 passed, 0 failed, 15 skipped (the 15 Postgres-only tests listed in `scripts/lib/expected-skips.mjs`), of 6954 |
| Suite on PostgreSQL 16 | 6955 passed, 0 failed, **0 skipped**, of 6955; the server committed 2427 transactions during it (Postgres was used) |
| Production build (`.next` removed first) | Succeeded |
| Browser end-to-end tests | 12 of 12 passed |
| Acceptance scenarios (UAT) | 27 files; 95 of 95 passed, none skipped |
| CI | Not run: GitHub Actions workflows start only by hand |
| Real services | None exercised (below) |

**How it got there.** Before it, one complete run failed and one was lost; neither was retried into a pass:

| Run | Commit | Failed | Cause and fix |
| --- | ------ | ------ | ------------- |
| 1 | `82f07a6` | One acceptance scenario (everything else passed: PGlite 6939 of 6954, Postgres 6955 of 6955, end-to-end 12 of 12) | *Email 4* had a stranger type a new account's address seconds after that account's own sign-up link and expected the *you already have an account* email; security mail now has a 60-second cooldown per address (ADR 0073), so none is sent that fast. The scenario waits a minute: the product behaviour is the intended one (a defect of a test about a changed rule) |
| (lost) | `82f07a6` | A container restart killed a run during the acceptance scenarios | No report was written; it counts as nothing |
| 2 | `d844e4a` | Nothing | PASS |

Two defects of tests were found by a full PGlite run before these, not by them: `tests/qualification-levels.test.ts` chose dates by weekday and collided on a Sunday in Malaysian time (it failed the same way on `c23ca9e` that day); and one run of `tests/erasure-ledger-restore.test.ts` crashed with a no-space error while the VM's disk was at 99%
(see [known limitations](../roadmap/known-limitations.md)). Commits after `d844e4a` that change only this file leave the verification standing; `node scripts/verify.mjs check` says so.

**Not verified by this run, by name** (each is in the report's `integrations`, with the command that checks it): Amazon SES (the read-only check on 7 November found DMARC and SPF records, could not read the account or the identity, and sent nothing; see
[provider verification](../operations/pilot-provider-verification.md)), Billplz (blocked: no sandbox credentials), Backblaze B2 (blocked: no credentials), Stripe, WhatsApp, SMS, MyInvois, Xero, Google sign-in, ClamAV on the Droplet. The suites use stand-ins for all of them.

#### 7 November 2026, commit `c23ca9e` (post-audit hardening round, release verification on the AI VM: PASS)

`node scripts/verify.mjs release --pg docker`, on the AI development VM (4 CPUs, 16.9 GB, Node 22.22.0, Docker with `postgres:16-alpine`, PostgreSQL 16.15 on a throwaway container
on a loopback port), of commit `c23ca9ebd2d9a0a24de0c943aac0f3411df083e1`, tree clean, source digest `2692a0302b45af11c4dcb8ac5a5142d5813c990a24d734f3805d9c57186150ed` (the same
before and after the run). Started 13:04 UTC, 4556 seconds. Report: `artifacts/verify/c23ca9ebd2d9-1794056682453.json` (not committed). This verifies the source of the
[hardening round](../audits/hardening-2026-11-07.md) (nine branches, one cross-domain suite, the sign-up review, migrations 0312 to 0342). **This is not CI** (no GitHub Actions job
was started) **and not production readiness**; the [pilot readiness assessment](../operations/pilot-readiness-2026-11-07.md) says what stands between the two.

| Step | Result |
| ---- | ------ |
| Type-check | Passed |
| Lint (`--max-warnings 0`) | Passed |
| Documentation checks | 169 of 169 passed |
| Suite on PGlite | 6845 passed, 0 failed, 15 skipped (the 15 Postgres-only tests listed in `scripts/lib/expected-skips.mjs`), of 6860 |
| Suite on PostgreSQL 16 | 6861 passed, 0 failed, **0 skipped**, of 6861; the server committed 2401 transactions during it (Postgres was used) |
| Production build (`.next` removed first) | Succeeded |
| Browser end-to-end tests | 12 of 12 passed |
| Acceptance scenarios (UAT) | 27 files; 95 of 95 passed, none skipped |
| CI | Not run: GitHub Actions workflows start only by hand |
| Real services | None exercised (below) |

**How it got there.** Two complete runs failed first; neither was retried into a pass, and a failed run's report is kept as it was.

| Run | Commit | Failed | Cause and fix |
| --- | ------ | ------ | ------------- |
| 1 | `bd9cc5f` | Three acceptance scenarios (everything else passed: PGlite 6845 of 6860, Postgres 6861 of 6861, end-to-end 12 of 12) | The scenarios encoded behaviour the round changed on purpose: a customer changing a booking's time now sees what it does to the price and confirms (`change-time`, `round6` Coaches U), and a booking keeps the cancellation terms shown when it was made, so the venue turns on *give the court back after the cutoff* before she books (`round8` Late AK). Corrected, not loosened |
| 2 | `8af12df` | Postgres: two tests; one acceptance scenario | `no-enumeration-timing` counted queued sign-up requests after the reply while the background worker could already have taken them (a defect of a test: it reads the table's counter); `team-forfeit-requests` expected one of two names for the same refusal (*fixture decided*, *season over*) of a request racing the result that finished the season (a defect of a test: it accepts both); `tournament-day` timed out once waiting for a heading and passed twice alone straight afterwards (**unexplained**; a timing flake under load is the best reading, recorded as such in [known limitations](../roadmap/known-limitations.md)) |
| 3 | `c23ca9e` | Nothing | PASS |

Two defects of the product were found by the round's own tests, not by these runs, and are in the [hardening record](../audits/hardening-2026-11-07.md#found-by-the-rounds-own-tests-and-reviews). Commits after `c23ca9e` that change only this file leave the verification standing; `node scripts/verify.mjs check` says so.

**Not verified by this run, by name** (each is in the report's `integrations`, with the command that checks it): Billplz (FPX, cards, refunds, and the new settlement checks against a real sandbox), Stripe
(cards, refunds, disputes, subscriptions, `pause_collection`), email through SES or SMTP, WhatsApp (and the changed waitlist offer template, which needs resubmitting to Meta), SMS, Backblaze B2 / S3
off-site storage, MyInvois, Xero, Google sign-in, ClamAV on the Droplet. The suites use stand-ins for all of them.

#### 6 November 2026, commit `1737cc2` (release verification on the AI VM: PASS)

The first complete release run that passed: `node scripts/verify.mjs release --pg docker`, on the AI development VM (4 CPUs, 16.9 GB, Node 22.22.0, Docker 29 with
`postgres:16-alpine`, PostgreSQL 16.15 on a throwaway container on a loopback port), of commit `1737cc28490d234e562fa8ffedb8755cf28b27f8`, tree clean, source digest
`8cb908af668344991b9caba969d31b98f6b00418e96e83f03d72370ec902be77` (the same before and after the run). Started 18:46 UTC, 4929 seconds. Report:
`artifacts/verify/1737cc28490d-1793990785460.json` (not committed). **This is not CI** (no GitHub Actions job was started) **and not production readiness.**

| Step | Result |
| ---- | ------ |
| Type-check | Passed |
| Lint (`--max-warnings 0`) | Passed |
| Documentation checks | 157 of 157 passed |
| Suite on PGlite | 539 files; 6472 passed, 0 failed, 13 skipped (the 13 Postgres-only tests listed in `scripts/lib/expected-skips.mjs`, in 3 whole files and 4 others), of 6485 |
| Suite on PostgreSQL 16 | 539 files; 6485 passed, 0 failed, **0 skipped**, of 6485; the server committed 2225 transactions during it (Postgres was used) |
| Production build (`.next` removed first) | Succeeded |
| Browser end-to-end tests | 3 files; 12 of 12 passed |
| Acceptance scenarios (UAT) | 27 files; 95 of 95 passed, none skipped |
| CI | Not run: GitHub Actions workflows start only by hand |
| Real services | None exercised (below) |

**How it got there.** The runner was rewritten first (release profile; Postgres mandatory; failures, skips, kills, timeouts and interruptions fail; a source digest before and after; `check`),
and the workflows were made manual. Five complete runs then failed before this one, each for a reason found and fixed, none by a retry:

| Run | Commit | Failed | Cause and fix |
| --- | ------ | ------ | ------------- |
| 1 | `c835be3` | PGlite: one test; Postgres: one test (all else, UAT included, passed) | The add-resources form lost what the operator had typed when the list of activities loaded late (a defect: fixed, with a test that failed before); two ticks refreshing Xero's rotating token at once (a defect: the connection is read again after the lease; about half of whole-file runs failed before it, 0 of 15 after) |
| 2 | `9e98792` | Postgres: exit code 1 with every test passing | An unlock on a lost migration-lock connection failed finished work (a defect: unlock is best effort; test added that failed with exactly that error before). The run was stopped when the source changed under it, and its report says so |
| 3 | `715a30b` | One acceptance scenario | *Accounts AG* needs an hour of the day still to come at the venue and has none from 23:00 Malaysian time; the scenario says so plainly and the release profile waits out 22:15 to midnight before the scenarios (a defect of a test about the clock) |
| 4 | `6339f5e` | Postgres: exit code 1 with every test passing | `tests/rating-matchmaking.test.ts` left three database queries running after its teardown had dropped the database (a defect of a test; 3 of 12 runs of the file before, 0 of 20 after) |
| 5 | `9d635de` | PGlite: exit code 1; Postgres: one test | The guardian messaging section threw an unheard error when the connection was down (a defect: fixed, test added that failed before); the password-reset timing test raced its own background work on a loaded Postgres (a defect of a test: it now compares the awaited work; it failed once, and in none of 20 runs alone) |
| 6 | `1737cc2` | Nothing | PASS |

Each failed run's report is kept as it was; a rerun of a failed test alone never changed a report (the stress loops above were diagnosis, not retries). Run 6 is the first whole run on the final source.
Commits after `1737cc2` that change only this file leave the verification standing; `node scripts/verify.mjs check` says so.

**Not verified by this run, by name** (each is listed in the report's `integrations`, with the command that checks it): Billplz (FPX, cards, refunds), Stripe (cards, refunds, disputes,
subscriptions, `pause_collection`), email through SES or SMTP, WhatsApp (and the changed waitlist offer template, which needs resubmitting to Meta), SMS, Backblaze B2 / S3 off-site
storage, MyInvois (including the late consolidation and the retry of unsent documents), Xero, Google sign-in, ClamAV on the Droplet. The suites use stand-ins for all of them.

**Remaining release blockers** (the [remediation roadmap](../audits/remediation-roadmap-2026-11-06.md) has the full list): every row of the
[launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove) that needs a real account; 33 open and 20 undecided audit findings
([findings register](../audits/findings-register-2026-11-06.md)), among them a way to close or leave a live venue, and the tax treatment of stored-credit sales in the consolidated e-invoice; the
machine-assisted Malay, Chinese and Tamil await native review; the legal questions about youth messaging stay pending.

#### 6 November 2026, commit `3626098` (the business-process audit: findings and fixes)

An independent audit of the business processes (baseline `2aabdd4`; eight auditors, read-only, with scratch repro tests; records in
[audits](../audits/index.md)) and the fixes for its verified defects, built by eleven workers and merged (migrations 0295, 0297, 0299-0301, 0303-0309, 0311; ADRs 0053-0063): closures that write the closure first and leave played
classes and bookings alone, class cancel and draw races, weekly series checked week by week, credit and pass payment decided under the booking's lock, money paid never above the price, no silent price, reports that reconcile with the journal,
outbox reliability (outages, urgent news, reminders, refund and invoice notices), customer lookups bounded to a venue, secrets masked, owner actions logged, erasure of payers, safety flags and self check-in, counter fees owed back,
waitlist offers per time, company-account part credits and cash-up counts, pass restore and session-date validity, and suspension notices. Not a launch. Run on one cloud container, Node 22, by hand.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed on `3626098` |
| Documentation checks (`npm run docs:check`) | 143 passed on `3626098`; 157 passed after the audit documents were merged |
| Build (`npm run build`) | **Failed at first**: the type-check ran out of memory at Node's default 2 GB heap; passed with a 4 GB heap, which `npm run build` and the Dockerfile now set |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 27 files; 94 of 95 passed (one failure below) |
| Suite on PGlite | 538 files (3 skipped); 6465 passed, 12 skipped, 5 failed (below) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 538 files; 6475 passed, 7 failed (below), one unhandled `ECONNRESET` |
| CI | Not run (deferred) |
| Real services | None checked |

Every failure was in a test, not in the audited behaviour, and is corrected in the commits after this one. The acceptance failure (*Guide I*) clicked "Save" in the Online payment section, where a second Save button now
exists (the waiting-list offer window, ADR 0060); it now picks the gateway form's button, and the whole file passed alone (3 tests). On both engines, four tests of `tests/components/counter-money.test.tsx` used a cash-up fixture without the new
`expected` and `counts` fields (ADR 0061), and `tests/activity-log-coverage.test.ts` took a hire deposit without a payment method, which is now required; both were corrected and passed. On Postgres only, `tests/accounting-push.test.ts` (a
race between two token refreshes) and `tests/guide-setup-ui.test.tsx` (a one-off timing under load) passed alone (75 tests). The unhandled `ECONNRESET` is the migration lock's release in one worker, as in earlier records. Before the full
run, a test of the liabilities block depended on the time of day (it books for today at 14:00 and failed after 14:00 Malaysian time) and was corrected. After the corrections no second full run was made. Each fix worker ran its own new and affected
tests on PGlite and, for races and money, on Postgres, with the results in its ADR and the register's status column; those runs are not CI.

Gaps: no live integration has passed its check (the Stripe `pause_collection`, the changed WhatsApp waitlist template, MyInvois late consolidation and retry, Billplz refunds by hand); 33 audit findings remain open and 20 await an owner decision
([findings register](../audits/findings-register-2026-11-06.md), [remediation roadmap](../audits/remediation-roadmap-2026-11-06.md), [decisions](../audits/business-decisions-2026-11-06.md)); no browser scenario covers the new safety flags,
suspension notices, company-account overdue block or cash-up counts; the Malay, Chinese and Tamil of everything added is machine-assisted and awaits native review.

#### 5 November 2026, commit `bd47dbc` (the owner's three remaining decisions)

The owner's three decisions, built by two workers and the lead: ladder counter-proposals (the counter-proposer's agreement counts, a stale or superseded
proposal is refused, a revision counter, a history of hold events; migration 0293), no automatic blame for abandoned or expired ladder holds (only a player's
own cancellations of holds that really reserved a court count towards a pause that ends by itself), and the youth-messaging interim safeguards pending legal
review (a launch switch that keeps youth messaging off in production, a recorded decision about each guardian's authority, review and appeal from the neutral
line, safeguarding escalation, evidence classes and owner-only legal holds, no invented legal period; migration 0294, ADR 0052), with the checklist for a
lawyer in [legal review: youth messaging](../operations/legal-review-youth-messaging.md). Not a launch, and not a legal conclusion. Run on one cloud
container, Node 22, by hand.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 139 passed |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 27 files; 94 of 95 passed (one failure below) |
| Suite on PGlite | 496 files (3 skipped); 6083 passed, 12 skipped, 4 failed (below) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 496 files; 6096 passed, 3 failed (below); one unhandled `ECONNRESET` |
| CI | Not run (deferred) |
| Real services | None checked |

Every failure was in a test, not the app, and is corrected in the commits after this one. *Ladders A* waited for the word "declined" in the challenges list and
found it first in the new, collapsed explanation of the limits (hidden); it now waits for the visible one, and the scenario passed alone (2 tests). Four unit
tests depended on the day or the time rather than on the behaviour: in `tests/class-moves.test.ts` a link's window was asserted to be under 3.5 days, which is
untrue between midnight and 06:00 Malaysian time (the run reached it at about 03:00); and in `tests/lesson-venue-moves.test.ts`, `tests/qualification-levels.test.ts`
and `tests/rosters.test.ts` two tests picked the same slot on some days of the week ("a Tuesday about 12 days ahead" and "about 13 days ahead" are the same Tuesday
on a Friday) and the second was refused. Each now uses a slot of its own. After the corrections the four files passed on PGlite and on Postgres (80 tests on
each); no second full run was made. The Postgres unhandled `ECONNRESET` came from the migration lock's release in one worker (the same kind as in an earlier
record); every file passed on its own.

Gaps: no live integration has passed its check; no browser scenario covers the counter-proposal screens or the youth-messaging safeguards (the guardian
authority record, the reported-adult review and appeal, the escalation); every legal question in the checklist is pending legal verification and nothing here
claims compliance; the youth-messaging notices and their wording await legal review; the Malay, Chinese and Tamil of everything added is machine-assisted and
awaits native review.

#### 5 November 2026, commit `72286df` (the owner's five remaining decisions)

The owner's decisions on the five questions left open by the previous round, built by two workers and the lead: guardians in
conflict (a per-guardian messaging authority, an objection that only every deciding guardian or a safeguarding administrator can end,
one lock per child and group) and a reported adult who is not told (a neutral protective restriction, a conflict guard, held evidence, a
moderators' case workflow; migration 0291, ADR 0049); an exact ladder agreement that counts as confirmation, an acceptance preview, and
active-hold limits that expired holds no longer consume, with an anti-abuse cooldown (migration 0292, ADR 0050); and class moves that stay refused onto
closed days and outside the hours, with a regression test (`tests/class-move-hours.test.ts`). Not a launch. Run on one cloud container, Node 22, by hand.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 136 passed |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 27 files; 95 of 95 passed |
| Suite on PGlite | 493 files (3 skipped); 6008 passed, 12 skipped, 2 failed (below) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 493 files; 6021 passed, 1 failed (below) |
| CI | Not run (deferred) |
| Real services | None checked |

Both failures were in tests, not the app, and are corrected in the commit after this one. In `tests/attendance.test.ts` one test booked a coach's
lessons for 19:00 and 20:00 *today* at the venue and read the register link with the real clock; the run reached it after 20:00 Malaysian time, when a booking
made after its own start is refused. It now books for tomorrow and fakes only the date, as noon that day, for the link's calls (it failed on both engines). In
`tests/guide-setup-ui.test.tsx` the add-courts test waited one second for the courts to appear, and failed once under the load of the full PGlite run; it
waits up to ten seconds (the assertion is unchanged) and passed three times alone. After the corrections, the two files passed on PGlite and on Postgres (47
tests each time); no second full run was made. The suites had also passed earlier on the same build before the clock reached that hour.

Gaps: no live integration has passed its check; no browser scenario covers the guardian authority and objection screens, the reported-adult case workflow,
ladder acceptance with its preview, or the active-hold limits; the youth-messaging notices, the neutral restriction line, the custody recording, the evidence
retention and the wording of consents all await legal review; the Malay, Chinese and Tamil of everything added is machine-assisted and awaits native review.

#### 5 November 2026, commit `82d4cdb` (the owner's six decisions)

The owner's decisions of 5 November 2026, built by five workers and merged: supervised group messaging for eligible
minors, guardian controls and a real digest (migration 0286, ADR 0044); front-desk class moves with a manager's
approval for consequential or exceptional ones (0287, ADR 0045); advisory launch and tide windows a manager may
override with a reason, and qualification levels (0288, ADR 0046); FIDE's Baku acceleration for a chess Swiss
(0289, ADR 0047); ladder hold limits, confirmation and expiry (0290, ADR 0048); and B76, found by the work and
fixed (a booking moved to another resource now asks that resource's launch or tide window). Not a launch. Run on one
cloud container, Node 22, by hand.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 134 passed |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 27 files; 94 of 95 passed (the one failure below) |
| Suite on PGlite | 488 files (3 skipped); 5917 passed, 12 skipped |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 488 files; 5929 passed; one unhandled `ECONNRESET` (below) |
| CI | Not run (deferred) |
| Real services | None checked |

*Guide F* timed out at its first step after 180 seconds in the full acceptance run, with nothing in the server's
output; run alone against the same build it passed (30 seconds, every step about two seconds). It is recorded as an
unexplained timeout under the load of the full run, not as passed in the run: a slow page in a long run is worth
watching, and a rerun of the whole acceptance suite was not made. The Postgres run reported every file and test
passed, and one unhandled `ECONNRESET` raised while `tests/rating-matchmaking.test.ts` was running, which made the
command exit non-zero; that file passed twice alone on Postgres (10 tests each). B76 was fixed with its test
(`tests/advisory-windows.test.ts`) after the browser run had started and is in this commit.

Gaps: no live integration has passed its check (the Xero adapter has never run against Xero, and the staff and
safeguarding emails went only through the outbox stand-in); no browser scenario covers rosters, windows and overrides,
messages and youth groups, class moves and desk requests, registers, team ladders, ladder holds or the Xero panel;
the Malay, Chinese and Tamil of everything added is machine-assisted and awaits native review; the retention periods,
rest hours, the staff-read exception for youth groups and the wording of consents await legal review; FIDE's text
for Baku was read through a summariser, and the pairing is not FIDE-certified.

#### 5 November 2026, commit `34c4d86` (fixes after it: `eda648a`, `9cd1437`)

Eight roadmap items, built by eight workers and merged: supervisor rosters (migration 0277, ADR 0036), launch and
tide windows (0278, ADR 0037), Swiss acceleration, the tie-break screen and Swiss for counted events (0279, ADR 0038),
messages between players (0280, ADR 0039), moving a class and a class's instructor as a coach (0281, ADR 0043), a
lesson moved by staff and attendance registers (0282, ADR 0042), ladder court time and ladders of teams (0283, ADR 0040),
and the live Xero push (0284, ADR 0041). Not a launch. Run on one cloud container, Node 22, by hand.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 129 passed |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 27 files; 93 of 95 passed (the two failures below) |
| Suite on PGlite | 474 files; 5684 passed, 12 skipped, 1 failed (below) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 474 files; 5696 passed, 1 failed (the same one) |
| CI | Not run (deferred) |
| Real services | None checked; the Xero push was exercised against a stand-in only and stays `INTEGRATION_VERIFICATION_REQUIRED` |

Three failures, none in what a customer would see, and what was done about each. *Formats C* read the Swiss standings'
last two columns as points and Buchholz, and the table now has more tie-break columns after them; it reads them by
heading. *Guide H* had a title so long that its evidence folder name was refused by the file system; the title is
shorter. Both scenario files were run again against the same build (6 of 6 passed). `tests/booking-references-deferred.test.ts`
(on both engines) found four new tables whose foreign keys to a booking were checked as each row was written, against
the rule that rows pointing at a booking are checked at commit (migration 0206); migration 0285 defers them, and that file
and the files of the features that write those rows were run again on PGlite and, for the three nearest, on Postgres
(93 and 28 tests passed). None of these corrections was followed by a second full run. Before the run, two
interactions between workers' code were found and corrected with tests (`tests/class-roster.test.ts`): a moved class was
not asked the roster, and a coach named to supervise a session could also be taken to teach a class at that time.
An accounting-push test that depended on which of several equal bookings was listed first now looks at all of them.

Gaps: no live integration has passed its check (the Xero adapter has never run against Xero); no browser scenario covers
rosters, launch windows, messages, class moves, registers, team ladders, held ladder court time or the Xero panel; the
Malay, Chinese and Tamil of everything added is machine-assisted and awaits native review; the retention and
authorisation periods added are provisional and await legal review.

#### 4 November 2026, commit `89bc4b7`

The browser scenarios for teams and team leagues (`tests/uat/teams.uat.ts`,
`tests/uat/team-leagues.uat.ts`), the tournament formats and tournament day
(`tests/uat/formats.uat.ts`, `tests/uat/tournament-day.uat.ts`) and climbing,
ladders, rankings and children's names (`tests/uat/climbing.uat.ts`,
`tests/uat/ladders.uat.ts`, `tests/uat/rankings.uat.ts`): fifteen scenarios, which
found and fixed four defects in the app (B72 to B75, in the
[register](../roadmap/known-limitations.md)). Not a launch. Run on one cloud
container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 119 passed |
| Suite on PGlite | 438 files; 5199 passed |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 441 files; 5211 passed |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 27 files; 93 of 95 passed (the two failures below) |
| CI | Not run (deferred) |
| Real services | None checked |

Both failures were in the harness and the scenarios, not the app. *Rankings A*
looked in the ledger for "Aida Tester v Bala Tester", but the ledger lists a
round-robin pair in either order and the full run had it as "Bala Tester v Aida
Tester"; it now accepts either. *Booking 1* did not get its sign-up email within
twenty seconds: the acceptance server has no scheduler and sends 25 queued messages
a run, and the climbing scenarios before it had queued hundreds (the email is in
`server.log`, sent late). The sign-up step now asks the app to work through its
outbox while it waits. No second full run followed: `climbing`, `rankings` and
`booking` files were run together against the same build (7 of 7 scenarios passed).
Gaps: the tournament-day scenario moves a second server's clock with a stand-in and
proves nothing about a deployed scheduler; no live integration has passed its
check; the decisions awaiting the owner are in the known limitations.

#### 4 November 2026, commit `c6ef1a9`

The owner's decisions of 4 November 2026 on names, rankings, forfeits, climbing
officials and ladders, and the optional feed-in consolation draw: minors' names
abbreviated on every public surface with a guardian's authorisation of the full
name (migration 0274); public rankings published by a manager's choice, a venue's
threshold and a separate provisional section (0275, ADR 0035); team-league
forfeits confirmed by a manager, officials entering climbing counts for their own
event, ladders that hold no court time (0276); the advanced feed-in consolation
draw (no migration, ADR 0034); B71 recorded. Not a launch. Run on one cloud
container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 119 passed |
| Suite on PGlite | 440 files (3 Postgres-only skipped); 5183 passed, 12 skipped |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 440 files; 5194 passed, 1 failed; a race in the test, corrected (below) |
| The new work inside both suites | Among them: `tests/public-names.test.ts` (every public surface scanned for a child's surname), `tests/ranking-policy.test.ts` and `tests/rating-eligibility.test.ts` (the switch on every surface, every row of the table of which results count, replay equal after amendment), `tests/team-forfeit-requests.test.ts`, `tests/official-climbing.test.ts` (a link tried against every staff route), `tests/ladder-court-time.test.ts` (no claim or block through a challenge's whole life), `tests/feed-in-structure.test.ts` and `tests/feed-in-consolation.test.ts` (exhaustive small fields, replay from scratch) |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 20 files; 79 of 80; *Guide F* failed on a race in the scenario (below) |
| CI | Not run (deferred) |
| Real services | None checked |

Both failures were races in tests, not in the app. *Guide F* counted the link *Open
this in the guide* in the "?" dialog before the dialog had read its topic, so it
counted none; it now waits for the link, before it checks what else is there, and
passes alone against the same build. *The application form comes from the guide's
own address* in `tests/guide-public-handoff.test.tsx` read the new venue's guide as
soon as the application was stored, before the account was opened and the venue
made; the printed rows showed an application with no venue yet. It now waits for
the venue and passed five times in five on Postgres and on PGlite. Neither
correction was followed by a second full run: the scenario file and the test file
were run alone, on the same build for the scenario. Gaps: no live integration has
passed its check; machine-assisted Malay, Chinese and Tamil await native review;
the authorisation wording for publishing a child's name awaits the owner's lawyer;
there are no browser scenarios yet for teams, team leagues, tournament day,
ratings, Swiss, ladders, the new formats or the officials' climbing entry.

**Follow-ups of 4 November 2026** (commit after `dab7e4a`): four small changes the
owner approved, checked by targeted suites only, not a second full run: a climbing
official's link works seven days after the event finishes for results and
correction requests only; earned-level matching never trusts a rating on fewer
results than the install default of eight; the public ladder shows ranks and
confirmed results, never a challenge; the surname initial skips name particles.
Run: `tests/ladder-public.test.ts`, `tests/ladders.test.ts`,
`tests/official-climbing.test.ts`, `tests/rating-matchmaking.test.ts`,
`tests/ranking-policy.test.ts`, `tests/public-names.test.ts`,
`tests/tournament-day.test.ts`, `tests/counted-performances.test.ts` on PGlite
(15 files, 245 tests) and the eight on Postgres, serially (151 tests); all passed.
Four existing expectations changed because the decisions make them wrong: the
particle examples ("Aina B." is now "Aina L.") and one matching threshold test.

#### 5 November 2026, commit `a86cab3`

The owner's request of 4 November 2026, the rest of the competition framework:
consolation draws and double elimination (migration 0271, ADR 0032), Swiss
tournaments and club ladders (0272, ADR 0033), and counted performances,
bouldering tops and zones (0273); B67 to B70 recorded. Each progression and
correction rule was written down before the code. Not a launch. Run on one cloud
container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 117 passed |
| Suite on PGlite | 427 files (3 Postgres-only skipped); 4969 passed, 12 skipped |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 427 files; 4980 passed, 1 failed; the cause fixed and the file passed on both engines (below) |
| The new work inside both suites | Among them: `tests/brackets-structure.test.ts`, `tests/double-elimination.test.ts` and `tests/consolation.test.ts` (every outcome of small fields, corrections at every depth, replay equal to a rebuilt state), `tests/swiss-math.test.ts` and `tests/swiss.test.ts` (pairing properties, stand or re-pair), `tests/ladder-math.test.ts` and `tests/ladders.test.ts` (ranks replayed from a ledger), `tests/counted-performances.test.ts` (hand-worked IFSC-style rankings) |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 20 files; 79 of 80; *Venue 1* (a venue signs up, sets up and takes its first booking) timed out waiting for the *Add courts* section; it passed alone against the same build and in the three earlier full runs, and its cause is not established |
| CI | Not run (deferred) |
| Real services | None checked |

The Postgres failure was real: calling a tournament fixture, sending it to another
court or moving it while a booking took the same minutes ended in the database's
overlap error instead of a refusal (B70), three runs in four when the machine was
loaded and almost never alone. The change owns its transaction, which cannot go on
after that error, so the retry meant for it never ran. Each of the three is now
refused whole; a test makes the refusal deterministic, fails without the fix, and
the race itself passed ten times under load afterwards. That fix was made after the
full run and checked on `tests/tournament-day.test.ts`, `tests/tournaments.test.ts`
and `tests/double-elimination.test.ts` on both engines, not by a second full run.
Gaps: no live integration has passed its check; machine-assisted Malay, Chinese
and Tamil await native review; there are no browser scenarios yet for teams, team
leagues, tournament day, ratings, Swiss, ladders, double elimination or counted
performances.

#### 4 November 2026, commit `f9438c2`

The owner's request of 3 November 2026, the competition and matchmaking items
of the roadmap: archiving past claims (migration 0267), tournament day, the next
match announced and a court called when it is free (0268), teams that persist
and leagues of teams with fixture lists (0269), and ratings from results,
rankings across events and matchmaking on earned levels (0270, ADR 0031); M31
and B66 recorded. Not a launch. Run on one cloud container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 115 passed |
| Suite on PGlite | 413 files (3 Postgres-only skipped); 4656 passed, 1 failed, 12 skipped; the 1 corrected and passed (below) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 413 files; 4668 passed, 1 failed; the 1 corrected and passed (below) |
| The new work inside both suites | Among them: `tests/claims-archive.test.ts` (bookings during a run, a locked row skipped), `tests/tournament-day.test.ts` (a call against a booking on the same minutes, never both), `tests/teams.test.ts`, `tests/team-leagues.test.ts` and `tests/fixture-plan.test.ts` (every pair meets, home and away balance), `tests/rating-math.test.ts`, `tests/ratings.test.ts` (a corrected result replays to the same ratings as a rebuilt ledger, interleaved results) and `tests/rating-matchmaking.test.ts` |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 20 files; 80 of 80 |
| CI | Not run (deferred) |
| Real services | None checked: team and tournament-day messages through the outbox only; the WhatsApp template `mysenam_tournament_day` is prepared, not submitted to Meta |

The one failure on each engine was a test listing the signed-in MCP tools that
had not taken the new public tool `venue_rankings`; it was corrected, and the
file passed on both engines after the commit. There are no acceptance
scenarios yet for teams, team leagues, tournament day or ratings: they are
tested below the browser, and a scenario for each is a next step. Gaps: no live
integration has passed its check; machine-assisted Malay, Chinese and Tamil
await native review; the claims archive was measured on a development
container, not at production size.

#### 3 November 2026, commit `5b11351`

The owner's request of 2 November 2026: multi-visit passes sold online
(migration 0264), bowling sold by the game with a lane given on arrival
(0265), and entry with no set time with day passes and gym entry on a
membership (0266); a lost chargeback on a membership now credits its receipt
(M31). Not a launch. Run on one cloud container, Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 114 passed |
| Suite on PGlite | 402 files (3 Postgres-only skipped); 4428 passed, 5 failed, 12 skipped; the 5 corrected and passed (below) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 402 files; 4440 passed, 5 failed; the 5 corrected and passed (below) |
| The new work inside both suites | Among them: `tests/passes-online.test.ts` (issued once with webhook and return racing), `tests/bowling-games.test.ts` (the race for the last free lane), `tests/entries.test.ts` (eight admissions at once for three places), `tests/membership-purchases.test.ts` (M31) |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`) | 20 files; 79 of 80; Guide H corrected and passed (below) |
| CI | Not run (deferred) |
| Real services | None checked: passes paid through the Stripe and Billplz stand-ins only |

The six failures were tests stating what had just changed: four still took gym
entry, climbing day passes or bowling by the game for things not built (now
built; they take archery's range officer, then not built (rostered range officers
were built on 5 November 2026), and check the new ones are no longer listed), and one fixed its booking on 2 November, past by
the run (it now books tomorrow). The tests were corrected, not the code: the
four unit files passed on both engines and the scenario file against the
same build, after the commit. Gaps: no live integration has passed its check;
machine-assisted Malay, Chinese and Tamil await native review.

#### 2 November 2026, commit `af5ddb5`

The owner's initiative of 31 October 2026, personalised venue onboarding: the
public guide *How MySenam fits your business*, the adaptive setup journey over
the venue's real configuration with launch readiness, the deterministic
playbook for manager, front desk and coach, contextual help and capability
discovery ([venue guide](../features/venue-guide.md), ADR 0028); then, at the
owner's request of 1 and 2 November, the MCP server for AI assistants in three
layers ([MCP](../integrations/mcp.md), ADRs 0029 and 0030) and the image
standard ([images](images.md)). Not a launch. Run on one cloud container,
Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 114 passed |
| Suite on PGlite | 399 files (3 Postgres-only skipped); 4373 passed, 12 skipped |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 399 files; 4385 passed |
| Guide, MCP and pictures inside both suites | Among them: `tests/guide-*.test.ts` (profile, plan, setup journey, playbook, public guide, help and discovery), `tests/mcp.test.ts` and `tests/mcp-oauth.test.ts` (protocol, keys, scopes, personal data hidden by default, PKCE, token rotation and reuse, grants ended on role change, configuration tools against the dashboard's routes), `tests/public-api.test.ts`, `tests/glyphs.test.ts`, `tests/activity-pictures.test.ts`, `tests/site.test.ts` |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), the venue guide's A to I among them (`tests/uat/guide*.uat.ts`) | 20 files; 80 of 80 |
| CI | Not run (deferred) |
| Real services | None checked: payments against the fake gateways and the Billplz stand-in, messages through the outbox only, the MCP server and its OAuth sign-in through the route handlers and a browser, never from claude.ai, ChatGPT or another real assistant |

Earlier full runs on the way found, and this one confirms fixed: provider
credentials of the cloud session reaching a second acceptance server (S33,
its remainder); 76 public phrases naming the site directly instead of
`{site}`; a scenario counting rows before the list was read again after a
save; a test that failed on Mondays (its week-later booking past the
14-day window). Two runs were cut short when the container was recycled
while idle. Gaps: no live integration has passed its check; machine-assisted
Malay, Chinese and Tamil await native review; the pictures are drawn
in-house, not by a designer.

#### 30 October 2026, commit `9db93d4`

The owner's decisions closing round 9 (29 October 2026), reconciled before
real-service verification: what the venue cancels (a court out of service, a
class or tournament called off, shares paid by other players) refunded through
the gateway where it can and otherwise owed for staff, under one policy; a test
booking never hiding real money (the cash-up's test block, the period report and
export, clearing with the manager's word on whether real money was taken, a
payment once live making a test real, going live refused with a paid test
standing, a paid test at a live venue in the consolidated e-invoice; S31); and a
MyInvois submission whose outcome is unknown shown as needing verification,
never resent blindly, reconciled from LHDN's identifiers with its history kept.
Not a launch. Run on one cloud container (four cores), Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed on `1e9c07d` |
| Documentation checks (`npm run docs:check`) | 108 passed on `1e9c07d` |
| Suite on PGlite | 375 files (3 Postgres-only skipped); 3884 passed, 12 skipped, on `9db93d4` |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server, `max_locks_per_transaction` 256) | 375 files; 3896 passed, on `9db93d4` |
| Concurrency, money and security inside both suites | Among them: `tests/venue-cancel-refunds.test.ts` (the venue's cancellations refunded once, asked again sends nothing), `tests/test-bookings-money.test.ts` and `tests/test-bookings.test.ts` (the trigger, the cash-up's test block, clearing, going live), `tests/einvoice-sending.test.ts` (an unknown outcome never sent again by the scheduler, confirmed sends once, portal identifiers checked), `tests/counter-owed.test.ts`, `tests/aside-writes.test.ts`, `tests/roles.test.ts`, `tests/staff-log-coverage.test.ts` on both engines |
| Build (`npm run build`) | Succeeded on `1e9c07d` |
| End-to-end tests against that build | 3 files; 12 passed, on `1e9c07d` |
| Acceptance scenarios against that build (`npm run uat`) | 17 files; 71 of 71, on `1e9c07d` |
| CI | Not run (deferred) |
| Real services | None checked: payments against the fake gateways and the Billplz stand-in (Stripe refunds against a stand-in), messages through the outbox only, MyInvois against a stand-in, Google sign-in against a stand-in |

The full run on `1e9c07d` passed type-check, lint, docs, build, end-to-end and
all 71 acceptance scenarios; its unit suites failed 11 tests on each engine:
two report fixtures in component tests lacked the new test-takings line, and
nine tests of the desk's tab scans timed out at two minutes under the full
run's load (the file passes alone in 87 seconds). The fixtures were corrected and
the file's timeouts raised to five minutes; the two unit suites were then run
again alone on `9db93d4` (the later commit changes only those tests, which
the type-check and lint cover), and are the results above. Gaps: no live
integration has passed its check; the LHDN lookups and which failures leave a
document possibly held there are assumed from the published API; machine-assisted
Malay, Chinese and Tamil await native review.

#### 29 October 2026, commit `d9925bf`

Round 9, the rest of the operations audit's operator self-service: staff
invited by email to choose their own password, a branch manager adding and
removing their own front desk, the desk shown only what it may do, in
competitions and the set-up checklist too (B59, B60, B63, S30); opening hours
and court rates from a later date (ADR 0027), narrowing refused while
bookings fall outside (B61, B62); a new branch started from another's set-up;
bookings made before going live marked as tests, out of the figures, cleared
or kept by a manager; staff alerts in each reader's language; a class's or
tournament's new name told to those in it; e-invoices sent to LHDN once; a
weekly series moved as a whole; counter money owed back after the venue
cancels, handed back by a named person (M29); the day list in time order; and
what the suites found (S29). Not a launch. Run on one cloud container (four
cores), Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed on `d9925bf` |
| Documentation checks (`npm run docs:check`) | 107 passed on `d9925bf` |
| Suite on PGlite | 373 files (3 Postgres-only skipped); 3833 passed, 12 skipped, on `d9925bf` |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server, `max_locks_per_transaction` 256) | 373 files; 3845 passed, on `d9925bf` |
| Concurrency, money and security inside both suites | Among them: `tests/aside-writes.test.ts` (a serialization failure inside a log write runs the transaction again), `tests/membership-suspensions.test.ts` (a suspension racing a booking), `tests/einvoice-sending.test.ts` (the scheduler and staff sending at once), `tests/entry-races.test.ts` (places lowered racing an entry), `tests/counter-owed.test.ts` (two staff settling at once), `tests/series-moves.test.ts` (a week taken between preview and move), `tests/dated-changes.test.ts`, `tests/test-bookings.test.ts`, `tests/branch-copy.test.ts`, `tests/staff-accounts.test.ts`, `tests/roles.test.ts`, `tests/staff-log-coverage.test.ts` on both engines |
| Build (`npm run build`) | Succeeded on `d9925bf` |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), the desk's scenarios in Invitations AA, Suspension AD and Classes AO rewritten for a desk offered no manager control | 17 files; 71 of 71 |
| CI | Not run (deferred, above) |
| Real services | None checked: payments against the fake gateways and the Billplz stand-in, messages through the outbox only (the acceptance server logs them), MyInvois against a stand-in, Google sign-in against a stand-in |

The branches were merged one at a time, each followed by a full run
(`2141550`, `205db46`, `cd00c0e`, `0d6c966`, `085184f`, `d2f3477`). The run on
`2141550` passed 67 of 71 acceptance scenarios: three were the desk's
scenarios clicking controls round 9 now keeps from the desk, rewritten to
check that none is offered and the server refuses, and one a dropped
connection; re-running them found B60 (the desk could not open what it is
shown read-only), fixed before `205db46`, all green. The run on `cd00c0e`
passed 70 of 71, the other B62, fixed and passing alone at the next commit.
The run on `0d6c966` failed two Postgres tests: one the defect S29 (a staff
log write swallowing a serialization failure, leaving its transaction
aborted), the other a test counting a background drain's statement as the
request's own; both fixed with tests. `085184f` and `d2f3477` were green
throughout. Gaps: no live integration has passed its check;
machine-assisted Malay, Chinese and Tamil await native review; the suites run
on today's date only.

#### 29 October 2026, commit `266a7f9`

The owner's round 8 decisions: e-invoice lines naming nobody and e-invoice
records kept for the statutory period, apart from optional customer details;
a language of their own for staff, coaches and a venue's booking alerts;
guests counted wherever they are registered, walk-ins apart. And the
operations audit of 28 October 2026 (45 of its 50 findings): counter payouts
and staff cancellations of paid bookings and of a series' weeks (M22),
corrections of a booking's details, the day list's filters, actions menu and
day sheet; payment methods on every counter sale, the cash-up, counter prices
from the venue's lists and a manager's price adjustment; every staff write in
the activity log (S28, B52), the schedule's own day (B51), alerts for online
cancellations and changes, classes and tournaments changed after set-up
(M23); money on erasure, voids, account cancellations and late fees (M24–M28)
and entry and split races (B53, B54); the two-factor gate on every staff path,
sealed calendar feeds, length limits, malformed bodies and local refund dates
(S26, S27, B48–B50); safe redirects, booking links, offers shown before they
are claimed, failed payments, the account page, promo codes checked before
booking, giving a court back late, guest bookings on the account, classes paid
online; the booking form on a phone, answers that are not the app's, leaving a
waiting list, the venue's number, the dashboard's address and refresh, weekday
dates, dialogs and field names (B55, B56); and what the acceptance scenarios
found (B57, B58). Not a launch. Run on one cloud container (four cores),
Node 22.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed on `3604266` |
| Documentation checks (`npm run docs:check`) | 106 passed on `3604266` |
| Suite on PGlite | 360 files (3 Postgres-only skipped); 3686 passed, 12 skipped, on `266a7f9` |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server, `max_locks_per_transaction` 256) | 360 files; 3698 passed, on `266a7f9` at the second attempt (the first timed out in the set-up hooks of three files under the suite's own load, then passed alone in 7 seconds) |
| Concurrency, money and security inside both suites | Among them: `tests/entry-races.test.ts`, `tests/split-races.test.ts`, `tests/price-adjustments.test.ts` (adjustments at once), `tests/class-changes.test.ts` (a cut racing an enrolment), `tests/waitlist-leave.test.ts` (a decline racing a claim), `tests/guest-counting.test.ts` (two guests for one host at once), `tests/counter-refunds.test.ts`, `tests/erasure-money.test.ts`, `tests/staff-two-factor-gate.test.ts`, `tests/bad-bodies.test.ts`, `tests/staff-log-coverage.test.ts` (every admin write handler) on both engines |
| Build (`npm run build`) | Succeeded on `3604266` |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Counter AI, Prices AJ, Late AK, Links AL, Waitlist AM, Alerts AN and Classes AO among them | 17 files; 71 of 71 |
| CI | Not run (deferred, above) |
| Real services | None checked: payments against the fake gateways and the Billplz stand-in, messages through the outbox only (the acceptance server logs them), MyInvois against a stand-in, Google sign-in against a stand-in |

The first full run, on `1f78e54`, passed 54 of 64 acceptance scenarios: eight
were written for screens round 8 changed on purpose (the day list's actions
menu, weekday dates, the booking form's order, the dashboard's address) and
were brought up to date without weakening them; two were defects (B57, B58),
fixed with tests. Its unit suites failed three tests and the next run's two,
all on the clock rather than the product: the two-factor tests' fake clock was
fixed on a date a week before the database's own (sessions lapsed), the
participants migration test compared columns added after it, and two tests'
bookings fell on a weekend once the date moved (all peak, or past closing);
each now holds on any date, and the suites above ran after. Gaps: no live
integration has passed its check; machine-assisted Malay, Chinese and Tamil
await native review; the suites run on today's date only, so a test that
depends on the weekday or the hour is found only when the date reaches it.

#### 26 October 2026, commit `8f62ccf`

Participants apart from accounts (ADR 0023), booking for somebody else on
every path, a second guardian at the counter, approval status for who is
taking part in search, supporting documents scanned for malware before
release and install retention periods provisional until reviewed (ADR 0024),
erasures re-applied after a restore. Not a launch. Run on one cloud
container, Node 22. The suites, build and end-to-end tests ran on commit
`6fc3bd8`; `8f62ccf` changed only two acceptance scenarios' expected wording
(the refusal now names the child), after which their file was run again
against the same build.

| Check | Result |
| ----- | ------ |
| Type-check, lint (`--max-warnings 0`) | Passed |
| Documentation checks (`npm run docs:check`) | 102 passed (with this record's documentation, the commit after) |
| Suite on PGlite | 229 files; 2602 passed, 4 skipped (Postgres-only tests) |
| Suite on Postgres 16 (`TEST_DATABASE_URL`, local server) | 229 files; 2606 passed |
| ClamAV engine (`tests/document-scanning-engine.test.ts`, inside both suites) | clamd 1.5.4 from Ubuntu's packages in this container, with a locally generated test signature; ClamAV's official signatures could not be downloaded here |
| Build (`npm run build`) | Succeeded |
| End-to-end tests against that build | 3 files; 12 passed |
| Acceptance scenarios against that build (`npm run uat`), Participants A–F and Documents E among them | 11 files; 30 of 32 at `6fc3bd8` (Participants A and C waited for the refusal's old wording), then the participants file 5 of 5 at `8f62ccf`: 32 of 32 |
| CI | Not run (deferred, above) |
| Real services | None checked: payments against the fake gateways, messages through the outbox only, documents scanned by a stand-in in the acceptance scenarios |

Gaps: ClamAV's official signatures, freshclam and the scanner on a real
droplet are unverified; no live integration has passed its check;
machine-assisted Malay, Chinese and Tamil (the participant, guardian,
scanning and eligibility text among them) await native review; the
retention periods are product policy awaiting Malaysian and Singaporean
legal review.
