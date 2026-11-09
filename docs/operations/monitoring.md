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
  The numbers are in the owner's system answer (`GET /api/admin/system`, `email`) and on
  the **Email** section of *System health* ([below](#email-on-system-health)), and
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

## Email on System health

The owner's *System health* has an **Email** section, always shown to the platform owner and to nobody else (the route,
`GET /api/admin/system`, answers a venue's manager or front desk `403` as before; venues never see platform-wide messaging).
It is read-only and reads what `emailHealth` (`src/lib/email-health.ts`) gives, from the outbox and the configuration; it asks
no provider and sends nothing ([ADR 0079](../architecture/decisions/0079-the-platform-owners-daily-refund-summary-and-email-on-system-health.md)).

| Line | What it says | Read from |
| ---- | ------------ | --------- |
| Configuration | The validator's state (not configured, set up wrongly, two providers, no sender, log only, configured with delivery not verified, delivery verified), the provider (Amazon SES, SMTP, none), whether this is a production marketplace, the problems by setting name (never a value), and whether sign-up and forgotten-password requests are refused | The environment ([email configuration](../integrations/messaging.md#email-configuration-and-its-checks)) |
| Delivery verified (separately confirmed) | *yes* when `MAIL_DELIVERY_VERIFIED` matches this provider and sender; *no*, with "a check is recorded for another provider or sender" when it is set and does not; *no* when nobody recorded a check. The value itself is never shown | The environment |
| Queued | How many emails wait (queued, or failed and to be tried again; a venue's bulk news excluded) and the oldest's age | `messages` by `status`, on the `(status, next_attempt_at)` index |
| Accepted by provider | In the last hour and the last 24 hours, and the last one in the 24 hours. **Accepted is not delivered**: the provider took the message; nothing here says it reached an inbox | `messages.last_attempt_at` within the day: no index, one pass over the email rows per load |
| Failed, to be tried again | Tries in the last hour and 24 hours that failed and wait for another | the same pass |
| Abandoned (given up) | In the last 24 hours, with security mail (`auth_email`) apart: how many ran out before they could go and how many the daily allowance held; and security mail failing and being tried again | `status = 'abandoned'` and `created_at` within the day (the `created_at` index); failed security mail on the status index |
| Recent failure reasons | Up to five, grouped: the kind of message, failed or abandoned, the provider's or the outbox's words with **every address, link, long token and configured secret taken out**, how many and when. No body, recipient, link or token | The newest 30 failed ones and the day's given-up ones |
| Open email alerts | The standing alerts about email: `config:email`, `email:failing`, `email:backlog`, `messages`, `messages-aged-out`, `auth-mail-ceiling`, `auth-mail-expired`, `scheduler:sending-messages-failed` | `system_alerts` |

It turns **amber with a warning** when production email cannot go out (not configured, invalid, two providers, no sender or
log only), when delivery has not been verified, when the provider is failing (at least 5 tries in the last hour and at least
half failed: the `email:failing` threshold), when the oldest waiting email is 30 minutes old (the `email:backlog` threshold),
and when security mail was given up or is failing. With a warning, a reason or an alert it names the procedure: the
[SES checklist](email-ses-checklist.md) and the outbox row of the table below; the incident is
[email delivery fails](pilot-daily-operations.md#email-delivery-fails). With no email ever written it says so instead of
showing zeros. The section is seen only while somebody opens the dashboard; the alerts above are what is sent.

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
alive whatever has happened since. That contract is unchanged: the owner's dashboard reads the heartbeat more strictly and
separately (next paragraph), and the two disagree on purpose in the first minutes after a restart.

**The scheduler line on the dashboard** ([ADR 0076](../architecture/decisions/0076-three-operator-visibility-gaps-the-heartbeat-a-payment-mismatch-and-counter-refunds-owed.md)).
The owner's *System health* section always shows one line, `scheduler.heartbeat` of `GET /api/admin/system`
(`schedulerHeartbeat`, `src/lib/alerts.ts`): *healthy* (stamped within 5 minutes; with the time since and the stamp), *stale*
(stamped, longer ago; red), *no heartbeat yet* (nothing was ever stamped; red, never green), *starting* (no fresh stamp, but the
process is under 2 minutes old, so its first tick, at 15 seconds, may not have run; amber and labelled, the only grace) or *off*
(the scheduler is switched off on this server). It also names the newest outstanding `scheduler:*` alert as the last failure,
and points at the alerts and the *Backups* panel. The stamp is written at the start of each short pass: it says the loop is
running, not that every job in the pass worked, which is what the `scheduler:*` alerts are for. **It is seen only while the owner
opens the dashboard**: a stopped scheduler or an offline app tells nobody, and the unattended watch is still the external check
on `/api/health` below. Owner only; a venue's manager and the front desk are not shown platform health.

What raises each, today, and where it goes. *Built* means the code raises it; it does **not** mean it was ever seen live.

| Watch | What raises it today | Built? | Where it goes | Who acts, and what |
| ----- | -------------------- | ------ | ------------- | ------------------ |
| The app answers (external HTTP uptime on `/api/health`) | The endpoint answers `503` or does not answer | Endpoint built; **NOT built: nothing polls it, external service needed** | The monitor's own channel | The named operator, then the technical contact: [the application is unavailable](pilot-daily-operations.md#the-application-is-unavailable) |
| Database connectivity | `/api/health` runs a query and answers `503` if it fails | Endpoint built; **external service needed** (the app cannot raise an alert it cannot store) | The same monitor | Technical contact: [the database fails](incident-response.md#the-database-fails-or-data-is-lost) |
| Scheduler heartbeat | A stamp each tick; `/api/health` answers `503` after ten minutes without one; the owner's *System health* always shows a line: last stamp, time since, healthy, stale, no heartbeat yet, starting or off, and the last scheduler failure still outstanding | Built (the line only while somebody opens the dashboard); **external service needed** for anything unattended | The monitor; the dashboard | Operator: [the application is unavailable](pilot-daily-operations.md#the-application-is-unavailable); no backups, messages or released holds meanwhile |
| TLS certificate expiry | Nothing reads the certificate | **NOT built, external service needed** (no record that a renewal on the pilot's host was ever checked) | The external service, or a calendar reminder | Technical contact renews or repairs the proxy ([behind a proxy](deployment.md#behind-a-proxy)) |
| Backup failure | `backup`, `offsite`, `scheduler:scheduled-backup-failed`, `backup-stale` (hourly and after each backup), `offsite-near-limit`, and the erasure-ledger alerts; the *Backups* panel's red line | Built; never run against a real bucket ([provider verification](pilot-provider-verification.md)) | Owner email, chat channel, *System health* | Operator: [a backup fails](pilot-daily-operations.md#a-backup-fails); [backups](backups.md#backup-health) |
| Outbox failure | `messages` (five failed in an hour, none sent), `email:failing`, `email:backlog`, `config:email`, `messages-aged-out`, `outbox-step:<name>`, `scheduler:sending-messages-failed`, `auth-mail-ceiling`, `auth-mail-expired` | Built; delivery never verified live. Bounces and complaints are **NOT built** (not read back) | Owner email (itself delayed if email is the fault), chat channel, *System health* | Operator: [email delivery fails](pilot-daily-operations.md#email-delivery-fails); the owner reads the SES reputation dashboard weekly |
| Payment mismatch | A held or mismatched payment is a *Payments to check* row, a red line in *Needs attention* and an activity-log row; the payer is emailed where the address was proved. **And, once per payment, the owner alert `payment:check:<id>`** (venue and the payment's bill id, the issue and amounts, no customer detail; cleared when the payment is marked checked; after five standing at a venue, one line a day for it) | Built; delivery of the email and the chat message never verified live; no real Billplz mismatch has been seen | Owner email, chat channel, *System health*; and the lists | Operator, daily: *Payments to check* |
| Refunds owed | The daily integrity check raises `integrity` for a refund asked and unanswered for an hour, owed over a week, or failed at the gateway; the venue's staff are emailed once a day how many wait; *Needs attention* shows overdue ones. **Counter payments owed back:** a *Needs attention* line for the venue's staff (how many, the sum, the oldest, how many past 2 days), and one message a day per venue to its managers from 09:00 venue time while anything is owed; **and one summary a day to each platform owner** from 09:00 install time (every venue: waiting, sum, oldest, overdue, newly owed and settled in the last 24 hours, payments to check, venues nobody could email; [ADR 0079](../architecture/decisions/0079-the-platform-owners-daily-refund-summary-and-email-on-system-health.md)) | Built for online refunds and for counter refunds; email delivery never verified live. A message settles nothing | Owner email, chat channel, *System health*; venue staff email (online); venue managers' email (counter); the owners' daily summary | Operator, daily: *Refunds owed*, *Owed back at the counter* |
| Disk space | The disk alert (`MYSENAM_DISK_*`, [disk space](#disk-space)): warn, critical and full for the volume holding the data directory | Built; never seen on a live host. A database on another volume is **not** watched | Owner email, chat channel, *System health* | Technical contact; a full disk stops backups, photos and the database (the [app is down](incident-response.md#the-app-is-down)) |

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

### Monitor specification (proposed)

*Added 8 November 2026. The table above says what raises each alert today; this one says what a monitor would be set to, so that
whoever configures it has the numbers and knows what is missing. The thresholds are **suggestions** for the owner to accept or
change, not measured values. **Every external monitor in it is NOT CONFIGURED**: no service is subscribed, priced or set up,
and none of this was checked against a real service. "Built" means the code raises the signal; it does not mean it was seen live.*

| Monitor | State | Source | Suggested threshold | Channel | Recipient | Action |
| ------- | ----- | ------ | ------------------- | ------- | --------- | ------ |
| Public HTTPS check of `/api/health` | **NOT CONFIGURED** | Endpoint built (`200` while the database answers and, with the scheduler on, it ticked in the last ten minutes; else `503`). **Nothing polls it: NOT built** | Every 5 minutes; alert after 2 failures in a row (about 10 minutes); one success clears. A failure is any answer other than `200`, a timeout, or a TLS error. (Interval and count are the owner's; what the chosen service allows has not been checked) | At least two channels, one of them a phone push or a chat message | ____ and ____ | The named operator, then the technical contact: [the application is unavailable](pilot-daily-operations.md#the-application-is-unavailable) |
| TLS certificate expiry | **NOT CONFIGURED** | **NOT built.** Nothing in the app reads the certificate | Alert at **21 days** and again at **7 days** before expiry, and at expiry | The same monitor, if it offers it; otherwise two dated calendar reminders | ____ | The technical contact renews or repairs the proxy's certificate ([behind a proxy](deployment.md#behind-a-proxy)) |
| Scheduler freshness | **NOT CONFIGURED** (external) | Built: `/api/health` answers `503` after ten minutes without a tick, and the owner's *System health* shows a line while somebody has the dashboard open. The owner's *System health* now always shows a Scheduler line (last stamp, time since, healthy, stale, no heartbeat yet, starting, off) and the newest outstanding scheduler failure ([ADR 0076](../architecture/decisions/0076-three-operator-visibility-gaps-the-heartbeat-a-payment-mismatch-and-counter-refunds-owed.md)); it is seen only while somebody opens the dashboard | Covered by the first monitor: ten minutes (fixed in the code) | The first monitor's channels | ____ | Operator: no backups, messages or released holds meanwhile |
| Backup freshness | **NOT CONFIGURED** (external) | In-app built: `backup` and `offsite` on a failure; `backup-stale` when the newest copy that would survive is older than `MYSENAM_BACKUP_RPO_HOURS` (26 hours unless changed) or none has gone off-site ([backups](backups.md#backup-health)). **No external signal: NOT built**; the backup's age is shown only to a signed-in owner, so no outside monitor can read it | In-app: the 26-hour default. External: none exists. Until one does, the operator reads *Backups* every day ([daily operations](pilot-daily-operations.md#every-day), item 9) | Owner email and the chat webhook (`MYSENAM_ALERT_WEBHOOK`, **NOT CONFIGURED**) | ____ | Operator: [a backup fails](pilot-daily-operations.md#a-backup-fails) |
| Disk space | **NOT CONFIGURED** (host level) | Built: `disk:warn` at 80%, `disk:critical` at 90%, `disk:full` at 95% of the volume holding the data directory ([disk space](#disk-space)). A database on another volume is **not** seen. No host-level alert | The built thresholds; the same percentages on the hosting provider's own alert for every volume that holds a database | Owner email, chat webhook; the provider's own alerting | ____ | Technical contact: free space or enlarge the disk; at 95% there is no new backup |
| Failed outgoing messages | **NOT CONFIGURED** (SES side) | Built: `messages` (5 or more failed in an hour and none sent), `email:failing` (at least 5 sends in an hour and at least half refused), `email:backlog` (oldest waiting email 30 minutes old), `config:email`, `messages-aged-out`, `auth-mail-ceiling`, `auth-mail-expired`. Bounces and complaints **NOT built** (not read back) | The built thresholds. Bounce and complaint rates: the review levels the SES console states (to be written in [the SES checklist](email-ses-checklist.md#b1-read-the-values-in-the-ses-console)) | Owner email (itself delayed if email is the fault), chat webhook; for SES, an SNS notice from a configuration set, **not created** ([bounces and complaints](email-ses-checklist.md#c-watching-bounces-and-complaints-during-the-pilot)) | ____ | Operator: [email delivery fails](pilot-daily-operations.md#email-delivery-fails) |
| Payment mismatches | **NOT CONFIGURED** | Lists built: *Payments to check*, a red line in *Needs attention*, an activity-log row. **And an owner alert once per payment (`payment:check:<id>`)**: venue and bill id, no customer detail; cleared when the payment is marked checked (ADR 0076) | Owner email, chat webhook, *System health*; the operator still opens the list daily | Owner email, chat webhook, *System health* | ____ | Operator: *Payments to check*, [a customer pays but gets no booking](pilot-daily-operations.md#a-customer-pays-but-gets-no-booking) |
| Refund obligations | **NOT CONFIGURED** | Online refunds built: the daily integrity check raises `integrity` for a refund asked and unanswered for an hour, owed over a week, or failed at the gateway; venue staff are emailed once a day how many wait. The counter list *Owed back at the counter* has now a *Needs attention* line (count, sum, oldest, overdue after 2 days) and **one message a day per venue to its managers from 09:00 venue time** (ADR 0076); a notice never settles a row | Online: the built thresholds (one hour; one week). Counter: overdue after 2 whole days; the daily message | Owner email, chat webhook, *System health*; venue staff email. Counter: the venue's managers, and the platform owners' daily summary of every venue (ADR 0079) | ____ | Operator: *Refunds owed* and *Owed back at the counter*, daily |

**What is missing before any of this can be configured.**

1. The **public address** of the pilot's service (its host is not yet decided: [known limitations](../roadmap/known-limitations.md#blockers-for-any-launch)),
   so that `https://<host>/api/health` can be named to a monitor. `/api/health` carries no detail and no secret.
2. The **operator's addresses**: at least two email addresses and one phone or chat channel for alerts, and who is first and
   second (the Recipient column). For `MYSENAM_ALERT_WEBHOOK`, a chat channel the operator reads on a phone; its address is a
   secret and goes in the environment's secret store, never in a document.
3. The **choice of monitoring service** and its plan, whether free or already paid for, with its limits checked: the interval it
   allows, the number of monitors, whether it checks certificate expiry. Nothing is bought to complete this.
4. The hosting provider's own **disk, memory and CPU alerts**, once the host is chosen.
5. The owners' **email addresses** as platform owners (the in-app alerts go to every one of them), and the SES account's
   notification target if a configuration set is created.

When these exist, the owner configures the monitors, tests each by causing the failure it watches for on a staging install
holding synthetic data (stop the app; let a certificate lapse on a test host; fill a test volume), writes the date and the
result here, and only then changes a row from NOT CONFIGURED.
