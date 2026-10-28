# Monitoring, alerts and errors

How an install tells its owners that something is wrong.

## Being told when something breaks

A failure the owner never hears about is found out from a venue's complaint.
So the platform owners are told (`src/lib/alerts.ts`) when:

- a **new kind of server error** happens on a page or API request (Next's
  `onRequestError`), or one marked fixed comes back (see *Errors* below);
- any of the **scheduled work** fails: sending messages, letting go of unpaid
  holds, invoices, overdue checks, league housekeeping, the backup;
- the **nightly backup** or its **off-site copy** fails;
- **messages to customers stop going out**: five or more failed in an hour and
  none sent (one bad address is not news; a rejected SMTP login is).
- **bookings and the court time they hold disagree** (`src/lib/integrity.ts`,
  once a day from the scheduler): a live booking that holds no court time
  (anybody could book over it), one holding a different court or time from
  the one it says, a cancelled booking or class still holding its court or
  coach, or a booking for an activity its court no longer offers. It looks
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
