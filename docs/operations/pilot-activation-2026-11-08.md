# Pilot activation record, 8 November 2026

What was checked, against real services and in the environment, to move MySenam from a verified
software release candidate towards a restricted Malaysian pilot, and exactly what is still open.
It records only what was performed; nothing here is a statement that a blocked check passed.
Companion documents: [pilot readiness](pilot-readiness-2026-11-07.md) (the matrix, the source of
truth), [provider verification](pilot-provider-verification.md) (how each check is run),
[SES checklist](email-ses-checklist.md), [daily operations](pilot-daily-operations.md),
[legal review packet](legal-review-packet-2026-11-08.md) and
[monitoring](monitoring.md#external-monitoring-for-the-pilot). Release verification of the
source is in [testing](../development/testing.md#release-records).

**Verdict: RELEASE CANDIDATE — EXTERNAL CHECKS PENDING.** Billplz online checkout is **not
ready** (no sandbox credentials). A counter-only pilot waits on the SES inbox confirmation, the
B2 round trip and restore, the legal review, monitoring and a named operator.

## 1. Baseline

Commit `8899dc0`, clean tree; the only change since the verified source `d844e4a` (digest
`50df113e…`) was the release record. This round then changed application source (a cash-up
correction and a disk-space guard), so the source is verified again by the record that follows
this one in testing.md; until that record says PASS, the pilot's code is **not verified**.

## 2. Provider results

| Provider | Configured | Credentials | Permissions | Real provider contacted | Tests performed | Result |
| -------- | ---------- | ----------- | ----------- | ----------------------- | --------------- | ------ |
| Amazon SES | Partial: region `ap-southeast-1`, sender `noreply@mysenam.com`, the SES key and an approved test recipient are set; no configuration set; `MAIL_DELIVERY_VERIFIED` unset | Yes | **Partial**: the key can send but not read the account (`ses:GetAccount`) or the identity (`ses:GetEmailIdentity`), both 403; so production-versus-sandbox access, quota, sending rate, domain verification and DKIM status are **unknown** | Yes | See below | **PARTIAL — delivery NOT verified** |
| Backblaze B2 | **No**: the upload and read keys are set; the endpoint, bucket, encryption key pair, data-location declaration and transfer approval are not | Partial | Not testable | No | `verify-offsite` and `verify-integrations b2` dry runs name what is missing | **BLOCKED** |
| Billplz | **No** | No | Not testable | No | `verify-integrations billplz` dry run | **BLOCKED** |

### SES, what was actually done (8 November 2026)

- Read-only: DMARC `v=DMARC1; p=none; rua=mailto:dmarc@mysenam.com` found; SPF `v=spf1 include:_spf.protonmail.ch ~all` found. The SPF record names only Proton: a message sent through SES passes DMARC by **DKIM alignment**, which could not be read (the identity is unreadable to this key), so DKIM is unverified.
- `verify-integrations.mjs email --send`: SES **accepted** the synthetic message for the approved recipient (a provider message id was returned). Acceptance is not delivery.
- The application's own mail through the real SES transport, with every recipient except the approved one refused before any call (nothing else was sent), on a throwaway in-memory database: after the ordinary daily limit to that address was spent (eight messages), the **sign-up link and the password-reset link were both accepted by SES**; a customer cancellation (counter-paid booking) produced a cancellation notice that was accepted by SES (with the ordinary limit clear). When the ordinary limit was spent, the cancellation notice was correctly **not sent** ("already 8 messages"), which is the designed ordinary limit and is why security mail has its own.
- About six messages in all reached the approved recipient's address from these runs.
- **Not done:** the booking-confirmation notice and the refund-owed notice were not triggered by the rehearsal; the links in the test mail point at a placeholder address, so single-use and no-tracking-redirect of a reset link could not be exercised from an inbox (needs a public staging address); expiry and provider-outage retry are covered only by tests with a stubbed transport; bounces and complaints are not read back by the application.
- **Needs a person:** open the messages at the approved recipient, and confirm they arrived (inbox, not spam), the sender, the content, `spf`, `dkim` and `dmarc` results in the headers, and that no link was rewritten. Only then set `MAIL_DELIVERY_VERIFIED` to the value `verify-integrations.mjs email --send` printed (it names the provider and sender) and restart. Until then do not accept real customer registrations.

### B2 and Billplz

Nothing was contacted. For B2 the owner must provide the bucket name and endpoint (documented
form `https://s3.us-west-004.backblazeb2.com`), a freshly generated encryption key pair (the
private key kept off the server), the data-location declaration `OFFSITE_DATA_LOCATION` and the
transfer approval `OFFSITE_TRANSFER_APPROVED` (a decision with the lawyer's answers, in
[privacy](../architecture/privacy.md#backups-held-abroad)). Then `npm run verify-offsite`,
`npm run verify-offsite -- --go`, and an isolated restore drill with the four timings recorded.
For Billplz the owner provides the sandbox API key, collection id and X-Signature key and a
public staging address; online checkout stays off until the sandbox results are accepted.

## 3. Cash-up and counter refunds

Before this round the cash-up read neither the owed list nor the payouts: it subtracted a
customer's credit note on the day it was written, under the original method, whatever was handed
over, when or how. Now expected per till is the cash received less refunds actually handed back,
by the day and method of the payout; refunds owed show apart ([ADR 0075](../architecture/decisions/0075-the-till-is-compared-with-cash-received-and-cash-handed-back-and-a-credit-note-is-not-a-payout.md)).
The credit note is not re-dated and the sales journal is unchanged. Worked per-day examples
(including the owner's 8 and 9 November case) are in the ADR and
`tests/cash-up-refunds-across-days.test.ts`. The historical review script
`scripts/reconcile-counter-cancellations.sql` now yields the manual-review table (venue, booking
code, cancellation date, amount possibly owed, original method, payout evidence, possible
duplicate, staff action; no names or phone numbers). It was exercised only on seeded rows;
**running it against the pilot venue's real data, and reviewing each candidate by a person, is
an open action**. Whether a customer's credit note should be dated at settlement is a question
for the owner and the adviser.

## 4. Environment

AI VM disk before cleanup: 91% (3.7 GB free); after removing merged agent worktrees, older browser
evidence and stale temporary directories: 82% (7.3 GB free). Nothing outside disposable artifacts
was removed and no blanket prune was run. A disk guard now exists in the application and the
runner (section 3 of the [hardening notes](../development/testing.md)). External monitoring is
**not configured**: see the table and recommended minimum in
[monitoring](monitoring.md#external-monitoring-for-the-pilot). The scheduler, backup and outbox
alerts exist; there is no alert for payment mismatches and no screen for the heartbeat
([known limitations](../roadmap/known-limitations.md)). Remaining infrastructure risks: no
off-site backup yet, no external uptime monitor, a Postgres volume elsewhere is not watched, a
killed verification run leaves its throwaway container.

## 5. Rehearsals

| Scenario | Result | What was done |
| -------- | ------ | ------------- |
| A Normal booking | **NOT RUN** against a deployed environment | The acceptance suite exercises it with logged (not sent) mail; the SES leg is above |
| B Customer cancellation | **PARTIAL** | Counter-paid cancellation, owed-back task, notice through real SES to the approved recipient, and the cash-up across days are tested; no deployed environment, no staff settlement on a real till |
| C Failed communication | **NOT RUN** against a real provider | Provider outage, retry, expired links and the operator alert are tested with a stubbed SES transport |
| D Data recovery | **BLOCKED** | No B2 bucket; the local backup and restore are tested by the suite with stand-ins; no recovery time was measured |
| E Billplz | **BLOCKED** | No sandbox credentials or public staging address |

## 6. Legal, operating procedure

The [legal review packet](legal-review-packet-2026-11-08.md) lists L1 to L16, every one **NOT
REVIEWED**; the stored-value e-invoice treatment (L15) stays unresolved and e-invoicing stays off
for stored-value sales. The [daily operations](pilot-daily-operations.md) procedure is written
for a non-technical named operator and has blank fields for every limit and response time.

## 7. Launch gates, as they stand

| Gate | State |
| ---- | ----- |
| SES email delivery verified | **No**: accepted by SES, inbox and headers not yet confirmed by a person |
| B2 upload and isolated restore verified | **No**: blocked |
| Privileged staff two-factor enrolled | Built; to be enrolled by the operator before first use |
| Legal documents reviewed | **No** |
| Daily reconciliation owner assigned | **No** |
| Historical counter-refund candidates reviewed | **No** (no production data yet; run the script before opening) |
| External monitoring configured | **No** |
| No unresolved P0 or enabled-feature P1 | No known P0 or P1 in the enabled pilot features |
| The actual release revision verified | See testing.md for this round's record |
| **Billplz online checkout ready** | **No** |
