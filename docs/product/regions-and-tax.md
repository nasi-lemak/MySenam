# Countries, tax and regional settings

One install serves one country. Authoritative for what differs between Malaysia and Singapore and for venue and platform tax.

## Countries

MySenam runs **one install per country**. `MYSENAM_COUNTRY` (`MY`, the
default, or `SG`) decides everything that differs between them, from one
table in `src/lib/region.ts`:

| | Malaysia (`MY`) | Singapore (`SG`) |
|---|---|---|
| Currency | RM, ringgit | S$, dollars |
| Time zone | Asia/Kuala_Lumpur | Asia/Singapore |
| Phone numbers | +60, written locally with a leading 0 | +65, eight digits |
| Languages | English, Bahasa Malaysia, Simplified Chinese and Tamil | English, Simplified Chinese and Tamil |
| Map and address lookups | Malaysia | Singapore |
| Default payment gateway | Billplz (FPX, cards) | Stripe (cards, PayNow) |
| Counter QR scheme | DuitNow QR | PayNow QR |
| SMS prefix | `RM0` | none |
| Terms cite | the laws of Malaysia, the Consumer Protection Act 1999, the Personal Data Protection Act 2010 | the laws of Singapore, the Consumer Protection (Fair Trading) Act 2003, the Personal Data Protection Act 2012 |
| Starter venues on a fresh install | four, in the Klang Valley | none |
| Suggested plan tiers (*Plans by size*) | RM19.90 / 39.90 / 69.90 / 99.90, RM2 a resource past 50 | S$29 / 59 / 99 / 149, S$3 a resource past 50 — a starting point to set, not researched |

- **Money** is shown with `money()` and, in phrases, `{cur}`; nothing writes
  a currency symbol by hand. Amounts are kept in major units to the sen or
  cent (S$4.80, RM18.50; a whole amount shows bare, S$20), prices are checked
  with `isAmount()` and totals rounded with `roundMoney()`, so 4.80 × 3 is
  14.40. A gateway is given the currency with each payment and refuses one it
  does not take.
- **The browser** learns the country from the language provider in the root
  layout, so a client component formats money and phone numbers as the
  server does.
- **Time**: both countries are UTC+8 all year. Each venue keeps its own zone
  (below), so a country with several zones (Indonesia) works. Where a zone
  changes its clocks, bookings touching the change are refused
  ([booking time model](../architecture/booking-time-model.md#time)); no
  country in the table has such a zone, and a test says so, because adding
  one is a decision of its own ([known limitations](../roadmap/known-limitations.md)).
- **Phone numbers** have one key however they are written (`src/lib/phone.ts`
  and the database's `phone_key()`, migration 0035): `+60 12-345 6789` and
  `012-345 6789` are one number, `+65 9123 4567` and `9123 4567` another, and
  a Singapore landline that begins 60 or 65 stays itself.
- **Not covered by the setting**: the brand name (`SITE_NAME`), and the
  privacy notice and terms, which need a lawyer in each country. Demo data
  (`src/lib/demo.ts`) fills whatever venues the install has, with phone
  numbers in its country's shape.
- **Languages** are English, Bahasa Malaysia (`ms`), Simplified Chinese
  (`zh`) and Tamil (`ta`), each country offering its own; the switch in the
  header sets a cookie. The Malay, Chinese and Tamil dictionaries
  (`src/lib/i18n.ts`, `src/lib/i18n-zh.ts`, `src/lib/i18n-ta.ts`) are typed
  against the English, so a phrase missing from any does not compile, and the
  tests check each fills the same placeholders. Dates are formatted for
  `zh-Hans`; WhatsApp templates go to Meta as `zh_CN` and `ta`.
- **A link in a message opens in the message's language.** The language is
  a cookie, set only by the switch, so a link opened in a browser that has
  never been to the site would open in the install's first language. Every
  link MySenam sends a customer carries the message's language as a fixed
  parameter (`?lang=ms`, `src/lib/link-locale.ts`): one of the four
  languages, added to an address MySenam built, never a URL from a request,
  so it cannot redirect anywhere; the link keeps its token and expiry as
  they were. The middleware passes it to the page only after checking it
  against the four (dropping any such header a browser sent), and the page
  uses it only where the person has not chosen a language: a choice made
  with the switch wins. So that the pages reached from there by moving
  around the site stay in that language, the middleware also keeps it for
  the browser session in a cookie of its own (`ms_link_lang`, holding the
  language and nothing else, out of scripts' reach), set only while nobody
  has chosen a language: a newer link's language replaces it, the switch
  always wins over it, and closing the browser forgets it
  ([which links](../integrations/messaging.md#messages-to-customers);
  `tests/link-locale.test.ts`).
- **Times** are written by one formatter (`Intl.DateTimeFormat`, through
  `clockTime` in `src/lib/region.ts`; `formatHour` and `formatMinute` use
  it), on customers' pages and in messages alike: English *6:30 PM*, as the
  pages always wrote it; Malay *6:30 PTG* (*PG* before noon); Chinese
  *下午6:30*, asked for the 12-hour clock outright, since a browser without
  data for Malaysia's Chinese (Chromium's) falls back to plain Chinese, whose
  default is *18:30*; Tamil on the 24-hour clock, *18:30*, because its 12-hour form
  differs between the server's CLDR data (*6:30 PM*) and browsers'
  (*பிற்பகல் 6:30*) and a page must read the same on both. A booking's
  hours are the venue's wall clock and written as they stand; a moment (a
  guardian change, a payment deadline) is read in the venue's time zone
  (`tests/message-times.test.ts`). Staff read times the same way, in the
  staff language (*Times for staff*, below).
- **The staff dashboard** is in English, Malay and Chinese, not Tamil (the
  owner's decision of 24 October 2026): the install's languages less Tamil,
  and the language switch on the dashboard offers only those. Its phrases are
  in their own dictionaries, one file per area of the dashboard
  (`src/lib/staff-i18n`), apart from the customer dictionaries so customers'
  pages do not carry them; the types refuse a missing translation.
  `tests/staff-i18n.test.ts` checks the placeholders and the simplified
  characters, and parses every staff screen to fail on any text a person
  would read that bypasses the dictionaries. Refusals the server sends are
  shown in the staff language by their code, or by their English sentence
  (`src/lib/staff-i18n/refusals-*.ts`).
- **Text the server composes for staff screens** is said in the staff
  language too (`src/lib/staff-text.ts`): the server sends, beside the
  English it always sent, a phrase of the staff dictionaries' server area
  (`srv.`, `src/lib/staff-i18n/server.ts`) with its values, and the screen
  says it (`t.say`). The English is that same phrase said in English, so
  emails, logs, the activity log and anything reading the English are
  unchanged. This covers location warnings on applications, what a draft
  still needs, system alerts and the detail MySenam wrote for them, why a
  pass, code or membership cannot be used, how a voucher was paid, backup
  problems and why off-site copies are paused, the retention lines, what
  the made-up month added, deposit-keep reasons, a court's day (buffers,
  offers, "Out of service", "Closed") and its booking rules in a line,
  e-invoicing's missing fields, gateway methods, fields, help and set-up,
  chargeback reasons and stages, catalogue notes, competition templates,
  what a tournament result, correction or replay changes or why it cannot
  go ahead, round names, message kinds and transports, and urgent notices'
  lines. Names the dashboard knows by a code (a template's key, a gateway's
  field) are looked up by that code (`t.known`), falling back to the
  server's English for one it has no phrase for.
- **Times for staff** are in the staff language
  too (the owner's decision of 28 October 2026), by the same formatter
  (`src/lib/region.ts`: `clockTime`, `minuteClock` for a minute of the
  venue's day, `clockRange`, `hourHeading` for the schedule's columns, and
  `momentDay`, `momentText` and `momentClock` for a stored moment), on every
  staff screen: the schedule, bookings, lessons and coaches, waiting lists,
  reports, the activity log, urgent notices, payments, messages, receipts,
  backups and the rest. A booking's hours are the venue's wall clock and are
  written as they stand; a moment (checked in, sent, paid, logged) is read
  on the clock and the day of the venue it happened at, or a tournament's
  or class's own venue, from the zones the dashboard has
  (`useStaffClock`, `src/components/admin/StaffLanguage.tsx`), and in the
  install's zone where it belongs to no venue. Days stay written
  `YYYY-MM-DD`, as booking dates are, but are the venue's day, not UTC's.
  Amounts are `money()`'s: a whole amount bare (RM80), any other to the sen.
  A time the server puts in a phrase for staff (an urgent notice's hours, a
  court's start times, a replayed match's time, an open-game share's
  receipt line) is kept as a time of day (`clockValue`,
  `src/lib/staff-text.ts`) and said in the reader's language; its English is
  what it always was. A refusal translated around the values it carried
  says its times in the staff language too. What staff are sent: the staff
  calendar feed's words and times are in the staff language its address
  names (`?lang=`, the language of whoever turned it on or looked it up,
  [staff calendar](../integrations/messaging.md#bookings-in-staffs-own-calendar));
  a coach's emails are in the install's first staff language and their
  calendar in the language their page linked it in
  ([coaches](../features/programmes.md#a-coachs-own-schedule-no-account-needed));
  a venue's booking alerts are in the install's first language, their hours
  as it writes them. **What stays as it is:** what software reads (form
  inputs' `HH:MM`, spreadsheets and exports, API responses, sorting,
  iCalendar's start, end, zone and ids, stored timestamps), the English the
  server keeps beside each phrase, and text stored in English (the activity
  log's details, receipt descriptions, refusals with no translation), whose
  times stay as they were written (`tests/staff-times.test.ts`,
  `tests/components/staff-times.test.tsx`).
- **What stays as stored or as sent:** what people typed (a block's reason,
  a counter top-up's reason, a correction's reason, names), the errors
  gateways, LHDN, mail and WhatsApp providers send, raw exception text and
  stack traces, the activity log's details, and records written before
  phrases were kept: credit lines, receipt lines, alerts, urgent notices and
  tournament corrections from before migration 0120 show their English. New
  ones keep their phrase beside the English (migration 0120; a receipt's
  line and a progression issue's affected matches inside their own JSON).
  A receipt itself, as printed, says its lines' English, except a booking's
  court time and a built-in concession's price ([receipts](#tax-sst-and-gst)).
- **The Tamil is a machine translation awaiting a native speaker's review**
  before a venue relies on it: in particular the words chosen for venue
  (மையம்) and court (கோர்ட்), sports terms such as walkover and bye, and the
  sentences put together from pieces (search results, the booking
  confirmation, the privacy page). To take it off an install until then, drop
  `"ta"` from the country's `locales` in `src/lib/region.ts`.
- **Time zones, venue by venue.** Each venue's courts run on its own clock:
  bookings are wall-clock times there (18:00 on the 4th), and its zone turns
  them into moments: when a slot has passed, the booking window, the
  cancellation cutoff, check-in, reminders and calendar invites. Zones are
  IANA names; none in the region table has daylight saving (handled as in
  the [booking time model](../architecture/booking-time-model.md#time)).
  - **Worked out from the map pin**, not the address: the pin is a point
    already checked to be in the country, while an address is free text.
    The lookup (`@photostructure/tz-lookup`, server only) is kept to the
    country's own zones (`timeZones` in the region table: Kuala Lumpur and
    Kuching for Malaysia), and with no pin the venue is in the install's
    zone. Because it is worked out when needed (`venues.time_zone` NULL,
    migration 0043), moving the pin moves the zone.
  - **Chosen by a manager** under *Venue details → Time zone* where the pin is
    wrong. A chosen zone stays put when the pin moves; *From the map pin*
    goes back. The setting only shows where the country has more than one
    zone.
  - Malaysia and Singapore are UTC+8 without daylight saving, so today this
    changes nothing anyone sees. It is what lets an install take venues in
    Indonesia's three zones later. Install-wide clocks
    (billing months, backups, the scheduler) stay on the install's zone.
- **Adding a country** is a row in that table, its dictionary if it speaks a
  new language, and a gateway if it needs one (*Payment gateways*).

## Tax (SST and GST)

Two different taxes pass through MySenam, and neither is MySenam's to decide
(`src/lib/tax.ts`). Rates and numbers are settings, so an accountant's answers
drop in without code.

**A venue's own**, on what customers pay it. A venue registered for SST or
GST sets the tax's name, its rate and its registration number under *Venue
details → Tax* (managers only).

- **Prices stay what customers pay, tax included.** Singapore requires
  GST-inclusive prices to consumers, and Malaysians are used to "RM20 incl.
  SST", so tax never changes what anybody pays, only how it is broken down:
  the tax inside RM21.20 at 6% is RM1.20.
- **Each booking keeps the rate it was taken at.** A trigger sets it on every
  new booking, however it is made (migration 0036), so a later change of
  rate, or deregistering, does not rewrite what was charged.
- **Receipts.** A paid booking has a receipt page, `/receipt/<code>?t=…`,
  behind a link signed with the install's secret rather than the customer's
  phone number. Where the venue charges tax it is titled *Tax invoice* and
  shows the amount before tax, the tax at its rate, the total and the venue's
  registration number. The receipt email links to it and says how much tax
  the payment included; My Booking links to it too. Its headings are in the
  reader's language and its lines as written, except two. A booking's court
  time (`slot` on the line) reads in the reader's language: the activity's
  name, the hours as the language writes them and how many places, with
  whom the places are for where the booking names anybody other than its
  customer (*…, for Alya, Bilal*; [receipts for a guardian](../features/payments-and-credit.md#receipts-for-a-guardian)).
  And the price of a built-in
  concession (student, senior, child, OKU; [pricing](../features/pricing.md#concession-prices)):
  that line keeps the concession's key beside its words (`concessionPreset`
  on the line), and the receipt says it in the reader's language (*Student
  price*, *Harga Pelajar*, *学生优惠价*, *மாணவர் விலை*), or as written in a
  language with no words for it, or one the install does not offer, which
  reads in the install's own. A concession the venue named itself is shown
  as typed. One person's own price on their place
  ([what a benefit applies to](../features/pricing.md#what-a-benefit-applies-to))
  is said the same way with their name as written: the line keeps whose
  place it was beside its words (`place` on the line) and, for a built-in
  concession, its key (*Member price, Alya* reads *Harga ahli, Alya*,
  *会员价（Alya）*, *உறுப்பினர் விலை, Alya*; a concession the venue named
  itself stays as typed). Only the words change: the amounts, the number, the tax and the
  line as stored are the same for every reader, and the sales journal,
  exports and e-invoices keep the words as written (with whom a line is for,
  while the receipt still names them:
  [privacy](../architecture/privacy.md#receipts-and-credit-notes)). A receipt from before
  lines kept the key reads in the customer's language only where it can be
  told for certain: a booking whose concession is still that built-in one,
  word for word, under the same name; a credit note or kept receipt whose
  booking's own line today has the same words and amount. Anything else
  shows as stored, and nothing stored is rewritten for it (`receiptLineText` in
  `src/lib/receipts.ts`, `tests/receipt-languages.test.ts`).
- **Receipts for everything else sold.** A membership, a pass, a credit
  top-up, a tournament entry, a league fee or a share of a game gets a
  receipt as it is paid, at the counter or online: a document written once
  (`receipts`, migration 0040) with the next number at its venue (`R-000001`,
  `R-000002`, …), the tax as it stood that day and how it was paid, at
  `/receipt/R<id>?t=…`. Customers find theirs on their account page and on the
  page they come back to after paying online; staff find the venue's under
  *Credit & passes → Receipts and credit notes*, to reprint one.
- **Credit notes.** Reversing a sale makes a credit note (`CN-000001`, …)
  for what is given back, at the tax it was sold at, naming the receipt it
  reverses: a paid booking cancelled (all of it, or what is left after a
  late-cancellation fee, whose own tax stays with the fee), a pass or
  membership voided with money handed back (a pass's unused part, a
  membership in full; voided without, it stays sold and nothing is
  credited), an online payment refunded, a fee marked paid at the counter
  and then unmarked. A cancelled booking's receipt links to its credit note.
- **Tax is counted once.** Credit carries no tax when bought: it is taxed
  when spent, on the booking it pays for. A pass is taxed when sold, so a
  booking paid with one carries none of its own and its receipt says so. A
  booking's receipt shows what its host paid: shares paid by other players
  are on their own receipts.
- **Reports and exports.** The Collected figure says how much tax is inside
  it, at each booking's own rate, plus the tax on the period's other
  receipts less their credit notes, and the tax on what was kept of
  bookings cancelled late ([reports](../features/reporting.md#reporting));
  the bookings spreadsheet has each booking's rate and tax.
- One rate covers the whole booking, add-ons included.
- **Money kept from a hire deposit** carries the venue's tax according to
  why it was kept, not a choice at the desk: each country has a usual
  treatment by the money's nature (in Malaysia and Singapore a charge for a
  service or a fee is taxed; compensation, a replacement and a penalty are
  not), which a manager can change per reason. The defaults are provisional
  until the venue records its adviser's review; MySenam does not decide
  whether an amount is consideration for a supply
  ([venue operations](../features/venue-operations.md#money-kept-from-a-deposit)).

**The platform's own**, on what it invoices venues. Set `MYSENAM_TAX_RATE`
and `MYSENAM_TAX_REG_NO` once the operator is registered:

- Invoices from then on add the tax on top of the fee (tier prices are before
  tax, as is usual between businesses); `amount` is what the venue pays,
  including it. A business's invoice is taxed on its whole net, worked out
  again as each branch's line is added.
- The rate, name and number are kept on each invoice as they were on the day.
  An invoice issued before registration stays without tax.
- *Billing* links each invoice to a printable page, `/admin/invoices/<id>`,
  for that venue's or business's staff and the platform's owners: a *Tax
  invoice* with the operator's details (`OPERATOR_*`), its tax number, the
  venue's own tax number if it has one, the lines, the total before tax, the
  tax and the total.

**Singapore's InvoiceNow is not built.** It is required from the start for
anybody registering for GST voluntarily from 1 April 2026, and from 2028 for
others: an API integration through a Peppol access point, worth building when
an operator there is in scope. Until then the printable invoices and the CSV
exports are what an accountant works from.
