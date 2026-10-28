# ADR 0027: Opening hours and rates from a date, as dated sets beside the current settings

- **Status:** current, decided 2026-10-28 (round 9, the operator finding X1-13
  of the [operations audit of 28 October 2026](../../audits/index.md)). How
  staff and customers meet it is
  [hours from a date](../../features/booking.md#hours-from-a-date) and
  [prices from a date](../../features/pricing.md#prices-from-a-date).
- **Context:** a venue's hours (`venues.open_min`, `close_min`,
  `week_hours`), a court's rates (`courts.off_peak_rate`, `peak_rate`, the
  member rates, its other activities' rates in `court_activities`) and a
  court's own hours (its booking rules' `week_hours`) were one value each,
  changed from the moment they were saved. A venue announcing winter hours or
  a price rise from 1 January had to make the change at midnight on the day,
  could not narrow its hours at all while weekly bookings ran past the date,
  and was told about the bookings in the way one date at a time. Every reader
  already asked for the hours of a date (`venueHours(venue, date)`,
  `hoursOn`, `courtDays`) and priced a date (`priceBooking({ date })`); none
  could be told that the answer depends on the date beyond the weekday.
- **Decision:**
  - **What is stored now is what is in force today.** The venue's and the
    court's own columns, and the booking rules, keep their meaning.
  - **A change from a later date is a whole set in a row of its own:**
    `venue_hours_changes` (the usual hours and the week; migration 0252) and
    `court_changes` (`rates`: the four rates and the other activities' own;
    `hours`: the court's own week, or none for the venue's; migration 0253),
    one per venue or court, kind and date. The database keeps the list on
    the venue and court rows (`venues.hours_changes`, `courts.dated_changes`,
    by trigger, as it keeps `courts.activities`), so everything that reads a
    venue or a court already has it.
  - **The existing lookups resolve the date asked about:** the latest set
    from that date or an earlier one, else the current settings
    (`hoursFor`/`hoursOn` in `src/lib/week-hours.ts`; `policiesFor(courts,
    date)` for a court's own hours; `ratesOn` inside `priceBooking`, and
    `courtOn` for the rates a page shows). The board, booking, moving,
    blocks, classes, waiting lists, coaching, tournaments, search, quotes,
    the counter, the API and the reports' "could have been sold" go through
    them, so none needed a path of its own. Dates are business dates where
    the venue is.
  - **No scheduler.** A set whose date has come is in force by that rule
    alone. It is made the current settings (its values written into the
    columns, its row removed) the next time staff read or change those
    settings (`applyDueHours`, `applyDueCourtChanges` in
    `src/lib/dated-changes.ts`), before anything else is written, so a
    change "from today" saved afterwards is not overridden by it. Until then
    a venue or court read without a date (the venue page, the API's venue,
    the rates table) shows what is in force today, not the stale columns.
  - **Nothing about a booking already made changes.** Its stored price is
    never recalculated; a move or a refund prices dates as before, each date
    at its own rates.
  - **Hours that would leave bookings outside them are refused**, from
    today or from a later date, when a set is changed or withdrawn as when it
    is added: every confirmed booking on a date whose hours change and that
    falls outside them is listed (date, time, court, code), so staff move or
    cancel them. A set may not let the evening before its date run into its
    first morning, or the evening before the next set's.
  - **Managers only**, as changing the settings now is; each set, change and
    withdrawal is in the activity log, old → new, with its date.
- **Consequences:** a venue sets next year's hours and prices whenever it
  decides them, and the date booked decides what applies. Weekly series
  spanning the date are priced week by week. After a set becomes the current
  settings, past dates are judged by the hours in force, as they were before
  this decision whenever hours changed (no history of past hours is kept;
  bookings carry their own times and prices). What can be set from a date is
  the hours and the rates; peak windows, holidays, a policy's prices for set
  lengths, minimums and fees, concessions, membership and tier prices, a
  court's own hours for one of its activities, and the staffed hours still
  change from the moment they are saved
  ([known limitations](../../roadmap/known-limitations.md)).
- **Alternatives considered:**
  - *Effective-dated history for everything* (every version with a
    valid-from and valid-to, the current settings derived from it): every
    writer and reader of hours and rates would change, it would be hard to
    reverse, and it buys a history of past hours that nothing needs, since a
    booking keeps its own price and times. Rejected.
  - *A scheduled job that applies the change at midnight*: the timing would
    have to be right in every venue's time zone, a missed tick would sell
    the wrong hours or prices, and nothing could be booked at the new price
    before the day. Rejected as the mechanism; reads by date need no timing.
- **Reversibility:** additive and conservative. The tables and the two
  listed columns can be dropped with the current settings intact; until a
  venue sets something from a date nothing reads differently.
- **Changes:** migrations 0252–0253; `src/lib/dated-changes.ts`,
  `src/lib/week-hours.ts`, `src/lib/court-activities.ts` `courtOn`,
  `src/lib/pricing.ts` `ratesOn`, `src/lib/booking-policy.ts`
  `policiesFor(…, date)`; the routes in
  [HTTP routes](../http-api.md#hours-and-rates-from-a-date);
  `tests/dated-changes.test.ts`, `tests/components/dated-changes.test.tsx`.
