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
- **Self-service management** — no account needed: look up or cancel any booking with the code + phone number (`/my-booking`)
- **Share & export** — WhatsApp share, Google Calendar link and `.ics` download for every confirmed booking
- **Admin dashboard** (`/admin`) — three tabs behind a passcode:
  - **Bookings**: all bookings for any date with expected/collected/outstanding revenue, one-click paid/unpaid toggle (and pay-a-whole-series), plus admin cancellation
  - **Court schedule**: per-court hourly grid; click to block slots for maintenance (with a reason) or release them — booked hours can never be blocked
  - **Occupancy**: 7-day utilisation heatmap per court with venue totals
  - **Courts & rates**: rename courts, edit peak/off-peak rates, add new courts
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

The admin page (`/admin`) is protected by a passcode checked server-side.

- Default (development): `mudah-admin`
- Production: set the `ADMIN_PASSCODE` environment variable.

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

Admin endpoints (all require the `x-admin-passcode` header):

| Method | Path                          | Description                                          |
| ------ | ----------------------------- | ---------------------------------------------------- |
| GET    | `/api/admin/bookings`         | `?date=` → bookings + expected/collected/outstanding |
| POST   | `/api/admin/bookings/cancel`  | `{code}` → cancel any booking (no phone check)       |
| POST   | `/api/admin/payments`         | `{code, paid}` or `{seriesCode}` → payment tracking  |
| GET    | `/api/admin/slots`            | `?venueId=&date=` → per-slot status grid             |
| POST   | `/api/admin/blocks`           | `{courtId, date, hours[], reason?}` → block slots    |
| DELETE | `/api/admin/blocks`           | `{courtId, date, hours[]}` → release blocked slots   |
| GET    | `/api/admin/occupancy`        | `?venueId=&start=&days=` → booked/blocked counts     |
| POST   | `/api/admin/courts`           | `{venueId, name, sport, offPeakRate, peakRate}`      |
| PATCH  | `/api/admin/courts/:id`       | `{name?, offPeakRate?, peakRate?}`                   |

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
    admin-auth.ts     # Passcode check shared by admin routes
    booking-links.ts  # WhatsApp / Google Calendar / .ics helpers
    time.ts           # Malaysia-timezone helpers, peak-hour rules
    types.ts          # Shared types & constants
tests/                # Vitest suite (booking rules, blocks, series, auth)
```

## Payments

Bookings are pay-at-counter: every booking starts `unpaid`, and front-desk staff
toggle it to `paid` from the admin Bookings tab (a whole recurring series can be
settled in one click). Customers see the payment state on `/account` and in the
`/my-booking` lookup. The daily view splits **expected** vs **collected** vs
**outstanding** revenue so a shift can be reconciled at closing.

## Continuous integration

`.github/workflows/ci.yml` runs type-check, tests and a production build on every
push and pull request (Node 22, `npm ci`).

## Roadmap ideas

- Venue CRUD + per-venue admin accounts (today one shared passcode sees every venue)
- Online payment (FPX / e-wallet) to replace the manual pay-at-counter toggle
- Cancellation cutoff window and no-show tracking
- Member rates, promo codes and bulk discounts
- Waitlist for fully-booked slots
- Per-venue operating hours and public-holiday closures
- Rate limiting on the login and booking endpoints
- Automated WhatsApp/email booking confirmations & reminders
- Session cookies are not marked `Secure`; set that (and a strong
  `ADMIN_PASSCODE`) before deploying behind HTTPS in production
