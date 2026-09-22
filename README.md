# MudahTempah 🏸

**Tempah gelanggang dengan mudah** — an online booking platform for sports courts:
badminton, tennis, pickleball, futsal — and shared facilities like gyms and pools.

## Features

- **Cross-venue search** (`/search`) — pick a sport, day, time window and duration, and see every free court across all venues at once, grouped by venue and cheapest-first; one click deep-links into the venue page with the slot already selected
- **Waitlists** — when a court hour or class is full, customers queue instead; a cancellation offers it to whoever has waited longest, held for 30 minutes before passing on
- **Instructor-led classes** (`/classes`) — schedule a session or a whole weekly term on a shared facility; customers enrol rather than book, the resource is reserved while the class runs, and staff get a live roster showing who has checked in
- **Courts *and* shared facilities** — a resource has a capacity: 1 means exclusive use (a badminton court), more means a gym floor, pool or class where that many people hold the same hour. The booking grid shows places left and colours them by how busy the hour is
- **Live availability grid** — per venue, per sport, per day, with hourly slots (8 AM – 11 PM)
- **Peak / off-peak pricing** — weekday evenings (from 6 PM) and weekends charge the peak rate; prices shown per-slot in MYR
- **Instant booking** — pick up to 4 consecutive hours, enter name + phone, get a booking code (e.g. `MT-8F3K2A`); pay at the counter
- **Weekly recurring bookings** — repeat the same slot for up to 8 weeks (leagues, training); each session gets its own code plus a shared series code (`SR-…`), clashing weeks can be skipped or fail the whole series, and a series cancels in one action
- **Double-booking proof** — slot uniqueness is enforced at the database level, so concurrent bookings can never collide
- **Stored credit** — customers buy credit at any counter and pay for bookings and classes from the balance; cancelling refunds it automatically
- **Customer accounts** — register/sign in (`/login`, scrypt-hashed passwords, HTTP-only session cookies, no external auth service); bookings made while signed in appear on `/account` with upcoming/past views, one-click cancel, and prefilled booking forms
- **Cancellation policy** — each venue sets how many hours before a slot customers may still cancel (default 2); the window is shown up front on the venue page and in the booking lookup, and staff can always override from the dashboard
- **Check-in & live crowd levels** — customers scan a QR code on their booking to check themselves in (or the desk does it), and the venue page shows a public *Here right now* panel counting who is actually inside each shared facility, refreshed every 30 seconds
- **No-show tracking** — staff flag a passed booking whose customer never turned up, and the day list warns when that phone number has prior no-shows
- **Self-service management** — no account needed: look up or cancel any booking with the code + phone number (`/my-booking`)
- **Share & export** — WhatsApp share, Google Calendar link and `.ics` download for every confirmed booking
- **Per-venue admin accounts** — operators sign in with email + password; a venue admin only ever sees their own venue's bookings, schedule, courts and revenue, while a platform owner manages every venue, creates venues and issues staff accounts
- **Admin dashboard** (`/admin`) — behind an operator sign-in:
  - **Bookings**: all bookings for any date with expected/collected/outstanding revenue, one-click paid/unpaid toggle (and pay-a-whole-series), check-in/check-out, no-show flagging, plus admin cancellation
  - **Court schedule**: per-court hourly grid; click to block slots for maintenance (with a reason) or release them — booked hours can never be blocked
  - **Occupancy**: 7-day utilisation heatmap per court with venue totals
  - **Courts & rates**: rename courts, edit peak/off-peak rates and capacity, add new courts
  - **Classes**: schedule one-off or weekly classes, view the roster and waiting queue, cancel a class (releasing every enrolment)
  - **Credit**: look a customer up by email or phone, see their balance and history, sell them credit
  - **Venues & staff**: edit venue details and the cancellation cutoff; owners can also add venues and create/remove staff accounts
- **14-day booking window**, Malaysia timezone-aware (past slots on today's date are blocked)

## Tech stack

- [Next.js 15](https://nextjs.org/) (App Router) + React 19 + TypeScript
- [Tailwind CSS 4](https://tailwindcss.com/)
- SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — zero-config, auto-created and seeded at `data/mudahtempah.db` on first run

## Getting started

```bash
npm install
npm run dev
```

Run the test suite (Vitest against an in-memory database) with:

```bash
npm test
```

Open http://localhost:3000. The database is created and seeded with three demo venues
(Petaling Jaya, Subang Jaya, Bangsar) on first request.

### Admin access

`/admin` is protected by operator accounts (scrypt-hashed passwords, HTTP-only
session cookies) held in the `admins` table. On a fresh database the first
platform owner is created automatically:

- Email: `ADMIN_EMAIL`, default `admin@mudahtempah.my`
- Password: `ADMIN_PASSWORD`, default `mudah-admin`

**Set both before deploying.** Once signed in, the owner can add venues and
issue staff accounts from the *Venues & staff* tab.

There are two roles:

| Role | `venue_id` | Can do |
| ---- | ---------- | ------ |
| Platform owner | `NULL` | Everything, across every venue; create venues and staff accounts |
| Venue operator | a venue id | Only that venue: its bookings, payments, schedule, courts, occupancy and venue details |

Every admin endpoint checks the scope server-side, so a venue operator gets a
403 for another venue's data even by calling the API directly.

## API

| Method | Path                  | Description                                        |
| ------ | --------------------- | -------------------------------------------------- |
| GET    | `/api/venues`         | All venues with their courts                        |
| GET    | `/api/availability`   | `?venueId=&date=YYYY-MM-DD&sport=` → hourly grid    |
| GET    | `/api/venues/:id/live`| Who is inside each shared facility right now        |
| GET    | `/api/classes`        | `?venueId=&sport=&from=&to=` → upcoming classes     |
| POST   | `/api/classes/enrol`  | `{classId, name, phone, email?}` → take a place     |
| POST   | `/api/waitlist`       | `{classId \| courtId+date+startHour+endHour, name, phone, email?}` → queue |
| DELETE | `/api/waitlist`       | `{entryId, phone}` → leave the queue                |
| POST   | `/api/waitlist/claim` | `{token}` → take up an offered place                |
| POST   | `/api/checkin`        | `{token}` → self check-in from the booking QR       |
| GET    | `/api/checkin/qr`     | `?token=` → that booking's QR code as an SVG        |
| POST   | `/api/bookings`       | `{courtId, date, hours[], name, phone, email?, weeks?, skipConflicts?}` |
| GET    | `/api/bookings`       | `?code=&phone=` → booking details                   |
| POST   | `/api/bookings/cancel`| `{code, phone}` → cancel (before start time only)   |
| POST   | `/api/bookings/cancel-series` | `{seriesCode, phone}` → cancel all future sessions |

Account endpoints (session cookie):

| Method | Path                      | Description                                     |
| ------ | ------------------------- | ----------------------------------------------- |
| POST   | `/api/auth/register`      | `{name, email, phone, password}` → sign up + in |
| POST   | `/api/auth/login`         | `{email, password}`                             |
| POST   | `/api/auth/logout`        | Ends the session                                |
| GET    | `/api/auth/me`            | Current user or `null`                          |
| GET    | `/api/my/bookings`        | The signed-in user's bookings                   |
| GET    | `/api/my/wallet`          | Credit balance and recent movements             |
| GET    | `/api/my/waitlist`        | Classes you are queuing for, and any live offer |
| POST   | `/api/my/bookings/cancel` | `{bookingId}` → cancel own booking              |

Admin endpoints (all require an admin session cookie; venue-scoped unless noted):

| Method | Path                          | Description                                          |
| ------ | ----------------------------- | ---------------------------------------------------- |
| POST   | `/api/admin/auth/login`       | `{email, password}` → admin session                  |
| POST   | `/api/admin/auth/logout`      | Ends the admin session                               |
| GET    | `/api/admin/auth/me`          | Current admin + the venues they may manage           |
| GET    | `/api/admin/bookings`         | `?date=` → bookings + expected/collected/outstanding |
| POST   | `/api/admin/bookings/cancel`  | `{code}` → cancel any booking (no phone check)       |
| POST   | `/api/admin/payments`         | `{code, paid}` or `{seriesCode}` → payment tracking  |
| POST   | `/api/admin/no-show`          | `{code, noShow}` → flag a passed booking             |
| POST   | `/api/admin/check-in`         | `{code, out?}` → record arrival or departure         |
| GET    | `/api/admin/wallet`           | `?q=` → find a customer by email or phone            |
| POST   | `/api/admin/wallet`           | `{userId, amount, reason?}` → sell credit            |
| GET    | `/api/admin/classes`          | `?venueId=` → classes including cancelled ones       |
| POST   | `/api/admin/classes`          | `{courtId, name, instructor, date, startHour, endHour, capacity, price, weeks?}` |
| GET    | `/api/admin/classes/:id`      | The class and its roster                             |
| DELETE | `/api/admin/classes/:id`      | Cancel a class, releasing every enrolment            |
| GET    | `/api/admin/slots`            | `?venueId=&date=` → per-slot status grid             |
| POST   | `/api/admin/blocks`           | `{courtId, date, hours[], reason?}` → block slots    |
| DELETE | `/api/admin/blocks`           | `{courtId, date, hours[]}` → release blocked slots   |
| GET    | `/api/admin/occupancy`        | `?venueId=&start=&days=` → booked/blocked counts     |
| POST   | `/api/admin/courts`           | `{venueId, name, sport, offPeakRate, peakRate}`      |
| PATCH  | `/api/admin/courts/:id`       | `{name?, offPeakRate?, peakRate?}`                   |
| POST   | `/api/admin/venues`           | `{name, area, address, phone}` — **owner only**      |
| PATCH  | `/api/admin/venues/:id`       | `{name?, area?, address?, phone?, cancelCutoffHours?}` |
| GET    | `/api/admin/admins`           | List operator accounts — **owner only**              |
| POST   | `/api/admin/admins`           | `{name, email, password, venueId}` — **owner only**  |
| DELETE | `/api/admin/admins/:id`       | Remove an operator — **owner only**                  |

Prices are always computed server-side; the client's displayed total is informational.

## Project structure

```
src/
  app/                # Pages + API routes (App Router)
    api/              # venues, availability, bookings, admin
    search/           # Cross-venue "find a court by time"
    venue/[id]/       # Availability grid + booking flow
    my-booking/       # Lookup & cancel by code + phone
    admin/            # Daily bookings & revenue
  components/
    BookingBoard.tsx  # Interactive slot-picker (client component)
  lib/
    db.ts             # SQLite schema, migrations + seed data
    store.ts          # All queries & booking/cancel/block logic
    auth.ts           # Accounts: scrypt passwords + session cookies
    admin-auth.ts     # Operator accounts, sessions and venue scoping
    booking-links.ts  # WhatsApp / Google Calendar / .ics helpers
    rate-limit.ts     # Fixed-window limiter for password and code endpoints
    time.ts           # Malaysia-timezone helpers, peak-hour rules
    types.ts          # Shared types & constants
tests/                # Vitest suite (booking rules, blocks, series, search,
                      # payments, customer auth, admin scoping)
```

## Exclusive courts vs shared facilities

Every bookable resource carries a `capacity`:

| Capacity | Behaves like | Example |
| -------- | ------------ | ------- |
| 1 | Exclusive use — one booking owns the hour | Badminton court |
| > 1 | Shared — that many people may hold the same hour | Gym floor, lap pool, class |

The guarantee is the same for both. Each booked hour takes a numbered *place*
(`booking_slots.seat`), and `UNIQUE (court_id, date, hour, seat)` is what makes
overbooking impossible under concurrent requests — a court is simply the case
where the only place is seat 0. Booking allocates the lowest free place inside
the transaction; if two requests race for it, the loser retries against the
winner's state (bounded), and a genuinely full resource is refused outright.

Capacity cannot be reduced below the places already booked in an upcoming hour,
so shrinking a gym never strands a customer.

For a customer this is the forward-looking crowd signal: a shared facility shows
**places left** rather than a price in each cell, shaded from quiet through
filling to busy, so you can see that Monday 7pm is always packed.

## Classes

A class is an instructor-led session held on a shared facility. While it runs
the resource is **reserved**: those hours disappear from general booking and
from cross-venue search, and a walk-in attempt is told to enrol instead. A class
cannot be laid over existing bookings, or over another class.

An enrolment is deliberately just a booking with a `class_id`, so it inherits
everything bookings already do — a code, a QR check-in, payment tracking,
cancellation and no-shows — instead of growing a parallel system. The only
override is price: an enrolment is charged the class's per-person rate rather
than the court's hourly one.

Classes can repeat weekly for a term (up to 12 weeks) under a shared `CL-`
series code. Cancelling a class releases every enrolment and returns the hours
to general booking. Staff see a roster per class with each attendee's check-in
state.

## Waitlists

A full class *or a taken court hour* can still be joined — as a queue. When it
frees up (a booking or enrolment cancelled, or someone ahead dropping out), it
is **offered to whoever has waited longest**, with a secret token and a
30-minute hold. Only one offer is ever live per class, and per resource per
day, so two cancellations do not hand the same place to two people.

Queuing is only offered where a cancellation could actually free the slot. A
blocked, class-reserved or past hour is not queueable, and the booking grid
only turns those cells into a waitlist button when they are genuinely just
taken.

There is no scheduler, so stale offers are expired **lazily**: every waitlist
read or write first times out any hold that has run out, then the next person
can be offered the place. The queue is only ever reached through one of those
operations, so nobody is blocked for long by someone who walked away.

Claiming is deliberately a tap rather than automatic on page load, because
unlike check-in it creates a booking that costs money. Claiming enrols the
holder at the class price (or makes an ordinary booking for a court slot) and
closes their queue entry; the token is then spent.

If somebody books the slot directly between the offer and the claim, the claim
fails and the waiter is put **back at the front of the queue** rather than
losing their turn for someone else's race.

## Stored credit

Customers buy credit at a venue counter and spend it on bookings and classes by
ticking *Pay from my credit balance*.

It is held as an **append-only ledger** (`wallet_entries`) rather than a balance
column: every movement keeps its reason, the booking it relates to and the
operator who sold it, and the balance is their sum. That makes the money
auditable and means no code path can quietly overwrite a total.

Three guards matter, and each has a test:

- **The balance is re-read inside the payment transaction**, so two concurrent
  bookings cannot overdraw it — a short balance is refused and nothing is
  written to the ledger.
- **A refund can only be claimed once per booking**, so cancelling twice cannot
  mint credit.
- **Paying from credit is best-effort at booking time.** An empty wallet leaves
  the booking standing as unpaid with a `walletError` explaining why, rather
  than throwing the booking away.

Cancelling a wallet-paid booking refunds it automatically, through every path:
by code, from an account, a whole series, an admin cancellation, and the
enrolments released when a class is cancelled.

## Check-in and live crowd levels

Places booked and people present are different numbers, so arrivals are tracked
separately. Staff check a customer in from the Bookings tab (the Attendance
column), and optionally out again.

`GET /api/venues/:id/live` — public, no session — answers *how busy is it right
now*: someone counts as present once they have checked in, have not checked
out, and their booking has not ended. Most people leave without telling the
desk, so the booking's end time is the backstop that keeps the number honest.
The venue page renders this as a **Here right now** panel that refreshes every
30 seconds.

Check-in and no-show are mutually exclusive and self-correcting: a customer who
checked in cannot be flagged a no-show, and checking someone in clears a
no-show the desk had already recorded when they turn up late.

### Self-service check-in

Every booking carries a random 128-bit `check_in_token`, separate from the short
booking code (codes are printed on receipts and are far easier to guess). The
booking confirmation, `/account` and the `/my-booking` lookup each show a QR
code encoding `/checkin/<token>`; scanning it checks that booking in and shows
a confirmation, so arrivals do not depend on a staff member pressing a button.

Check-in — by QR or at the desk — is only open from
`CHECK_IN_OPENS_MINUTES_BEFORE` (60) minutes before the slot until it ends.
Without that window an early scan would count toward the live headcount for the
rest of the day.

## Payments

Bookings are pay-at-counter: every booking starts `unpaid`, and front-desk staff
toggle it to `paid` from the admin Bookings tab (a whole recurring series can be
settled in one click). Customers see the payment state on `/account` and in the
`/my-booking` lookup. The daily view splits **expected** vs **collected** vs
**outstanding** revenue so a shift can be reconciled at closing.

## Cancellation and no-shows

Each venue carries a `cancel_cutoff_hours` (default 2, max 72). Customer-facing
cancellation — by code, from an account, or for a whole series — is refused
inside that window with a message naming the cutoff, while
`/api/admin/bookings/cancel` always succeeds so the front desk can make
exceptions. Cancelling a series drops only the sessions still outside the
window.

After a slot has passed, staff can flag it a no-show from the Bookings tab. The
flag is reversible, never applies to a cancelled booking, and the day list shows
a ⚠ badge counting that phone number's previous no-shows.

## Rate limiting

Password endpoints and anything addressable by a short code are rate limited
per client IP (`src/lib/rate-limit.ts`), returning `429` with `Retry-After`:

| Endpoint | Budget |
| -------- | ------ |
| Admin & customer sign-in | 10 per 10 min, per IP **and** per email |
| Registration | 5 per hour |
| Booking lookup / cancel by code | 20 per 10 min |
| Booking creation | 20 per hour |

Counters live in process memory, so each instance keeps its own. A horizontally
scaled deploy should move them to a shared store (Redis) with the same policies.
Client identity comes from `x-forwarded-for`, which is only trustworthy behind a
proxy that sets it.

## Continuous integration

`.github/workflows/ci.yml` runs type-check, tests and a production build on every
push and pull request (Node 22, `npm ci`).

## Roadmap ideas

- Turnstile or access-gate integration, so entry is physically gated rather
  than trusted
- Multi-visit passes (10 entries, expiring) — different from a credit balance
- Online top-ups, so credit can be bought without visiting a counter
- Online payment (FPX / e-wallet) to replace the manual pay-at-counter toggle
- Member rates, promo codes and bulk discounts
- Waitlist for fully-booked slots
- Per-venue operating hours and public-holiday closures
- Automated WhatsApp/email booking confirmations & reminders
- Session cookies are not marked `Secure`; set that (and strong
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` values) before deploying behind HTTPS
