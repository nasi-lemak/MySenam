# ADR 0009: A half-hour diary, sold by the sport

- **Status:** superseded by [ADR 0010](0010-interval-booking.md) before it
  reached production; it superseded [ADR 0008](0008-slot-length-per-venue.md).
  The tables and functions it names were dropped by migration 0091.
- **Context:** padel is sold in 90-minute games, badminton by the hour, and a
  hall with both wants each sold its own way. Under ADR 0008 a venue's slot
  length was both how its diary was stored and how it was sold, so a mixed
  hall had to sell everything by the half hour, letting badminton start at
  9:30. Changing the length split or merged the stored diary, and a booking
  had to re-read the length inside its transaction so two sizes of slot never
  met. Nothing had gone to production, so the storage could still change.
- **Decision:** every court's time is stored in half hours, always:
  `booking_slots`, `slot_blocks` and `coach_slots` hold one row per half hour
  (`SLOT` in `src/lib/time.ts`; migration 0088 split what was stored by the
  hour). What a sport is *sold by*, the hour or the half hour, is a selling
  rule (`unitFor` in `src/lib/store.ts`): the sport's own at the venue
  (*Rules by sport → Sold by*, `sport_rules.slot_minutes`), else padel's half
  hours (a sport whose usual game is not whole hours), else the venue's
  default (*Booked by*, `venues.slot_minutes`). Bookings start on that unit
  and run in it; times given to the API, the board and the staff screens are
  starts of that unit, expanded into halves before anything is stored. How
  long one booking on a court may be stays the court's own.
- **Rationale:** one grain of storage keeps every check that compares one
  court's time with another's (linked courts, shadows, blocks, outages,
  classes, coaches, the unique key the
  [concurrency guarantees](../booking-concurrency.md) rest on) the same
  comparison of half hours, whatever each sport is sold by. A grid per court
  would have needed conversion at each of those. Selling becomes a rule like
  booking lengths, changeable at any time without touching stored rows.
- **Consequences:** a badminton court beside padel starts on the hour while
  the padel court starts on the half hour; changing what a sport is sold by
  moves nothing already booked. The staff schedule shows the finest unit any
  of the venue's sports is sold by. Every slot row is half an hour, so
  storage for an hourly venue doubles (two rows an hour). The public API's
  availability gives each court's `unit`; a booking's `hours` are starts of
  that unit, so a padel court at a venue that otherwise sells hours now takes
  half-hour starts.
