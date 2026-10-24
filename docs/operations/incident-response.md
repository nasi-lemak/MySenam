# Incident response

What to do when something goes wrong with a running MySenam install: who
decides, how bad it is, what to do first, what to keep, how to recover and
how to know it is over. It is for a small team, often one person. It points
to the documents that hold the detail rather than repeating them:
[monitoring](monitoring.md) (how you are told), [backups](backups.md) (how to
restore), [deployment](deployment.md) (how to roll back) and
[privacy](../architecture/privacy.md) (what data is where).

**Not legal advice.** The notification rules below are summarised from the
regulators' own guidance as read on 24 October 2026, with what could not be
confirmed marked as such. Who is responsible for which data is not settled
([privacy](../architecture/privacy.md#where-personal-data-is-kept)). Have a
lawyer confirm both before launch, and again when an incident involves
personal data.

## Who does what

- **The incident lead** decides and keeps the record. By default it is
  whoever is on call; on a small team, the founder. One person leads at a
  time, and says so when handing over.
- **The platform owners** (the owner accounts on the dashboard) are told of
  every incident above *low*. They receive the alerts already.
- **Venues** are told when their customers, bookings or money are affected,
  by the incident lead, by email or phone, not by the app's automatic mail if
  the app is what broke.
- **A lawyer** is called for any suspected breach of personal data, and for
  anything that may need a regulator, the police or a payment provider told.

## How bad it is

| Level | Means | For example | Respond |
| ----- | ----- | ----------- | ------- |
| **Critical** | People's money or personal data are at risk, or nobody can book anywhere | Personal data exposed; a payment or API key leaked; double charging; the app or database down | At once, day or night; owners told within the hour |
| **High** | A core workflow is broken for some venues, or wrong data is being written | Bookings that disagree with the court time they hold; refunds failing; backups failing for a day; a failed deploy left running | Same working day |
| **Medium** | Something works badly or a safeguard is down, with a workaround | Messages delayed; one gateway or WhatsApp down; the off-site copy paused | Within two working days |
| **Low** | Cosmetic or one person affected, nothing at risk | A page error for one browser | In the normal course of work |

**Escalate** a level when any of these is true: personal data may have left
anybody's control; money moved that should not have; it affects more than one
venue; it is getting worse; the fix needs a restore; or nobody knows yet what
is wrong after an hour.

## Every incident, in order

1. **Write down the time** and what was seen, and open the incident record (a
   dated note: what happened, when, what was done, by whom). Keep adding to it.
2. **Contain** before fixing: stop it getting worse (see each kind below).
3. **Keep the evidence** before changing anything that would destroy it
   (below).
4. **Recover**, from the documents linked under each kind.
5. **Check it is over** before saying so (below).
6. **Tell** whoever was affected, and anyone the law requires.
7. **Follow up** within a week: what happened, why, what changes, and a
   [known limitations](../roadmap/known-limitations.md) row for any defect
   found, with the test to write first.

### Keeping the evidence

Before restoring, redeploying or deleting anything, keep copies of:

- the server and proxy logs for the period (they are rotated);
- the owner dashboard's *System health* alerts and *🐞 Errors* with their
  stack traces ([monitoring](monitoring.md#errors));
- the staff activity log for the venues involved (*Reports → Staff activity*,
  [reporting](../features/reporting.md));
- a backup taken now (`npm run backup`), even of a database you believe is
  wrong: it is the state you will want to compare;
- for money: the gateway's own records (Billplz or Stripe dashboard) for the
  payments and refunds involved;
- the deployed version (image digest or commit).

Keep the record and copies somewhere other than the server involved, and
treat them as personal data: they contain names, numbers and emails.

### Checking it is over

- `/api/health` answers 200 and the scheduler is ticking
  ([monitoring](monitoring.md#errors)).
- `GET /api/admin/integrity` (as a platform owner) reports nothing: bookings
  agree with the court time they hold, and no refund is stuck
  ([monitoring](monitoring.md#being-told-when-something-breaks)).
- A test booking on a demo venue goes through and is cancelled; a message
  arrives.
- The alert that started it has been marked *Dealt with* and has not come
  back.
- For a restore: the restore drill's checks ([backups](backups.md#a-restore-drill)).

## Kinds of incident

### The app is down

- **Detected by** the uptime monitor on `/api/health`, venues or customers.
- **Contain:** nothing to contain; if a deploy just happened, see *A failed
  deploy*.
- **Recover:** restart the app; check the disk (backups and photos fill
  it), memory and the database connection. The DigitalOcean kit's service
  restarts the app on failure ([deployment](deployment.md)).
- **Tell** venues if it lasts more than about 15 minutes in opening hours:
  bookings at the counter can still be written down and entered afterwards.

### The database fails or data is lost

- **Detected by** errors on every request, `/api/health`, or the integrity
  check.
- **Contain:** stop the app so nothing writes to a database in an unknown
  state.
- **Keep** a copy of whatever is left before restoring over it.
- **Recover:** restore the latest good backup, from the off-site copy if the
  server's own is gone ([backups](backups.md#restoring), [off-site](backups.md#restoring-from-the-off-site-copy)).
  Everything after the backup's time is lost: bookings, payments and
  messages made since then must be rebuilt from the gateways' records and
  venues' own notes. The recovery point and time the backups aim for are in
  [backups](backups.md#recovery-point-and-recovery-time).
- **Check:** the integrity check, and each venue's bookings for today and
  tomorrow, before opening the doors again.
- **Tell** every venue the time the data was restored to, and that payments
  taken since may need entering again.

### Bookings that disagree, or a double booking

- **Detected by** the daily integrity check (problems such as
  `booking_unheld`, `booking_mistimed` and `claim_orphaned`), a venue, or two
  customers at one court.
- **Contain:** if bookings are being written wrongly, suspend the affected
  venue's bookings (suspend the venue, [marketplace](../product/marketplace.md#running-the-marketplace))
  until it is understood.
- **Keep** the bookings and claims involved, and the activity log.
- **Recover:** the integrity check names each booking and what is wrong;
  put each right (move or cancel it with the venue), then run it again.
  The database refuses two bookings of the same court time
  ([booking concurrency](../architecture/booking-concurrency.md)), so a real
  double booking means something went round the code (a hand edit, half a
  restore): find out what.
- **Tell** the customers affected, through the venue.

### Duplicate payments, or refunds that fail

- **Detected by** the integrity check (`refund_unanswered`, `refund_failed`,
  `refund_overdue`), a venue, or a customer charged twice.
- **Contain:** nothing in MySenam moves money between parties; check the
  venue's gateway dashboard for what was actually charged.
- **Keep** the gateway's records and MySenam's `online_payments` rows for
  the booking.
- **Recover:** refunds owed are listed for the venue; a refund the gateway
  never answered is checked in the gateway's dashboard and marked
  ([payments](../features/payments-and-credit.md#refunds-that-are-interrupted)).
  A payment reported twice is credited once by design; a customer actually
  charged twice is refunded by the venue from its gateway.
- **Tell** the customer, through the venue, with what was refunded and when.

### A leaked or compromised key or password

API keys, gateway keys, the email or SMS login, the backup upload key, an
owner's password, `MYSENAM_SECRET`.

- **Detected by** a key found in a log, a commit, a screenshot or a chat;
  a provider's warning; payments or messages nobody made.
- **Contain:** revoke or rotate it at the provider **first**, then put the
  new one in the environment and restart. A venue's gateway keys are the
  venue's to rotate in its gateway; they then re-enter them under *Payments*
  ([payment gateways](../integrations/payment-gateways.md)). Backup keys:
  [rotating keys](backups.md#rotating-keys). A staff or owner password: set a
  new one, which signs the account out everywhere
  ([authentication](../architecture/authentication.md#forgotten-passwords)).
  `MYSENAM_SECRET` encrypts stored payment keys: replacing it means every
  venue enters its gateway keys again.
- **Keep** where it was found and the provider's logs of its use.
- **Check** the provider's logs for use you did not make, and treat any as a
  possible breach (below).
- Never paste a key into a chat, a ticket or the incident record; record
  which key, not the key.

### Somebody else in an account

- **Detected by** a staff member, a venue, or the activity log showing
  changes nobody made.
- **Contain:** set a new password for the account (every session ends);
  for staff, a manager or owner can remove the account; turn on two-factor
  sign-in ([authentication](../architecture/authentication.md#two-factor-sign-in)).
  Suspend the venue if staff accounts there cannot be trusted.
- **Keep** the activity log, the sessions and the server logs (addresses,
  times).
- **Check** what was done in the account (refunds, payment settings, exports
  of customers' data) and undo it. An export of customers' data is a
  possible breach.

### A suspected breach of personal data

Any personal data seen, taken, changed, lost or destroyed by somebody who
should not have: an account broken into, an export sent to the wrong person,
a backup or log in the open, a lost laptop with a copy.

- **Contain** at once: close the hole (revoke the key, end the sessions,
  take the file down), without destroying evidence.
- **Assess** what data, whose, how many people, whether it was encrypted,
  and how likely harm is. Write it down as you go: both regulators expect the
  assessment documented. MySenam holds names, phone numbers, emails, booking
  and payment history (no card numbers: those stay with the gateway),
  playing profiles, and for some tournament entrants declared dates of birth
  and guardians' names.
- **Decide who must notify.** Venues are the controllers (organisations)
  for their bookings and MySenam processes them; the operator is responsible
  in its own right for customers' accounts
  ([privacy](../architecture/privacy.md#where-personal-data-is-kept)). Where
  MySenam is the venue's processor, tell each affected venue without delay,
  with what is known, so the venue can meet its own duties. Where the
  operator is responsible, the operator notifies. **This split needs a
  lawyer's confirmation.**
- **Call the lawyer** before notifying, unless that would miss a deadline.

**Malaysia** (Personal Data Protection Act 2010, s.12B, inserted by the
Personal Data Protection (Amendment) Act 2024, in force from 1 June 2025):

| | What the sources say | Confirmed from |
| - | -------------------- | -------------- |
| Who | The data controller notifies; the Act puts no notification duty on processors. The Commissioner's guideline expects controllers to require processors to tell them promptly | Act (law-firm copy of the gazetted text); guideline via law-firm summaries only |
| The Commissioner | "As soon as practicable", where there is reason to believe a breach occurred. The official notification portal says notification is mandatory only where the breach causes significant harm: physical injury, financial loss, harm to credit records or property; misuse for unlawful purposes; sensitive personal data; data that could enable identity fraud; or more than 1,000 people affected | Act; [PDP notification portal](https://daftar.pdp.gov.my/v1/dbn) |
| Deadline | **72 hours**, per the Commissioner's guideline. Whether it runs from the breach or from becoming aware of it is **not confirmed**: assume the earlier | Law-firm summaries of the guideline (the regulator's site was unreachable on 24 October 2026) |
| Further information | As it becomes known, within 30 days of the first notification | [PDP notification portal](https://daftar.pdp.gov.my/v1/dbn) |
| Affected people | Where significant harm is caused or likely, "without unnecessary delay"; the guideline sets 7 days after notifying the Commissioner | Act; guideline via law-firm summaries |
| Records | Keep a register of breaches; reported as at least 2 years | Law-firm summary only |
| How | The online form at the [PDP notification portal](https://daftar.pdp.gov.my/v1/dbn); email and post are reported alternatives | Portal; alternatives not confirmed |
| Penalty | Failing to notify the Commissioner: a fine up to RM250,000, up to 2 years' imprisonment, or both | Act |

Flagged for the lawyer: the Act's test ("reason to believe") is wider than
the portal's significant-harm filter; whether the 72 hours run from the
breach or from awareness; and whether MySenam must appoint a data protection
officer (the portal's thresholds: personal data of more than 20,000 people,
more than 10,000 for financial, biometric or health data, or regular and
systematic monitoring).

**Singapore** (Personal Data Protection Act 2012, Part 6A, and the Personal
Data Protection (Notification of Data Breaches) Regulations 2021, in force
from 1 February 2021), from the PDPC's
[Advisory Guidelines on Key Concepts, chapter 20](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/ag-on-key-concepts/advisory-guidelines-on-key-concepts-in-the-pdpa-17-may-2022.pdf)
(revised 29 April 2026) and its
[Guide on Managing and Notifying Data Breaches](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-on-Managing-and-Notifying-Data-Breaches-under-the-PDPA-15-Mar-2021.pdf):

| | What the guidance says |
| - | ---------------------- |
| Who | The organisation assesses and notifies. A data intermediary (processing for it) tells the organisation without undue delay once it has credible grounds to believe a breach occurred, and does not notify the PDPC itself |
| Assess | Reasonably and quickly: generally within 30 calendar days of credible grounds to believe a breach occurred, documenting each step |
| Notifiable | Likely to cause significant harm to the people affected (some kinds of data are deemed to, including an account identifier with its password or other access credential), or of significant scale: 500 people or more |
| The PDPC | As soon as practicable, and no later than **3 calendar days** after deciding the breach is notifiable (the day after that decision is day 1) |
| Affected people | Where significant harm is likely (not for scale alone): as soon as practicable, at the same time as or after notifying the PDPC; exceptions where remedial action or encryption makes harm unlikely, or where the PDPC or the police say not to |
| How | The [PDPC's online form](https://eservice.pdpc.gov.sg/case/db); for an urgent major case, also by phone, +65 6377 3131, in working hours |
| Penalty | Up to S$1 million, or 10% of Singapore turnover where that is over S$10 million |

The Singapore statute itself was not read (its official site was unreachable
on 24 October 2026); the figures above are the PDPC's own.

**The rules differ**: Malaysia's clock is counted in hours and may start
from the breach itself; Singapore's from the decision that it is notifiable,
in calendar days, after an assessment that may take up to 30 days. Malaysia
counts more than 1,000 people as significant scale; Singapore, 500 or more.
Do not assume one country's rule for the other: an install serves one country
(`MYSENAM_COUNTRY`), but a customer may live elsewhere.

- **Tell the people affected** what happened, what data, what MySenam and
  the venue are doing, and what they can do (change a password, watch for
  calls claiming to be the venue). Plain words, in their language where the
  app has it.
- **Follow up** with the regulator as more is known, and keep the record.

### Backups fail, or an off-site restore goes wrong

- **Detected by** the `backup`, `offsite`, `backup-stale` and
  `offsite-near-limit` alerts ([backups](backups.md#backup-health)).
- **Contain:** take a backup by hand now (`npm run backup`) and keep it off
  the server.
- **Recover:** fix the cause (disk, credentials, bucket); the next scheduled
  run copies what is missing. For a Backblaze B2 restore that fails (a
  missing key, a signature that does not verify, a set that will not
  decrypt), follow [restoring from the off-site copy](backups.md#restoring-from-the-off-site-copy);
  never restore a set whose signature does not verify
  ([signed manifests](backups.md#signed-manifests)). Lost decryption keys
  cannot be recovered: that is why they are kept off the server
  ([recovery keys](backups.md#recovery-keys)).
- **Check** with a restore drill into a scratch database.
- High if no good backup is less than a day old; critical if none can be
  restored at all.

### A provider is down: gateway, email, WhatsApp, SMS, Google

- **Detected by** the provider's status page, messages failing
  ([monitoring](monitoring.md#being-told-when-something-breaks)), payment pages
  not opening.
- **Contain:** nothing to switch automatically. Messages wait in the outbox
  and are retried; bookings held until paid are let go if unpaid as usual,
  so tell venues to take payment at the counter meanwhile.
- **Recover:** when the provider is back, the outbox sends what waited;
  check the alert for failing messages has stopped coming back.
- **Tell** venues if payments online are down in their opening hours.

### A failed deploy

- **Detected by** the deploy script's own check, `/api/health`, or errors
  after a release.
- **Contain:** the DigitalOcean kit puts the previous version back if the new
  one does not answer. Otherwise deploy the previous version.
- **Recover:** if a migration has run, the old code alone is not enough:
  restore the backup taken before the deploy and deploy the previous version
  ([upgrading](deployment.md#upgrading)).
- **Check** as above, and run the staging checks before trying again
  ([staging](deployment.md#staging-before-a-release)).

## After an incident

Within a week, write a short review in the incident record: the timeline,
the cause, what worked, what did not, and what changes. Add any defect to
[known limitations](../roadmap/known-limitations.md) with the test to write,
any new safeguard to the roadmap, and any change to how to respond here.
Keep the record (and, for Malaysia, the breach register) as the lawyer
advises.
