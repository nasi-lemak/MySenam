# MudahTempah 🏸

**Tempah gelanggang dengan mudah** — an online booking platform for sports courts:
badminton, tennis, pickleball and futsal.

## Features

- **Live availability grid** — per venue, per sport, per day, with hourly slots (8 AM – 11 PM)
- **Peak / off-peak pricing** — weekday evenings (from 6 PM) and weekends charge the peak rate; prices shown per-slot in MYR
- **Instant booking** — pick up to 4 consecutive hours, enter name + phone, get a booking code (e.g. `MT-8F3K2A`); pay at the counter
- **Double-booking proof** — slot uniqueness is enforced at the database level, so concurrent bookings can never collide
- **Self-service management** — look up or cancel a booking with the code + phone number (`/my-booking`)
- **Share & export** — WhatsApp share, Google Calendar link and `.ics` download for every confirmed booking
- **Admin dashboard** (`/admin`) — three tabs behind a passcode:
  - **Bookings**: all bookings and confirmed revenue for any date, with admin cancellation
  - **Court schedule**: per-court hourly grid; click to block slots for maintenance (with a reason) or release them — booked hours can never be blocked
  - **Occupancy**: 7-day utilisation heatmap per court with venue totals
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
| POST   | `/api/bookings`       | `{courtId, date, hours[], name, phone, email?}`     |
| GET    | `/api/bookings`       | `?code=&phone=` → booking details                   |
| POST   | `/api/bookings/cancel`| `{code, phone}` → cancel (before start time only)   |

Admin endpoints (all require the `x-admin-passcode` header):

| Method | Path                          | Description                                          |
| ------ | ----------------------------- | ---------------------------------------------------- |
| GET    | `/api/admin/bookings`         | `?date=` → all bookings + confirmed revenue that day |
| POST   | `/api/admin/bookings/cancel`  | `{code}` → cancel any booking (no phone check)       |
| GET    | `/api/admin/slots`            | `?venueId=&date=` → per-slot status grid             |
| POST   | `/api/admin/blocks`           | `{courtId, date, hours[], reason?}` → block slots    |
| DELETE | `/api/admin/blocks`           | `{courtId, date, hours[]}` → release blocked slots   |
| GET    | `/api/admin/occupancy`        | `?venueId=&start=&days=` → booked/blocked counts     |

Prices are always computed server-side; the client's displayed total is informational.

## Project structure

```
src/
  app/                # Pages + API routes (App Router)
    api/              # venues, availability, bookings, admin
    venue/[id]/       # Availability grid + booking flow
    my-booking/       # Lookup & cancel by code + phone
    admin/            # Daily bookings & revenue
  components/
    BookingBoard.tsx  # Interactive slot-picker (client component)
  lib/
    db.ts             # SQLite schema + seed data
    store.ts          # All queries & booking/cancel/block logic
    admin-auth.ts     # Passcode check shared by admin routes
    booking-links.ts  # WhatsApp / Google Calendar / .ics helpers
    time.ts           # Malaysia-timezone helpers, peak-hour rules
    types.ts          # Shared types & constants
```

## Roadmap ideas

- Online payment (FPX / e-wallet) instead of pay-at-counter
- User accounts and booking history
- Venue-owner self-service for courts and rates (closures are done — see Court schedule)
- Automated WhatsApp/email booking confirmations & reminders
- Recurring bookings for leagues and training sessions
