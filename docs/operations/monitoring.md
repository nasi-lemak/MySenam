# Monitoring, alerts and errors

How an install tells its owners that something is wrong.

## Being told when something breaks

A failure the owner never hears about is found out from a venue's complaint.
So the platform owners are told (`src/lib/alerts.ts`) when:

- a **new kind of server error** happens on a page or API request (Next's
  `onRequestError`), or one marked fixed comes back (see *Errors* below);
- any of the **scheduled work** fails: sending messages, letting go of unpaid
  holds, invoices, overdue checks, league housekeeping, the backup;
- **past court time cannot be archived** (only where `CLAIMS_ARCHIVE_AFTER_DAYS`
  is set): `scheduler:claims-archive-failed` when a run fails (tried again ten
  minutes later), and `claims-archive-behind` when court time due to move has
  waited three days or more past the horizon, so the job has stopped or
  cannot keep pace. Nothing is lost by either: the time stays where it was
  and still keeps the court. Look at the database's room and load, and at
  `claimsArchive` in the owner's system answer (`GET /api/admin/system`: days,
  last run, moved, due, behind, last failure)
  ([archiving past claims](../architecture/database.md#archiving-past-claims));
- the **retention run** fails (`scheduler:retention-failed`, from the scheduler or from a dashboard load, which never fails because of it), or one **stale draft venue
  cannot be deleted** (`retention:stale-draft-not-deleted`: it is skipped, and the rest of the run goes on; the alert names the business and the database's reason, which
  usually means a table the foreign-key walk in `src/lib/drafts.ts` cannot clear);
- the **nightly backup** or its **off-site copy** fails;
- **messages to customers stop going out**: five or more failed in an hour and
  none sent (one bad address is not news; a rejected SMTP login is).
- **email cannot deliver, or is failing** (`config:email`, `email:failing`,
  `email:backlog`; [email configuration](../integrations/messaging.md#email-configuration-and-its-checks)):
  at start-up and after each outbox pass (at most every five minutes) the install's
  email is checked, without sending anything. `config:email` says email is not set up
  (and, on a production marketplace, that sign-up and forgotten-password requests are
  refused until it is), or that it is configured and delivery has not been verified
  (`MAIL_DELIVERY_VERIFIED`). `email:failing` is raised when at least 5 sends in the
  last hour were tried and at least half were refused, `email:backlog` when the oldest
  email still waiting (a venue's bulk news excluded) is 30 minutes old. Each clears when
  it stops. Two more are about security mail: `auth-mail-ceiling` (an address used up its
  allowance of sign-in and account emails, so a link was withheld) and `auth-mail-expired`
  (a sign-in or sign-up link ran out before the provider took it); what to do for a
  person locked out is in [security mail](../integrations/messaging.md#security-mail).
  The numbers are in the owner's system answer (`GET /api/admin/system`, `email`), and
  the owner can ask the provider whether it answers (`POST /api/admin/system`
  `{"check":"email"}`), which sends nothing;
- **bookings and the court time they hold disagree** (`src/lib/integrity.ts`,
  once a day from the scheduler): a live booking that holds no court time
  (anybody could book over it), one holding a different court or time from
  the one it says, a cancelled booking or class still holding its court or
  coach, a booking for an activity its court no longer offers, or court
  time in the archive that has not ended (`claim_archived_early`: the archive
  job cannot do that, so something went round it). It looks
  from yesterday on. Every write keeps the two together, so this finds
  nothing unless something went round the code (a hand-edited row, half a
  restore). `GET /api/admin/integrity` asks again now, after putting it
  right: for the platform owner, every venue; for a manager (a branch's, or
  a business's), their own venues only, each kind looked for there alone, so
  another venue's problems are never shown (a payment with no venue is the
  owner's alone); front desk is refused. The dashboard runs it from
  *Booking integrity check* (`src/components/admin/IntegrityCheck.tsx`),
  beside the system health and errors panels for the owner, saying for a
  manager that only their venues are checked, listing each problem by kind,
  venue and booking or class with the server's own description of it
  (in English, as the check writes it).
  The same check raises **refunds that are stuck**: one asked of the gateway
  with no answer after an hour, money owed back on an online payment for
  over a week, and a refund the gateway accepted and then reported failed
  (`refund_failed`, owed again). Those need somebody to look in the
  gateway's dashboard or pay it back, then mark it
  ([payments](../features/payments-and-credit.md#refunds-that-are-interrupted)).
  It also lists, for 30 days, money refunded in the gateway's own dashboard
  that nothing in MySenam owed (`refund_unasked`): nothing was changed by it,
  and the venue decides what it was for
  ([refunds made in the gateway's dashboard](../features/payments-and-credit.md#refunds-made-in-the-gateways-dashboard)).
  A failed or paused off-site copy of a backup raises `offsite`, and a failed
  nightly backup `backup`. Backups older than the recovery-point target, or
  none copied off-site yet, raise `backup-stale`. A backup part nearing the
  single-upload limit raises `offsite-near-limit`
  ([backups](backups.md#backup-health)).
- **supporting documents cannot be scanned** (hourly, `document-scanner`):
  the malware scanner does not answer, none is configured while documents
  wait in quarantine, its signatures are over 48 hours old or of unknown age,
  a document has waited over an hour, documents wait for a scanner (their
  tries ran out with none answering: kept, and scanned by themselves once one
  answers), or a working scanner could not scan one
  ([security](../architecture/security.md#malware-scanning)). The owner's
  *Supporting documents* panel shows the scanner's state, the failed
  documents and the action to scan one again
  ([deployment](deployment.md#the-malware-scanner)). Where clamd is started
  on demand, a clamd stopped because nothing waits is not "not answering"
  (its signatures' age is read from disk), and the same alert also covers a
  start that failed or a clamd that stopped by itself (until a start
  succeeds) and a start held back for over 30 minutes.
- **the malware scanner could not be started on demand**
  (`document-scanner-ondemand`, at once): clamd did not answer within its
  start limit and was stopped, exited before answering, or stopped by itself
  while running; or documents have waited 30 minutes while a start was held
  back (too little free memory, freshclam running, another process holding
  its lock). Documents stay in quarantine, unopened; the start is tried again
  after a pause ([deployment](deployment.md#choosing-how-clamd-runs)).
- **after a restore**, an erasure could not be applied again
  (`erasure-reapply`), or the erasure ledger could not be written beside the
  backups (`erasure-ledger`) ([backups](backups.md#after-a-restore)).

What to do about one is [incident response](incident-response.md).

Each kind is told once, then again only after six hours if it is still
happening, with how many times it has. It goes by email to every platform
owner, through the outbox like every other email (retried while the mail
server is down, [messaging](../integrations/messaging.md#emails-that-belong-to-no-venues-customers)), and, with `MYSENAM_ALERT_WEBHOOK` set, to a Slack, Discord or Google
Chat channel, which still arrives when email is what broke. The owner's
dashboard shows *System health* while anything is outstanding, with the
latest detail and a *Dealt with* button.

## Disk space

The Droplet holds Postgres, the backups and the uploaded documents, so a full disk is an outage: the database stops
writing, and bookings and payments with it. `src/lib/disk-health.ts` watches the volume that holds the data directory
(`MYSENAM_DATA_DIR`, where `photos/`, the key file and, unless `MYSENAM_BACKUP_DIR` says otherwise, the backups are) with the
platform's own `statfs` answer. A database on another volume (a managed database, a separate Postgres disk) is not seen by it:
that volume is its provider's to watch, or the data directory's variable should name the one that matters.

| Used | State | What happens |
| ---- | ----- | ------------ |
| below `MYSENAM_DISK_WARN_PERCENT` (80) | `ok` | nothing; any disk alert clears |
| from 80 | `warn` | `disk:warn`, *The disk holding MySenam's data is filling up* |
| from `MYSENAM_DISK_CRITICAL_PERCENT` (90) | `critical` | `disk:critical`, *…is nearly full* |
| from `MYSENAM_DISK_BLOCK_PERCENT` (95) | `full` | `disk:full`, and new backups are refused (below) |

Used is as `df` reports it (used over used plus what an ordinary process may still use), so space kept back for root does not
hide a full disk. The three numbers must each be above 0 and at most 100 and increase in that order; a set that does not is
replaced, whole, by 80/90/95, and the system answer's `disk.thresholds.problem` says why (the server log says it once).
Where the platform cannot answer, the state is `unknown`: nothing is raised, what stands is left alone, and a backup is not
held back (not knowing is no reason to stop one).

- **Who looks, and when.** The scheduler's short unit, at most every 15 minutes, on whichever instance holds the lease. Each
  state is one alert through the usual path (`raiseAlert`: told once, again after six hours with the count, to the owners by
  email and on `MYSENAM_ALERT_WEBHOOK`); only the current state's alert stands, and all clear when usage falls under the
  warning. An alert says the volume's percentage and free space and never a path.
- **The owner's view.** `GET /api/admin/system` carries `disk`: `state`, `usedPercent`, `freeBytes`, `totalBytes` and the
  `thresholds` in force (`valid`, `problem`).
- **At the block percentage.** A backup is refused before anything is written (`createBackup` returns a failure, not a success;
  the next scheduled attempt tries again): the scheduler raises `backup:no-space`, which clears when a backup is taken, and
  `npm run backup`, the backup button and the restore script's safety copy say the same in their own answer. The volume asked is
  the one the backup is written to. An off-site copy that would write an encrypted scratch copy first
  (`OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE`) is refused the same way, if the temporary folder's volume is at the block percentage:
  it is recorded as a failed copy (the `offsite` alert, the last good copy still the last good copy). A copy that is streamed as
  it is writes nothing locally and is not held back. Bookings, payments and everything else the app does are never blocked:
  the point is to keep the room that is left for them.
- **What to do.** Free space or enlarge the disk: old snapshots beyond `MYSENAM_BACKUP_KEEP`, uploaded documents and photos
  that should be in a bucket (`PHOTOS_S3_*`), logs, Docker images. At `full` there is no new backup until it is done, so the
  newest copy ages toward the recovery-point target (`backup-stale`, [backups](backups.md#backup-health)). Nothing is deleted by
  the app. The checks of a release (`scripts/verify.mjs`) read the same idea of the machine they run on
  ([testing](../development/testing.md)).

## Errors

Each error is filed under its kind (`lib/error-log.ts`), with a count, where it
happened last, its method and its stack trace. The kind is a fingerprint of the
error's name, its message with numbers, ids and quoted parts taken out, and the
first frame of the stack that is ours, without its line number. So *Cannot read
booking 42* and *… 977* are one kind, and an edit that moves a line does not
start a new one. Errors come from two places:

- **The server**: every request that ends in an error. A new kind is told to
  the owners as an alert of its own.
- **Customers' browsers**: errors nothing else caught (`components/ErrorReporter.tsx`)
  and pages that failed to draw (`app/error.tsx`, which says so plainly and
  offers *Try again*). They are sent to `/api/errors`, which allows 20 per
  address per 10 minutes, at most five from one page. It drops what is not
  ours: browser extensions, *Script error.* from other sites' scripts, and
  Chrome's ResizeObserver warning. Anybody can send one, so they are not
  alerted one by one: together they are, at most every six hours.

The owner's dashboard shows *🐞 Errors* with each kind and its stack. *Fixed*
takes one off the list until it happens again; then it comes back and is told
again. Before anything is kept, email addresses and long runs of digits are
replaced and addresses lose their query strings. An error is forgotten 90 days
after it last happened.

With `SENTRY_DSN` set, each one is also sent to Sentry, or to anything that
speaks its envelope API, like self-hosted GlitchTip. That is one request, with
no SDK, given up on after five seconds.

**A stopped scheduler** cannot email about itself, so `/api/health` answers
`503` when it has not ticked for ten minutes. Point an uptime monitor
(UptimeRobot, Better Stack, the host's own) at `/api/health` and it covers
both the app being down and the scheduler being stuck.

## External monitoring for the pilot

*Added 8 November 2026 for the restricted pilot ([pilot readiness](pilot-readiness-2026-11-07.md)). Everything above says what
the app tells its owners; this says what it cannot, and the minimum that has to sit outside it. **Every external service
named here is NOT CONFIGURED**: nothing is subscribed, priced or set up, and nothing in this section was checked against a
real service.*

**What the app can and cannot tell.** An alert is written by the running app into its own database
(`raiseAlert`, `src/lib/alerts.ts`), then sent by email through the outbox and, with `MYSENAM_ALERT_WEBHOOK` set, to a chat
channel. So **an app that is offline cannot report itself**; nor can one whose database is unreachable (the alert is stored
first), whose scheduler has stopped (it cannot email about itself, above), or whose email is the thing that broke (the email
copy waits in the outbox; the chat copy still arrives). Something outside the server has to ask. The only question the app
answers for outsiders is `GET /api/health`: `200` while the database answers a query and, where the scheduler is on, it has
ticked in the last ten minutes; otherwise `503`, with no detail. For ten minutes after a restart it reports the scheduler as
alive whatever has happened since.

What raises each, today, and where it goes. *Built* means the code raises it; it does **not** mean it was ever seen live.

| Watch | What raises it today | Built? | Where it goes | Who acts, and what |
| ----- | -------------------- | ------ | ------------- | ------------------ |
| The app answers (external HTTP uptime on `/api/health`) | The endpoint answers `503` or does not answer | Endpoint built; **NOT built: nothing polls it, external service needed** | The monitor's own channel | The named operator, then the technical contact: [the application is unavailable](pilot-daily-operations.md#the-application-is-unavailable) |
| Database connectivity | `/api/health` runs a query and answers `503` if it fails | Endpoint built; **external service needed** (the app cannot raise an alert it cannot store) | The same monitor | Technical contact: [the database fails](incident-response.md#the-database-fails-or-data-is-lost) |
| Scheduler heartbeat | A stamp each tick; `/api/health` answers `503` after ten minutes without one; the owner's *System health* shows a line | Built (the line only while somebody opens the dashboard); **external service needed** for anything unattended | The monitor; the dashboard | Operator: [the application is unavailable](pilot-daily-operations.md#the-application-is-unavailable); no backups, messages or released holds meanwhile |
| TLS certificate expiry | Nothing reads the certificate | **NOT built, external service needed** (no record that a renewal on the pilot's host was ever checked) | The external service, or a calendar reminder | Technical contact renews or repairs the proxy ([behind a proxy](deployment.md#behind-a-proxy)) |
| Backup failure | `backup`, `offsite`, `scheduler:scheduled-backup-failed`, `backup-stale` (hourly and after each backup), `offsite-near-limit`, and the erasure-ledger alerts; the *Backups* panel's red line | Built; never run against a real bucket ([provider verification](pilot-provider-verification.md)) | Owner email, chat channel, *System health* | Operator: [a backup fails](pilot-daily-operations.md#a-backup-fails); [backups](backups.md#backup-health) |
| Outbox failure | `messages` (five failed in an hour, none sent), `email:failing`, `email:backlog`, `config:email`, `messages-aged-out`, `outbox-step:<name>`, `scheduler:sending-messages-failed`, `auth-mail-ceiling`, `auth-mail-expired` | Built; delivery never verified live. Bounces and complaints are **NOT built** (not read back) | Owner email (itself delayed if email is the fault), chat channel, *System health* | Operator: [email delivery fails](pilot-daily-operations.md#email-delivery-fails); the owner reads the SES reputation dashboard weekly |
| Payment mismatch | A held or mismatched payment is a *Payments to check* row, a red line in *Needs attention* and an activity-log row; the payer is emailed where the address was proved | **NOT built as an alert**: no owner email or chat message exists for it | Lists the operator must open | Operator, daily: *Payments to check* |
| Refunds owed | The daily integrity check raises `integrity` for a refund asked and unanswered for an hour, owed over a week, or failed at the gateway; the venue's staff are emailed once a day how many wait; *Needs attention* shows overdue ones | Built for online refunds. The counter *Owed back at the counter* list has **no alert and no email: NOT built** | Owner email, chat channel, *System health*; venue staff email | Operator, daily: *Refunds owed*, *Owed back at the counter* |
| Disk space | The disk alert (`MYSENAM_DISK_*`), being built in parallel and **not part of this baseline** | **NOT built here**; until it is merged and checked, treat as not built | Per that change | Technical contact; a full disk stops backups, photos and the database (the [app is down](incident-response.md#the-app-is-down)) |

**Recommended minimum, not subscribed.** The owner decides; nothing here is bought by this change.

1. **One external HTTP check on `/api/health`**, from a service outside the server, alerting at least two people by two
   channels. It covers the app, the database and the scheduler in one. Interval and failure count: **____** (the repository
   fixes only the scheduler's ten minutes). The services named above (UptimeRobot, Better Stack) are only examples, and **their free
   tiers and limits have not been checked**; use one that is free or already paid for, and check what it offers before relying on it.
2. **A certificate-expiry check or a dated reminder**, from the same service if it offers one.
3. **`MYSENAM_ALERT_WEBHOOK` pointed at a chat channel the operator reads on a phone**, so alerts arrive when email is what
   broke ([configuration](../development/configuration.md)). NOT CONFIGURED.
4. **The hosting provider's own disk, memory and CPU alerts**, until the disk alert is built and verified. The host is not
   yet decided ([known limitations](../roadmap/known-limitations.md#blockers-for-any-launch)).
5. **A weekly human look** at the SES reputation dashboard and the *Backups* panel, since bounces and a real bucket's state
   are not read back.

| External service or setting | Status |
| --------------------------- | ------ |
| Uptime monitor on `/api/health` | NOT CONFIGURED |
| TLS certificate expiry check | NOT CONFIGURED |
| `MYSENAM_ALERT_WEBHOOK` chat channel | NOT CONFIGURED |
| `SENTRY_DSN` error tracker | NOT CONFIGURED |
| Host-level disk, memory and CPU alerts | NOT CONFIGURED |
| SES bounce and complaint watching | NOT CONFIGURED |
