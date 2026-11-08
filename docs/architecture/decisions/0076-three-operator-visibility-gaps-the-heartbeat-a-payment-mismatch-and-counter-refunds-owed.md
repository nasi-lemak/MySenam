# ADR 0076: The scheduler heartbeat, a payment mismatch and counter refunds owed back are each made visible to the person who must act, from data the app already holds

- **Status:** current, decided 2026-11-08 in the pilot-completion round (brief VIS). No migration: nothing new is stored; the readings are computed from the heartbeat stamp, `system_alerts`,
  `online_payments.settlement_*` and `counter_refunds_owed`, and the daily message is deduplicated by the outbox's own key. What staff and owners see is in
  [monitoring](../../operations/monitoring.md#external-monitoring-for-the-pilot), [daily operations](../../operations/pilot-daily-operations.md),
  [settlement checks](../../features/payments-and-credit.md#settlement-checks) and [owed back after the venue cancels](../../features/payments-and-credit.md#owed-back-after-the-venue-cancels);
  the routes are in [the HTTP API](../http-api.md). Builds on [ADR 0065](0065-a-payment-is-settled-for-the-amount-the-gateway-took-and-never-into-a-lapsed-hold.md) (the list *Payments to check*),
  [ADR 0066](0066-operations-hardening-grants-deliveries-leases-and-the-worklist.md) (the scheduler, its lease and heartbeat) and [ADR 0074](0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md)
  / [0075](0075-the-till-is-compared-with-cash-received-and-cash-handed-back-and-a-credit-note-is-not-a-payout.md) (counter money owed back).
- **Context:** the pilot's daily-operations document and the monitoring plan named three things the operator would otherwise not see unless they happened to open the right screen: the scheduler had a
  heartbeat but no screen for it (the owner saw a red line only after ten minutes of silence, and `/api/health` reports the scheduler alive for ten minutes after every restart whatever happened);
  a payment that came in short, for the wrong bill, or after a hold was let go was a list, a red line and an activity-log row but told nobody; and a counter payment owed back to a customer was only on
  the Bookings tab. The owner asked for the smallest reliable change, using existing data and the existing alert framework: no new scheduler, monitoring service or accounting.

## Decision 1: the scheduler is a reading on the owner's dashboard, and a missing heartbeat is never green

`GET /api/admin/system` (owner only) gains `scheduler.heartbeat` beside the old `enabled` and `alive` (`schedulerHeartbeat`, `src/lib/alerts.ts`): the last stamp (UTC), the seconds since, a state and the newest
outstanding `scheduler:*` alert as `lastFailure`. The states: `healthy` (stamped within 5 minutes), `stale` (stamped, longer ago), `never` (nothing ever stamped), `starting` (no fresh stamp but the
process is under 2 minutes old: its first tick is at 15 seconds; shown as "starting", with the grace named) and `off` (the scheduler is switched off in this process). The *System health* section of the
dashboard always shows this one line for the owner (a slim line when healthy, inside the red box when not), with a pointer to the alerts and the *Backups* panel.

`/api/health` is **unchanged** (an uptime monitor depends on it): `schedulerAlive` is still true for ten minutes after a start and then follows a ten-minute stamp. The dashboard's reading is stricter and is
computed separately; the two disagree on purpose in the first minutes after a restart, and the documents say so. The stamp is written at the start of each short pass, so it says the loop is running, not
that every job in it worked; a job that failed is its own `scheduler:*` alert, which is what `lastFailure` shows.

Not for a venue's manager or the front desk: the scheduler is the platform's, the route is the owner's, and nothing about it is shown to a venue.

## Decision 2: a newly detected payment mismatch is one owner alert, keyed by payment

Where a payment is put on *Payments to check* (`settlement_issue` set: short, a bill that is not ours, another collection or currency, a report missing its amounts, an excess, after a hold was let go, short
after it was applied), `alertPaymentToCheck` (`src/lib/payment-settlement.ts`) calls `raiseAlert` with the key `payment:check:<payment id>`, from the one place that claimed the transition (the same
guarded statement that records the issue), so a repeated or parallel callback, or the redirect after it, finds nothing to claim and tells nothing. It also refuses to write a second alert for a payment
that has one. The alert goes where every owner alert goes (an email to each platform owner through the outbox, the alert webhook when set, *System health*); no new recipient list. It names the venue and
the payment's reference (the gateway's bill id), the issue and the amounts, and says where the list is. It carries **no customer name, phone or email**. Marking the payment checked (`reviewPayment`)
clears the alert; a different payment later is news again. After five alerts standing at a venue, further ones are told as one line for that venue per day (`payment:check:many:<venue>:<day>`), which is
cleared when the venue's last payment to check is marked. The list stays the source of truth; the alert is a pointer to it and moves no money.

## Decision 3: counter refunds owed back are a line in Needs attention and one message a day to managers

`counterOwedSummary` (`src/lib/counter-owed-visibility.ts`) reads `counterOwed`, so it is exactly the list staff are shown, every cause: per venue how many wait, the sum, the whole days the oldest has waited and how many have
waited `REFUND_OVERDUE_DAYS` (2) or more. It is `counterOwed` in `GET /api/admin/attention` for all staff of the venue (the desk too) and the owner for every venue, and a line in *Needs attention*, red when any is
overdue and amber otherwise. The threshold is a constant, not a setting: there is no promised date to measure against, as online refunds have the venue's `refund_within_days`.

`sendCounterOwedDigests`, run by the scheduler's short unit, sends **one message per venue per venue-local day, once the venue's clock is past 09:00**, to the venue's managers and its business's managers (the front
desk is not written to), saying how many, the sum, the oldest age and how many are overdue; no customer, no booking, no item. Each person's message is queued under the key
`counter-owed:<venue>:<local day>:<email>` (the outbox writes a key once), so a restart, a repeated tick or two servers at once write nothing more that day, and nothing needs clearing: when everything is settled there
is nothing to send. **No message, delivered, opened or ignored, settles anything**: a row leaves the list only when a named member of staff presses *Handed back* or *Give as credit*.

## Not decided here

- **Who the "designated operator" is.** The message goes to the venue's managers. The platform owner is not on a venue's staff list, so an owner who is not also a manager sees the line in *Needs attention* (all venues) but is
  not emailed. If the owner wants the platform owners told as well, that is a small addition and a recipient decision.
- **A threshold other than two days, or a different hour.** Constants (`REFUND_OVERDUE_DAYS`, `COUNTER_OWED_DIGEST_HOUR`); the owner may change them.
- **Whether a payment mismatch should also be sent to the venue's managers.** Not done: the brief said to use what `raiseAlert` uses.

## Alternatives considered

- **A new table or a new alert channel for each:** rejected; the data exists, and the alert framework already has the recipients, the resend rule and the dashboard.
- **Changing `/api/health` to be strict:** rejected; an uptime monitor reads it and would page on every restart or slow tick.
- **One alert for all mismatches:** rejected; it would hide a second payment behind the first. A per-payment key clears when that payment is checked.
- **A per-item message for refunds owed:** rejected; the owner asked for one message a day with counts.
- **A clock in the database (a "last told" column) for the daily message:** unnecessary; the outbox's unique key already makes a day's message once.

## What the tests do not prove

They run against PGlite and Postgres with fetch stood in for and the outbox's emails read before they leave. They prove the readings, the keys and the idempotence, not that an email reaches an inbox (email stays unverified
live: [the SES checklist](../../operations/email-ses-checklist.md)), that the alert webhook reaches a channel, that Billplz sends these mismatches, or that anyone acts on a message. A scheduler that has stopped
cannot send anything: the heartbeat line is seen only while somebody opens the dashboard, and the unattended watch is still an external uptime monitor on `/api/health`, which is not configured
([monitoring](../../operations/monitoring.md#external-monitoring-for-the-pilot)).
