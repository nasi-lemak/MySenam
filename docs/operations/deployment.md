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
npm package and no paid service, and no document leaves the machine.

- **Installing it.** The DigitalOcean kit's `setup.sh` installs Ubuntu's
  `clamav-daemon` and `clamav-freshclam`, has clamd listen on the loopback
  only (a systemd socket drop-in) beside its local socket, sets
  `ConcurrentDatabaseReload no`, `StreamMaxLength 12M` and `MaxThreads 2`,
  and writes `MYSENAM_CLAMD=127.0.0.1:3310` into `/etc/mysenam/env` on a new
  machine (add it by hand on one set up before). `--no-scanner` leaves it out.
  Elsewhere, any clamd the app can reach works, including the official
  `clamav/clamav` container image, which runs clamd and freshclam together.
- **Memory and disk.** ClamAV's own documentation gives "upwards of 1.2 GiB
  of RAM simply to load the signature definitions", recommends a minimum of
  3 GiB and preferably 4 GiB for the machine, and puts its container with the
  signature database at about 300 MB compressed, 456 MB uncompressed
  ([ClamAV: Docker](https://docs.clamav.net/manual/Installing/Docker.html)).
  With the app (about 250 MB) and Postgres (about 300 MB) beside it, the 2 GB
  Droplet is too small: use the 4 GB one (USD 24 a month instead of USD 12;
  [kit](../../deploy/digitalocean/README.md#what-it-costs)). Reloading
  signatures in place, rather than beside the old ones, keeps it to one copy
  in memory at the price of scans pausing during a reload: documents wait in
  quarantine and are retried.
- **Signatures.** `clamav-freshclam` fetches the official signatures from
  ClamAV's mirrors and checks for new ones every hour (Ubuntu's default
  `Checks 24`); clamd reloads them by itself. A signature database more than
  48 hours old, or one that does not say its date, is raised to the owners.
  clamd does not start until freshclam has the first signatures, a few
  minutes on a new machine; until then documents wait in quarantine.
- **Health.** The owner's *Supporting documents* panel shows whether clamd
  answers, its engine and signature version and age, and documents waiting,
  refused or failed; the scheduler raises `document-scanner` every hour while
  something is wrong ([monitoring](monitoring.md)). systemd restarts clamd if
  it stops. `/api/health` does not include it: a scanner that is down holds
  documents back, it does not take the site down.
- **Failure and recovery.** While clamd is away, documents stay `pending`
  (never openable) and are retried after 1, 5, 30, 120, 360 and 720 minutes;
  after the seventh try, about 20 hours on, they are `failed` and the
  applicant is asked to send them again. Nothing needs restoring: the
  scanner holds no data of the app's, and its signatures are fetched again.
- **Without a scanner** documents are refused, with a message saying they
  cannot be checked now. `MYSENAM_DOCUMENT_SCAN=off` is the operator's
  explicit opt-out: documents are then taken and marked *not checked for
  malware* to the applicant and reviewers. A production start warns about
  either.
- **Upgrading to migration 0142.** Documents stored before it were never
  scanned: they become `pending` and are scanned by the scheduler. Configure
  the scanner before upgrading, or they fail after their tries (and go after
  the quarantine period) and their applicants are asked again.

What this deployment has **not** verified: clamd against the official
signatures (in the development container freshclam could not reach ClamAV's
mirrors, so the engine was tested with a locally generated test signature for
the EICAR test file), the kit's scanner set-up on a real Droplet, and scan
latency, start-up time and memory with the official signatures. Each is a
launch check below.

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
- [ ] **Email**: `SMTP_URL` and `MAIL_FROM` send a booking confirmation that
      arrives in an inbox, not spam (SPF/DKIM on the sending domain), with
      its calendar invite, and a venue's news shows the mail app's own
      unsubscribe button.
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
      takes back what it paid for; a renewing membership charges again. On a
      marketplace paying through Stripe, the platform's own webhook takes the
      `charge.dispute.*` events too, and a test dispute on an invoice emails
      the owners.
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
- [ ] **The malware scanner**: on the 4 GB Droplet, `clamav-freshclam` has
      fetched the official signatures, the *Supporting documents* panel shows
      clamd answering with signatures under a day old, an application sent
      with the EICAR test file inside a PDF is refused by the scan, a plain
      PDF is released, and the memory clamd takes and the time a 10 MB PDF
      takes are noted ([the malware scanner](#the-malware-scanner)).
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
| Legal review | A lawyer in each country | The open points in [privacy](../architecture/privacy.md#backups-held-abroad) answered before `OFFSITE_TRANSFER_APPROVED` is set (Backblaze's terms as the transfer contract, the TIA, roles, breach notice); the terms, privacy notice and venue agreement reviewed; whether a venue's refund period meets consumer law; what guardian consent the law asks for | Nothing: the app refuses the transfer until it is declared, and records consent as declared |
| Continuous integration | GitHub Actions able to start runners on the repository (the account's billing or spending limit) | A CI and a Docs run on the commit being launched start, run every step and pass | Every run since 16 October 2026 ended before a runner was assigned ([known limitations](../roadmap/known-limitations.md)); the suites have been run by hand only |
| Staging on DigitalOcean (optional) | A DigitalOcean team used for nothing else, a custom-scoped token (droplets, tags, registry read), a read-only registry credential, and an agreed spend per run | `scripts/stage-remote.mjs up --approve-usd …` serves the image on `sslip.io`, its tests pass, `down` leaves nothing billable | `tests/stage-remote.test.ts` (stand-in API) |
| Malware scanner (ClamAV) | The 4 GB Droplet (the owner's decision: USD 12 a month more) and outbound access to ClamAV's signature mirrors | freshclam fetches the official signatures; the EICAR test file is refused and a plain PDF released through the app; the hourly check stays quiet; clamd's memory and scan time measured | `tests/document-scanning.test.ts` (stand-in scanner and stand-in sockets), `tests/document-scanning-engine.test.ts` (real clamd 1.5.4 with a locally generated test signature, not the official ones) |
| Performance under production-like conditions | A managed database across a real network, a production-size pool, two or more app instances | The [benchmark](../development/testing.md#results) re-run there, with the targets in the roadmap | One machine, database beside the app |
| Monitoring and alerts | An error-tracking DSN (`SENTRY_DSN`) and an owner email that receives alerts | A deliberate error reaches the tracker; a failed backup or off-site copy, and a `refund_failed` integrity problem, email the owners; `/api/health` is polled by an uptime monitor | `tests/alerts.test.ts`, `tests/integrity.test.ts` |

Missing today: every credential above. None is in this repository or its
test environment, and none should be: they go in the host's environment
variables ([configuration](../development/configuration.md)).

Not built here, and needing a partner or a contract first: Reserve with
Google's live booking server (the feeds are ready), Singapore's InvoiceNow,
smart locks, Stripe Connect payouts to venues, LINE and Zalo. Web push needs
no partner but is not built either ([roadmap](../roadmap/roadmap.md)).
