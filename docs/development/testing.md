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
| Email 1 | A booking's confirmation email is read from the server's log and its link opens My booking, showing that booking |
| Email 2 | A waiting-list offer's emailed link claims the place, the claimed booking's confirmation follows, and the link then offers nothing; meanwhile the held place is refused to the person who gave it up |
| Email 3 | A password-reset email's link sets a new password once; the old password is refused and the link then shows it has run out |
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
and *Documents E* and *I* are then skipped, as are *Email 1–3*, which read the emails from the acceptance server's log. The server also loads a stand-in for Billplz's sandbox
(`tests/uat/gateway.ts`, loaded by `tests/uat/gateway-preload.mjs`): it answers
the collection check and bill creation, serves a payment page, and sends
Billplz's signed callback and redirect. It is not Billplz and proves nothing
about the live service; *Membership O*, *Membership W*, *Family X*, *Places Y*
and *Guardians P* are skipped against a deployment, as are *Guests T* and
*Malay Z*, which read emails from the server's log. The app's output is kept as
`server.log` beside the evidence (`E2E_SERVER_LOG`); the server sends with
`MYSENAM_SEND=log`, so that file is where scenarios read the emails sent.

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
Actions tab. The owner has deferred paid CI for cost (October 2026); until a
run passes, CI is not evidence of anything. The suites are run by hand
(above), and each release's results are recorded below.

### Release records

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
