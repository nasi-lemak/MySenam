# Booking time model: review and plan

**Status: proposal awaiting a decision.** Nothing here is built. What works
today is described in [booking](../features/booking.md) and
[ADR 0009](decisions/0009-half-hour-diary-sold-by-sport.md); this document
reviews that model against interval-based storage, recommends one, and plans
the change. The decision it asks for is
[ADR 0010](decisions/0010-interval-booking.md).

## Summary

**Recommendation: store every reservation as an exact interval** (a
`tstzrange` in UTC, plus the venue's business date), and let the database
refuse overlaps itself: an **exclusion constraint** for exclusive space, and a
**locking capacity trigger** for shared facilities. Linked courts become sets
of **atomic spaces** a booking claims, rather than shadow rows. What a customer
may book (start times, increments, minimum, maximum and fixed lengths,
buffers, hours) becomes a **booking policy** per court, per sport at a venue,
or per venue. The grid becomes a way of showing time, not a way of storing it.

The half-hour grain was never a requirement of the domain. It was the price
of enforcing conflicts with a unique key: `UNIQUE (court_id, date, hour, seat)`
only works if every row is the same size. Prototypes in this review show that
both Postgres 16 and PGlite enforce interval overlap directly, under
concurrent load, without any grid.

It is a large change: about 70 SQL statements over 14 modules, every
booking path, pricing, search and the booking board. It is the right time to
make it. Nothing is in production, so the migration only has to carry
development data. Every month of new features on the grid adds to what has
to be moved.

## Why storage is in half hours today

| When | What | Why |
| ---- | ---- | --- |
| Migration 0001 | `booking_slots(court_id, date, hour INTEGER, seat)`, unique | One row per court-hour made double-selling impossible with a unique key ([ADR 0002](decisions/0002-database-enforced-concurrency.md)) |
| 0042 | Hours became `double precision`; a venue could sell halves; rows got `span` | Half-hour selling without changing the key |
| 0072, 0087 | A trigger copies each slot onto linked courts as "shadows" | The unique key can only see one court, so links needed copies |
| 0088 ([ADR 0009](decisions/0009-half-hour-diary-sold-by-sport.md)) | Every row became a half hour | Mixed hour and half-hour selling would otherwise put rows of two sizes under one key |

Each step kept the unique key working. None was chosen because a half hour is
the right precision for a booking.

## Audit: where time lives now

| Thing | Stored as | Conflict protection |
| ----- | --------- | ------------------- |
| Bookings | `bookings.date` (venue-local text), `start_hour`/`end_hour` (local decimal hours, past 24 for after midnight) | Its `booking_slots` rows |
| Court occupancy | `booking_slots`: one row per half hour per place, `seat` 0…capacity−1 | `UNIQUE (court_id, date, hour, seat)` |
| Linked courts | Shadow rows written by a trigger, at seat 0 or −(court id) | The same unique key, one level of links deep |
| Shared-capacity facilities | Seats picked in application code, net of blocks and offers | Serializable transaction only; no database check |
| Blocks, tournament holds, repeating blocks, rain-outs | `slot_blocks`, one row per half hour | `UNIQUE (court_id, date, hour)` for blocks only; bookings check blocks in code |
| Outages | `court_outages` (date range), expanded into half hours by `own_blocks_between` | Checked in code |
| Classes | `classes(start_hour, end_hour)`; enrolments are bookings holding the class court's seats | Checked in code by each path |
| Coaches | `coach_slots(coach_id, date, hour)` primary key | Primary key, half hours |
| Waitlist offers, pay-to-hold | Bookings or counts read by `countTakenPlaces` | Checked in code |
| Opening hours | `open_hour`/`close_hour`, `week_hours` (local decimal hours) | Checked in code |
| Pricing | Sum over half-hour slots, each half the hourly rate, peak by slot start | — |

What the audit found, beyond "it is a grid":

1. **Only bookings and blocks are protected by the database.** Classes,
   outages, offers and the capacity of shared facilities are protected by
   application code repeated in several paths, inside serializable
   transactions. [Booking concurrency](booking-concurrency.md) already
   records "each path still applies its own blocks and classes" as a gap.
2. **Linked courts are a trigger plus a seat-numbering convention.** Two
   wholes over one part needed a second convention (migration 0087). Links
   go one level deep.
3. **Local wall-clock decimals** (`date` + `hour`, with 25 meaning 1 AM the
   next day) need special cases: `isPastSlot` handles hours past 24
   separately. They cannot express a daylight-saving change, which matters
   the day a venue opens somewhere that has one.
4. **Precision is fixed by storage**: 15-minute starts, 50-minute lessons, a
   10-minute changeover or a 75-minute padel game cannot be sold.
5. **Storage grows with time, not bookings**: two rows per hour per place,
   plus shadows; a two-hour booking on a whole with three parts is 16 rows.
6. **Conversions everywhere**: `SLOT`, `expandSlots`, cells, `scheduleUnit`,
   `span` sums. Every new feature has to translate between what is sold and
   what is stored.

## The options

- **A. Keep the half-hour grid** (today).
- **B. A finer grid** (5- or 1-minute rows): the same code with a smaller
  `SLOT`.
- **C. Interval claims with database constraints** (recommended): one row
  per booking per atomic space, `tstzrange`, an exclusion constraint for
  exclusive space, and a locking trigger for capacity.
- **D. Intervals checked by application code only**, relying on the
  serializable transactions the app already uses.

| | A. Half-hour grid | B. Finer grid | C. Intervals + constraints | D. Intervals, app checks |
| - | ----------------- | ------------- | -------------------------- | ------------------------ |
| **Correctness** | Strong for bookings and blocks; classes, outages, offers and capacity are code-checked; links by trigger | As A | Every occupant (booking, class, block, outage, tournament, hold, offer) is a claim under the same constraint; links by shared spaces at any depth; capacity by trigger | Correct only while every path remembers every check; drops [ADR 0002](decisions/0002-database-enforced-concurrency.md) |
| **Precision** | 30 minutes | 5 or 1 minute | Any minute (or second) | Any |
| **Performance** | 2 rows/hour/place (+ shadows); unique-key inserts are cheap; reads by `(court_id, date)` | 12× to 60× the rows of A; a 1-minute day is 1,440 rows per court | 1 row per booking per space; a GiST insert costs more than a B-tree one but there are far fewer; reads by `(court_id, business_date)` B-tree, overlap by GiST | Like C, without the constraint's write cost |
| **Complexity** | Low per feature, high in aggregate: conversions, shadows, spans, seats | As A, plus volume | New: interval arithmetic, policies, time zones done once. Removed: shadows, seat juggling, spans, grid conversions | Least schema; most hidden coupling |
| **Extensibility** | New lengths and buffers need a finer grid | Buffers and odd lengths possible but costly | Buffers, fixed lengths, per-resource starts, minute bookings, overnight, daylight saving | As C, minus the guarantee |
| **Migration risk** | None | Large row rewrite | One structured rewrite of development data, checked by a reconciliation in the migration | As C |

B buys precision with volume and keeps every weakness of A. D is simpler but
gives up the property this codebase was built on: the database, not the
paths, refuses a double booking. **C is the long-term design.**

## Evidence from prototypes

Run in this review against the project's own PGlite and Postgres 16 (scripts
were scratch work, not committed):

- **Exclusion on PGlite**: `EXCLUDE USING gist (unit WITH =, during WITH &&)`
  refused a 1-minute overlap, accepted an adjacent 47-minute booking, freed
  the time when the claim was deactivated, and held an overnight range across
  midnight with no "hour 25".
- **Exclusion under concurrency on Postgres 16**: 50 rounds of 8 concurrent
  transactions inserting overlapping windows on one space: exactly one
  committed per round, 301 refused with `23P01`, the rest ended in deadlocks
  (`40P01`, already retried by `withTransaction`); no overlapping pair
  remained.
- **Capacity under concurrency**: a pool of 3 places, 30 rounds of 8
  overlapping one-place requests at 7-minute offsets: 110 committed, 130
  refused as full, and **at no instant more than 3 places held**. This held
  both under the app's serializable transactions and with a row lock on the
  resource (`SELECT … FOR UPDATE`); the lock needs no serializable retry, so
  it can live in a trigger.
- **No extension needed**: `EXCLUDE USING gist (int4range(space_id, space_id, '[]') WITH &&, during WITH &&)`
  works on stock Postgres and PGlite without `btree_gist`, so managed hosts
  that restrict extensions are not a risk. (`btree_gist` also ships with
  PGlite 0.5 if preferred.)
- **Multiranges** (`range_agg`) work on both engines (Postgres 14+; PGlite is
  18), for occupancy reports and free-time computation.

## Recommended design

### Time

- `during tstzrange` (UTC instants, half-open `[start, end)`, never empty),
  plus `business_date date`: the venue's trading day it belongs to, so a
  booking from 23:30 to 01:00 belongs to the evening it started. The venue's
  time zone (already stored) converts both ways.
- Minute precision by `CHECK`: `date_trunc('minute', lower(during)) = lower(during)`,
  and the same for `upper`. Finer is possible but not needed.
- Opening hours stay as they are, local minutes from the business day's
  midnight (`week_hours`, past 24:00 allowed), converted to instants per date.

### Atomic spaces (exclusive resources and links)

- **`spaces`**: the smallest things that can be double-booked: each badminton
  court, the strip of a pitch no smaller court covers.
- **`court_spaces(court_id, space_id)`**: a court is the set of spaces it
  occupies. A plain court is one space. A futsal pitch over three badminton
  courts is those three spaces (plus its own if it covers more).
- Booking a court claims **every one of its spaces**. A pitch then conflicts
  with each court under it, two pitches sharing a court conflict through that
  court's space, and two courts under one pitch do not conflict with each
  other. This is what migrations 0072 and 0087 did with shadows and seat
  numbers, without either, at any depth.

### Claims: one table for everything that occupies time

```sql
CREATE TABLE claims (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  venue_id      integer NOT NULL REFERENCES venues(id),
  court_id      integer NOT NULL REFERENCES courts(id),   -- what was booked
  space_id      integer REFERENCES spaces(id),            -- exclusive: one row per space
  places        integer,                                  -- shared facility: places held
  kind          text NOT NULL CHECK (kind IN
                  ('booking','hold','offer','class','block','tournament','outage')),
  booking_id    integer REFERENCES bookings(id) ON DELETE CASCADE,
  class_id      integer REFERENCES classes(id) ON DELETE CASCADE,
  block_id      integer,  tournament_id integer,  outage_id integer,
  business_date date NOT NULL,
  during        tstzrange NOT NULL,                       -- the time sold or held
  occupied      tstzrange NOT NULL,                       -- during, widened by buffers
  active        boolean NOT NULL DEFAULT true,
  expires_at    timestamptz,                              -- holds and offers
  CHECK ((space_id IS NULL) <> (places IS NULL)),
  CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during)),
  CHECK (occupied @> during),
  EXCLUDE USING gist (int4range(space_id, space_id, '[]') WITH &&, occupied WITH &&)
    WHERE (active AND space_id IS NOT NULL)
    DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX claims_court_day ON claims (court_id, business_date) WHERE active;
```

- **Exclusive space**: the exclusion constraint. Nothing that occupies a
  space (a booking, a class, a block, an outage, a tournament, a
  pay-to-hold, a waitlist offer) can overlap another on it, whatever path
  wrote it.
- **Shared capacity** (kayak fleets, gym floors): a `BEFORE INSERT OR UPDATE`
  trigger locks the court row (`FOR UPDATE`), computes the peak of places
  held over the new claim's `occupied` range (a sweep over overlapping
  claims, as prototyped), and raises if it would exceed capacity. Partial
  blocks are claims with `places`. The lock serialises writers on one
  facility only.
- **Buffers**: `occupied` is `during` widened by the court's buffer before
  and after, snapshotted at write time. Changing a buffer affects new claims
  only.
- **Deferrable** so a swap (two bookings exchanging courts) can defer the
  check to commit.
- **Expiring claims** (holds, offers): the sweep that already cancels
  expired holds deactivates them. A booking path first deactivates expired
  claims overlapping its window, in its own transaction.
- **Coaches**: `coach_claims(coach_id, booking_id, during)` with the same
  exclusion on `coach_id`: a coach is never in two lessons, enforced by the
  database instead of a half-hour primary key.
- **Tenancy**: a claim's court, spaces and venue must agree (trigger or
  composite foreign keys). The constraint is per space, so one venue's
  writes never contend with another's.
- **No partitioning of `claims`**: a partitioned table's exclusion
  constraint must include the partition key by equality, which an overnight
  booking would cross. Old claims are archived by the retention job instead.

### Booking policies

What may be booked, separate from what is stored. One table, most specific
wins: court, else sport at venue, else venue, else platform defaults.

| Setting | Example |
| ------- | ------- |
| Start times | every 30 minutes from :00; every 15 minutes; or listed (18:00, 19:30, 21:00) |
| Duration | increments of 30 minutes; between 60 and 120 minutes; or fixed choices (90 only) |
| Buffers | 10 minutes after each booking |
| Hours | the venue's, or the court's own |
| Who | customers, or staff only (staff may book any minute where allowed) |

Today's settings map onto it: a venue's *Booked by* and a sport's *Sold by*
become start step and increment (60 or 30); a court's shortest and longest
booking become minimum and maximum; padel's usual 90 minutes becomes a
suggested length.

### How each feature works on intervals

| Feature | On intervals |
| ------- | ------------ |
| **Booking** | Validate against the policy, then insert the booking and its claims in one transaction; a `23P01` is "taken" |
| **Linked courts** | Spaces (above); no trigger, any depth |
| **Several courts at once, any court** | All claims in one transaction, inserted in space order to limit deadlocks; one refusal aborts all |
| **Shared capacity** | Capacity trigger; places held are claims |
| **Classes** | A session is one claim on its court (all its spaces, or its full capacity). Enrolments count against the class's own capacity under a lock on the class row; they no longer hold court seats |
| **Tournaments** | Claims per court for the day, narrowed after the draw by updating `during` |
| **Blocks, repeating blocks, rain-outs** | Claims of kind `block`, any length |
| **Outages** | One claim per space for the outage range (open-ended allowed: an unbounded upper end); taking a court out over existing bookings is refused by the constraint, which is today's rule, now enforced |
| **Closures, opening hours** | Policy, checked when booking; not occupancy |
| **Weekly series** | One booking and its claims per week; a `SAVEPOINT` around each week turns a `23P01` into a skipped week when skipping is asked for |
| **Waitlists** | Entries keep a wanted interval; an offer is a claim with `expires_at`; matching asks whether the wanted interval is free |
| **Moving, rescheduling** | `UPDATE` the claims' court, spaces and `during` in place, so a booking can overlap its own old time; swaps defer the constraint |
| **Pricing** | Integrate the rate over the interval: split at peak and holiday boundaries, each piece at its rate for its minutes, rounded once per booking. A half hour still costs half the hourly rate; aligned bookings price exactly as today |
| **Passes** | An entry per hour or part of one (today's rule), from minutes |
| **Coaching** | Fee from minutes; coach claims |
| **Search** | Candidate starts from each court's policy; one query for the day's active claims of the candidate courts; an in-memory sweep finds which candidates are free for the duration |
| **Availability grid** | Drawn at the policy's start step; a cell shows free, partly taken or taken from the claims overlapping it; picking a cell picks a start, and the length comes from the policy |
| **Staff schedule** | The same claims drawn at any zoom, including minute-level bookings |
| **Reports, occupancy** | Minutes from `upper − lower`; occupancy from `range_agg` clipped to opening hours |
| **Calendar and Google feeds, messages** | Instants straight from `during`; local display by the venue's zone |

## API compatibility

- **Public API v1** (`/api/v1`) keeps every field it has:
  - Booking creation still accepts `hours` (read as starts of the court's
    start step, then joined into one interval).
  - It also accepts `start` and `end` (ISO 8601 with offset), or `start` and
    `minutes`.
  - Responses keep `date`, `startHour` and `endHour` (local decimal hours,
    possibly fractional) and add `startsAt` and `endsAt`.
  - Availability keeps `slots` and `unit`, now drawn from the policy, and
    adds the policy (start times, lengths) and the day's busy intervals.
  - Webhook payloads gain `startsAt` and `endsAt`. Nothing is removed in v1.
- **The app's own routes** change with the screens that call them, in the
  same change.
- **Exports, calendar feed, Google feeds**: same columns and formats, from
  intervals.

## Migration

A new migration after 0088 (applied migrations are never edited):

1. **Spaces**: one per court of capacity 1; courts linked as wholes take
   their parts' spaces plus their own; capacity courts get none (they hold
   places).
2. **Policies**: from `venues.slot_minutes`, `sport_rules.slot_minutes`,
   `courts.min_hours` and `max_hours`, padel's half hours.
3. **Claims**:
   - Bookings (confirmed, and pending ones still holding): `during` from
     `date`, `start_hour` and `end_hour` in the venue's zone. Postgres reads
     hour 25 as the next day's 1 AM without special cases.
   - Blocks: grouped into runs per court, reason, places, tournament and
     repeat code.
   - Outages, classes, live offers: one claim each.
   - Coach slots: grouped per booking.
4. **Reconciliation inside the migration**: for every court and half hour in
   the data, places held before must equal places held after, or the
   migration raises and nothing is committed. Creating the exclusion
   constraint itself fails on any overlap the old data hid.
5. **Old tables renamed, not dropped** (`legacy_booking_slots`,
   `legacy_slot_blocks`, `legacy_coach_slots`). They are dropped by a later
   migration once the new paths have run, which is a **destructive step
   flagged for review**.
6. The SQLite import script and the demo data write intervals.

Risk is low because there is no production data. The reconciliation makes a
wrong conversion fail loudly rather than move a booking.

## Implementation phases

Each phase ends with typecheck, lint, the docs check, the whole suite on
PGlite and Postgres, and the documentation of what changed.

1. **Time core.** A small interval module: local ↔ UTC per venue zone,
   business dates, half-open arithmetic, a policy validator (starts,
   increments, fixed lengths, minimum and maximum, buffers, hours) and
   candidate generation. Unit-tested on its own, including overnight hours
   and a daylight-saving zone.
2. **Schema and migration.** Spaces, policies, claims, the exclusion
   constraint, the capacity trigger, coach claims, and the migration with
   its reconciliation. Constraint tests insert directly in SQL, bypassing the
   app, to prove the database refuses on its own.
3. **Write paths.** Booking, series, several courts, any court, holds,
   offers, blocks, repeating blocks, rain-outs, outages, classes and
   enrolments, tournaments, coaching, moving, rescheduling, cancelling. The
   seat and shadow code goes.
4. **Read paths.** Availability, staff schedule, search, waitlist matching,
   occupancy and reports, exports, calendar and Google feeds, privacy export.
5. **Money.** Interval pricing (peak, holidays, member and concession rates,
   per player, last-minute), passes, coach fees, deposits, refunds. Every
   existing price test must give the same price for aligned bookings.
6. **Screens.** The policy editor (court, sport, venue), the booking board
   (start and length pickers over the grid, partly-taken cells), and the
   staff schedule at any precision.
7. **API and clean-up.** v1 additions with compatibility tests. Remove
   `SLOT`, `expandSlots`, `span`, `blocks_between` and the shadow trigger. ADR
   0010 becomes current and ADR 0009 is superseded.
8. **Drop the legacy tables** (separate, flagged).

## Tests

- **The database alone**: overlapping claims refused by raw SQL on one
  space, through a whole and its part, and two wholes over one part. Adjacent
  claims accepted. Buffers widen what is refused. Capacity refused past the
  limit, with partial blocks counted. Inactive and expired claims ignored.
  Tenancy mismatches refused.
- **Races on Postgres** (`Promise.all`, as `tests/concurrency.test.ts`
  does):
  - the last minute of an exclusive court, through a whole and its part;
  - the last place of a shared facility;
  - two group bookings sharing one court, all or nothing;
  - a class against a booking;
  - an outage against a booking;
  - a reschedule against a new booking.
- **Policies**: starts on and off the step, listed starts, fixed lengths,
  increments, minimum and maximum, buffers, hours past midnight, staff-only
  minute bookings.
- **An oracle test**: random bookings, moves and cancellations are applied
  both through the app and to a simple minute-by-minute model; at the end,
  occupancy must agree at every minute.
- **Pricing**: every existing price test unchanged for aligned bookings;
  minute bookings across a peak boundary; rounding once per booking.
- **Migration**: a database seeded on the old schema (hourly and half-hour
  venues, links, shared facilities, blocks, outages, classes, coaches,
  tournaments, offers) migrates with identical occupancy; a seeded overlap
  makes the migration fail.
- **API**: v1 requests written for today's API get the same answers; new
  fields present.
- **Performance**: a benchmark seeding hundreds of venues and weeks of
  bookings, comparing availability, search and booking times before and
  after on Postgres. It is an acceptance check for phase 4, with the target
  set before the work starts.
- **Browser**: book a 90-minute padel game from 9:30, a 15-minute-step court,
  and a court with a changeover buffer, on the production build.

## Decisions for the owner

These change business rules, so they are not assumed here:

1. **Adopt interval storage (ADR 0010)**, superseding ADR 0009 before
   production.
2. **Minute-level bookings**: allowed for customers wherever a policy
   permits, or staff only by default?
3. **Prices for lengths that are not whole increments**: pro rata to the
   minute (proposed), or rounded up to the increment?
4. **Pass entries**: one per hour or part (today's rule), or pro rata?
5. **Buffers**: who sees them (staff only, or "changeover" on the board), and
   whether they are ever charged.
6. **Peak hours to the minute** (today whole hours only)?
7. **When to drop the legacy tables** after the switch.
