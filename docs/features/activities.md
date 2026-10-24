# Activities

Authoritative for what can be booked: the activity catalogue, how a resource
is modelled for each kind of activity, templates, operators' own activities,
resources offering several activities, staff sign-offs, how activities are
named country by country and found in search, and **how far each activity is
supported**. How a booking of any of them is checked and stored is
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
most per booking (eight unless set; one for a gym that sells a session
each). The database holds the sum of places at every moment within the
capacity, so the last two boards cannot be hired twice. How it is priced is
the venue's choice, per resource (`src/lib/pricing.ts`):

| Model | Price | For |
| ----- | ----- | --- |
| Per place (the default) | The rate for each place booked | Kayaks, boards, bikes, a lane swim, a climbing session |
| One price for the booking (`flatRate`) | The rate once, however many places it takes | A party room, a group package, a lane hired whole |
| Quantity prices (`quantityPrices`) | From so many places, each at a percent of the rate (up to five bands, each larger booking cheaper) | Four boards or more at 90% each |
| Kinds of kit | Each kind is a resource of its own under the activity, with its own price and count | Single kayaks at RM25 and double kayaks at RM40 |

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
log.

**Who it counts for.** A phone number typed into a form proves nothing, so:

| Who is booking | A sign-off counts when |
| -------------- | ---------------------- |
| The customer online (booking, any court, weekly series, waiting list, open games, rescheduling) | They are signed in, and the record is linked to their account (staff named it by email), or names a number their account has proved ([phone checks](../architecture/authentication.md#checking-a-customers-phone-number)). A guest, or an account whose number is only typed, is refused. |
| The venue's staff at the counter, or the venue's own system with its API key | The record names the number booked for: staff answer for who is in front of them. |
| A manager going past the rules | Not asked; recorded in the activity log as an override. |

It must hold on the last day booked (the last week of a series; the new day
of a reschedule). One person's sign-off covers one person: online, a
customer books one place on an activity that asks for one (`SIGN_OFF_EACH`),
and everyone joining an open game needs their own. Classes are not held to
it: they are led by an instructor. Refused bookings say why
(`SIGN_OFF_NEEDED`, `CERTIFICATION_NEEDED`) and point to the counter.
Sign-offs are personal data: they appear in a phone number's export, and
withdrawn ones are deleted after a year ([privacy](../architecture/privacy.md)).

A sign-off is not an [induction](venue-operations.md): an induction clears
somebody to use the venue when nobody is staffing it; a sign-off clears them
to book one activity.

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
`tests/sports.test.ts`, `tests/capacity.test.ts` and `tests/hire.test.ts`.

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
