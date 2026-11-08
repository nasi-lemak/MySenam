# Pilot daily operations: the checklist and the incident procedures

For the **named operator** of the restricted pilot: one to three staffed venues in Malaysia, counter payments first,
email as the only customer message channel ([pilot readiness](pilot-readiness-2026-11-07.md)). Pilot readiness makes this
person a condition: **without them the pilot does not start.** This document is what they do each day and week and what
they do when something goes wrong. It uses only screens and lists that exist today, by the names the screens carry, and it
points to the documents that hold the detail rather than repeating them
([incident response](incident-response.md), [monitoring](monitoring.md), [backups](backups.md),
[payments and credit](../features/payments-and-credit.md)).

**Status: written from the repository's documents and screen text; NOT rehearsed with a real operator, NOT checked on a
live install.** Names in blanks (`____`) are the owner's to fill; no response time, threshold or amount is invented here.
The first real run should correct this document.

## Before the pilot starts: what the operator needs

1. **A platform owner account** (or a manager's for one venue), with two-factor sign-in enrolled and **recovery codes
   stored somewhere safe** ([two-factor sign-in](../architecture/authentication.md#two-factor-sign-in)). Several screens
   below are owner-only; where a screen is for the owner, this document says so. A venue manager sees their venue only; the
   front desk sees less (it hands back only counter payments taken today).
2. **Access to each venue's Billplz dashboard**, if online payment is ever switched on, because every Billplz refund is made
   there by hand. The Billplz account belongs to the venue, so how the operator gets access is not decided (see the
   questions at the end).
3. **The escalation table** at the end filled in, and one **incident lead** named
   ([who does what](incident-response.md#who-does-what)).
4. **An uptime monitor and an alert channel set up** ([external monitoring for the pilot](monitoring.md#external-monitoring-for-the-pilot)):
   as the baseline stands none is configured, so the app cannot tell the operator it is down.

## The screens, by their names

| Screen | Where | Who |
| ------ | ----- | --- |
| **Needs attention** | *Bookings* tab | Venue staff; the owner sees every venue |
| **Owed back at the counter** (and **Handed back at the counter on {date}**) | *Bookings* tab, above the day list | Venue staff |
| **Refunds owed**, **Refunds on their way**, **Payments to check**, **Disputed payments**, **Refund workload** | *Venues & staff*, under **Online payment** | Venue staff (the front desk's view is smaller) |
| **Messages to customers** (*Sent*, *Waiting*, *Retrying*, *Given up*, *Try again*; **Platform emails** for the owner) | *Venues & staff* | Venue staff; platform emails the owner |
| **Backups** (state, each snapshot *Whole* or not, the last off-site copy, *Back up now*) | *Venues & staff* | Owner only |
| **System health** (the **Scheduler** line: healthy, stale, no heartbeat yet, starting or off, with the time since; outstanding alerts, *Dealt with*) | Top of the admin dashboard | Owner only; the Scheduler line is always there, the red box only while something is wrong |
| **Errors** | Top of the admin dashboard | Owner only |
| **Booking integrity check** | Admin dashboard | Managers (their venues) and the owner (all); not the front desk |
| **Cash-up** (counts, variance, *Print the cash-up*) | *Credit & passes* tab | Front desk its own shift; manager anybody's |
| Period report, including **Held for customers, in ringgit**, unspent pass hours and lapsing memberships; **Staff activity** | *Reports* tab | Managers and the owner |
| **Reviews** | *Venues & staff* | Venue staff |

One thing the operator will look for and **will not find as a screen**: the email health numbers are in the owner's system
answer (`GET /api/admin/system`, raw data, not a page). The scheduler is a line under **System health**: **Scheduler: healthy**
with the time since it last ran; **STALE** (more than 5 minutes); **NO HEARTBEAT YET** (never reported in); **starting** (the app
restarted under 2 minutes ago; the only grace); or **switched off on this server**. **Only healthy is good.** The line is seen only
while somebody has the dashboard open: an offline app cannot report itself, so it is not proof that the app is healthy
([monitoring](monitoring.md#external-monitoring-for-the-pilot)).

## Every day

Do this at the start of the day and again at the end (the one-page sheet below). Do it for **each pilot venue**.

1. **New bookings and failed reservations.** *Bookings* tab: today's and tomorrow's day list. Look for bookings still
   unpaid (filter the day list to unpaid) and held bookings. There is **no separate list called "failed reservations"**:
   a payment that arrived after a hold lapsed, was short, or could not be matched is on **Payments to check** (next item);
   an unpaid hold that lapses is let go on its own.
2. **Payments requiring review.** *Venues & staff → Online payment → Payments to check*, and the red line **Payments to
   check** in **Needs attention**. Each is money that came in and was not applied as the customer paid for it. Open each,
   check it against the venue's gateway dashboard, and press **Mark checked** with a note. Anything with "owed back" is
   also under **Refunds owed**. The owner is also emailed once per such payment (subject *A payment at {venue} needs
   checking*: the venue and the payment's bill id, no customer detail; after five standing at one venue, one line a day), and
   it is cleared when you press **Mark checked**. The list is the record. With online payment off (the plan until Billplz's sandbox check passes) this list should
   be empty; if it is not, that is an incident ([A customer pays but gets no booking](#a-customer-pays-but-gets-no-booking)).
3. **Refunds owed.** *Online payment → Refunds owed*: each shows how many days it has been owed and the date promised to the
   customer; **Overdue** is in red, and **Needs attention** repeats it as **Refunds overdue**. Refund each in the
   gateway's dashboard (Billplz has no refund API), then mark it done with the reference. Also look at **Refunds on their
   way** (a refund that failed at the gateway is owed again). A refund marked done is not made again, so do not mark it
   before the money has gone ([refunds made by hand](../features/payments-and-credit.md#refunds-made-by-hand)).
4. **Counter refunds not yet confirmed.** *Bookings → Owed back at the counter*: every counter payment still owed back,
   whatever day it was for. It lists the customer, booking code, amount, how it was paid, why, whether the customer was
   told, and the credit note's number. **A credit note is not the refund**: nothing is paid until a named staff member
   presses **Handed back** (or **Give as credit**). The front desk can settle a payment taken today; an older one is a
   manager's. **Needs attention** shows a red line **Owed back at the counter** (amber if none is old yet): per venue how many
   wait, the sum, the oldest in days and how many are past 2 days; the venue's managers are emailed one message a day, after
   09:00 venue time, while anything is owed. **Neither settles anything**: a row leaves the list only when a named staff
   member presses **Handed back** or **Give as credit**. The owner who is not also a manager sees the line but is not emailed.
   Where the customer has no email, ring them: the panel says so.
5. **Failed customer notifications.** **Needs attention**: each customer the venue cancelled or moved who has not yet seen it,
   with the way they were reached. Red lines (*No email or WhatsApp: call them*, *Message failed: call them*) need a call;
   mark them **I have told them** once you have. Then *Venues & staff → Messages to customers*: the counts of *Retrying* and
   *Given up*; **Try again** on a message that can still be sent. A given-up message is not repeated by itself.
6. **Closures needing follow-up.** **Needs attention → Closed this week** for each closure and who has not seen the news. A
   closed day, an outage, a rain-out or a class called off also leaves counter payments on **Owed back at the counter**
   and online payments on **Refunds owed**. A booking whose kit is still out is **not** cancelled: it is named in the answer
   and in **Staff activity**, for the desk to settle once the kit is back.
7. **Safety and attention worklists.** Everything else in **Needs attention** is a worklist; open and clear each block
   that appears. The ones that exist: **bookings that need your decision** (a refused number, or a sign-off, certification
   or induction taken back: nothing is cancelled for you, and the desk gets no door code or QR check-in for a refused number);
   **People: marks, endings and strikes** (answers to no-show marks, passes and memberships ending within 14 days, numbers
   with a strike, coaches with no email); **private hire enquiries nobody has answered**; class move requests waiting for a
   manager; sessions with too few qualified people rostered; **overdue company accounts**; **competitions and messages that
   need you**. A block with nothing in it does not appear.
8. **Scheduler heartbeat.** **System health → Scheduler** (owner): anything but **healthy** (STALE, NO HEARTBEAT YET, or
   *starting* for more than a couple of minutes) means there may be **no backups, no messages and no released holds**: treat
   it as [the app is unavailable](#the-application-is-unavailable) and call the technical contact. The line also names the last
   scheduler failure still outstanding. If the external uptime monitor is configured, it reports this as well
   (`/api/health` answers an error when the scheduler has not ticked for ten minutes).
9. **Backup status.** *Venues & staff → Backups* (owner): the state at the top
   ([backup health](backups.md#backup-health)): **Backups: active** is the good state. Anything else, or a red line (the
   newest snapshot over two days old, a failed or paused off-site copy), is [a backup fails](#a-backup-fails).
10. **Unresolved operator alerts.** **System health** lists each outstanding alert with its count and latest detail; the
    same alert went by email to every platform owner, once, and again after six hours if it persists. Deal with each (the
    incident procedures below, or [incident response](incident-response.md)), and press **Dealt with** only after it is dealt
    with. An alert that comes back is told again. Also glance at **Errors** (a new kind of error is an alert of its own).

## Every week

1. **Cash-up variances.** *Credit & passes → Cash-up*: for each day of the week, the counted amount beside the expected
   amount and the **variance** (short or over) with who counted. A day with no count is a gap. Recounts are separate
   records; nothing is edited. Variance limits are not defined in the repository: **limit before escalating: ____**.
2. **Stored-value liabilities.** *Reports → Held for customers, in ringgit*: credit, gift vouchers not yet used, deposits
   and shares held, hire deposits held, refunds owed. It is **provisional** and for the venue's adviser. Compare with the pilot
   rule that stored-value exposure stays small ([operating conditions](pilot-readiness-2026-11-07.md#restricted-pilot-operating-conditions)).
   **Agreed ceiling for each pilot venue: RM ____.**
3. **Pass and membership obligations.** *Reports*: unspent pass hours and the count of lapsing memberships; **Needs attention
   → People** for those ending within 14 days. A venue's suspension does not pause validity, so a customer may ask.
4. **Duplicate and disputed payments.** *Online payment → Disputed payments* (a chargeback: answer in the gateway's own
   dashboard before the date shown); **Payments to check**; and the **Booking integrity check**'s list of money refunded in
   the gateway's own dashboard that MySenam did not owe (kept 30 days): nothing changes by itself, so ask the venue what it
   was for ([refunds made in the gateway's dashboard](../features/payments-and-credit.md#refunds-made-in-the-gateways-dashboard)).
   A payment reported twice is credited once by design; a customer actually charged twice is refunded by the venue from its gateway.
5. **Unresolved refunds.** Anything on **Refunds owed** or **Owed back at the counter** older than the date promised, and the
   month's **Refund workload** (how many refunds by hand, how many late). **Oldest acceptable age: ____ days.**
6. **Backup verification.** *Backups*: every recent snapshot marked **Whole**, the last off-site copy present, encrypted and
   signed, the age against the target. The **restore drill** (restoring a set on an isolated machine) is not a weekly
   task in the repository; **how often the owner wants it: ____**
   ([a restore drill](backups.md#a-restore-drill); a drill on a test machine does not prove production can be recovered).
7. **Support incidents.** Read the incident record: every open incident, what is owed to whom, and any defect to add to
   [known limitations](../roadmap/known-limitations.md) with its test.
8. **Venue feedback.** Ask each venue manager what went wrong this week (counter, cash, customers, the app); read **Reviews**.
   Write it down; there is no screen that collects venue feedback.
9. **Performance.** *Reports* and *Occupancy* tabs for the week; **Errors** (counts and new kinds); press **Booking integrity
   check** (the scheduler runs it daily; this asks again now). No performance threshold is set in the repository:
   **what we watch and its limit: ____**.
10. **Email reputation.** Bounces and complaints are **not read back by the app**: look at the SES reputation dashboard
    weekly ([SES checklist](email-ses-checklist.md), item 10).

## Incident procedures

Each is in order. The general sequence (write the time down, contain, keep evidence, recover, check it is over, tell,
follow up) and the severity levels are in [incident response](incident-response.md#every-incident-in-order); read it once.
**Keep the evidence before changing anything**: [what to keep](incident-response.md#keeping-the-evidence). Never put a key or
password in the record. Response times are the owner's: the table at the end has the fields.

### The application is unavailable

*Detected by:* the external uptime monitor (when configured), a venue, a customer, or **System health** reporting that the
scheduler has stalled.
1. Write down the time and who reported it. Open the incident record.
2. Ring the technical contact (escalation table). They restart the app and check the disk, memory and database connection
   ([the app is down](incident-response.md#the-app-is-down)).
3. If it lasts more than about 15 minutes in opening hours, ring each venue manager. **Counter bookings can still be written
   down on paper and entered afterwards.** The database refuses two bookings of the same court time, so a slot taken online
   meanwhile is refused when entered: ring that customer.
4. When back: check it is over ([checking it is over](incident-response.md#checking-it-is-over)): the health address answers, the
   scheduler is ticking, the **Booking integrity check** shows nothing.
*Evidence:* the time, the monitor's report, what the venues saw. *Escalate:* technical contact; incident lead if over an hour or
if data may be lost.

### Email delivery fails

*Detected by:* an alert on **System health** (messages not going out, email failing, email waiting too long); **Messages to
customers** showing *Retrying* or *Given up*; customers saying nothing arrived; a sign-up or password-reset request refused
as "temporarily unavailable" (on a production marketplace, that is deliberate while email cannot deliver).
1. Check the email provider's status page and the SES console (technical contact).
2. Ring every customer who must not miss news: **Needs attention** red lines.
3. Do not mark the alert **Dealt with** yet. Messages wait and are retried (the wait grows to two hours); one that keeps
   failing is given up after 7 days by default and the venue's managers and the owners are told.
4. When the provider is back, the queue sends what waited. For what was given up, use **Send again** in **Messages to
   customers** for the chosen window. A sign-up or password-reset email is **not** sent again by hand (its link is not kept):
   the customer asks again, and there is a per-address allowance and a 60-second wait between links
   ([security mail](../integrations/messaging.md#security-mail)). **No tool sends a link by hand.**
5. Check it is over: the alert has not come back; a test message to the operator's own address arrives.
*Evidence:* the alert text and counts, the provider's status. *Escalate:* technical contact; the owner (if SES access or
sending limits are the cause). [When a provider is down](../integrations/messaging.md#when-a-provider-is-down-and-what-keeps-a-message-from-being-lost).

### A customer pays but gets no booking

1. Get the booking code (if any), phone number, the time, the amount and how they paid.
2. **Paid at the counter:** *Bookings* day list: find the booking; if it is unpaid, mark it paid with the method; if it
   was cancelled, ask the venue manager what happened; nothing is refunded automatically.
3. **Paid online** (only once online payment is on): *Payments to check*. A payment after a hold lapsed, a short payment, a
   payment for another bill or without its amounts is **held and owed back in full**, and the booking is **not** confirmed or
   revived. The customer is told by email if their address was proved, and on the payment's return page.
   Check the venue's gateway dashboard for the true amount, then either refund by hand (**Refunds owed**) or help the
   customer book again on a new page. Press **Mark checked** with a note.
4. If the money is in the gateway, MySenam shows nothing and no list explains it: that is a defect; run **Booking integrity
   check**, keep both records, and ring the technical contact.
*Evidence:* the gateway's own record, the MySenam payment row, the booking code. *Escalate:* technical contact (defect);
the venue manager (to tell the customer). [Duplicate payments, or refunds that fail](incident-response.md#duplicate-payments-or-refunds-that-fail).

### A customer cancels but is not refunded

1. Find the booking and how it was paid.
2. **Paid at the counter:** *Owed back at the counter*. If it is not there: was it paid by credit or a pass (credit and
   entries go back on their own), or was it a cancellation from before the owed-back list existed (past cancellations are not
   listed; the venue knows whether it handed the money back; the read-only script `scripts/reconcile-counter-cancellations.sql`
   lists candidates for review)? Where it is listed, a named staff member hands the money back and presses **Handed back**.
3. **Paid online:** *Refunds owed* (is it owed, overdue, requested, processing, failed or completed?), then the gateway
   dashboard. A **late** cancellation under the terms the booking was sold on keeps the venue's share by design; the
   customer can read those terms on *My booking*. Do not override without the venue manager.
4. Tell the customer the date and the amount.
*Evidence:* the booking, the credit note number, the payout or refund record, the gateway record. *Escalate:* venue manager
(late share, exceptions); incident lead if money moved that should not have.

### Two customers claim the same slot

The database refuses two bookings of the same court time ([booking concurrency](../architecture/booking-concurrency.md)), so
two confirmed bookings of one slot should not exist.
1. Ask each for the booking code and look both up. Whichever is a confirmed booking of that court and time holds it.
2. The other is usually a booking for a different time or court, a counter slot written on paper and never entered, or a
   customer who was never booked. Find out which.
3. Settle it with the venue manager: move the other booking (offer the next slot) or cancel it with a refund through staff
   cancellation. Press **Booking integrity check**: if it reports a booking that holds no court time or the wrong one,
   that is [a booking disagreement](incident-response.md#bookings-that-disagree-or-a-double-booking): ring the technical
   contact, and the owner may suspend the venue's bookings until it is understood.
*Evidence:* both booking codes, the day list, **Staff activity** for the booking, the integrity check's text. *Escalate:*
technical contact if the integrity check reports anything.

### A venue closes unexpectedly

The pilot's closure policy is [the hardening record, section 5](../audits/hardening-2026-11-07.md#5-restricted-pilot-operating-policy-for-a-venue-that-cannot-yet-leave-a5--h8):
no venue is removed or closed by an automatic or unmonitored path; **suspension is the owner's act and does not settle any
liability**; closing a venue is done **by hand**: stop selling, refund or honour what is held, export, then suspend; and
**a suspension is never described to a customer as having settled what they are owed.**
1. Write down the time. Ring the venue manager and learn: closed today only, for some days, or for good?
2. **Today only or some days:** a manager closes the affected days (*Venues → Closures*, [closed days](../features/booking.md#operating-hours-and-closed-days)):
   it asks for a yes with the counts, writes the closure first, then cancels each booking, refunds what was paid and tells each
   customer; counter payments become **Owed back at the counter** and online payments **Refunds owed**. What was already played is left alone.
3. Clear the follow-up lists the same day: **Needs attention** (who has not seen it), **Owed back at the counter**,
   **Refunds owed**, any booking with kit still out.
4. **For good, or unreachable:** *Reports → Held for customers, in ringgit* for that venue: what is held (credit, vouchers,
   deposits, refunds owed), and the *Credit & passes* lists of passes and memberships. The owner decides in this order:
   stop selling, refund or honour what is held, export the venue's data, then **suspend** the venue under *Venues & staff*
   with a reason. A suspension emails each customer with something there once, hides the venue, stops new sales of passes,
   memberships, credit and vouchers, and leaves bookings standing; it does not pause pass or membership validity.
5. Ring anyone the emails cannot reach. Do not say anywhere that the suspension settles what customers are owed.
*Evidence:* the closure record, **Staff activity**, the liabilities figure, the export. *Escalate:* the owner (suspension),
the lawyer if customers' stored value is stranded ([legal packet](legal-review-packet-2026-11-08.md), item L6).

### Internet or the payment provider fails

1. **The venue's internet is down:** the venue writes counter bookings and payments on paper and enters them afterwards (as
   for [the application is unavailable](#the-application-is-unavailable)).
2. **The payment provider (Billplz) is down or its page will not open:** tell venues to take payment at the counter meanwhile.
   Unpaid online holds lapse as usual; a payment that arrives after its hold lapsed is owed back, never revived
   ([a provider is down](incident-response.md#a-provider-is-down-gateway-email-whatsapp-sms-google)).
3. If you cannot reach the gateway's dashboard, **do not mark a refund done**. Leave it on **Refunds owed** and keep the list.
4. When it is back, clear **Payments to check** and **Refunds owed**; check the failing-messages alert has not come back.
*Evidence:* the provider's status page, the times, the payments in between. *Escalate:* the provider's support (blank in the
table); technical contact if the callback address is the problem.

### A backup fails

1. *Venues & staff → Backups* (owner): read the state and the red line. Note which of *failed*, *paused* (the off-site copy
   is not allowed or not declared) or *behind the target* it is, and the storage's own message.
2. Press **Back up now** and confirm the snapshot appears and is marked **Whole**.
3. Ring the technical contact: the cause is a disk, a credential or a bucket
   ([backups fail](incident-response.md#backups-fail-or-an-off-site-restore-goes-wrong)). **A set whose signature does not
   verify is never restored.**
4. Severity: high if no good backup is less than a day old; critical if none can be restored at all.
*Evidence:* the alert text, the Backups panel, the storage's message. *Escalate:* technical contact; incident lead if no good
backup can be restored. **Until the off-site copy has been proved on a real bucket, a restore drill has been run on an isolated
machine, and the transfer approved, the pilot must not hold real customer data** ([pilot readiness](pilot-readiness-2026-11-07.md)).

### A suspected privacy breach

Follow [a suspected breach of personal data](incident-response.md#a-suspected-breach-of-personal-data); it is not repeated
here. The first minutes, in short: write the time down; **stop the leak without destroying evidence**; ring the **incident lead**;
**call the lawyer before anyone notifies a regulator or a customer, unless a deadline would be missed**; keep the record
somewhere other than the server. The notification rules in that document are partly from summaries and **not confirmed by a
lawyer**: do not quote them to anyone as settled. Never send personal data to a provider's support in a message.

### Staff lose access

1. **Forgot the password:** *Forgot your password?* on the staff sign-in sends a link (one use, 30 minutes) by email, which
   needs email to work; asking is limited to three links an hour per account
   ([forgotten passwords](../architecture/authentication.md#forgotten-passwords)). If email cannot deliver, no link goes: see
   the questions at the end.
2. **Lost the phone, still has recovery codes:** sign in with a **recovery code** (ten were shown once; each works once);
   then turn two-factor on again with new codes.
3. **Lost the phone and the recovery codes:** somebody with authority resets the account from *Venues & staff*: a platform
   owner for anyone; a business manager for their own business's staff; **only another owner for an owner**. The person
   resetting must have two-factor on themselves, enter their own current code, and write down how they knew it was really
   that person. The reset clears two-factor, signs the account out everywhere, and is emailed to the account and to every
   platform owner. Nobody resets their own.
4. **The last owner, with nobody above them:** the technical contact resets on the server with
   `npm run reset-two-factor -- <email> --reason "…"`, which is recorded and emailed the same way.
5. **Suspected misuse of the account:** treat as [somebody else in an account](incident-response.md#somebody-else-in-an-account)
   (new password, which ends every session; remove the account if needed; check **Staff activity**).
*Evidence:* the reset record and **Staff activity**. *Escalate:* the owner; the incident lead if misuse is suspected.

## One page: start of day and end of day

Date: ____ Venue: ____ Operator: ____ (one sheet per venue per day; tick and write the time)

| Start of day | Done | Time | Notes |
| ------------ | ---- | ---- | ----- |
| Signed in; two-factor works | [ ] | | |
| **System health**: any alert? scheduler line? | [ ] | | |
| **Backups**: state *active*; newest snapshot age | [ ] | | |
| **Needs attention**: open every block; red lines called | [ ] | | |
| **Payments to check**: count ____ | [ ] | | |
| **Refunds owed**: count ____, overdue ____ | [ ] | | |
| **Owed back at the counter**: count ____ | [ ] | | |
| **Messages to customers**: *Retrying* ____, *Given up* ____ | [ ] | | |
| Day list for today and tomorrow: unpaid or held ____ | [ ] | | |
| Venue manager rung: anything unusual | [ ] | | |

| End of day | Done | Time | Notes |
| ---------- | ---- | ---- | ----- |
| **Cash-up** counted by ____ and checked by ____; variance ____ | [ ] | | |
| **Handed back at the counter** today matches the till | [ ] | | |
| **Owed back at the counter**: any settled today; any left | [ ] | | |
| **Refunds owed** marked done only after the money went | [ ] | | |
| **Payments to check** all marked checked or escalated | [ ] | | |
| **Needs attention** cleared or handed over | [ ] | | |
| **System health** alerts dealt with or escalated | [ ] | | |
| Incident record updated | [ ] | | |
| Handover note for tomorrow written | [ ] | | |

## Escalation table

Names, telephone numbers and times are the owner's to fill in. No response time is promised in this document; the severity
levels are in [incident response](incident-response.md#how-bad-it-is).

| Role | Name | Phone | Email | Available (hours) | Response time we commit to |
| ---- | ---- | ----- | ----- | ----------------- | -------------------------- |
| Named daily operator | | | | | |
| Backup operator (covers the first) | | | | | |
| Incident lead | | | | | |
| Platform owner(s) | | | | | |
| Technical contact (server, app, database) | | | | | |
| Venue manager: venue 1 | | | | | |
| Venue manager: venue 2 | | | | | |
| Venue manager: venue 3 | | | | | |
| Malaysian lawyer (any suspected breach) | | | | | |
| Tax adviser (venue's) | | | | | |
| Payment provider support (Billplz) | | | | | |
| Email provider support (Amazon SES) | | | | | |
| Backup provider support (Backblaze) | | | | | |
| Hosting provider support | | | | | |

| Situation | First contact | Then |
| --------- | ------------- | ---- |
| Application unavailable | Technical contact | Incident lead; venue managers if over about 15 minutes in opening hours |
| Email delivery fails | Technical contact | Owner; email provider |
| Paid, no booking | Venue manager | Technical contact (a defect) |
| Cancelled, not refunded | Venue manager | Incident lead if money moved wrongly |
| Same slot claimed twice | Venue manager | Technical contact if the integrity check reports anything |
| Venue closes unexpectedly | Venue manager | Owner (suspension); lawyer if stored value is stranded |
| Internet or payment provider fails | Venue manager | Provider support; technical contact |
| Backup fails | Technical contact | Incident lead if no good backup can be restored |
| Suspected privacy breach | Incident lead | Lawyer first; then as the lawyer advises |
| Staff lose access | Owner | Technical contact for the last owner |

## Questions for the owner

Things this document could not source:

1. **Who gets access to each venue's Billplz dashboard** so the operator can make a refund by hand? The account is the venue's.
2. **A forgotten staff password while email cannot deliver:** no documented path was found (the server's two-factor reset
   clears the second step, not the password; `ADMIN_PASSWORD` replaces only a published default password at a restart).
3. **A named incident lead, a backup operator and the technical contact:** none is named in the repository.
4. **Limits for the weekly checks:** the cash variance, the agreed stored-value ceiling per venue, the oldest acceptable age
   of an owed refund, how often to drill a restore, and what performance to watch.
5. **Where the counter-owed list should be seen without opening it:** it is not in **Needs attention** and sends no email, so
   it is only seen if somebody opens it.
6. **The scheduler heartbeat and email health numbers have no screen:** only a red line when the scheduler stalls. Is a
   readable page wanted for the operator?
