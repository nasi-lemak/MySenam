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
a facility over its capacity at any moment, partly blocked places and
waiting-list offers included, whatever path wrote it
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
- **Buffers**: minutes kept free before and after each booking, for setting
  up or cleaning. Nobody can book into them. Customers just see the time as
  taken; the staff schedule shows each buffer and what it is for. Buffers
  are not charged; a setup or cleanup **fee** is a separate rule, shown to
  the customer apart from the time ([pricing](pricing.md#prices-to-the-minute)).
  Each booking keeps both its buffers, so two bookings on a court with a
  10-minute buffer after each are 10 minutes apart, and one before and after
  of 10 each make them 20.
- **Notice**: how long before it starts a booking may be made at the latest.
- **The court's own hours**, weekday by weekday, inside the venue's: the
  venue's, closed, or its own opening and closing time for each day.
- **Sign-off or certification**: whether a customer needs a staff sign-off,
  or a recorded certification, for the activity before booking it; online it
  must be on their own account ([sign-offs](activities.md#sign-offs)).

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
database refuses those whoever asks.

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
duplicating it. The occupancy report counts only full blocks, since a partial
one does not remove time from the day.

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
(`customerMayBook()`): a refused number, a members-only venue, the house rules
and the unpaid-bookings limit all apply, so a queue is not a way round them.

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
  sells 90 minutes at least.
  **Staff** use *Change time* on any booking in the Bookings tab, at any
  time before it has finished; a manager may also choose any minute, outside
  the rules ([staff booking outside the rules](#staff-booking-outside-the-rules)).
- Only times free for the whole length are offered (`rescheduleOptions`), its
  own court first, then another court offering the same activity. The booking's own
  time counts as free, so it can slide by a few minutes.
- **The price follows the court time.** Unpaid, it is repriced at the new
  time's rate, up or down, by the same pricing as a new booking. Paid, it keeps what was paid: a customer cannot move
  it somewhere dearer (that would be peak hours at an off-peak price), and
  staff who do have chosen not to charge the difference.
- Refused for a class place (it moves with its class), a lesson with a
  coach, a checked-in booking, or kit still out; and, for a customer, a
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
a ⚠ badge counting that phone number's previous no-shows.

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
  online, it is told to book at the counter instead. Staff bookings are never
  refused.


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
- **Matching is by the phone number on the customer's account** — and, where
  this site checks numbers (*Checking a customer's phone number*), only once
  the customer has checked it, because a number is not identity until
  somebody shows they hold it. Without phone checks, anyone who types a
  number on the list gets in; the editor says so.
- **Members only**: the venue page says *Members only* with the venue's own
  note (how to join, who to ask), and search results carry the badge. Booking,
  enrolling in a class, joining its waitlist, an open game, a tournament or a
  league all need an account that is eligible. Staff still book anyone at the
  counter.
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
- The guest needs an account with that number (checked, where phone checks
  are on). The resident is shown the venue link to send them.

## Free courts and house rules

**A court can be free.** Rates may be RM0 — a condominium's tennis court, a
club's member-only pool lane. A booking that comes to RM0 owes nothing: it
shows as *Free* to the customer and the desk, is never offered online
payment, and does not count towards the cap on unpaid bookings a number may
hold.

**House rules** (*Venues & staff → House rules*, `src/lib/house-rules.ts`) are a
venue's fair-use limits for online bookings, each blank for none:

| Rule | Example |
| ---- | ------- |
| Bookings coming up at once | 2 — a third waits until one is played or cancelled |
| Bookings a week (Monday to Sunday) | 3 |
| Bookings a day | 1 |
| Days ahead they may book | 7 or 60 (0 is today only; blank is the site's 14; up to 90) |
| Days ahead members may book | 21: more than everybody's, so members get first pick |

- **Counted per household.** Everybody the venue's list gives the same unit
  (*Who a venue is for*) shares one allowance: a family in B-07-2 gets two
  bookings a week between them, not two each. Anybody else is counted by the
  number on the booking **and** the account making it, so typing a different
  number does not buy another booking.
- Only court bookings count; a class place is limited by the class.
- Checked when a customer books (every week of a weekly series), and when
  they move a booking to another day. Staff at the counter are not held to
  them.
- The venue page shows them (*House rules: up to 2 a week for each person or
  household; book up to 7 days ahead. Members book up to 21 days ahead.*), and
  its dates stop at the last day the venue takes bookings from whoever is
  looking.
- **Members first.** A member holds a live membership at the venue (or
  another branch of its business). Booking online, that is an account the
  membership is linked to, or whose verified number holds it — not a number
  typed on the booking ([a phone number is not identity](../architecture/privacy.md#a-phone-number-is-not-identity)).
  Inside the members' window everybody else is told how far ahead
  they may book, and that members may book further. The members' window is
  also the outer edge for staff at the counter, for moving a booking and for
  joining a waitlist.
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
