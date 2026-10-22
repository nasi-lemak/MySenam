# Booking and availability

Authoritative for how courts and shared facilities are booked: capacity, linked courts, booking lengths, opening hours, blocks and outages, waitlists, moving, cancelling and who may book.

## Exclusive courts vs shared facilities

Every bookable resource carries a `capacity`:

| Capacity | Behaves like | Example |
| -------- | ------------ | ------- |
| 1 | Exclusive use — one booking owns the hour | Badminton court |
| > 1 | Shared — that many people may hold the same hour | Gym floor, lap pool, class |

Each booked hour takes a numbered *place* (`booking_slots.seat`), and
`UNIQUE (court_id, date, hour, seat)` stops two bookings taking the same
place under concurrent requests — a court is simply the case where the only
place is seat 0. That a resource never holds more than its capacity, net of
partly blocked places and waiting-list holds, rests on the `SERIALIZABLE`
transaction rather than on that key; what this does and does not guarantee is
set out in [booking concurrency](../architecture/booking-concurrency.md). Booking allocates the lowest free place inside
the transaction; if two requests race for it, the loser retries against the
winner's state (bounded), and a genuinely full resource is refused outright.

Capacity cannot be reduced below the places already booked in an upcoming hour,
so shrinking a gym never strands a customer.

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
- Customers and staff see the other courts as booked; the staff grid shows
  which booking has them. *Suspected defect:* two big courts over the same
  small one see each other only at the database: the second big court shows
  free, and booking it is refused as "filling up" (B1 in
  [known limitations](../roadmap/known-limitations.md#suspected-defects)).
- A block, a tournament's courts or a court out of service closes the courts
  it shares the floor with too, and a class on one holds the others.
- It holds under races the same way a single court does: each booked hour is
  mirrored onto the courts it takes as a `shadow` row of the same booking in
  `booking_slots`, written by a database trigger, so the same unique key
  refuses the second booking (`db/migrations/0072_linked_courts.sql`).
  Shadows leave with the booking, and reports count only the court actually
  booked.
- Only courts booked whole can be linked, one level deep (a court that takes
  others is not itself part of one), and a linked court cannot start selling
  places. Linking is refused, naming the first date, while both sides are
  already booked at the same time; what is sold from today on takes the new
  court as soon as it is linked, and lets go when unlinked.

Known limits: utilisation counts the pitch and the courts as separate
sellable hours, so a hall that is busy every evening as a pitch still shows
its badminton courts as sold for those hours rather than as one floor; and a
waiting-list offer holds only its own court.

## How long a booking may be

The usual: one slot (an hour, or half an hour where a venue sells halves) up to
four hours, and a weekly booking of up to eight weeks. A venue can change both:

- **Court by court**, under *Courts → How long one booking may be*: a futsal
  pitch booked for two hours at least, a hall for up to twelve. The grid stops
  a selection at the court's longest, says *2 to 4 consecutive hours per
  booking on Futsal A* on the booking form, and will not book one shorter. A
  booking on *any court* goes to a court that takes that length, and search
  leaves out courts that would not. Search and the waiting list ask for at
  most four hours, so a longer booking is made from the venue's page (B6 in
  [known limitations](../roadmap/known-limitations.md#suspected-defects)). Classes are not held to it.
- **Weeks in one weekly booking**, under *House rules*: up to 26, for a team's
  season or a school's term, staff's bookings included. It is not a fair-use
  rule, so on its own it does not put house rules on the venue page. Where the
  venue limits how far ahead people may book, every week must still fall in
  that window.

## Half-hour bookings

A venue sells its courts **by the hour** (the default) or **by the half
hour**, chosen under *Courts & rates → Booked by* (a manager's setting,
`venues.slot_minutes`, 60 or 30):

- **The grid** shows a column every half hour (8AM, 8:30AM, 9AM…). Customers
  pick consecutive halves, up to the same four hours. A half hour costs half
  the hourly rate, peak or off-peak by when it starts, and the legend says
  the numbers are per half hour.
- **Times** are hours with a fraction (18.5 is 18:30) in `start_hour`,
  `end_hour`, `booking_slots.hour`, `slot_blocks.hour` and the waitlist
  (migration 0042). Each slot row carries its length (`span`), so reports
  count hours sold correctly whichever way the venue sold them. Calendar
  invites, messages and receipts show 6:30 PM.
- **Moving, rescheduling, blocking, waitlists and outages** all work in the
  venue's own slots. Search still offers whole-hour start times, made of a
  half-hour venue's halves.
- **Classes and tournaments stay on the hour.** At a half-hour venue they hold
  both halves of each hour they use.
- **Passes** spend one entry an hour, so a booking with a half hour in it
  (an hour and a half, say) spends the whole of that hour (two entries).
- **Switching to half hours** at any time splits everything already in the
  diary from today on into its two halves, each keeping its place, so
  nothing moves. **Switching back to hours** is refused while anything from
  today on starts or ends on the half hour; otherwise the halves are put back
  together.

## Rules by sport

A venue's cancellation cutoff, late-cancel share and peak hours apply to all
its courts. Where one sport needs its own (tennis cancelled a day ahead while
badminton is two hours; pickleball at peak from 5 PM), *Courts → Rules by
sport* sets it for that sport (`src/lib/sport-rules.ts`). Anything left on
*venue's* follows the venue.

- **Cancellation:** free until the sport's own cutoff; after it, the sport's
  own late-cancel share, or no cancelling online. The booking terms shown
  before booking, `/my-booking` and the venue page say the sport's rule.
- **Peak hours:** the sport's own weekday and weekend windows decide which of
  its courts' two rates an hour costs; the weekend days and holidays stay the
  venue's. Off-peak-only last-minute prices and concessions follow them.

## Booking without naming a court

Courts are chosen cinema-seat style: the grid is a row per court, and tapping a
cell books that court. Courts genuinely differ — a premium court costs more, and
regulars have preferences — so auto-assigning by default would take a real
choice away and make the price column meaningless.

For customers who *don't* mind, an **Any court** row sits above the grid. Each
hour shows the cheapest rate among the courts free that hour (so it reads RM18
in an hour when only the premium court is left), and booking it takes the
cheapest court free for the **whole** slot, not hour by hour — nobody is moved
mid-session. The price on the form is that court's price for the whole time,
not the cheapest hour of each court added up, and a run of hours no single
court is free for cannot be picked.

`createBookingOnAnyCourt()` re-reads the candidate list server-side rather than
trusting the client, orders it by what that slot actually costs (peak-aware, so
the order can differ morning to evening), and walks it: if the cheapest is
taken between choosing and inserting, the next is tried. That is the point of
not naming a court — a race should cost the customer a different court, not the
booking. It stops walking as soon as an error applies to every court equally.

Each attempt goes through the ordinary `createBookingSeries()` path, so the
uniqueness guarantee, seat allocation, trading hours, closures and series
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
`open_hour` and a `close_hour` (defaults 8 and 23, bounds 0–28, past 24 being
after midnight): the first
bookable hour starts at `open_hour` and the last one ends at `close_hour`. That
single pair sizes the customer grid, the admin schedule, the occupancy
denominator, and the hours accepted by booking, class scheduling, slot blocking
and waitlist joins. Cross-venue search clamps the requested window to each
venue's own day, so a 7 AM search only ever returns the venues that are open at
7 AM, and a 2-hour block is only offered if it still finishes by that venue's
close.

Narrowing a venue's day is refused while bookings exist outside the proposed
hours — otherwise a customer would hold a slot the venue no longer sells. Staff
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

Hours may run **past midnight**, to 4 AM at the latest: a close of 26 is 2
AM. Those hours belong to the evening they started on, so a futsal booking
from 1 AM on a Friday night is a Friday booking (hour 25), on Friday's grid,
priced by Friday's rules (after midnight is off-peak unless the venue's
peak window says otherwise), and its check-in, reminders and "has it
started" are worked out from the real time. A day's late hours may not run
into the next day's own opening, so the same moment is never two slots. The
desk sees a 1 AM booking on the evening's date in the Bookings tab.

Every check that used the venue's one pair of hours now asks for that
date's: the grid, booking, moving a booking, blocks, classes, waiting lists,
coaching slots, tournaments and the report's "could have been sold". Changing
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
  messages its customer. *Suspected defect:* the check, the cancellations and
  saving the outage are not one transaction, and classes on a linked court are
  not listed (B4 in
  [known limitations](../roadmap/known-limitations.md#suspected-defects)). *Back in service today* ends it early.

An outage is not a row per hour. The database function `blocks_between`
(first in `db/migrations/0009_outages_suspensions.sql`, redefined since, last in
`db/migrations/0072_linked_courts.sql` as `own_blocks_between` plus linked
courts) answers "what is blocked between these days" with the
hours blocked by hand and every trading hour of every outage, and everything
that asks what is blocked asks it — so availability, search, booking, moving
a booking, the waitlist, the schedule and the reports close the court without
knowing outages exist. Where an hour is both, the hand-made block wins.

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

`slot_blocks` therefore carries a `places` column. `NULL` is the whole
resource, which is the only thing a court can mean and exactly what every
pre-existing row already meant. A number takes that many places out and leaves
the rest bookable, so the hour reads `1/5` rather than closed.

Everything that consults a block resolves it the same way — `COALESCE(places,
capacity)` — so availability, cross-venue search, "any court", booking, moving
a booking, the waitlist and the staff schedule all compare `booked + out`
against capacity instead of asking whether a block exists. A partial block
therefore only closes an hour once it has taken the last place, and only then
does queuing become possible.

Staff cannot take out more places than are free, since that would strand a
booking; the refusal names how many remain. Re-blocking an hour revises it
rather than duplicating it. The occupancy report counts only full blocks, since
a partial one does not remove an hour from the day.

## Waitlists

A full class *or a taken court hour* can still be joined — as a queue. When it
frees up (a booking or enrolment cancelled, or someone ahead dropping out), it
is **offered to whoever has waited longest**, with a secret token and a
30-minute hold. Only one offer is ever live per class, and per resource per
day, so two cancellations do not hand the same place to two people.

Queuing is only offered where a cancellation could actually free the slot. A
blocked, class-reserved or past hour is not queueable, and the booking grid
only turns those cells into a waitlist button when they are genuinely just
taken.

A live offer **holds the place**: the grid shows it taken and nobody can book
it directly for those 30 minutes, so the person offered it does not tap the
link to find it gone. Stale offers are expired whenever the waitlist is read or
written, and by the scheduler every few minutes (`passOnExpiredOffers()`),
which offers each freed place to the next person in the queue, so a place
nobody claims does not sit empty until somebody happens to look.

Joining the queue goes through the same checks as booking
(`customerMayBook()`): a refused number, a members-only venue, the house rules
and the unpaid-bookings limit all apply, so a queue is not a way round them.

Claiming is deliberately a tap rather than automatic on page load, because
unlike check-in it creates a booking that costs money. Claiming enrols the
holder at the class price (or makes an ordinary booking for a court slot,
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

`moveBooking(code, courtId)` re-points the booking and rewrites its
`booking_slots` rows in one transaction, so a move either happens completely or
not at all — a target that is free for three of four hours leaves the booking
exactly where it was. Seats are re-allocated on the target, so a move onto a
shared facility takes the lowest free place; the unique index is still the real
guard, and a racing insert fails rather than double-selling.

A move is refused across venues, across sports, onto the court it is already
on, onto a blocked hour or one a class owns, and for a booking that is
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

`rescheduleBooking(code, { date, startHour, courtId? }, by)` moves a booking to
another day or hour — the same length, at the same venue, for the same sport —
keeping its code, its payment, its extras and any promo. It is the step that
otherwise means cancel, refund and book again, with the risk the slot goes
while the customer rebooks.

- **Customers** change their own from `/my-booking` (*Change date or time*),
  with the code and phone number, up to the venue's cancellation cutoff and
  within the booking window. **Staff** use *Change time* on any booking in the
  Bookings tab, at any time before it has finished.
- Only times free for the whole length are offered (`rescheduleOptions`), its
  own court first, then another court of the same sport. The booking's own
  places count as free, so it can slide by an hour.
- **The price follows the court time.** Unpaid, it is repriced at the new
  time's rate, up or down. Paid, it keeps what was paid: a customer cannot move
  it somewhere dearer (that would be peak hours at an off-peak price), and
  staff who do have chosen not to charge the difference.
- Refused for a class place (it moves with its class), an open game with
  players in it, a checked-in booking, or kit still out.
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
exceptions. Cancelling a series drops only the sessions still outside the
window.

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
- **Members first.** A member is a number holding a live membership at the
  venue (or another branch of its business): the number on the booking or the
  account's. Inside the members' window everybody else is told how far ahead
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
