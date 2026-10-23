# ADR 0008: Slot length stays per venue

- **Status:** superseded by [ADR 0009](0009-half-hour-diary-sold-by-sport.md), before
  it reached production.
- **Context:** padel is sold in 90-minute games, badminton by the hour. A
  hall with both wants each court booked its own way. A venue sells by the
  hour or by the half hour (`venues.slot_minutes`), and every part of the
  booking engine works in that one grid: the booking board, availability,
  linked courts that share a floor, blocks, outages, waiting lists, classes,
  tournaments, moving and rescheduling, search and the reports.
- **Decision:** the slot length stays a property of the venue. A hall with a
  sport whose game is not whole hours sells by the half hour, and each court
  says how long one booking on it may be (*Courts → How long one booking may
  be*: a padel court's shortest 1½ hours; a badminton court's an hour). Search
  finds 90-minute games, starting on the hour or the half hour, at venues
  that sell half hours. The usual length of a sport (`SPORT_USUAL_HOURS` in
  `src/lib/types.ts`) is what search asks for when that sport is picked.
- **Rationale:** a slot length per court would give one venue several grids.
  Courts that share a floor (a futsal pitch over badminton courts) would have
  to agree on which, and every check that compares one court's hours with
  another's would need converting between them: a large change across the
  engine that the [concurrency guarantees](../booking-concurrency.md) rest
  on, for what half-hour slots and per-court lengths already give.
- **Consequences:** at a half-hour venue, a badminton court whose shortest
  booking is an hour can still be booked from the half hour (9:30–10:30), and
  for an hour and a half; a half hour left between two bookings cannot be
  sold. If venues ask for hourly-only starts on some courts, a court's own
  start rule (on the hour, or every 90 minutes) is the smaller change, not
  per-court slots.
