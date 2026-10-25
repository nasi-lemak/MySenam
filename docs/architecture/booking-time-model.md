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
claims that overlap on the same **space** (an exclusion constraint) and more
claims than a shared facility has **places** (a trigger). Which intervals a
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
| `kind` | `booking`, `offer`, `class`, `block` or `outage`, with exactly the matching `booking_id`, `waitlist_id`, `class_id`, `block_id` or `outage_id` |
| `court_id`, `venue_id` | What was claimed; a trigger (`claims_belong`) refuses a court of another venue, a space the court does not cover, places on an exclusive court and spaces on a shared one |
| `space_id` or `places` | One claim per space for an exclusive court; one claim with a number of places for a shared facility |
| `during` | The time sold or held |
| `occupied` | `during` widened by the buffers before and after, as they were when the claim was made |
| `active` | Cancelling, releasing or expiring a claim sets it false; the row stays for history |
| `expires_at` | When a waiting-list offer lapses |

- **Exclusive space**: `EXCLUDE USING gist (int4range(space_id, space_id,
  '[]') WITH &&, occupied WITH &&) WHERE (active AND space_id IS NOT NULL)`.
  `int4range(id, id, '[]') &&` is equality, so no extension is needed on
  Postgres or PGlite. A refused claim raises `23P01`, which `isConflict`
  recognises and each path turns into "taken".
- **Shared capacity**: `claims_capacity` locks the court row
  (`FOR NO KEY UPDATE`, which does not wait on the key-share locks the
  foreign keys of the rows being written take), sweeps the places held over
  the new claim's `occupied` range, and raises `23P01` if the peak would pass
  the court's capacity. A partly blocked facility is a block claim of some
  places. The lock serialises writers on one facility only.
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
  `fits`, `peakPlaces` and `freeStretches` answer "is this free" in memory.

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
| Kept free before / after | 0 / 0 | Buffers: time no customer can book, not charged |
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
  there.

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

Where those left a rule open, these defaults were chosen; each is a setting
or a single place in the code if the owner wants it otherwise:

| Question | Default |
| -------- | ------- |
| Who may go past the rules | Managers of the venue (not front-desk staff, not the API); each booking marked, the activity log naming the rules passed |
| The platform's rules | On the hour, 60 to 240 minutes in hours, 60 first, no buffers, no notice; padel from any half hour, in half hours, 90 first |
| Two buffers side by side | Each booking keeps its own: 10 minutes after one and 10 before the next leave 20 minutes |
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
| Policies: starts, lengths, grid, breaches, validation, inheritance, the route | `tests/booking-policies.test.ts` |
| Pricing to the minute, peak boundaries, rounding, fixed prices, steps, minimums, fees, last-minute | `tests/pricing.test.ts` |
| The migration: a diary seeded on the old schema migrates to the same occupancy and is dropped; a mismatch stops it | `tests/interval-migration.test.ts` |
| The board: starts and lengths, partly held cells, quotes, override | `tests/components/booking-board.test.tsx` |

The suite runs on PGlite and on Postgres 16
([testing](../development/testing.md)); races only show on Postgres.
