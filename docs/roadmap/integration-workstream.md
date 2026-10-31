# Real-service verification: the next workstream

Planned work, not operational. The owner (29 October 2026) closed round 9
and asked that what is built now be checked against real services instead of
simulated ones, before more product work and before a first venue is onboarded.
This page orders that work, says what each step needs from the owner, and what
it costs. What is true now is in [feature status](../product/feature-status.md)
and [known limitations](known-limitations.md); a service stays
`INTEGRATION_VERIFICATION_REQUIRED` until its own check has passed against the
real service, and the result is recorded there with its date and in a
[release record](../development/testing.md#release-records). The
checks and what each service needs first are in the
[launch integration checklist](../operations/deployment.md#launch-integration-checklist).

## How it is run

- **One integration agent**, working through the steps in order, owns the
  work and every change to the app it needs. Parallel workers only for tasks
  that touch different files and need nothing from each other (a transport
  adapter and its tests; generating test keys; documentation).
- **Targeted tests while building; the full suites once**, after the
  integrated changes of a step that changed code. Documentation-only changes
  run `npm run docs:check` only.
- **Credentials** go into the cloud environment's secret settings (the
  environment menu in the session's title bar, then Edit), never into chat,
  files or commits; test or sandbox keys only, live keys refused by the
  checks. Nothing is printed of a credential. A rotated or revoked key is
  replaced the same way.
- **Costs are kept at zero** unless the owner approves a figure first. Nothing
  paid is created without it ([deployment](../operations/deployment.md)).
- **Synthetic data only**: a check never copies production data, and sends
  only to recipients the owner names.

## What this environment can reach

Checked on 29 October 2026 with no credentials: HTTPS reaches Stripe's, Meta's,
Billplz's sandbox, Backblaze's, Twilio's and Resend's addresses. **Raw SMTP does
not**: connections to ports 25, 465 and 587 are refused here, and cloud hosts
commonly refuse them on new accounts too (to be confirmed for the host chosen).
So email through `SMTP_URL` cannot be proved from here, and may not be
reachable from the production host either. That decided step 1: an HTTPS
transport for Amazon SES is now built next to SMTP
([email transports](../integrations/messaging.md#email-transports)), tested
against a stand-in only. A provider callback or webhook needs a public HTTPS address, which
this environment does not have; a payment is settled here by the return page,
which asks the provider (`scripts/verify-integrations.mjs`), and only the
callback and signature steps wait for a public address (step 4).

## The steps, in order

| # | Step | What it proves | Needs from the owner | Cost |
| - | ---- | -------------- | -------------------- | ---- |
| 1 | **Real email delivery** | A confirmation with its calendar invite, a password reset, a staff invitation and an application confirmation arrive in a real inbox, not in spam, in the reader's language; a reset past its expiry is not sent; what a bounce looks like | Choose the provider (below). A free account, an API key in the secret settings, a recipient address for the checks (`VERIFY_EMAIL_TO`); later the sending domain, whose DNS the owner controls, for SPF, DKIM and DMARC | $0 on a free tier |
| 2 | **Backblaze B2 backups and an isolated restore** | `npm run verify-offsite -- --go --size-mb 200` passes with synthetic data (the upload key refused read, list, delete and a retention change; Object Lock and the lifecycle rule in force; an overwrite leaves the first version restorable); `fetch-backup` and `restore --drill` on an isolated database; the erasure ledger lands signed and encrypted and is read back | The test bucket with Object Lock (14 days, governance), its upload key and read key (write-only and read-only, restricted to the bucket and prefix) in the secret settings. I generate the encryption and signing key pairs; the private keys of the test pair stay off the server and are throwaway | $0 within Backblaze's free storage |
| 3 | **Billplz sandbox payments, and refunds by hand** | A bill paid by FPX and by card in the sandbox marks the booking paid through the return page; an expired hold's bill expires; a venue cancellation leaves the money owed with its due date, and marking it refunded reconciles it | A Billplz sandbox account (free), its API key, collection ID and X-Signature key | $0 |
| 4 | **Production-like configuration and the public address** | The image served over HTTPS with its own Postgres: provider callbacks and webhooks (Billplz callback, Stripe webhook signature, Google sign-in redirect, WhatsApp's delivery webhook) delivered once and replays recorded once; health, alerts, uptime and error reporting each reach a person; the scheduler, nightly backup and restore on that host | Approve one short staging droplet and its cap, or choose another way to give the check a public address (below); an alert email address; a free error-tracking DSN (`SENTRY_DSN`) if wanted | About $0.04 for a two-hour run at the smallest size the kit allows, capped by `--approve-usd` |
| 5 | **Stripe test mode** (Singapore, renewals, one-click refunds) | A test checkout paid, the webhook signature checked, a renewal charged again, a refund through the gateway made once, a refund interrupted and finished once | A restricted test key (`STRIPE_TEST_SECRET_KEY`), and for the webhook, step 4 | $0 |
| 6 | **WhatsApp test number** | A message with the approved template reaches the owner's own number; a phone check by code works; the delivery status comes back | The test number's token and phone number ID, the owner's number on its recipient list; production needs a verified Meta business and approved templates (days to weeks, the owner's) | $0 for the test number |
| 7 | **MyInvois preproduction**, when a venue needs e-invoicing | A document accepted, validated and cancelled on LHDN's preproduction service; the LHDN rules the app follows (seven days, RM10,000, codes, version 1.0 without a signature, the 72-hour window) checked against what it actually does; the interrupted-submission reconciliation tried | A taxpayer's TIN, preproduction client ID and secret registered in the portal, and the venue's adviser for the statutory-period and signature questions | $0 |
| 8 | **Others, only if wanted**: SMS through Twilio, Google sign-in, photos on object storage | Each its own check in `scripts/verify-integrations.mjs` | Only if the launch uses it (WhatsApp may be enough for phone checks) | $0 on trial |

Steps 1 to 3 need no public address and no spend and can start as soon as the
credentials are in place.

## Decisions that need the owner

1. **Email provider.** The owner chose Amazon SES (Singapore,
   `ap-southeast-1`; the domain is bought and SES is set up), and SMTP is
   unreachable from here and may be from the production host. So the
   transport built is SES over its HTTPS API, next to SMTP
   ([email transports](../integrations/messaging.md#email-transports),
   [launch providers](../integrations/launch-providers.md#transactional-email));
   step 1 is checking it against the real account. Resend would need a
   transport of its own and is not built.
2. **How the check gets a public address** (step 4): (a) the existing staging
   kit on one small DigitalOcean droplet, destroyed afterwards, a few cents;
   (b) a free tunnel from this environment, which exposes a running copy
   (synthetic data) to the internet for the length of the check and which
   needs the owner's explicit approval; or (c) skip callbacks and verify only
   what the return page covers. Recommended: (a), with the cap the owner sets.
3. **The domain** the install is served from and sends mail from (an owner and
   operating-company decision, in
   [launch providers](../integrations/launch-providers.md#operating-company-and-jurisdictions)).
4. **When production-like hosting starts costing money**: the droplet sizes,
   the managed database or Postgres on the droplet, and the Object Lock
   retention, are in [deployment](../operations/deployment.md); none is created
   without approval.

## Legal, language and operational readiness stay visible

None of the steps above settles these; each stays in
[known limitations](known-limitations.md#what-the-launch-depends-on) as a
launch blocker until done:

- **Legal**: a Malaysian lawyer's review of the terms, privacy notice and
  venue agreement; breach-notification rules; the transfer safeguards before
  `OFFSITE_TRANSFER_APPROVED` is set for real data (the test bucket holds
  synthetic data only); each venue's adviser on tax and e-invoicing.
- **Language**: native review of the Malay, Chinese and Tamil wording.
- **Operations**: who reads the alerts and the bounce reports, who owns the
  restore drill and how often it is run, who settles refunds owed by hand, the
  incident contact ([incident response](../operations/incident-response.md)),
  and the real figures from the benchmark on the production set-up.

## Exit: ready for a pilot venue

Steps 1 to 4 passed and recorded (email, B2 with an isolated restore, the
payment gateway the pilot venue uses, and the public set-up with monitoring), a
restore drill on the production host, the legal and language items either done
or accepted in writing by the owner, and personalised onboarding of the pilot
venue (its set-up checklist, staff invitations, a test booking cleared before
going live) agreed. Further product work follows real feedback from that venue.
