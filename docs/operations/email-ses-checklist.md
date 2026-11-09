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

Where the owner looks, without waiting for an alert: the **Email** section of *System health* on the admin dashboard
([email on System health](monitoring.md#email-on-system-health)). After the steps above it should read *Configuration: configured, delivery
verified. Provider: Amazon SES* and *Delivery verified (separately confirmed): yes*; until `MAIL_DELIVERY_VERIFIED` is set to this provider's and
sender's fingerprint it stays amber with "Delivery has not been verified". Its *Accepted by provider* count is SES taking the message, never
proof of delivery: the inbox check in step A is the only proof, and bounces and complaints are not read back ([C](#c-watching-bounces-and-complaints-during-the-pilot)).
Its *Failed*, *Abandoned* and recent failure reasons (the provider's words with addresses, links and secrets taken out) are the first thing to read
when sending stops.

## Upgrading an install that had no email

A production marketplace that ran without a working email provider (or with `MYSENAM_SEND=log`) stops taking sign-up and forgotten-password requests when this version
starts, and says why in the log and to the owners. Set the email up first (the steps above), or, for a staging or acceptance install that holds synthetic data and no
real account, `MYSENAM_SEND=log` with `MYSENAM_SYNTHETIC_DATA=on`.

## Owner: confirm the existing test messages and close the read gaps

*Added 8 November 2026. Written from the activation record and the check's own report; **none of it has been done**. Nothing here
was read in an inbox or in the AWS console by the author, and no message was sent for this section. Status of every row in the
tables below: **NOT CONFIRMED** until the owner fills it in.*

Two things stand between "SES accepted about six test messages" and "email delivery is verified": a person reading what
arrived (part A), and the account and identity settings the sending key is not allowed to read (part B). Part C is what the
owner watches once real customers receive mail. Steps 1 to 16 above say what must be true; this section says how the owner finds
out. Do the parts in order. A message the owner has not opened and read is not confirmed.

### A. Read the messages already sent to the approved recipient

**Which mailbox.** The approved test recipient: the address that was set as `VERIFY_EMAIL_TO` for the 8 November runs. It is
the owner's own; this document does not name it. Only that mailbox received anything (the rehearsal refused every other
recipient before any call to SES: [activation record](pilot-activation-2026-11-08.md#2-provider-results)).

**When.** On 8 November 2026, from about 06:26 to about 07:30 UTC (14:26 to 15:30 in Malaysia, UTC+8). The first, the
integration check, was accepted at 06:26:43 UTC. Search that window, and not only the inbox: also *Spam* or *Junk*, the
*Promotions* tab and *All Mail* (Gmail), and any folder a rule may have moved mail to.

**Which messages to look for.** About six in all. The record names these kinds (the subject wording is the English
dictionary's; `{site}` is the site name the install showed):

| # | Kind | Subject to look for | What it shows if it arrives and reads correctly |
| - | ---- | ------------------- | ----------------------------------------------- |
| 1 | The verification message (`verify-integrations.mjs email --send`) | `MySenam integration check 2026-11-08T06:26:43…` (the ISO time of the run). SES's id for it is in `artifacts/integrations/email-1794119203009.json` on the AI VM (not committed), step *message accepted by SES for the test address*; the id appears in the received `Message-ID` header | That SES delivers from the configured sender to a real mailbox, and the real authentication results |
| 2 | The sign-up link | `Finish creating your {site} account` | That security mail (sign-up) arrives, and its link is not rewritten |
| 3 | The password-reset link | `Set a new password — {site}` | The same, for the reset path |
| 4 | A cancellation notice (a counter-paid booking cancelled by the customer) | `Booking {code} cancelled — {venue}` | That an ordinary customer notice arrives, and says the venue will return the money, not that it was returned |
| 5, 6 | The remaining two or so | Not recorded in the activation record | Write down whatever else from the sender is found in the window; do not guess what it was |

The booking-confirmation notice and the refund-owed notice were **not** triggered by the rehearsal, so they are not in the
mailbox: do not look for them. An earlier run on 31 October (`artifacts/integrations/email-1793459279704.json`, 15:07 UTC) was
also accepted by SES; the file does not say to which address, so treat anything of that date as extra, not as one of the six.

**Do not click the links in messages 2 and 3.** They belong to a throwaway database and point at a placeholder address (the
record says so). To read where a link goes, hover over it (computer) or press and hold it (phone) and read the address, or read
it in the message source.

**Open the full headers.** Menu names change between versions; if one is missing, search the mail program's help for "view
message source" or "view headers".

- **Gmail** (web): open the message, press the three dots at the top right of the message (*More*), choose *Show original*.
  The top of the page lists *SPF*, *DKIM* and *DMARC* each as PASS, FAIL or NEUTRAL with the domain it checked; below is the raw
  text of every header.
- **Proton Mail** (web): open the message, press the three dots (*More*), choose *View headers*. The text of every header is
  shown, with no summary table, so read `Authentication-Results` yourself.
- **Outlook** (web, outlook.com or Microsoft 365): open the message, press the three dots at the top right (*More actions*),
  *View*, then *View message details* (the internet headers). In the Outlook desktop program: open the message in its own
  window, *File*, *Properties*, and read *Internet headers*.

**What to read, in each message's headers.** Copy the lines into the table below; do not paste them anywhere else.

| Header | What to read | Why |
| ------ | ------------ | --- |
| `From` | The display name and the address (the sender in the activation record is `noreply@mysenam.com`; `MAIL_FROM` may add a display name) | A customer sees this. A wrong or odd display name is a finding |
| `Authentication-Results` | `spf=`, `dkim=`, `dmarc=` each with its result, and the domain after `smtp.mailfrom=`, `header.d=` and `header.from=` | The receiver's own verdict |
| The DKIM signature | `DKIM-Signature: … d=<domain>; s=<selector>` | `d=` should be `mysenam.com` (the sending domain, so it **aligns** with the `From` domain). The selector should be one of those the SES console shows for the identity (part B) |
| `Return-Path` | The domain of the bounce address | With SES's default MAIL FROM this is an Amazon host; with a custom MAIL FROM it is a subdomain of `mysenam.com`. It decides whether SPF can align |
| `Message-ID` | The part before `@` | Message 1: compare with the id in the report |
| Links in the body | The host of each link | See point 4 below |
| Where it landed | Inbox, a tab of it, or Spam | Inbox (or a tab of it) is the goal; Spam is a finding even when every check passes |

**How to interpret what you read.**

1. **`dmarc=pass` is the result that matters.** DMARC passes when **either** SPF **or** DKIM passes **and aligns** with the
   `From` domain. The SPF record found for `mysenam.com` on 8 November names only Proton (`v=spf1 include:_spf.protonmail.ch
   ~all`), so mail sent by SES is expected to pass DMARC by DKIM alignment, not by SPF. That is what the headers must confirm.
2. **An `spf` that does not align is not a failed message.** With SES's default MAIL FROM, SPF is checked against the
   `Return-Path` domain, an Amazon one, so `spf=pass` may be shown for that Amazon domain (it passed, for that domain) and still
   not align with `mysenam.com`; or `spf=none` or `softfail` may be shown. Record what is shown, and **do not mark a message
   failed for this alone**. A custom MAIL FROM domain (item 4 above) is how SPF is made to align as well; it is an improvement,
   not a condition of this step. (The verification script's own wording asks for "SPF, DKIM and DMARC passing"; read it with
   this point.)
3. **What would be a failure:** `dmarc=fail`; or `dkim=pass` with `d=` an Amazon domain (a real signature that does not align,
   so with SPF also unaligned, DMARC fails); or no DKIM signature at all; or the message in Spam; or a link that goes through
   a click-tracking host. DMARC is published at `p=none` (`v=DMARC1; p=none; rua=mailto:dmarc@mysenam.com`), which asks
   receivers to deliver anyway; a fail is still a finding, because the policy is meant to be tightened later.
4. **Links in these particular messages** point at a placeholder address (the rehearsal used a throwaway install), so their host
   will not be the real `MYSENAM_URL` host. Check instead that the host is the same on every message and is not a third party's
   tracking host. The real-host check is step 15 above, with a real sign-up on a staging address.
5. **Content and language.** The text is the English wording of that message kind and says what the message needs to say (the
   cancellation notice says the venue *will* return the money at the counter, never that it has been returned). Anything
   unreadable, cut off or in the wrong language is a finding.

**Record it.** One row per message found; leave blank what was not seen. Nothing here has been filled in.

| # | Kind | Subject seen | Received (UTC and MYT) | Folder | From (name, address) | `dmarc=` | `dkim=` and `d=`, `s=` | `spf=` and its domain | `Return-Path` domain | Link host(s); rewritten? | Content and language ok? | Confirmed by, date |
| - | ---- | ------------ | ---------------------- | ------ | -------------------- | -------- | ---------------------- | --------------------- | -------------------- | ------------------------ | ------------------------ | ------------------ |
| 1 | Verification | | | | | | | | | | | |
| 2 | Sign-up link | | | | | | | | | | | |
| 3 | Reset link | | | | | | | | | | | |
| 4 | Cancellation notice | | | | | | | | | | | |
| 5 | | | | | | | | | | | | |
| 6 | | | | | | | | | | | | |

Messages 1 to 4 are the minimum. If any is missing, in Spam, or has `dmarc=fail`, **stop**: record nothing, and look at part B
(a sandbox account sends only to verified addresses; an identity whose DKIM is not successful signs with Amazon's domain).

**Only after every row you expected is confirmed:**

1. Set `MAIL_DELIVERY_VERIFIED` on the install to the value that `node scripts/verify-integrations.mjs email --send` prints (the
   line starting *record delivery as verified*). The value names the provider region and the sender address
   (`src/lib/email-config.ts`): use the one printed for the settings the install actually runs with, and **never reuse a value
   from another region or sender**. The 8 November report holds the value for the settings used then; if `SES_REGION` or
   `MAIL_FROM` has changed since, run the check again (it sends one more message to `VERIFY_EMAIL_TO`, and nothing else).
2. Restart the authorised staging or production service, so that it reads the setting.
3. Confirm: as a platform owner, `GET /api/admin/system` reports the email state `delivery_verified`, and the alert *Email
   delivery has not been verified* (`config:email`) has cleared in *System health*.
4. Write who confirmed, when, and from which mailbox in the launch record. Nothing in MySenam records it.

Until then real customer registrations stay off ([activation record](pilot-activation-2026-11-08.md#7-launch-gates-as-they-stand)).

### B. Close the read gaps: account and identity settings

The sending key can send and nothing else: `ses:GetAccount` and `ses:GetEmailIdentity` both answered 403 on 8 November. So
these are unknown: sandbox or production access, the daily quota and rate, whether the domain is verified, whether DKIM is
successful, any custom MAIL FROM domain, and whether a configuration set exists. There are two ways to read them. **Prefer the
console (no new credential).** Use the temporary read-only user only if the owner wants the script's report.

**Do not give the production sender key these permissions, and do not add them to the key the application runs with.** A
separate temporary user, used once and then deleted, keeps the application's key as narrow as it is. Never paste a key into a
chat or a ticket.

#### B1. Read the values in the SES console

Signed in to the AWS console as the account's owner (with multi-factor sign-in on), open **Amazon SES** and set the region at the
top right to **Asia Pacific (Singapore), `ap-southeast-1`**: identities, quota and sandbox status are per region. Menu names are
as the console showed them when this was written, and may have moved.

| Where | What to read | Value (fill in) |
| ----- | ------------ | --------------- |
| Account dashboard | Sandbox or production (a banner says the account is in the sandbox) | |
| Account dashboard | Sending status: enabled or paused | |
| Account dashboard | Daily sending quota; messages sent in the last 24 hours; maximum send rate (per second) | |
| Configuration, *Identities*, `mysenam.com` | Identity status: *Verified*? | |
| The identity, *Authentication* | DKIM: status *Successful*? Signing enabled? The three DKIM names it lists (compare the selector with the `s=` in a received message) | |
| The identity, *Authentication* | Custom MAIL FROM domain: none, or its name and status (*Successful*?) | |
| Configuration, *Configuration sets* | Any set at all? (the activation record says none is set on the install). For a set: its *Event destinations* (bounces, complaints) and any open or click tracking option, which **must be off** | |
| Configuration, *Suppression list* (account level) | Whether bounces and complaints are added to the account-level suppression list | |
| Reputation metrics (account dashboard) | Bounce rate and complaint rate so far, and AWS's own review levels as the page states them (write them here: ____) | |

If the account is in the **sandbox**, a customer who is not a verified address in SES cannot receive mail. Request production
access in the console (item 8 above) before real customers; the request is the owner's, and its wording about bounces and
complaints should match part C.

#### B2. A temporary read-only user, if the script's report is wanted

Create an **IAM user with programmatic access and no console sign-in**, attach this one inline policy, create one access key, use
it in a shell for one run, then delete the key and the user. `<ACCOUNT_ID>` is the AWS account number, for the owner to fill in
(it is not written in this document).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSesAccountSettings",
      "Effect": "Allow",
      "Action": "ses:GetAccount",
      "Resource": "*"
    },
    {
      "Sid": "ReadTheSendingIdentity",
      "Effect": "Allow",
      "Action": "ses:GetEmailIdentity",
      "Resource": "arn:aws:ses:ap-southeast-1:<ACCOUNT_ID>:identity/mysenam.com"
    }
  ]
}
```

- **Where it cannot be scoped.** `ses:GetAccount` has no resource to name, so its `Resource` is `*` (the 403 on 8 November said
  "on resource: *"). `ses:GetEmailIdentity` is scoped to the identity's ARN (the 403 named exactly that form for `mysenam.com`
  in `ap-southeast-1`). If the sending identity is an address rather than the domain, the ARN ends `identity/<address>`.
- **Optional extras**, as a second statement, if the owner also wants configuration-set detail. These are written from AWS's
  naming as the author recalls it and **were not tested**: confirm each action in the IAM policy editor or simulator before
  relying on it. `ses:ListEmailIdentities` and `ses:ListConfigurationSets` cannot be scoped (`*`);
  `ses:GetConfigurationSet` and `ses:GetConfigurationSetEventDestinations` take the set's ARN,
  `arn:aws:ses:ap-southeast-1:<ACCOUNT_ID>:configuration-set/<NAME>`. None of these can send.
- **Run it.** With the temporary key in `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY` in that shell only (never in the app's
  environment), and `SES_REGION` and `MAIL_FROM` as the install has them, run `node scripts/verify-integrations.mjs email`
  **without `--send`**. The script reads the account and the identity, checks DKIM, DMARC and SPF, and sends nothing (a read-only
  key could not send anyway). It writes `artifacts/integrations/email-<time>.json`; the script replaces the value of any set
  variable with `***` in what it prints.
- **Afterwards.** Delete the access key, then the user, and write the date in the launch record. The application's own key is
  untouched.

| Script step | Expected if the account is ready | Result (fill in) |
| ----------- | -------------------------------- | ---------------- |
| production access (not the sandbox) | production | |
| 24-hour sending quota | prints sent, maximum and rate | |
| `mysenam.com` verified for sending in SES | true | |
| DKIM for `mysenam.com` | status SUCCESS | |
| custom MAIL FROM, if any | status SUCCESS | |

### C. Watching bounces and complaints during the pilot

What the code does today: **nothing**. It does not read bounces or complaints back (item 10 above; the verification script says
so). A customer whose address bounces simply does not get the link, and MySenam does not know. So a person watches. **None of
this is set up.**

1. **Who and when (a proposal; the owner confirms).** The named operator ([daily operations](pilot-daily-operations.md)) opens
   the SES console's reputation metrics and sending statistics **every pilot day** for the first weeks, then weekly; the owner
   reads them weekly in any case. Names, and the day the frequency changes: ____.
2. **What to look at.** Bounce rate and complaint rate against the review levels AWS states on the page (copied into B1); a
   rising count on the suppression list; an account status of *under review* or *sending paused*.
3. **A notice that does not depend on MySenam (a suggestion, not configured).** A configuration set with an event destination for
   bounces and complaints, going to an SNS topic that emails the owner and the operator. That channel runs from AWS to a mailbox,
   so it still works when MySenam's own outbox is what broke. It needs the set's name in `SES_CONFIGURATION_SET` (so the app
   sends through it), `ses:SendEmail` granted on the set's ARN as well as the identity's (item 7 above), and the set's open and
   click tracking left **off**. The owner decides whether to create it; nothing is created by this document.
4. **What to do with a bounce or a complaint.** An address that bounced on a sign-up or reset: the customer asks again, or the
   venue rings them; do not resend by hand ([email delivery fails](pilot-daily-operations.md#email-delivery-fails)). A complaint:
   mail to that address should stop (the account-level suppression list does this at SES; MySenam does not know), and the owner
   is told. Reading these events into the outbox and flagging the address is a known limitation, not built.
5. **Record.** The operator writes the day's figures in the
   [daily handover record](pilot-daily-operations.md#daily-handover-record).
