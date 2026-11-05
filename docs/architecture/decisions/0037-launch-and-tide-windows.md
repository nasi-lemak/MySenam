# ADR 0037: Launch and tide windows narrow the bookable hours of water hire

- **Status:** current, decided 2026-11-05 on the owner's request for a daily window that
  narrows the hours of water activities (kayaks, paddle boards, boats, jet skis, surf), from a
  launch window, a tide table the venue supplies, or both. What staff and customers see is
  [booking](../../features/booking.md#launch-and-tide-windows-for-water-hire). Migration
  0278 (`launch_rules`, `tide_events`, `launch_kept`).
- **The question:** water hire is not open all the hours the venue is. The ramp has hours and
  a launch crew, and on tidal water the water is only deep enough for part of the day. Today
  staff block hours one by one or rain off a stretch; neither is a rule, and a tide table
  moves every day. How does a daily window narrow the hours without a second booking engine,
  without trusting a service the app cannot check, and without silently cancelling what is
  already booked when the data behind it changes?

## Decision

### A. One place: the court's day

- **A1.** A resource's window for a date is part of its **day** (`CourtDay.launch`,
  `src/lib/store.ts`), beside its opening hours and closures, and is read where they are:
  `courtDays` asks `launchDaysFor` once per date and the result is a list of windows within the
  court's opening hours. `policyBreaches` (`src/lib/booking-rules.ts`) adds a breach, `WINDOW`,
  when a span is not wholly inside one window with the return buffer taken off. Every path that
  already asks the policy (the form, the counter, the API key, joining a waiting list, an approval's held
  slot, rescheduling, games' proposed moves, a series' first week) is held without a line of its
  own; the paths that do not (a weekly series' later weeks, a class term, adding games to a
  booking, the board's cells and starts, search) read `day.launch` directly.
- **A2.** Nothing is stored per date and nothing is cached across requests: a window is worked
  out from the rule, the opening hours and the table each time, so a corrected table changes
  every answer at once.

### B. Sources

- **B1.** A rule is per resource, or per activity on a resource (an activity's rule wins over the
  resource's for all), with source **weekly** (a window, or none, for each weekday), **tide** (a
  table and a rule on it) or **both** (the intersection), a **shortest window** and a **return
  buffer**.
- **B2.** The tide rule is a **least height** (the interpolated tide at least *H*) or **minutes
  around a high or low tide** (within *N*). One or the other, chosen by the venue.
- **B3.** **No tide service is asked and nothing is fetched.** The table is what the venue typed
  or imported, per station name, and is the venue's. Customers are never shown the table, the
  station or a height; they are shown the windows, with the words *not a forecast*, in four
  languages. A venue cannot present the table as an official forecast because nothing of it is
  shown.

### C. The tide, to the minute, deterministically

- **C1.** An entry is an instant (stored as an ISO UTC string to the minute), a kind (`high` or
  `low`) and a height in whole centimetres. Between two adjacent entries of different kinds the
  height is the **half-cosine** *h₁ + (h₂ − h₁)·(1 − cos πf)/2*; at an entry it is the entry's.
  This is the standard smoothing of the rule of twelfths: slow at the turn, fast at mid-tide,
  and exactly the entries' heights where the table has them.
- **C2.** A minute of a date is read at the instant the venue's clock gives it (`instantOf`), so
  a day the clocks change is read as it happened. Sampling is at whole-minute boundaries; a minute
  interval is usable where both its ends are, so windows begin and end on whole minutes. The
  float comparison against the least height has a tolerance of 10⁻⁹ cm.
- **C3.** The table is trusted only **between neighbours**: not before its first entry or after
  its last, not between two entries more than 15 hours apart (a tide turns about every six
  hours; once-a-day tides, twelve), and not between two of one kind (an entry is missing). There the water is
  *not known*, and the time is **closed with the reason "no tide data"**, never open. This holds
  for both tide rules, so a table that has run out closes the date.
- **C4.** The event rule is the minutes within *N* of an entry of the chosen kind, inside the
  trusted part of the table.
- **C5.** Deterministic: the same rule, hours and table give the same windows. No randomness, no
  learned adjustment.

### D. Time

- **D1.** A window is whole minutes within one local date, 00:00 to 24:00, and **never crosses
  midnight**. A weekday window cannot end after 24:00. A tide that serves 23:00 to 01:00 is two
  windows (the evening's on its date, the morning's on the next), and a booking across midnight is
  in neither. The minutes of a late-hours business day after midnight are never in a window.
- **D2.** Windows are cut to the court's opening hours that day. **The narrower wins**: closures,
  outages, rain-outs, blocks and other bookings close their time as before; the window closes
  more. Where the hours are narrower they decide, and a manager's override of the hours does
  not go past the window (the window's breach is counted beside the hours', not instead).
- **D3.** Daylight saving is the existing rule: a booking touching a change of the clocks is
  refused (`CLOCK_CHANGE`). A CSV time the clocks skip or repeat is refused row by row; the table
  may be given in UTC instead.

### E. Buffers

- **E1.** The **return buffer** belongs to the window: a booking must end at least that many
  minutes before the window closes. It is not a claim buffer and keeps nobody else out.
- **E2.** The court's **operational time and separation** (setup, cleaning, minimum gap) are the
  claim's and unchanged: the claim's `occupied` range may run past the window's close, so the
  last hire's cleaning is after the last return. The two never add up on anyone.

### F. No override

- **F1.** The window is **not a rule a manager can waive** at the desk, as a change of the clocks
  is not: it is the venue's own data, so the venue changes the rule or the table (a logged,
  manager-only action) rather than booking past it. This is the conservative reading of "the
  narrower always wins"; allowing an override with a reason is a small change in
  `createBookingSeries` and `rescheduleBooking` if the owner prefers it (see Consequences).

### G. When the data changes

- **G1.** **Nothing already booked is cancelled, moved or messaged** when a table is corrected or a
  rule is changed or removed.
- **G2.** The bookings and class sessions to come that are not wholly inside their day's window
  are **listed**, each with why, the customer's number and the day's windows
  (`strandedByLaunch`, `src/lib/launch-worklist.ts`), on the rule's panel and as lines on the
  desk's *Needs attention* panel. The list is the live difference between what is booked and what
  the data now say, so it needs no event and cannot go stale.
- **G3.** Staff move or cancel each through the existing paths, with their refunds and customer
  messages, or **keep it as booked** (`launch_kept`), which names the day's window as it stood
  and so holds only until the day's window changes again.
- **G4.** A booking that has finished is left alone, as a rain-out leaves it.

### H. Safety

- **H1.** The app **only narrows hours by the data the venue gave**. It is **not a safety
  system**: it does not know the weather, the sea state or the crowd, and whether to launch is the
  venue's judgement. The staff screen, the venue's page and the feature document say so.

### I. Permissions and privacy

- **I1.** Rules, the table, the preview and the worklist are `/api/admin/launch-windows` and
  `/api/admin/tides`. Reads are for any staff of the venue; **writes are a manager's**
  (`MANAGER_ONLY`, `STAFF_ACTIONS.launchWindows`, `.tides`), every venue-scoped by the session
  (`denyVenue`), every write in the activity log. The desk sees the screen read-only.
- **I2.** The worklist shows the booking's customer name and number to staff, as the day list
  does; nothing of it is public. The public pages show windows only.

## Consequences

- No new booking path and no change to claims: the database still refuses overlaps, buffers and
  capacity; the window is checked before a claim is made and cannot be raced past it, since a
  window depends on data, not on other bookings.
- A venue with no rule is unchanged: one extra indexed query per day computation.
- Not built: a tournament's or league's court time is not held to a window (their holds go through
  their own slot placement); a venue copied from another does not copy its windows; no
  allowance for a station's distance from the water (the venue names a nearby station and may
  type the heights it wants); no live tide service, by decision.
- Open for the owner: whether a manager may book outside a window with a recorded reason (F1),
  and whether the worklist should message customers on its own (G1 says no: staff decide).
