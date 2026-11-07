# Real-provider verification for the restricted pilot

What must be shown against the **real** services before a staffed pilot takes real
customers, how each check is run, what counts as proof, and what does not. The suites use
stand-ins for every provider: a passing test run is not one of these checks
([testing](../development/testing.md#release-records)). Credentials and recipients are the
owner's; nothing here is run with live keys, a real customer's address or a chargeable
operation. The runner is `scripts/verify-integrations.mjs`, which refuses live keys, prints no
secret, sends only to the recipients named in `VERIFY_*_TO` and only with `--send`, and writes
`artifacts/integrations/<provider>-<time>.json` (not committed).

Results below are those of **7 November 2026**, run on the AI VM. A provider is verified only
when its own check passes against the real service.

| Provider | Needed for the pilot | Result on 7 November | What is missing |
| -------- | -------------------- | -------------------- | --------------- |
| Amazon SES | Yes (every customer message) | **PARTIAL, not delivery-verified**: DMARC (`p=none`) and SPF records for `mysenam.com` found; the key in the environment cannot read the account or the identity (403 for `ses:GetAccount`, `ses:GetEmailIdentity`), so sandbox or production access, quota, domain verification and DKIM are **unknown**; no message sent | An approved test recipient (`VERIFY_EMAIL_TO`), then `--send`; a read-only IAM grant for the two Get calls (or the owner reading them in the console); a human confirming inbox receipt |
| Backblaze B2 | Yes, before any real data | **BLOCKED**: no off-site credentials in the environment | Bucket, two scoped keys, encryption key pair, data-location declaration and transfer approval |
| Billplz | Before online checkout only | **BLOCKED**: no sandbox credentials | Sandbox API key, collection id, X-Signature key; a public callback address |
| Stripe, WhatsApp, SMS, MyInvois, Xero, Google sign-in | No: stay off | NOT RUN | Not needed for the pilot |

## 1. Amazon SES (mandatory)

Run `node scripts/verify-integrations.mjs email --send` with the SES key, `MAIL_FROM` and
`VERIFY_EMAIL_TO` set to an address the owner controls (in the SES sandbox it must be a
verified identity). It reads the account (sandbox or production, quota), the sending identity
(verified, DKIM status), the domain's DMARC and SPF, and sends one synthetic message. The
step-by-step setup and what each setting means are in the
SES checklist (docs/operations/email-ses-checklist.md, added with the email changes).

Pass means all of: the account is in production access (or every pilot recipient is a verified
identity); the domain identity is verified with **DKIM successful**; DMARC and SPF are
published and the message **passes DMARC** (read the received message's headers: `dmarc=pass`
through DKIM alignment; this domain's SPF record names only Proton, so alignment must come from
DKIM); click and open tracking are **off** for the identity (a rewritten reset link would
break); the IAM key may send and nothing broader; and **a person received the message**.
Acceptance by SES (HTTP 200) is not delivery and is not inbox placement.

Then, with the application pointed at SES and approved test recipients only: a sign-up
verification, a password reset, a booking confirmation and a refund notice each arrive; a
reset requested after eight ordinary messages to the same address still arrives; a
deliberately bad recipient produces a permanent failure shown to the operator, and a stopped
provider produces retries and an alert, not a false "sent". Bounces and complaints are **not**
read back by the application today (known limitations): the owner watches the SES reputation
dashboard during the pilot.

## 2. Backblaze B2 backup and restore (mandatory before real data)

1. Declare and approve the transfer first ([privacy](../architecture/privacy.md#backups-held-abroad)):
   `OFFSITE_DATA_LOCATION`, and abroad `OFFSITE_TRANSFER_APPROVED` with encryption.
2. A bucket in the chosen region with **Object Lock** (versioning, retention) on; an upload key
   and a **separate read key**, neither with delete or retention powers; the encryption key
   pair, the private key kept off the server and out of Git.
3. `npm run verify-offsite` (says what it would check), then `npm run verify-offsite -- --go`
   from a test machine: it uploads a synthetic signed set under a `verify/` prefix, downloads
   it with the read key, checks the manifest and integrity, and tries each refusal (overwrite,
   delete). It also times the download (`--size-mb 200`).
4. Restore the downloaded set **into an isolated machine** and run the application against it
   (the drill in [backups](../operations/backups.md#verifying-a-real-bucket)); check the booking
   and balance counts match the source. **Never** restore into or over the production database.
5. Write down the observed steps and the measured time: no recovery target is claimed until it
   has been measured.
6. A failed backup raises an owner alert (checked by stopping the upload key's access for one
   run).

Pass means the synthetic set round-tripped, restored in isolation and matched, with the refusals
refused and the time recorded. A passing stand-in test does not count.

## 3. Billplz sandbox (mandatory before online checkout)

Set `BILLPLZ_SANDBOX_API_KEY`, `BILLPLZ_SANDBOX_COLLECTION_ID`,
`BILLPLZ_SANDBOX_X_SIGNATURE_KEY`, then `node scripts/verify-integrations.mjs billplz`; for the
full path run a staging deployment on a public address (`scripts/stage-remote.mjs`, so the
callback can reach it) and `... billplz --through <url>`. Record, from the sandbox, not from the
documents: bill creation; the callback's fields (`id`, `collection_id`, `state`, `amount`,
`paid_amount`, `x_signature`) and whether `paid_amount` is present; the redirect's signed
fields; whether a bill can be paid short or over (the settlement code holds a callback without
`paid_amount`, so if the sandbox never sends it, **every** Billplz payment is held); duplicate
and delayed callbacks; a hold that lapsed before payment; a manual refund through the
Refunds owed list; and the failure notices. Online checkout is offered only after these pass.

## 4. Everything else stays off

Stripe auto-renewal, WhatsApp (and its resubmitted waitlist template), SMS, MyInvois (the
stored-value treatment is a tax adviser's, [memo](einvoice-stored-credit-memo.md)), Xero and
Google sign-in stay disabled for the pilot unless a venue actually needs them and its own check
has passed. Nothing is purchased to complete a check.

## Outstanding actions for the owner

1. Name an approved test recipient for SES (`VERIFY_EMAIL_TO`) and run the `--send` check; grant
   the key `ses:GetAccount` and `ses:GetEmailIdentity` read access (or read the console).
2. Provide B2 credentials and the transfer approval; run the off-site check and the isolated
   restore drill; record the time.
3. Provide Billplz sandbox credentials and a public staging address; run the sandbox check.
4. Name the daily reconciliation operator, and get the legal documents reviewed.
