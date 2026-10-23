# Running a venue day to day

Authoritative for the desk's tools: check-in and crowd levels, unstaffed hours and door codes, equipment hire, notes on customers, waivers and private hire enquiries.

## Check-in and live crowd levels

Places booked and people present are different numbers, so arrivals are tracked
separately. Staff check a customer in from the Bookings tab (the Attendance
column), and optionally out again.

`GET /api/venues/:id/live` — public, no session — answers *how busy is it right
now*: someone counts as present once they have checked in, have not checked
out, and their booking has not ended. Most people leave without telling the
desk, so the booking's end time is the backstop that keeps the number honest.
The venue page renders this as a **Here right now** panel that refreshes every
30 seconds.

Check-in and no-show are mutually exclusive and self-correcting: a customer who
checked in cannot be flagged a no-show, and checking someone in clears a
no-show the desk had already recorded when they turn up late.

### Self-service check-in

Every booking carries a random 128-bit `check_in_token`, separate from the short
booking code (codes are printed on receipts and are far easier to guess). The
booking confirmation, `/account` and the `/my-booking` lookup each show a QR
code encoding `/checkin/<token>`; scanning it checks that booking in and shows
a confirmation, so arrivals do not depend on a staff member pressing a button.

Check-in — by QR or at the desk — is only open from
`CHECK_IN_OPENS_MINUTES_BEFORE` (60) minutes before the slot until it ends.
Without that window an early scan would count toward the live headcount for the
rest of the day.

## Resources nobody is standing next to

Unstaffed gyms are a proven model — Anytime Fitness, Snap, Jetts, chocoZAP —
and what makes them work is not an absence of staff but a specific stack:
staffed hours daily, an induction in person before out-of-hours access, a
credential tied to one identity, cameras, a duress button, and equipment chosen
for use with nobody watching. MySenam models the parts of that stack that are
software.

**Two dials, not one.** A **venue** says when somebody is behind the counter
(`staffed_from`/`staffed_to`; both `NULL` means always, equal values mean
never). A **resource** says whether it may be used outside that window
(`unmanned`). The same gym floor is staffed at 10 AM and unstaffed at midnight,
which is how these places really run, and a centre can leave its courts
unattended overnight while the kayak counter keeps someone on it.

Two combinations are refused outright, whatever a venue asks for:

- **Any activity the catalogue marks as supervised** (`supervised`, see
  [activities](activities.md#the-catalogue)): swimming, water polo and
  everything on the water. Drowning is silent and fast, which is why the
  24-hour chains sell gym floors and not lap pools. A court offering several
  activities is refused if any of them is supervised.
- **Anything hired out against a deposit.** There is nobody to hold the money
  and nobody to look at the hull when it comes back.

**MySenam does not open the door.** It relays a code that staff have programmed
into the lock, and the lock stays the source of truth. Generating or rotating a
code here would be worse than useless: the lock would not know about it, and
the court would be unopenable by the one person entitled to be inside. Staff
type in what they set; MySenam stamps when it changed and nags after
`ACCESS_CODE_STALE_DAYS`.

**MySenam does not open the door.** It relays a code that staff have programmed
into the lock, and the lock stays the source of truth. Generating or rotating a
code here would be worse than useless: the lock would not know about it, and
the court would be unopenable by the one person entitled to be inside. Staff
type in what they set; MySenam stamps when it changed and nags after
`ACCESS_CODE_STALE_DAYS`.

Who gets the code, and when:

| Condition | Why |
| --------- | --- |
| The resource is unmanned and has a code | Otherwise there is nothing to give, and the customer is told someone will let them in |
| The booked hour is **unstaffed** | During staffed hours the counter does this, and a code handed out then is a code in circulation for no reason |
| The customer has been **inducted** at that venue | Nobody is there to show a stranger where the emergency button is, so it has to have happened already, in person. An induction is not an activity [sign-off](activities.md#sign-offs), which clears somebody to book one activity at any hour |
| The booking is not cancelled | — |
| **The booking is paid** | Nobody is on site to take payment, so the door is the till. An unpaid booking still holds its slot; the code appears the moment staff or a payment marks it paid |
| Inside the check-in window | The same hour before the slot that check-in already uses |
| Before the slot ends | — |

Each refusal carries its own `reason`, so the customer is told what to do about
it rather than getting a flat no.

**Inductions** are the part that turns unstaffed hours from reckless into
insurable, so they are recorded by a named operator and can never be
self-declared: `POST /api/admin/inductions` takes the admin from the session,
not the body. One row per person per venue, revived rather than duplicated if
access is withdrawn and later restored, matched on a normalised phone number so
`+60 12-345 6789` and `012-345 6789` are the same person. Withdrawing access
shuts the door on the next request.

Four consequences worth stating plainly:

- **Every reveal is written down**, one row per look, with the booking, name and
  phone behind it. When a court is found in a state on Tuesday night, "who had
  the code" is the whole investigation — so the log is append-only and the
  venue's staff can read it from the Courts tab.
- **Opening the door is the arrival.** The reveal checks the customer in, so
  *Here right now* stays honest and no-shows stay meaningful with nobody at a
  desk to press a button.
- **The entry screen carries the emergency details.** The venue's out-of-hours
  number and whatever it wants people to know — where the AED is, the nearest
  clinic — plus how many people are checked in right now, so somebody letting
  themselves into an empty building at 2 AM knows they are on their own. It is
  the one screen you know they are looking at while standing inside.
- **The code never travels with the court.** `Court` is served by the public
  `/api/venues` and availability routes, so it carries `unmanned` but never the
  code itself; the code is only ever read through an admin route or handed to
  one authenticated customer, with `Cache-Control: no-store`. Asking for it is
  a `POST` for the same reason — it writes a log line, and has no business in a
  browser history or a proxy log.

The customer-facing reveal is rate limited to 10 per 10 minutes per IP, tighter
than an ordinary booking lookup, because a booking code plus a phone number is
now a door.

## Equipment hire and deposits

Most resources stay where they are: you cannot walk off with a badminton court.
A kayak is different. It goes out on the water, it can come back damaged, and
the venue holds something against that — usually cash or a card imprint at the
desk, handed straight back when the hull is.

A court carries a `deposit`. `0`, the default and the only sensible value for
anything fixed, means the resource is not handed over at all and no hire
appears anywhere in the flow. Above zero turns on the counter workflow:

- **Handing over** records the deposit held against that booking and checks the
  customer in, since those are one action at the desk. The check-in window
  applies unchanged, so kit cannot leave an hour before the slot it belongs to.
  Staff may override the amount, including waiving it — the record is worth
  keeping either way, because the kayak is out.
- **Taking it back** records the condition (fine, damaged, not returned),
  anything kept back out of the hold, and a note. Nothing can be kept back that
  was not held, and anything short of a clean return needs a note: the customer
  is about to be told why they are not getting all of their money, and
  "damaged" on its own is not a reason that stands up a week later.
- **While kit is out** the booking cannot be cancelled or moved, by staff or by
  the customer, and the venue cannot switch the deposit off on that resource.
  All three would quietly destroy the only record of what is out and what is
  being held against it.

The deposit is deliberately *not* a wallet movement. Stored credit is money the
venue owes the customer against future bookings; a deposit is a hold at the
counter that mostly ends up handed back untouched. Modelling it as credit would
put both in the same balance and make a refund look like a top-up. `hire_records`
therefore tracks the state of the hold — taken, returned, how much was kept and
why — and leaves the ledger alone.

Customers see the deposit before they commit: on the grid row, on the booking
panel and on the confirmation, phrased as what it is rather than as a charge.

## Notes on a customer

Staff remember things about regulars: prefers Court 3, pays by transfer, bring
the ramp out, the coach's son. 📝 beside a customer on the day's bookings
writes a note against their phone number, one per number per venue (however
the number is typed), and it shows on every booking of theirs from then on
(`src/lib/customer-notes.ts`). Anyone at the desk can write, change or clear
it; each change is in the activity log, and the note says who last wrote it.

A note is personal data, so staff are told as they write it to keep it
factual: it goes out with what the venue holds against the number and with
the customer's own data when they ask for it, and it is erased with their
account, by the number on the account and the one they proved.

## Waivers

A climbing wall, a gym floor, kayaks on a lake, or any court that wants one:
*Venues & staff → Waiver* holds the venue's words (`src/lib/waivers.ts`). With
a waiver in force, the booking form and the class enrolment form show *I have
read and agree to the venue's waiver*, with the waiver a click away at
`/venue/{id}/waiver`, and a booking or enrolment is refused until it is ticked.
What is kept is the agreement: which version, by which number (however it is
typed), in whose name, on which booking, and when. A number is asked once,
until the venue changes the words: new words are a new version that everybody
agrees to afresh, and the editor says how many have agreed to the one in
force. The box is shown to everyone, since whether a number has agreed is not
something to tell a stranger.

The day's bookings flag anybody who has not agreed (a walk-in booked at the
desk, say) with *No waiver yet: signed on paper?*, which records a paper
signature in the name of the member of staff. Managers write the waiver; the
desk records paper ones, which go in the activity log.

A signature is the venue's record of consent, so like the money on a booking
it is kept when a customer erases their account; it goes out with what the
venue holds against the number and with the customer's own data.

## Private hire enquiries

A tournament, a company sports day, a birthday party, a school's sports day:
not a slot on the grid but a conversation, where the date may move, it may
want every court, and the price is the venue's to quote. Every venue page ends
with *Private hire and events*: name, phone, an email if they like, what it is
for, the date if they know it, roughly how many people, and what they have in
mind (`src/lib/enquiries.ts`).

It lands on the *Bookings* tab under *Private hire enquiries*, open ones first,
with buttons to call, WhatsApp or email the person, and to mark it replied,
booked or declined (and by whom). Where the venue gave an address for new
bookings, it is emailed there too. Staff then book the courts themselves,
blocking them or booking them in the customer's name.

A number can send three a day to one venue, the form has a field only scripts
fill in, and the route is rate-limited. An enquiry goes out with what the venue
holds against the number and with the customer's own data, is erased with
their account, and is deleted after a year.
