# ADR 0010: Reservations as intervals, with overlap refused by the database

- **Status:** proposed; would supersede
  [ADR 0009](0009-half-hour-diary-sold-by-sport.md). Not built. The review,
  evidence and plan are in [booking time model](../interval-booking-review.md).
- **Context:** court time is stored as fixed half-hour rows so that a unique
  key can refuse double bookings. The grain limits what can be sold: no
  15-minute starts, 50- or 75-minute lengths, or changeover buffers. It also
  needs shadow rows for linked courts, and leaves classes, outages, offers and
  shared capacity to application checks.
- **Decision (proposed):**
  - Store each reservation as a `tstzrange` with its venue business date.
  - Courts claim atomic spaces.
  - An exclusion constraint refuses overlapping claims on a space, and a
    locking trigger refuses claims beyond a shared facility's capacity.
  - Everything that occupies time (bookings, holds, offers, classes, blocks,
    tournaments, outages) is a claim.
  - What may be booked is a booking policy per court, sport at venue, or
    venue.
- **Rationale:** precision becomes a policy, not a storage limit, and the
  database refuses every overlap whatever path wrote it, which is
  [ADR 0002](0002-database-enforced-concurrency.md) applied to everything
  that holds a court. Prototypes on Postgres 16 and PGlite held both
  constraints under concurrent load.
- **Consequences:** a large, one-off change across booking, search, pricing
  and the board, made before production while only development data has to
  move. The public API keeps its fields and gains exact times.
