# ADR 0010: Reservations as intervals, with overlap refused by the database

- **Status:** current; supersedes
  [ADR 0009](0009-half-hour-diary-sold-by-sport.md). Built in migrations
  0089–0091. How it works is [booking time model](../interval-booking-review.md);
  what customers and staff see is [booking](../../features/booking.md).
- **Context:** court time was stored as fixed half-hour rows so that a unique
  key could refuse double bookings. The grain limited what could be sold: no
  15-minute starts, 50- or 75-minute lengths, or changeover buffers. It also
  needed shadow rows for linked courts, and left classes, outages, offers and
  the capacity of shared facilities to application checks.
- **Decision:**
  - Every reservation is an exact interval: a `tstzrange` of minute-precise
    moments, plus the venue's business date and its minutes of that day.
  - A court that takes one booking at a time covers one or more atomic
    *spaces*; a court over others (a pitch over badminton courts) covers
    theirs too. Shared facilities hold *places*.
  - Everything that occupies time (bookings, held bookings, waiting-list
    offers, classes, blocks, tournament holds, outages) is a row in `claims`.
    An exclusion constraint refuses two overlapping claims on a space; a
    trigger that locks the court refuses claims beyond a shared facility's
    capacity. A coach is held by `coach_claims` under the same kind of
    constraint.
  - What may be booked is a **booking policy** (starts, lengths, buffers,
    hours, notice, pricing rules), each setting inherited from the most
    specific level that sets it: court, sport at the venue, venue, business,
    the platform's for the sport, the platform's.
  - Prices are pro rata to the minute, each part at the rate in force then,
    in whole minor units rounded once; fixed-length prices, billing steps,
    minimums and fees are policy.
  - Managers may book or move outside a policy, recorded in the activity log;
    nobody books over a claim or into a buffer.
  - The half-hour tables were dropped (0091) once the migration had checked,
    half hour by half hour, that the claims hold exactly what they held.
- **Rationale:** precision becomes a policy, not a storage limit, and the
  database refuses every overlap whatever path wrote it, which is
  [ADR 0002](0002-database-enforced-concurrency.md) applied to everything
  that holds a court. Both constraints hold under concurrent load on
  Postgres 16 and PGlite, with no extension.
- **Consequences:** one large change across booking, search, pricing, passes
  and the board, made before production while only development data had to
  move. A buffer is part of the claim, so two adjacent bookings keep both
  buffers between them. The public API keeps `hours`, `startHour` and
  `endHour` and adds minutes and moments. There is no down-migration: going
  back means restoring the backup taken before the upgrade
  ([deployment](../../operations/deployment.md#upgrading)).
