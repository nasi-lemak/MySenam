# Deploying and upgrading

Authoritative for putting MySenam into production and keeping it there. The ready-made kit is in [`deploy/digitalocean`](../../deploy/digitalocean/README.md).

## Deploying

Production runs against a Postgres server, version 16 or later:

```bash
npm ci
npm run build
DATABASE_URL=postgres://mysenam:…@127.0.0.1:5432/mysenam npm start
                   # listens on 3000; put a TLS-terminating proxy in front
```

The schema is created on the first database query after a start, and moved
on by every later start: the
files in `db/migrations` are applied in order, each once, under a lock, so two
servers starting together do not both run one.

The ready-made way to run it is one DigitalOcean Droplet with Postgres, the app
and Caddy on it, set up by a script and deployed by another. See
[`deploy/digitalocean/README.md`](../../deploy/digitalocean/README.md).

## Behind a proxy

Two things depend on the proxy being configured properly:

- **Session cookies** are marked `Secure` when the request arrived over HTTPS,
  which is read from the request rather than from a build flag. The proxy must
  set `X-Forwarded-Proto`, or cookies will not carry the flag.
- **Rate limits** identify a client by `X-Forwarded-For`. If the proxy does not
  set it, every request looks like one client and the limits apply to the whole
  internet at once. It must also *replace* what the visitor sent rather than add
  to it, or a visitor can pick their own address. The DigitalOcean kit's
  Caddyfile does both.

`GET /api/health` answers `{"ok":true}` while the database is readable, and
`503` when it is not. It deliberately says nothing else — anything reachable by
the load balancer is reachable by everyone else too.

## The malware scanner

Supporting documents sent with applications are scanned by ClamAV's daemon,
clamd, before anybody can open them
([security](../architecture/security.md#malware-scanning);
[ADR 0024](../architecture/decisions/0024-documents-scanned-before-release-retention-by-purpose.md)).
The app talks to it over TCP at `MYSENAM_CLAMD` (`127.0.0.1:3310`); it needs no
npm package and no paid service, and no document leaves the machine. Every
guarantee is the same however clamd runs: documents wait in quarantine, only a
real scan with the official signatures releases one, the result is bound to
the exact bytes, and nothing is released because a scanner was missing or
could not start.

### Choosing how clamd runs

| Mode (`setup.sh --scanner=`) | For | What runs | A document sent while nothing is scanning |
| --- | --- | --- | --- |
| `on-demand`: the default below 3.5 GB of memory | **The 2 GB Droplet** (the owner's choice, 27 October 2026: no upgrade) | The app starts clamd itself (`MYSENAM_CLAMD_ONDEMAND`) when documents wait and no scanner answers, and stops it after `MYSENAM_CLAMD_IDLE_MINUTES` (5) with nothing waiting; freshclam runs from a timer, never beside it | Waits for the scheduler's next tick (up to a minute), clamd's start (about 10–16 s measured; longer on a slower CPU) and the scan; documents sent while clamd is up are scanned at once |
| `always-on`: the default from 3.5 GB | A 4 GB Droplet or larger, or a separate scanner machine (any clamd the app reaches at `MYSENAM_CLAMD`, such as the official `clamav/clamav` image) | Ubuntu's `clamav-daemon` all the time, and `clamav-freshclam` hourly | Scanned at once, in the upload |
| `none` | No documents to take yet | Nothing | Waits in quarantine, unopened, until a scanner is set up |

Choose `on-demand` on the 2 GB Droplet, where clamd kept running beside the
app and Postgres would leave no room for freshclam, a deploy's build or a
burst (below). Choose `always-on` where memory allows, or where documents must
be released within seconds of arriving. Switching is running `setup.sh` again
with the other `--scanner`; it adds the settings it needs, and says which to
remove.

### Running and watching it

- **The on-demand scanner.** clamd runs as the app's own user, in the
  foreground, as a child of the app, from `/etc/mysenam/clamd-ondemand.conf`
  (loopback only: clamd has no authentication; no settings or secrets in its
  environment). One at a time: the scheduler's lease makes one instance the
  scheduler, and a lock file in `/var/lib/mysenam/scanner/` names the app
  process, its clamd and the boot, so a second process does not start
  another. It is started only while `MemAvailable` is above
  `MYSENAM_CLAMD_MIN_MEMORY_MB` (1,200 MiB) and no freshclam runs (a process
  of that name, or the timer's lock file); otherwise documents keep waiting,
  and the owners are told after 30 minutes. clamd must answer PING within
  `MYSENAM_CLAMD_START_SECONDS` (120 s), or it is stopped (SIGTERM, then
  SIGKILL after 10 s) and tried again after 1, 2, 5, 10 and 30 minutes, then
  hourly; a clamd that exits by itself, mid-scan or not, is recorded as a
  crash, the document it was scanning stays `pending` and is tried again, and
  the owners are told. Children are always waited for (no zombies). When the
  app stops, its clamd stops too: the app tells it to, and systemd stops
  every process in the service. A clamd left running by an app process that
  died elsewhere is stopped by its exact pid (checked against its command
  line) at the next tick.
- **Installing it.** The DigitalOcean kit's `setup.sh` installs Ubuntu's
  `clamav-daemon` and `clamav-freshclam` (`--scanner=always-on` or
  `on-demand`), and sets `ConcurrentDatabaseReload no`, `StreamMaxLength 12M`
  and `MaxThreads 2`. Always-on: clamd listens on the loopback only (a systemd
  socket drop-in) beside its local socket, and `MYSENAM_CLAMD=127.0.0.1:3310`
  goes into `/etc/mysenam/env`. On demand: the packaged services are disabled;
  it writes `/etc/mysenam/clamd-ondemand.conf`, lets the `mysenam` user read
  the signatures (group `clamav`), installs `mysenam-freshclam` with its timer,
  fetches the first signatures, and adds `MYSENAM_CLAMD` and
  `MYSENAM_CLAMD_ONDEMAND` to `/etc/mysenam/env`. `--scanner=none` (or the
  older `--no-scanner`) leaves the scanner out. It also adds a 2 GB swap file:
  a safety net against an out-of-memory kill, not capacity; nothing is sized
  to run in it.
- **Memory and disk.** ClamAV's own documentation gives "upwards of 1.2 GiB
  of RAM simply to load the signature definitions", recommends a minimum of
  3 GiB and preferably 4 GiB for the machine, and puts its container with the
  signature database at about 300 MB compressed, 456 MB uncompressed
  ([ClamAV: Docker](https://docs.clamav.net/manual/Installing/Docker.html));
  that is for a clamd kept running. Measured in the development container on
  27 October 2026 with the official signatures (daily 28165, main 63,
  bytecode 339; ClamAV 1.5.4, the kit's settings; **one container's figures,
  not a Droplet's**): clamd's resident memory was **969–972 MiB** once
  loaded, and its peak **1,038 MiB** through a reload in place; freshclam's
  own peak while fetching the full set was **about 700 MiB** with
  `TestDatabases yes` (it loads each new database once to test it; 14 s) and
  **about 310–320 MiB** with `TestDatabases no` (4 s); the production app
  about **334 MiB** (proportional set size) and Postgres about **100 MiB**
  at rest (configured for up to about 300 MB: 281 MB of shared memory,
  the lock table included, [database](../architecture/database.md#the-lock-table-on-the-2-gb-droplet)). App, Postgres and clamd come
  to about **1.45 GiB**: on a 2 GB Droplet (about 1.9 GiB usable, ESTIMATE)
  that fits only if clamd is not resident while freshclam runs, nor while
  nothing waits. The on-demand mode is built on exactly that: clamd only
  while documents wait, freshclam (about 700 MiB beside about 0.45 GiB) only
  while clamd is stopped, and a start only while 1,200 MiB is free (clamd's
  peak and about 200 MiB to spare), which also keeps clamd from starting in
  the middle of a deploy's build. Always-on, freshclam tests before clamd
  reloads, so the two peaks do not coincide: about 1.7 GiB for both at the
  worst moment, which is why always-on wants 4 GB. A routine update tests
  only the database that changed (usually the smaller daily one), so the full
  download is the upper bound. Reloading signatures in place, rather than
  beside the old ones, keeps it to one copy in memory at the price of scans
  pausing during a reload: documents wait in quarantine and are retried.
- **Measured on demand** (the development container, 27 October 2026,
  `tests/clamd-on-demand-engine.test.ts`, official signatures, three runs):
  clamd started by the app answered PING after **10.3–10.6 s** (11.3 s with
  clamd held to one CPU); a document sent while clamd was stopped was
  released **10.4–10.7 s** after it arrived, when the scheduler's tick came at
  once (in production add up to a minute for the next tick); clamd's peak
  resident memory (`VmHWM`) was **972 MiB**. A Droplet's shared vCPU may be
  slower: measure there (launch check below).
- **`TestDatabases`.** The kit leaves freshclam's default, `yes`, in both
  modes: a new database is loaded once by freshclam before clamd uses it, so
  a database that is corrupt or that this engine cannot load is caught there
  and clamd keeps the one it has. `no` saves about 380 MiB at the update's
  peak and some seconds; freshclam still checks each database's digital
  signature (a `.cvd` is signed by ClamAV), but an unloadable database would
  then reach clamd, whose load could fail and leave documents waiting in
  quarantine until it is fixed. On demand, `yes` fits, because freshclam
  never runs beside clamd. Keep `yes` unless memory forces otherwise.
- **Signatures.** Always-on, `clamav-freshclam` fetches the official
  signatures from ClamAV's mirrors and checks for new ones every hour
  (Ubuntu's default `Checks 24`); clamd reloads them by itself. On demand,
  `mysenam-freshclam.timer` runs freshclam twice a day (04:17, after the
  nightly backup, and 16:17, Malaysia and Singapore time), through
  `mysenam-freshclam`, which marks that it runs and waits (up to an hour) for
  the app's clamd to stop first, or skips that update; the app, in turn, does
  not start clamd while freshclam runs. clamd loads the newest signatures at
  each start. A signature database more than 48 hours old, or one that does
  not say its date, is raised to the owners; while the on-demand clamd is
  stopped its date is read from the database's header on disk. clamd cannot
  scan until freshclam has the first signatures, a few minutes on a new
  machine; until then documents wait in quarantine.
- **Health.** The owner's *Supporting documents* panel shows whether clamd
  answers, its engine and signature version and age, and documents waiting,
  refused or failed; on demand, also whether clamd is running, its last
  start (when, how long it took to answer, its peak memory), its last stop
  and why, the memory free now against the threshold, why a start is held
  back, and the last failure. The scheduler raises `document-scanner` every
  hour while something is wrong, and `document-scanner-ondemand` as soon as
  an on-demand start fails or clamd crashes, and once a start has been held
  back for 30 minutes ([monitoring](monitoring.md)). An on-demand clamd
  stopped on purpose is not reported as "not answering". Always-on, systemd
  restarts clamd if it stops. `/api/health` does not include it: a scanner
  that is down holds documents back, it does not take the site down.
- **Failure and recovery.** While clamd is away, documents stay `pending`
  (never openable) and are retried after 1, 5, 30, 120, 360 and 720 minutes.
  After the seventh try, about 20 hours on, a document whose last try found
  no scanner is `failed` **waiting for a scanner**: kept, never openable,
  never removed for that, and put back in quarantine by the scheduler as soon
  as clamd answers again (within a minute), then scanned. Nothing needs doing
  by hand, and nothing needs restoring: the scanner holds no data of the
  app's, and its signatures are fetched again. A document a working clamd
  could not scan (over `StreamMaxLength`, or no answer for that document) is
  `failed` for good and goes after the quarantine period.
- **Scanning one again.** The platform owner's *Supporting documents* panel
  lists failed documents (number, venue, activity, kind and size; never the
  contents or who sent them) with a *Scan again* action that asks for a
  reason: for example after raising `StreamMaxLength`. It puts the same bytes
  back in quarantine, only if they are still there and match the hash taken
  when they were checked, at most three times per document; otherwise the
  applicant has to send it again. Each request and its outcome are kept
  with the document and in the staff activity log
  ([security](../architecture/security.md#malware-scanning)).
- **Without a scanner** documents are still taken, into quarantine: they wait
  there, never openable, and an application that needs one cannot be
  approved, until a scanner is configured and passes them. There is no
  setting to release documents unscanned: `MYSENAM_DOCUMENT_SCAN=off` was
  withdrawn on 27 October 2026 and is ignored, with a start-up warning where
  it is still set. A production start without `MYSENAM_CLAMD` (or a usable
  `MYSENAM_CLAMD_ONDEMAND`) warns too, and the hourly check tells the owners
  once documents are waiting.
- **Upgrading to migrations 0159–0160.** Documents taken unscanned under the
  withdrawn setting go back into quarantine and are scanned; until then
  nobody can open them. Documents stored before scanning existed, or that
  failed only because no scanner was configured, are marked and kept until a
  scanner passes them or their own retention period ends
  ([privacy](../architecture/privacy.md#applications-to-be-approved-for-an-activity)).
  Configure the scanner, and they are scanned within a minute or two.

**Verified in the development container on 27 October 2026**: freshclam
fetched the official signatures from ClamAV's mirrors over HTTPS, with TLS
verification on (its first attempt there had failed with *Problem with the SSL
CA cert*: the container pointed it at a CA bundle in a folder the `clamav`
user cannot read; pointing `CURL_CA_BUNDLE` at the system store fixed it, a
quirk of that container, not of a Droplet); clamd 1.5.4 with them found the
EICAR test file as `Eicar-Test-Signature` and released a plain PDF through the
app (`tests/document-scanning-engine.test.ts` with `MYSENAM_TEST_CLAMD`), with
the memory above. The official signatures find the EICAR file only as the
EICAR standard defines it (the string at the start of the file), not inside a
PDF. The on-demand scanner started that clamd itself with the official
signatures, scanned a plain PDF clean and refused the EICAR file, and stopped
it when idle (`tests/clamd-on-demand-engine.test.ts`, the measurements above);
every guard path runs against a stand-in clamd (`tests/clamd-on-demand.test.ts`,
including the kit's `freshclam.sh` against a stand-in freshclam). **Not
verified**: the kit's scanner set-up (either mode), its memory and clamd's
start time on a real Droplet, the freshclam timer, and signature updates over
days. Each is a launch check below.

## Upgrading

Migrations run when the app starts, so a deploy is build, restart, done.
**Take a backup first** (`npm run backup`; see [backups](backups.md)), because a migration cannot be undone
from inside the app. The DigitalOcean kit's deploy script takes one with the
live version, just before it switches to the new one, and puts the old version
back if the new one does not answer.

Rolling back past a migration means restoring that backup and deploying the
previous version: putting the old code back alone is not enough once a
migration has changed the schema. This matters most for the upgrade to
interval bookings (migrations 0089–0091): 0090 checks that the new claims hold
exactly what the half-hour diary held and stops, changing nothing, if not;
0091 then drops the diary for good
([booking time model](../architecture/booking-time-model.md#migration-from-the-half-hour-diary)).
Restore the backup into a scratch database first to know it works
([backups](backups.md)).

## Staging before a release

Try a release on staging first: `npm run stage -- run` builds the image from
the commit, runs it on its own Postgres with synthetic data, runs the smoke,
browser and acceptance suites against it, keeps the evidence and removes
everything; `scripts/stage-remote.mjs` does the same on a DigitalOcean
droplet once a spend is agreed ([testing](../development/testing.md#staging-and-real-services)).
Never copy a production database into staging, and never keep a database
with real customers in it as a test fixture.

## Before going live: what only a live account can prove

The tests run every gateway and API against recorded answers, not the real
services. Before taking real money or sending real messages, check each of
these once with a real account, in its sandbox where it has one:

- [ ] **Secrets**: `ADMIN_EMAIL` and an `ADMIN_PASSWORD` of 12 characters or
      more set before the first start (without it production makes no owner
      and refuses the published default); `MYSENAM_SECRET` set and
      kept out of backups; two-factor sign-in on for the owner account.
- [ ] **Email**: either Amazon SES over HTTPS (`SES_ACCESS_KEY_ID`,
      `SES_SECRET_ACCESS_KEY`, `SES_REGION`, `MAIL_FROM`; SES wins if
      `SMTP_URL` is set too) or SMTP (`SMTP_URL`, `MAIL_FROM`; ports 25, 465
      and 587 are refused by many cloud hosts, so check the host allows them).
      A booking confirmation arrives in an inbox, not spam (DKIM and DMARC on
      the sending domain), with its calendar invite, and a venue's news
      shows the mail app's own unsubscribe button. With SES, the account has
      production access (not the sandbox), the sending domain is verified,
      and `node scripts/verify-integrations.mjs email --send` passes
      ([email transports](../integrations/messaging.md#email-transports)).
- [ ] **WhatsApp**: every template under *Messages to customers* submitted
      and approved by Meta in each language, word for word; a confirmation
      and a waitlist offer arrive; the delivery webhook reaches
      `/api/whatsapp/webhook` (a message shows *delivered* under Messages).
- [ ] **Billplz** (Malaysia): a sandbox bill paid by FPX and by card marks
      the booking paid by callback and by redirect; the X-Signature key is
      checked (a tampered callback is refused); a held booking's bill expires
      with its hold.
- [ ] **Stripe** (Singapore, renewals): a test-mode checkout paid; the
      webhook secret checked; a refund from *Refunds owed* goes through; a
      test dispute (card `4000 0000 0000 0259`) shows under Disputes and, lost,
      takes back what it paid for; a renewing membership charges again; a
      refund made in Stripe's own dashboard (`charge.refunded`) is recorded
      once and emails the venue's staff, with the booking unchanged. On a
      marketplace paying through Stripe, the platform's own webhook takes the
      `charge.dispute.*` and refund events too, and a test dispute on an
      invoice emails the owners.
- [ ] **MyInvois** (Malaysia): the sandbox (preprod) accepts a consolidated
      e-invoice and a single one, with the venue's own TIN and certificate.
- [ ] **Google sign-in**: the redirect URI registered matches
      `<MYSENAM_URL>/api/auth/google/callback`.
- [ ] **Backups**: the nightly backup runs, the off-site copy lands whole
      (its manifest is in the bucket), and the off-site drill passes on an
      isolated server ([backups](backups.md#restoring-from-the-off-site-copy)).
      `npm run verify-offsite -- --go` passes against the real bucket with
      synthetic data ([backups](backups.md#verifying-a-real-bucket)).
      The erasure ledger's segments land under `erasure-ledger/` (or in
      `OFFSITE_LEDGER_S3_BUCKET` with its own upload-only key), covered by
      the same Object Lock and lifecycle rule
      ([the erasure ledger off-site](backups.md#the-erasure-ledger-off-site)).
      `OFFSITE_DATA_LOCATION` names the bucket's country; a bucket abroad (B2,
      the preferred provider, always is) only once the transfer safeguards
      are recorded
      ([privacy](../architecture/privacy.md#backups-held-abroad)).
- [ ] **Operating company and data location decided**: the entity running
      each install, its tax registration, and where the database, photos and
      backups are hosted, written into the privacy notice and venue
      agreement ([launch providers](../integrations/launch-providers.md#operating-company-and-jurisdictions)).
- [ ] **The scheduler**: `/api/health` shows its heartbeat a minute old at
      most, so holds, reminders, offers and backups happen on time.
- [ ] **The malware scanner**: on the 2 GB Droplet with `--scanner=on-demand`
      (or a 4 GB one, always-on), freshclam has fetched the official
      signatures (`journalctl -u mysenam-freshclam`), a plain PDF sent with an
      application is released, the *Supporting documents* panel shows the
      last start with its load time and peak memory and, a few minutes later,
      clamd stopped as idle with signatures under a day old; the EICAR test
      file is refused; `MemAvailable` before a start, clamd's load time and
      the time a 10 MB PDF takes are noted, and a timer run of
      `mysenam-freshclam` is seen to wait for clamd to stop
      ([the malware scanner](#the-malware-scanner)).
- [ ] **Retention periods reviewed**: a lawyer in each country has answered
      the [open questions](../architecture/privacy.md#open-questions-for-professional-review-retention-and-documents),
      the install's periods are set accordingly, and the review is recorded
      under *Supporting documents*; until then they show as provisional.
- [ ] **Terms and privacy**: `OPERATOR_NAME`, `OPERATOR_EMAIL` (and
      `OPERATOR_ADDRESS`, `OPERATOR_REG_NO`) set, so `/terms` names the
      operator and `/privacy` says who to write to; a lawyer has read both,
      and the translations.
- [ ] **Somebody owns incidents**: an incident lead named, the owners' alert
      email and uptime monitor working, and the
      [incident-response](incident-response.md) breach rules confirmed by a
      lawyer.
- [ ] **A real venue, end to end**: book, pay online, get the messages,
      check in at the desk, cancel one late, see it in the reports and the
      accounting export.

### Launch integration checklist

What each launch service needs before it can be verified, how to verify it,
and what the local tests already cover (against stand-ins only). Which
providers to choose is [launch providers](../integrations/launch-providers.md). None of
these is verified yet; each stays `INTEGRATION_VERIFICATION_REQUIRED` in
[feature status](../product/feature-status.md) until its check passes, and
the result is recorded there with the date.

| Service | Needs first (from whom) | Verify by | Covered locally |
| ------- | ----------------------- | --------- | --------------- |
| Payment gateway — Billplz (MY) | A Billplz account and sandbox API key and X-Signature key (Billplz; business verification for live) | A sandbox bill paid by FPX and by card marks the booking paid by callback and by redirect; a tampered callback is refused; an expired hold's bill expires | `tests/payments.test.ts` |
| Payment gateway — Stripe (SG, renewals) | A Stripe account in test mode, a restricted key with Checkout Sessions and Refunds write, a webhook signing secret (Stripe; account activation for live) | A test checkout paid; the webhook signature checked; a renewal charges again | `tests/stripe.test.ts`, `tests/membership-renewal.test.ts` |
| Payment callbacks and webhooks | A public HTTPS `MYSENAM_URL` the provider can reach | Billplz callback and Stripe webhook deliveries succeed in each provider's dashboard; a replayed delivery records the payment once | `tests/payments.test.ts`, `tests/stripe-disputes.test.ts` |
| Refunds and reconciliation | The Stripe test account above (Billplz has no refund API: by hand) | A refund from *Refunds owed* goes through; one cancelled with the app stopped mid-request is finished by the scheduler once; a pending refund settles; a refund made on the Stripe test card whose refunds fail is owed again and raised | `tests/stripe-refunds.test.ts`, `tests/refund-crash.test.ts` |
| Transactional email | An SMTP account and a sending domain with SPF, DKIM and DMARC (the email provider; the domain's DNS owner) | A booking confirmation with its invite, a password reset and an application confirmation arrive in an inbox, not spam; a reset whose link has run out is not sent; a bounce is looked at in the provider's dashboard (not read back by the app) | `tests/outbox.test.ts`, `tests/platform-messages.test.ts` |
| Phone verification | WhatsApp: a Meta Business account, a verified number and approved templates (Meta, days to weeks). SMS: a Twilio or HTTP gateway account and, in Malaysia, sender registration | A code arrives and is accepted; the daily cap holds; the delivery webhook marks a message delivered | `tests/phone-methods.test.ts` |
| Object storage and restore | A private bucket (Backblaze B2, US West, preferred, once the transfer safeguards are recorded; Amazon S3 in the install's country supported) with Object Lock and a lifecycle rule; an upload-only key for the server, a read-and-list key, the encryption private key and the signing public key kept off it; `OFFSITE_DATA_LOCATION` set and matching the endpoint | `npm run verify-offsite -- --go --size-mb 200` passes with synthetic data and its report is kept; the nightly copy lands with its manifest, encrypted and signed; the upload key is refused a GET, a list, a delete and a retention change; an overwrite with the upload key leaves the first version restorable; `fetch-backup` and `restore --drill` pass on an isolated server; `secret.key` or `MYSENAM_SECRET` restored from where it is kept opens the payment keys; photos bucket uploads and serves a photo; an erasure's ledger segment lands signed and encrypted, and a restore on the isolated server reads it back | `tests/offsite.test.ts`, `tests/backup-scripts.test.ts`, `tests/erasure-ledger-restore.test.ts`, `tests/photos.test.ts` |
| Tax on money kept from hire deposits | A qualified accountant or tax adviser for each country (and each venue registered for SST or GST) | The adviser reviews each reason's treatment under *Tax*; changes are made; the manager records the review with the adviser's name. Until then every amount kept is marked provisional in the journal | `tests/hire.test.ts` |
| Live accounting to Xero (optional) | The install's decision that sending sales to Xero (kept outside the country) is approved, with a lawyer's answers; a Xero developer app (redirect address `<site>/api/admin/accounting/xero/callback`) and a Xero demo company; `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI` in the secret store, then `ACCOUNTING_PUSH_APPROVED=yes` | `node scripts/verify-xero.mjs consent` (the one manual approval) and then `node scripts/verify-xero.mjs` pass against the demo company and the report is kept; a venue connects, maps, and a paid sale and its refund appear in Xero as an invoice with its payment and a credit note with its refund, the *Check against Xero* totals matching ([Xero](../integrations/xero.md#verifying-against-a-demo-company)) | `tests/accounting-push.test.ts`, `tests/accounting-push-routes.test.ts`, `tests/xero-adapter.test.ts`, `tests/verify-xero.test.ts` (a stand-in Xero) |
| Legal review | A lawyer in each country | The open points in [privacy](../architecture/privacy.md#backups-held-abroad) answered before `OFFSITE_TRANSFER_APPROVED` is set (Backblaze's terms as the transfer contract, the TIA, roles, breach notice); the terms, privacy notice and venue agreement reviewed; whether a venue's refund period meets consumer law; what guardian consent the law asks for | Nothing: the app refuses the transfer until it is declared, and records consent as declared |
| Continuous integration | GitHub Actions able to start runners on the repository (the account's billing or spending limit) | A CI and a Docs run on the commit being launched start, run every step and pass | Every run since 16 October 2026 ended before a runner was assigned ([known limitations](../roadmap/known-limitations.md)); the suites have been run by hand only |
| Staging on DigitalOcean (optional) | A DigitalOcean team used for nothing else, a custom-scoped token (droplets, tags, registry read), a read-only registry credential, and an agreed spend per run | `scripts/stage-remote.mjs up --approve-usd …` serves the image on `sslip.io`, its tests pass, `down` leaves nothing billable | `tests/stage-remote.test.ts` (stand-in API) |
| Malware scanner (ClamAV) | The Droplet set up with `--scanner=on-demand` (2 GB, the owner's choice) or `always-on` (4 GB), and outbound access to ClamAV's signature mirrors | freshclam fetches the official signatures; the EICAR test file is found and a plain PDF released through the app; on demand, clamd starts when a document waits, stops when idle, and the freshclam timer waits for it; the hourly check stays quiet; clamd's memory, load time and scan time measured on the Droplet | `tests/document-scanning.test.ts` (stand-in scanner and stand-in sockets), `tests/clamd-on-demand.test.ts` (stand-in clamd and freshclam: every guard path), `tests/document-scanning-engine.test.ts` and `tests/clamd-on-demand-engine.test.ts` (real clamd 1.5.4: with a locally generated test signature, and, in the development container on 27 October 2026, with the official signatures, started on demand) |
| Performance under production-like conditions | A managed database across a real network, a production-size pool, two or more app instances | The [benchmark](../development/testing.md#results) re-run there, with the targets in the roadmap | One machine, database beside the app |
| Monitoring and alerts | An error-tracking DSN (`SENTRY_DSN`) and an owner email that receives alerts | A deliberate error reaches the tracker; a failed backup or off-site copy, and a `refund_failed` integrity problem, email the owners; `/api/health` is polled by an uptime monitor | `tests/alerts.test.ts`, `tests/integrity.test.ts` |

Missing today: every credential above. None is in this repository or its
test environment, and none should be: they go in the host's environment
variables ([configuration](../development/configuration.md)).

Not built here, and needing a partner or a contract first: Reserve with
Google's live booking server (the feeds are ready), Singapore's InvoiceNow,
smart locks, Stripe Connect payouts to venues, LINE and Zalo. Web push needs
no partner but is not built either ([roadmap](../roadmap/roadmap.md)).
