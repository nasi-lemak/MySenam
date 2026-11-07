# ADR 0066: A free hour is given once by the database's rule, a failed webhook delivery can be sent again, the backup has a lease of its own, lapsed holds are let go for the venue's API, and an unanswered hire enquiry is on the worklist

- **Status:** current, decided 2026-11-07 for the post-audit hardening round (audit 9 findings G19, G17, G18, B15, E17); built in migrations 0320 and 0321 (0322 and 0323 were not needed).
  What staff and venues see is in [pricing](../../features/pricing.md#a-free-hour-for-regulars), [external API and webhooks](../../integrations/external-api.md),
  [venue operations](../../features/venue-operations.md#private-hire-enquiries) and [the overview](../overview.md#more-than-one-instance); the routes are in [the HTTP API](../http-api.md).
  Builds on [ADR 0003](0003-scheduler-lease.md) (scheduled work under a lease), [ADR 0002](0002-database-enforced-concurrency.md) (the database enforces what must not happen twice) and
  [ADR 0057](0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md) (staff actions are logged). Every decision is the audit's recommended one, kept to the smallest change.
- **Context:** five small defects of the same kind: something that must happen once, or reach somebody, relied on timing or on a person noticing. Two runs at once gave the same free hour twice;
  a webhook that failed eight times was simply gone; a long backup held up the outbox and refunds behind it; a venue's own system saw a slot taken that its public grid showed free; and a private hire
  enquiry was seen only by a venue that had set an alert email.

## Decision 1 (G19): a free hour for regulars is given once, by a unique key in the database

- A reward is the Nth given to a phone number at a venue. `loyalty_rewards` gains `n`, and **(venue, number, n) is unique** (migration 0320). The grant claims the place first
  (`INSERT … ON CONFLICT DO NOTHING`), issues the pass and ties it to the row, and queues the email, **in one transaction per reward** (`giveReward`, `src/lib/loyalty.ts`).
  A second run that finds the same hour due, from another instance, a lease lost mid-run or a retry, finds the place taken and issues nothing; a stop part way gives all of it or none.
  The scheduler's "done today" marker stays, as a saving of work, not as the guard. Nothing is held in memory.
- **Rewards already given are kept exactly as they are.** The migration numbers them in the order recorded (by id) within their venue and number, so a number that already holds two rewards for
  one earned hour keeps both, as 1 and 2: nothing is deleted or merged, the index cannot fail on them, and the count the grant works from does not change. Given twice before, the customer keeps
  the second hour (the customer-protective fallback; nothing is clawed back).
- **Review of past duplicates:** `scripts/reconcile-loyalty.sql` is read only and lists numbers with more free hours recorded than their played hours earn, and free-hour passes no reward row
  points at. It is a lead for a person, not proof (the venue's rule may have changed since). Voiding or keeping a pass is the venue's decision.

## Decision 2 (G17): a webhook delivery that used its attempts stays visible and can be sent again

- The delivery row is the record. It now keeps when it was last tried (`last_attempt_at`) and how many times it was sent again (`redeliveries`, `redelivered_at`, migration 0321, with a deterministic
  backfill of the last attempt for existing rows). Under each address, the integrations panel lists the ones that used their eight attempts: event, event id, attempts, last status and error,
  last attempt, times sent again. **Never the payload**, which names the customer.
- A manager of the owning venue (managers only, as the whole panel; a front-desk user and another venue's manager are refused) can send one delivery, or an address's failed ones (at most 50 a
  time), again: the **same payload, so the same event `id`**, signed afresh, attempts counted from nothing, due now. It is one statement whose test is on the row itself, so two presses, or two
  managers at once, send it again once. It is refused while the address is turned off (turning it back on is a decision of its own). Each press is in the activity log with who and how many.
- **Retention is the existing 30 days** from the event ([privacy](../privacy.md)): a failed delivery is purged with the delivered ones, no queue grows. A delivery waiting on an address turned off,
  which nothing would ever send, is now also purged after those 30 days (it stayed for ever before).
- *Sent* means MySenam made the request and got a 2xx. It says nothing of what the receiver did, and the panel says so. Not verified against any real receiver (a stand-in is all the tests have).

## Decision 3 (G18): the backup and its off-site copy are their own unit, on their own lease

- `runScheduledWork` is two units. The **short** unit (outbox, refunds, holds, invoices, everything else, and the heartbeat) and the **long** unit (the erasure ledger's off-site copy, the backup and its
  off-site copy). The scheduler ticks them every minute **apart from each other**, each under its **own lease row** in `settings` (`scheduler_lease`, `scheduler_lease_long`), each with its own
  "still running" flag. For the hour a large backup and upload can take, the outbox, refunds and the heartbeat still run each minute.
- One instance may hold either lease or both, and another the other; two instances starting the long work together run it once.
- **Bounded:** the long unit is waited for at most `MYSENAM_LONG_JOB_MINUTES` (default 120). Past it the lease is not renewed, so it runs out within three minutes and another instance may take the
  work, and the owners are told (`scheduler:long-jobs-overran`). The work is not cancelled (a request in flight cannot be taken back), so the process that started it starts no second backup until
  it ends. No job system was added.
- The hourly check that a recent enough copy exists runs in the short unit, so a stuck long unit is still noticed.

## Decision 4 (B15): the venue's API lets go lapsed holds as the public grid does

- `GET /api/v1/availability`, `POST /api/v1/bookings` and the MCP server's `my_availability` and `create_booking` call `releaseExpiredHolds()` first, the same function the public grid, search and
  booking route call. The venue's own system no longer sees a slot taken for up to a minute that the public grid shows free.

## Decision 5 (E17): an unanswered private hire enquiry is on the needs-attention list

- `GET /api/admin/attention` gains `enquiries`: enquiries still `new`, oldest first, with their age and, after **two days** (`ENQUIRY_NUDGE_DAYS`), a gentle line that the customer is waiting. It stands
  whether or not the venue set an alert email or WhatsApp number, is visible to the venue's own staff (front desk too) and the platform owners, and carries the name and kind only, never the message or
  number. It sends nothing to anybody; an enquiry leaves it when staff mark it replied, booked or declined.

## What was left open

- **No acknowledgement to the enquirer** (the audit's other half of E17) was built: a message to somebody who has not agreed to one, and a promise the venue has not made. For the owner.
- **Events a webhook missed** while its address was off, for a booking more than two days old when first seen, or further than 120 days ahead, are still not replayed (G17's other half).
- **A lost lease does not cancel work in progress** (the audit's remark under G18): two instances can still overlap on one job if a renewal fails. Jobs stay idempotent; this is unchanged.
- **Long work other than the backup** (e-invoice submission, document scanning, the accounting push) is still in the short unit and could still delay it if a provider hangs.
- **Free hours given twice before migration 0320** are for a venue's decision, not the app's.
