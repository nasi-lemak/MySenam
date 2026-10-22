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

- **Email first** (`SMTP_URL` + `MAIL_FROM`, any SMTP account — Gmail, Zoho,
  Brevo, Amazon SES). Anyone who gives an address gets their confirmation by
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
| A waitlist place frees up | Offer, with a link to claim it (urgent: it expires) | email; WhatsApp unless *off* |
| The day before, for a booking made more than a day ahead | Reminder | email; WhatsApp only on *everything* with *Day-before reminders on WhatsApp too* ticked |
| A booking is paid later — online, or marked paid at the counter | Receipt | email only |

Closing a day that has bookings or classes on it is refused until staff say
to cancel them; then each customer is told, as above. Messages are written in
the language the customer booked in.

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
- They are written in the install's first language.

A lesson's confirmation names the coach where it names the court (*Court 1,
lesson with Ana Lim*). A customer's cancellation says what happened to the
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

- The address is `/api/calendar/<token>.ics` on the venue's own domain where
  it has one. A calendar app cannot sign in, so the long random token is the
  key. It shows customers' names and numbers, so *Make a new address* replaces
  it (calendars on the old one stop updating) and *Turn off* withdraws it. Both
  go in the activity log. Turning it on, renewing it and turning it off are for
  managers; front desk can copy it.
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
