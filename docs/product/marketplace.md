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
  (a court, a pin), and sends it to **go live**.
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
  payment, an invoice), which is left for the owner to look at.
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
  start date there, and marks a bank transfer paid or voids an invoice.
- **Prices are published** at `/pricing` (linked from the footer and the
  sign-up page), worked out from the same tiers and settings the invoices
  use, so the page cannot say one thing and the bill another.
- **An invoice more than 14 days overdue** (28 days after it was issued) takes
  every venue on it off the marketplace until it is paid: not listed, not
  bookable, not payable online. A week before that, its staff are emailed
  once with the amount and the date it happens. When it happens, they and the
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
