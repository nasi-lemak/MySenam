# Messages to customers and venues

Authoritative for email, WhatsApp and SMS messages: what is sent when, delivery tracking, urgent news, venue alerts, staff calendars, marketing email and what WhatsApp costs. Template wording for Meta approval is in [WhatsApp templates](whatsapp-templates.md).

## Messages to customers

Confirmations, cancellations, class enrolments and waitlist offers are written
to an outbox the moment the thing happens, then sent separately and retried
with backoff — a mail server being down delays a confirmation; it never loses
the court. Staff see every message, and why one failed, under *Venues*.

The booking code is on the customer's screen the moment the booking is made,
with *Add to Google Calendar* and a calendar file beside it, so nothing waits
on a message arriving. Messages are the copy they keep:

- **Email first** (`SMTP_URL` + `MAIL_FROM` for any SMTP account — Gmail, Zoho,
  Brevo — or the `SES_*` settings + `MAIL_FROM` for Amazon SES over HTTPS;
  [email transports](#email-transports)). Anyone who gives an address gets their confirmation by
  email, with the booking attached as a calendar invite (each week of a
  series, and a reminder an hour before), so it is in their diary in a tap.
  It costs next to nothing. The booking form asks for the address as *Email
  (for your code + calendar)*.
- **WhatsApp for what must not be missed** (`WHATSAPP_TOKEN` +
  `WHATSAPP_PHONE_NUMBER_ID`). Each venue chooses under *Venue details →
  WhatsApp messages*:
  - **Urgent only** (the default): the venue's own cancellations and moves,
    and waitlist offers, go to the customer's phone as well — included, the
    platform pays.
  - **Everything**: confirmations too, and day-before reminders if ticked;
    urgent news is still included, the rest comes from prepaid credit
    (below).
  - **Off**: email only; anyone who cannot be reached shows under *Needs
    attention* for a call.
- **SMS is not offered**: it costs more than WhatsApp and Malaysian sender
  rules make it the harder of the two to run.
- A customer who gave no email, at a venue without WhatsApp, gets no message:
  they have the code on screen, the calendar buttons, and *My Booking*.
- Messages wait in the queue until a channel is configured, and the
  dashboard says so.

**What is sent, and when.** Each message is written the moment the thing
happens and sent at once, then retried (1, 5, 30, 120 minutes; five tries).

| When | Message | Channels |
|---|---|---|
| A booking, a weekly series or a class place is made | Confirmation, with a calendar invite | email; WhatsApp on *everything* |
| The customer cancels | Cancelled | email; WhatsApp on *everything* |
| The venue cancels — at the desk, by closing the day, by taking the court out of service, or by calling off the class | **Cancelled by the venue**, with a *seen it* link (urgent) | email; WhatsApp unless *off* |
| The venue moves a booking to another court | **Moved**, with the new court and a *seen it* link (urgent) | email; WhatsApp unless *off* |
| A waitlist place frees up | Offer, with a link to claim it (urgent: it expires); the page it opens can also turn the offer down | email; WhatsApp unless *off* |
| Somebody joins a waiting list online, giving an email address | **On the waiting list** (kind `waitlist_joined`), with the private link to leave it ([leaving](../features/booking.md#leaving-and-turning-an-offer-down)) | email only |
| A class's name or instructor is changed, to those enrolled and those holding an offer of a place, giving an email address | **A change to the class** (kind `class_changed`), once per person per change, saying what it was and what it is; an offer's carries its link ([changing a class](../features/programmes.md#changing-a-class)) | email only |
| The day before, for a booking made more than a day ahead | Reminder | email; WhatsApp only on *everything* with *Day-before reminders on WhatsApp too* ticked |
| A booking is paid later — online, or marked paid at the counter | Receipt | email only |
| Tournaments, leagues and open games: entering, coming off a waiting list, a tournament's new name before its draw, the draw, a season starting, a call-off, a game's changes, the day before a game a player joined | The programme's own message (kind `programme`) | email only |
| On a tournament's day: a side's match is the next on its court (within the hour, or late), and when a manager or official calls it to its court | **Next** and **Called** (kind `tournament_day`, template `mysenam_tournament_day`, prepared and not yet submitted to Meta in [WhatsApp templates](whatsapp-templates.md#mysenam_tournament_day)), once per fixture, side and call, to the account that holds the entry and in its language, never to somebody who left ([tournament day](../features/tournaments.md#tournament-day)) | email; WhatsApp only on *everything*, to a number the account proved |

Programme emails are queued in the outbox, inside the change's own
transaction where it has one (a withdrawal, a result, a season starting), so
one whose email fails is retried like any other. Each is written in the
language the player's account last used the site in (`users.locale`, kept
when a signed-in request carries a different language; migration 0112), or
the install's first language before it has one or if it no longer offers
it. What staff typed (a venue's reason for moving a game) and the names of
rounds ("Semi-final 2") stay as written.

### Email transports

Email leaves by one of two transports, chosen by configuration alone
(`emailConfig` in `src/lib/transports.ts`, the one place that says whether
email is set up and how). Both send the same message: the same sender,
subject and text, the booking as a calendar invite, and a venue's news with
the one-click unsubscribe headers.

| | SMTP | Amazon SES over HTTPS |
| - | ---- | --------------------- |
| Set by | `SMTP_URL`, `MAIL_FROM` | `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_REGION`, `MAIL_FROM`; optionally `SES_SESSION_TOKEN`, `SES_CONFIGURATION_SET` |
| Goes through | nodemailer, to any SMTP server, on port 25, 465 or 587 | SESv2 `SendEmail` at `https://email.<region>.amazonaws.com/v2/email/outbound-emails`, port 443 |
| Why | Any provider | Many cloud hosts refuse outgoing SMTP ports, especially on new accounts; HTTPS is not refused |

If both are set, **SES is used and `SMTP_URL` is not**. SES is chosen only
when all four of its required settings are present; the `AWS_*` variable
names are deliberately not read, since other tools on a machine set them
(sometimes to placeholders). With neither set, messages queue and the
dashboard says so, as for any unconfigured channel.

**How the SES transport sends** (`src/lib/ses.ts`). The message is built
with nodemailer (`streamTransport`), without sending it, to get the finished
email as raw MIME; that goes as base64 in `Content.Raw.Data` with the sender,
the one recipient and the configuration set if there is one. The request is
signed with AWS Signature Version 4, service `ses`, by the signer the
off-site copies use (`signV4` in `src/lib/offsite.ts`), with no SDK and no
new dependency; it has a 15-second limit. `SES_REGION` must look like an AWS
region (`ap-southeast-1`) before it becomes part of the host name. SES's
`MessageId` is kept as the message's provider id.

**When SES says no.** The error carries SES's own words and the HTTP status
(`Amazon SES refused it (400): …`) and never a credential. A throttle (429,
`TooManyRequestsException`) or a 5xx is worded as SES being throttled or
unavailable; everything else, including the sandbox refusing an address that
is not verified (`MessageRejected`, "Email address is not verified"), is a
plain failure with its reason. Every failure goes through the outbox's usual
retry (1, 5, 30 and 120 minutes, five tries) and then the message is
abandoned with the reason, so a throttle is retried and not lost, and
staff see why under *Venues*.

**Sandbox and production access.** A new SES account is in the sandbox: it
sends only to addresses and domains verified in SES, at most about 200 a day
and one a second, and the sender (`MAIL_FROM`) must be a verified identity.
For real customers the account needs *production access*, which the owner
requests in the SES console (a description of the use; usually answered
within a day). The domain is verified by publishing the DKIM records SES
gives, and DMARC should be set on it too. The real-service check reads the
account and the sender's identity and says which of these is the case
([checks](../development/testing.md#staging-and-real-services)).

**What a bounce looks like.** The app does not read bounces or complaints
back: SES accepting the request is "sent" in the outbox, which is not proof
the message arrived. A bounce, a complaint or a suppressed address is
visible in SES's console and, with `SES_CONFIGURATION_SET` pointing at a set
with an event destination, in the events it publishes; reading them back into
the outbox is a known limitation. Nothing here has been checked against a
real SES account yet: the transport is tested against a stand-in for SES, so
email stays `INTEGRATION_VERIFICATION_REQUIRED` until the real-service check
passes ([workstream](../roadmap/integration-workstream.md)); what a bounce
looks like in practice is recorded then.

### Emails that belong to no venue's customers

Emails to people applying to list a venue, password reset links, alerts to
the platform's owners and to a venue's staff, and WhatsApp credit alerts go
through the same outbox (`emailPlain` in `src/lib/outbox.ts`), so they are
retried with the same backoff, listed with how they went, and never sent
twice:

| Message | Kind | Belongs to | Gives up |
| ------- | ---- | ---------- | -------- |
| Password reset link (customers and staff) | `account_email` | the platform | when the link runs out (`expires_at`, the reset's own lifetime) |
| Confirming an application's email address | `account_email` | the platform | when the confirmation link runs out |
| An application approved, refused, or asked for more | `applicant` | the platform | after the five tries |
| Alerts to the platform's owners (system alerts such as a failed backup, courts or classes piling up, an application, a reported review, a dispute on the platform's account) | `staff_alert` | the platform | after seven days |
| Alerts to a venue's staff (a suspension or payment hold, a review hidden, a league or dispute matter, WhatsApp credit low) | `staff_alert` | that venue | after seven days |

- **A link that has run out is not sent.** A reset email still queued when
  its link stops working is given up ("Not sent: it ran out before it could
  go"), not retried, and cannot be put back in the queue, to the same
  address or another.
- **What it carries is not kept.** Once an `account_email` is sent, given up
  or capped, its body (with the link) is wiped from the outbox; the owners'
  list shows that it went, never the link.
- **Staff alerts are not held to the daily limit** that protects customers
  from being flooded, since an alert that does not arrive is worse than one
  too many; the request rate limits on asking for a reset or applying stay
  as they were.
- **Who sees them**: the platform's own messages are listed for the
  platform's owners under *Venues & staff → Messages → Platform emails*,
  and only they can resend one; a venue's staff alerts are listed with that
  venue's messages.
- Applying with no mail server configured still opens the application at
  once (development and log mode); with one, the confirmation waits in the
  queue rather than being skipped on a first failure.

Tested with a stand-in mail server that fails and recovers
(`tests/platform-messages.test.ts`, on PGlite and Postgres).

**Sent is not received.** *Sent* means the mail server accepted the message.
It may still bounce, be filtered as spam or sit in a full mailbox; bounces
and complaints are not read back from any provider. Live delivery,
SPF/DKIM and bounce handling are part of the
[launch checklist](../operations/deployment.md#launch-integration-checklist).

Closing a day that has bookings or classes on it is refused until staff say
to cancel them; then each customer is told, as above. Messages are written in
the language the customer booked in.

**In the message's language, links and times too.**

- *Links.* Every link MySenam puts in a message to a customer (a waiting-list
  offer, *My Booking*, a receipt, *I have seen this*, a review, a gift
  voucher, a loyalty reward, a company account's invoice, confirming
  marketing email, a customer's password reset, programme emails and the
  guardian emails' people page) carries the message's language as a fixed
  parameter, `?lang=ms`, so it opens in that language in a browser that has
  never been to the site; a language the person has chosen with the switch
  wins ([regions](../product/regions-and-tax.md)). A staff password reset's
  link carries the staff member's own language; staff alerts and coach
  emails carry no link parameter.
- *Times.* A message writes a time as its language does, by the same
  formatter as the pages (`formatHour` and `formatMinute`, from
  `clockTime` in `src/lib/region.ts`): *6:30 PM*, *6:30 PTG*, *下午6:30*,
  *18:30*; a moment (a guardian change, a payment deadline) in the venue's
  time zone. Staff and coaches are written to in their own language, times
  as it writes them ([a language of their own](../product/regions-and-tax.md#a-language-of-their-own-for-staff-and-coaches)).

Tests: `tests/link-locale.test.ts` (the parameter, the middleware, the
language a page opens in, links in an offer, a confirmation, a receipt and a
venue's cancellation), `tests/message-times.test.ts` (each language,
morning, afternoon and past midnight, in the venue's zone).

### Guardian notices

When who acts for a participant changes (ADR 0023;
[another guardian by invitation](../features/venue-operations.md#another-guardian-by-invitation)),
the participant's other guardians with an account (acting for them now, not
paused) are emailed through the outbox (`notifyGuardianChange` in
`src/lib/guardian-requests.ts`, kind `account_email`, in the language each
account last used):

| When | To | Says |
| ---- | -- | ---- |
| Another guardian added (a request agreed, or made by an exception) | every other guardian, except the new one and the one who just agreed | that a guardian was added for {name}, and when |
| A guardian's relationship ended (ended by them, or revoked by staff) | every remaining guardian | that a guardian stopped acting for {name}, and when |
| A request staff started was accepted and waits for agreement | every guardian who could agree | that another adult asked, that nothing changes unless they agree or a manager records an exception, and where to answer |

Each names the participant and the general nature of the change and when it
took effect (in the venue's time zone), links to the account's people page
(`/account#people`) to report a mistake or answer, and gives the venue to
contact (its name and number) where a venue is involved. Never the other
adult's name or details, and never a location, court, schedule or anything
else private. A guardian taking over, with their own account, the
relationship a venue recorded by name and number is told to the others the
same way (`gw5.mail.claimed`). An exception that requires it
(`suppressNotice`, a manager's) tells nobody, and the participant's history
says so (`guardian.notice_suppressed`).

Guardians a venue recorded by name and number only have no email
(`noticeContactGuardians` in `src/lib/contact-guardians.ts`;
[guardians without an account](../features/venue-operations.md#guardians-without-an-account)):

- At a number a code has come back from (staff sent a code to it and the
  guardian read it back), and where WhatsApp is set up, a WhatsApp message
  (kind `guardian_notice`, template `mysenam_guardian_notice` in
  [WhatsApp templates](whatsapp-templates.md)), in the language of the code
  that came back (`participant_guardians.contact_locale`, migration 0198;
  the install's first language for one confirmed before): the venue's name,
  what changed (another guardian added; a guardian stopped acting; another
  adult asked to become a guardian, nothing changing unless a guardian
  agrees or the manager records an exception; a guardian recorded by name
  and number now on their own account, nobody new acting), and the venue's
  page, in that language, to find its number; ask at the counter or call.
  Never the child's name, birth year or anything about them, nor the other
  adult's, since a number is not an identity. Paid by the platform, as
  urgent news is; queued, retried and capped per number like any other.
  SMS is not used: the outbox has no SMS channel.
- Otherwise nothing is sent, and the venue that recorded them gets a task
  (`guardian_notice_tasks`, migration 0173, with why: the number was never
  checked by a code, or no WhatsApp), shown under *Needs attention* to its
  staff until one of them marks it done (`POST /api/admin/attention`,
  `guardianTold`), with who.
- A WhatsApp notice that does not reach them becomes the same task, with
  why *not delivered* (`taskUndeliveredNotices`, migration 0184): given up
  by the outbox (out of tries, over the day's limit for the number, run
  out) or reported undelivered by WhatsApp afterwards. Which notice went to
  which guardian about what is kept (`guardian_notice_messages`), and the
  task names the message; it is made once per notice, after each outbox
  drain (`tickOutbox`), and not for a guardian whose relationship has since
  ended. A notice that was sent and not reported undelivered makes no task:
  WhatsApp's acceptance is not proof it was read.
  Tests: `tests/guardian-notice-undelivered.test.ts`.

The codes staff send to such a number (`gw5.sms.code`: the code and the
venue's name) go through the phone-check delivery (`src/lib/phone-check.ts`,
SMS or WhatsApp's authentication template) and its daily limits, not the
outbox.

Queued like any other message: retried when the mail server is down, held
to the daily limit per address, its body (with the account link) wiped once
sent. The change is made and recorded before anything is queued, so a
failed delivery, or a failure even to queue it (recorded as
`guardian.notice_failed`), never undoes the change or loses its record; the
queued messages are listed in the participant's history
(`guardian.notified`, and `guardian.notified_contact` for those recorded by
name and number). Tested with a transport that fails and a queue that
throws (`tests/counter-guardians.test.ts`), and the WhatsApp notice and the
tasks with a stand-in SMS gateway and a queued WhatsApp message
(`tests/guardian-contact.test.ts`, the notice's language, each change's
wording and its three values too); live delivery is part of the email,
SMS and WhatsApp integrations' verification.

**The guardian notice template is prepared, not submitted.** Before any
notice can reach a guardian:

1. In WhatsApp Manager, under the business account that owns the number in
   `WHATSAPP_PHONE_NUMBER_ID`, create `mysenam_guardian_notice` (with this
   install's `WHATSAPP_TEMPLATE_PREFIX` if it has one), category
   **Utility**, with its four translations (`en`, `ms`, `zh_CN`, `ta`)
   exactly as in [WhatsApp templates](whatsapp-templates.md#mysenam_guardian_notice)
   and the sample values given there for its three variables.
2. Wait for Meta to approve each translation. Meta may re-categorise it or
   ask for changes; a changed wording is changed in the dictionaries first
   (the test that compares them with the document fails otherwise) and
   submitted again.
3. Nothing else is configured: the notice goes through the WhatsApp set-up
   every other message uses (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`).
   Until the template is approved a notice sent fails at Meta, is retried,
   is given up, and becomes the venue's task like any undelivered notice;
   nothing about a guardian's consent or relationship waits on it.

Then verify it live, as the WhatsApp integration's other templates are,
before calling it working ([testing](../development/testing.md)).

### Urgent news, and knowing it arrived

A cancellation or a move by the venue is something a customer must not miss —
otherwise they turn up to a court that is not theirs. Each one opens a notice
that stays on **Bookings → Needs attention** until somebody knows the customer
has it:

- The message carries a link; the customer taps *I have seen this* on the
  page it opens (opening the link alone does not count, since email scanners
  open links by themselves), and the notice closes.
- Until then the desk sees how far it got: *waiting to send*, *sent* (email
  accepted by the mail server), *delivered to phone* and *read* (WhatsApp
  reports both back through the webhook), *failed*, or *no email or
  WhatsApp — call them*, with the number to ring. Soonest booking first.
- *I have told them* closes it once staff have rung or spoken to them. Closed
  notices stay visible for a week.

The message list under *Venues & staff* shows the same delivered, read and
not-delivered states for every WhatsApp message.

Numbers are sent the way WhatsApp wants them, whatever was typed:
`012-345 6789` becomes `60123456789`.

### New-booking alerts to the venue

Under *Venue details → New-booking alerts* a venue gives an email address, a
WhatsApp number, both or neither (the default). Each booking a customer makes
online then goes to them too: who booked, their number, the court and time,
the code, the amount and whether it is paid. A booking held for payment is
announced once it is paid, when it stands. Bookings staff make at the desk
are not announced back to the desk.

- They go through the same outbox as customers' messages, so they are retried
  and show under delivery, but are **not held to the daily limit per
  recipient**: that limit is there to keep the site from flooding somebody
  else's phone, and a busy venue takes more bookings than it allows.
- On WhatsApp each alert counts against the venue's messages like any other,
  and needs the `mysenam_venue_new_booking` template below approved.
- They are written in the staff language chosen with the address and number
  (*Alerts written in*; `venues.alert_locale`), else the install's first
  staff language, their hours as it writes them
  ([a language of their own](../product/regions-and-tax.md#a-language-of-their-own-for-staff-and-coaches)).
- Where the venue asked, customers' online cancellations and changes are
  announced the same way, in the same language (kind `venue_booking_change`,
  template `mysenam_venue_booking_change`, prepared and not yet submitted to
  Meta); which ones, and how far ahead, is in
  [booking alerts](../features/venue-operations.md#booking-alerts).

A lesson's confirmation names the coach where it names the court (*Court 1,
lesson with Ana Lim*). A booking, class enrolment or waiting-list offer made for
somebody else ([booking for somebody else](../features/booking.md#booking-for-somebody-else))
goes to the customer who made it (the guardian), through their usual
channels and preferences, and names who it is for in the same place (*Court
1, for Alya*; *Kids gym, for Alya*); the participant needs no email or phone
of their own, and nothing else about them is said. The templates are
unchanged: the name is part of the place they already carry. A customer's cancellation says what happened to the
money: the late-cancellation fee kept, refunds on their way and how, or that
nothing is owed. That changed the `mysenam_booking_cancelled` template (a new
`{{5}}`), which has to be submitted to Meta again. A gift voucher bought online
is emailed in the language it was bought in.

### Bookings in staff's own calendar

Under *Venue details → Bookings in your own calendar* a manager turns on an
iCalendar feed (`lib/staff-calendar.ts`). Staff subscribe to it in Google
Calendar, Outlook or their phone, and the venue's bookings and classes show up
next to the rest of their day, from a week back to 90 days ahead. Each booking
is *Court 1: Name (unpaid)* with its code, times, number and amount. Each class
is *Yoga Flow (6/8)*. Cancelled bookings drop off at the next refresh, which
the feed asks for every 30 minutes.

- What people read (each event's title and description, the calendar's
  name) is in the staff language the address names (`?lang=ms`), with times
  as that language writes them: the address the dashboard shows names the
  own language of whoever turned the feed on or looked it up, else the
  language they were reading the dashboard in. A language staff
  screens do not have, or none, gives the install's first. What calendar
  apps read (start, end, zone, ids) is the same in every language
  ([times for staff](../product/regions-and-tax.md); `tests/staff-times.test.ts`).

- The address is `/api/calendar/<token>.ics` on the venue's own domain where
  it has one. A calendar app cannot sign in, so the long random token is the
  key. It shows customers' names and numbers, so *Make a new address* replaces
  it (calendars on the old one stop updating) and *Turn off* withdraws it. Both
  go in the activity log. Turning it on, renewing it and turning it off are for
  managers; front desk can copy it.
- The database keeps no readable copy of the token: the feed is found by its
  hash, and the copy the dashboard shows again is sealed with the install's
  secret, which a database copy or backup does not carry
  ([security](../architecture/security.md#private-links-and-who-decides-approvals)).
  An address made before that (migration 0240), or on an install restored
  without its secret, keeps working but is not shown: the dashboard says so,
  and a manager makes a new one to copy.
- Each address lapses a year after it is made; the dashboard shows the date,
  and once it has passed the feed answers nothing and the dashboard says to
  make a new one (`tests/calendar-feed-hash.test.ts`).
- The response is `Cache-Control: private, no-store` and `noindex`.

### What WhatsApp costs, and who pays

Meta charges the platform for each template it delivers to a customer — a
few sen each in Malaysia, more for marketing, which MySenam never sends.
Email costs next to nothing and is the default. The codes that check a
customer's phone number are the platform's own cost: they protect the whole
marketplace, not one venue.

- **Urgent news is included.** A venue's own cancellations and moves, and
  waitlist offers, are few — at an assumed 2% of bookings each and one
  surprise closure a month, roughly RM0.60 a month for a 1-court venue and
  RM11 for 20 courts at a few sen a message — so the platform pays for them
  and no venue needs credit to be sure its customers are told.
- **Prepaid, never billed afterwards,** for everything else. On a marketplace a venue buys
  WhatsApp messages in packs — `MYSENAM_WHATSAPP_PACK` (200) for
  `MYSENAM_WHATSAPP_PACK_PRICE` (RM20) — paid online into the platform's
  Billplz account, or by transfer and marked paid by the owner. Each message
  sent spends one; one that fails to send is given back.
- **At zero, those messages stop; nothing else does.** Email, the on-screen
  code and urgent news on WhatsApp carry on, and nothing is sent on credit. The venue's staff are
  emailed at 20 left and again at none. So a venue that stops paying costs
  the platform nothing.
- **What staff see.** Under *Venue details → WhatsApp messages*: off, urgent
  only or everything; this month's urgent messages (included) and those from
  credit; and on *everything*, messages left, *Buy 200 messages · RM20*, what this month went on,
  and an estimate — bookings a month in, messages and packs out.
- **The platform owner** can mark a pack paid or void it, and give messages
  (a trial, goodwill).
- A venue's own install (not a marketplace) pays Meta itself: choosing
  *everything* is all it takes.

**Customers who ask on WhatsApp.** WhatsApp lets a business answer a customer
who wrote first with plain text; starting the conversation takes an approved
template. Meta's own pricing page says such replies are free, but resellers
report charges for them from 1 October 2026, so each reply spends a message
of the venue's credit like any other. Once `WHATSAPP_CHAT_NUMBER`,
`WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` are set, the confirmation
screen of a venue with WhatsApp on and credit left shows a green *Send it to
my WhatsApp* button. It opens a chat with the platform's number
with *Hi! Please send me booking MS-XXXXXX.* typed in; the customer presses
send.

- The confirmation waits `MYSENAM_WHATSAPP_CHAT_HOLD_MINUTES` (3) before it
  goes as a template. If the customer's message arrives first, the same words
  go as the reply instead, and the template never goes: one message either
  way, whichever Meta charges less for.
- Writing later — or again — gets the latest message about the booking.
- Only to the number the booking was made with. A code from any other number
  gets no answer.
- Waitlist offers and cancellations are never held; nobody is waiting on a
  screen for those.
- Staff see these as *reply in chat* in the message list, counted apart
  under *This month*.

To switch it on, in the Meta app: *WhatsApp → Configuration → Webhook*, set
the callback URL to `<MYSENAM_URL>/api/whatsapp/webhook` and the verify token
to `WHATSAPP_VERIFY_TOKEN`, then subscribe to the `messages` field. The same
subscription carries Meta's delivered, read and failed reports, which is what
lets staff see whether urgent news reached a phone. The app
secret is under *App settings → Basic*. A delivery without a valid signature
is refused.

## News from venues (marketing email)

A venue can email news and offers to customers who asked for them, and to
nobody else (`src/lib/marketing.ts`, migration 0059). Written for
Malaysia's PDPA and Singapore's PDPA and Spam Control Act; not legal
advice, and a venue running promotions should still check with its own
adviser.

- **Asked, never assumed.** Under the booking form, once an email address
  is typed, an unticked box: *Email me news and offers from {venue}. I can
  unsubscribe at any time.* Ticking it is recorded per venue and address,
  with the words as shown in the customer's language and when. Nothing else
  signs anybody up: not an account, not a booking at the counter, not staff.
  An address that is not the signed-in account's own (anybody can type
  one), or one that had unsubscribed, is sent one email asking it to confirm,
  and nothing else until it does.
- **Stopping is one click** from the link at the foot of every copy (a
  page with a button, so mail scanners following links do not unsubscribe
  people), or from *News from venues* on the account page. Booking
  confirmations, reminders and receipts are not marketing and keep coming.
- **Sending** is under *Venues & staff → News to customers* (managers): a
  subject and some words, a test copy to yourself first, then *Send to N*
  after a confirmation. Every copy ends with why the customer gets it and the
  unsubscribe link, in the customer's own language; the venue cannot remove
  it. At most 4 in 30 days per venue. The usual daily cap per recipient
  applies.
- **Email only.** No WhatsApp: each message costs the venue, and in
  Singapore marketing messages to phone numbers fall under the Do Not Call
  registry.
- **Personal data:** consents (with their wording) are in the customer's
  data export, and closing an account deletes them.
