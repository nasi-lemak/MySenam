# Final bounded housekeeping, 9 November 2026

A bounded round before the restricted Malaysian pilot, authorised for three changes only: recording refunds for customer
cancellations made before migration 0346, the platform owners' daily refund summary with email health on *System health*,
and correcting a stale limitation. Two financial-policy questions were traced and left to the owner. No integration was
touched: no mail was sent, no bucket, payment, staging or DNS was changed, nothing was deployed.

## Baseline

HEAD `a965651`, clean tree; release-verified source `354f346` (digest `f96d9442…`), the three commits after it changing
only the release record (`node scripts/verify.mjs check`: VERIFIED). This round changed application source, so that
verification does not cover it: the result for the new source is in
[testing](../development/testing.md#release-records).

## 1. Cancellations from before money owed back was written down

[ADR 0078](../architecture/decisions/0078-cancellations-from-before-money-owed-back-was-written-down-are-recorded-once-and-change-no-counted-day.md),
migration 0348; what staff do is in [payments and credit](../features/payments-and-credit.md).

- **Identified** per credit note issued before migration 0346 was applied: a customer's cancellation or a customer's or API
  key's withdrawal of a counter-paid booking with no owed row, no payout naming the note and no staff credit for it. The
  read-only script `scripts/reconcile-counter-cancellations.sql` lists the same notes. The evidence the script shows
  (activity-log actions, other credit notes, stored credit) is shown beside each; no customer contact details.
- **Permissions:** managers of the venue or its business and the platform owner; the front desk is refused; another venue's
  notes are invisible and refused.
- **Earlier or now:** handed back earlier is recorded with its actual date (between the note's day and yesterday), method,
  amount and evidence reference, and moves no cash on any day; handed back now is a payout dated now through the existing
  settle path, counted only in today's cash-up; both may be in one record, with any remainder and why it is not returned.
  Too little evidence: nothing is saved and the note stays listed. Nothing is inferred.
- **Data model:** columns on `counter_refunds_owed` (the finding, the parts, evidence, reason, verifier, acknowledgement) and
  `counter_payouts.historical_reconciliation`, with a validated CHECK. No new ledger, no backfill.
- **Duplicates:** one record per cancellation or withdrawal by the existing unique indexes, checked again inside the
  transaction; a second submission or a second manager at the same moment is refused ("already recorded"), tested with
  real parallel transactions on Postgres.
- **Closed periods:** no counted day changes. The historical payout and record do not link the old credit note, so the
  note's day reads as it was counted. Where the note's day, the earlier day or today has a till count, the manager sees it
  in the preview and must acknowledge it.
- **Evidence kept:** the credit note and the sales journal are unchanged; the record keeps the evidence, reason, verifier and
  dates (cancellation = the credit note's date; refund date; recording date); the activity log has
  `payment.historical_reconciled`. Retention is that of counter refunds; no new period.

## 2. The owners' daily summary and email health

[ADR 0079](../architecture/decisions/0079-the-platform-owners-daily-refund-summary-and-email-on-system-health.md); the
owner's view is in [monitoring](../operations/monitoring.md).

- **Summary:** each platform owner with an email, once per Malaysian day from 09:00, the window the 24 hours before it is
  read, through the existing outbox and the scheduler's short unit, queued under `owner-refunds:<day>:<email>` (a repeated
  tick or a second server queues nothing more). Per venue: still owed (count, sum, oldest, overdue), newly owed, settled,
  payments to check; the venues' obligations apart from what needs the platform. No customer details. Nothing is sent when
  nothing waits. "Queued" is reported, never "sent"; failures show in the Email section. An owner with no address is
  counted and, if none has one, an alert says so. Mail is no longer queued to a blank address on the sibling paths.
- **Email section:** read-only, owner only, on *System health*: configuration and delivery verification as recorded,
  queued and the oldest, accepted by the provider and failed, abandoned (security mail apart, and expired), the last
  acceptance, sanitised recent failures, open email alerts, warnings and where the procedure is. It never says *delivered*;
  secrets, addresses and links never appear (tested).

## 3. The stale limitation

The open row "counter refunds: staff withdraw a person at the counter … writes no payout record" contradicted the
fixed row of the pilot-completion round. Checked against the code: the route acts as the member of staff and the withdrawal
writes its payout in the same transaction (`src/app/api/admin/bookings/withdraw/route.ts`, `handBackWithdrawnPlace` in
`src/lib/counter-refunds.ts`, called from `src/lib/place-withdrawals.ts`), with ten tests in
`tests/staff-withdrawal-cash-up.test.ts` (Postgres included). The open row was removed and the cash-up row's gap in
[feature status](../product/feature-status.md) corrected. The narrower variant, money handed back later or another way
than it was paid, stays open as its own row in [known limitations](../roadmap/known-limitations.md).

## Owner decisions traced, not changed

### Mark unpaid (ADRs 0068 and 0075)

**What the code does.** `setPaymentStatus(code, false)` in `src/lib/store.ts`, under the booking's row lock, refuses a booking paid online,
with credit or with a pass, lets the front desk take back only its own tick of the venue's today, and then clears `payment_status`,
`paid_at`, `paid_via` and who took it. It writes no credit note, no payout and no owed row. The activity log records the action.

**What that reverses.** A booking's receipt is not a stored row: the sales journal (`salesJournal` in `src/lib/accounting.ts`) and the
cash-up draw it from `paid_at`. Clearing `paid_at` therefore removes the sale from the journal *on the day it was paid*, and the cash
received from that day's expected till. No receipt email is sent when a counter payment is ticked, so no customer was sent a document
(the customer can still have seen or printed the booking's receipt page).

**Consequences.**

| Case | Effect today | Right? |
| ---- | ------------ | ------ |
| A mistaken tick undone the same day, before the till is counted | The sale and the cash leave that day together | Yes: nothing was received, nothing is reversed |
| A real payment handed back the same day | The sale and the cash leave the day; no credit note, no payout, nothing says money went back | No: a refund without its document or its payout |
| A manager taking back a payment from an earlier day | That past day's journal and expected till change after the fact; a counted day's stored variance no longer matches what the sheet now shows; an export, accounting file or consolidated e-invoice made from that day no longer matches | No: a closed period is rewritten |

**Options.** (1) Keep it a status-only undo but only where nothing was recognised: the same venue day and before that day's till is
counted; anything else is refused and done as a cancellation or refund, which writes the credit note and the payout. (2) Always write a
credit note dated today for a counter payment taken back (the original sale stays on its day), with a payout when money goes back.
(3) Leave as is and correct the documents.

**Recommendation for the owner and the adviser.** Option 1, which matches the owner's provisional preference: no credit note for a
status-only correction where no recognised transaction is reversed, and no silent change to a closed day. A real payment returned is a
refund, recorded as one. The adviser should confirm whether a booking receipt the customer could already see counts as issued. Until
decided, the pilot's operating rule is in [daily operations](../operations/pilot-daily-operations.md).

### A cheaper coach's difference at the counter

**Money flow.** `POST /api/admin/bookings/reschedule` with `coachMoney: "adjust"` on a lesson paid at the counter calls `applyCoachChange`
(`src/lib/lesson-coaches.ts`): a `lesson_coach_changes` row with `refunded` = the difference, `refund_how` = `hand`, and a credit note for
the difference (`creditBookingCoach`), dated at the change. No owed row, no payout. The route does not act as the member of staff, so
the note names nobody. The customer is told the venue *will* give it back.

**Is the cash-up misstated?** Under ADR 0075 a credit note that no payout or owed row points at is cash leaving the till on its day, under
the paid-by method. So:

- handed over at the moment of the change: everybody's sheet is right; nobody's own sheet counts it (the desk's own drawer reads short);
- handed back on a later day: the change day's till reads over and the hand-back day's short, with nothing on either sheet to say why;
- never handed back: the till of the change day reads over, and the money owed to the customer is on no list, no *Needs attention* line
  and no digest.

So yes, it can misstate the till and lose an obligation. The amounts are coach-fee differences, usually small, which is why it is P2.

**How a tracked obligation would correct it.** Exactly the shape of a cheaper move (ADR 0067): at the change, an owed row (a new cause for
the coach change, with its `lesson_coach_changes` id), no credit note; when staff settle it, the credit note and a payout in the same
transaction (`settleMoveDifference`'s shape), or stored credit for an account. It would then be on the owed list, in *Needs attention*,
in the digests and counted on the day the money left.

**Recommendation.** Reuse the owed-back mechanism as above; a business decision because it adds an owed cause and changes what the
customer is told. **Pilot restriction until decided:** for a lesson paid at the counter, choose *keep* (the venue absorbs the difference)
or hand the difference over at that moment, and never promise it for later.

## External checks, unchanged by this round

SES: the provider accepted the test messages; inbox delivery and headers are not confirmed. Backblaze B2: partly configured;
no off-site copy, no restore. Billplz: sandbox unverified; online checkout stays off. Legal review: pending. External uptime
and TLS monitoring: not configured. The historical cancellations of a real venue have not been reviewed.
