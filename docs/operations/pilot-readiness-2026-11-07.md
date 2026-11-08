# Pilot readiness assessment, 7 November 2026

A factual assessment of whether MySenam can start a **restricted pilot**: one to three
staffed venues in Malaysia, controlled functionality, a person supervising daily. It is
written after the [hardening round](../audits/hardening-2026-11-07.md) and is as true as its
[release verification](../development/testing.md#release-records). **It is not a statement
that MySenam is production-ready**: automated tests are necessary and not sufficient, and
several things below cannot be checked by a program.

**Verdict: not yet.** The software is a release candidate for a restricted pilot. The pilot
may begin only when the *blocked* rows below pass their live checks and the manual
safeguards are in place. Until then nothing is offered to a real customer.

## Classes used

| Class | Meaning |
| ----- | ------- |
| Ready for restricted pilot | Built and tested; no live service or decision stands in the way |
| Ready only with manual safeguards | Built and tested; a named person or a procedure must cover a known gap |
| Disabled for pilot | Exists; stays switched off for the pilot |
| Blocked pending verification | Built; cannot be offered until a real-service check, a lawyer or an adviser has answered |
| Not implemented | Does not exist |

## Capability matrix

| Capability | Class | Why, and what the pilot must do |
| ---------- | ----- | ------------------------------- |
| Booking and availability | Ready for restricted pilot | Claims under exclusion constraints; races tested on Postgres; cancellation terms snapshotted; edits and bookings meet in one transaction. Staffed hours only |
| Counter payments (cash, DuitNow QR, transfer) | Ready for restricted pilot | Recorded with the method; the cash-up and one payout list cover refunds handed back; a credit note is not money paid and the screen says so |
| Billplz checkout | **Blocked pending verification** | Settlement checks are built against stand-in payloads only. Billplz sandbox keys and the check (`node scripts/verify-integrations.mjs billplz`) must show that `paid_amount` is on the callback and what a short payment looks like. Until then a paid callback without `paid_amount` is held, and online payment must not be offered |
| Refund reconciliation | Ready only with manual safeguards | A customer's cancellation of a counter-paid booking is now a task on the owed-back list (ADR 0074), settled once by a named staff member; past cancellations are listed by `scripts/reconcile-counter-cancellations.sql` for manual review before the pilot. Billplz refunds are by hand: the *Refunds owed*, *Payments to check* and counter-owed lists exist, and a named person (section below) must clear them daily. A payment after a hold lapsed is owed back, never revived |
| Classes | Ready for restricted pilot | Pay-to-hold, waiting-list offers and moves tested; counter payment unaffected. Online class payment waits on the Billplz row |
| Memberships and passes | Ready only with manual safeguards | Sold at the counter; terms kept for the paid term; no pre-renewal notice; validity is not paused during a suspension (DEC-02); **gateway auto-renewal (Stripe) stays disabled**: its pause is unverified against real Stripe |
| Venue cancellation and closures | Ready only with manual safeguards | The closure is written first, refunds owed are tracked; Billplz refunds by hand; waiting entries on a closed day stay silent |
| Staff authentication | Ready for restricted pilot | Two-factor is required for the owner, venue owners and managers on a production marketplace; each must enrol before first privileged use; recovery codes and the documented reset exist. The pilot operator must enrol first |
| Customer registration and password reset | See the assessment below | Reviewed end to end this round |
| Email delivery | **Blocked pending verification** | Never sent through a real provider. Verify the sending domain in SES (DKIM, SPF, DMARC), production access, then the email check. Booking confirmations, resets, refund notices and the new no-show and expiry notices all depend on it |
| Backups and restore | **Blocked pending verification** | Backup, signing and restore code is tested against stand-ins. A real Backblaze B2 bucket, a written transfer approval (privacy document), the off-site verify and a restore drill on an isolated machine must pass **before** any real customer data is held |
| Scheduler and operational monitoring | Ready only with manual safeguards | Alerts, the heartbeat, a separate lease for long jobs and a visible dead-letter list exist. An uptime monitor outside the server and an owner who reads the alerts are not code: both must be set up |
| Privacy and legal documents | **Blocked pending verification** | Terms, privacy notice, the backup-abroad transfer and the retention periods are drafts for a Malaysian lawyer to review. No legal question is treated as settled in code |
| Tax compliance | Ready only with manual safeguards | Tax treatments are provisional starting points the venue's adviser reviews. **E-invoicing (MyInvois) is disabled for the pilot**, and in any case not at a venue that sells credit or vouchers until the adviser answers the [memo](einvoice-stored-credit-memo.md) |
| Youth functionality | Disabled for pilot | Interim safeguards exist; the legal review in [the checklist](legal-review-youth-messaging.md) has not happened; nothing is enabled in production meanwhile |
| Unstaffed access | Disabled for pilot (not implemented per person) | One door code per resource, not revocable per booking; no smart-lock integration. Staffed hours only |

## Integrations

Mock tests passing is not a live check. For each provider: what exists, whether a sandbox
or test credential is available, what has actually been exercised, and whether it may be
enabled in the pilot. Provisioning credentials and approvals is the owner's.

| Integration | Mock tests | Sandbox credentials | Exercised live | Error handling checked live | Missing approvals or configuration | May it be enabled in the pilot |
| ----------- | ---------- | ------------------- | -------------- | --------------------------- | ---------------------------------- | ------------------------------ |
| Billplz | Pass (settlement, signature, duplicates, late, short, over) | Not available | Nothing | No | Sandbox account and test keys; collection id; callback URL on a public address | **No, until the sandbox check passes** |
| Amazon SES | Pass (outbox, retry, exhaustion) | Not available | Nothing | No | Verified domain (DKIM, SPF, DMARC), production access, `SES_*` and `MAIL_FROM` | **Required** before any customer message; pending |
| Backblaze B2 | Pass (upload, signed manifests, restore drill on stand-ins) | Not available | Nothing | No | Bucket, separate write and read keys, lifecycle, `OFFSITE_*` approvals | **Required** before real data; pending |
| Stripe | Pass | Not available | Nothing | No | Test keys; the `pause_collection` and refund checks | No: not needed for a staffed pilot; auto-renewal disabled |
| WhatsApp Cloud API | Pass | Not available | Nothing | No | Meta business verification; the changed waitlist offer template must be **resubmitted** | No: email only for the pilot |
| MyInvois (LHDN) | Pass (stand-in) | Not available | Nothing | No | The venue's sandbox credentials; the adviser's answer on stored value | No: disabled |
| Xero | Pass (stand-in) | Not available | Nothing | No | Developer app and a demo company | No: optional, off |

Prioritised for a Malaysian staffed-venue pilot: **Billplz, SES and B2**, in that order of
risk; everything else stays off. A sandbox result does not prove all production behaviour.

## Restricted-pilot operating conditions

1. **Scope**: one to three staffed venues; counter payments from day one; online payment
   only after the Billplz check passes.
2. **A named person** at the platform operator clears *Refunds owed*, *Payments to check*
   and *Needs attention* every day, settles manual Billplz refunds, and is the contact for a
   venue's closure. Without that person the pilot does not start.
3. **Two-factor** enrolled for the owner, each venue owner and manager before use.
4. **Stored-value exposure** (credit, passes, memberships, vouchers) kept small until the
   exit workflow exists ([hardening record](../audits/hardening-2026-11-07.md#5-restricted-pilot-operating-policy-for-a-venue-that-cannot-yet-leave-a5--h8)).
5. **Disabled**: youth messaging, unstaffed access, Stripe auto-renewal, e-invoicing,
   WhatsApp, Xero, voucher expiry and desk redemption changes.
6. **Backups**: the first restore drill passes on an isolated machine before real data.
7. **Legal and tax review**: the questions for a Malaysian lawyer and the venue's tax adviser, every one NOT REVIEWED, are in the [legal and tax review packet](legal-review-packet-2026-11-08.md).
8. **Daily operation**: the named person's checklist, incident procedures and escalation table are in [pilot daily operations](pilot-daily-operations.md); the monitoring that must sit outside the app is in [monitoring](monitoring.md#external-monitoring-for-the-pilot).

## Pilot acceptance criteria, as they stand

| Criterion | Status |
| --------- | ------ |
| Hardening changes pass release verification | Recorded in [testing](../development/testing.md#release-records) when the frozen source has passed |
| Privileged staff two-factor enforced | Built and tested |
| Venue isolation and access revocation reliable | Built and tested (credentials follow their owners) |
| No known unresolved P0 or enabled-feature P1 | No P0 known. P1s: C19 (Billplz online payments: **do not enable**) and C2 (e-invoicing at a stored-value venue: **do not enable**) |
| Payment integrity verified for each method enabled | Counter: tested. Billplz: **pending** |
| Billplz sandbox validation before online payments | **Pending** |
| A designated person settles manual refunds | **To be named** |
| SES delivery verified for essential notifications | **Pending** |
| B2 backup and restore exercised | **Pending** |
| Scheduler failures visible and actionable | Built; an external monitor is to be set up |
| Existing booking terms preserved and explainable | Built and tested |
| Customer registration and password reset reviewed | See below |
| Legal documents and obligations addressed | **Pending a lawyer** |
| Youth, unmanned access, gateway auto-renewal disabled | Yes, by this policy |
| Venue stored-value exposure restricted | By operating condition 4 |

## Customer registration and password reset

Reviewed end to end this round (sign-up, sign-in, sessions, forgotten password, reset,
change, Google linking, phone codes, erasure, staff sharing the same code), with tests in
`tests/auth-review.test.ts`. The logic is sound: sign-up links and reset tokens are 24
random bytes, stored keyed-hashed, single-use and short-lived; six parallel uses of one
reset link give exactly one success on both engines; every answer about an address is the
same whether or not it exists; a reset ends every session; Google joins only a verified
email; the reset token cannot be burned by a mail scanner's pre-fetch; the token never
reaches a referrer or an access log.

Four defects were found and fixed: a reset link for an erased or removed account caused a
500 (now refused); nothing capped reset links asked for from one address (30 an hour per
client address now, staff and customer); changing a password left earlier reset links
alive (now voided); and phone-code tries were counted after the check, so parallel guesses
passed the cap (now counted in the checking statement).

**Both are *ready only with manual safeguards*.** Three safeguards named on 7 November are
now built; one remains:

1. *Built (final operational hardening, ADR 0073):* a sign-up or reset link is **security mail**,
   its own class with its own allowance (10 a day per address by default,
   `MYSENAM_AUTH_MAIL_PER_RECIPIENT_PER_DAY`), a 60-second cooldown and no second link while one
   is waiting; eight ordinary messages to an address no longer make its link vanish. Past its own
   allowance a message is not sent, is shown to the operator with the reason, and raises an alert.
2. *Built:* a production marketplace whose email cannot deliver (no provider, no sender, both SES
   and SMTP set, `MYSENAM_SEND=log`) refuses sign-up and forgotten-password requests with a plain
   "temporarily unavailable" and alerts the owner; nothing says "check your email" when no email
   can go. The health view shows the email state, the last hour's sent and failed counts, the
   queue's age and what was given up.
3. *Built:* the per-address sign-up and reset limits are settings; many people behind one venue
   network still count together (the sign-in budget is fixed).
4. **Remains:** real email delivery and domain authentication verified
   ([SES checklist](email-ses-checklist.md), [provider verification](pilot-provider-verification.md)).
   The application cannot know that mail reaches an inbox; `MAIL_DELIVERY_VERIFIED` is set only by
   an operator after a person confirmed one. Until then both journeys stay *ready only with manual
   safeguards*, and a person locked out by the security-mail allowance has only "ask again later"
   or Google sign-in (there is no tool to send a link by hand).

Not checkable without real email: delivery and inbox placement; that SES click tracking is
off (it would rewrite the link); behaviour in an SES outage against real error codes;
bounces and complaints; the Malay, Chinese and Tamil wording in real clients; WhatsApp and
SMS delivery of phone codes; Google sign-in against live Google.
