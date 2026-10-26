# Activities

Authoritative for what can be booked: the activity catalogue, how a resource
is modelled for each kind of activity, templates, operators' own activities,
resources offering several activities, staff sign-offs and registering online
for approval, how activities are named country by country and found in
search, and **how far each activity is supported**. How a booking of any of them is checked and stored is
[booking](booking.md); why activities are data rather than code is
[ADR 0011](../architecture/decisions/0011-activities-as-data.md).
Status: [feature status](../product/feature-status.md#booking-and-availability) (the activity rows).

## The catalogue

Every activity is a row in the `activities` table (migration 0092), not a
name in the code. The booking engine knows nothing about any one activity:
a booking of a badminton court, a climbing session, a kayak or a yoga studio
goes through the same rules, the same prices and the same conflict
protection ([booking concurrency](../architecture/booking-concurrency.md)).

An activity has:

| Field | What it is for |
| ----- | -------------- |
| `key` | Its permanent name in the data (`sepak_takraw`, a slug); what bookings, courts, passes and rules refer to |
| `category` | Racket, team, aquatic (in the pool), water (on the water), fitness, studio (classes and studios), specialist: how search and the dashboard group it |
| `icon`, `names` | Its emoji and its name in English, Malay, Chinese and Tamil |
| `aliases` | Other words people search by (*shuttle*, *bulu tangkis*, *ping pong*, *SUP*, *spin*) |
| `template` | What a new resource for it starts as (below) |
| `policy` | Its usual booking rules, beneath every venue's own: padel's half-hour starts and 90-minute games |
| `surfaced`, `supervised` | Whether a surface is worth naming (a court, not a table); whether it may never run in unstaffed hours (pools, water) |
| `filters` | Which court filters mean something for it in search (air-con for badminton; floodlit for football; none for kayaks) |
| `country` | Per-country names, aliases and filters: *Takraw* in Thailand, *Sipa* in the Philippines |
| `support` | How far MySenam supports it: full, basic or specialised ([support matrix](#support-matrix)) |

The 32 built-in activities live in `src/lib/activity-catalogue.ts` and are
written to the table at every start (`syncActivities`), so a release can add
or correct one. An install's database is what the app reads: it loads the
catalogue on the server (`src/lib/activities.ts`, refreshed every minute) and
hands it to the browser with the page (`src/lib/activity-registry.ts`), so
names, icons and templates come from one place. A key nobody knows is shown
as its own words rather than failing.

Foreign keys tie every use of an activity to the catalogue: courts, bookings,
classes, passes, promo codes, levels, tournaments, leagues, extras,
concessions, sport rules and booking policies cannot name an activity that
does not exist (`23503`).

### Templates, not restrictions

A template is where a new resource starts, nothing more:

| Model | Means | Built-in examples |
| ----- | ----- | ----------------- |
| `exclusive` | One booking at a time | Courts, pitches, a pool hired whole for water polo |
| `lanes` | Several of the same, each booked whole | Table-tennis tables, cricket nets, golf bays, archery lanes, bowling lanes, fencing pistes |
| `shared` | One space with places, several bookings at once | Gym floor, climbing and bouldering walls |
| `class` | A room run as classes with places, booked through its classes (*classes only*) | Yoga, Pilates and dance studios, martial-arts mats, a boxing ring |
| `hire` | A fleet hired by the item | Kayaks, canoes, paddleboards, bikes |

The template also gives the resource's noun (lane, bay, piste, board), its
places, how many to make, whether a court booked whole is priced per player,
whether it is indoor or outdoor, whether a class room is classes only, and
whether a [sign-off](#sign-offs) is asked for by default. The noun, places,
count, per-player pricing, most per booking and indoor or outdoor are in the
form before the resources are made; everything is changeable on each
resource afterwards, and the sign-off in the booking rules. Nothing about a
resource's behaviour depends on which template it came from.

## Setting activities up (dashboard)

All of this is under *Courts* in the dashboard; nothing needs the database or
a hand-made API call.

- **Add resources** (`AddResourcesForm`, `POST /api/admin/courts`): pick an
  activity (grouped by category, with its support level and what is not
  built), and the form fills in from its template. Make up to 20 at a time:
  *8 lanes* become Lane 1 to Lane 8, numbered on from any already there.
  Rates are per hour, or per person where the resource is priced that way.
  The venue's cap on courts counts each one.
- **Add your own activity** (managers): a name in at least English, a
  category and a model; the rest is optional. It belongs to the business
  (every branch), or to the venue where it is in no business, and nobody
  else sees it in their dashboard. It is offered and found in search like any
  built-in one (`POST /api/admin/activities`; the platform owner manages the
  whole catalogue). An activity can be retired: no new resources, but
  everything already booked keeps its name. Built-in activities can only be
  retired, and only by the platform owner.
- **What a resource offers** (`CourtActivitiesEditor`, `PATCH /api/admin/courts/[id]`
  with `activities`): a court can offer several activities. The first is its
  main one; each other can have its own rates or use the court's. An
  activity with bookings still to come cannot be taken off; the main one can
  only be changed, never removed.
- **Booking rules per activity on a resource**: the booking-rules editor
  offers each activity on each court as a level of its own (pickleball on
  Hall A starts on the half hour while badminton on it starts on the hour).
  It also sets a court's own weekly hours.
- **How one booking is priced** (*Courts*, `PATCH /api/admin/courts/[id]`):
  per player, per place, one price for the booking, quantity prices, the
  most in one booking, and classes only ([below](#pricing-a-booking-with-places)).
- **Sign-offs and certifications** (`SignOffsPanel`): [below](#sign-offs).

## One resource, several activities

A sports hall offering badminton, pickleball and volleyball is **one**
resource with three activities (`court_activities`), not three courts. Then:

- It shows under each activity, at that activity's rates if it has its own,
  and under that activity's booking rules.
- It is booked for one activity at a time: a pickleball booking and a
  badminton booking at the same moment are refused by the same database
  constraint as any other overlap, because they claim the same space.
- Each booking records its activity (`bookings.sport`); cancellation cutoffs,
  peak hours, passes, promo codes, reports and the public API read it from
  the booking, not the court.
- Moving or rescheduling stays on courts offering the booked activity.
- A booking for an activity the court does not offer is refused
  (`SPORT_NOT_HERE`).

Where one hall is sold as one futsal pitch *or* four badminton courts, those
are still separate resources sharing a floor
([linked courts](booking.md#courts-that-share-a-floor)).

## Pricing a booking with places

On a resource with places (a gym floor, a wall, a fleet of boards), a booking
says how many it takes — four kayaks, three climbers — up to the venue's
most per booking (eight unless set, or the places if fewer; one for a gym
that sells a session each). The venue sets it per resource (*Courts →
How it is sold*, or when the resources are made, or on an activity's
template) anywhere from one to every place the resource has, so a fleet of
30 kayaks can go to one school trip of 30; it cannot be set above the
places, and when the places are cut below it, it comes down with them. A
court priced per player takes 2 to 50 players. Every way of booking reads
the same limit (`placesPerBooking` in `src/lib/court-activities.ts`): the
booking form, the desk, the venue's own system through the API
(`players`), several kinds of kit booked together (each kind up to its own),
*any court* (the lowest limit among the courts it may pick), and an open
game on the booking, which can look for that many players less the host
(at least ten). The database holds the sum of places at every moment within
the capacity, so the last two boards cannot be hired twice. How it is priced
is the venue's choice, per resource (`src/lib/pricing.ts`):

| Model | Price | For |
| ----- | ----- | --- |
| Per place (the default) | The rate for each place booked | Kayaks, boards, bikes, a lane swim, a climbing session |
| One price for the booking (`flatRate`) | The rate once, however many places it takes | A party room, a group package, a lane hired whole |
| Quantity prices (`quantityPrices`) | From so many places, each at a percent of the rate (up to five bands, each larger booking cheaper) | Four boards or more at 90% each |
| Kinds of kit | Each kind is a resource of its own under the activity, with its own price and count, optionally under one heading | Single kayaks at RM25 and double kayaks at RM40, under *Kayaks* |

**Under one heading.** Kinds of the same thing can be listed under one
heading (*Courts → Under one heading*, or `heading` on the resource;
`courts.heading`, migration 0123): customers then see *Kayaks* on the venue
page's grid with *Single kayak* and *Double kayak* beneath it, together
wherever the first of them comes, the booking form names the heading
(*Kayaks · Single kayak*) and offers the other kinds under it first (*Add
other kinds of Kayaks at the same time*). A heading typed again in other
capitals joins the one already at the venue; a blank takes the resource out
from under it. It is only how they are shown: each kind is still booked,
priced, counted and found in search as itself, several kinds still go in one
booking all or nothing, and availability is each kind's own
(`groupByHeading` and `headedRows` in `src/lib/court-activities.ts`).

Quantity prices apply equally to a court priced per player. A court booked
whole cannot be priced flat (it already is one booking) and a resource with
places cannot be per player (it already counts each place): the database
refuses both. A room run as **classes only** is not sold place by place:
customers book its [classes](programmes.md), which hold the room for their
places, and the venue's staff can still hire the room out.

## Sign-offs

Some activities need staff to have checked somebody first. Two kinds are
kept apart (`src/lib/sign-offs.ts`):

- An operational **sign-off**: the venue's own check — a belay check on a
  climbing wall, a range briefing in archery, a gym induction, a paddling
  competence check.
- A **certification**: a qualification the law or a governing body asks for,
  which staff have seen. It records what was seen (its number and issuer)
  and must have the day it runs out.

The booking rules ask for either at any level: `signOff` (either kind
counts) or `certification` (only a certification counts). Climbing and
archery ask for a sign-off by default; a venue can turn it off, and any
activity can ask for one.

**Each record keeps** the person (name, phone number, and their account
where one is linked), the activity (or anything there), its scope (this
branch, or every branch of the business, which only whoever runs the
business may give or take back), who gave it and when, when it runs out,
and, once taken back, who did it and why. Every change is in the activity
log. Front desk cannot record one for an activity whose approval the venue
set as a safety assessment unless a manager delegated them for it
([who may grant](#registering-online-for-approval)); taking back one an
approval wrote revokes that approval.

**Who it counts for.** A phone number typed into a form proves nothing, so:

| Who is booking | A sign-off counts when |
| -------------- | ---------------------- |
| The customer online (booking, any court, weekly series, waiting list, open games, rescheduling) | They are signed in, and the record is linked to their account (staff named it by email), or names a number their account has proved ([phone checks](../architecture/authentication.md#checking-a-customers-phone-number)). A guest, or an account whose number is only typed, is refused. |
| The venue's staff at the counter, or the venue's own system with its API key | The record names the number booked for: staff answer for who is in front of them. |
| A manager going past the rules | Not asked; recorded in the activity log as an override. The booking stands, but gets no door code without a sign-off in force ([door codes](venue-operations.md#resources-nobody-is-standing-next-to)). |

It must hold on the last day booked (the last week of a series; the new day
of a reschedule). One person's sign-off covers one person: online, a
customer books one place on an activity that asks for one (`SIGN_OFF_EACH`),
and everyone joining an open game needs their own. Classes are not held to
it: they are led by an instructor. Refused bookings say why
(`SIGN_OFF_NEEDED`, `CERTIFICATION_NEEDED`) and point to the counter; where
the venue takes applications online, its page offers that instead
([below](#registering-online-for-approval)).
Sign-offs are personal data: they appear in a phone number's export, and
withdrawn ones are deleted after a year ([privacy](../architecture/privacy.md)).

A sign-off is not an [induction](venue-operations.md): an induction clears
somebody to use the venue when nobody is staffing it; a sign-off clears them
to book one activity. On an unmanned resource the door code also waits for a
sign-off where the activity asks for one
([door codes](venue-operations.md#resources-nobody-is-standing-next-to)).

## Registering online for approval

A customer need not come to the counter just to register for an activity
that needs a sign-off or certification, or to ask for a first lesson
(`src/lib/approvals.ts`; [ADR 0019](../architecture/decisions/0019-approval-requests-apart-from-bookings.md),
[ADR 0020](../architecture/decisions/0020-approval-to-booking-payment-and-authority.md)).
The same workflow serves climbing, kayaking, coaching, equipment hire or any
activity whose rules ask for a sign-off.

**What the venue asks, per activity** (*Courts & rates → Online
applications*, managers): what applicants are told first; questions (some
may be left blank); and one or more verification methods:

| Method | What the customer does | What it records |
| ------ | ---------------------- | --------------- |
| Online declaration | Ticks the venue's words | When it was ticked |
| Documents staff review | Uploads a photo or scan (a certificate, never an identity document: a label naming one is refused) | The image, redrawn as for venue photos, private to the customer and the venue's reviewers |
| Video briefing | Watches a link and confirms having watched it | When it was confirmed |
| In-person briefing or assessment | Comes in (and may book the session online) | Who recorded it and when |

It also says whether the venue's [waiver](venue-operations.md#waivers) must be
agreed (the existing digital waiver, signed once per version), what an
approval writes (a sign-off, or a certification, for which the customer gives
its number, issuer and end date and sends the document), how long an
approval lasts (days, or until taken back), how many days an application may
wait unanswered before it lapses (14 unless set), how many hours a slot asked
for is held (48 unless set), how many hours an approved customer has to pay
for the slot booked where the venue asks payment to hold (24 unless set), and
which of the venue's [coaches](programmes.md#one-to-one-coaching) may review
these applications, each linked to the coach's own MySenam account.

**Who may grant it** ([ADR 0020](../architecture/decisions/0020-approval-to-booking-payment-and-authority.md)).
The venue says, per activity, whether approving is a **safety assessment**
(the default: a belay or climbing competency check, an archery safety
briefing, water-sports competence) or an **administrative check** (that an
application is complete, a membership held):

| Who | Administrative check | Safety assessment |
| --- | -------------------- | ----------------- |
| Manager (or whoever runs the business) | Everything | Everything |
| Front desk | Everything | Ask for more, record the administrative check, refuse, revoke; approve and record the in-person step only if a manager delegated them by name for this activity |
| A coach the venue names for this activity, signed in to their own account | Everything for that activity | Everything for that activity |

Asking, the administrative check, refusing and revoking grant nothing, so any
reviewer may; approving and recording the in-person step grant eligibility.
The same holds in the Sign-offs tab. MySenam certifies nobody: these are the
venue's existing roles and the people it names.

**Applying** needs a signed-in account (an approval is personal), with a
number the venue can reach as for booking. The venue's page lists the
activities it takes applications for. The customer answers what is asked,
declares whether they are 18 or over, and, if not, gives a parent or
guardian's name and their declaration that they agree; this is recorded as
declared, never as verified, and no identity document is asked for. They may
ask for a slot at the same time: a time the court's booking rules allow,
checked against the venue's own limits as a booking would be. One application
per person, activity and venue may be open at a time; somebody approved with
more than 30 days to run cannot apply again until then.

**Statuses** (`approval_requests.status`):

| Status | Means | Waiting on |
| ------ | ----- | ---------- |
| `pending` | Waiting for review | The venue |
| `info_requested` | A reviewer asked something | The customer: their answer (and any document) sends it back to `pending` |
| `in_person_due` | The online part is accepted; the in-person step is still to be recorded | The venue |
| `approved` | Everything asked for is done | — |
| `rejected`, `withdrawn`, `expired` | Refused with a reason; withdrawn by the customer; lapsed, nobody having acted in time | — |

**Reviewing.** The venue's staff review from the dashboard: the bookings tab
shows applications waiting, and *Courts & rates* lists them all. A coach the
venue named for that activity reviews signed in to their own MySenam account,
which a manager links to the coach record (*Courts & rates → Online
applications*); their account's approvals page lists only those applications,
and they can do nothing else of a manager's. The coach's private schedule
link decides nothing. A reviewer can approve, refuse (with a reason the
customer is told), ask for more (the customer answers and it comes back),
record the administrative check, record the in-person step, and revoke an
approval. Where an in-person step is set, approving accepts only the online
part: the application is complete only once staff (or the coach) record the
in-person step, in either order; an online declaration never stands in for
it. Every decision records who made it: the member of staff, or the coach and
the account they decided from.

**Approved**, the application writes the sign-off or certification the
booking rules already check, linked to the customer's account, with the
venue's period as its end (a certification's end is never past the
certificate's own), naming who approved it. Every booking path then works as
it always has; nothing else is unlocked by an application on its own. A
renewal is a new application, linked to the one it renews; the customer is
reminded 14 days before an approval runs out, and past its end the booking
rules refuse it again.

**A slot asked for** is held by an expiring claim of its own kind (`approval`),
which the database counts like any booking while it lasts, until its hours
are up or the slot starts, and is let go on refusal, withdrawal or lapse. On
approval it is rechecked and booked through the ordinary booking path, its
hold let go and the booking claimed in one transaction under the same
constraints; if the hold had lapsed and somebody else took the slot, nothing
is forced or displaced: the approval stands, the customer is told, and they
book another time, or join the waiting list, through the ordinary booking
engine. Where an in-person step is still to come, the slot is booked when the
online part is accepted, as the session at which it is done; that session is
not held to the sign-off, and a customer can book one later from their
account. A pending application never reserves anything beyond its hold.

**Money: approval is eligibility, not payment.** Nothing is charged for
applying or while an application waits. The booking a slot becomes follows
the venue's own payment policy ([paying to hold](payments-and-credit.md#paying-online-to-hold-a-booking)):
where the venue asks payment online to hold a booking, it is held for
payment by the ordinary booking hold for the activity's hours to pay (the
slot reads *booked, waiting for payment*, with the deadline and a pay button
on the customer's approvals page), confirmed when paid, and let go if not
(*not paid in time*; the approval stands). A payment that lands after it was
let go becomes the booking again if the slot is still free, or is owed back.
Where the venue takes payment at the counter, or the booking is free, it
stands as any booking there does. Staff approving may let it stand unheld,
paid at the counter, as an exception on record; a coach may not. The
application's status (`approval_requests.status`) stays apart from the
booking's: an approved application can have a slot booked, waiting for
payment, let go or taken. Refusing or lapsing an application leaves nothing
to refund.

**Access.** Four permissions are kept apart: to record or manage a booking
(staff; a manager past the rules), to take part in the activity (a sign-off
in force, which an approval writes), to receive unmanned access (that
sign-off in force on the day, for the activity booked), and to supervise an
exception (a manager's staff-supervised attendance). A pending, refused,
lapsed or revoked application grants nothing: the booking rules refuse the
activity online, and an unmanned resource's door code is not given until a
sign-off is in force for the person booked, whoever made the booking and
however: online, at the counter, past the rules, through the venue's API
key, as a coach's lesson, or before the approval. An activity the venue takes
applications for needs one at the door even where its booking rules do not
ask for a sign-off. A manager can arrange staff-supervised attendance where
the venue's safety procedures allow it; it is recorded, gets no door code,
and authorises no unmanned use later
([door codes](venue-operations.md#resources-nobody-is-standing-next-to)).
Unmanned facilities can approve remotely wherever the activity sets no
in-person step.

**Revoking.** Staff, or a coach named for the activity, revoke an approval in
force with a reason the customer is told. Its sign-off is taken back at
once, which stops online booking of the activity and its door codes; a
booking it made that is still waiting for payment is let go (a payment after
that is owed back). The person's confirmed bookings of that activity there,
from today on, are not cancelled: they are flagged for staff (*Bookings to
decide* on the bookings tab), who cancel one the ordinary way, arrange
supervision, or keep it, and say which. Taking the sign-off back in the
Sign-offs tab does the same. The customer can apply again.

**Telling people.** The customer is emailed in the language their account
last used when an application is received, asked about, accepted online,
approved (with the booking and, where it must be paid, the deadline),
refused, lapsed or revoked, when a held slot is let go, when a booking made
on approval was not paid in time, when a late payment became the booking or
is owed back, and before an approval runs out; their account page
(*Approvals for activities*, `/account/approvals`) shows each application's
status, what is waiting on whom, its slot, what to pay by when, why an
approval was taken back, and its history. Emails go through the outbox,
which retries a failed delivery; a failure to send never undoes a decision.
The venue's booking-alert address and the authorised coaches are emailed
when an application arrives or is answered.

**The record.** Each application keeps its history (who, when, what and why:
customer, staff member, coach or the system) and every decision also goes in
the staff [activity log](reporting.md), a coach's under their name. Answers,
declarations and documents are personal data: they go out with the customer's
data export, are erased with the account, and documents are deleted 90 days
after the decision ([privacy](../architecture/privacy.md#retention)).

Not built: a parent applying for a child from the parent's own account (a
minor applies from their own, with the guardian's declaration); a coach's
lesson asked for with an application (a slot is court time; a lesson is booked
once approved); PDFs as documents (images only, so they can be redrawn).

## Countries and languages

Each activity's name comes in the four languages, and a country can name it
differently: sepak takraw is *Takraw* in Thailand and *Sipa* in the
Philippines, and is found by either word everywhere. The same per-country
entry can change which search filters make sense. Adding a country's names is
a change to the catalogue entry, not to the code that shows it.

## Search and discovery

- The search page shows every activity bookable as a court, lane or place,
  grouped by category and in the catalogue's order within it, so a rare
  activity is as visible as a popular one. A box finds an activity by any of
  its names or aliases in any language (*takraw*, *spin*, *bulu tangkis*);
  `?q=` does the same in the address and in `GET /api/search`. Activities
  offered only as classes are named there with a link to the Classes page.
- What popularity does not touch: search results are ordered by what the
  customer chose (soonest, nearest or cheapest), among the times free for
  the length asked for, where they asked.
- The court filters offered are the chosen activity's (no floodlit filter for
  a pool); amenity filters are offered for every activity.
- The home page's quick search shows eight activities as buttons and every
  other one in a list beside them. The eight are the most booked over the
  last 30 days at the venues in view (a storefront's, and the chosen area's
  on the home page), then those most venues offer, then the catalogue's
  order (`activitiesByPopularity`).
- Venue pages, Google feeds and the public API list every activity a
  resource offers.

Details of search itself are in [discovery](discovery.md).

## Support matrix

A support level asks one question: can a venue of that kind sell this
activity the way such venues ordinarily do, with what exists? Generic
booking is the floor every activity has: its resources can be set up from
the dashboard, found, booked for time, paid for and protected from double
booking (`tests/activity-coverage.test.ts` does this for every built-in one).

- **Full**: beyond that floor, the way venues of its kind ordinarily sell it
  is a workflow that exists, end to end — a court or lane by time, per player
  or per place, a place in a class, a session with places — with its usual
  rules (lengths, starts, sign-offs) set as booking rules.
- **Basic**: the floor holds and it can be sold, but a way of selling it that
  such venues commonly rely on is not built (named below).
- **Specialised workflow required**: time on its resources can be booked,
  but the way it is normally sold needs a workflow that does not exist.

Sport-specific extras that nobody needs to sell the activity (scoring,
rankings, logbooks) do not count against a level.

**Count:** 32 built-in activities: 23 full, 8 basic, 1 specialised
(`tests/activities.test.ts` holds these numbers).

Tested: `tests/activity-coverage.test.ts` (every built-in, set up from its
template, found and booked as it is sold), `tests/activities.test.ts`
(catalogue, templates, multi-activity resources, places, search),
`tests/hire-pricing.test.ts` (pricing models), `tests/sign-offs.test.ts`,
`tests/approvals.test.ts` (registering online for approval: approval,
refusal, questions answered, expiry and renewal, holds and races on
Postgres, money, who may decide, in-person steps, minors, documents, door
codes), `tests/sports.test.ts`, `tests/capacity.test.ts` and
`tests/hire.test.ts`.

| Activity | Category | Model | Support | Not built |
| -------- | -------- | ----- | ------- | --------- |
| Badminton, tennis, pickleball, padel, squash | Racket | Exclusive court | Full | — |
| Table tennis | Racket | Tables (lanes) | Full | — |
| Futsal, football, basketball, volleyball, netball, floorball, sepak takraw | Team | Exclusive court or pitch | Full | — |
| Cricket | Team | Nets (lanes); a ground for a match as a resource of its own | Full | — |
| Swimming | Aquatic | Lanes with places, per swimmer | Full | — |
| Water polo | Aquatic | Pool hired whole | Full | — |
| Yoga, Pilates, dance, martial arts, boxing | Studio | Rooms run as classes | Full | — |
| Golf simulator | Specialist | Bays (lanes) | Full | — |
| Fencing | Specialist | Pistes (lanes); lessons and club nights as classes | Full | — |
| Gym | Fitness | Floor with places: timed sessions, memberships, passes, inductions | Basic | Entry on a membership without booking a session (walk-in access counted at check-in) |
| Kayak, canoe, stand-up paddleboarding | Water | Fleet hire, per item; kinds of boat or board as resources of their own, booked together with a number of each | Basic | Tide and launch windows |
| Cycling | Fitness | Bike hire (sizes as resources of their own); spin as classes | Basic | Track or velodrome sessions run in heats |
| Climbing | Specialist | Wall with places, per climber, belay sign-off by default | Basic | Open-ended day passes |
| Bouldering | Specialist | Wall with places, per climber | Basic | Open-ended day passes |
| Archery | Specialist | Lanes, per archer, range-briefing sign-off by default | Basic | Scheduling a range officer per session |
| Bowling | Specialist | Lanes by time, per player | Specialised | Selling by the game; assigning a lane on arrival |
| An operator's own activity | Any | Any | Basic until reviewed | Whatever its workflow needs beyond the models above |

Each activity's note is also shown to operators as they pick it. The work to
move basic and specialised activities up is in the [roadmap](../roadmap/roadmap.md).
