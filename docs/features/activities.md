# Activities

Authoritative for what can be booked: the activity catalogue, how a resource
is modelled for each kind of activity, templates, operators' own activities,
resources offering several activities, staff sign-offs, how activities are
named country by country and found in search, and **how far each activity is
supported**. How a booking of any of them is checked and stored is
[booking](booking.md); why activities are data rather than code is
[ADR 0011](../architecture/decisions/0011-activities-as-data.md).

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

The 33 built-in activities live in `src/lib/activity-catalogue.ts` and are
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
| `class` | A room run as classes with places | Yoga, Pilates and dance studios, martial-arts mats, a boxing ring |
| `hire` | A fleet hired by the item | Kayaks, canoes, paddleboards, bikes |

The template also gives the resource's noun (lane, bay, piste, board), its
places, how many to make, whether it is priced per person, whether it is
indoor or outdoor, and whether a [sign-off](#sign-offs) is asked for. Every
one of these can be changed in the form before the resources are made, and
on each resource afterwards; nothing about a resource's behaviour depends on
which template it came from.

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
- **Sign-offs** (`SignOffsPanel`): below.

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

## Quantity: places and hire

On a resource with places (a gym floor, a wall, a fleet of boards), a booking
says how many it takes — four kayaks, three climbers — up to the venue's
most per booking (eight unless set), and is priced per place. The database
holds the sum of places at every moment within the capacity, so the last two
boards cannot be hired twice. Classes are booked through
[classes](programmes.md) and hold the room for their places.

## Sign-offs

Some activities need staff to have seen somebody do it first: a belay check
on a climbing wall, a range briefing in archery, a gym induction, a paddling
competence check. Where an activity's booking rules ask for a **sign-off**
(`signOff`, set like any other rule at any level), a customer without one is
refused (`SIGN_OFF_NEEDED`) and told to book through the venue. Staff record
sign-offs under *Courts → Sign-offs* (`/api/admin/sign-offs`) against a phone
number, for one activity or anything at the venue, with an optional last
day; they can take one back. Staff booking past the rules are not asked for
one. Sign-offs are personal data: they appear in a phone number's export and
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

- The search page groups the activities offered by category, folding to the
  chosen one's group past twelve, and has a box that finds an activity by any
  of its names or aliases in any language (*takraw*, *spin*, *bulu tangkis*).
  `?q=` does the same in the address and in `GET /api/search`.
- The court filters offered are the chosen activity's (no floodlit filter for
  a pool); amenity filters are offered for every activity.
- The home page's quick search shows the eight activities most venues offer
  as buttons and the rest in a list. Activities are ordered by how many
  venues offer them, then by the catalogue's order.
- Venue pages, Google feeds and the public API list every activity a
  resource offers.

Details of search itself are in [discovery](discovery.md).

## Support matrix

What *supported* means:

- **Full**: everything the activity is usually sold as can be set up from
  the dashboard and booked end to end with the existing workflows.
- **Basic**: it can be set up and booked, but part of how venues usually sell
  it is not built; what is missing is listed.
- **Specialised**: booking time works, but the way it is normally sold needs a
  workflow that does not exist yet.

All are tested through the same engine: `tests/activities.test.ts` (catalogue,
templates, multi-activity resources, quantity, sign-offs, search),
`tests/sports.test.ts` (every built-in can be a resource, names, rules),
`tests/capacity.test.ts` and `tests/hire.test.ts` (places and hire).

| Activity | Category | Model | Support | Not built |
| -------- | -------- | ----- | ------- | --------- |
| Badminton, tennis, pickleball, padel, squash | Racket | Exclusive court | Full | — |
| Table tennis | Racket | Tables (lanes) | Full | — |
| Futsal, football, basketball, volleyball, netball, floorball, sepak takraw | Team | Exclusive court or pitch | Full | — |
| Cricket | Team | Nets (lanes) | Full | Whole-ground hire for a match is an exclusive resource made by hand |
| Swimming | Aquatic | Lanes with places, per swimmer | Full | — |
| Water polo | Aquatic | Pool hired whole | Full | — |
| Gym | Fitness | Shared floor with places | Full | — |
| Yoga, Pilates, dance, martial arts, boxing | Studio | Rooms run as classes | Full | — |
| Golf simulator | Specialist | Bays (lanes) | Full | — |
| Kayak, canoe, stand-up paddleboarding | Water | Fleet hire, per item | Basic | Kinds or sizes of boat in one fleet; tide and launch windows |
| Cycling | Fitness | Bike hire; spin as classes | Basic | Track sessions with heats; bike sizes in one fleet |
| Climbing | Specialist | Wall with places, per climber, belay sign-off | Basic | Open-ended day passes; route and grade records |
| Bouldering | Specialist | Wall with places, per climber | Basic | Open-ended day passes |
| Archery | Specialist | Lanes, per archer, range-briefing sign-off | Basic | Scheduling a range officer per session |
| Fencing | Specialist | Pistes (lanes) | Basic | Bout scoring and referees |
| Bowling | Specialist | Lanes by time, per player | Specialised | Selling by the game; assigning a lane on arrival |
| An operator's own activity | Any | Any | Basic until reviewed | Whatever its workflow needs beyond the models above |

Each activity's note is also shown to operators as they pick it. The work to
move basic and specialised activities up is in the [roadmap](../roadmap/roadmap.md).
