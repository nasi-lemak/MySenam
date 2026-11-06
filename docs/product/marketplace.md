# The marketplace

Running MySenam as a shared marketplace of independent venues: sign-up, going live, billing, suspension and storefront domains. Authoritative for venue onboarding and marketplace billing rules.

## Running the marketplace

With `MYSENAM_MARKETPLACE=on`, the install is the shared MySenam marketplace:
independent venues, players booking across them.

- **Businesses sign themselves up** at `/list-your-venue` (linked from the
  footer) and start straight away. Once they confirm their email, their
  account opens with the venue as a **draft**: theirs to set up — courts,
  rates, hours, staff, classes, passes, test bookings — and nobody else's to
  see. A banner on their dashboard says it is a draft, lists anything missing
  (a court, a pin), and sends it to **go live**. Bookings made meanwhile are
  [test bookings](#test-bookings-before-going-live).
- **Going live is what the platform owner approves**, under *Venues & staff →
  Going live*, with the evidence set out — see *Checking a venue is real*. Not
  yet? They are told why, keep everything they set up, and can ask again.
- **Nothing reaches the public before then.** A draft is not listed,
  searched, or shown on the classes page; its page answers only its own staff,
  as a preview; customers cannot book it, join its waitlist or pay it online;
  and nobody is messaged about its bookings. One rule decides all of it
  (`src/lib/listing.ts`).
- **Drafts nobody comes back to go.** A business that never went live, and
  that nobody has signed in to for 90 days, is deleted with what it set up —
  unless it holds something of a customer's (a pass, a membership, credit, a
  payment, an invoice), which is left for the owner to look at. Everything else it set up goes with it, found from the database's
  foreign keys rather than a list (`src/lib/drafts.ts`), and one that cannot be deleted is left and the owners are told
  (`retention:stale-draft-not-deleted`): it never stops the rest of the day's retention run or a dashboard from opening.
- **Signing up does not say who works at a venue.** An address that already holds a staff account, or has a sign-up waiting, gets
  the answer a new address does and an email saying what it can do (at most one an hour); the page never says whether an address belongs to somebody
  at a venue. On an install that cannot send email nobody could be asked to confirm either, and it says so
  ([ADR 0057](../architecture/decisions/0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md)).
- **Stored credit is per venue** — see *Whose credit it is*.
- **Venues are invoiced monthly.** Each pays its own agreed fee if it has
  one; else its tier by size, once the owner has set tiers (see *Plans by
  size*); else `MYSENAM_VENUE_FEE` a month — from the date billing starts — set when it goes live, after
  `MYSENAM_FREE_MONTHS` (one, unless set). Setting up is free however long it
  takes; the free months count from going live. Every full month from then is invoiced once, on the
  first; a venue joining on the 16th has the rest of that month free, and
  nothing is prorated or back-billed. Venues that predate billing are not
  billed until the owner gives them a start date. Invoices are due in 14 days.
  Venue staff see theirs under *Venues & staff → Billing* and can pay online
  into **the platform's own Billplz account** (`BILLPLZ_*`), which is never a
  venue's: this is the platform's income. The owner sets each venue's fee and
  start date there, and marks a bank transfer paid or voids an invoice. Marking paid and voiding each need a reason (5 to 300 characters),
  and every one of those decisions, the fees and plans by size, grouping venues into a business, making staff its managers, adding or
  approving a venue and suspending or lifting one is in the [staff activity log](../features/reporting.md#staff-activity-log) with the
  owner's name and the figures before and after, where the venue's or business's own managers read it.
- **How MySenam fits a business** is explained at `/for-venues` (linked from
  the site's navigation): the visitor picks the kinds of business and
  activities and sees a day in MySenam for them, what is and is not supported,
  and the way on to `/list-your-venue` with the choice carried. It writes
  nothing ([the public guide](../features/venue-guide.md#the-public-guide)).
- **Prices are published** at `/pricing` (linked from the footer and the
  sign-up page), worked out from the same tiers and settings the invoices
  use, so the page cannot say one thing and the bill another.
- **An invoice more than 14 days overdue** (28 days after it was issued) takes
  every venue on it off the marketplace until it is paid: not listed, not
  bookable, not payable online. The venue's managers are emailed the invoice
  when it is issued and again three days before it falls due
  ([messaging](../integrations/messaging.md#the-platforms-invoice-to-a-venue)); a week
  after the due date, its staff are emailed once with the amount and the date it happens. When it happens, they and the
  owner are emailed; the dashboard keeps working and bookings already made
  stand. Paying it, or the owner marking it paid or voiding it, puts the venue
  back at once. It is worked out afresh from the invoices by the scheduler,
  and whenever anybody opens *Billing* (`src/lib/payment-holds.ts`).
- **The owner can suspend a venue, or a whole business**, with a reason its
  staff are emailed: under *Venues & staff*, on the venue (*Suspend*) or under
  *Businesses* (*Suspend the business*). Customers stop seeing it at once, as
  for an unpaid invoice; staff can still sign in, and bookings already made
  stand — cancel them separately if they should not. A suspended business
  cannot add a branch or send one live. Only the owner lifts a suspension:
  paying an invoice does not, and lifting one on a venue that still owes
  leaves it off for that (`src/lib/suspensions.ts`).
- **Terms** live at `/terms`, for players and, on a marketplace, for venues.
  They are a starting draft written to match what the software does — who
  holds the money, who refunds it, whose credit is whose — and **not legal
  advice: have a Malaysian lawyer review them before relying on them.** Set
  `OPERATOR_NAME`, `OPERATOR_REG_NO`, `OPERATOR_ADDRESS` and `OPERATOR_EMAIL`;
  until `OPERATOR_NAME` is set the page says it has not been completed.

## Test bookings before going live

A booking made while its venue is a draft is a **test booking**: the set-up
checklist asks for one, and staff try the counter, take a payment and print a
receipt on them (`src/lib/test-bookings.ts`, migration 0254). The database
marks each as it is written (`bookings.test`), whichever path writes it.
Bookings already made at venues still in draft when the migration ran were
marked too; nothing at a venue already live changed.

**A test is synthetic, or it is accounted for. Marking a booking a test never
takes money out of the financial records.**

- **It stays a booking.** It holds its court, and its receipt and credit
  notes are kept and numbered as any are. A receipt is never deleted or
  numbered again: one given in a test is reversed by a credit note.
- **Left out only of performance and the e-invoice**: the occupancy measures,
  the customer report, strikes, loyalty and review requests, and the month's
  [consolidated e-invoice](../integrations/myinvois.md) (no sale was made
  while the venue is a draft; at a venue that is live a test standing with a
  payment on it is money taken, so it goes in).
- **Never out of the money.** Its payments, refunds owed, counter payouts and
  credit stay where staff and the owner look for them (the owed lists, the
  reconciliation, the integrity check, the wallet and pass ledgers); the sales
  journal and the bookings export list it marked *Test booking*; the
  [cash-up](../features/payments-and-credit.md#cash-up) shows its receipts
  and credit notes in a block of its own, with its own lines by method and
  totals, and one line telling staff that if any of it was real money they keep
  that booking as real; the period report says what was paid on tests, apart
  from its figures ([reporting](../features/reporting.md#reporting)). Nothing
  of it is added into the real totals.
- **Staff see it marked** *Test* in the day list.
- **A manager clears them**, from the go-live banner (*Clear all test
  bookings*), or by ticking *Also clear my test bookings* when sending the
  venue to go live (unticked until asked). Each test booking still standing
  is cancelled with everything paid given back the way it was paid (credit
  to credit, a pass's entry to the pass, money paid online owed back on the
  payment), played or not; nobody is messaged and no strike is counted. One
  with kit still out on hire is left, and said.
- **Clearing says whether real money moved.** Where any chosen booking has a
  counter payment on it (cash, QR, transfer, card terminal, or a tick whose
  method was never recorded) the manager must answer, with nothing chosen for
  them (`moneyTaken`): *No, a try-out*: its receipt is reversed by a credit
  note and nothing is handed back, and the log says it was **declared
  synthetic** and by whom. *Yes, real money was taken*: each counter payment is
  **owed back** exactly as the venue's own bulk cancellations owe it
  ([owed back](../features/payments-and-credit.md#owed-back-after-the-venue-cancels),
  cause *test booking cleared, real money taken*): no credit note and no payout
  until a named person hands it back or gives it as credit from the day list,
  never reported as handed back before then, one taken on an earlier day by a
  manager. The answer is not asked for what was paid online, with credit or
  with a pass, which go back as they were paid.
- **Or keeps one as real** (an advance booking entered while setting up):
  *Keep as real* puts it in the figures like any other booking, on the days
  it was played and paid; not once its receipt's month has gone to LHDN
  consolidated without it. The log says who said it is real.
- **Real money after going live is never a test.** When a booking's payment
  becomes *paid* (counter, online confirmation, credit or a pass) at a venue
  that has gone live, the database makes it a real booking at once
  (`bookings_paid_real`, migration 0259), so what is taken after going live is
  in the figures and the e-invoice like any sale.
- **A venue cannot go live with a paid test standing.** Asking to go live is
  refused (409, naming the codes) while any standing test booking has a payment
  recorded (paid, or money paid online or as a share towards it), unless the
  same request clears them with the answer above; clear them or keep them as
  real first. The platform owner's approval is refused likewise, with the
  count, for a test paid after the request, until the venue has dealt with it.
  Unpaid tests may remain.
- Clearing and keeping are a manager's (`MANAGER_ONLY`), each in the
  activity log (`booking.test_cleared`, `booking.test_kept`). The list stays
  on the dashboard after going live until none is left.

Clearing is offered, never automatic: going live is decided by the platform
owner, and a venue may have entered real advance bookings while setting up.
Only a test paid at the counter, online, in credit or by a pass at a draft
venue is held; the answers are the manager's own word, recorded, not checked
against the till (`tests/test-bookings.test.ts`,
`tests/test-bookings-money.test.ts`, `tests/cash-up.test.ts`,
`tests/components/test-bookings-panel.test.tsx`). Online money in those tests
is a stand-in gateway's, not a live check.

## Checking a venue is real

Nothing about a venue is taken on trust before customers see it, and nothing
is decided automatically either: the platform owner decides whether it goes
live, with the evidence in front of them.

- **A pin on the map.** The applicant taps their entrance on a map
  (OpenStreetMap, through Leaflet), after the form has flown it to the
  address they typed, or uses their phone's location from inside the venue.
  No pin, or a pin outside Malaysia, and the form is not accepted.
- **The address, looked up.** When they apply, the address is looked up
  (Nominatim), and so is what the map calls the place at the pin. The panel
  flags a pin more than 1 km from where the address leads, a pin whose
  place doesn't mention the area they typed, an address the map doesn't
  know, and another business's venue listed within 150 m of the pin — and
  links to Google Maps and Street View at the pin. A new taman missing from
  OpenStreetMap is common; a flag is a reason to look, not to refuse.
- **A confirmed email.** Signing up emails a link, good for 7 days, and no
  account opens until it is followed. Signing up again from the same
  unconfirmed email replaces the first, and an unconfirmed one is deleted
  after 7 days. An install that cannot send email opens the account at once,
  and the go-live request says the email was never confirmed.
- **What it has set up.** Each request shows its courts, sports and rates,
  with a link to its page, which the owner can open while it is a draft.
- **Looked up again when it asks.** The details checked are the venue's as
  they are when it asks to go live, not as they were at sign-up.
- **What the owner checked.** *Approve* stays greyed out until they tick
  that they looked at the map, phoned the venue's number, found the
  business somewhere besides this form, and that any photos show this
  venue. What was ticked is recorded with the
  approval, and the venue keeps its pin.
- **Branches** are added by a signed-in manager as drafts, so there is no
  email to confirm, but they have a pin and the same checks when they ask to
  go live. With `MYSENAM_AUTO_APPROVE_BRANCHES=on`, a branch of a business
  that is already live goes live on its own only when none of the location
  checks flag anything; otherwise it waits like any other, with the flags in
  the email to the owner. A business may have 5 branches in draft at once.

Lookups go to OpenStreetMap's public Nominatim server by default, at most
one a second as its usage policy asks, cached, and rate limited per visitor.
A busy install should run its own Nominatim and set `MYSENAM_GEOCODER` to its
address; `MYSENAM_GEOCODER=off` looks nothing up, and the panel says so.

## Storefront domains

A marketplace venue can have its own website on the same server: `abc.com`
shows ABC's venues, under ABC's name, tagline, logo and colour, and nothing
else. The platform owner sets one up under *Venues & staff → Storefront
domains* — the domain, the name, and which venues it shows — and then:

points the domain's A record at the server. Caddy gets the certificate on the
first visit, once it has asked the app (`/api/tls-check`) and been told the
domain is a registered storefront, so nobody can point domains of their own at
the box and have it request certificates for them.

What changes on a storefront is what the public pages show. The home page,
search, classes and the venue list are only its venues; another venue's page,
and its availability, are *not found*; a one-venue storefront opens straight on
that venue's booking page. The colour replaces the teal the interface is drawn
in, so every button and link takes it — and a colour too light for white
writing on its buttons is refused. The footer says *Bookings by MySenam*.
Confirmation and waitlist messages, and the page a customer returns to after
paying online, link to the venue's storefront rather than the marketplace.

What does not change is everything behind those pages: bookings, payments,
staff accounts, credit and reports already belong to venues, and work as they
always have. Customer accounts are the marketplace's, so somebody with one can
use it on any storefront (signing in again, since sessions are per domain).
That makes a storefront a window onto part of the marketplace, **not a wall
around a business's data** — a business that needs its own customers and its
own database gets its own copy, below.

Which storefront a request is for comes from the hostname alone, matched
exactly against the registered ones, with `www.` ignored. Anything else is the
marketplace. `X-Forwarded-Host` is ignored unless `MYSENAM_TRUST_FORWARDED_HOST=on`
— set that only behind a proxy that rewrites the Host header and sets this one
itself. Caddy passes Host through as it is, so leave it off behind the
DigitalOcean kit.
