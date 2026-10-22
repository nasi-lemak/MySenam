# ADR 0004: Plain Postgres for bookings, not TimescaleDB

- **Status:** current
- **Context:** whether bookings, messages and the ledger should move to a
  time-series database (TimescaleDB) as data grows, and what to do as it does.
- **Decision:** keep everything in plain PostgreSQL. Grow with continuous
  backups, then monthly partitioning of `booking_slots` if needed.
- **Consequences:** development (PGlite) and production stay the same engine;
  unique constraints and foreign keys keep working across all time.
- **Known limitations:** the size figures below are from one synthetic
  measurement, not production; partitioning `bookings` would cost the single
  unique index on booking codes.

## Rationale and measurements


Measured with 5.4 million bookings on 12,000 courts, a booked hour costs about
450 bytes: 274 for the booking and 179 for its slot, each with its indexes.
That database was 2.3 GB, and `pg_dump` wrote it in 21 seconds to 78 MB.

At national scale, around 160,000 bookings a day, that is roughly 30 GB a
year. Messages add a steady 15–20 GB that does not grow, because they are kept
90 days. None of it slows the pages people use: they read the next fortnight
through indexes, and a day's list loads in about 20 ms with five million
bookings stored. Old rows cost disk and backup time, not speed. Bookings are
kept, anonymised after two years (see *Retention* above), because they are the
venues' accounting records, which Malaysian tax law expects kept for seven
years.

What to do as it grows:

- **Tens of GB:** nightly `pg_dump` gets slow, and a day's loss is too much.
  Move to continuous backups with point-in-time recovery: pgBackRest or WAL-G
  to R2 on the Droplet, or DigitalOcean's managed Postgres, which includes
  them.
- **Hundreds of GB:** partition `booking_slots` by month. Its unique key
  already includes the date, so it partitions cleanly, and old months can be
  detached and archived. `bookings` cannot be partitioned the same way without
  giving up a single unique index on booking codes, which customers look
  bookings up by.
- **Compression:** Postgres compresses only large values, and these rows are
  small, so there is little to gain inside the database. Compression happens
  in the backups, which `pg_dump` compresses roughly 5–10× on real data.

**TimescaleDB does not fit.** It is built for append-only measurements:
millions of sensor readings or metrics a second, rarely changed once written,
and queried in time buckets. Bookings are the opposite. They are updated
after they are written (cancelled, paid, checked in, anonymised). They
depend on unique constraints across all time: no double-booked hour, no
repeated booking code. Ledger rows point back at them with foreign keys.
Hypertables require every unique index to include the time column, and
restrict foreign keys that point at them. Compressed chunks make updates slow.
Its compression and continuous aggregates are not in the open-source edition
that DigitalOcean's managed Postgres offers, and PGlite has no TimescaleDB at
all, so development and production would differ. And the load it is built for
is thousands of writes a second; this one is about two. If high-frequency data
ever arrives, such as door sensors, occupancy pings or page-view analytics,
that one stream could be its own table or service. The bookings stay in plain
Postgres.
