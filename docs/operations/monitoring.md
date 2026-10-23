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
  restore). `GET /api/admin/integrity` asks again now, for the platform
  owner, after putting it right.

Each kind is told once, then again only after six hours if it is still
happening, with how many times it has. It goes by email to every platform
owner and, with `MYSENAM_ALERT_WEBHOOK` set, to a Slack, Discord or Google
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
