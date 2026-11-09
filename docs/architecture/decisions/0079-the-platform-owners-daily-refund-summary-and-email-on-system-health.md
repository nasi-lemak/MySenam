# ADR 0079: The platform owners get one daily summary of what the venues owe back at the counter, and System health shows email as the outbox knows it

- **Status:** current, decided 2026-11-09 in the hardening round (brief DIGEST). No migration: the summary reads `counter_refunds_owed`, `online_payments` and `admins`,
  the email section reads `messages`, `system_alerts` and the environment, and the summary is deduplicated by the outbox's own key. What the owner sees is in
  [monitoring](../../operations/monitoring.md#email-on-system-health) and [daily operations](../../operations/pilot-daily-operations.md#every-day); the counter rule is in
  [owed back after the venue cancels](../../features/payments-and-credit.md#owed-back-after-the-venue-cancels); the response is in [the HTTP API](../http-api.md). Settles what
  [ADR 0076](0076-three-operator-visibility-gaps-the-heartbeat-a-payment-mismatch-and-counter-refunds-owed.md) left open (*who the designated operator is*) and builds on
  [ADR 0073](0073-security-mail-is-its-own-class-and-a-production-marketplace-needs-email-that-can-deliver.md) (email configuration and health).
- **Context:** the daily message about counter refunds owed back went only to each venue's managers. The platform owner saw the *Needs attention* line only by opening it,
  was never told when a venue had no manager to tell, and had no one place for overdue refunds and payments to check across venues. Separately, `emailHealth` was already in
  `GET /api/admin/system` but the owner's dashboard showed no email section: the numbers were raw data nobody looked at.

## Decision 1: one summary per platform owner per platform day, through the same path

- **Recipients:** every platform owner (an admin with no venue and no business) with an address. An owner whose account has no address is skipped and counted; if there is
  something to tell and no owner has an address, the alert `owner-refunds:no-recipient` stands on *System health* instead (its own email reaches nobody either, which is why the
  panel is where it shows).
- **When:** the scheduler's short unit, after the venues' own messages (`sendCounterOwedDigests`), from `COUNTER_OWED_DIGEST_HOUR` (09:00) on the **install's** clock
  (`installZone`, Asia/Kuala_Lumpur for Malaysia): one platform day, not a venue's. No new scheduler, job table or alert channel.
- **Window:** the 24 hours ending at the moment the numbers are read, stated in the message in the install's zone, with the day and the zone. Outstanding counts are as they stood
  at that moment.
- **What it says** (`ownerRefundSummary`, one SQL statement so every number is of one moment): per venue, refunds still owed (count, sum, the oldest's whole days, how many have
  waited `REFUND_OVERDUE_DAYS` or more), newly owed in the window and settled in the window (by `settled_at`), and the venue's payments to check (the list itself:
  `settlement_issue` set and not reviewed, not the `payment:check:*` alerts, which an owner can mark *Dealt with* while the payment still waits). Split into *For the venue to hand
  back* (each venue's own obligation to its customers) and *For the platform to follow up* (overdue refunds, payments to check, a venue with something owed and no manager with an
  address). The words never say the platform owes the money. Counts, sums, ages and venue names only: no customer name, phone, email or booking code.
- **Nothing to tell, nothing sent:** when nothing is owed back anywhere and no payment waits to be checked, no message is queued, even if refunds were settled in the window. A
  summary every day that says "nothing" trains people to ignore it; the settled ones stay on the venues' lists; a day with no summary means nothing was waiting at 09:00 (the
  scheduler line on *System health* says whether the scheduler ran).
- **Once:** each owner's message is queued under `owner-refunds:<day>:<email>` (the outbox writes a key once), so repeated ticks, a restart or two servers write nothing more.
  The function returns `queued`, never "sent": the outbox tries, retries with its backoff and gives up as for every message, and a failure shows in the *Email* section below.
- **Overlap:** an owner is never also a venue's manager. Admin accounts are one per address (`admins.email` is unique, case-insensitive) and an owner's account has no venue or
  business, so no address receives both the venue's message and this one. Were that ever to change, the owner's summary is the one to keep: it holds every venue's numbers.
- A venue whose managers nobody could email is no longer counted as told by `sendCounterOwedDigests`, and owner and venue alerts skip an account with a blank address
  instead of queueing a message to nobody (`tellOwnersEach`, `tellVenueStaffEach` now return how many were queued).

## Decision 2: System health has an Email section, read-only, owner only

`GET /api/admin/system` stays owner-only (a venue's manager and the front desk are answered `403`, as before; venues never see platform-wide messaging). `emailHealth` adds,
from bounded and mostly indexed reads, the last 24 hours' acceptances and failures and the last acceptance, security mail given up for its link running out, security mail being
retried, up to five recent failure reasons, the open email alerts, the warnings with their thresholds (the alerts' own: 5 tries and half failed; 30 minutes waiting) and a no-data
flag; the configuration now says whether a delivery check is recorded for this provider and sender, for another, or not at all (never the value). Failure reasons are sanitized
(`sanitizedReason`): addresses, links, long tokens and configured secrets are taken out, and the text is cut short. The same sanitizing now applies to the error quoted in the
`email:failing` alert, which goes by email and to the webhook.

The words are fixed: *Queued*, *Accepted by provider*, *Failed*, *Abandoned*, *Delivery verified (separately confirmed)*. Acceptance by SES is never called delivery; only the
recorded inbox check is. The section is amber with its warnings and names the procedure documents by path (the dashboard has no document viewer; the alerts name paths the same way).

## Not decided here

- **Competition entry fees owed back at the counter** (`counter_fee_refunds_owed`) are in neither the venues' nor the owners' daily message, as before; adding them is a small change
  and a decision about whose obligation they are.
- **"Counter payouts awaiting confirmation"**: there is no such state. A counter refund is owed (`settled_at` null) or settled with its payout written at once
  ([ADR 0077](0077-staff-taking-a-person-off-at-the-counter-hand-the-money-over-then-and-it-is-written-as-the-payout-it-is.md)); nothing waits for a confirmation.
- An index on `messages.last_attempt_at` (the 24-hour reading is one pass over the email rows on each load of the owner's dashboard); a migration was out of scope.

## Alternatives considered

- **Copy the owners on each venue's message:** rejected; one message per venue per owner is many messages, and it would not show what needs the platform.
- **A "nothing outstanding" line every day:** rejected above.
- **Counting open `payment:check:*` alerts:** rejected; the list is the record, and an alert can be cleared by hand while the payment still waits.
- **A new monitoring page or alert channel for email:** rejected; the owner's dashboard and the existing alerts are where the owner already looks.

## What the tests do not prove

`tests/owner-refund-digest.test.ts` (PGlite and Postgres), `tests/email-health-owner.test.ts` (PGlite and Postgres) and `tests/email-health-panel.test.tsx` run with a stood-in
transport and a fake clock. They prove the window, the Malaysian day, the keys, the split, the absence of customer detail and secrets, the retries and the giving up as the outbox
records them, and what the panel says. They do not prove that a message reaches an inbox (email stays unverified live: [the SES checklist](../../operations/email-ses-checklist.md)),
that anyone reads it, or that the 24-hour pass stays cheap on a large `messages` table.
