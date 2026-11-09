# Pilot completion record, 8 November 2026

What the pilot-completion round did after the [pilot activation record](pilot-activation-2026-11-08.md),
what it changed, and exactly what is still open. It records only what was performed; nothing here
says a blocked or owner-gated check passed. The capability matrix stays in
[pilot readiness](pilot-readiness-2026-11-07.md); how each provider check is run is in
[provider verification](pilot-provider-verification.md).

## Results by phase

| Phase | Result |
| ----- | ------ |
| Release and AI VM health | The previous source `f1c2c52` passed the full release profile on the AI VM (see [testing](../development/testing.md#release-records)). The disk guard raises `disk:warn`, `disk:critical`, `disk:full` and `backup:no-space`, refuses a backup that cannot be written (no false success) and never blocks bookings; tested in `tests/disk-health.test.ts`. No blanket prune was run; only merged agent worktrees, older browser evidence and temporary directories were removed |
| SES | **Delivery NOT verified.** SES accepted the controlled test, sign-up, password-reset and cancellation messages; nobody has yet read the messages at the approved recipient or the `spf`, `dkim` and `dmarc` headers, and the key cannot read the account or identity. The owner's inbox and header checklist (with DMARC passing by aligned DKIM, not SPF) and the least-privilege IAM policy are in [the SES checklist](email-ses-checklist.md); nothing was granted. `MAIL_DELIVERY_VERIFIED` stays unset |
| Backblaze B2 | **BLOCKED.** Owner checklist for the first real off-site backup, what is and is not backed up, and the restore drill with a blank four-timing table are in [backups](backups.md). No real check was run: the endpoint, bucket, encryption key pair, data-location declaration and transfer approval are not set |
| Billplz | **BLOCKED — online checkout must remain disabled.** The sandbox procedure is in [provider verification](pilot-provider-verification.md); no sandbox credentials or public staging address exist |
| Visibility | Built and tested, **not live-verified**: the owner's dashboard shows the scheduler heartbeat; a payment mismatch raises an owner alert (`payment:check:<id>`); counter refunds owed have a *Needs attention* line and a daily manager message after 09:00 ([ADR 0076](../architecture/decisions/0076-three-operator-visibility-gaps-the-heartbeat-a-payment-mismatch-and-counter-refunds-owed.md)). The external uptime and TLS monitoring specification is in [monitoring](monitoring.md#external-monitoring-for-the-pilot); none is configured |
| Cash-up | The staff withdrawal defect is fixed: a staff member taking a person off at the counter and handing the money over writes the payout, so the till reconciles ([ADR 0077](../architecture/decisions/0077-staff-taking-a-person-off-at-the-counter-hand-the-money-over-then-and-it-is-written-as-the-payout-it-is.md)). The historical cancellation review script and checklist exist; **no historical review has happened** |
| Legal and operating | The [legal review packet](legal-review-packet-2026-11-08.md) is unchanged: every item NOT REVIEWED. The daily reconciliation operator role and the proposed operating targets are in [daily operations](pilot-daily-operations.md); the targets are proposals for the owner to confirm, and no operator is named |
| Rehearsals A–E | As in the [activation record](pilot-activation-2026-11-08.md#5-rehearsals): A not run against a deployed environment, B partial, C not run against a real provider, D blocked, E blocked. None is claimed as passed from unit tests |

## What changed in the application

Operational defects only, each with its decision record and tests, and each in
[known limitations](../roadmap/known-limitations.md): the operator-visibility gaps (ADR 0076,
`tests/operator-visibility.test.ts`, `tests/operator-visibility-ui.test.tsx`) and the staff
withdrawal cash-up (ADR 0077, `tests/staff-withdrawal-cash-up.test.ts`). Because application source
changed after `f1c2c52`, the full release profile was run again on `354f346` on the AI VM and **passed** (7192 s: PGlite 7034 passed and 15 expected skips, Postgres 7050, docs 181, end-to-end 12, acceptance 95; source digest `f96d9442…`); see [testing](../development/testing.md#release-records). That is not CI and checked no real service.

## What is still open (needs a person or a credential)

- SES: read the test messages and headers, then set `MAIL_DELIVERY_VERIFIED`; optionally grant the read-only permissions in the checklist.
- B2: provide the endpoint, bucket, encryption key pair and declarations; then the off-site checks and an isolated restore with the four timings.
- Billplz: sandbox credentials and a public staging address.
- External uptime and TLS monitoring; the legal and tax reviews; a named daily reconciliation operator; confirmation of the proposed targets; running the historical cancellation script on the venue's real data.

## Status

| Subject | Status |
| ------- | ------ |
| Counter-only pilot | Waits on SES inbox confirmation, B2 round trip and restore, legal review, monitoring and a named operator |
| Billplz online checkout | **NOT READY** |
| SES delivery | **UNVERIFIED** |
| B2 recovery | **UNVERIFIED** |
| Legal review | **PENDING** |
