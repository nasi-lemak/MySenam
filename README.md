# MudahTempah 🏸

**Tempah gelanggang dengan mudah** — an online booking platform for sports courts:
badminton, tennis, pickleball and futsal.

## Features

- **Cross-venue search** (`/search`) — pick a sport, day, time window and duration, and see every free court across all venues at once, grouped by venue and cheapest-first; one click deep-links into the venue page with the slot already selected
- **Live availability grid** — per venue, per sport, per day, with hourly slots (8 AM – 11 PM)
- **Peak / off-peak pricing** — weekday evenings (from 6 PM) and weekends charge the peak rate; prices shown per-slot in MYR
- **Instant booking** — pick up to 4 consecutive hours, enter name + phone, get a booking code (e.g. `MT-8F3K2A`); pay at the counter
- **Weekly recurring bookings** — repeat the same slot for up to 8 weeks (leagues, training); each session gets its own code plus a shared series code (`SR-…`), clashing weeks can be skipped or fail the whole series, and a series cancels in one action
- **Double-booking proof** — slot uniqueness is enforced at the database level, so concurrent bookings can never collide
- **Customer accounts** — register/sign in (`/login`, scrypt-hashed passwords, HTTP-only session cookies, no external auth service); bookings made while signed in appear on `/account` with upcoming/past views, one-click cancel, and prefilled booking forms
- **Cancellation policy** — each venue sets how many hours before a slot customers may still cancel (default 2); the window is shown up front on the venue page and in the booking lookup, and staff can always override from the dashboard
- **No-show tracking** — staff flag a passed booking whose customer never turned up, and the day list warns when that phone number has prior no-shows
- **Self-service management** — no account needed: look up or cancel any booking with the code + phone number (`/my-booking`)
- **Share & export** — WhatsApp share, Google Calendar link and `.ics` download for every confirmed booking
- **Per-venue admin accounts** — operators sign in with email + password; a venue admin only ever sees their own venue's bookings, schedule, courts and revenue, while a platform owner manages every venue, creates venues and issues staff accounts
- **Admin dashboard** (`/admin`) — behind an operator sign-in:
  - **Bookings**: all bookings for any date with expected/collected/outstanding revenue, one-click paid/unpaid toggle (and pay-a-whole-series), plus admin cancellation
  - **Court schedule**: per-court hourly grid; click to block slots for maintenance (with a reason) or release them — booked hours can never be blocked
  - **Occupancy**: 7-day utilisation heatmap per court with venue totals
  - **Courts & rates**: rename courts, edit peak/off-peak rates, add new courts
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
    time.ts           # Malaysia-timezone helpers, peak-hour rules
    types.ts          # Shared types & constants
tests/                # Vitest suite (booking rules, blocks, series, search,
                      # payments, customer auth, admin scoping)
```

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

- Online payment (FPX / e-wallet) to replace the manual pay-at-counter toggle
- Member rates, promo codes and bulk discounts
- Waitlist for fully-booked slots
- Per-venue operating hours and public-holiday closures
- Automated WhatsApp/email booking confirmations & reminders
- Session cookies are not marked `Secure`; set that (and strong
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` values) before deploying behind HTTPS
