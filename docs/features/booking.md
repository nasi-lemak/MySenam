# Booking and availability

Authoritative for how courts and shared facilities are booked: booking rules (starts, lengths, buffers, notice), capacity, linked courts, opening hours, blocks and outages, waitlists, moving, cancelling and who may book. How time is stored and protected underneath is the [booking time model](../architecture/booking-time-model.md).
Status: [feature status](../product/feature-status.md#booking-and-availability).

## Activities

What a court (any bookable resource: a court, pitch, lane, bay, wall, studio
or fleet) is booked for comes from the activity catalogue, not the code:
racket and team sports, the pool, the water, fitness, studio classes and
specialist activities, and any an operator adds ([activities](activities.md)).
A court can offer several activities, one booking at a time; each booking
records which one it is for, and that activity's rates and rules apply.
Customers are offered only the activities somebody on the site (or the
storefront) has a court for, most-offered first (`GET /api/sports`).

**Padel** is played in 90-minute games, so unless a venue says otherwise it
starts on any half hour, runs in half hours and offers 90 minutes first
([booking rules](#booking-rules-starts-lengths-buffers)); badminton beside it
still starts on the hour. Search asks for 90 minutes when padel is picked. A
**football** pitch that is also two smaller pitches is a set of
[linked courts](#courts-that-share-a-floor).

## Exclusive courts vs shared facilities

Every bookable resource carries a `capacity`:

| Capacity | Behaves like | Example |
| -------- | ------------ | ------- |
| 1 | Exclusive use — one booking at a time | Badminton court |
| > 1 | Shared — that many people at the same moment | Gym floor, lap pool, class |

A booking of an exclusive court claims its space for exactly its minutes; a
booking of a shared facility claims as many places as it says it takes
(three climbers, four kayaks), up to the most one booking may take, priced
as the venue chose ([per place, flat or by quantity](activities.md#pricing-a-booking-with-places)).
A room run as **classes only** is not on the grid or in search: customers
book its [classes](programmes.md), and the venue's own staff can still hire
the room. The
database refuses an overlapping claim on a space, and a claim that would put
a facility over its capacity at any moment, partly blocked places,
waiting-list offers and slots held for an [approval application](activities.md#registering-online-for-approval)
included, whatever path wrote it
([booking time model](../architecture/booking-time-model.md#claims);
guarantees in [booking concurrency](../architecture/booking-concurrency.md)).
A refused claim is "just taken" to the customer.

Capacity cannot be reduced below the places already booked at any upcoming
moment, so shrinking a gym never strands a customer.

For a customer this is the forward-looking crowd signal: a shared facility shows
**places left** rather than a price in each cell, shaded from quiet through
filling to busy, so you can see that Monday 7pm is always packed.

## Courts that share a floor

A multi-purpose hall is often sold more than one way: one futsal pitch, or
four badminton courts on the same floor. Under *Courts → Courts that share a
floor* (`src/lib/court-links.ts`), a manager says which courts the bigger one
takes. Then:

- Booking the pitch takes all four courts for those hours; booking any one of
  the four takes the pitch. The four do not take each other, and two big
  courts over the same small one (futsal and netball over the same badminton
  courts) take each other through it.
- Customers and staff see the other courts as booked, two big courts over the
  same small one included; the staff grid shows which booking has them.
- A block, a tournament's courts or a court out of service closes the courts
  it shares the floor with too (another big court over the same small one
  included), and a class on one holds the others.
- It holds under races the same way a single court does: the pitch covers
  the spaces of the courts under it as well as its own, and a booking claims
  every space its court covers, so the database refuses the second booking.
  Reports count only the court actually booked.
- Only courts booked whole can be linked, one level deep (a court that takes
  others is not itself part of one), and a linked court cannot start selling
  places. Linking is refused, naming the first date, while both sides are
  already booked at the same time; what is sold from today on takes the new
  court as soon as it is linked, and lets go when unlinked.

A waiting-list offer is held like a booking, on every space its court
covers, so it keeps the linked courts too.

Utilisation counts such a floor once, whether it was sold as the pitch or
as its courts ([reporting](reporting.md)).

## Booking rules: starts, lengths, buffers

Any minute can be stored; what a customer may pick on a court is its
**booking rules** (*Courts & rates → Booking rules*, managers only;
`POST /api/admin/booking-policies`; the settings and their defaults are in
the [booking time model](../architecture/booking-time-model.md#booking-policies)):

- **When bookings start**: every so many minutes from a first start past the
  hour (on the hour; every 15 minutes; every 90 from 08:00), or only at
  listed times (18:00, 19:30, 21:00).
- **How long they run**: from a shortest to a longest in steps (60 to 240 in
  hours; 60 to 120 in 15s), or only listed lengths (60, 90, 120), with a
  length offered first.
- **Buffers**, two kinds, before and after each booking. A **minimum gap**
  (separation) is time kept free between bookings that neighbours share:
  where two meet, the larger is needed, so 10 minutes after one and 10
  before the next leave them 10 apart, and 10 against 25 leaves 25.
  **Setup and cleaning** (operational time) is work that needs the court,
  and adds up: 10 minutes of cleaning after one and 10 of setup before the
  next leave 20. With both, the larger of the setup and cleaning added up
  and the gaps applies. Nobody can book into either, managers included.
  Customers just see the time as taken; the staff schedule shows what each
  booking keeps free and what for. Buffers are not charged; a setup or
  cleanup **fee** is a separate rule, shown to the customer apart from the
  time ([pricing](pricing.md#prices-to-the-minute)). Each booking keeps the
  buffers it was made with when the rules change; the details are in the
  [booking time model](../architecture/booking-time-model.md#buffers-separation-and-operational-time).
- **On a shared facility, what the buffers are for** (*turnover*): each
  place a booking takes, held over its setup, cleaning and gap added together
  (the default, as before), or over the longer of them each side (a kayak
  rinsed for 10 minutes is out until 11:10 while the rest of the fleet stays
  bookable); or the **whole facility**, cleared between sessions: bookings in
  the same session share its places, nobody is let in while it is set up,
  cleaned or kept free, and between sessions the larger gap applies and setup
  and cleaning add up, as on a court. Per place, a gap still adds up with the
  next booking's, since places are not told apart; the
  [booking time model](../architecture/booking-time-model.md#shared-facilities-how-they-are-turned-over)
  says why, and which is exact.
- **Notice**: how long before it starts a booking may be made at the latest.
- **The court's own hours**, weekday by weekday, inside the venue's: the
  venue's, closed, or its own opening and closing time for each day.
- **Sign-off or certification**: whether a customer needs a staff sign-off,
  or a recorded certification, for the activity before booking it; online it
  must be on their own account ([sign-offs](activities.md#sign-offs)), and
  where the venue takes applications online the customer can apply for one
  from its page ([registering online](activities.md#registering-online-for-approval)).

Each rule is inherited where it is not set: one activity's on one court,
else the court's own, else its activity's at the venue, else the venue's,
else the business's for every branch, else the activity's usual rules in the
catalogue, else the platform's (on the hour, an hour to four, an hour first;
padel from any half hour, 90 minutes first). The editor shows what each level sets and what
a court ends up with (*Now: every 15 minutes, 60 to 120 minutes…*). Clearing
a setting goes back to inheriting it. Changing the rules moves nothing
already booked.

**The board** shows each court's day in columns as wide as its rules need
(an hour, a half hour, 15 minutes), cells marked free, partly taken (*½*) or
taken. Tapping a free cell picks the court's earliest start in it and its
first length; tapping a later cell stretches the booking to it, as far as the
rules and the free time allow. The form below has the start and the length
as lists of what is allowed (or a time and a number where there are many),
and asks the server for the price as they change
([`GET /api/quote`](../architecture/http-api.md)), so the price on the
*Book* button is the one charged. The same rules hold for every way in:
booking, any court, several courts, weekly bookings, waiting lists, moving,
rescheduling, the public API.

**Weekly bookings** run up to eight weeks by default; *House rules* can allow
up to 26, for a team's season or a school's term, staff's bookings included.
It is not a fair-use rule, so on its own it does not put house rules on the
venue page. Where the venue limits how far ahead people may book, every week
must still fall in that window. Classes are not held to the booking rules.

### Staff booking outside the rules

A manager can book, move or reschedule outside a court's rules: a 50-minute
lesson on a court sold by the hour, a start at 18:10, a booking with less
notice than customers get. The board's *Book outside this court's rules*
box, and *Change time*, offer any minute and length. The booking is marked
as an exception, and the activity log records who made it and which rules it
went past (*Booked or moved outside a court's booking rules*). Front-desk staff cannot, and nobody
can book over another booking, a block, a class, an outage or a buffer: the
database refuses those whoever asks. It is not a way round the venue's
policies either: those are the same on every path, and a manager goes past
only those the venue lets them, one booking at a time
([manager overrides](#manager-overrides)). Nor does it go past eligibility
for a members' place ([who a venue is for](#who-a-venue-is-for-public-members-only-private)).

## Rules by sport

A venue's cancellation cutoff, late-cancel share and peak hours apply to all
its courts. Where one sport needs its own (tennis cancelled a day ahead while
badminton is two hours; pickleball at peak from 5 PM), *Courts → Rules by
sport* sets it for that sport (`src/lib/sport-rules.ts`). Anything left on
*venue's* follows the venue. A sport's starts and lengths are its
[booking rules](#booking-rules-starts-lengths-buffers) at the venue.

- **Cancellation:** free until the sport's own cutoff; after it, the sport's
  own late-cancel share, or no cancelling online. The booking terms shown
  before booking, `/my-booking` and the venue page say the sport's rule.
- **Peak hours:** the sport's own weekday and weekend windows decide which of
  its courts' two rates each minute costs; the weekend days and holidays stay the
  venue's. Off-peak-only last-minute prices and concessions follow them.

## Booking without naming a court

Courts are chosen cinema-seat style: the grid is a row per court, and tapping a
cell books that court. Courts genuinely differ — a premium court costs more, and
regulars have preferences — so auto-assigning by default would take a real
choice away and make the price column meaningless.

For customers who *don't* mind, an **Any court** row sits above the grid. Each
column shows the cheapest rate among the courts free then (so it reads RM18
when only the premium court is left), and booking it takes the cheapest court
free for the **whole** booking whose rules allow it — nobody is moved
mid-session. The price on the form is that court's price for the whole time,
not the cheapest part of each court added up, and a stretch no single
court is free for cannot be picked.

`createBookingOnAnyCourt()` re-reads the candidate list server-side rather than
trusting the client, orders it by what that booking actually costs (peak-aware, so
the order can differ morning to evening), and walks it: if the cheapest is
taken between choosing and inserting, the next is tried. That is the point of
not naming a court — a race should cost the customer a different court, not the
booking. It stops walking as soon as an error applies to every court equally.

Each attempt goes through the ordinary `createBookingSeries()` path, so the
database's refusal of overlaps, booking rules, trading hours, closures and series
handling are the same code as a named-court booking. When nothing is free the
error says so, rather than reporting the last court's "someone just took it";
structural reasons — venue closed, outside trading hours, no courts of that
sport — are surfaced as themselves.

## Several courts in one booking

A company night or a club session wants three badminton courts at 8 PM, not
three separate bookings. With a court and its hours picked, the booking form
offers *Book more courts at the same time*: the other courts free for every
one of those hours (and that take a booking that long), with what each costs.

- Each court is its own booking with its own code, exactly as if booked one by
  one, so the desk, check-in, cancelling and moving work as ever. They share
  a group code (`bookings.group_code`, `GR-…`).
- All or nothing (`createGroupBooking` in `src/lib/store.ts`): if any court
  cannot be had, none are kept, and the refusal names the court.
- One confirmation lists every court and its code, with a calendar entry for
  each; the venue's new-booking alert names them all. Held for payment, they
  are paid in one bill and confirmed once when it is paid.
- Each court counts against the venue's house rules, as each week of a weekly
  booking does. 2 to 6 courts, at one venue, on one date, without extras or a
  coach (book those on one court).
- A concession and a promo code are put on each court's booking by the same
  rule as on one ([discounts together](pricing.md#discounts-together)); a
  limited code spends a use for each court.
- **Kinds of kit** work the same way: beside a shared resource (single
  kayaks), the form offers the venue's other shared resources free at that
  time (*Add other kinds at the same time*: double kayaks, boards), each with
  how many, up to what one booking may take. Each kind is its own booking at
  its own price; all or none are kept. Whole courts and shared resources are
  not mixed in one. Kinds the venue put under one heading are listed together
  under it and offered first ([activities](activities.md#pricing-a-booking-with-places)),
  in search as on the grid; arriving from a search result for the heading,
  the grid marks it ([discovery](discovery.md#finding-a-court-from-the-front-page)).

## Booking for somebody else

Who takes part is not assumed to be whoever is signed in, booking or paying
([ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md);
`src/lib/participant-bookings.ts`). Every booking path names the people
taking part in the same way, and books them through the same engine
(`createBookingSeries`), with nothing of its own:

- **Who.** A booking names nobody (its customer takes part alone, as every
  booking always has), or a list of participants (`participantIds`), with
  `customerTakesPart` where the customer takes a place alongside them. A
  participant is never re-entered at each booking: they are chosen from the
  people the adult manages (online) or the venue knows (at the counter).
- **Who may name them.** Online, only people the signed-in account acts for
  now (a live relationship, not archived, and not paused for a manager's
  review; anybody else's is refused `GUARD_NOT_FOUND`). At the counter and
  through the venue's API key, only participants the venue knows
  (`participantAtVenue`) with such a guardian on the booking's number: the
  booking is made with, and told to, somebody who acts for them. A number
  typed in never makes anybody a guardian (`PBK_NOT_GUARDIAN`); somebody new
  is recorded first with the guardian's declaration to the member of staff
  ([inductions](venue-operations.md#inductions)). An adult not yet on record
  for a child the venue knows is invited to become a guardian of that same
  child: a code they accept on their own account, then an existing
  guardian's agreement or a manager's exception
  ([another guardian by invitation](venue-operations.md#another-guardian-by-invitation)).
  Until then their request grants nothing: they book for the child neither
  online nor at the counter. A guardian paused for a manager's review, or
  whose relationship ended, books for nobody on any path: online, a booking
  of several courts, the counter and the venue's API key on their number,
  and a waiting-list entry they made is offered to nobody. A guardian the
  venue recorded by name and number acts only through its staff, by a code
  to their number, or takes the relationship over with their own account
  ([guardians without an account](venue-operations.md#guardians-without-an-account)).
- **Places.** Each person takes a place: a parent booking two children on a
  shared facility takes two, and takes a third only when ticked as taking
  part; a court booked whole is one booking whoever plays. The same person
  twice is refused (`PBK_TWICE`); up to 12 people on one booking.
- **Eligibility, each on their own.** Age rules, sign-offs, certifications
  and approvals ([sign-offs](activities.md#sign-offs)), inductions and the
  venue's waiver are checked for each participant, and for the customer only
  when they take part; one child's never covers a sibling or the adult. A
  sign-off that ends before the last day booked does not count. The door
  asks for everybody's ([venue operations](venue-operations.md#resources-nobody-is-standing-next-to)).
- **Money.** The customer (the guardian) pays, is held to pay where the venue
  holds bookings until paid, and is refunded on cancelling, as for any
  booking. A membership prices a booking its holder, or a person it names,
  takes part in, by the scope of its benefit; one person's own pass,
  concession or membership covers their own place
  ([pricing](pricing.md#what-a-benefit-applies-to)). One child can be taken
  off a booking of several, the others staying booked
  ([taking one person off a booking](#taking-one-person-off-a-booking));
  class enrolments are already one each.
- **Several courts.** In a booking of several courts each court has its own
  people (`moreCourts: [{ courtId, participantIds, customerTakesPart }]`): a
  child is on one court of the group at most, and the guardian is not on
  every court because they placed the order. A court nobody is named on is
  the customer's party, a count of places with nobody assigned. On the
  booking page (online, and at the counter) the people ticked are put on
  courts under *Who is on which court?*: one choice each, so nobody is on two
  courts; everybody starts on the court picked first; the customer, where
  they take part, is on one court too; each court says who is on it, or that
  nobody is named and it is booked for the party. A court dropped from the
  booking sends its people back to the first. A shared resource's places
  rise to at least the people put on it (`src/lib/people-per-court.ts`).
- **On record.** Each participant's history says who made the booking for
  them, where and how (online, at the counter, through the API, a class, a
  waiting list); staff bookings for a participant are also in the activity
  log (`booking.for_participant`), and `booking_participants.added_by_*` says
  who put each person on it.
- **Told.** Confirmations, waiting-list offers and enrolments go to the
  customer (the guardian) through their usual channels and name who it is
  for ("Court 1, for Alya"); a participant needs no email or phone of their
  own ([messaging](../integrations/messaging.md)). The customer's own pages
  say it too: each booking on the account page, *My booking* and a place
  claimed from the waiting list (*For Alya*); the staff activity log names a
  counter booking or class enrolment for a participant as such.
- **Never discoverable.** A booking naming a participant is never opened as
  an open game, and participants never appear in matchmaking
  ([open games](matchmaking.md)).

Tests: `tests/participant-bookings.test.ts` (each path, refusals, and races
on Postgres), `tests/participants.test.ts` (the model),
`tests/guardian-contact.test.ts` (a paused or ended guardian on every path),
`tests/components/people-per-court.test.tsx` (people per court on the
booking page) and `tests/people-per-court.test.ts` (what the page sends, as
the route books it, online and at the counter).

## Operating hours and closed days

Hours are a property of the venue, not the platform. Every venue carries an
opening and a closing time to the minute (`open_min` and `close_min`,
08:00 and 23:00 to begin with, up to 04:00 the next morning; a venue is open
at least an hour). Bookings start no earlier and end no later. That pair
(or that weekday's, below) sizes the customer grid, the admin schedule, the
occupancy denominator, and the times accepted by booking, class scheduling,
blocking and waitlist joins; a court's
[booking rules](#booking-rules-starts-lengths-buffers) may narrow it. Cross-venue search clamps the requested window to each
venue's own day, so a 7 AM search only ever returns the venues that are open at
7 AM, and a 2-hour block is only offered if it still finishes by that venue's
close.

Narrowing a venue's day is refused while bookings exist outside the proposed
hours — otherwise a customer would hold time the venue no longer sells. Staff
have to cancel or move those first.

A **closure** shuts one venue for one whole date (`venue_closures`, unique on
venue + date). Closed days read as blocked everywhere: no slot is selectable,
booking, series, class scheduling, enrolment and waitlist joins are all refused
with "The venue is closed that day", the venue disappears from search for that
date, and customers see the reason both as an upcoming-closures banner on the
venue page and on the grid itself. Staff still see the day in the schedule,
marked with the closure reason rather than blank, so bookings taken before the
closure was declared remain visible for them to handle.

### Hours by weekday, and after midnight

A weekday can keep the usual hours, have its own, or be closed every week
(*Venues & staff → the venue → Different hours on some days*;
`venues.week_hours`, migration 0070, `src/lib/week-hours.ts`). A weekday
closed every week is a closure like any other: nothing can be booked, it is
out of search, weekly bookings skip it, and the report counts it as a closed
day. The venue page lists the week (Mon–Thu 4:00 PM – 12:00 AM, Fri 4:00 PM
– 2:00 AM, Sun closed) when the days differ, and search engines get one
opening-hours entry per run of days.

Hours may run **past midnight**, to 4 AM at the latest: a close of 02:00 is
stored as minute 1560 of the day. Those hours belong to the evening they
started on, so a futsal booking from 1 AM on a Friday night is a Friday
booking (minute 1500), on Friday's grid,
priced by Friday's rules (after midnight is off-peak unless the venue's
peak window says otherwise), and its check-in, reminders and "has it
started" are worked out from the real time. A day's late hours may not run
into the next day's own opening, so the same moment is never on two days. The
desk sees a 1 AM booking on the evening's date in the Bookings tab.

Every check that used the venue's one pair of hours now asks for that
date's: the grid, booking, moving a booking, blocks, classes, waiting lists,
coaching times, tournaments and the report's "could have been sold". Changing
the hours, or closing a weekday, is refused while bookings already sold fall
outside them, naming the first such date.

## Courts out of service

Two ways, for two lengths of time:

- **A few hours**: block them on the *Schedule*, with a reason. On a shared
  facility, only some of its places (below).
- **Days, or until further notice**: *Courts & rates → Out of service* — a
  court, a first day, a last day or "until further notice", and a reason,
  which customers see on the venue's page. Nobody can book it, search finds it
  closed, and the reports count it as out. If anything is booked in the
  stretch, it lists those bookings and classes and stops; staff move them, or
  choose to cancel them, which refunds each as a staff cancellation would and
  messages its customer. Classes on a court sharing the floor are listed too.
  The outage is saved in one transaction that finds nothing left in the way: a
  booking made while the others were being cancelled is cancelled in turn (or,
  without *cancel them*, listed). *Back in service today* ends it early.

An outage is one claim on the court for the whole stretch: every minute of
each business day it covers, late hours past midnight included, or with no
end for *until further notice* (`claimOutage` in `src/lib/outages.ts`).
Availability, search, booking, moving a booking, the waitlist, the schedule
and the reports read it with every other claim, so they close the court
without knowing outages exist, and the database refuses a booking into it.

An outage whose last night's late hours are not in its claim (one carried
over from before migration 0090, or one made before its venue came to stay
open past midnight) says so on *Out of service*; *Close those hours too*
claims what of them is free and lists any booking or class there, which it
leaves as it is (`repairLateHours`;
[legacy installs](../archive/migrations/legacy-installs.md#outages-from-before-migration-0090)).

### Rained off

Outdoor courts lose an afternoon at a time to the weather. *Schedule →
🌧️ Rained off?* takes the courts (outdoor ones ticked to start), the hours
and a reason, and first says what it would call off: each booking by code and
name, and how many classes. *Call them off* then cancels every booking and
class on those courts in those hours, refunds each as a staff cancellation
would (the venue's choice, so no late-cancel fee), messages each customer and
keeps them on the desk's *needs attention* list until they have seen it, and
blocks the rest of those hours with the reason so nobody books them
meanwhile (`rainOut` in `src/lib/rain-outs.ts`). A booking already under
way is called off too; one that has finished is left alone. Bookings on a
linked court that hold the chosen court's hours are found as well. Front-desk
staff can do it; it is in the activity log.

Each customer's message gives the reason, on the line above what is owed
(*Reason: Rained off*). The panel fills in a built-in reason in the staff
member's language; left as it is, it is sent as a key (`reasonPreset`) and
each customer reads it in their own language, the language their booking was
made in. Anything staff type instead goes to everybody as typed. The blocks
carry what the panel showed, for the schedule. On WhatsApp the reason travels
in the same parameter as what is owed, so the approved template is unchanged
([WhatsApp templates](../integrations/whatsapp-templates.md)).

### Every week

A school's PE lessons on Tuesday mornings, cleaning on Monday evenings, the
club's own night: *Schedule → 🔁 Block every week* takes the courts, the days
of the week, the hours, how many weeks (up to 52, from the day on the
schedule) and what it is for, which customers see on the blocked hours
(`repeatBlock` in `src/lib/repeat-blocks.ts`). Each week is an ordinary block,
so availability, search and booking treat it like any other, and a single
week can still be released on the schedule. Hours already booked stay booked,
and are listed for the desk to move or let be. The same panel lists each run
with weeks still to come and *End it* frees the rest from today. The desk can
do it; it is in the activity log.

## Taking some of a shared facility out of service

A court is blocked whole — blocking it *is* taking the unit out, because a
court is capacity 1. Equipment is where that breaks down: one kayak of six
with a cracked hull should not cost you the other five, and dropping `capacity`
to 5 would apply to every date rather than just the week it is being repaired.

A block (`blocks`, any minutes) therefore carries `places`. `NULL` is the
whole resource, which is the only thing a court can mean. A number takes that
many places out and leaves the rest bookable, so the time reads `1/5` rather
than closed: its claim holds those places, and the capacity check counts them
with the bookings, so availability, cross-venue search, "any court", booking,
moving a booking, the waitlist and the staff schedule all see the same
places left. A partial block only closes the time once it has taken the last
place, and only then does queuing become possible.

Staff cannot take out more places than are free, since that would strand a
booking; the refusal names how many remain. A block over time that is partly
booked covers the rest of it, and one made at the moment a booking lands is
worked out again around it. Re-blocking time revises it rather than
duplicating it. The occupancy grid and the reports count every place a block
takes out, whole or partial, off what could have been sold for its time
([reporting](reporting.md#reporting)).

## The same policies on every path

Customer, counter and API bookings are held to the same venue policies (the
owner's decision of 28 October 2026;
[ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md)):
using the counter or an API key does not get round them. One check asks them
all, in one order (`policyCheck()` in `src/lib/limits.ts`): the booking form,
the counter (a staff session on the same routes: court time, several courts,
a lesson, a class place or a term), the venue's API key
(`POST /api/v1/bookings`), and a waiting list (joining it, the offer and its
claim, [below](#waitlists)).

| Policy | Online | At the counter | Through the API key |
| ------ | ------ | -------------- | ------------------- |
| The venue open to customers | Refused (`VENUE_NOT_OPEN`) | Its own staff may try a venue customers cannot reach yet | Refused |
| Who a venue is for (members only, private) | The account ([below](#who-a-venue-is-for-public-members-only-private)) | The number booked, on staff's word, or each person named where only they take places; a member's or resident's guest by their host ([below](#members-and-residents-guests-at-the-counter-and-through-the-api)) | As the counter |
| A member's or resident's guest allowance | The resident's own invitations (`GUEST_LIMIT`, [below](#residents-inviting-their-own-guests)) | Counted against the host's allowance; a manager may override | Counted against the host's allowance; refused |
| House rules: how far ahead | Refused (`LIMIT_AHEAD`, `LIMIT_AHEAD_MEMBERS`) | Refused; a member's number on staff's word has the members' window | Refused |
| House rules: bookings at once, a week, a day | Refused (`LIMIT_UPCOMING`, `LIMIT_WEEK`, `LIMIT_DAY`) | Refused; a manager may override | Refused |
| A weekly booking needs an account | Refused (`SERIES_NEEDS_ACCOUNT`) | Refused; a manager may book it as assisted | One booking at a time |
| The limit on online bookings without an account (`GUEST_SURGE_PER_HOUR` unpaid ones made online or through the API in the hour) | Held until paid where the venue takes payment online; refused where it does not | Paid as it is booked, or refused; a manager may override | Refused |
| A blocked number | Refused (`PHONE_BLOCKED`) | Refused, never overridden | Refused |
| No-show strikes | Held until paid online; refused where nothing is taken online | Paid as it is booked, or refused; a manager may override | Refused |
| Unpaid bookings coming up (3 here, 6 anywhere) | Refused | Refused, never overridden, paid as it is booked or not | Refused |
| The venue's waiver | Ticked by the customer | Ticked by staff for the customer | Already on record, the customer's and each person's named |

The booking engine then asks the rest the same on every path: the court's
booking rules, sign-offs, a members' place each person's own, a women-only or
men-only class, capacity, availability and linked resources (the database).

**Said for each path.** Online a refusal is said as the customer is told. At
the counter it has a code of its own (`R9_DESK_…`, in the customer languages,
so the staff screens say it in theirs) saying what staff can do: take payment
now, take payment for (or cancel) one already booked, review the blocked
number, sell a membership or add the person to the list, or ask a manager to
override it where the venue allows. Through the API it keeps the code the form
gets, with words for a venue's system (`saidOn()`).

**The limit on online bookings without an account** (once called the guest
limit: "guest" there means booking without an account, never a member's
guest) is a brake on a venue's evening being filled from a script. It counts
unpaid bookings without an account made online or through the venue's API key
in the last hour (`guestSurge()`; each booking records the path it was made
on, `made_on`). The counter's own bookings, an ordinary walk-in customer or a
member's guest, are made by staff in front of the person and are not counted,
so a busy counter hour no longer trips it; it is still asked at the counter
when the venue is being flooded online (`tests/guest-counting.test.ts`).

**Paid as it is booked.** Where online a booking would be held until paid
(no-show strikes, the limit on online bookings without an account), the counter takes payment as it books:
the form offers *Take payment now* and how it was paid (`paidAtCounter`:
cash, QR, transfer, card), and the booking (or class place) is marked paid
then, on the record as any counter payment is (`payment.paid`). Never
silently: without it, the counter is refused. Only staff send it
(`R9_PAY_NOW_STAFF` otherwise). The API key takes no money, so it is refused
there.

### Manager overrides

A venue may let its managers, and only its managers, go past some
operational restrictions for one booking at the counter (*Venues & staff →
Manager overrides*; `src/lib/policy-overrides.ts`, migrations 0208–0209).
Every one is off until a manager turns it on; turning one on or off is a
manager's (`POST /api/admin/policy-overrides`) and is in the activity log
(*Changed settings*).

| Policy | What it lets through |
| ------ | -------------------- |
| House rules | Bookings at once, a week, a day (`LIMIT_UPCOMING`, `LIMIT_WEEK`, `LIMIT_DAY`); not how far ahead |
| No-show strikes | `STRIKES_COUNTER`: booked unpaid, not held |
| Online bookings without an account | `GUEST_SURGE` |
| Assisted booking | A weekly booking for a customer without an account (`SERIES_NEEDS_ACCOUNT`); everybody on it still eligible |
| A member's or resident's guest allowance | `GC8_GUEST_ALLOWANCE`, `GC8_GUESTS_OFF`, `GC8_GUEST_DAYS`, for a guest registered at the counter ([below](#members-and-residents-guests-at-the-counter-and-through-the-api)); never the host's eligibility |

- Refused with one of these at the counter, the form says what can be done: a
  manager at a venue that permits it gets *Override for this booking* with a
  reason; front desk sees *Ask a manager*.
- The request names the policies (`overridePolicies`) and gives a reason
  (`overrideReason`, 5–300 characters). The server checks again: each is one
  of these five (`R9_OVERRIDE_NOT_OVERRIDABLE`, 400), the venue permits it
  (`R9_OVERRIDE_NOT_PERMITTED`, 403), the member of staff is a manager of
  that venue (`R9_OVERRIDE_MANAGERS`, 403, for front desk and for anybody
  without a staff session), and the reason is given (`R9_OVERRIDE_REASON`,
  400). Only the refusals a policy answers for are let through; anything else
  still refuses.
- **Recorded with each booking it let through**, in the booking's own
  transaction, only for what was actually refused
  (`booking_policy_overrides`: venue, booking, policy and refusal code,
  reason, the manager by id and by name, when), and in the activity log
  (*Overrode a venue policy for one booking*, `booking.policy_overridden`).
  The staff Bookings list shows it on the booking (*Overridden by …: … Why:
  …*). A booking that cannot be made (the time taken) keeps nothing. The
  bookings export does not carry overrides; the activity log does.
- **Front desk never overrides, and neither does an API key**: any override
  field, or `paidAtCounter`, sent with a key is refused
  (`R9_API_NO_OVERRIDE`, 400), never ignored, for a booking and a waiting-list
  entry alike.
- **Never overridable**, whatever the venue allows:
  - a blocked number: taking it off *Blocked numbers* is the workflow, a
    manager's, and asks why (kept in the activity log as `phone.unblocked`;
    blocking is `phone.blocked`);
  - the unpaid-bookings limit: take payment for one of them, or cancel one;
  - eligibility: a members-only or private venue, and a members' place (sell
    the membership, or add the person to the list); the court's-rules
    override above does not go past it either;
  - the venue being open, and the booking window;
  - the waiver, and sign-offs where a door opens without staff: a manager may
    book past a missing sign-off as before, but the door code waits for the
    person's own;
  - capacity, availability and linked resources (the database's), tenant
    isolation, and payment.

## Waitlists

A full class *or taken court time* can still be joined — as a queue. A court
entry keeps the start and length wanted, within the court's booking rules.
When that whole time frees up (a booking or enrolment cancelled, or someone
ahead dropping out), it is **offered to whoever has waited longest**, with a
secret token and a 30-minute hold. Only one offer is ever live per class, and
per resource per day, so two cancellations do not hand the same place to two
people.

Queuing is only offered where a cancellation could actually free the time. A
blocked, class-reserved or past time is not queueable, and the booking grid
only turns those cells into a waitlist button when they are genuinely just
taken.

A live offer **holds the place**: it is a claim on the court that lapses with
the offer, so the grid shows it taken and nobody can book it directly for
those 30 minutes, so the person offered it does not tap the
link to find it gone. Stale offers are expired whenever the waitlist is read or
written, and by the scheduler every few minutes (`passOnExpiredOffers()`),
which offers each freed place to the next person in the queue, so a place
nobody claims does not sit empty until somebody happens to look.

Joining the queue goes through the same checks as booking
([the same policies on every path](#the-same-policies-on-every-path)): a
refused number, a members-only venue, the house rules and the unpaid-bookings
limit all apply, so a queue is not a way round them. The place is claimed
later through the offer's link, so it is paid as a claim is: no-show strikes
and the limit on online bookings without an account refuse only where claimed court time could not be held
until paid online. A class's queue asks exactly what enrolling asks: the house
rules for the session's date, and strikes refused online (an enrolment is
never held until paid).

When a place is offered and again when it is claimed, the entry is asked
what the booking the claim makes would be asked on the path the entry was
made: online, at the counter or through the API (`entryRefused()` in
`src/lib/store.ts`, through `mayBookOn()` in `src/lib/limits.ts`, the one
policy check every booking path asks), paid as the claim is. So a place freed
weeks after somebody joined goes only to somebody who could book it now:

- **A number the venue refuses now** (refused after it joined): the entry is
  passed over at the offer and leaves the queue, and the place goes to the
  next; an offer already out cannot be claimed (`PHONE_BLOCKED`), nothing is
  booked, the entry leaves and the place passes on. Lifting the refusal later
  does not bring the entry back. Nothing more is sent to the number: refusing
  it takes any offer message to it still waiting in the outbox back out
  (marked given up, *the venue refused this number after the offer was
  made*), and an offer whose message had not yet been written gets none. A
  message already sent stays sent; its link is then refused as above.
- **The venue not open to customers** (a draft, or unlisted): nobody is
  offered a place while it is so, and a live offer cannot be claimed
  (`VENUE_NOT_OPEN`); that entry goes back to waiting in its place, its hold
  let go. Nobody loses their place; a place freed while the venue was closed
  is offered when the next one frees, or bookable directly once it is open.
- **For an entry made online, the venue's access no longer admitting the
  account** (members only, a private list; as at the join, a parent queuing
  only their member children at a members-only venue need not be a member):
  the entry is passed over at the offer and keeps its place, as one whose
  sign-off lapsed does; at the claim it is refused (`MEMBERS_ONLY`,
  `PRIVATE_VENUE`), goes back to waiting and the place passes on. For an
  entry the counter or the API made, the person queued is asked instead, as
  their bookings are: the number, or each person named where only they take
  places (`R9_NOT_MEMBER`, `R9_NOT_LISTED`, `ENT_MEMBERS_PLACE`).
- **The house rules** (bookings coming up at once, a day, a week; how far
  ahead, the members' longer window among them), counted as they stand then,
  the claim's own booking among them, for court time and a class place alike,
  as booking and enrolling ask them; **the unpaid-bookings limit**; and
  **no-show strikes** and **the limit on online bookings without an account** where the venue takes nothing
  online, or for a class place (otherwise the claimed court time is held until
  paid, as any booking from a struck-out number is): passed over at the offer
  keeping its place, and at the claim refused with the booking's own reason
  (`LIMIT_UPCOMING`, `LIMIT_DAY`, `LIMIT_AHEAD_MEMBERS`, `PHONE_LIMIT_VENUE`,
  `STRIKES_COUNTER`…), back to waiting and the place passed on. Asked of an
  entry the counter or the API made as their bookings are asked them.
- **A members' place nobody on the entry is covered for on its date** (each
  person named, and the customer where they take a place; however the entry
  was made): a membership that has since been cancelled or ends before the
  session. The entry is passed over at the offer and keeps its place, to
  renew; at the claim it is refused with the reason (`MV6_ENDS_BEFORE`,
  `ENT_MEMBERS_PLACE`, `MV6_OWN_*`), goes back to waiting and the place
  passes on ([membership validity](pricing.md#membership-validity)).

The members' longer booking window is asked at the join and again at the
claim: a membership that ended or was cancelled since leaves the claim
refused (`LIMIT_AHEAD_MEMBERS`) and the entry waiting. **The venue's waiver is
asked at the claim**, where the booking is made, for the version in force
then and for each person taking a place, by the customer claiming through the
link whoever made the entry; not yet agreed, the claim is refused
(`WAIVER_NEEDED`) and the offer stands, its hold kept, while the claim page
shows the box to tick and claim again. It is not asked at the join, so a
waiver changed while somebody waits is agreed once, as it stands. The booking
the claim makes is then held until paid where the venue asks that, as any
booking is.

Claiming is deliberately a tap rather than automatic on page load, because
unlike check-in it creates a booking that costs money. Claiming enrols the
holder at the class price (or makes an ordinary booking for the court time,
through the same path as any booking, closures and limits included) and
closes their queue entry; the token is then spent. A venue that holds
bookings until they are paid holds a claimed one the same way, and the
confirmation goes out like any other booking's.

If the place is gone anyway (staff booked over it, or blocked the court), the
claim fails and the waiter is put **back at the front of the queue** rather
than losing their turn.

**For somebody else.** A signed-in adult can queue for people they manage
([booking for somebody else](#booking-for-somebody-else)), with or without
themself. The entry keeps who and how many (`waitlist.places`,
`waitlist_participants`, migration 0146), and waits for a place for each: an
entry for two children is offered two places, held together, never one. A
class place, like court time, goes to the longest waiter it fits; an entry
too big for what came free waits. Before an offer is made the entry is
checked again: every participant's record still there and the account still
acting for each (otherwise the entry leaves the queue and the place goes to
the next), and, where the activity needs one, each person's sign-off still in
force (otherwise it waits). Claiming books exactly those people, each checked
again as any booking is, at the price and payment terms that apply then; the
customer is never booked in a child's place. The same child, or the adult
taking part themself, cannot queue twice for the same thing; siblings on one
number can. The offer goes to the account holder, naming who it is for.

### At the counter and through the API

Somebody who rings or walks up can be queued by the venue, not only online,
so the counter and the venue's own system offer what its page does
(`src/lib/waitlist-venue.ts`; `POST /api/admin/waitlist`, `POST
/api/v1/waitlist` with a write key; migration 0180). The front desk and
managers do it at a venue they work at: on the staff schedule a taken cell
opens *Add to the waiting list* for that court and time (the times can be
adjusted to the court's rules), and a full class's roster has the same
button (`src/components/admin/WaitlistJoin.tsx`).

- **On the venue's word**, as a counter booking: the name, number and email
  are what staff (or the venue's system) give; nobody signs in. People other
  than the caller are only participants the venue knows with a live guardian
  on that number, ticked as for a counter booking
  ([booking for somebody else](#booking-for-somebody-else)); a key also needs
  the guardian's agreement to the waiver already on record, as for a booking
  through the API.
- **The same rules as online**: a refused number, the venue not open, the
  house rules and the unpaid-bookings limit, and who may book a members-only
  or private venue (as the counter asks them: the number, or each person
  named where only they take places; each participant's own membership for a
  members' place), the court's
  booking rules, a women-only or men-only class said for by staff, the time
  genuinely taken, and nobody queued twice whoever queued them (an entry made
  at the counter and the same number online are the same person).
- **Checked and booked the way it was made**: sign-offs on the entry's number,
  as the counter checks them; at the offer and again at the claim, each
  participant still one the venue knows with a guardian on that number
  (otherwise the entry leaves the queue and the place goes to the next), and
  what the counter (or the API) would ask of the booking, as for any entry
  ([above](#waitlists)). The
  booking claimed from it is made as the counter (or the API) would make it,
  with the member of staff on record as having put each participant on it.
- **Told as usual, in the caller's language**: the offer goes to that number
  and email by the usual messages, in the language kept on the entry, and is
  claimed by its link; the customer sees the entry on their number, and can
  leave it. The counter form asks the caller's language among the customer
  languages the install offers (English, Bahasa Malaysia, Chinese, Tamil in
  Malaysia), starting from the one this member of staff reads the site in
  (the language switch) where the install offers it, else English; the
  day's queues show each entry's language. Through the API it is `locale`
  (English if not given).
- **Seen and taken off by staff**: the day's queues under the schedule, and a
  class's on its roster, say who made each entry (online, at the counter and
  by whom, through the API). Staff take off an entry the venue made; one the
  customer made online is theirs to leave. Taking off a live offer passes it
  to the next in line. Taking an entry off **sends the caller nothing**: the
  venue takes it off because they asked it to (the confirmation staff see
  says so), and an offer already sent stops working (its link says the offer
  is no longer valid). Each join and removal is in the staff activity log
  (`waitlist.added`, `waitlist.removed`).

## Moving a booking

A net breaks, a court floods, a league wants to be side by side — the booking
has to change court without changing anything else. Without this the only
option is cancel-and-rebook, which issues a new code the customer does not
have, drops the payment record, and un-checks-in anyone already inside.

`moveBooking(code, courtId)` re-points the booking and moves its claims in one
transaction, so a move either happens completely or not at all — a target
that is free for three of its four hours leaves the booking exactly where it
was. The target's own buffers apply; the database is still the real guard,
and a racing booking fails rather than double-selling.

A move is refused across venues, onto a court not offering the booked activity, onto the court it is already
on, onto blocked time or time a class owns, and for a booking that is
cancelled or already finished. A class enrolment cannot be moved on its own —
it belongs to the class.

**The price does not change.** A move is the venue's convenience, not the
customer's, so it never costs them more — and they do not gain from being put
on a cheaper court either. The code, payment status, pass or credit charge, and
any check-in all survive untouched, and the court they left is immediately
offered to anyone waiting on it.

Staff pick from a list of courts that are genuinely free for the whole booking
(`moveTargetsFor`), so the refusals above are mostly unreachable from the UI —
they exist because the API is reachable without it.

### Changing the date or time

`rescheduleBooking(code, { date, start, courtId?, override? }, by)` moves a
booking to another day or time — the same length, at the same venue, for the
same activity — keeping its code, its payment, its extras and any promo. It is
the step that otherwise means cancel, refund and book again, with the risk
the time goes while the customer rebooks.

- **Customers** change their own from `/my-booking` (*Change date or time*),
  with the code and phone number, up to the venue's cancellation cutoff and
  within the booking window, to a start and length the target court's
  booking rules allow: a 60-minute booking cannot be moved onto a court that
  sells 90 minutes at least. Inside the cutoff no time is offered: the
  panel says why and to call the venue.
  **Staff** use *Change time* on any booking in the Bookings tab, at any
  time before it has finished; a manager may also choose any minute, outside
  the rules ([staff booking outside the rules](#staff-booking-outside-the-rules)).
- Only times free for the whole length are offered (`rescheduleOptions`), its
  own court first, then another court offering the same activity. The booking's own
  time counts as free, so it can slide by a few minutes.
- **The price follows the court time.** Unpaid, it is repriced at the new
  time's rate, up or down, by the same pricing as a new booking. Paid, it keeps what was paid: a customer cannot move
  it somewhere dearer (that would be peak hours at an off-peak price), and
  staff who do have chosen not to charge the difference. Its concessions and
  promo code stay as they were given, the same amounts, and are not asked
  about again ([discounts together](pricing.md#discounts-together)).
- A lesson moves with its coach, to a time the coach takes lessons and is
  free, or (staff) to another of the venue's coaches while nothing is paid
  ([moving a lesson](programmes.md#moving-a-lesson)).
- Refused for a class place (it moves with its class), a checked-in
  booking, or kit still out; and, for a customer, a
  booking friends have already paid shares of in a split (the venue can move
  it). A booking under an open game with players in it moves only through
  the game, as its host's proposal the players answer or a manager's change
  with a reason ([moving a game](matchmaking.md#moving-a-game-to-another-time));
  a called-off game does not stop its booking moving.
- The booking is re-read and locked as it moves: one moved by somebody else
  in the meantime is refused (`RESCHEDULE_CHANGED`) rather than moved from a
  time it no longer has.
- The customer is told. Changed by the venue, it is urgent news with an
  acknowledge link (`mysenam_booking_rescheduled` on WhatsApp, in the venue's
  *Needs attention* panel until they see it). Changed by the customer, it is an
  email with the new calendar invite. The time it left goes to whoever is
  waiting for it.

## Cancellation and no-shows

Each venue carries a `cancel_cutoff_hours` (default 2, max 72). Customer-facing
cancellation — by code, from an account, or for a whole series — is refused
inside that window with a message naming the cutoff, while
`/api/admin/bookings/cancel` always succeeds so the front desk can make
exceptions.

**Cancelling a weekly series** shows each upcoming week and what cancelling it
would do before anything is done: inside the free window, all of it back;
past it, where the venue allows late cancels, the venue's share kept and the
rest back (or a late cancel counted where nothing was paid); past it where the
venue does not, or with kit still out on hire, the week stays booked, with
what is still owed. The customer picks the weeks, and each goes on its own
terms, all in one transaction. A late week is cancelled only when the
customer accepted the late terms they were shown; if a week's terms changed
since (it crossed the cutoff, or the venue changed its policy), nothing is
cancelled and they are asked to look again (`SERIES_CHANGED`). Asked without a
choice (an older client), only the weeks free to cancel go, and the weeks left
are returned by name (`tests/series-cancel.test.ts`).

After a slot has passed, staff can flag it a no-show from the Bookings tab. The
flag is reversible, never applies to a cancelled booking, and the day list shows
a ⚠ badge counting that phone number's previous no-shows. Where a booking
names the people taking part, staff can also say who of them came
([check-in](venue-operations.md#check-in-and-live-crowd-levels)); the booking is then a no-show
only when everybody it names was one.

### Late cancellations and strikes

A manager can soften or harden that, venue by venue, under *Cancellations,
refunds and no-shows* on the Venues tab (`lib/cancel-policy.ts`):

- **Cancelling late online.** Off by default: past the cutoff a customer has to
  call. Turned on, a customer can still cancel online until the slot starts, and
  the venue keeps a percentage of what was paid (0–100). The rest goes back the
  way it was paid: to stored credit, to a pass (whole entries, rounded down), or
  as an amount owed back on the online payment. A credit note covers the share
  given back. My Booking and the account page say what the venue keeps before
  the customer confirms, and how much it kept afterwards.
- **Strikes.** A no-show, or a late cancellation of a booking nobody had paid
  for, is a strike against the phone number at that venue. A paid late
  cancellation is not: its fee was its cost. After the venue's limit (1–20) in
  its window (7–365 days, default 90), the number has to pay online to book.
  Its bookings are held unpaid as with *Paying online to hold a booking*, even
  where the venue does not ask that of everyone. Where the venue takes nothing
  online, it is told to book at the counter instead. At the counter it is
  paid as it is booked, or a manager overrides it where the venue allows; the
  venue's API key is refused
  ([the same policies on every path](#the-same-policies-on-every-path)).


### Taking one person off a booking

A guardian can withdraw one child without cancelling the others; a customer
can stop taking part themself while the people they booked for still go; a
group can give up a place nobody is named on
([ADR 0025](../architecture/decisions/0025-benefits-and-privileges-by-scope.md);
`lib/place-withdrawals.ts`). *Take somebody off* on `/my-booking` and on each
booking on the account page lists who is on it, what taking each off would
do to the money, or why it cannot be done; staff do it from the day's
bookings (✕ beside a name, *−1 place*), with a reason if they give one.

- **Where the activity allows it.** A booking rule, *One person taken off a
  booking* (`separatePlaces`, inherited like the others), is yes unless the
  venue sells the places together; then nobody can be taken off on their own
  (`ENT_WITHDRAW_SOLD_WHOLE`).
- **What it does depends on what was booked.**
  - A place on a shared session (a pool, a gym floor, kayaks): the place is
    released (the booking holds one fewer) and offered to whoever has waited
    longest for it.
  - A place priced by the place (each place on a facility not priced flat,
    each player on a court priced per player): that place's share of the
    court time as charged comes off ([pricing](pricing.md#what-a-benefit-applies-to)).
    Not yet paid, it comes off what is owed. Paid, it goes back the way it was
    paid on the venue's cancellation terms (a late withdrawal keeps the
    venue's share, as a late cancellation does), with a credit note of its own
    ([refunds for one person's place](payments-and-credit.md#refunds-for-one-persons-place)).
    The person's own concession or member's price goes with their place, and
    so does exactly their recorded share of a promo code
    ([discounts together](pricing.md#discounts-together)); a pass spent for
    their place gives back its entries, and benefits for the whole booking
    stay with it.
  - A court or room hired whole: the person is no longer named on it. The
    court stays booked and paid as it was, and nothing is refunded: there is
    nothing priced per person.
  - Places nobody is named on (a group of four becoming three): as a place
    above, one at a time.
- **Whoever paid what.** The place's price comes off the booker's own part
  first, then a deposit's:
  - *Held by a deposit paid online*: it comes off what the booking costs,
    off the balance still owed first; only what was paid beyond the new
    total goes back, to the deposit's payment, on the venue's cancellation
    terms, with a credit note on the deposit's receipt. A booking paid in
    full after its deposit settles the place from the part paid last (the
    rest, the way it was paid) and then from the deposit. A later
    cancellation gives back only the deposit left
    ([refunds for one person's place](payments-and-credit.md#refunds-for-one-persons-place)).
  - *Charged to a company or school account*: before the month's invoice is
    issued, the place's price comes off the booking's charge; after, the
    invoice stays as issued and the place's price (on the venue's
    cancellation terms) is a credit note on the account, taken off its next
    invoice ([company and school accounts](payments-and-credit.md#company-and-school-accounts)).
  - *Split with friends* ([splitting the cost](payments-and-credit.md#splitting-the-cost-with-friends)):
    while no friend has paid a share, the place comes off and each share is
    worked out again on the new price, as changing the number of ways is.
- **Refused, with the reason, and why.** These are deliberate, and the same
  for the customer and the counter:
  - the last person on a booking: that is cancelling it;
  - a lesson: booked as one product with the coach's fee, not by the head;
  - a class place: each is already its own enrolment, so cancelling it is
    the withdrawal;
  - an open game: its players leave the game, whose shares are the game's;
  - a booking other players paid shares of (a split share paid, or a game's):
    each share was worked out from the whole price and paid to the venue by
    somebody who holds no place of their own, so no one person's part can
    be told apart (`ENT_WITHDRAW_SHARED`); the booking can be cancelled, or
    the venue settles it by hand;
  - part of it paid online that is no deposit of the booker's (a share handed
    back, a disputed payment), for the same reason (`ENT_WITHDRAW_DEPOSIT`);
  - a payment page open, the booking's or a friend's share: the amount on
    it was fixed from the price when it was opened;
  - kit still out: as for cancelling, the hire is settled first;
  - somebody already marked at the door: their place was used and stays on
    the record;
  - past the venue's cutoff, as for cancelling;
  - a court or room hired whole is never refused, but nothing comes off: it
    was sold whole, not by the person.
- **Staff at the counter** may take somebody off until the booking has
  been played, in full, as a staff cancellation is; it is in the activity log
  (*Took one person off a booking*) with the reason.
- **The venue's API key** does what its counter does, through the same
  code (`GET`/`POST /api/v1/bookings/<code>/withdraw`;
  [external API](../integrations/external-api.md)): the counter's terms, the
  same refusals and the same money, the customer told, recorded and logged
  as the key (`API key <id>`), for its own venue's bookings only. A request
  may carry an `Idempotency-Key`, so one sent again takes nobody else off.
- **On record and told.** `place_withdrawals` keeps who it was, what their
  place cost, what went back and how, what was kept, the pass entries
  returned, who did it and why; the participant's history says so; the
  person's row leaves the booking, so the door, the roster and every check
  no longer count them. The customer is told by email, naming who is off and
  what happened to the money. Two withdrawals at once, or one racing the
  booking's cancellation, the last place or the account's invoice being
  issued, are settled under the booking's lock: the money goes back once,
  the place comes off the charge before the invoice or is a credit note
  after (never both), and never more places are held than there are.

Tests: `tests/place-withdrawals.test.ts` (each case, the money each way it
is paid, refusals, and races on Postgres),
`tests/place-withdrawals-money.test.ts` (a deposit under- and over-paid,
late, and paid in full after it; an account before and after its invoice; a
split; races with a second withdrawal, the cancellation and the invoice, on
Postgres), `tests/components/withdraw-people.test.tsx` (the customer's
screen) and `tests/api-withdrawals.test.ts` (the venue's API key: the
counter's options and money, refusals, another venue's key, the same
request sent again, at once on Postgres).

### Telling customers before they book

Every booking form, and the lesson form, has a **Before you book** box
(`lib/booking-terms.ts`, `components/BookingTermsNotice.tsx`). It says when
cancelling is free, what a late cancellation costs or that it means calling
the venue, and that a no-show counts against the number. Where the venue
counts strikes, it says what happens after the limit (pay online, or book at
the counter). Where bookings are held until paid, it says how many minutes
there are to pay.

- **Don't show again for this venue** puts it away, for the account where
  someone is signed in (`terms_dismissals`) and in the browser for a guest. It
  is filed under a digest of the rules, so when the venue changes them it
  shows again. *Booking rules at this venue* reopens it.
- **A signed-in customer's own strikes are always shown**, whether the box is
  put away or not: *You have 2 of 3 so far here*, or in red once they have
  reached the limit. A guest's are not, since a typed phone number is not
  proof of whose it is.
- **Staff see each number's strikes** on the day's bookings (*2/3 strikes*, red
  once at the limit). Clicking it **forgives** them: only no-shows and late
  cancellations on bookings after today count again (`strike_forgiveness`,
  managers only, in the activity log).
- Cancelling an unpaid booking late, where strikes are counted, asks first:
  *this counts as a late cancellation against your number*. Staff marking a
  no-show are reminded it counts against the customer too.
- The gift voucher form says it is good for 12 months, cannot be exchanged for
  cash, and is refunded only if the venue cancels it. The lesson form says the
  venue's cancellation rules cover the whole lesson, the coach's fee included.

## Who a venue is for: public, members only, private

Each venue chooses under *Venues & staff → Who it is for* (`src/lib/access.ts`):

| Mode | Found in search and lists | Who can book | For example |
| ---- | ------------------------- | ------------ | ----------- |
| **Public** (default) | Yes | Anybody | A commercial badminton centre or futsal hall |
| **Members only** | Yes, unless the venue turns that off | Signed-in customers with an active membership here, or on the venue's list | A private club taking new members |
| **Private** | Never | Signed-in customers on the venue's list, and its staff | A condominium's courts, pool or gym |

- **The list** is phone numbers, with a name, a unit or membership number,
  and whether each is a resident, a member or a guest. Staff add people one at
  a time or paste a spreadsheet (`phone, name, unit` a line); a number already
  on the list is updated, not doubled. **Guests** need an end date and drop
  off after it (the daily housekeeping removes them). Up to 5,000 people.
- **Online, an entry counts only for an account linked to it, or one that
  has proved its number** ([a phone number is not identity](../architecture/privacy.md#a-phone-number-is-not-identity);
  `ENTRY_COUNTS_FOR` in `src/lib/access.ts`, the same rule as a membership's).
  A number merely typed on an account lets nobody in, whether or not this site
  checks numbers. Staff link an entry to an account in the editor — when
  adding the person, or with *Link account* on their row — by the account's
  email or the number on it (a number two accounts carry is refused: use the
  email); *Unlink* takes it away. Where this site checks numbers (*Checking a
  customer's phone number*), an account that has proved the number needs no
  link. **On a site without phone checks, staff must link each resident's
  account before relying on online access**: until then a resident is booked
  at the counter. The editor says so, and recommends phone checks
  ([recommended, not required](venue-operations.md#phone-checks-recommended-not-required)). The editor marks each entry linked (with the account's name
  and email), *number checked by their account*, or *not linked: counter
  only*, and counts those last. Every path asks the same rule: the venue page
  and its availability, booking, a class, a waiting list, an open game, a
  tournament or league there, and *Your private venues*. At the counter and
  through the venue's API key the person booked is asked instead: the number,
  on staff's word, on the list (or each person named where only they take
  places); staff are never asked to sign in as anyone. Erasing an account unlinks its entries;
  they stay on the list (`tests/access-accounts.test.ts`).
- **Members only**: the venue page says *Members only* with the venue's own
  note (how to join, who to ask), and search results carry the badge. Booking,
  enrolling in a class, joining its waitlist, an open game, a tournament or a
  league all need an account that is eligible. At the counter and through the
  venue's API key, the person booked must be eligible instead, never whoever
  is signed in: the number, on staff's word, holds a membership here or is on
  the list on every date booked, or, where only people named take places,
  each of them has their own (`R9_DESK_NOT_MEMBER` at the counter,
  `R9_NOT_MEMBER` through the API, `ENT_MEMBERS_PLACE` naming who). No
  override goes past it: sell the membership, or add them to the list. A
  place on a members' session needs the person's own membership on its date
  there too (below). Each rule is the scope it is about
  ([ADR 0025](../architecture/decisions/0025-benefits-and-privileges-by-scope.md)):
  - *Reserving a court or room whole* is the account's privilege: a member
    books one for their children, who need no membership of their own to
    play on it.
  - *A place on a shared session* (a pool's places, a gym floor, a class) is
    each person's own to hold, **on the session's date**, not today: the
    customer's own place needs their own membership (or a place on the
    venue's list) valid then, besides the account being eligible to book;
    each participant needs their own membership, or a family membership
    naming them, on every date booked (`ENT_MEMBERS_PLACE` names who lacks
    one; `MV6_ENDS_BEFORE` and `MV6_OWN_ENDS_BEFORE` say whose ends before the
    session, and when, with where to renew;
    [membership validity](pricing.md#membership-validity)). A parent's
    membership does not cover a child it does not name, and a parent who is
    not a member may book their member child's place. This one check is made
    on every path: online, the counter (by the number given), the venue's API
    key, a group of courts, a waiting list (joining it, the offer and its
    claim), a class, and moving the booking to another date; the booking form
    says it before booking. No override goes past it, a manager's going past
    the court's rules included (ADR 0026; `lib/entitlements.ts`,
    `membersOnlyRefusal`). It is asked again at check-in and before a door
    code ([before taking part](pricing.md#before-taking-part)), and a
    membership that stops early flags the bookings it no longer covers for
    staff ([when a membership stops](pricing.md#when-a-membership-stops)).
  - *A tournament entry or a league place* for a participant is theirs in the
    same way: their own membership or a family one naming them, whoever
    enters them, online or at the counter
    ([who enters and how](tournaments.md#who-enters-and-how)).
- **Private**: in no search, list, map, classes, games, tournaments or leagues
  page — not even on its own storefront's lists. Its page, availability and
  QR poster answer only its staff and the people on its list; somebody not
  signed in is asked to sign in, without being told whose venue it is, and
  anybody else gets *not found*. Residents find it under *Your private venues*
  on their account page, or from the QR poster on the noticeboard.
- One rule decides what lists show (`LISTED_PUBLICLY` / `listRule` in
  `src/lib/listing.ts`) and one decides who may book (`accessRefusal`), so a
  new page or endpoint has one place to ask.

### Residents inviting their own guests

A members-only or private venue can let the **residents and members on its
list** add their own guests from their account page (*Your guests*), rather
than asking the management office each time. The venue sets two numbers in
the same editor: **guests each at a time** (0 to 10; 0, the default, turns it
off) and **for up to how many days** (1 to 14). Changing them is a manager's job
(`src/lib/guest-invites.ts`).

- A guest goes on the list as a *guest* with an end date (today plus the days
  chosen), and drops off after it like any other guest. The resident can take
  them off early.
- **A guest takes the host's unit.** Their bookings count towards that
  household's house rules, so inviting a friend does not double a unit's
  allowance. This applies even where the host has no unit label, because
  the household also follows who invited whom.
- **Removing a resident removes their guests.** Staff see *Guest of Hafiz* on
  the list. A number staff add themselves becomes staff's entry, not the
  resident's guest.
- A number already on the list stays as it is: a resident, a member, or
  another resident's guest whose visit is still running cannot be taken over.
  Re-inviting one's own guest extends the visit and uses no extra place. A
  guest whose visit has ended can be invited by anyone.
- Guests cannot invite guests, and nobody can invite their own number.
- The resident may give **the guest's email**, and the address is sent an
  **invitation**, not linked to anything: the resident learns nothing about
  it ([no account enumeration](../architecture/security.md#no-account-enumeration)).
  Whether or not an account has that address, the answer is the same
  (*Invitation submitted: if the recipient can receive invitations, they'll
  receive further instructions*), the entry goes on the list the same way,
  and the same email goes out through the outbox, in the resident's language.
  Only the resident's own address is refused (`GUEST_ACCOUNT_SELF`), and
  something that is not an address (`GUEST_EMAIL_INVALID`).
  - The email carries a **single-use link** to `/guest-invitation`, kept only
    as a keyed hash with a keyed hash of the address. It works until the
    guest's entry ends, and only for **an account signed in with that
    address**: somebody without one makes it (*Create an account*, by the
    link emailed to that address: [signing up](../architecture/authentication.md#signing-up))
    and comes back. Accepting links that one entry to the account, and nothing else —
    no other entry, venue, household or staff access.
  - Inviting the same guest again with an email **replaces** the link; the
    guest taken off, their entry running out, a lapsed guest taken over by
    another resident, or the resident leaving the list or no longer counting
    as one **voids** it. Every link that cannot be used gets the same answer
    (`GUEST_INVITATION_INVALID`); one opened by another account is left for
    the right one. Two acceptances at once link it once.
  - The resident sees each guest as *invitation sent* until it is accepted,
    then *linked* (accepting is the guest's own act, so it tells the resident
    nothing they were not meant to know); a guest already linked keeps that
    account until a new invitation is accepted.
  - **Withdrawing.** An invitation not yet accepted can be withdrawn
    (*Withdraw invitation*, after a confirm) by the resident who sent it, or
    by the venue's **manager** from the list (*Who it is for*), who gives a
    reason; front desk cannot, as with every other change to the list
    (`src/lib/roles.ts`). The guest stays on the list by their number, and the
    link is refused in the same words as one run out
    (`GUEST_INVITATION_INVALID`). It is withdrawn only while open, under its
    row lock as accepting takes it, so a withdrawal racing an acceptance is
    one or the other; withdrawing again gives the same answer. One already
    accepted is refused (`409 INVITATION_ACCEPTED_GUEST`: take the guest off
    the list, or unlink their account, instead), as is one run out or
    replaced (`409 INVITATION_NOT_PENDING`), changing nothing; anybody else's
    guest, or another venue's entry, is `404 INVITATION_NOT_FOUND`. If its
    email had not gone it never goes; if it had, the address it went to is
    sent a short notice, in the language the invitation was written in, that
    it was withdrawn (never by whom or why), the same whether or not an
    account holds it. The resident and staff then see *invitation withdrawn*;
    the invitation keeps who withdrew it and when, with a manager's reason,
    and a manager's withdrawal is in the activity log
    (`guest_invitation.withdrawn`) (`tests/invitation-withdrawals.test.ts`,
    `tests/components/invitation-withdrawals.test.tsx`).
- Without an email, the entry counts only for an account that has proved the
  guest's number — so on a site without phone checks the guest cannot book
  online until the resident invites them again with an email or staff link
  their account. The resident is shown the venue link to send them. A lapsed
  guest another resident takes over keeps no link
  (`tests/guest-invitations.test.ts`, `tests/components/guest-invitations.test.tsx`).
- Only a resident or member whose own entry counts for their account (linked,
  or their number proved) can invite guests.

### Members' and residents' guests at the counter and through the API

The owner's decision of 28 October 2026: *count actual guests, including
counter-registered guests, while distinguishing ordinary walk-in customers
from guests accompanying members.* So the counter tells the two apart:

- **A walk-in customer** books for themselves and is nobody's guest. At a
  public venue that is everybody; at a members-only or private venue they
  must be eligible themselves, as above (`R9_DESK_NOT_MEMBER`,
  `R9_DESK_NOT_LISTED`). Their booking does not count towards the limit on
  online bookings without an account ([above](#the-same-policies-on-every-path)).
- **A member's or resident's guest** comes with somebody on the venue's list.
  At a members-only or private venue the counter's booking form asks *Booking
  for: a walk-in customer / a member's or resident's guest*, and for a guest
  the host's phone number (`guestOf`); the venue's API key may send the same
  (`src/lib/guest-invites.ts`, `registerGuest`).
  - The host must be a resident or member on the list for every date booked,
    on staff's word as everything at the counter is (`GC8_HOST_NOT_FOUND`).
    A number on the list in its own right, or another resident's guest whose
    visit is running, is booked as themselves (`GC8_GUEST_LISTED`); nor can
    the host be their own guest (`GC8_GUEST_IS_HOST`). None of these is ever
    overridden. At a public venue there is no allowance and the person is a
    walk-in (`GC8_GUESTS_NOT_HERE`, 400). A guest is booked for their own place
    alone (`GC8_GUEST_ALONE`, 400, with people named), and only staff or the
    API key say so (`GC8_GUEST_OF_STAFF`, 403, online: residents invite from
    their account page instead).
  - **Counted exactly as a resident's own invitation.** The guest goes on the
    list as the host's guest until the last date booked, with the host's unit,
    so one allowance counts every guest whichever path registered them: the
    venue's *guests each at a time* (`GC8_GUEST_ALLOWANCE`; `GC8_GUESTS_OFF`
    where it is 0) and *for up to how many days*, counted from today
    (`GC8_GUEST_DAYS`). A guest the counter registered fills a place the
    resident could otherwise invite online (`GUEST_LIMIT`), and the other way
    round. Booking the host's own running guest again extends the visit and
    takes no extra place. The booking counts with the host's household under
    the house rules, even before the guest is on the list.
  - **Overridable like the other operational limits**: a manager may go past
    the allowance (the guests at once, and the visit's length) for one booking
    where the venue permits *A member's or resident's guest allowance*
    ([manager overrides](#manager-overrides)); front desk is told to ask a
    manager; the API key never overrides.
  - Registered under the host's entry's row lock, as a resident's online
    invitation now also takes it, so two registrations for one host at once
    cannot both take the last place. A booking that is then not made (the
    time taken, a coach not free, an account over its limit) takes the
    registration back. The booking keeps whose guest it is
    (`bookings.guest_of_entry`, migration 0229) and the path it was made on;
    staff see *Guest of …* on the list as for any resident's guest; the
    activity log has *Registered a member's or resident's guest at the
    counter* (`guest.registered`). Reports, occupancy and the bookings list
    count the booking as any other (`tests/guest-counting.test.ts`,
    `tests/components/guest-at-counter.test.tsx`).
  - Only a resident or member **on the venue's list** can be a host: a
    members-only venue's member who holds a membership but is not on its list
    cannot bring a guest this way (add them to the list as a member). Guests
    are not asked of class places or waiting lists: a guest is registered with
    a court booking (or by the resident online) and is then listed for those
    dates like anybody on the list.

## Free courts and house rules

**A court can be free.** Rates may be RM0 — a condominium's tennis court, a
club's member-only pool lane. A booking that comes to RM0 owes nothing: it
shows as *Free* to the customer and the desk, is never offered online
payment, and does not count towards the cap on unpaid bookings a number may
hold.

**House rules** (*Venues & staff → House rules*, `src/lib/house-rules.ts`) are a
venue's fair-use limits on booking, each blank for none, asked online, at the
counter and through the venue's API key alike
([the same policies on every path](#the-same-policies-on-every-path)):

| Rule | Example |
| ---- | ------- |
| Bookings coming up at once | 2 — a third waits until one is played or cancelled |
| Bookings a week (Monday to Sunday) | 3 |
| Bookings a day | 1 |
| Days ahead they may book | 7 or 60 (0 is today only; blank is the site's 14; up to 90) |
| Days ahead members may book | 21: more than everybody's, so members get first pick |

- **Counted per household.** Everybody the venue's list gives the same unit
  (*Who a venue is for*) shares one allowance: a family in B-07-2 gets two
  bookings a week between them, not two each. An account linked to an entry
  counts with that entry's unit, whatever number it books under. Anybody else is counted by the
  number on the booking **and** the account making it, so typing a different
  number does not buy another booking. These are the account's limits:
  bookings it makes for the people it books for count with its own.
- Only court bookings are counted. A class place asked for (enrolling, a
  term, its waiting list and the claim) is checked against them as one more
  booking on its date, as court time is.
- Checked when a customer books (every week of a weekly series), and when
  they move a booking to another day, each time counting the account that
  made the booking as booking online does. At the counter and through the
  API the number booked is counted, on the venue's word for the members'
  window; a manager may go past the limits on bookings at once, a week and a
  day for one booking where the venue allows it, never how far ahead
  ([manager overrides](#manager-overrides)).
- The venue page shows them (*House rules: up to 2 a week for each person or
  household; book up to 7 days ahead. Members book up to 21 days ahead.*), and
  its dates stop at the last day the venue takes bookings from whoever is
  looking.
- **Members first.** A member holds a live membership at the venue (or
  another branch of its business). Booking online, that is an account the
  membership is linked to, or whose verified number holds it — not a number
  typed on the booking ([a phone number is not identity](../architecture/privacy.md#a-phone-number-is-not-identity)).
  It is the account's privilege: a member books further ahead for their
  children too, and a child's own membership on the parent's number does not
  give the parent the members' window
  ([pricing](pricing.md#memberships-and-member-rates)).
  Inside the members' window everybody else is told how far ahead
  they may book, and that members may book further. At the counter and
  through the API it is the number's: a member's number has the members'
  window, anybody else's the public one. The members' window is the outer edge
  for moving a booking and for joining a waitlist, and is asked again when a
  waitlist's place is claimed.
- Cross-venue search lists a venue only on days inside its own window (the
  public one), and offers *Or another day* up to 90 days ahead besides the two
  weeks of buttons. Moving a booking can go as far as the window allows that
  customer.

## Booking again

Past bookings on `/account` have *Book again*, and the account page opens with
*Play again*: the last few courts and times a customer actually played. One tap
opens the venue page with the same court and hours picked on the **next day
they are free** — the same weekday first, since most regulars play the same
night each week — else another court of the same sport. It is a link, not a
booking: the customer still sees the price and taps *Book*. `/my-booking` has
the same button for a booking looked up by code and phone.

## Your booking link and QR poster

Venue staff see **their booking link** on the Bookings tab, with *Copy link*,
*Share on WhatsApp* and *Print QR poster*. The link is the venue's page on its
storefront domain if it has one. The poster (`/venue/<id>/poster`) prints the QR
code, the link and three steps in English and Malay, for the counter, the door
or the noticeboard. The QR code is also an image at `/api/venues/<id>/qr`. A
draft venue's link, code and poster are for its own staff only.
