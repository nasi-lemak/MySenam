# Reports and exports

Authoritative for what venues can see about their business: period reports, customer reports, spreadsheet exports, the sales journal and the staff activity log.
Status: [feature status](../product/feature-status.md#reporting).

## Reporting

The daily dashboard answers *what is happening today*. A venue owner asks a
different set of questions once a month, and before this they could only be
answered by exporting the database.

Everything is keyed on the date the slot was **played**, not the date the
booking was taken, because that is how an operator thinks about a month.
[Test bookings](../product/marketplace.md#test-bookings-before-going-live),
made before the venue went live, are left out of the figures here and the
customer report, which are performance figures, but never hidden: the
period report adds one line under *Collected* saying how many paid tests stand
in the period and what was paid on them (`testTakings`), apart from the
figures, and the bookings export lists them with *Test booking* in its last
column.

- **Revenue** is split into *booked* and *collected*, so the gap between them is
  the number a venue chases. Cancellations are counted as their own figure
  rather than folded into revenue: a thin month should read as either "we sold
  less" or "they cancelled", never an ambiguous total.
- **Kept from late cancellations** is takings: what the venue kept of a paid
  booking in the period cancelled late (its late-cancellation fee, or all of
  it where it allows no late cancelling) is a line of its own (`lateKept`) and
  is inside *collected*, the split by payment method, by activity and by
  month, and the tax collected. It is the booking's receipt less the credit
  notes that gave the rest back, read from the same documents as the sales
  journal (`bookingGross` and `bookingCredited` in `src/lib/accounting.ts`),
  so the two agree; the fee's tax is worked out on the fee itself, the credit
  note taking the rest of the receipt's. *Outstanding* is what confirmed
  bookings still owe. A booking paid with a pass is left out, as its money was
  taken when the pass was sold; a deposit kept on a booking never paid in
  full is not in the report, as deposits are not
  (`tests/late-cancel-report.test.ts`).
- **Utilisation** measures against hours that could *actually* have been sold —
  the trading day times capacity, less whole-day closures and any places staff
  took out of service. Marking a court out for maintenance should not make the
  venue look idle.
- **Hours sold by time of day** is the one chart that changes a decision:
  it shows where peak really is, which is a question about the peak rate.
- **Courts are measured by their floor.** Each piece of floor that can be sold
  on its own (a court, or each court under a pitch) is counted once: an hour of
  it is in use when any booking covers it, sold as the court or as the pitch
  over it, and it is taken out where a block or outage on either covers it. A
  hall sold as one futsal pitch every evening therefore reads full, not a
  third idle, and the pitch is not a third court's worth of hours to sell.
  Beside it the report gives what the courts took per hour of floor that could
  have been sold, and each court's line shows its own hours sold and, where a
  court sharing its floor was booked, the hours it was **in use** (not free to
  sell) besides ([B11](../roadmap/known-limitations.md#fixed-since-the-audit);
  `tests/reports-floor.test.ts`).
- **The occupancy grid** (*Occupancy*, `getOccupancy` in `src/lib/store.ts`)
  shows each court's next seven days by the same measure: place-hours booked
  against place-hours that could have been sold, which are the day's own
  hours times capacity, nothing on a closed day, less every place a block or
  outage takes out for its time. Two kayaks of six blocked for an hour take
  two place-hours, not the hour; the cell says how many were taken out
  (`tests/partial-blocks.test.ts`, `tests/components/occupancy-tab.test.tsx`).
  Under a resource taking [entries with no set time](venue-operations.md#entry-with-no-set-time)
  each cell also counts the people let in that day; they are a count, not
  place-hours, and are not in the percentage or the totals below.
  A court's cell counts the hours it was in use, so a court under a booked
  pitch shows that hour too. Below the courts each day has two totals,
  measured exactly as the report measures that day (`measureUse` in
  `src/lib/reports.ts`, shared by both): the courts' floor, counted once, and
  the shared facilities' places, apart. They are not the cells added up: a
  pitch over two courts booked for an hour is two hours of floor, not three,
  and a busy gym does not move the courts' figure. A row is left out where
  the venue has nothing of its kind (`tests/occupancy-totals.test.ts`).
- **Utilisation is reported twice**, for exclusive courts and for shared floors
  and pools (places sold against places offered: a booking takes as many
  places as it has players), never blended. The report's other hours (in all,
  by activity, by month and by hour of the day) count places the same way, so
  a gym session for three is three place-hours wherever it appears
  (`tests/occupancy-totals.test.ts`). A forty-place gym offers more place-hours in a
  fortnight than every court in the building put together, so one combined
  figure lets the gym decide the headline and teaches an owner nothing about
  either. The demo data is what made that obvious: courts read 13% while the
  building read 2%.

- **What you still owe** is the part a spreadsheet usually misses. Unspent pass
  entries are hours already paid for that somebody can still walk in and take,
  and lapsing memberships are next month's renewals. Stored credit is shown to
  the platform owner only, because credit is bought at one counter and
  spendable at any — the platform owes it, not the venue that sold it.
  It is reported customer by customer, never netted: what customers hold
  (owed to them) is one figure, and apart from it what customers whose
  balance went below nothing after a chargeback owe (how many, and how much),
  labelled as not income. The two together are the ledger's total. A
  balance below nothing is a debt to collect, not revenue.
- **Money kept from a hire deposit** is a sale per reason: in the day's
  takings, on a receipt, and in the sales journal and exports under its own
  heading — *Hire: damage and loss*, *Hire: extra charges*, *Hire:
  penalties*, or *Hire deposits kept* for other reasons — and, in the
  export's *Tax basis* column, whether its tax treatment was a provisional
  default, the venue's unreviewed choice, or reviewed by the venue's adviser
  ([venue operations](venue-operations.md#money-kept-from-a-deposit)).

Two colours carry the whole tab and mean one thing each: teal is money in hand,
amber is money still owed. The pair is checked for colour-vision separation and
contrast rather than chosen by eye, both are direct-labelled and legended, and
every figure is also available as a number, so nothing is readable by colour
alone.

### Customers

Below the money, *Reports* says who the customers were in the period
(`src/lib/customer-report.ts`): how many, how many booked here for the first
time ever and how many came back, bookings per customer, the share of bookings
played that nobody turned up for, and late cancellations. Then the ten best
customers by what they spent, with their hours and since when they have been
coming; and the regulars who have stopped: four or more bookings in the six
months before, none in the last 45 days and none coming, with a number to
call. A customer is a phone number however it was typed; demo bookings,
test bookings from before going live (a performance figure), class enrolments and bookings whose names the retention policy removed are
left out. Managers only, like the other reports.

**The period** is any from and to (up to 400 days), typed in the two date
fields, or one of *Last 30 days*, *This month*, *Last month* (its first day to
its last, as the accountant asks for at the start of the next) and *Last 3
months*; the exports below take the same period.

**Spreadsheets for the accountant.** *Reports* has *Bookings (CSV)*,
*Online payments (CSV)*, *Sales journal* and *Sales summary* for the period shown (`src/lib/export.ts`): every
booking with its price, whether and how it was paid, promo discount, extras,
a manager's price adjustment, check-in and no-show; and every payment taken
online with what is owed back.
They open straight in Excel (byte-order mark, quoted cells, and a cell that
would start a formula is kept as text). Managers only, and each download is
in the activity log, since customers' names and numbers leave with it.

**The sales journal** (`src/lib/accounting.ts`) is what the accountant keys
into SQL Accounting, AutoCount, Xero or QuickBooks. It has one row for every
receipt and credit note dated in the period, on the venue's own calendar,
including booking receipts, which are drawn from the bookings when they were
paid; a booking that stops being paid (a chargeback lost) keeps its receipt in
its own period as a document of its own, and the credit note is dated when it
was lost. Each row carries the number, the customer, a category (*Court hire*,
*Classes*, *Memberships*, *Passes*, *Tournament entries*, *League fees*,
*Game shares*, *Stored credit*, *Gift vouchers*), the net, the tax inside it,
the gross and how it was paid, and in its last column whether it is a
[test booking's](../product/marketplace.md#test-bookings-before-going-live)
from before going live (kept, as every numbered document is, and shown in the
cash-up in a block of its own; left out only of the consolidated e-invoice). Credit notes are negative. Two categories are
marked *not takings*: **stored credit** and **gift vouchers** are owed to
customers until they are spent, so the booking they pay for is the sale (shown
as paid by *Stored credit*). A **booking paid with a pass** is not a row: the
pass was the sale, taxed when it was sold. *Sales summary* totals it by
category, the takings, and what was received each way. The journal and the
exports are the same whatever language the reader uses: each receipt's lines
are as written, even where the customer's own receipt says a built-in
concession's price in their language
([regions and tax](../product/regions-and-tax.md#tax-sst-and-gst)).

### Staff activity log

**The staff activity log** (*Reports → Staff activity*, `src/lib/activity.ts`)
writes down who did what, when, at which venue and to which booking:
payments marked at the desk and how, bookings cancelled, moved or changed,
no-shows, court and price changes (as they were and as they are), refunds,
credit, passes and memberships sold or voided, promo codes, settings, and
staff added, removed or given another role. It answers "who cancelled my
booking?"; the till is squared at the end of a shift with the
[cash-up](payments-and-credit.md#cash-up), which front desk sees for its own
shift; search it by booking code
for one booking's history. Entries keep the person's name, so they read right
after an account is removed, and are kept two years.

Every staff write is in it. A day closed writes one entry with what it
called off (`day.closed`: bookings, classes and their enrolments), a
`class.cancelled` for each class, and a `booking.cancelled` under each
booking's and enrolment's own code, worded as a single cancellation's with
why; cancelling a class, a rain-out and a court taken out of service do the
same for what they cancel. So do: opening a closed day again, scheduling
and changing classes ([changing a class](programmes.md#changing-a-class)),
blocking and unblocking a court, kit handed out and taken back with the money
kept from its deposit and how it was held, extras, notices, inductions
recorded and withdrawn (a participant by their id only), going live, new
tournaments, competitions and leagues, a tournament's details changed
([changing a tournament](tournaments.md#changing-a-tournament)), league fees
marked paid or not and players taken out, a failed message sent again (and
to which address, when staff corrected it), WhatsApp settings and packs,
photos, and an online payment account removed. Each kind of entry has words
in the staff languages (`src/lib/activity-labels.ts`, `ActivityPanel.tsx`).

`tests/staff-log-coverage.test.ts` reads every `POST`, `PUT`, `PATCH` and
`DELETE` handler under `src/app/api/admin` and fails for one that neither
writes to the log nor calls a function of `src/lib` that does, unless it is
on its list of handlers that need no entry, each with why: signing in and out
and one's own password, the platform owner's running of the install itself
(error reports, alerts, backups, retention runs, demo data, businesses,
storefronts, venue applications, the platform's invoices), a draft branch
added, and the set-up checklist. `tests/activity-labels.test.ts` fails for a
kind of entry without words, including one chosen by `? :`.
