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

A resource with places can also let people in with no booked time, while it
has room, where the venue turns that on: [entry with no set
time](venue-operations.md#entry-with-no-set-time). Its bookings keep their
places; entries are not claims, and are counted against what bookings leave.

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

## By the game, and a lane given on arrival

Bowling lanes are sold by the game, and the lane is given at the counter
when the customer arrives. Both are booking rules
(*Courts & rates → Booking rules → Sold by the game*; `lib/booking-rules.ts`),
inherited like the rest, and the [activity catalogue](activities.md#selling-units-by-time-or-by-the-game)
gives them to bowling; any lane activity can be sold so, and a venue selling
its lanes by time sets the minutes for a game to 0 and the lane to *chosen
when booking*.

**By the game.** The customer chooses a number of games, 1 to the most the
venue sells in one booking (6 unless it says), and how many play. The lane is
held for the venue's estimate: the minutes for one game of one player, and
more for each other player (on a lane priced per lane players are not
counted, so the venue gives the minutes of a usual game), times the games,
rounded up to the length step (`gameHold`; bowling: 12 minutes, 10 more each,
in quarter hours, so two games for three take 75 minutes). Starts, hours,
notice, buffers, closures and the venue's policies are as for any booking;
lengths by time are not asked. Asked for by time on a lane sold by the game,
a booking is refused (`GAMES_NEEDED`), as are games on a court sold by time
(`GAMES_NOT_HERE`) and more games than the most (`GAMES_RANGE`). The price is
the venue's price for a game, for each player where the lane is priced per
player ([pricing](pricing.md#a-price-per-game)). The booking keeps how many
games it was for (`bookings.games`, migration 0265). Cancelling, late
cancellation, no-shows, holds and deposits to pay online, discounts and
receipts treat it as any booking, on its price.

**A lane given on arrival.** The booking holds one lane like any other: the
cheapest free for the whole time, as [any court](#booking-without-naming-a-court)
is taken, so the database refuses an overlap and decides a race for the last
lane. But the lane is provisional (`bookings.lane_on_arrival`):

- The board shows **lanes free** at each time, one row, not lane by lane, and
  books *a lane, given when you arrive*; search says *a lane* too.
- Until it is checked in, the customer is never told which lane: not in the
  booking's answer, *My booking*, the account's bookings, the times offered
  for a change, the confirmation, reminder, change, cancellation or payment
  messages, the calendar file or a receipt issued before then. They read
  *Lane given on arrival* (`lib/lanes.ts`).
- Staff see the lane held, marked *lane given on arrival*. *Check in* asks
  which lane: keep the one held, or any other free for the booking's whole
  time. It is moved there as [moving a booking](#moving-a-booking) moves one,
  in one step under the claims, then checked in; a lane not free then is
  refused and nothing is checked in. The move is in the activity log, and the
  customer is not sent a message about it (they were never told a lane).
- Checked in, at the desk or by the QR code (which keeps the lane held), the
  lane is theirs and is shown.

**Playing on.** *Add a game* at the desk holds the lane on from where the
booking ends for the estimate of one more game, while that time on the same
lane is free (`GAMES_ADD_TAKEN` otherwise), up to the most games. The game is
priced as one is that day, without the discounts already on the booking, and
added to what is still to pay; a booking anything is paid towards already
(paid, a deposit or a friend's share, on an account, a payment page open) is
not changed (`GAMES_ADD_SETTLED`): book the extra games as a booking of their
own on the lane. In the activity log as *Added games to a booking*.

**Where games are taken.** The booking board (any lane or a named lane),
the counter, weekly bookings, the quote, `POST /api/v1/bookings` and the MCP
server's `create_booking` take `games`. What cannot take them refuses rather
than book by time: the waiting list for a taken time (`GAMES_NO_WAITLIST`),
an approval application's slot, and anything else that books a fixed time
(`GAMES_NEEDED`). *Change time* and moving keep the time the games hold.

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

Narrowing a venue's day, or a court's, a sport's or the business's hours in
the booking rules, is refused while bookings exist outside the proposed
hours — otherwise a customer would hold time the venue no longer sells. The
refusal lists every such booking (date, time, court and code), and staff
cancel or move them first. Hours saved in the editor apply from today; hours
can also be set [from a later date](#hours-from-a-date).

**A weekly series is checked week by week** against the hours, the closed weekdays, the closures and the court's
booking rules (starts, lengths) in force **on that week's own date**, as its price is each week's own: a change of
hours or a closed weekday from a later date reaches the weeks that fall after it. A week that does not fit is
**skipped with the reason** (*outside the opening hours*, *outside the court's booking rules*, *venue closed*) with
*skip unavailable weeks*, as a clash or a closed day is; without it the whole series is refused, naming the first week
and the reason, and nothing is made. Staff who may go past the court's rules (`staff.override`) book those weeks
anyway, and the series answers with the rules gone past (`overrides`), each such week marked as an override.

A **closure** shuts one venue for one whole date (`venue_closures`, unique on
venue + date). Closed days read as blocked everywhere: no slot is selectable,
booking, series, class scheduling, enrolment and waitlist joins are all refused
with "The venue is closed that day", the venue disappears from search for that
date, and customers see the reason both as an upcoming-closures banner on the
venue page and on the grid itself. Staff still see the day in the schedule,
marked with the closure reason rather than blank, so bookings taken before the
closure was declared remain visible for them to handle.

**Closing a day over bookings** (*Venues → Closures*; `POST /api/admin/venues/{id}/closures`)
is one decision, taken in this order ([ADR 0053](../architecture/decisions/0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md)):
a past date is refused first, before anything is cancelled; with bookings or classes still to be played that day it
asks for a yes (a 409 naming the counts); the **closure is then written first**, in a transaction that also reads what
is booked, and live waiting-list offers for the day are let go (the entry goes back to waiting, not burned); only then
is each booking cancelled, refunded and its customer told (a counter payment owed back), and each class called off,
with nothing offered to the waiting list (a closed day is not offered). A booking made at the same moment either
completes before the closure (and is cancelled with the rest) or is refused after it, never left confirmed on the closed
day; the sweep runs again for anything that arrived before the closure was written. What has **been played** (a
booking or class that has ended) is left alone, and not counted; one under way is called off. A booking whose **kit is
still out** cannot be cancelled: it stays confirmed and is **named in the response (`left`) and the activity log** for
the desk to settle after the kit is back; asked again, the same request carries on with what is left.

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
outside them, listing every one.

### Hours from a date

Winter hours, or longer evenings from the new year, are set ahead: under the
hours, *Change the hours from a date* takes a date after today and the usual
hours and week from then, as a whole (`venue_hours_changes`, migration 0252;
`src/lib/dated-changes.ts`; [ADR 0027](../architecture/decisions/0027-hours-and-rates-from-a-date.md)).
A court's own hours from a date are set the same way, under *Courts & rates →
Rates and a court's own hours from a date* (its own hours from then, or the
venue's).

- **The date asked about decides.** Every check above, search, the venue's
  closed weekdays and the API answer for a date by the hours set for it: the
  latest set from that date or an earlier one, else today's. The hours saved
  in the editor are today's, and apply up to the first date set ahead.
- **Bookings already made stay as they are.** Setting, changing or
  withdrawing hours from a date is refused while confirmed bookings on the
  dates it changes would fall outside the hours, and the refusal lists every
  one of them (date, time, court, code) for staff to move or cancel; so is a
  set whose evening before would run into its first morning.
- **Waiting to apply**: each set from a later date is listed under the
  editor, and can be changed (another date, other hours) or withdrawn, after
  which what applied before carries on.
- **When its date comes** it applies by that rule alone: no scheduled job is
  involved. The next time staff open or change the hours it becomes today's
  hours in the editor and leaves the list.
- Managers only; each set, change and withdrawal is in the activity log, with
  the hours before and after and the date (`hours.scheduled`,
  `hours.withdrawn`).

## Courts out of service

Two ways, for two lengths of time:

- **A few hours**: block them on the *Schedule*, with a reason. On a shared
  facility, only some of its places (below).
- **Days, or until further notice**: *Courts & rates → Out of service* — a
  court, a first day, a last day or "until further notice", and a reason,
  which customers see on the venue's page. Nobody can book it, search finds it
  closed, and the reports count it as out. If anything is booked in the
  stretch, it lists those bookings and classes and stops; staff move them, or
  choose to cancel them, which refunds each as a staff cancellation would
  (a counter payment owed back, [owed back after the venue cancels](payments-and-credit.md#owed-back-after-the-venue-cancels))
  and messages its customer. Classes on a court sharing the floor are listed too.
  **Taking the court out is one transaction**: the bookings and classes in the way are cancelled and refunded, live
  waiting-list offers on the court are let go, and the outage is written and the court claimed, **or none of it is**
  (nothing is offered to the waiting list meanwhile, and the customers are told, and online money refunded, once it
  has committed). A booking made while this runs makes the claim refuse and the whole thing goes round again for it
  (a few times, then it says so, with nothing changed); one made after is refused by the claim. What has **been played**
  today is history, never "in the way": a court taken out at 15:00 "from today" is not refused because of the 09:00
  booking, and its claim starts from the moment it was taken out (`court_outages.claimed_from`). One under way is
  cancelled. A booking whose **kit is still out** cannot be cancelled and the court cannot go out over it: the request
  is refused naming the booking, with **nothing changed** (no booking cancelled, no refund, no outage).
  *Back in service today* ends it early.

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
would (the venue's choice, so no late-cancel fee; a counter payment owed back,
[owed back after the venue cancels](payments-and-credit.md#owed-back-after-the-venue-cancels)), messages each customer and
keeps them on the desk's *needs attention* list until they have seen it, and
blocks the rest of those hours with the reason so nobody books them
meanwhile (`rainOut` in `src/lib/rain-outs.ts`). **The hours are blocked first**
(live waiting-list offers for them are let go), so from then on nothing in them is offered, claimed or booked; each
booking and class is then called off in a transaction that also blocks the time it frees, so the freed time is never
open in between and is offered to nobody; a booking that slipped in before the block is found by going round again. A
booking or class already under way is called off too; one that has finished is left alone, and the preview does not
count it. A booking whose **kit is still out** cannot be called off: it is **named for the desk** (`left` in the
response, and in the panel's message) rather than skipped silently. Bookings on a
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

## Launch and tide windows for water hire

Hire of kayaks, paddle boards, boats, jet skis and surf gear is limited by a
**daily window** that is not the venue's opening hours: a launch window (the
ramp is open, the launch crew is there) and, on tidal water, the stretches of
the day the water is deep enough to go out and come back. *Courts & rates →
Launch and tide windows* (a manager's; the desk reads it) gives a resource, or
one activity on it, a rule that **narrows the bookable hours** to the windows
it leaves
([ADR 0037](../architecture/decisions/0037-launch-and-tide-windows.md);
`src/lib/launch-day.ts` works a day out, `src/lib/launch-windows.ts` keeps the
rules and the table, `src/lib/launch-worklist.ts` the bookings a change
leaves outside).

**This is not a safety system.** The window is only the hours the venue's own
data leave. Whether it is safe to go out stays the venue's decision, on the
day: the app does not know the weather, the swell or the crowd, and it says so
on the staff screen and, beside the window, on the venue's page.

### Where a window comes from

A rule has one of three sources, and may say more:

- **A launch window by weekday**: one window, or none, for each day of the week
  (Sunday first), in whole minutes of the day.
- **A tide table**: the venue's own list of high and low tides for a station it
  names, with a rule on it: usable where the tide is **at least *H* metres**, or
  **within *N* minutes of a high (or low) tide**.
- **Both**: the intersection of the two.

A rule may also say a **shortest window** (*M* minutes; a window shorter than
that is not offered at all) and **back before it closes** (minutes: a hire must
end that long before the window ends). A rule is for one activity on a resource
or for every activity it offers; one for an activity wins over the resource's.

**No tide service is asked and nothing is fetched.** Tide times are what the
venue typed or imported, and customers are told so where they see a window:
*not a forecast*. They never see the table, its station or its heights, only the
windows it leaves.

### The tide table

Entered by hand (*Add one entry*: a date, a 24-hour time, high or low, a height
in metres) or **imported as CSV**, pasted or from a file:

```
date,time,type,height_m
2026-11-06,05:42,high,3.1
2026-11-06,11:58,low,0.6
```

- Dates are `2026-11-06` or `06/11/2026` (day first). Times are 24-hour `HH:MM`
  on the venue's clock, or in UTC where the import says so (tables published in
  UTC). Type is `high` or `low` (`H`, `L`, `HW`, `LW` also read).
- The height column is `height` or `height_m` (metres), `height_cm` or
  `height_ft`; a figure may carry its own unit (`3.1m`, `10.2ft`, `310cm`), which
  must agree with its column's. Heights are kept to the centimetre, between
  -5 and 25 m. The separator may be a comma, semicolon or tab, and columns may be
  in any order.
- **Every row is checked and every fault is named by its line** (a date that is
  not one, a time, a type, a height, a figure in the wrong unit, a row too short,
  the same moment twice, a time the clocks skip or repeat on a day they change);
  a table with any fault **stores nothing**. *Check* reports what an import would
  do (new, changed, already there) without storing it. Up to 5,000 rows at a
  time.
- An entry at a moment the table already has **replaces** it, so a corrected
  table is imported over the old one; entries can also be removed one by one or
  by dates. Two entries of one kind in a row, or more than 15 hours between
  entries, are reported as warnings: the stretch between them is not used (below).

### How a window is worked out

For one date, from the court's opening hours and the table, deterministically,
to the minute:

1. The tide is read **between two entries by half-cosine interpolation**:
   *h = h₁ + (h₂ − h₁) · (1 − cos(π·f)) / 2*, *f* the fraction of the time between
   them. It is the entry's own height at an entry. A minute is read at the
   instant it is on the venue's clock (a day the clocks change is read as it
   happened).
2. **Where the table says nothing, the water is not known and the time is
   closed with the reason "no tide data"**: before its first entry, after its last,
   between two entries more than 15 hours apart, or between two of one kind (an
   entry is missing). A date a table does not cover is therefore closed, never
   open. This holds under either rule.
3. The *height* rule keeps the minutes at which the interpolated tide is at
   least *H* (a minute interval is usable where both its ends are); the
   *event* rule keeps those within *N* minutes of an entry of the chosen kind.
4. With a launch window too, only what is inside both. The result is cut to the
   court's opening hours that day, and **a window never crosses midnight**: it is
   within one date's 00:00 to 24:00, so the business day's minutes after midnight
   (late hours) are never in a window, and a tide that serves 23:00 to 01:00 is
   two windows, the evening's on its date and the early morning's on the next.
5. A window shorter than the shortest is dropped (reason: *window too short*).

The reason a stretch is closed is *outside the launch window*, *low water*, *no
tide data*, *window too short* or, for the last minutes of a window, *must be
back before it closes*.

### Where it bites

A booking must **start and end inside one window, and end by the return
buffer** (the last returns must be back that long before the window closes). On
every way a booking can be made or changed, refused with a code and text in the
customer's language: `LAUNCH_WINDOW` (it quotes the day's windows),
`LAUNCH_RETURN` (it says by when), `LAUNCH_CLOSED` (no window that day) and
`TIDE_NO_DATA`; `LAUNCH_WEEK` for a class term.

- **The booking form, the counter, the venue's API key, a waiting list (joining
  it; an offer taken is booked as any booking), an approval request's held slot**: the same check, through
  `policyBreaches` in `src/lib/booking-rules.ts`, the one the opening hours and
  the clocks changing are asked in. **A manager's override of a court's booking
  rules goes past none of it** (as none goes past a change of the clocks); the
  window has its own override, for an *advisory* window only, with a recorded
  reason ([below](#advisory-and-hard-windows)).
- **The quote** says it before a booking is made.
- **Availability and search**: the board's cells outside a window are shut and
  say why (a tooltip, *Outside the launch window*, *Low water*, *No tide data*…),
  not merely missing; they are not queued for. The court's row shows the day's
  window ("Launch 7:10 AM–10:40 AM, back by 10:10 AM"). Starts offered, and the
  longest hire from each, stay inside the window and its return buffer; search
  offers only those starts. A cell not wholly inside a window is shut.
- **Moving or rescheduling** a booking, including a game's proposed move and a
  series moved: the new time is held to its day's window.
- **A weekly series**: each week is checked against its own day's window. With
  *skip unavailable weeks* a week outside its window is skipped, with the reason
  (*no tide data*, *outside the launch window*, *back after the last return*);
  without it the whole series is refused and nothing is made.
- **Classes**: a class session, and every week of a term, must be inside its day's
  window (a term with a week outside it is refused, naming the date).
- **Open games** are bookings, so a game on the resource is held to it.
- **Adding games to a booking** (by the game) must still end inside the window.

How it composes: **the narrower always wins**. A window is cut to the opening
hours, so where the hours are narrower they decide (a booking outside them is
refused as outside the hours, and a manager's override of the hours does not
go past the window, which has its own, [below](#advisory-and-hard-windows)). A closed day, an outage, a rained-off stretch, a block and
another booking close their time as ever; the window closes more. The **return
buffer is on the booking's end**, the window's own; the court's **operational
time and separations** (setup and cleaning, [booking rules](#booking-rules-starts-lengths-buffers))
are the claim's and may run past the window's close (a hire that ends at the last
return is cleaned after it), so a window's buffer and a court's buffers add up on
nobody. Daylight saving works as for every booking: a booking touching a change
of the clocks is refused (`CLOCK_CHANGE`) whatever the window.

### Advisory and hard windows

A window is the venue's own judgement, so **every rule is *advisory* unless the
venue marks it *hard*** (*Launch and tide windows → How firmly it holds*; a rule
that existed before is advisory). The owner's decision of 5 November 2026
([ADR 0046](../architecture/decisions/0046-strength-of-a-requirement-advisory-windows-and-qualification-levels.md)): an authorised manager may override an
advisory window, with a mandatory reason and an audit record; nothing ordinary
overrides a hard closure, a legal restriction or a mandatory safety requirement.

| Restriction | Strength | A manager's window override |
| ----------- | -------- | --------------------------- |
| A launch or tide window (`LAUNCH_WINDOW`, `LAUNCH_RETURN`, `LAUNCH_CLOSED`, `TIDE_NO_DATA`, `LAUNCH_WEEK`), the rule advisory | advisory | Yes, with a reason |
| The same, the rule marked hard | hard | Never |
| A change of the clocks (`CLOCK_CHANGE`) | hard | Never |
| A closure, outage, block or rain-out | hard where the venue marked it a *safety closure*, otherwise venue-required | Never: the database holds that time |
| Required supervision (`SV1_NO_SUPERVISOR`), the roster's [qualification levels](venue-operations.md#qualification-levels) | venue-required; hard where legally required | Never at booking |
| The court's booking rules, eligibility, sign-offs, capacity | as before ([manager overrides](#manager-overrides)) | Not by this override |

- **Where it applies**: exactly the paths that refuse a window, for a manager at
  the counter: a booking (`POST /api/bookings`, a weekly series each week), a
  booking moved or rescheduled (and each week of a series moved), and a class
  term (each session). Send `overrideWindow: true` and a `windowReason`.
  Customers, front desk, the venue's API key, another venue's manager and the
  platform owner are never offered it and never accepted
  (`SAFE1_WINDOW_MANAGERS`, 403). There is no owner or platform emergency
  override.
- **What the counter says**: a manager refused for an advisory window is told an
  override is available and how long the reason must be; front desk is told to
  ask a manager; for a hard rule, that there is none and why. The customer's
  refusal is unchanged, and a booking made this way is an ordinary booking to
  them.
- **The reason** is at least as long as the venue's minimum (15 characters from
  the install, the venue may change it; 300 at most). Short, `SAFE1_WINDOW_REASON`;
  the venue having turned the override off, `SAFE1_WINDOW_OFF`; a hard window,
  `SAFE1_WINDOW_HARD`.
- **What is kept**, in the booking's own transaction and only for what was
  actually refused: who, when, why, which rule, which refusal and the day's
  window as it stood (`booking_window_overrides`), and an entry in the staff
  activity log (`booking.window_overridden`). A preview, a booking that fails
  and the loser of a race keep nothing. It is shown on the booking (*Went past the
  window (…) — Mina: why*) and on the manager's report under *Launch and tide
  windows* (`GET /api/admin/window-overrides`).
- **A cap and an alert**: more overrides in 7 days than the venue's limit (5
  from the install; the venue may change it or set 0 for none) puts a line on
  the manager's needs-attention panel.
- **Settings and defaults**: managers may override by default; a venue turns it
  off, changes the shortest reason or the weekly limit under *Launch and tide
  windows → Overrides of advisory windows* (a manager's, logged). A venue that has
  no window sees none of this.
- **A safety closure**: a closure, outage, block or rain-out may be marked one
  (`safety: true` on the closure, outage, block and rain-out routes; the
  rain-out's checkbox is for outdoor safety). It is kept, named in the log and
  lists, and nothing reaches it; every other block is as it was.
- **Not covered**: moving a booking to another resource at the same time
  (`moveBooking`) does not ask the target's window today, so there is nothing
  there to override (a known gap).

### When a window changes

A table corrected, a rule changed or removed: **nothing already booked is
cancelled or moved**. Every booking and class session to come that is not wholly
inside its day's window as it now stands is listed, soonest first, with why, the
customer's number and the day's windows: under the rule on *Launch and tide
windows*, and as a line on the desk's *Needs attention* panel (with the first
eight of each venue). Staff **move or cancel** each through the existing paths on
the day list, with the existing refunds and customer messages (a cancellation
from here is any staff cancellation), or **keep it as booked**, which holds until
the day's window changes again; it is then listed again. A booking that has
finished is left alone. The list is worked out each time from the rules and the
table, so it cannot be out of date.

### Customers see the window

The venue's page lists, for each resource with a rule, today's and tomorrow's
windows in the venue's time ("Tomorrow: Kayaks, launch 7:10 AM–10:40 AM, back by
10:10 AM"), or that there is none or that tide times are not yet entered, with
the line *not a forecast; whether it is safe to go out is the venue's call on the
day*. The booking board shows the window under each court's name. In English,
Malay, Chinese and Tamil.

*Courts & rates → Launch and tide windows* also has a **month preview**: each
date's windows as bookings will meet them, or why there is none.

Known limits: a tournament's or league's court time is not held to a window
(a lesson is, as it is a booking); a venue copied from another does not copy its
windows; the tide is read from the table at the whole minute, with no allowance
for a station's distance from the water.

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
| Unpaid bookings coming up (3 here, 6 anywhere), counted by the number **and** by the signed-in account | Refused | Refused, never overridden, paid as it is booked or not (by the number) | Refused (by the number) |
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

**The offer's page** (`/waitlist/<token>`, from the link in the offer's
message) says what is offered before anything is claimed
(`GET /api/waitlist/claim`, `src/lib/waitlist-offer.ts`): the venue, the court
or class (and instructor), the day and time, who it is for, the price as it
would be booked now, until when the offer is theirs, and, where claiming it
holds the booking until it is paid online (the venue holds unpaid bookings,
or the number is past its strikes, or a guest books while the venue is
flooded with unpaid guest bookings: the same rule the claim applies), for how
many minutes. Claimed, the page shows the booking as the booking form's
confirmation does: its code, court or class, day and time, and, held, *Held
until 6:45 PM while you pay online* with the button to pay (by the booking's
own link, [below](#links-that-open-a-booking)); booked outright, payable at
the counter, or online where the venue takes it. It never says "payable at the
counter" for a booking that will be let go. It links back to the venue and to
My Booking. The offer's message itself is unchanged (its WhatsApp template is
fixed), so the page is where the hold is said.

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

### Leaving, and turning an offer down

Whoever joins a waiting list online is given **a private link to leave it**
(`/waitlist/leave/:token`): on the screen that says they are on it, and in an
email saying so where they gave an address (kind `waitlist_joined`, by email
only, in their language, with the day and its weekday). Only the link's
SHA-256 is kept (`waitlist.leave_hash`, migration 0248), as a coach's link is;
an entry made before it has none and leaves as before. The page the link
opens says what the entry waits for (the court or class, the venue, the day
and time; nothing about who joined) and takes it off the list only when its
button is pressed, so a link opened by a mail scanner changes nothing. A
signed-in customer can still leave from *My waiting lists*, and the venue
can take off an entry it made.

The offer's own page has, beside *Claim my place*, **No thanks, offer it to
the next person**, asked once more before it is done. Anybody holding the
offer's link may turn it down, as anybody holding it may claim it.

Either way the entry leaves the list (`cancelled`), its hold on the court is
let go, and the place is **offered at once to the next person waiting**,
through the same offer path every other leaving uses (`leaveWaitlistByToken`
and `declineWaitlistOffer` in `src/lib/store.ts`), rather than held for
nobody until the offer would have run out; that person's offer is written to
the outbox there and then. The entry's row is locked while it is left, turned
down or claimed, so a decline racing a claim does exactly one of them. A link
used twice, for an entry whose place was taken up, or that has run its
course, changes nothing and says so (`WAITLIST_NOT_FOUND`,
`PLACE_ALREADY_CLAIMED`, `OFFER_EXPIRED`) (`tests/waitlist-leave.test.ts`, on
PGlite and Postgres).

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
  time's rate, up or down, by the same pricing as a new booking; with a deposit
  or friends' shares paid, never below what was paid on it (the excess of a
  deposit is owed back, friends' shares refuse the move:
  [a deposit instead of the whole price](payments-and-credit.md#paying-online-to-hold-a-booking)). Paid, it keeps what was paid: a customer cannot move
  it somewhere dearer (that would be peak hours at an off-peak price), and
  staff who do have chosen not to charge the difference. Its concessions and
  promo code stay as they were given, the same amounts, and are not asked
  about again ([discounts together](pricing.md#discounts-together)). The one
  exception is a coached lesson **staff** move: it keeps the price agreed, paid
  or not, whatever the new time costs, and its customer may cancel with everything
  back for a while ([a lesson moved by the venue](programmes.md#a-lesson-moved-by-the-venue)).
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
inside that window with a message naming the cutoff, while staff may cancel
past it (`/api/admin/bookings/cancel`), until the booking has been played, so
the front desk can make exceptions. Staff are shown first what was paid and
how and the venue's terms, and choose how a paid booking is settled: back the
way it was paid, as stored credit, or keeping the venue's late share where
its terms keep one
([cancelling a booking paid at the counter](payments-and-credit.md#cancelling-a-booking-paid-at-the-counter)).

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

**Staff cancel weeks of a series** from the day list (*Cancel weeks of the
series*; `POST /api/admin/bookings/cancel-series`): every week still to be
played is listed with its own terms as above, what was paid on it and how,
and whether it is a manager's to refund; staff tick the weeks and choose how
what was paid is settled, as for one booking. Each week goes on its own
terms: where it does not offer the outcome chosen (keeping the late share on
a week inside the free window, credit on a week not paid at the counter) it
goes back the way it was paid. Unlike a customer, staff may cancel weeks past
the cutoff. Each week is cancelled and settled once, in its own transaction;
a week that cannot go (kit still out, a counter payment from an earlier day
for the front desk) is named with why and the others still go. The customer
gets one message for the weeks cancelled; the activity log has each week and
the series (`booking.series_cancelled`) (`tests/counter-refunds.test.ts`).

### Moving a weekly series

Staff move the weeks of a series still to be played in one step (*Move the
series* on the day list; `POST /api/admin/bookings/move-series`,
`src/lib/series-moves.ts`): a weekday (each week moves within its own
Monday-to-Sunday week), a start, and a court (or its own court, else another
free one). Each week is first shown as it would go: where to, what it would
cost, and which cannot move and why (taken, the venue closed, outside the
court's rules, a lesson's coach not working). Staff tick the weeks to move.

It is the single staff move week by week (`staffMove`, `rescheduleBooking`),
not a second engine: what is free, linked courts and buffers, the court's
rules for the date each week falls on (dated hours and rates included), a
manager's override, a lesson's coach and an open game's players are decided
as for one booking, and so is the price: a paid week keeps what was paid
(the difference at today's rates shown, not charged), an unpaid one is priced
at its new time. Each week moves in its own transaction; a week taken in the
meantime stays where it is and is named, and the others still move. The
customer gets one message for the weeks moved (the venue's change they
acknowledge, every week in its calendar file), a lesson's coach one email,
and the activity log each week (`booking.rescheduled`) and the series
(`booking.series_moved`) (`tests/series-moves.test.ts`, on PGlite and
Postgres).

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
- **Giving the court back.** Where late cancelling is off, the venue may still
  let a customer give the court back online until it starts, nothing refunded
  (*Still let customers give the court back after the cutoff, with no refund*,
  `venues.late_give_back`, migration 0246; off by default, so past the cutoff
  a customer calls, as before). It goes through the same cancellation as any
  late one, the venue keeping all of it: recorded as a late cancellation
  keeping 100%, no credit note, the slot offered again and the waiting list
  told; one never paid for is a strike where the venue counts them. My
  Booking and the account page offer *Give the court back (no refund)* past
  the cutoff and say so before the customer confirms, and afterwards that the
  venue kept what was paid and nothing is refunded (never that a rest goes
  back; `tests/components/q8a-customer-flows.test.tsx`); the booking terms say
  it before booking. Where the venue (or the sport) keeps a share on a late
  cancellation, that share is what applies. The same terms go for a week of a
  series and for one person taken off a booking. Changing it is logged as any
  change to the policy.
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

### The booking form and its dialogs

Tapping a free time on a venue's grid opens the booking form
(`components/BookingBoard.tsx`). On a phone it is a sheet along the bottom of
the screen, never more than 60% of its height, scrolling inside, with room
left below the grid so every court and time can be scrolled clear of it and
picked instead, and a × that lets the time go; on a wider screen it sits under
the grid. It ends with the **Book** button, its label carrying the price it
will be, after everything still to choose: who takes part, the extras, the
waiver, credit, a promo code or pass, the venue's news and the *Before you
book* box. A refused booking is said inside the form, beside the button, read
out and given the focus, with the venue's number to call
([the venue's number](venue-operations.md#the-venues-number)); it is not
also put above the grid, behind the sheet. An answer that is not the app's (a
deploy's restart, an overloaded proxy) is said as such in the customer's
language and never as a parser error
([HTTP routes](../architecture/http-api.md#how-every-route-behaves)).

The booking's confirmation, the waiting list on the grid and enrolling in a
class are dialogs a keyboard and a screen reader know as such, through one
component (`components/Dialog.tsx`): named by their heading, the
confirmation described by its booking code, the focus moved into them when
they open (onto the first field of a form), kept inside by Tab and
Shift+Tab, closed by Escape, and given back to what opened them where that is
still on the page (`tests/components/booking-dialogs.test.tsx`, with the
phone layout checked in Chromium at 390 × 844 in English and Malay).

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

## Finding your booking

### Links that open a booking

Every message that sends a customer to their booking (the confirmation, a
change they made, the reminder), the payment return page, a waiting-list
claim and a class enrolment links to it directly:
`/my-booking?code=MS-…&t=…`, the booking's signed link
(`src/lib/booking-access.ts`;
[security](../architecture/security.md#links-that-open-a-booking)). My Booking
opens it without the code and phone being typed, and every action there
(pay, change the time, split the cost, cancel) then works as with them typed.
Looked up by code and phone, the page puts the booking's link in the address,
so a refresh or the Back button keeps it; the phone is never in the address.
The link runs out 30 days after the booking's day (`Q8A_LINK_EXPIRED`: type
the code and phone instead). A series' and a group's messages link to their
first booking.

### Bookings on the account

The account page lists the account's own bookings and, once the account has
proved its email address (made by the emailed sign-up link, given a password
by a reset link, or signed in with Google with an address Google verified:
`users.email_confirmed_at`), the bookings made without an account under that
address (`ACCOUNT_BOOKING` in `src/lib/store.ts`; index in migration 0245).
That is where every message about them already went. An address only typed
in, never proved, shows nothing; a phone number never does. Nothing moves:
the booking keeps no account, so the venue's records, limits and any
participant on it are as they were; the account may cancel it, take somebody
off it, and do what My Booking does with it.

Each booking still to come shows what My Booking shows for it, through the
same components (`src/components/BookingPayment.tsx`, `ChangeTime`,
`SplitCost`): a booking held until paid online says *Held* and *Held until
6:45 PM while you pay online*, its price *pay online to keep it*, with the
button to pay (or the venue's deposit); one not held offers paying online
where the venue takes it, and splitting the cost; *Change date or time*.

## Your booking link and QR poster

Venue staff see **their booking link** on the Bookings tab, with *Copy link*,
*Share on WhatsApp* and *Print QR poster*. The link is the venue's page on its
storefront domain if it has one. The poster (`/venue/<id>/poster`) prints the QR
code, the link and three steps in English and Malay, for the counter, the door
or the noticeboard. The QR code is also an image at `/api/venues/<id>/qr`. A
draft venue's link, code and poster are for its own staff only.
