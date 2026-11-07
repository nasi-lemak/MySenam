# Email with Amazon SES: the checklist before a production marketplace takes sign-ups

For the operator. Sign-up and forgotten-password requests are answered "check your email", so on a production marketplace they are
only taken when email can deliver ([email configuration](../integrations/messaging.md#email-configuration-and-its-checks),
[ADR 0073](../architecture/decisions/0073-security-mail-is-its-own-class-and-a-production-marketplace-needs-email-that-can-deliver.md)).
This list is what has to be true, who checks it and how. Nothing in MySenam talks to SES until you configure it and, apart from
the controlled check below, nothing sends a real email on your behalf. Do not assume access from the presence of a key: the
check below is what proves it.

Tick each in order. A step that says **a person** needs a human reading an inbox or a console; the app cannot see it.

1. **Region.** Pick the SES region the account will send from (for example `ap-southeast-1`) and set `SES_REGION` to it. SES
   identities, quota, sandbox status and keys are per region: verify everything below in that region.
2. **Verified sender identity.** In the SES console, verify the domain you send from (preferred) or the exact address in `MAIL_FROM`
   (for example `MySenam <no-reply@mail.example.my>`). SES refuses to send from anything else. `MAIL_FROM` must be an address, or `Name <address>`;
   the validator rejects a value with no address in it.
3. **Domain verification and DKIM.** Publish the three DKIM CNAME records SES gives for the domain (Easy DKIM) and wait for the identity to
   show *Verified* and DKIM *Successful*. The verification script reads both from SES and reports them.
4. **SPF.** With SES's own *MAIL FROM* domain or a custom one, SPF is carried by that domain; set a custom MAIL FROM domain (with its MX and SPF TXT
   records) so SPF aligns for DMARC. A bare `v=spf1` on the sending domain is not required for DKIM-aligned DMARC but receivers weigh it; the script
   reports what it finds and says "could not look up DNS from here" when it cannot.
5. **DMARC.** Publish exactly one `v=DMARC1` TXT record at `_dmarc.<domain>` (start with `p=none` and a `rua=` mailbox, then tighten). Two records are
   ignored by receivers; the script flags that.
6. **Click and open tracking OFF.** Sign-up and reset links must reach the person unchanged. Do not enable open or click tracking in
   the configuration set (SES rewrites links when click tracking is on, which breaks the single-use token and routes it through a third party). If
   you use `SES_CONFIGURATION_SET`, check its tracking options in the console; the app cannot see them.
7. **IAM, least privilege.** An IAM user (or role) used by the app needs only `ses:SendEmail` on the verified identity's ARN (and on the configuration
   set's ARN if `SES_CONFIGURATION_SET` is used). For the verification script add `ses:GetAccount` and `ses:GetEmailIdentity` (read-only); remove them
   from the app's runtime key if you prefer, sending is not affected. No `ses:*`, no administration, no other service. Use a key made for this install, not
   a person's; rotate it like any secret, and set it only in the environment's secret store ([configuration](../development/configuration.md)). The AWS_* variable names are
   deliberately not read.
8. **Production access, not the sandbox.** A new account is in the sandbox: it sends only to verified addresses and domains, about 200 a day. Request production
   access in the SES console for the region (a description of the use: transactional booking and sign-in mail to customers who asked for it; how
   bounces and complaints are handled). The verification script reports `ProductionAccessEnabled`.
9. **Sending quota.** Read the account's 24-hour quota and per-second rate (the script prints them). A busy tournament day plus sign-ups must fit with room: a
   message that SES throttles is tried again, but a quota used up delays every customer's mail.
10. **Bounces and complaints.** What the code does today: **nothing**. The app does not read bounces or complaints back; SES accepting a message is "sent",
    not delivered, and a reset link to an address that bounces is invisible to MySenam. What to do now: in the SES console turn on the account-level
    suppression list, set up an event destination for the configuration set (bounces and complaints to an SNS topic or CloudWatch) that **a person watches**, and
    keep the account's reputation dashboard under review. What is missing (a known limitation): reading those events into the outbox and flagging the address.
11. **Settings on the install.** Set `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_REGION`, `MAIL_FROM`; **do not** also set `SMTP_URL` (the validator
    calls both `contradictory`, and a production marketplace refuses sign-ups on it); do not set `MYSENAM_SEND=log`. Start the app: the log must not say
    "Email cannot deliver", and the owners' *System health* must not show *Email is not set up*.
12. **The controlled verification.** From a machine with the same settings, and an address you control (in the sandbox it must be verified in SES):

    ```
    VERIFY_EMAIL_TO=you@example.my node scripts/verify-integrations.mjs email --send
    ```

    It reads the account and the identity, checks DKIM, DMARC and SPF, and sends **one** synthetic message to `VERIFY_EMAIL_TO` only. It prints a line starting
    *record delivery as verified* with a value for `MAIL_DELIVERY_VERIFIED` once SES has accepted the message. **HTTP 200, or SES acceptance, is not delivery.**
13. **A person confirms the inbox.** Open the message at the test address: it arrived in the inbox (not spam), and its headers show SPF, DKIM and DMARC
    passing. If it did not arrive, do not record anything: look at the SES console's sending statistics, the suppression list and the sandbox status.
14. **Record it.** Set `MAIL_DELIVERY_VERIFIED` to the printed value on the install and restart. The owners' alert *Email delivery has not been verified*
    clears; `GET /api/admin/system` shows `delivery_verified`. The value names the provider region and the sender address: changing either needs a new
    check. Nothing records who confirmed or when: write it in the launch record.
15. **A real sign-up and a real reset** from a phone not on the office network, with an address that is not on your domain, arrive within a minute or two; the
    link opens the page unchanged (no tracking redirect).
16. **Provider outage rehearsal (optional, staging).** With a wrong key on a staging install holding synthetic data, ask for a reset: the page says an email is on its way
    and nothing claims it was sent; the *System health* panel shows `email:failing` after enough tries; with the right key back inside 30 minutes the link goes.

If a step cannot be done, the install stays "configured, unverified" and the pilot's email-dependent features stay restricted
([pilot readiness](pilot-readiness-2026-11-07.md)).

## Asking the provider without sending

The owner's `POST /api/admin/system` with `{"check":"email"}` asks SES for the account (or opens an SMTP connection and signs in) and reports whether it
answered and accepted the credentials. It sends nothing, and *reachable* is not *delivered*.

## What the owners see afterwards

`email:failing` (at least half of at least 5 sends in the last hour were refused), `email:backlog` (the oldest waiting email is 30 minutes old),
`auth-mail-ceiling` (an address used up its security-mail allowance), `auth-mail-expired` (a sign-in or sign-up link ran out unsent) and `config:email`
(the configuration), in *System health*, by email, and on `MYSENAM_ALERT_WEBHOOK`. What to do about each: [monitoring](monitoring.md#being-told-when-something-breaks),
and for a person locked out, [security mail](../integrations/messaging.md#security-mail).

## Upgrading an install that had no email

A production marketplace that ran without a working email provider (or with `MYSENAM_SEND=log`) stops taking sign-up and forgotten-password requests when this version
starts, and says why in the log and to the owners. Set the email up first (the steps above), or, for a staging or acceptance install that holds synthetic data and no
real account, `MYSENAM_SEND=log` with `MYSENAM_SYNTHETIC_DATA=on`.
