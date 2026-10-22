# HTTP routes (reference)

A reference to the application's own HTTP routes. It is not exhaustive: every route is a `route.ts` under `src/app/api/`, and each route listed here is checked to exist by `tests/docs.test.ts`. The public, key-authenticated API for venues' own systems is in [external API](../integrations/external-api.md).

## API

| Method | Path                  | Description                                        |
| ------ | --------------------- | -------------------------------------------------- |
| GET    | `/api/health`         | `{ok}` while the database answers, `503` when it does not |
| GET    | `/api/venues`         | All venues with their courts                        |
| GET    | `/api/availability`   | `?venueId=&date=YYYY-MM-DD&sport=` → hourly grid    |
| GET    | `/api/venues/:id/live`| Who is inside each shared facility right now        |
| GET    | `/api/classes`        | `?venueId=&sport=&from=&to=` → upcoming classes     |
| POST   | `/api/classes/enrol`  | `{classId, name, phone, email?}` → take a place     |
| POST   | `/api/waitlist`       | `{classId \| courtId+date+startHour+endHour, name, phone, email?}` → queue |
| DELETE | `/api/waitlist`       | `{entryId, phone}` → leave the queue                |
| POST   | `/api/waitlist/claim` | `{token}` → take up an offered place                |
| POST   | `/api/checkin`        | `{token}` → self check-in from the booking QR       |
| POST   | `/api/access`         | `{code, phone}` → the door code for an unmanned resource |
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
| POST   | `/api/auth/forgot`        | `{email}` → emails a reset link; always `{ok}`  |
| POST   | `/api/auth/reset`         | `{token, password}` → new password + signed in  |
| GET    | `/api/my/password`        | `{hasPassword}` (Google accounts may have none) |
| POST   | `/api/my/password`        | `{current, next}` → change it; others signed out |
| GET    | `/api/my/bookings`        | The signed-in user's bookings                   |
| GET    | `/api/my/wallet`          | Credit balance and recent movements             |
| POST   | `/api/my/vouchers`        | `{code}` → a gift voucher, as credit            |
| POST   | `/api/vouchers`           | Buy a gift voucher online → `{url}` to pay      |
| GET    | `/api/my/passes`          | The signed-in customer's multi-visit passes     |
| GET    | `/api/my/membership`      | The signed-in customer's memberships            |
| GET    | `/api/my/waitlist`        | Classes you are queuing for, and any live offer |
| GET/POST | `/api/venues/:id/terms` | The venue's booking rules, and for an account whether it put them away and its strikes / `{version}`: don't show again |
| GET    | `/api/my/data`            | Everything held against this account, as a file |
| POST   | `/api/my/erase`           | `{confirm:"DELETE"}` → close the account        |
| POST   | `/api/my/bookings/cancel` | `{bookingId}` → cancel own booking              |
| GET    | `/api/bookings/reschedule` | `?code&phone&date` → free start times that day |
| POST   | `/api/bookings/reschedule` | `{code, phone, date, startHour}` → change it   |
| GET    | `/api/my/venues`          | Private and members-only venues this account is on the list of |
| GET    | `/api/bookings/again`     | `?code` (own, signed in) or `?code&phone` → `{url}` |

Admin endpoints (all require an admin session cookie; venue-scoped unless noted):

| Method | Path                          | Description                                          |
| ------ | ----------------------------- | ---------------------------------------------------- |
| POST   | `/api/admin/auth/login`       | `{email, password}` → admin session                  |
| POST   | `/api/admin/auth/logout`      | Ends the admin session                               |
| GET    | `/api/admin/auth/me`          | Current admin + the venues they may manage           |
| POST   | `/api/admin/auth/forgot`      | `{email}` → emails a reset link (no session needed)  |
| POST   | `/api/admin/auth/reset`       | `{token, password}` → new password + admin session   |
| GET/POST | `/api/admin/auth/password`  | Has a password? / `{current, next}` → change it      |
| GET    | `/api/admin/bookings`         | `?date=` → bookings + expected/collected/outstanding |
| POST   | `/api/admin/bookings/cancel`  | `{code}` → cancel any booking (no phone check)       |
| GET    | `/api/admin/bookings/move`    | `?code=` → courts this booking could move to         |
| POST   | `/api/admin/bookings/move`    | `{code, courtId}` → move it, keeping code and payment |
| GET    | `/api/admin/bookings/reschedule` | `?code&date` → free start times that day          |
| POST   | `/api/admin/bookings/reschedule` | `{code, date, startHour, courtId?}` → change it; customer told |
| GET    | `/api/admin/booking-link`     | `?venueId` → the venue's booking link                |
| GET    | `/api/admin/activity`         | `?venueId&from&to&code` → the staff activity log (managers) |
| PATCH  | `/api/admin/admins/:id`       | `{role: manager or desk}` for branch staff            |
| GET/POST | `/api/admin/hold-policy`    | `?venueId` / `{venueId, on, minutes}`: pay online to hold a booking |
| GET    | `/api/admin/data-request`  | `?venueId&phone` → what the venue holds against a number, as a file (managers) |
| GET/POST/DELETE | `/api/admin/coaches` | `?venueId` / `{venueId, id?, name, bio?, sports, rate, hours}` / `?venueId&id`: a venue's coaches |
| GET/POST | `/api/admin/calendar-feed`  | `?venueId` / `{venueId, on}`: the staff calendar's address; on makes a new one |
| GET/POST | `/api/admin/cancel-policy`  | `?venueId` / `{venueId, lateKeep, strikeLimit, strikeDays, onlineRefunds}`: late cancellations, refunds, strikes |
| GET/POST | `/api/admin/house-rules`    | `?venueId` / `{venueId, upcoming, perWeek, perDay, aheadDays, memberAheadDays}` |
| GET    | `/api/admin/venue-access`     | `?venueId` → who it is for, and its list             |
| POST   | `/api/admin/venue-access`     | `{venueId, action: settings, add, import or remove}` |
| POST   | `/api/admin/payments`         | `{code, paid, via?}` or `{seriesCode, via?}`; `via` is cash, qr, transfer or card |
| POST   | `/api/admin/no-show`          | `{code, noShow}` → flag a passed booking             |
| POST   | `/api/admin/check-in`         | `{code, out?}` → record arrival or departure         |
| GET    | `/api/admin/access`           | `?venueId=` → who has been given a door code         |
| GET    | `/api/admin/inductions`       | `?venueId=` → who may use the venue out of hours     |
| POST   | `/api/admin/inductions`       | `{venueId, phone, name, note?}` → record an induction |
| DELETE | `/api/admin/inductions/:id`   | Withdraw someone's out-of-hours access               |
| GET    | `/api/admin/hire`             | `?venueId=` → kit that is still out                  |
| POST   | `/api/admin/hire`             | `{code, action:"take", deposit?}` or `{code, action:"return", condition, withheld?, note?}` |
| GET    | `/api/admin/wallet`           | `?q=` → find a customer by email or phone            |
| POST   | `/api/admin/wallet`           | `{userId, amount, reason?}` → sell credit            |
| GET    | `/api/admin/memberships`      | `?venueId=` → that venue's members                   |
| POST   | `/api/admin/memberships`      | `{venueId, holderName, holderPhone, startsOn, expiresOn, price}` |
| POST   | `/api/admin/memberships/:id/void` | Cancel a membership                              |
| GET    | `/api/admin/promos`           | `?venueId=` → that venue's promo codes               |
| POST   | `/api/admin/promos`           | `{venueId, code, description, kind, value, sport?, minHours?, validFrom, validTo, maxUses?}` |
| POST   | `/api/admin/promos/:id/void`  | Withdraw a code; discounts already given stand       |
| GET    | `/api/admin/passes`           | `?venueId=` → passes sold by that venue              |
| POST   | `/api/admin/passes`           | `{venueId, name, sport?, entries, price, holderName, holderPhone, expiresOn}` |
| POST   | `/api/admin/passes/:id/void`  | Cancel a pass; entries already spent stay spent      |
| GET    | `/api/admin/vouchers`         | `?venueId=` → gift vouchers sold, with printable links |
| POST   | `/api/admin/vouchers`         | `{venueId, amount, buyerName, buyerEmail?, recipientName?, message?, via?}`: sold at the counter |
| POST   | `/api/admin/vouchers/:id/void` | Cancel a voucher nobody has used                   |
| GET    | `/api/admin/classes`          | `?venueId=` → classes including cancelled ones       |
| POST   | `/api/admin/classes`          | `{courtId, name, instructor, date, startHour, endHour, capacity, price, weeks?}` |
| GET    | `/api/admin/classes/:id`      | The class and its roster                             |
| DELETE | `/api/admin/classes/:id`      | Cancel a class, releasing every enrolment            |
| GET    | `/api/admin/slots`            | `?venueId=&date=` → per-slot status grid             |
| POST   | `/api/admin/blocks`           | `{courtId, date, hours[], reason?}` → block slots    |
| DELETE | `/api/admin/blocks`           | `{courtId, date, hours[]}` → release blocked slots   |
| GET    | `/api/admin/occupancy`        | `?venueId=&start=&days=` → booked/blocked counts     |
| GET    | `/api/admin/reports`          | `?venueId=&from=&to=` → the period report            |
| POST   | `/api/admin/courts`           | `{venueId, name, sport, offPeakRate, peakRate, capacity?, deposit?}` |
| GET    | `/api/admin/courts/:id`       | The court plus the door code staff may see for it    |
| PATCH  | `/api/admin/courts/:id`       | `{name?, offPeakRate?, peakRate?, memberOffPeakRate?, memberPeakRate?, capacity?, deposit?, unmanned?, accessCode?}` |
| POST   | `/api/admin/venues`           | `{name, area, address, phone}` — **owner only**      |
| PATCH  | `/api/admin/venues/:id`       | `{name?, area?, address?, phone?, cancelCutoffHours?, openHour?, closeHour?, staffedFrom?, staffedTo?, emergencyPhone?, emergencyInfo?}` |
| GET    | `/api/admin/venues/:id/closures` | Upcoming closed days for one venue                |
| POST   | `/api/admin/venues/:id/closures` | `{date, reason?}` → close that whole day          |
| DELETE | `/api/admin/venues/:id/closures?date=` | Re-open a closed day                        |
| GET    | `/api/admin/demo`             | Whether this install is empty — **owner only**       |
| POST   | `/api/admin/demo`             | Fill an empty install with a demo fortnight — **owner only** |
| GET    | `/api/admin/retention`        | The retention policy, what is due, and when it last ran — **owner only** |
| POST   | `/api/admin/retention`        | Apply the retention policy now — **owner only**      |
| GET    | `/api/admin/backup`           | Snapshots, and how stale the newest is — **owner only** |
| POST   | `/api/admin/backup`           | Take one now — **owner only**                        |
| GET    | `/api/admin/admins`           | List operator accounts — **owner only**              |
| POST   | `/api/admin/admins`           | `{name, email, password, venueId}` — **owner only**  |
| DELETE | `/api/admin/admins/:id`       | Remove an operator — **owner only**                  |

Prices are always computed server-side; the client's displayed total is informational.
