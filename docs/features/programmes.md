# Classes and coaching

Authoritative for instructor-led classes and terms, one-to-one coaching, and
the women-only and men-only rule that classes, open games, tournaments and
leagues share. Tournaments and box leagues are in
[tournaments and leagues](tournaments.md); open games and matchmaking in
[open games and matchmaking](matchmaking.md).
Status: [feature status](../product/feature-status.md#classes-and-coaching).

## Classes

A class is an instructor-led session held on a shared facility. While it runs
the resource is **reserved** (a claim on the court for the session's exact
minutes): that time disappears from general booking and
from cross-venue search, and a walk-in attempt is told to enrol instead. A class
cannot be laid over existing bookings, or over another class.

An enrolment is deliberately just a booking with a `class_id`, so it inherits
everything bookings already do — a code, a QR check-in, payment tracking,
cancellation and no-shows — instead of growing a parallel system. The only
override is price: an enrolment is charged the class's per-person rate rather
than the court's hourly one.

Classes can repeat weekly for a term (up to 12 weeks) under a shared `CL-`
series code. Cancelling a class releases every enrolment and returns the hours
to general booking. Staff see a roster per class with each attendee's check-in
state.

**Enrolling somebody else.** A signed-in adult enrols themself, people they
manage, or both; staff at the counter enrol a child the venue knows with a
guardian on the number given ([booking for somebody else](booking.md#booking-for-somebody-else);
`enrolPeople` in `src/lib/store.ts`). Each person gets a place and an
enrolment of their own, at the class price, named on the roster, checked in,
cancelled and refunded as themself; the adult takes a place only when ticked.
All or none: a class with one place left takes neither of two children
(`CLASS_FULL`), and the class row is locked while its places are counted so
two guardians cannot take its last place for different children. Somebody
already enrolled is refused by who they are: the adult by their own number
taking part themself, a child by their id, so siblings sharing a parent's
number are enrolled separately. A women-only or men-only class asks the adult
to confirm it on behalf of the people they enrol. The confirmation goes to
the adult and names each child; their [waiver](venue-operations.md#waivers)
is agreed for each. A full class's waiting list keeps the same people
([waitlists](booking.md#waitlists)).

**One child withdrawn, the others staying.** Each person's enrolment is a
booking of its own, so a guardian withdraws one child by cancelling that
child's enrolment, on the venue's cancellation terms; the sibling's stays,
and the freed place is offered to the class's waiting list. Taking somebody
off an enrolment as if it were a booking of several is refused with that
reason (`ENT_WITHDRAW_CLASS`; [taking one person off a booking](booking.md#taking-one-person-off-a-booking)).

**A class at a members-only venue** is a members' session: each child
enrolled needs their own membership, or a family membership naming them, on
the class's date, not today (`ENT_MEMBERS_PLACE`; `MV6_ENDS_BEFORE` where
theirs ends before it, with where to renew), and so does joining its waiting
list for them ([membership validity](pricing.md#membership-validity)); a parent who is not a member may enrol their member child
([who a venue is for](booking.md#who-a-venue-is-for-public-members-only-private)).


### Terms

A class scheduled weekly can be joined for every session left at once, from
the classes page: *Every week to the end: 8 sessions, RM216*
(`enrolInTerm` in `src/lib/store.ts`). Each session is its own enrolment, as
if joined one by one, sharing a series code so they are confirmed in one
message and paid in one bill. A session that is full, or that the customer
is already in, is skipped and named. Enrolling several people, each session takes all of
them or is skipped and named: never some of a family in one week. When
scheduling a weekly class, the
venue can take a share off each session (up to 50%) for joining the whole
term. A class in the diary can be joined however far ahead it is: the
booking window is for courts, while the venue's house rules on how far ahead
people may book still apply.

## One-to-one coaching

A venue lists its coaches under *Classes → Coaches* (`lib/coaching.ts`): a name,
a line about them, the sports they coach, their fee for an hour, and the days
and hours they take lessons. The venue page shows them under *🎓 Coaching*.
*Book a lesson* (`/venue/:id/coach/:coachId`) offers the times that day when
the coach is working, not already taken, and a court of the sport is free. The
customer picks a length, gives their name and number, and pays the way any
booking is paid. A venue can instead assign the coach itself
([who chooses the coach](#who-chooses-the-coach)).

- **A lesson is a booking.** It goes through `POST /api/bookings` with
  `coachId`, on any free court of the sport, so the house rules, blocked
  numbers, strikes, holds, credit, receipts, cancelling, refunds and reports
  all apply. The coach's fee is added to its price (`bookings.coach_fee`) and
  is its own line on the receipt, *Coaching with Ana Lim*. A promo code comes
  off the court, not the coach's fee. The sales journal files it under
  *Coaching*.
- **Paid from credit** as a court is: a signed-in customer holding credit at
  the venue sees *Pay from my credit balance* on the lesson form, which sends
  `payFromWallet` through the same path (`payBookingFromWallet`): the court
  and the coach's fee are taken from credit and the lesson is paid; with too
  little credit it is booked and stays unpaid, and the confirmation says so.
  Cancelled in time, it goes back to credit as any booking paid that way
  (`tests/lesson-credit.test.ts`, `tests/components/coach-booking-credit.test.tsx`).
- **A coach is in one place at a time.** Each lesson claims the coach for
  its exact minutes (`coach_claims`, under a database constraint that
  refuses two overlapping claims for one coach). A second lesson overlapping
  it, on any court, is refused (*Ana Lim has just been booked*), and the
  court it had picked is let go as if never booked. Cancelling a lesson
  releases the coach. The fee is the coach's hourly fee for the minutes
  booked; lesson starts and lengths follow the court's
  [booking rules](booking.md#booking-rules-starts-lengths-buffers).
- **Weekly lessons**, for a signed-in customer, as with a weekly court:
  *Repeat* on the lesson form books the same time for up to 8 weeks
  (`MAX_RECUR_WEEKS`), and a week the coach or every court is already taken
  is skipped and listed (`skipConflicts`). A lesson can be moved to another
  time, by the customer or staff ([moving a lesson](#moving-a-lesson)),
  and staff can move it to another court at the same time.
- **For somebody else.** A lesson can be booked for people the adult manages
  (or by staff for a child the venue knows), as any booking
  ([booking for somebody else](booking.md#booking-for-somebody-else)): the
  child is the student, checked on their own sign-offs; the adult books, pays
  and is told. The coach's lessons, link and payouts name the student taking
  part (the booking's participants), with the adult's number to reach them.
- Staff see *🎓 Lesson with Ana Lim* on the booking, and the staff calendar
  feed names the coach. *Stop* retires a coach; lessons already booked stand.

### Moving a lesson

A lesson moves the way any booking changes its date or time
([changing the date or time](booking.md#changing-the-date-or-time),
`rescheduleBooking` in `src/lib/store.ts`), with its coach:

- **Its coach goes with it.** Only times the coach takes lessons through
  (their week's hours, not on time off) and is in no other lesson are
  offered (`rescheduleOptions`, `coachFreeSpans` in `src/lib/coaching.ts`),
  as well as times a court of the sport is free; its own time counts as
  free. The coach's time is claimed again with the court's, in the same
  transaction, under the constraint that keeps a coach in one lesson at a
  time: a lesson or a move that took that time first, at the same moment,
  refuses this one (*Ana Lim has just been booked*, `COACH_TAKEN`), and the
  lesson stays where it was. The coach's hours are never passed, not even
  with a manager's override of the court's rules (`COACH_NOT_WORKING`).
- **The customer** moves their own from `/my-booking` up to the venue's
  cancellation cutoff, as any booking; the panel says the lesson keeps its
  coach. They cannot choose another coach (`RESCHEDULE_COACH`).
- **Staff** use *Change time*: front desk or a manager, keeping the coach.
  Giving the lesson to another coach is a manager's change of its own
  ([giving a lesson to another coach](#giving-a-lesson-to-another-coach)).
- **The price** follows the court time as for any booking: unpaid, repriced
  at the new time; paid, kept, the customer unable to move somewhere dearer.
  The coach's fee stays as booked with the same coach.
- **The coach is told** by email, where they have one, once they had heard
  of the lesson (`notifyLessonMoved` in `src/lib/coach-schedule.ts`): the
  old time and the new; given to another coach, the new one hears of a
  lesson booked with them and the old one that it is no longer theirs.
  Before the coach had heard of it, the scheduler's *new lesson* email tells
  whoever has it, at its time then. Their schedule link and calendar feed
  always show it where it is now.

Tests: `tests/lesson-moves.test.ts` (with the coach, refusals, another coach,
paid, the coach told, and a move racing a new lesson for the coach's time),
`tests/coaching.test.ts`, `tests/components/lesson-coach.test.tsx`.

### Giving a lesson to another coach

A manager can give a booked lesson to another active coach of the venue who
coaches its sport, at the same time or with a new one (owner's decision, 27
October 2026; `lib/lesson-coaches.ts`). Customers never change the coach of
a lesson they booked (`RESCHEDULE_COACH`), and the front desk moves a lesson
only with its own coach (`COACH_CHANGE_MANAGER`; no delegation to the desk
fits this, so it is not offered).

- **How.** Under *Change time*, *Coach* above the times: the new coach's
  hours, time off and other lessons decide the times offered, and the change
  goes through the same path as any move (`POST
  /api/admin/bookings/reschedule` with `coachId`), so the court and the new
  coach are claimed in one transaction under the constraint that keeps a
  coach in one lesson at a time: a lesson booked with that coach for the same
  time at the same moment refuses one of the two (`COACH_TAKEN`), and the
  loser is left as it was. A retired coach, or one who does not coach the
  sport, is refused (`COACH_NOT_FOUND`); a coach not taking lessons then,
  `COACH_NOT_WORKING`.
- **The fee.** The new coach's hourly fee for the lesson's minutes replaces
  the old one on the booking (`bookings.coach_fee`, what the coach is owed in
  [what coaches are owed](#a-coachs-own-schedule-no-account-needed)). Before
  anything is changed, the screen shows both fees and the difference
  (`GET /api/admin/bookings/lesson-coach`), and the preview of the move says
  the same.
- **Not yet paid**, the price changes by the difference, up or down.
- **Paid**, the manager chooses (`coachMoney`; refused without,
  `RESCHEDULE_COACH_PAID`):
  - *Keep it as paid*: the price stays; the venue absorbs a dearer coach's
    difference, or keeps a cheaper coach's, and the amount is recorded
    (`lesson_coach_changes.absorbed`).
  - *Adjust it*: a dearer coach's difference becomes an amount owed on the
    booking, paid once, on a receipt of its own filed under *Coaching*:
    at the counter (*RM 20 owed for Ben Tan's fee*, by cash, QR, transfer
    or card, `POST /api/admin/bookings/lesson-coach`), or online where the
    venue takes payment online ([paying the difference online](#paying-a-dearer-coachs-difference-online)); a cheaper coach's goes back the way
    the lesson was paid, through the existing refund paths: to the stored
    credit it came from, owed back on the online payment and sent through the
    venue's refund path, or given back by hand at the counter; each with a
    credit note of its own ([refunds for a cheaper coach](payments-and-credit.md#refunds-for-a-cheaper-coach)).
  The money is settled in the change's own transaction, under the booking's
  row lock: two managers at once settle it once, and a lesson paid meanwhile
  is refused (`RESCHEDULE_CHANGED`) rather than settled on the wrong terms.
  A difference still owed from an earlier change ends with the next one,
  whose terms count from the fee the customer has paid for (`earlierOwed`,
  shown before it is made): a lesson given back to its first coach owes
  nothing and gets nothing back, one given on to a cheaper coach gets back
  only what it paid beyond that coach's fee, and the earlier difference is
  recorded as no longer owed (`owed_cleared_why = 'superseded'`).
- **Refused for money that is not simply the customer's**: a lesson paid with
  a lesson pack (`LESSON_COACH_PASS`: the pack pays only its coach's lessons;
  cancel it, which returns the pack's entry, and book again with the other
  coach paid another way), and one with a deposit or shares others paid
  (`LESSON_COACH_PART_PAID`: cancel and book again). Paying differences
  online leaves these as they are (owner's decision of 28 October 2026: kept
  unless safe and fully tested): a pack's entries, a deposit's own payment
  and receipt, and shares others paid each have their own refund and
  credit-note paths, which a coach's difference would have to be split
  across.
- **Receipts are not rewritten.** A paid lesson's receipt keeps the coach and
  fee it was sold with; an adjustment is its own receipt or credit note. A
  later cancellation gives back only what is left of what was paid (what went
  back for a cheaper coach is left out), credits a difference taken for a
  dearer coach as it credits the lesson (given back the way it was taken: by
  hand, or owed back on its online payment and sent through the venue's
  refund path), and a difference not yet taken is no longer owed.
- **On the record.** The activity log (`lesson.coach_changed`) names who did
  it, from and to which coach, the fees and the money effect; the change
  itself is kept in `lesson_coach_changes` (migration 0188).
- **Who is told.** The customer, by one email in the language they booked in,
  through the outbox: the new coach, the time, and what happened to the
  money; given a new time or court as well, also the venue's usual change of
  time, which they acknowledge. The coaches as for any move: the new one hears of a lesson booked
  with them, the old one that it is no longer theirs.

The court-time part of a paid lesson moved to a dearer time stays as for any
booking moved by staff: kept as paid, the difference not charged.

Tests: `tests/lesson-coach-changes.test.ts` (unpaid, paid kept, paid adjusted
dearer with the difference taken and credited on cancelling, cheaper back to
credit, online and by hand, the refusals, the desk refused, notifications and
their recipients, a change racing a new lesson for the new coach, two
managers at once), on PGlite and Postgres; the screens in
`tests/components/lesson-coach.test.tsx` and
`tests/components/bookings-tab-coach.test.tsx`.

#### Paying a dearer coach's difference online

Where the venue takes payment online, the customer can pay the difference a
change left owed on the venue's own payment page, as well as at the counter
(owner's decision of 28 October 2026; `lib/lesson-coaches.ts`,
`lib/payments.ts` `startCoachDifferencePayment`, migration 0214):

- **Where it is offered.** The coach-change email carries a link to a page
  for that change (`/coach-difference/<token>`, the change's id and a keyed
  hash of it, so it needs no sign-in and names nothing else), and the
  customer's booking page shows the amount owed with *Pay RM 20 online*
  (`GET /api/bookings` `coachDifferences`); both say it can be paid at the
  counter instead. A venue that takes no payment online says the counter
  only (`LESSON_COACH_PAY_OFFLINE`). Both open a page through
  `POST /api/payments/coach-difference` for exactly the amount owed on that
  change.
- **One page at a time.** Each page is an attempt numbered on the change
  (`online_payments.coach_change_id`, `coach_attempt`, unique together),
  opened under the booking's row lock and counted open for 30 minutes
  (`lesson_coach_changes.owed_page_until`): Stripe is asked to close its page
  then; Billplz cannot close one at a set time. A second click while it is
  open goes back to the same page (`LESSON_COACH_PAGE_OPENING` while it is
  being opened).
- **The counter waits for an open page.** Staff see *paying online, page
  open until 10:30* beside the lesson; taking it at the counter then is
  refused (`LESSON_COACH_PAGE_OPEN`) unless they choose *Close their page and
  take it*, which records the page closed (the activity log says so).
- **Paid once.** The gateway's word (callback or return page, in either
  order, any number of times) settles the page once, under the booking's
  lock: if the difference is still owed it is paid (`owed_paid_via =
  'online'`, `owed_payment_id`), on a receipt of its own (`lesson-coach:<id>`,
  *Online (Stripe)*), the lesson's receipt untouched, and the customer is
  emailed the receipt. A payment on a Billplz page after its 30 minutes still
  pays it while it is owed.
- **Failed or expired**, the difference stays owed and nothing is reverted:
  the coach and fee stay the new ones, the counter can take it, and another
  page can be opened.
- **Too late or twice.** Money on a page after the difference was paid (at
  the counter, the page closed to do so, or on another page), after the
  lesson was cancelled, or after it went to another coach again, is owed back
  on that payment, with no receipt and not counted as takings, and refunded
  once through the venue's refund path (Stripe in one click or by the
  scheduler where the venue refunds automatically; Billplz in its dashboard,
  then marked refunded): the M12 pattern
  ([refunds owed](payments-and-credit.md#refunds-for-a-cheaper-coach)).
- **Cancelled after paying online**, the difference's receipt is credited
  with the lesson's (a credit note of its own) and its payment is owed back
  and sent through the venue's refund path with the lesson's.
- **A chargeback lost** on a difference paid online credits its receipt and
  makes it owed again, as a lost chargeback makes a booking unpaid; paid
  again, it has a receipt of its own (`lesson-coach:<id>:2`).
- **The day's figures.** Owed, it counts in the day's expected and
  outstanding figures; paid either way, in collected
  (`GET /api/admin/bookings`).

Tests: `tests/coach-difference-online.test.ts` (Stripe: offered by the email
and the booking page, one page reused, the counter refused while it is open,
paid by callback and return page once, its own receipt, the lesson's
untouched, the figures; an expired Stripe page; a failed Billplz page and
another paid; late money after the counter, with the page closed and after
its time, refunded once by Stripe and marked once for Billplz; a late Billplz
page still paying what is owed; the coach given back and given on to a
cheaper one while owed; cancelled before paying and after, refunded once
with a credit note; a chargeback lost and the difference paid again; a venue
without online payment; a deposit still refused;
two clicks at once, the counter and the gateway at once, callback and return
page at once), on PGlite and Postgres, against stand-ins for Stripe's and
Billplz's APIs only; the screens in `tests/components/coach-difference.test.tsx`.
Not checked against the real gateways: the payments integration is
`INTEGRATION_VERIFICATION_REQUIRED`.

### Who chooses the coach

A venue setting under *Classes → Coaches* (`venues.lesson_coach_choice`,
migration 0189; `GET`/`POST /api/admin/coaches`, managers):

- **The customer chooses** (the default, as before): the venue page lists the
  coaches, and the customer books a named one.
- **The venue assigns**: the venue page lists the coaches for who they are,
  and offers *Book a tennis lesson* for each sport they coach
  (`/venue/:id/lesson?sport=`). The times shown are those when any coach of
  the sport is free (`GET /api/coaching/slots?venueId&sport&date`, every
  coach's own lesson starts together, with the range of their fees). Booking
  (`POST /api/bookings` with `assignCoach: true`) puts on the lesson a coach
  who coaches the sport and takes lessons through its time, the one with the
  fewest lessons that day first, then the lowest id; each is tried under
  their own lock, so two lessons booked for the same time at once get
  different coaches, or, with one coach free, one of them is refused
  (`LESSON_NO_COACH`) and nothing is left booked. The coach given is shown on
  the confirmation. Each week of a weekly lesson keeps the first week's coach
  where they are free. A customer cannot book a coach by name there
  (`LESSON_VENUE_ASSIGNS`; the coach's own page leads to the lesson page);
  staff at the counter still can. A lesson paid with a lesson pack goes only
  to the pack's coach.

Tests: `tests/lesson-venue-assigns.test.ts`, `tests/components/coach-booking-assign.test.tsx`,
`tests/components/coaches-choice.test.tsx`.

### Lesson packs

A pass sold for one coach (*Credit & passes → Multi-visit passes → For:
Lessons with Ana Lim*, `passes.coach_id`, migration 0061). It spends as any
[pass](pricing.md#multi-visit-passes) does (an entry an hour unless set
otherwise, or court time to the minute) on lessons with that coach, court and
coach fee together, and it pays nothing else. A court pass no longer pays a lesson, since the coach's fee
would go unpaid; the customer is told to use a lesson pack or pay another way.
The pack's receipt is filed under *Coaching* in the sales journal. A pack for
one person (*One use covers: One person's place*, held for a child the
holder acts for) pays only that person's lessons
([what a benefit applies to](pricing.md#what-a-benefit-applies-to)). A
lesson is booked as one, the coach's fee included, so nobody is taken off a
lesson on their own: it is cancelled whole.

### A coach's own schedule (no account needed)

On each coach under *Coaches* (`lib/coach-schedule.ts`):

- **Email for lesson alerts.** The coach is emailed when a lesson is booked
  with them and when one is cancelled, once each (`notifyCoaches`, every
  scheduler tick, dedupe keys `coach-new:<id>` and `coach-cancel:<id>`). A
  coach has no language on record, so these are in the install's first staff
  language (`coachLocale`), the lesson's hours as it writes them.
- **Schedule link.** *Make a schedule link* gives the coach a private page,
  `/coach/<token>`, with their lessons for the next 30 days, each student's
  name and number (to call), and whether it is paid, plus a calendar feed of
  the same, `/api/coach-calendar/<token>.ics`, for their phone, its words
  and times in the language the page is read in (`?lang=`). The page says
  it is private and not to be shared. The link is shown to staff once, when
  made, to copy and send: only its hash is kept (`coaches.link_hash`), so the
  dashboard afterwards says only until when it works. It lapses a year after
  it is made (`LINK_DAYS`); *New link* replaces it, and *Withdraw link*
  stops it at once. Neither is listed for search engines. The link
  decides no [approval application](activities.md#registering-online-for-approval):
  a coach the venue names to review those does so signed in to their own
  MySenam account, which a manager links to the coach record.

### Which children a coach sees

A coach sees the children they supervise and no others (ADR 0023, amended
27 October 2026): the participants taking part in their own lessons
(`bookings.coach_id`), on their schedule page, its calendar feed, their
lesson emails and their own lessons file, with the booker's number to reach
them; and the children whose applications they are the named reviewer for,
at the venue that named them, while their coach record is active
(`/api/my/reviews`, [approval reviewers](activities.md#registering-online-for-approval)),
with the documents of those applications only (`/api/my/reviews/document`,
each opening recorded under the coach's name). Not every child at the
venue, not another coach's students, nothing at another venue, no
guardian's other records, and no document beyond what the review route
already allows. Classes name their instructor as text, not a coach record,
so no class roster reaches a coach; the product holds no emergency or
medical details, and none are collected for coaches. Tests:
`tests/coach-scope.test.ts` (own lesson's child named, others not; the
calendar feed, emails and the one-coach file; reviews and documents at the
coach's venue only, not to another coach, not once inactive).

### What coaches are owed

*Reports* shows *Coaches: lessons and fees* for the period: per coach, lessons
that went ahead and their hours, the coach's fees on those paid and on those
not yet paid, and no-shows apart (whether a coach is paid for those is the
venue's call). *Every lesson (CSV)* has one row per lesson for the venue's
books (`/api/admin/coach-payouts`, managers only); *Their lessons (CSV)*
beside each coach (`coachId`) holds that coach's own lessons only, the file
to hand to the coach, naming no other coach's students.
Lessons cancelled late are listed apart, with the coach's fee times the share
the venue kept, for the venue to decide whether the coach is paid for them.
The report says what is owed; paying the coach happens outside MySenam.


### A coach's own week and time off

At their private schedule link (`/coach/<token>`), a coach can also set the
hours they take lessons each week (several stretches a day, to the minute)
and add time off, a day or a stretch of days up to a year ahead
(`setCoachHours`, `addTimeOff` in `src/lib/coaching.ts`). Nobody can book a
lesson with them in time off; lessons already booked then stand, and the
coach is told how many, to ask the venue to move them. Staff see the time
off beside the coach. The link is the coach's key: the venue replaces or
withdraws it as before, and a withdrawn or lapsed link changes nothing. Each
change made at the link is written to the venue's activity log under the
coach's name (no staff account), so staff can see who changed the hours.

## Women-only and men-only

Open games, leagues and classes can be for anyone (the default), women only
or men only; tournaments have badminton's categories — open, women's, men's,
and mixed doubles. Women-only matters most: ladies' nights, muslimah
sessions, and women who would not otherwise join strangers. Men-only exists
too, for contact sports and those who keep apart, so the rule reads the same
both ways.

- **What a player says.** *Woman*, *man* or *prefer not to say*, asked the
  first time it matters — never at sign-up — on *Women's and men's games*,
  and then straight back to what asked. It can be changed on the account
  page, is in the data export, and goes with the account. Nobody else sees it:
  a game shows only its own rule. *Prefer not to say* joins everything open
  to anyone.
- **Open games.** The host chooses *Who can join*. A women-only game must be
  opened by a woman (and a men-only game by a man), so the label cannot be
  used to draw people in. Joining checks the player. *Games* has *Women only*
  and *Men only* chips, and each such game carries a badge.
- **Tournaments.** A women's or men's event takes entrants of that gender; in
  doubles the partner is the same. Mixed doubles is doubles only, and the
  entrant says whether their partner is a woman or a man — it must be one of
  each.
- **Leagues** take the same choice as games; in a league of pairs the
  partner is the same, as declared by whoever joins.
- **Somebody without an account of their own** — a participant a guardian
  enters, or a player staff enter at the counter — has their gender
  declared at entry, where the event or league asks it
  ([who enters and how](tournaments.md#who-enters-and-how)).
- **Classes.** A signed-in customer is checked by their account. A guest
  enrolling without one ticks "I am a woman: this class is for women only" —
  the same self-declaration an account makes. The waiting list asks the same.
- **It is self-declared**, like a player's level: nothing here can prove it.
  A host can remove a player, and venue staff see who enrolled, and that is
  the backstop.
