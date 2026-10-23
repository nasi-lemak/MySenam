# ADR 0011: Activities as data, resources as products of them

- **Status:** current. Built in migration 0092. What operators and customers
  see is [activities](../../features/activities.md); how a booking of any of
  them is held is [ADR 0010](0010-interval-booking.md).
- **Context:** the code knew fifteen sports by name (`SPORTS` in
  `src/lib/types.ts`), with their labels, icons, default rules and which ones
  may run unstaffed written beside it. Each new sport was a release, an
  operator could not offer anything not on the list, and a court was exactly
  one sport, so a hall sold for badminton, pickleball and volleyball had to
  be three courts that did not know they were one floor. A marketplace across
  Southeast Asia needs dozens of activities, named differently from country
  to country, and operators who add their own the day they start selling
  them.
- **Decision:**
  - **An activity is a row** in `activities`: key, category, icon, names in
    each language, aliases, per-country names and filters, a template, its
    usual booking rules, and its support level. The built-in ones are
    defined in `src/lib/activity-catalogue.ts` and written to the table at
    every start; operators' own belong to their business or venue. Every
    table that names an activity has a foreign key to it.
  - **The engine never branches on an activity.** What differs between a
    badminton court, a lane pool and a kayak fleet is data on the resource
    (capacity, per-person pricing, most per booking) and the booking policy
    (starts, lengths, buffers, sign-off); the claims, constraints, prices and
    rules of ADR 0010 are the same for all.
  - **Activity, resource, product and policy are separate.** A resource
    (still `courts`) offers one or more activities (`court_activities`); each
    pairing is a product with its own rates if it has them and its own level
    in the booking-policy chain (activity on a court → court → activity at
    the venue → venue → business → the activity's usual rules → platform).
    A booking records the activity it is for (`bookings.sport`), and
    everything that depends on the activity reads it from there.
  - **A booking of a resource with places takes as many as it says**
    (several kayaks, several climbers), priced per place, under the same
    capacity trigger.
  - **Templates prefill, they do not constrain**: five resource models
    (exclusive, lanes, shared, class, hire) suggest a noun, places, count
    and pricing, all editable before and after.
  - **Sign-offs** are one rule (`signOff`) and one table for every activity
    that needs a person checked first, rather than a check per activity.
  - **The catalogue reaches the browser with the page**, so components name
    and group activities from the same data the server uses.
- **Consequences:**
  - Adding an activity is a catalogue row, from the code or the dashboard;
    no code path changes.
  - Catalogue presence is not workflow support. Each activity carries a
    support level and a note of what is missing, shown to operators and
    listed in the [support matrix](../../features/activities.md#support-matrix).
  - The column is still called `sport` everywhere for compatibility with
    stored data, URLs and the public API.
  - Existing built-ins keep their names and default rules exactly; new ones
    have their own defaults. Stand-in catalogue rows are made for any key
    already in use when the migration runs, so no data is refused.
  - A wrong catalogue row can mislead every venue at once; built-ins are
    changed only by release or by the platform owner, and only retired from
    the dashboard.
- **Alternatives considered:** a free-text sport on each court (no shared
  names, filters or rules, and search could not group or translate them); a
  hard-coded list per country (the same release problem, multiplied); a
  separate resource per activity on a shared floor (the floor could be sold
  twice at once without linking every pair).
