# Booking time model

Authoritative for how court time is stored and protected: intervals, spaces,
claims, booking policies, how prices are worked out from minutes, and how the
half-hour diary was migrated. The decision is
[ADR 0010](decisions/0010-interval-booking.md); what customers and staff see
is [booking](../features/booking.md) and [pricing](../features/pricing.md);
what holds under concurrent requests is
[booking concurrency](booking-concurrency.md).

## In one paragraph

Every reservation is an exact interval to the minute. What occupies a court
(a booking, a held booking, a waiting-list offer, a class, a block, a
tournament's hold, an outage) is a **claim** on it. The database refuses two
claims that overlap on the same **space** (an exclusion constraint), two
closer than the larger of the **separations** they keep (a second one),
more claims than a shared facility has **places** (a trigger), and anyone in a
facility while it is **turned over** whole (two more). Which intervals a
customer may pick is a **booking policy**, inherited from the most specific
level that sets each rule. The booking board's grid is a way of showing
time, not of storing it.

## Time

- **Minutes of the business day.** `bookings.start_min`/`end_min`, and the
  same on classes, blocks, waiting-list entries, tournaments and coach
  hours, count minutes from the venue's midnight on `date`, up to 1680
  (04:00 the next morning, `LATEST_MINUTE` in `src/lib/interval.ts`). A
  booking from 23:30 to 01:00 is minutes 1410–1500 of the evening it
  started.
- **Moments.** Each claim's `during` is a `tstzrange` of real instants,
  half-open `[start, end)`, worked out from the business date, the minutes
  and the venue's time zone (`instantOf`, `rangeLiteral`). Bookings also
  carry `starts_at` and `ends_at`. Checks on the table keep both ends on a
  whole minute.
- Opening hours, peak windows and court hours are minutes too
  (`venues.open_min`/`close_min`, `week_hours`, `peak_*_min`).
- **Where the clocks change.** A zone's offset is read from the runtime's
  zone database (Intl), moment by moment, never from rules written here. On
  the day a zone changes its clocks, a wall-clock minute the clocks go
  forward over never happens (*skipped*) and one they go back over happens
  twice (*repeated*) (`clockProblem` in `src/lib/time.ts`). A booking that
  starts or ends at such a minute, or runs across the change, would last more
  or less than it says and could mean two moments, so it is not sold: its
  starts are not offered, and asked for anyway it is refused
  (`CLOCK_CHANGE`), a manager's override included. Either side of the change
  everything is as any other day, an hour on the clock an hour held. No
  country MySenam is sold in changes its clocks
  (`tests/clock-changes.test.ts` checks London, New York and Sydney on their
  2026 changes).

## Spaces: courts and the courts they share a floor with

- `spaces`: one per court that takes one booking at a time (capacity 1).
  `court_spaces(court_id, space_id)` says which spaces a court covers: its
  own, and, for a court over others (a futsal pitch over four badminton
  courts, [linked courts](../features/booking.md#courts-that-share-a-floor)),
  theirs too.
- Booking a court claims **every** space it covers. A pitch conflicts with
  each court under it; two pitches over the same court conflict through its
  space; two courts under one pitch do not conflict with each other. No
  shadow rows and no seat numbers.
- The database keeps a court's own space in step with its capacity, however
  the court is written (trigger `courts_own_space`, migration 0090): made
  with capacity 1, it gets one; turned into a shared facility, it loses it.
  Links add and remove other courts' spaces (`src/lib/court-links.ts`).
- Shared facilities (capacity above 1: a gym floor, a kayak fleet) have no
  spaces. Their claims hold a number of places.

## Claims

`claims` (migration 0089, `src/lib/claims.ts`):

| Column | Meaning |
| ------ | ------- |
| `kind` | `booking`, `offer`, `class`, `block`, `outage`, `move` (an open game's proposed new time) or `approval` (a slot held for an [approval application](../features/activities.md#registering-online-for-approval), migration 0114), with exactly the matching `booking_id`, `waitlist_id`, `class_id`, `block_id`, `outage_id`, `move_id` or `approval_id` |
| `court_id`, `venue_id` | What was claimed; a trigger (`claims_belong`) refuses a court of another venue, a space the court does not cover, places on an exclusive court and spaces on a shared one |
| `space_id` or `places` | One claim per space for an exclusive court; one claim with a number of places for a shared facility |
| `during` | The time sold or held |
| `occupied` | `during` widened by `buffer_before`/`buffer_after`: the operational time (setup, cleaning) as it was when the claim was made; on a shared facility turned over per place, its separation too, by its turnover ([shared facilities](#shared-facilities-how-they-are-turned-over)). Claims made before migration 0118 keep the buffers they were made with here |
| `separation_before`, `separation_after` | The minimum separation the claim keeps, as it was when made (0 to 240 minutes; 0 for claims made before migration 0118) |
| `facility_wide` | Made on a shared facility turned over whole (migration 0131): `occupied` is `during`, `buffer_before`/`buffer_after` are the setup and cleaning the whole facility needs, and the separation is kept by the whole facility; false for every claim made before |
| `active` | Cancelling, releasing or expiring a claim sets it false; the row stays for history |
| `expires_at` | When a waiting-list offer, a proposed move or an approval application's hold lapses (an `approval` claim always has one) |

- **Exclusive space**: `EXCLUDE USING gist (int4range(space_id, space_id,
  '[]') WITH &&, occupied WITH &&) WHERE (active AND space_id IS NOT NULL)`.
  `int4range(id, id, '[]') &&` is equality, so no extension is needed on
  Postgres or PGlite. A refused claim raises `23P01`, which `isConflict`
  recognises and each path turns into "taken".
- **Separation on a space**: triggers on `claims` (migration 0119) write
  each claim on a space into `claim_gaps` as its time (`during`, role
  `[0,0]`) and the separation it keeps before and after (role `[1,1]`), and
  `claim_gaps_apart` (`EXCLUDE USING gist (int4range(space_id, space_id,
  '[]') WITH &&, role WITH -|-, zone WITH &&) WHERE (active)`) refuses a time
  and a separation that overlap on one space. `-|-` holds only between
  `[0,0]` and `[1,1]`, so two separations may overlap (they do not add up)
  and two times are left to `claims_no_overlap`. A gap shorter than the
  larger of two facing separations is shorter than one of them, so this is
  exactly the rule in [buffers](#buffers-separation-and-operational-time). It
  raises `23P01` like the other, waits on a concurrent writer as the other
  does, and reads nothing, so it takes no serializable predicate locks; a
  claim's rows are released, moved and deleted with it by the same triggers.
- **Shared capacity**: `claims_capacity` locks the court row
  (`FOR NO KEY UPDATE`, which does not wait on the key-share locks the
  foreign keys of the rows being written take), sweeps the places held over
  the new claim's `occupied` range, and raises `23P01` if the peak would pass
  the court's capacity. A partly blocked facility is a block claim of some
  places. The lock serialises writers on one facility only.
- **A facility turned over whole**: triggers on `claims` (migration 0131)
  write each claim with places into `facility_gaps`, and two exclusion
  constraints keyed by the court, like `claim_gaps_apart`, refuse anyone's
  time where a facility-wide claim keeps the facility clear, and setup on top
  of cleaning ([shared facilities](#shared-facilities-how-they-are-turned-over)).
- **Coaches**: `coach_claims(coach_id, booking_id, during)` with the same
  exclusion on `coach_id`, so a coach is never in two lessons at once.
- **Outages** claim whole business days: from the end of the previous day's
  late hours to the end of the last day's (or open-ended, for *until further
  notice*), so a court out of service is out for every minute it could have
  been booked (`claimOutage` in `src/lib/outages.ts`).
- **Reading**: `occupantsOn(courts, date)` returns every active claim on the
  courts (and the courts sharing their spaces) for a business day, with its
  minutes, kind, reason and places. Availability, search, waiting lists,
  moving, rescheduling, the staff schedule and the reports all read it;
  `fits`, `peakPlaces` and `freeStretches` answer "is this free" in memory,
  by the same rules the database applies (`fits` on a space: no `occupied`
  overlaps, and every neighbour `separated`; on a shared facility, places
  over `occupied`, and nothing in a facility while it is turned over whole).
  Each occupant's `kept` (its time widened by the larger of its operational
  time and its separation) is what the board's cells, the staff schedule's
  buffers and a block's placement treat as held; `clearZones` is the time a
  facility turned over whole is closed to everybody.

## Booking policies

What may be booked is kept apart from what can be stored
(`src/lib/booking-rules.ts` for the rules, browser-safe;
`src/lib/booking-policy.ts` for storing and resolving them; table
`booking_policies`).

| Setting | Default (platform) | Notes |
| ------- | ------------------ | ----- |
| Starts every / first start past the hour | 60 / 0 | Or only at listed times (18:00, 19:30, 21:00) |
| Lengths go up by / shortest / longest | 60 / 60 / 240 | Or only listed lengths (60, 90, 120) |
| Length offered first | 60, or the shortest | What the board picks on a tap |
| Minimum separation before / after (`bufferBefore`, `bufferAfter`) | 0 / 0 | Time kept free that two neighbours share: the larger of the two facing ones applies ([buffers](#buffers-separation-and-operational-time)) |
| Operational time before / after (`operationalBefore`, `operationalAfter`) | 0 / 0 | Setup and cleaning that need the court: adds up with the neighbour's |
| What a shared facility's buffers apply to (`turnover`) | `place` | Each place a booking takes, added together (`place`) or the longer (`unit`), or the whole facility (`facility`); ignored on a court of one place ([shared facilities](#shared-facilities-how-they-are-turned-over)) |
| Court's own hours by weekday | the venue's | Within the venue's day |
| Book at least this far ahead | 0 minutes | Notice |
| Each part at its own rate, or all at the rate when it starts | each part | `rateMode` |
| Charge by steps of / at least (minutes) / at least (amount) | none | Rounding and minimums |
| Prices for set lengths | none | 90 minutes RM40, RM55 when it starts at peak |
| Setup fee / cleanup fee | 0 | Shown apart from the time |

- **Inheritance, setting by setting**: a court's own, else its sport's at
  the venue, else the venue's, else its business's (every branch), else the
  platform's for the sport, else the platform's (`resolvePolicy`). Padel's
  platform setting is from any half hour, in half hours, 90 minutes first
  (`SPORT_POLICY`). Clearing a setting goes back to inheriting it; a level
  with nothing set is removed.
- **Who sets them**: managers of the venue, in *Courts & rates → Booking
  rules* (`BookingPolicyEditor`), or `POST /api/admin/booking-policies`. The
  business level needs the owner or a manager of that business. Changes are
  in the activity log.
- **Checking a request** (`policyBreaches`): the start, the length, the
  court's hours that day, and the notice. A customer request that breaks one
  is refused, naming the rule (*Bookings on Court 1 start on the hour*).
- **Staff past the rules**: a manager may book, move or reschedule outside a
  policy (`override: true`; the board's *Book outside this court's rules*).
  The booking is marked `policy_override` and the activity log records who
  and what (`booking.override`). Front-desk staff and customers may not. No
  one, override or not, books over a claim or into a buffer: those are the
  database's to refuse.
- **The board** draws columns of a sensible width for the policy
  (`gridMinutes`: the start step where it is 15 to 60 minutes, else the
  largest such that divides it), at the finest any court of the sport needs.
  A cell is free, partly held or held. Availability also gives each court's
  `starts`: every minute a booking may start and the longest it may run from
  there, with the `lengths` that fit where not every length up to the
  longest does (joining a session on a facility turned over whole:
  `startLengths`, `startTakes`).

## Buffers: separation and operational time

Two kinds of time are kept around a booking, set apart in a booking policy
and stored apart on each claim:

| | Minimum separation | Operational time |
| - | ------------------ | ---------------- |
| What it is for | A gap between bookings: changeover, players leaving and arriving | Work that needs the court: setting up or preparing before, cleaning or turnover after |
| Policy settings | `bufferBefore`, `bufferAfter` (the editor's *Minimum gap before / after*) | `operationalBefore`, `operationalAfter` (*Setup before*, *Cleaning after*) |
| Two neighbours | Share it: they need the **larger** of the two that face each other. 10 after one and 10 before the next: 10 apart; 10 and 25: 25 | Add up: 10 minutes of cleaning after one and 10 of setup before the next: 20 apart |
| On the claim | `separation_before`, `separation_after` | In `occupied` (`buffer_before`, `buffer_after`) |
| Enforced by | `claim_gaps_apart` ([claims](#claims)) | `claims_no_overlap` |

So between the end of one booking's time and the start of the next's, a
court of one place needs the larger of: the operational time after the first
plus the operational time before the second; the first's separation after;
the second's separation before. 5 minutes' cleaning inside a 15-minute
separation needs 15; 10 + 10 of setup and cleaning with 15 of separation
needs 20. Separation is measured between the times sold, so operational time
on either side counts towards it.

- **Against anything.** A booking's separation keeps every other claim's time
  away, blocks, classes, outages, offers and held moves included; those keep
  none of their own (classes and waiting-list offers keep their court's, as a
  booking would).
- **Linked courts.** Checked per space: a pitch keeping 25 minutes after it
  keeps them on every court under it.
- **Shared facilities.** What the two apply to is the facility's turnover:
  each place a booking takes, or the whole facility
  ([below](#shared-facilities-how-they-are-turned-over)).
- **A game's proposed move** (lib/store.ts) holds its new time with its
  operational time, and its separation on its outer edges less the
  operational time it already holds there; beside its own booking it holds
  only what that booking does not already keep, so the booking's separation
  never refuses its own move. On a facility turned over whole, it keeps the
  facility clear on its outer edges as a session would, less what its own
  booking already keeps.
- **Changing the rules** changes new claims only. Each claim keeps the
  separation and operational time it was made with.
- **Before migration 0118** there was one kind of buffer, *kept free*, held
  in `occupied`, so two bookings with 10 minutes each on the side they met
  were 20 apart. The policy settings (`booking_policies.buffer_before`,
  `buffer_after`) kept their values and are minimum separation from then on;
  claims made before keep their buffers in `occupied` (nothing stored was
  shrunk or rewritten) with no separation of their own, so each still keeps
  free what it kept, and a claim made since may start 10 minutes after one
  that keeps 10 and itself keeps 10 before. Migration 0119 writes each
  existing claim on a space into `claim_gaps` as its time alone, which cannot
  conflict (`tests/separation-migration.test.ts`).
- **Where the clocks change**, the database measures a gap in real minutes
  and the board in minutes on the clock; across a change they differ, and
  the database decides (no country MySenam is sold in changes its clocks).

## Shared facilities: how they are turned over

Resources hold bookings in different ways, and their buffers are not forced
into one rule:

| Capacity model | What it is | How it is held |
| -------------- | ---------- | -------------- |
| Exclusive resource | One booking at a time: a court, a lane, a room | Spaces; separation shared, operational time added up ([buffers](#buffers-separation-and-operational-time)) |
| Shared-capacity facility | Many customers at once on fungible places: a gym floor, a climbing area | Places, by the turnover the venue chooses (below) |
| Fleet or equipment inventory | Separate units of a kind: single and double kayaks | Each kind a resource with places, under one heading ([kinds of kit](../features/activities.md#pricing-a-booking-with-places)); the units of a kind are fungible places, turned over per place |
| Per-unit turnover | Each unit needs its own turnaround: a kayak rinsed and checked | `place` or `unit`: the places a booking takes are held over it; the others stay sellable |
| Facility-wide turnover | The whole facility is cleared or prepared between sessions | `facility`: nobody is in it while it is |

A booking policy's `turnover` (inherited like every setting; *On a shared
facility, setup, cleaning and gaps are for* in the editor) says which, for a
resource with places:

| `turnover` | Held | Between two bookings on one place, or two sessions | Exact? |
| ---------- | ---- | -------------------------------------------------- | ------ |
| `place` (default) | Each booking's places, over its operational time **plus** its separation each side (`occupied`) | The sum of all four: 10 minutes' gap either side and 10 of cleaning after make 30 | Conservative: as every claim with places was held before migration 0131, so nothing became more sellable unless a venue chose |
| `unit` | Each booking's places, over the **longer** of its operational time and its separation each side | The longer each side, added: the same rules make 20; operational time alone (a kayak rinsed for 10 minutes: out until 11:10, the others sellable) is exact | Exact for operational time alone; with separation, the least any count of places can hold (below) |
| `facility` | The places for its time only; the whole facility clear for its separation, setup and cleaning (`facility_gaps`) | As on a court of one place: separations shared, the larger counts; setup and cleaning add up. 15 of cleaning and 5 of setup with a 10-minute gap: 20 | Exact |

**Facility-wide turnover.** A claim made under `facility` is `facility_wide`:
it holds places for its time only, and keeps the whole facility clear before
and after it for the longer of its setup and its separation, and of its
cleaning and its separation. Bookings in the same session share the
facility's places (counted by the capacity trigger); nobody's time may be
where any of them keeps it clear, so a session's cleaning keeps everyone out,
a booking that runs on past the end of a session is refused, and joining a
session under way is refused where it needs the facility set up first. Two
cleanings after one session overlap (one task, the longer counts), as do two
setups. In the database, `facility_gaps` holds each claim with places as its
time (`side [0,0]`) and each facility-wide claim's zones kept clear
(`side [1,1]`); `facility_gaps_clear` refuses a time and a zone that overlap
on one court, and `facility_gaps_work` refuses cleaning and the next one's
setup that overlap (roles `work [1,1]` and `[2,2]`). Constraints that read
nothing, like `claim_gaps_apart`: `23P01` whatever writes the claim, a
concurrent writer waited on, no serializable predicate locks.

**Sessions and cohorts.** A scheduled session is `facility` with the
policy's listed start times and lengths: everyone in it starts and ends
together and the facility turns over between sessions. A cohort (a group in
one booking: four kayaks, a school's thirty climbers) is the booking's places,
turned over together, per place. Joining a session on the board is offered
for the lengths that end with it: `starts` lists the `lengths` that fit where
a shorter booking, cleaned while the session runs on, would not.

**Why per place is not exact with separation.** Places are fungible, so
nothing says which booking follows which on a unit. Separation measured
between two bookings on one unit would need the database to find an
assignment of bookings to units, a scheduling question no count of places
answers. A count can only hold each booking's own time around it; for every
pair (a block keeping nothing included) to be at least as far apart as both
ask, each side must hold at least the larger of its operational time and its
separation, which is `unit`. Counting a gap only once between overlapping
zones does not do it either: of three bookings of one place on two units,
each pair can be too close to share a unit (the first ends at 10:00 keeping
30 minutes after; the second starts at 10:25 keeping 15 before; the third
starts at 10:35 keeping 40 before) while no moment has more than two places
held, or held and kept, so such a count would sell three where two units
cannot take them. Exact shared separation on
fungible places stays out; venues that need it exact use `facility`, or set
the turnaround as operational time with `unit`.

**Mixing.** A facility whose turnover changes, or whose activities' policies
differ, holds claims of both kinds. A per-place claim's time keeps out of
every facility-wide zone, and what it holds around its time counts as setup
before and cleaning after against the whole facility's cleaning and setup
(roles `work [0,0]` and `[3,3]`), though part of it may be a gap: never closer
than either asks. Blocks, outages and claims made before keep nothing of
their own beyond their time and what they hold. Each claim keeps what it was
made with when the setting changes.

**Showing it.** The board's cells read held for the time a facility is kept
clear (partly held where it covers part of a cell), with no reason given to
customers; staff see it as *Kept free* with the booking it belongs to; blocks
are placed either side of it, and an outage's late hours are claimed around
what each claim keeps (`kept`), not only what it holds.

## Prices from minutes

`priceBooking` in `src/lib/pricing.ts` is the one function quotes, bookings,
weekly series, moves, reschedules and refunds price through:

- **Pro rata by default**: the minutes booked, each part at the rate in
  force then. Boundaries are the peak window's start and end (to the minute,
  per sport and per day, holidays as weekends) and the last-minute window's.
- **Arithmetic** in the currency's minor units, as whole numbers (rate ×
  minutes × percent), rounded once, half up, per booking.
- **Policy options**: the whole booking at the rate when it starts; a set
  length priced outright (its peak price when it starts at peak); billing in
  steps or at least so many minutes (the extra minutes priced at the rate in
  force then); a minimum charge; setup and cleanup fees, kept in
  `bookings.fee_amount` and shown apart from the time.
- **Member and tier prices**, per-player courts and last-minute prices apply
  to each part; concessions and promo codes discount the court time, not the
  fees.
- **The quote**: `GET /api/quote` returns the same figures the booking will
  be charged, with each part, before anything is booked; the board shows it.

## Passes

A pass is a session pass or a time pass (`passes.kind`, `passCost` in
`src/lib/pass-rules.ts`):

- **Session pass**: one entry per `entry_minutes` booked or part of them
  (60 for passes sold before, which is the rule they were sold under; 60 for
  new ones unless set), or one entry a booking whatever its length when
  blank.
- **Time pass**: the minutes booked, to the minute.
- Either may cap the length of a booking it pays for (`max_minutes`).
  Refunds return exactly what was spent.

## How each feature works on claims

| Feature | On claims |
| ------- | --------- |
| Booking, held bookings | Policy checked, then the booking and its claims inserted in one transaction; a held (unpaid) booking's claims lapse with it |
| Any court, several courts | Each court tried in turn / all in one transaction; one refusal undoes the lot |
| Weekly bookings | One booking and its claims per week; a savepoint around each week turns a `23P01` into a skipped week when skipping is asked for |
| Shared facilities | Place claims under the capacity trigger |
| Classes | One claim per session on its court (every space, or every place); enrolments count against the class's own capacity |
| Blocks, repeating blocks, rain-outs, tournament holds | A `blocks` row, any minutes, and its claims; re-blocking revises rather than stacks; a block made while a booking lands is retried around it |
| Outages | Claims for whole business days, open-ended allowed |
| Waiting lists | Entries keep the minutes wanted; an offer is a claim with `expires_at` |
| Moving, rescheduling | The booking's claims released and claimed again in one transaction, so a booking may slide over its own old time |
| Coaching | Lesson claims for the court, coach claims for the coach |
| Search | Candidate starts from each court's policy, one read of the day's claims for the candidate courts, a sweep in memory |
| Reports, exports, feeds, messages | Minutes from the booking; moments from `starts_at`/`ends_at` |

## API compatibility

- Requests may give `start` and `end`, or `start` and `minutes`, as minutes
  of the day or `HH:MM`; or, as before, `hours`: starts of the board's
  columns, end to end, joined into one interval (`readTime` in
  `src/lib/api.ts`, `spanFor` in `src/lib/store.ts`).
- Public API bookings and webhooks keep `startHour` and `endHour` (hours,
  possibly fractional) and add `startMin`, `endMin`, `startsAt` and
  `endsAt`. Availability adds `policy`, `starts` and `grid` beside `slots`
  ([external API](../integrations/external-api.md)).

## Migration from the half-hour diary

Three migrations, each in its own transaction, with a check run by the app
between them (`src/lib/db-steps.ts`, run by `migrate` in `src/lib/db.ts`
straight after the named migration's SQL; a step that throws undoes the
migration):

1. **0089** adds minutes beside the decimal hours, spaces, `blocks`,
   `claims`, `coach_claims`, `booking_policies`, the pass columns, and turns
   today's settings into policies (a venue or sport sold by the half hour
   starts and runs in half hours; a court's shortest and longest booking are
   its own). Its step stages each venue's time zone as the app works it out.
2. **0090** turns the diary into claims: bookings holding the diary, blocks
   (half hours alike joined into one block), outages, classes and coaches'
   lessons. It refuses a booking whose diary is not one stretch of exactly
   its own time. Its step then compares, for every court and half hour the
   diary had anything in, what the diary held with what the claims hold, and
   that every claim's moments come back to the minutes they were made from;
   any difference stops the migration with nothing changed.
3. **0091** drops `booking_slots`, `slot_blocks`, `coach_slots`, the shadow
   trigger, `blocks_between` and the decimal-hour and slot-length columns. It
   only runs once 0090 and its check have committed.

Classes and outages are claimed more widely than the diary showed them (a
class always held its court; an outage now takes whole days), so the check
confirms they are there rather than that they match. Outages migrated from
the diary cover whole calendar days of the business date; new ones cover the
late hours as well. Staff close a migrated outage's missing late hours from
*Out of service* where they are free, any booking sold there since being
listed and left alone
([legacy installs](../archive/migrations/legacy-installs.md#outages-from-before-migration-0090)).

**Backup and rollback.** 0091 is destructive and there is no
down-migration. Take a backup before upgrading (`npm run backup`); rolling
back is restoring it and deploying the previous version
([deployment](../operations/deployment.md#upgrading),
[backups](../operations/backups.md)). The backup's contents check counts
`claims` among the tables a backup must have.

## The owner's decisions, and the defaults chosen

The owner decided (October 2026):

1. **Interval storage** with database-level conflict protection, linked
   resources, concurrent and atomic multi-court bookings included.
2. **Minute-level bookings for customers** wherever a court's rules permit,
   with sensible default increments, configurable per resource. Staff may be
   allowed past scheduling rules, never past a physical conflict, and that
   is audited.
3. **Pro-rata pricing by default**, with fixed-length prices, minimum billed
   minutes, minimum charges and other rounding as options; the final price
   shown before confirming; exact money arithmetic.
4. **Several pass models**: time passes spend the minutes booked; session
   passes spend entries by their own rules; passes already sold keep theirs.
5. **Buffers are unavailable time**, not shown to customers as such, shown
   to staff with their reason; not charged, though disclosed setup or
   cleanup fees may be.
6. **Peak boundaries to the minute**, a booking priced across several rate
   periods, consistently for quotes, rescheduling, refunds, passes and weekly
   bookings.
7. **Drop the old tables** once migration, integrity and regression checks,
   and backup and rollback, are in place.
8. **Minimum separation does not add up; operational time does** (decided
   later in October 2026, replacing the default that buffers side by side add
   up): two neighbours need the larger of the separations that face each
   other, while setup and cleaning are set apart and add up; existing
   *kept free* settings became minimum separation; existing claims keep the
   protection they were made with; the database still refuses every
   violation ([buffers](#buffers-separation-and-operational-time)).
9. **Shared facilities by their capacity model** (decided later in October
   2026): exclusive resources keep rule 8; a shared facility's turnover
   applies to each place a booking takes or to the whole facility, as the
   venue says in its booking rules (inherited, defaulting to what was done
   before so nothing becomes more sellable without the venue choosing);
   separation is not added where it need not be, operational time that needs
   its own duration is kept; units are not invented for fungible places;
   modes the database cannot enforce exactly stay conservative and say why
   ([shared facilities](#shared-facilities-how-they-are-turned-over)).

Where those left a rule open, these defaults were chosen; each is a setting
or a single place in the code if the owner wants it otherwise:

| Question | Default |
| -------- | ------- |
| Who may go past the rules | Managers of the venue (not front-desk staff, not the API); each booking marked, the activity log naming the rules passed |
| The platform's rules | On the hour, 60 to 240 minutes in hours, 60 first, no separation or operational time, no notice; padel from any half hour, in half hours, 90 first |
| Two buffers side by side | Decided (8 above): minimum separations share, the larger applies (10 after one and 10 before the next leave 10 minutes; 10 and 25 leave 25); operational time adds up (10 of cleaning and 10 of setup leave 20) |
| Separation on a shared facility | By its turnover (9 above); unset, each place a booking takes is held over its separation and operational time added together, as before |
| Billing steps and minimum minutes | The extra minutes are priced at the rate in force then, as if booked |
| A fixed-length price at peak | Its peak price applies when the booking starts at peak |
| A minimum charge on a per-player court | Applies to the whole booking, after multiplying by the players |
| Last-minute prices | Per minute: each minute starting within the window is discounted |
| Discounts and fees | Concessions and promo codes come off the court time, never setup or cleanup fees; an off-peak-only concession is refused if any minute is at peak |
| Session passes | One entry per 60 minutes or part, for passes already sold (their rule) and new ones unless set; blank is one a booking |
| Outages | Every minute of each business day, late hours included; migrated ones whole calendar days |
| Opening hours | To the minute; a venue still opens for at least an hour |
| Unstaffed hours | Still whole hours ([known limitations](../roadmap/known-limitations.md)) |
| A booking touching a change of the clocks | Refused, the skipped and the repeated hour alike, even for managers; not offered (rather than taking the first of a repeated hour, which would hold more time than the clock says) |

## How it is tested

| What | Where |
| ---- | ----- |
| The database refuses on its own: raw SQL inserts of an overlapping claim and of a place past capacity | `tests/capacity.test.ts` "is still the database that prevents overbooking" |
| Races on Postgres: the last court, a shared floor's places, a class, a pitch against a court, an outage and a block against bookings | `tests/concurrency.test.ts`, `tests/court-links.test.ts`, `tests/outages.test.ts`, `tests/move.test.ts` |
| Any minute, buffers, staff past the rules, several courts, weekly series, waiting lists, passes | `tests/intervals.test.ts` |
| Separation and operational time: 10 and 10 leave 10 (9 refused), cleaning and setup add up, the two combined, 10 against 25, linked courts, a shared floor, rescheduling, weekly series, a manager's override, a game's proposed move, rules changed between bookings, raw SQL, the board's starts against the database's answer minute by minute, races through the app and between two raw writers on Postgres | `tests/separation.test.ts` |
| Migrations 0118–0119 on claims and settings made under buffers that added up: nothing stored changes, the settings become separation, new claims follow the new rule | `tests/separation-migration.test.ts` |
| Shared facilities' turnover: the setting and its inheritance, per place added up (as before), per place the longer, a fleet's own turnaround, the whole facility (sessions sharing places, cleaning and setup added up, the larger gap, nobody in it while cleared, joining a session), a facility changed from one to the other, the board's cells and the staff schedule, blocks placed around it, a game's proposed move, raw SQL refusals, the board's starts against the database's answer minute by minute in every mode, a crowded sequence of requests audited from the table (never past capacity, never in a turnover), races through the app and between two raw writers on Postgres | `tests/shared-turnover.test.ts` |
| Migration 0131 on shared facilities already booked: nothing stored changes, no turnover set, every claim written into `facility_gaps` without conflict, new facility-wide claims kept clear of the old | `tests/shared-turnover-migration.test.ts` |
| Policies: starts, lengths, grid, breaches, validation, inheritance, the route | `tests/booking-policies.test.ts` |
| Pricing to the minute, peak boundaries, rounding, fixed prices, steps, minimums, fees, last-minute | `tests/pricing.test.ts` |
| The migration: a diary seeded on the old schema migrates to the same occupancy and is dropped; a mismatch stops it | `tests/interval-migration.test.ts` |
| The board: starts and lengths, partly held cells, quotes, override | `tests/components/booking-board.test.tsx` |

The suite runs on PGlite and on Postgres 16
([testing](../development/testing.md)); races only show on Postgres.
