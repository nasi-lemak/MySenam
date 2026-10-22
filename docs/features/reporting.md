# Reports and exports

Authoritative for what venues can see about their business: period reports, customer reports, spreadsheet exports, the sales journal and the staff activity log.

## Reporting

The daily dashboard answers *what is happening today*. A venue owner asks a
different set of questions once a month, and before this they could only be
answered by exporting the database.

Everything is keyed on the date the slot was **played**, not the date the
booking was taken, because that is how an operator thinks about a month.

- **Revenue** is split into *booked* and *collected*, so the gap between them is
  the number a venue chases. Cancellations are counted as their own figure
  rather than folded into revenue: a thin month should read as either "we sold
  less" or "they cancelled", never an ambiguous total.
- **Utilisation** measures against hours that could *actually* have been sold —
  the trading day times capacity, less whole-day closures and any places staff
  took out of service. Marking a court out for maintenance should not make the
  venue look idle.
- **Hours sold by time of day** is the one chart that changes a decision:
  it shows where peak really is, which is a question about the peak rate.
- **Utilisation is reported twice**, for exclusive courts and for shared floors
  and pools, never blended. A forty-place gym offers more place-hours in a
  fortnight than every court in the building put together, so one combined
  figure lets the gym decide the headline and teaches an owner nothing about
  either. The demo data is what made that obvious: courts read 13% while the
  building read 2%.
- **What you still owe** is the part a spreadsheet usually misses. Unspent pass
  entries are hours already paid for that somebody can still walk in and take,
  and lapsing memberships are next month's renewals. Stored credit is shown to
  the platform owner only, because credit is bought at one counter and
  spendable at any — the platform owes it, not the venue that sold it.

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
class enrolments and bookings whose names the retention policy removed are
left out. Managers only, like the other reports.

**Spreadsheets for the accountant.** *Reports* has *Bookings (CSV)*,
*Online payments (CSV)*, *Sales journal* and *Sales summary* for the period shown (`src/lib/export.ts`): every
booking with its price, whether and how it was paid, promo discount, extras,
check-in and no-show; and every payment taken online with what is owed back.
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
the gross and how it was paid. Credit notes are negative. Two categories are
marked *not takings*: **stored credit** and **gift vouchers** are owed to
customers until they are spent, so the booking they pay for is the sale (shown
as paid by *Stored credit*). A **booking paid with a pass** is not a row: the
pass was the sale, taxed when it was sold. *Sales summary* totals it by
category, the takings, and what was received each way.

**The staff activity log** (*Reports → Staff activity*, `src/lib/activity.ts`)
writes down who did what, when, at which venue and to which booking:
payments marked at the desk and how, bookings cancelled, moved or changed,
no-shows, court and price changes (as they were and as they are), refunds,
credit, passes and memberships sold or voided, promo codes, settings, and
staff added, removed or given another role. It squares the till at the end
of a shift and answers "who cancelled my booking?"; search it by booking code
for one booking's history. Entries keep the person's name, so they read right
after an account is removed, and are kept two years.
