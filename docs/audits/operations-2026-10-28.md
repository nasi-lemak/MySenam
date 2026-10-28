# Operations audit, 28 October 2026

Three read-only audits of MySenam at commit `f4812fa` (round 7 complete), made
before round 8's work was chosen. Each read the register, the feature
documents and the code of its area, then ran the production build on a
throwaway database with the demo data and walked it in Chromium as the people
concerned, with calls through the same sessions; no real service was used.
None of the findings was in the register as open, and none re-opened a
restriction the owner had decided (the decisions of 24 to 28 October 2026
were checked).

- **X1, operating a venue without support:** the dashboard as a branch
  manager and as the front desk.
- **X2, the customer's and the staff's flows:** booking, paying, waiting
  lists, the account and My Booking on a phone and a laptop; the staff
  dashboard's navigation and forms.
- **X3, money, security and concurrency:** money paths read against the sales
  journal and the period report, routes sent malformed bodies, and races run
  on Postgres.

The findings are kept as they were written, ranked by value within each
audit. Where each stands now is tracked in the [audits index](index.md#operations-audit-28-october-2026).

| Finding | What was found | Category |
| ------- | -------------- | -------- |
| X1-1 | Cancelling a booking paid at the counter writes a full cash refund with no choice, no record of the payout, and the front desk can do it for any booking | defect: money (also operator control) |
| X1-2 | Passes, memberships, credit top-ups and competition fees sold at the counter record no payment method; there is no cash-up for a shift | operator self-service / money reconciliation |
| X1-3 | Staff cannot correct a booking's name, phone number or email | workflow gap / operator self-service |
| X1-4 | Closing a day, cancelling a class, blocking a court and keeping a hire deposit are missing from the staff activity log | defect: data (audit trail) |
| X1-5 | Front desk is shown manager-only controls everywhere, then refused | UX (things the desk is shown but cannot do) |
| X1-6 | The schedule's "day to the minute" lists yesterday's and tomorrow's bookings as zero-minute entries | defect: booking (staff display) |
| X1-7 | Membership, pass, receipt and voucher lists show the newest N with no search, so older records cannot be acted on | operator self-service (lists that grow) |
| X1-8 | Reports and the accountant's exports offer only "last 30 days", "this month" and "last 3 months" | operator self-service |
| X1-9 | No way to start a booking from the dashboard; clicking a free schedule cell blocks the court instead | UX / workflow gap (front desk's commonest task) |
| X1-10 | Staff cannot cancel or move a weekly series as a whole | workflow gap |
| X1-11 | Staff are not alerted when customers cancel or change online | missing notification |
| X1-12 | Classes and tournaments cannot be edited after they are set up, only cancelled | workflow gap / operator self-service |
| X1-13 | Opening hours and prices cannot be changed from a future date | missing capability (operator self-service) |
| X1-14 | Staff accounts: a branch manager cannot add or remove desk staff; passwords are set by the manager with no invitation | operator self-service / security hygiene |
| X1-15 | A new branch cannot copy an existing branch's set-up | operator self-service |
| X1-16 | Draft-period test bookings stay in the books after going live | data / operator self-service |
| X1-17 | No manager price adjustment or complimentary booking | missing capability |
| X1-18 | The day list has no filters and hides its actions at laptop width | UX |
| X1-19 | Counter memberships and passes are priced freely by the desk, not from the venue's plans | operator control (lower priority) |
| X2-1 | Sign-in sends people to another site: open redirect through `?next=` (and text injection through `?error=`) | defect: security |
| X2-2 | A waiting-list place claimed at a venue that holds unpaid bookings is said to be "payable at the counter", and is let go | defect: booking / money (workflow gap) |
| X2-3 | After a failed or abandoned online payment, a held booking is said to "still stand: pay at the counter" | defect: booking / money (customer told the wrong thing) |
| X2-4 | The account page shows a held booking as "Confirmed (pay at counter)", with no way to pay, move or split it | workflow gap (inconsistent behaviour between similar pages) |
| X2-5 | A wrong promo code is found out only after the booking is made at full price | UX (money the customer did not expect to pay) |
| X2-6 | On a phone, the booking form covers the grid and hides its own errors; the Book button comes before what is still to be chosen | UX (phone layout; lost feedback) |
| X2-7 | A 502 or an HTML error page shows "Unexpected token '<' … is not valid JSON" to customers and staff, in English | UX (error states); risk of duplicate bookings |
| X2-8 | Emails and pages send customers to My Booking without their booking: the code and phone are typed again every time | UX / operator self-service |
| X2-9 | A guest cannot leave a waiting list, and nobody can turn an offer down | workflow gap / operator self-service |
| X2-10 | "Please call the venue", with no venue number on the page that says it | UX / operator self-service |
| X2-11 | Past the cancellation cutoff a customer cannot even give the court back | operator self-service (default) |
| X2-12 | A booking made as a guest never reaches the account made later with the same email | missing capability (customer self-service) |
| X2-13 | The staff dashboard has no addresses: a reload, the Back button or a link always lands on Bookings | UX (staff navigation) |
| X2-14 | The front desk's day list and court schedule never refresh themselves | operator UX |
| X2-15 | On a laptop the bookings table hides its actions; rows are by court, not by time | UX (staff) |
| X2-16 | Dates are printed as `2026-10-31` in the booking form, confirmation, My Booking, account and emails | UX / languages |
| X2-17 | The booking confirmation, waiting-list and class dialogs are not dialogs to a keyboard or screen reader | UX (accessibility) |
| X2-18 | Staff forms labelled by placeholder only | UX (accessibility, staff) |
| X2-19 | Enrolling in a class ends without a way to pay online | UX (inconsistent with court booking) |
| X3-1 | Erasing an account cancels its paid upcoming bookings with no refund, nothing owed back and no credit note | defect: money / data |
| X3-2 | Voiding a pass, or a membership without "money back", issues a full credit note though nothing is refunded and entries were used | defect: money / tax |
| X3-3 | A booking cancelled after its account invoice is issued stays on the invoice at full price, with no credit note; the account's "owing" figure disagrees with the invoice | defect: money |
| X3-4 | A tournament takes more entries than `maxEntries` when people enter at once (`enterAs` runs outside any transaction) | defect: concurrency |
| X3-5 | The install's two-factor requirement is bypassed through public routes that act as the counter | defect: security |
| X3-6 | Money a venue keeps from late cancellations is missing from the period report's revenue and tax, which then disagree with the sales journal | defect: money / reporting |
| X3-7 | A venue's staff calendar feed is a plaintext bearer token that never expires (every other link is hashed) | defect: security / data |
| X3-8 | Booking names and emails have no length bound | defect: data / input validation |
| X3-9 | Eighteen routes answer 500 to a JSON body of `null` | defect: error handling |
| X3-10 | A customer's data export leaves out the details they gave for their own e-invoice | defect: data (access right) |
| X3-11 | The refund date given to customers is a UTC date, a day early for refunds noted between 00:00 and 08:00 in Malaysia | defect: date boundary |
| X3-12 | Splitting a booking races: two first splits at once give a 500, and re-splitting can change the share after a friend has paid | defect: concurrency |
