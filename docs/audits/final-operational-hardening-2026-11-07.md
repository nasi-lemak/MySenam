# Final operational hardening, 7 November 2026

A small, bounded round after the [post-audit hardening round](hardening-2026-11-07.md), to
close the last practical launch risks: essential account emails silently dropped, a counter-paid
cancellation that left no refund task, and production running with no working email. It is not
an audit; it does not add to the audit's finding count (three operational defects already named
as manual safeguards in [pilot readiness](../operations/pilot-readiness-2026-11-07.md) are
closed, and the tests are their regression cover).

Baseline: commit `58dcbb8`, whose source is the one verified on `c23ca9e` (the only commit
between them changes the release record). Working tree clean. Verification of this round's
frozen source is in [testing](../development/testing.md#release-records).

## 1. Essential authentication emails (P1, FIXED)

- **Evidence.** At the baseline, after eight ordinary messages to an address, a password-reset
  link and a sign-up link were both written `abandoned` ("Not sent: already 8 messages") with the
  link forgotten, while the page said *check your email*. Reproduced before the change.
- **Cause.** `limitReached` in `src/lib/outbox.ts` held every kind outside two lists to one daily
  limit counted over *everything*, and sign-up and reset shared the kind `account_email` with
  invitations and guardians' requests.
- **Change** ([ADR 0073](../architecture/decisions/0073-security-mail-is-its-own-class-and-a-production-marketplace-needs-email-that-can-deliver.md),
  migrations 0343, 0344). A new kind `auth_email` for the sign-up link, the reset link, the
  existing-account notice, the two-factor-reset notice and the staff address-moved notice. It is
  not counted in the ordinary limit, ordinary mail never counts it, and it has its own allowance
  (10 a day per address, `MYSENAM_AUTH_MAIL_PER_RECIPIENT_PER_DAY`, 5 to 100), a 60-second cooldown
  per account or address, and no second link while the first email is waiting. The check, the token
  and the email are one transaction under an advisory lock, so concurrent requests make one link.
  Retry is 1, 2, 5, then every 10 minutes while the link is valid; a link that ran out before
  delivery is dropped unsent with an alert; a message past its allowance is `abandoned` with the
  reason, its link voided and an alert raised (never naming the address). "Sent" is recorded only
  after the provider accepted it. The request-side limits stay (reset: 3 an hour per account, 30 an
  hour per client address; sign-up: 3 an hour and 5 a day per address, 5 an hour per client address,
  the last two now settings for shared venue networks). The reply is identical for every address.
- **Tests.** `tests/auth-mail-allowance.test.ts` (25, Postgres included): eight ordinary messages
  then reset, sign-up and notice; repeated, concurrent and mail-bomb requests; an exhausted
  allowance; temporary failure and retry; permanent refusal; a link that ran out; one-time use; an
  unknown address; a shared network. The earlier protections (`auth-review`, `password-reset`,
  `registration`, `sign-in`, `no-enumeration-timing`) pass.
- **Remaining risk.** A person locked out by the allowance has only *ask again later* or Google
  sign-in: no tool sends a link by hand. Real delivery is unverified (section 3).

## 2. Counter-paid cancellations (P1 for counter venues, FIXED)

- **Evidence.** At the baseline a customer cancelling a booking paid at the counter wrote a credit
  note and no refund task, on every customer path (single cancel, series week, class place, account
  closure, place withdrawal, deposit remainder, cheaper move then cancel): 27 of 36 new tests failed
  with the new write disabled.
- **Change** ([ADR 0074](../architecture/decisions/0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md),
  migrations 0346, 0347). The existing owed-back list (no second ledger) gets a row in the
  cancelling transaction, under the booking claim (causes `customer_cancelled`, `place_withdrawn`),
  for the counter payment still on the booking less the venue's late share *on the terms the booking
  was sold on* (ADR 0069). The credit note is the record and not the refund. A named staff member
  settles it once; the payout records amount, method and note; an agreed alternative method is
  allowed and recorded (`settled_via`); the customer is told the venue will return the money at the
  counter, by email where an address exists, and the panel shows whether they were told. A cheaper
  move followed by a cancellation gives two obligations that both settle (migration 0342). "Mark
  unpaid" and a customer cancel can no longer both win.
- **Historical data.** Earlier customer cancellations are **not** turned into tasks (nobody can say
  whether the money was handed over, and a refund must not be paid twice). A read-only
  `scripts/reconcile-counter-cancellations.sql` lists candidates (a heuristic: there is no
  cancelled-by column) for **manual review before the pilot**.
- **Tests.** `tests/customer-cancel-counter-owed.test.ts` (38, Postgres included), the migration
  replay test and a component test; the cross-domain payments test now expects the second obligation.
- **Remaining risk.** The cash-up counts the credit note on the cancel day under the original
  method, so the till and the payout list agree only when both fall on the same day and method
  (writing the note at settlement would move the tax document's date: the owner's and the adviser's
  choice). Staff withdrawing a person at the counter writes no payout record. My Booking does not
  repeat the amount on later visits.

## 3. Email configuration and delivery (P1 readiness gate, FIXED in code; delivery UNVERIFIED)

- **Evidence.** A production marketplace could start with no provider (or `MYSENAM_SEND=log`) and
  answer *check your email* to every sign-up and reset.
- **Change** (ADR 0073). One validator, `src/lib/email-config.ts`, names the state and never a
  value: not configured, invalid, contradictory (SES and SMTP both), missing sender, log only,
  configured but unverified, delivery verified. *Provider reachable* is a separate, explicit,
  never-sending check; *delivery verified* is an operator-set fingerprint (`MAIL_DELIVERY_VERIFIED`)
  printed by `verify-integrations.mjs email --send` only after the provider accepted a message and
  recorded by a person who confirmed the inbox. On a production marketplace a state that cannot
  deliver makes sign-up and forgotten-password requests refuse with *temporarily unavailable*
  (503 `EMAIL_UNAVAILABLE`) and alerts the owner; the only exception is `MYSENAM_SEND=log` with
  `MYSENAM_SYNTHETIC_DATA=on` (staging, acceptance), flagged. A non-marketplace install only
  warns. The system view reports the state, the last hour's sent and failed counts, the queue's
  age and what was given up; `email:failing` and `email:backlog` alerts. No token, link or
  credential reaches a log (asserted in tests).
- **Tests.** `tests/email-config.test.ts` (23): the whole validator matrix, the gate on all three
  routes, a provider down then recovered through the real SES transport with a stubbed `fetch`,
  health numbers, alerts, no secrets in logs.
- **Upgrade effect.** A production marketplace running with no working email now refuses
  sign-up and forgotten-password requests. Staff who cannot reset a password have the existing
  `npm run reset-two-factor` and `ADMIN_PASSWORD` paths.
- **Status of real delivery: NOT VERIFIED.** See the [provider verification](../operations/pilot-provider-verification.md)
  and the [SES checklist](../operations/email-ses-checklist.md). Today's read-only check found
  DMARC and SPF records but could not read the SES account or identity (the key lacks the read
  permissions), and no message was sent because no approved test recipient exists.

## 4. The tournament-day timeout (test defect, FIXED at about 75% confidence)

The timed-out assertion was `staffOnTournaments`' wait for the *Tournaments* heading
(`tests/uat/formats-support.ts:78`) after the tab click had returned. The trace shows the click was
lost: no request was sent and the tab never changed, because the dashboard's late panels (the setup
checklist and the booking link) shifted the tab bar between mouse-down and mouse-up, a window of
about 7 ms. It was reproduced only by forcing the shift between down and up (0 of about 150 plain
attempts lost a click); 2FA, configuration, server health and database contention were excluded.
Product code was not defective (the layout shift is a minor wart a person could mis-click as well).
The acceptance helpers now click until the tab is current (`openDashboardTab`, `tests/uat/harness.ts`)
instead of raising a timeout. The same bare click remains in `competition.uat.ts`, `formats.uat.ts`
and `round5.uat.ts`. The natural occurrence is not reproduced, so the cause stays "very probable", not
proven.

## 5. Provider verification, as of today

| Provider | Local stand-in tests | Real check | Result |
| -------- | -------------------- | ---------- | ------ |
| Amazon SES | Pass | Read-only: DMARC and SPF records found; account and identity unreadable by the key (403); **no message sent** (no approved recipient) | **NOT RUN / PARTIAL** (delivery not verified) |
| Backblaze B2 | Pass | No credentials in the environment | **BLOCKED** |
| Billplz | Pass | No sandbox credentials | **BLOCKED** |

## 6. What did not change

No youth messaging, WhatsApp, Stripe auto-renewal, unsupported e-invoicing, unrestricted
stored-value sales or unmanned hours; no venue-exit lifecycle; no production deployment; no
GitHub Actions run; no provider contacted for a chargeable or customer-facing operation. The pilot
stays one to three staffed venues, counter payments first, Billplz checkout only after its sandbox
check passes.
