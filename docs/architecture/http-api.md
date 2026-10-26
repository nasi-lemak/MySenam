# HTTP routes (reference)

A reference to every one of the application's own HTTP routes: each is a `route.ts` under `src/app/api/`, and `tests/docs.test.ts` checks that every route listed here exists, that every route is listed, and that each method listed is one the route answers and each it answers is listed. The description of each is the doc comment on its handler; the code is the final word on fields. The public, key-authenticated API for venues' own systems is in [external API](../integrations/external-api.md).

**Times.** A time of day is minutes from the business day's midnight
(`1087` is 18:07; past `1440` is after midnight) or `"HH:MM"`. A booking's
time is `start` and `end`, or `start` and `minutes`; the older `hours`, a list
of the board's column starts in hours (`[18, 19]`), is still read
(`readTime` in `src/lib/api.ts`). Where a route took `startHour`/`endHour` or
`fromHour`/`untilHour`, it takes `start`/`end` or `fromMin`/`untilMin` and
still reads the older names.

## How every route behaves

These hold for every route below unless its row says otherwise.

- **Who is asking.** A customer is signed in by the `ms_session` cookie
  (`/api/auth/*`, Google at `/api/auth/google`); staff by `ms_admin`
  (`/api/admin/auth/*`). A booking made without an account is reached with
  its code and the phone number it was made with, never the code alone. A
  coach and a tournament official have a private link of their own instead of
  an account (`/api/coach/:token/*`, `/api/officials/:token`), which decides
  no approval: a coach reviews applications signed in to their own account
  (`/api/my/reviews`); a venue's own
  systems use an API key ([external API](../integrations/external-api.md)).
- **What staff may do.** Every admin route checks the session (`401` without
  one), then the role: the front desk is refused what only a manager does
  (`403`, code `MANAGER_ONLY`; the list is `MANAGER_ONLY` in
  `src/lib/roles.ts`), and anything about a venue its staff do not run is
  refused (`403`); branch staff see their venue, business managers their
  branches, platform owners everything
  ([tenancy](tenancy.md)). Where the install requires two-factor sign-in, an
  account without it is refused everything but setting it up (`403`, code
  `TWO_FACTOR_REQUIRED`).
- **Requests from another site.** A request that changes something and
  carries a session cookie must come from the app's own pages: one whose
  `Origin` (or `Sec-Fetch-Site`) says another site is refused (`403`) before
  it reaches the route ([security](security.md#requests-from-another-site)).
- **Answers** are JSON. A refusal is `{ error, code?, vars? }`: `error` in
  English for logs and staff, `code` a stable name the customer pages
  translate (the `err.*` phrases in `src/lib/i18n.ts`), `vars` what the
  message quotes. A name quoted by its key as well (`nameKey`, such as
  `pre.con.student` for a built-in concession) is said in the reader's
  language; `name` is its English.

  | Status | Means |
  | ------ | ----- |
  | `400` | The request is malformed: a field missing or of the wrong kind |
  | `401` | Sign in first |
  | `403` | Signed in, but not allowed (role, venue, another site, phone not checked) |
  | `404` | Not found, or not yours to see: a private game, another customer's booking |
  | `409` | Refused by a rule of the business: the time is taken, past the cutoff, the game is full |
  | `429` | Too many requests; `Retry-After` says when to try again ([security](security.md#rate-limiting)) |
  | `503` | Busy (`code: "BUSY"`, `Retry-After: 2`): nothing was kept, so sending it again is safe |
- **Text the server words for staff screens** (a warning, a reason, a list
  of changes, a summary) comes in English and, beside it, as a phrase with
  its values: a field named for it with `Phrase` or `Phrases` (`warnings` and
  `phrases`, `unusableReason` and `unusablePhrase`, `changes` and
  `changePhrases`), `{ key, vars }` where `key` is an `srv.` phrase of the
  staff dictionaries and a value may itself be one. The dashboard says it in
  the staff language; what people typed and providers' errors stay values
  ([regions and languages](../product/regions-and-tax.md)).
- **Money.** No route marks anything paid because it was called: payment
  routes answer with the gateway's page to send the payer to, and only the
  gateway's signed report or the redirect's check marks it paid
  ([payments and credit](../features/payments-and-credit.md)).

## The main workflows, by route

Where to start for each, in the order a client calls them. The rows below
have the fields.

- **Booking a court:** `GET /api/availability` (starts and prices) →
  `GET /api/quote` → `POST /api/bookings` (answers `booking`, `holdUntil` if
  it must be paid online to be kept) → `POST /api/payments` (the page to pay
  on) → `GET /api/bookings?code&phone`. Changing it:
  `GET`/`POST /api/bookings/reschedule`; cancelling:
  `POST /api/bookings/cancel`. Staff: `/api/admin/bookings*`.
- **Payments and refunds:** `POST /api/payments` and the provider's report to
  `/api/payments/:provider/callback`; refunds owed and made are on the
  booking (`refunds`), and staff's under `/api/admin/online-payments`.
- **Open games and matchmaking:** `GET /api/games` and
  `GET /api/games/recommended` (suggested, with reasons) →
  `POST /api/games/:id` (`join`, `leave`, `pay`, `invite`, `keepPlace`) →
  the host's `POST /api/games/:id/players/:playerId`,
  `GET /api/games/:id/candidates` and `GET`/`POST /api/games/:id/move`.
- **Tournaments:** staff `POST /api/admin/tournaments` →
  `POST /api/admin/tournaments/:id` (`draw`) → results at
  `/api/admin/tournaments/:id/matches/:matchId`; players
  `POST /api/tournaments/:id` (`enter`, `report`, `confirm`, `dispute`);
  officials `/api/officials/:token`.
- **Running a venue:** `/api/admin/venues`, `/api/admin/courts`,
  `/api/admin/peak-rules`, `/api/admin/booking-policies`,
  `/api/admin/venues/:id/payment-settings`, and `/api/admin/go-live` to ask
  to go live.

## API

| Method | Path                  | Description                                        |
| ------ | --------------------- | -------------------------------------------------- |
| GET    | `/api/health`         | `{ok}` while the database answers, `503` when it does not |
| GET    | `/api/venues`         | All venues with their courts                        |
| GET    | `/api/availability`   | `?venueId=&date=YYYY-MM-DD&sport=` → each court's day: `starts` (each minute a booking may start, and the longest it may run from there; `lengths`, the lengths that fit, where not every one up to the longest does: joining a session on a facility turned over whole), its booking `policy` (with `needs`: a sign-off or certification its rules ask for first, or null), and `slots`, the day in columns of `grid` minutes (free, `partly` held, held, with price); `mayOverride` for a manager; rooms run as classes only for the venue's own staff |
| GET    | `/api/quote`          | `?courtId&date&start&end` (or `minutes`), or `venueId&sport` for any court, `[&sport]` for one activity on a court offering several, `[&players]` (players, or places on a shared facility) `[&also=2,3]` (`2:4` for four places on a shared resource) → the price before booking: `total`, `court`, `fees`, `billedMinutes`, each part (`lines`), whether the court's rules allow it (`allowed`, `error`), and `others` for `also` |
| GET    | `/api/venues/:id/live`| Who is inside each shared facility right now        |
| GET    | `/api/classes`        | `?venueId=&sport=&from=&to=` → upcoming classes     |
| POST   | `/api/classes/enrol`  | `{classId, name, phone, email?}` → take a place     |
| POST   | `/api/waitlist`       | `{classId \| courtId+date+start+end, name, phone, email?}` → queue |
| DELETE | `/api/waitlist`       | `{entryId, phone}` → leave the queue                |
| POST   | `/api/waitlist/claim` | `{token}` → take up an offered place                |
| POST   | `/api/checkin`        | `{token}` → self check-in from the booking QR       |
| POST   | `/api/access`         | `{code, phone}` → the door code for an unmanned resource |
| GET    | `/api/checkin/qr`     | `?token=` → that booking's QR code as an SVG        |
| POST   | `/api/bookings`       | `{courtId \| venueId+sport, sport?, date, start, end \| minutes, players?, moreCourts?, name, phone, email?, weeks?, skipConflicts?, override?, participantId?}`; `participantId`: for somebody the signed-in adult manages (one court; their own sign-off and waiver are what count, `GUARD_NOT_FOUND` 404 for anybody else's, [applying for somebody you manage](../features/activities.md#applying-for-somebody-you-manage)); `moreCourts` books other courts at the same time as one (`GR-`), each an id, or `{courtId, places}` for a number of places on another shared resource (a kind of kit); `sport` picks the activity on a court offering several (else its main one; `SPORT_NOT_HERE` if it offers none such); `players` is places on a shared facility; `SIGN_OFF_NEEDED` or `CERTIFICATION_NEEDED` where the activity asks for one (online, on the signed-in account; booked by the venue's own staff, by number), `SIGN_OFF_EACH` for several places on one, `CLASSES_ONLY` for a room run as classes; `override` (managers) books outside the court's rules, recorded |
| GET    | `/api/bookings`       | `?code=&phone=` → booking details, with any refund owed or made on it (`refunds`); on an unmanned resource, `door`: `{by: "code" \| "counter", partly}` by the booking's whole time |
| POST   | `/api/bookings/cancel`| `{code, phone}` → cancel (before start time only)   |
| POST   | `/api/bookings/cancel-series` | `{seriesCode, phone, preview: true}` → `weeks`: each upcoming week and what cancelling it would do (`free`, `late` with the share kept, or `stays` and why); `{seriesCode, phone, codes, acceptLate}` → cancel those weeks, late ones only if listed in `acceptLate` (`SERIES_CHANGED` if a week's terms moved since); without `codes`, only the weeks free to cancel, the rest returned as `left` |

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
| GET    | `/api/my/bookings`        | The signed-in user's bookings (each with `mostSpots`, the most players an open game on it can look for), and refunds owed or made on them (`refunds`) |
| GET    | `/api/my/wallet`          | Credit balance and recent movements             |
| POST   | `/api/my/wallet`          | `{venueId, amount}` → the page to pay on; the credit lands once it is paid |
| POST   | `/api/my/vouchers`        | `{code}` → a gift voucher, as credit            |
| POST   | `/api/vouchers`           | Buy a gift voucher online → `{url}` to pay      |
| GET    | `/api/my/passes`          | The signed-in customer's multi-visit passes     |
| GET    | `/api/my/membership`      | The signed-in customer's memberships            |
| POST   | `/api/my/membership`      | `{planId, autoRenew?}` → the page to pay the venue on; the membership is made once it is paid, and with `autoRenew` again each period |
| DELETE | `/api/my/membership`      | `?renewal=<id>` → stop renewing; the membership runs to its end |
| GET    | `/api/my/waitlist`        | Places you are queuing for, and any live offer: those this account joined, or on its proved number |
| GET/POST | `/api/venues/:id/terms` | The venue's booking rules, and for an account whether it put them away and its strikes / `{version}`: don't show again |
| GET    | `/api/my/data`            | Everything held against this account, as a file |
| POST   | `/api/my/erase`           | `{confirm:"DELETE"}` → close the account        |
| POST   | `/api/my/bookings/cancel` | `{bookingId}` → cancel own booking              |
| GET    | `/api/bookings/reschedule` | `?code&phone&date` → free start times that day; `409` (`RESCHEDULE_CUTOFF`, `RESCHEDULE_STARTED`) with no times once the booking may no longer be changed |
| POST   | `/api/bookings/reschedule` | `{code, phone, date, start}` → change it   |
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
| POST   | `/api/admin/bookings/reschedule` | `{code, date, start, courtId?, override?, preview?, reason?}` → change it; customer told; `override` (managers) outside the rules, recorded. `preview: true` → what it would do, changing nothing. A booking whose open game has players moves only with a manager's `reason`, which its players are told (403 for the front desk, 400 without one) ([moving a game](../features/matchmaking.md#moving-a-game-to-another-time)) |
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
| GET    | `/api/admin/hire`             | `?venueId=` → kit that is still out, and how each reason for keeping money is taxed (`deductions`) |
| POST   | `/api/admin/hire`             | `{code, action:"take", deposit?}` or `{code, action:"return", condition, deductions?: [{reason, amount}], note?, via?}` (`withheld` alone still accepted, its reason taken from the condition) |
| GET    | `/api/admin/wallet`           | `?q=` → find a customer by email or phone            |
| POST   | `/api/admin/wallet`           | `{userId, amount, reason?}` → sell credit            |
| GET    | `/api/admin/memberships`      | `?venueId=` → that venue's members                   |
| POST   | `/api/admin/memberships`      | `{venueId, holderName, holderPhone, startsOn, expiresOn, price}` |
| POST   | `/api/admin/memberships/:id/void` | Cancel a membership                              |
| GET    | `/api/admin/promos`           | `?venueId=` → that venue's promo codes               |
| POST   | `/api/admin/promos`           | `{venueId, code, description, kind, value, sport?, minHours?, validFrom, validTo, maxUses?}` |
| POST   | `/api/admin/promos/:id/void`  | Withdraw a code; discounts already given stand       |
| GET    | `/api/admin/passes`           | `?venueId=` → passes sold by that venue              |
| POST   | `/api/admin/passes`           | `{venueId, name, sport?, kind?, entries, entryMinutes?, maxMinutes?, price, holderName, holderPhone, expiresOn}`: `kind` `session` (entries, each `entryMinutes` or part, 60 unless given, null for one a booking) or `time` (`entries` is minutes) |
| POST   | `/api/admin/passes/:id/void`  | Cancel a pass; entries already spent stay spent      |
| GET    | `/api/admin/vouchers`         | `?venueId=` → gift vouchers sold, with printable links |
| POST   | `/api/admin/vouchers`         | `{venueId, amount, buyerName, buyerEmail?, recipientName?, message?, via?}`: sold at the counter |
| POST   | `/api/admin/vouchers/:id/void` | Cancel a voucher nobody has used                   |
| GET    | `/api/admin/classes`          | `?venueId=` → classes including cancelled ones       |
| POST   | `/api/admin/classes`          | `{courtId, name, instructor, date, start, end, capacity, price, weeks?}` |
| GET    | `/api/admin/classes/:id`      | The class and its roster                             |
| DELETE | `/api/admin/classes/:id`      | Cancel a class, releasing every enrolment            |
| GET    | `/api/admin/slots`            | `?venueId=&date=` → each court's day for staff: columns, and every booking, class, block, outage and buffer to the minute (`entries`) |
| POST   | `/api/admin/blocks`           | `{courtId, date, start, end \| hours[], reason?, places?}` → block that time; what is booked in it stays, the rest is blocked |
| DELETE | `/api/admin/blocks`           | `{courtId, date, start, end \| hours[]}` → release blocked time |
| GET    | `/api/admin/occupancy`        | `?venueId=&start=&days=` → booked/blocked counts     |
| GET    | `/api/admin/reports`          | `?venueId=&from=&to=` → the period report            |
| POST   | `/api/admin/courts`           | `{venueId, name \| count, sport, offPeakRate, peakRate, capacity?, deposit?, noun?, perPlayer?, maxPlayers?, setting?, also?}`: one resource, or `count` (1–20) numbered after `noun` (Lane 1…), filled in from the activity's template; `also` lists more activities it offers → `{court, courts}` |
| GET    | `/api/admin/courts/:id`       | The court plus the door code staff may see for it    |
| PATCH  | `/api/admin/courts/:id`       | `{name?, offPeakRate?, peakRate?, memberOffPeakRate?, memberPeakRate?, capacity?, deposit?, unmanned?, accessCode?, noun?, heading?, activities?}`; `heading` (2–40 characters, or null) lists it under one heading with the venue's other kinds of the same thing; `activities` is `[{sport, offPeakRate?, peakRate?}]` besides its main one (refused while one taken off has bookings to come); `flatRate`, `quantityPrices` (`[{from, percent}]`) and `classesOnly` say how a booking is priced and sold |
| POST   | `/api/admin/venues`           | `{name, area, address, phone}` — **owner only**      |
| PATCH  | `/api/admin/venues/:id`       | `{name?, area?, address?, phone?, cancelCutoffHours?, openMin?, closeMin?, staffedFrom?, staffedTo?, partlyUnstaffed?, emergencyPhone?, emergencyInfo?}`; `partlyUnstaffed` is `code` or `counter`: a booking staffed for only part of its time gets the door code, or somebody stays on the desk |
| GET    | `/api/admin/venues/:id/closures` | Upcoming closed days for one venue                |
| POST   | `/api/admin/venues/:id/closures` | `{date, reason?}` → close that whole day          |
| DELETE | `/api/admin/venues/:id/closures?date=` | Re-open a closed day                        |
| GET    | `/api/admin/demo`             | Whether this install is empty — **owner only**       |
| POST   | `/api/admin/demo`             | Fill an empty install with a demo fortnight — **owner only** |
| GET    | `/api/admin/retention`        | The retention policy, what is due, and when it last ran — **owner only** |
| POST   | `/api/admin/retention`        | Apply the retention policy now — **owner only**      |
| GET    | `/api/admin/player-reports`   | Reports about players, `?status=open\|reviewed&before=<id>` — **owner only** |
| POST   | `/api/admin/player-reports`   | `{ id }` — mark a report reviewed — **owner only** |
| GET    | `/api/admin/backup`           | Snapshots, off-site status and backup health — **owner only** |
| POST   | `/api/admin/backup`           | Take one now — **owner only**                        |
| GET    | `/api/admin/admins`           | List operator accounts — **owner only**              |
| POST   | `/api/admin/admins`           | `{name, email, password, venueId}` — **owner only**  |
| DELETE | `/api/admin/admins/:id`       | Remove an operator — **owner only**                  |
| POST   | `/api/admin/admins/:id/two-factor-reset` | `{reason, code}`: reset a member of staff's two-factor sign-in after they lost both authenticator and recovery codes; by an owner or that business's manager (an owner only by another owner), with the caller's own current `code`; signs them out, recorded, emailed to them and the owners |

## More routes, by area

### Public pages and booking

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/ack` | `{ token }` — the customer has seen the venue's news |
| GET | `/api/addons` | What can be added to a booking: `?courtId=&date=&start=&end=` (or `hours=18,19`), or `?venueId=&sport=` in place of a court, or `?classId=` for a class. Rentals say how many are left for that time |
| POST | `/api/bookings/split` | `{ code, phone, parts }` → the booking split `parts` ways, and the link to send friends |
| GET | `/api/classes/term` | `?classId` → the sessions left in this weekly class that can still be joined, and what the term costs |
| GET | `/api/coaching/slots` | `?coachId&date&sport?` → when a lesson with that coach can start that day (`starts`: minute and longest length), and the lengths the sport's courts allow (`policy`) |
| GET | `/api/games` | Public open games with room (or a waiting list), soonest first: `?sport=&date=&area=&level=&who=women`, or `?near=lat,lng&km=` for nearest. Signed in, each says where you stand in it. Private games are never listed |
| POST | `/api/games` | `{ bookingCode, spots, level, share, autoAccept, note?, who?, visibility?, waitlist?, intensity?, adultsOnly? }` — open one of your bookings to other players; `spots` up to ten, or the court's most per booking less the host where that is more |
| GET | `/api/games/recommended` | Signed in: open games suggested for you, best first, each with its score and reasons; `?sport=&offset=&limit=` ([matchmaking](../features/matchmaking.md#suggested-games-and-players)) |
| GET | `/api/games/:id` | One game as you may see it; a private one only to its host, its players and invitees, or with `?link=` |
| POST | `/api/games/:id` | `{ action }` on one game, by the signed-in player: "join" (ask, join outright where the host lets everybody in, join the waiting list, or take up an invitation or a held place; `link` for a private game), "leave" (also turns down an invitation or held place), "pay" (your share, online, to the venue — answers with where to pay), "invite" (`userId` or `email`); for its host, "close", "cancel", "link" (`hours`), "unlink" and, on a weekly game, "inviteRegulars"; "keepPlace" for a player keeping their place at the new time it is moving to (or confirming the venue's change) |
| GET | `/api/games/:id/move` | The host: `?date` → the start times the game's booking could move to that day |
| POST | `/api/games/:id/move` | The host: `{ date, start, courtId?, preview? }` → `preview` shows what a move would do; otherwise moved at once while nobody is in the game, or proposed to its players (`outcome: "proposal"`), the new time held while they answer; `{ action: "withdraw" }` withdraws a proposal ([moving a game](../features/matchmaking.md#moving-a-game-to-another-time)) |
| GET | `/api/games/series` | The signed-in host's weekly games, each with its dates' games |
| POST | `/api/games/series` | `{ bookingCode, title?, …game settings }` — make one of your weekly bookings a weekly game, a game on each upcoming date |
| POST | `/api/games/series/:id` | `{ action: "end", callOffUpcoming? }` — the host ends a weekly game; the court bookings stay theirs |
| GET | `/api/groups` | Community groups to ask to join, `?sport=&area=&offset=`; signed in, your own too |
| POST | `/api/groups` | `{ name, sport, area?, description?, privacy?, capacity? }` — start a group, which you organise |
| GET | `/api/groups/:id` | One group as you may see it; a private one only to members and invitees; the roster to members |
| POST | `/api/groups/:id` | `{ action }`: "join" (ask, or take up an invitation), "leave"; the organiser's "invite" (`email`) and "close"; a member hosting a game, "inviteToGame" (`gameId`) |
| POST | `/api/groups/:id/members/:memberId` | `{ action: "accept" \| "decline" \| "remove" }` — the organiser on one person |
| GET | `/api/games/:id/candidates` | The host: opted-in players who might suit the game — first name, level, distance band and reasons; `?offset=&limit=` |
| POST | `/api/games/:id/players/:playerId` | `{ action: "accept" \| "decline" \| "remove" \| "no_show" }` — the host about one player |
| GET | `/api/geocode` | `?q=` — where an address is, so the map on the application and branch forms can open on it. Asked through here rather than from the browser so every lookup shares one queue and one cache |
| GET | `/api/leagues` | Leagues taking players: `?sport=` |
| GET | `/api/leagues/:id` | The boxes, the tables and the results, `?season=` for an earlier one; and, signed in, your place and box-mates |
| POST | `/api/leagues/:id` | `{ action: "join", partnerName? }`, `{ action: "leave" }`, or `{ action: "pay" }` this season's fee |
| POST | `/api/leagues/:id/matches/:matchId` | A player on one of their own matches: `{ action: "report", winner, score }` (their games first), `{ action: "confirm" }`, or `{ action: "dispute", note }` |
| POST | `/api/receipts/einvoice` | `{ ref, t, name, tin, idType, idNumber, sst?, email, phone, addressLine, city, postcode, stateCode }` → an LHDN e-invoice made out to the customer for this receipt, sent at once. The receipt's signed link is the proof they hold it |
| POST | `/api/reviews` | `{ code, t, rating, body? }` → this number's review of the venue, written or written again |
| GET | `/api/sports` | The sports somebody here offers, in the usual order (on a storefront, its venues'), for the sport choices on search, classes and games |
| GET | `/api/search` | `?sport=&date=&from=&to=&minutes=&area=`, or `&near=lat,lng&km=` in place of an area; `q=` in place of `sport` finds the activity by any of its names (404 when none) → free courts, one result per venue and start time. `from` and `to` are the earliest and latest start (HH:MM, or hours); `minutes` the length (or `duration` in hours), found on courts whose booking rules take it. Each result has `needs` (`signOff`, `certification` or null: what the shown court's rules ask for first) and `groups`: for each heading at the venue with a kind free then, `{ heading, kinds }`, each kind `{ courtId, name, free, totalPrice, perPlayer, capacity, placesLeft, needs }` as itself, never summed ([discovery](../features/discovery.md#finding-a-court-from-the-front-page)) |
| POST | `/api/split/:token/pay` | `{ name, phone, email? }` → the venue's payment page for one share of a split booking |
| GET | `/api/tournaments` | Tournaments coming up, or just played: `?sport=` |
| GET | `/api/tournaments/:id` | The draw, the groups, the bracket and the times; and, signed in, your entry and the results waiting on your matches (`reports`) |
| POST | `/api/tournaments/:id` | `{ action: "enter", partnerName?, partnerGender?, teamName?, roster?, entryMark?, birthDate?, partnerBirthDate?, rosterEligible?, guardianName?, guardianConsent? }` (dates of birth where the tournament has an age range; a guardian's name and agreement for a declared minor, code `GUARDIAN_CONSENT` without), `{ action: "withdraw" }` (before the draw), or `{ action: "pay" }`; where players enter results, `{ action: "report", matchId, winner, score?, walkover? }` (own score first; `winner: null` for a draw), `{ action: "confirm", matchId }` or `{ action: "dispute", matchId, note }` |
| GET | `/api/officials/:token` | An official's link: the tournament and its matches; 404 once withdrawn, past its last day, or the tournament is over |
| POST | `/api/officials/:token` | `{ matchId, winner, score?, walkover?, retired? }` — a result for a match still to be decided, entered as staff would, under the official's name |
| POST | `/api/venue-applications` | A venue asking to join. Only a marketplace takes them |
| POST | `/api/venues/:id/enquiry` | `{ name, phone, email?, kind, wantedOn?, people?, message }`: a private hire enquiry from the venue's page, passed to its staff |
| GET | `/api/venues/:id/qr` | The venue's booking link as a QR code (SVG), to print or share |
| GET | `/api/venues/:id/waiver` | The venue's waiver as it stands, or null: whether the booking form asks for it |

### Sign-in, unsubscribing and feeds

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/auth/google` | Off to Google, `?next=` being where to come back to |
| GET | `/api/auth/google/callback` | Back from Google: signed in, and on to where they were going; or back to sign in, saying why |
| GET | `/api/auth/providers` | Which ways of signing in this address offers, besides a password |
| GET | `/api/calendar/:token` | A venue's bookings and classes as an iCalendar feed, for its staff's own calendar apps. The token is the only key: a wrong or withdrawn one finds nothing |
| GET | `/api/coach-calendar/:token` | A coach's lessons as an iCalendar feed. The token is the only key |
| POST | `/api/unsubscribe` | `{ token }` from a venue's email → no more news from it; with `confirm`, yes to it. No account needed |
| POST | `/api/unsubscribe/:token` | One-click unsubscribe from a mail app's own button (RFC 8058): the List-Unsubscribe-Post header on a venue's news says to POST here. Only a POST stops anything, so a scanner fetching links does not |

### Customer account (session cookie)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/my/about` | Which games the account plays in: woman, man, prefer not to say — or not said yet (null) |
| POST | `/api/my/about` | `{ gender: "woman" \| "man" \| "unsaid" }` |
| GET | `/api/my/accounts` | `?venueId` → the company and school accounts here the signed-in customer may charge a booking to |
| GET | `/api/my/approvals` | The signed-in customer's applications to be approved for an activity, with their history; `courts` where a slot can be asked for; with `?venueId&sport`, also what that venue asks (`apply`, or null where it takes none online) ([activities](../features/activities.md#registering-online-for-approval)) |
| POST | `/api/my/approvals` | Apply: a form upload with `data` (JSON `{ venueId, sport, answers?, declaration?, videoWatched?, waiver?, adult, guardianName?, guardianDeclaration?, certReference?, certExpiresOn?, slot?: { courtId, date, start, end }, forPerson?, authority? }`; `forPerson` with `authority: true` applies for somebody the account's adult manages, who is then the guardian on it, `adult` not asked) and up to three `document` files (PDF, JPEG, PNG or WebP, 10 MB each, checked by content: [supporting documents](security.md#supporting-documents)), or the JSON alone. A slot asked for is held, never booked, until approved; nothing is charged |
| POST | `/api/my/approvals/:id` | The customer's own application: `{ action: "answer", answer }` (documents as a form upload), `{ action: "withdraw" }` (its hold let go), or `{ action: "slot", slot }` (held; booked at once as the in-person session once the online part is accepted) |
| GET | `/api/my/approvals/document` | `?id` → a document the customer sent with one of their applications: a PDF as an attachment, an image inline, under the document policy, never cached; each opening recorded ([supporting documents](security.md#supporting-documents)) |
| GET | `/api/my/people` | People the signed-in adult manages (a child, or somebody else they have authority for), `?archived=1` with those no longer managed: name, declared birth year and relationship, when authority was declared ([applying for somebody you manage](../features/activities.md#applying-for-somebody-you-manage)) |
| POST | `/api/my/people` | `{ displayName, birthYear?, relationship: "parent" \| "guardian" \| "other", authority: true }` → add one; any other field (an email, phone, photo, school, identity number) is refused (`GUARD_EXTRA_FIELD`), never stored |
| PATCH | `/api/my/people` | `{ id, displayName?, birthYear?, relationship?, authority?, archived? }` → change one of the account's own (a changed relationship needs `authority: true` again); `archived` stops or resumes managing them, deleting nothing; anybody else's is `GUARD_NOT_FOUND` (404) |
| GET | `/api/my/reviews` | A coach signed in to their own account (one a venue linked to its coach record): `coaches` (which records) and the applications they may review, for the activities each venue named them for; empty for everybody else ([ADR 0020](decisions/0020-approval-to-booking-payment-and-authority.md)) |
| POST | `/api/my/reviews` | `{ id, action: "approve" \| "reject" \| "ask" \| "in_person" \| "check" \| "revoke" \| "authority", reason? }`: the coach's decision, under their name and this account; refused (403, `APR_NOT_REVIEWER`) for any application they are not named for. Rejecting, asking and revoking need a reason |
| GET | `/api/my/reviews/document` | `?id` → a document sent with an application the signed-in coach may review, as the customer's route serves it; each opening recorded under the coach's name |
| GET | `/api/my/games` | The signed-in player's games: hosting, with who asked; and playing |
| GET | `/api/my/guests` | The venues this resident can invite guests to, and their guests there now |
| POST | `/api/my/guests` | `{ venueId, phone, name, days }`: put a guest on the venue's list |
| DELETE | `/api/my/guests` | `?id=`: take one's own guest off the list |
| GET | `/api/my/levels` | The signed-in player's level in each sport they have given one for |
| GET | `/api/my/profile` | How the signed-in player likes to play (area, approximate point, distance, days, times, intensity, most per share, opt-ins, declared age), and their levels |
| PUT | `/api/my/profile` | Any of those fields; being found or invited by anybody needs a declared 18 or over |
| GET | `/api/players/blocks` | Who the signed-in player has blocked |
| POST | `/api/players/blocks` | `{ userId }` — block somebody you have come across here |
| DELETE | `/api/players/blocks` | `{ userId }` — undo a block |
| POST | `/api/players/reports` | `{ userId, reason, gameId?, note? }` — report somebody you have come across here to the platform's owners |
| PUT | `/api/my/levels` | `{ sport, level \| null }` |
| GET | `/api/my/marketing` | The venues this account agreed to hear from, and whether it still does |
| POST | `/api/my/marketing` | `{ id }` → stop hearing from that venue |
| GET | `/api/my/phone` | The account's number, and whether it is checked |
| POST | `/api/my/phone` | `{ action: "whatsapp", phone }` starts a check by a message the customer sends us from that number on WhatsApp, and returns the link that opens it; `{ action: "send", phone }` sends a code to it by SMS (or WhatsApp); `{ action: "confirm", code }` checks it; `{ action: "save", phone }` keeps it as given, where this install does not check numbers |
| GET | `/api/my/receipts` | The signed-in customer's receipts and credit notes, newest first, each with its signed link |

### Coaches (by their private link)

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/coach/:token/hours` | `{ hours: [{ weekday, from, until }] }`: a coach sets the hours they take lessons, at the private link the venue gave them. Lessons already booked stand |
| POST | `/api/coach/:token/time-off` | `{ from, until?, reason? }`: days off, at the coach's own link. What is already booked then is counted, for the venue to move |
| DELETE | `/api/coach/:token/time-off` | `?id`: back at work those days |

### Payments and providers' webhooks

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/payments` | Open a payment page for one or more of a customer's bookings. `{ code, phone }` or `{ codes: [...], phone }`, with `deposit: true` for the venue's deposit only. Answers with the gateway's URL to send the customer to; the booking is marked paid when the gateway says it was, never because this was called |
| POST | `/api/payments/:provider/callback` | A gateway, server to server, saying what happened to a payment page: `/api/payments/billplz/callback`, and the like for any other gateway. This is the message that counts: the customer's browser may never come back. It is believed only when it checks out under the key of the account the page was made through, at that same gateway. Gateways retry anything but a 200, so a forged or unknown one is answered 400 and a … |
| GET | `/api/whatsapp/webhook` | Meta checking the address when it is subscribed |
| POST | `/api/whatsapp/webhook` | Meta's signed delivery of messages to the platform's number (`WHATSAPP_APP_SECRET`) |

### Run by the app itself

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/errors` | `{ name?, message, stack?, path? }`: an error in a customer's browser, filed with the server's. Anybody can send one, so it is limited per address, cut to size and never echoed back |
| GET | `/api/tls-check` | `?domain=` → `200` for the install's own address or a registered storefront (with or without `www.`), `404` otherwise: whether Caddy may get a certificate for it on first visit (`on_demand_tls { ask … }`) |

### Admin (admin session cookie; venue-scoped unless noted)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/admin/accounts` | `?venueId` → the venue's company and school accounts, its invoices to them, and the `languages` an invoice can be in |
| POST | `/api/admin/accounts` | `{ venueId, id?, name, email, contact?, address?, taxNo?, termsDays?, creditLimit?, locale? }`: open one, or change it (managers); `locale`, one of the site's languages, is what its invoices are written in |
| DELETE | `/api/admin/accounts` | `?venueId&id`: closed to new bookings; what is on it is still invoiced (managers) |
| POST | `/api/admin/accounts/bookers` | `{ venueId, accountId, name, phone }`: somebody who may charge their own bookings to the account (managers) |
| DELETE | `/api/admin/accounts/bookers` | `?venueId&accountId&phone`: no longer (managers) |
| POST | `/api/admin/accounts/charge` | `{ bookingId, accountId }`: the desk charges a booking to a company or school account; `accountId: null` takes it off again, until it is invoiced |
| POST | `/api/admin/accounts/invoices` | `{ accountId, period: "YYYY-MM" }`: invoice what was played on it up to that month's end, now (managers) |
| POST | `/api/admin/accounts/invoices/:id` | `{ via }`: paid, and so is every booking on it |
| DELETE | `/api/admin/accounts/invoices/:id` | Withdrawn, its bookings to be invoiced again; not once paid (managers) |
| GET | `/api/admin/addons` | `?venueId=` — every extra a venue has, retired ones last |
| POST | `/api/admin/addons` | `{ venueId, name, kind: "rental" \| "sale", price, stock?, sport? }` |
| PATCH | `/api/admin/addons/:id` | Change it, or retire it with `active: false` and bring it back with `true` |
| DELETE | `/api/admin/addons/:id` | Retired, not deleted: bookings that had it still say what they had |
| GET | `/api/admin/approvals` | `?venueId[&waiting=1]` → applications to be approved for an activity here, those waiting on the venue first, how many wait, and `flags`: bookings to decide after an approval was revoked ([activities](../features/activities.md#registering-online-for-approval)) |
| POST | `/api/admin/approvals` | `{ venueId, id, action: "approve" \| "reject" \| "ask" \| "in_person" \| "check" \| "revoke" \| "authority", reason?, payLater? }`: decide one. Refusing, asking and revoking need a reason; approving accepts the online part where an in-person step is still to come, otherwise writes the sign-off and books a slot asked for if it is still free, held for payment where the venue asks payment to hold (`payLater`: an exception, paid at the counter, on record). A safety-assessed activity is approved, and its in-person step recorded, only by a manager or front desk delegated for it (403 `APR_SAFETY_AUTHORITY`); `check` records the administrative check; `authority` records that the authority of an adult who applied for somebody they manage was reviewed (by those who may grant it), which approval waits for where the activity asks it (409 `APR_CHILD_AUTHORITY_UNREVIEWED`). `{ venueId, flagId, action: "resolve_flag", note }`: a flagged booking dealt with. Recorded in its history and the activity log |
| GET | `/api/admin/approvals/document` | `?venueId&id` → a document sent with an application here, as the customer's route serves it; each opening recorded under the staff member's name |
| GET | `/api/admin/approvals/settings` | `?venueId` → what the venue asks for each activity before approving online, its coaches who could review (with the account each is linked to), and its front-desk staff who could be delegated |
| POST | `/api/admin/approvals/settings` | `{ venueId, sport, kind?, intro?, declaration?, documentLabel?, documentPurpose?, videoUrl?, inPerson?, questions?, waiver?, validDays?, pendingDays?, holdHours?, payHours?, open?, coachIds?, reviewLevel?: "safety" \| "administrative", delegateIds?, reviewDays?, documentDays?, recordDays?, guardianCheck? }`: take applications online for an activity, or change what is asked and who may grant it (managers); a document label needs its purpose, and naming an identity document in either is refused; the retention days may only be shorter than the install's ([privacy](privacy.md#applications-to-be-approved-for-an-activity)); recorded |
| POST | `/api/admin/approvals/reviewers` | `{ venueId, coachId, email }`: link a coach to their own MySenam account by its email, or unlink it (`email: null`); a coach reviews only signed in to it (managers); recorded |
| POST | `/api/admin/approvals/supervised` | `{ venueId, code, supervised, note }`: arrange (or stop) staff-supervised attendance on a booking, saying who supervises under which procedure; never a door code, and no sign-off for later (managers); recorded |
| DELETE | `/api/admin/approvals/settings` | `?venueId&sport`: no more applications online for it; those in are still decided (managers); recorded |
| GET | `/api/admin/approvals/holds` | `?venueId` → holds keeping applications here past their time, those in force first (managers and the platform owner; [holds](privacy.md#holds)) |
| POST | `/api/admin/approvals/holds` | `{ venueId, requestId, basis: "legal" \| "safety" \| "dispute" \| "incident", reason, reviewBy }`: keep an application past its time until the review date (a manager: at most 90 days, 180 in all for one application; the platform owner: a year at a time); a renewal is a new hold; recorded |
| PATCH | `/api/admin/approvals/holds` | `{ venueId, id, reason }`: release a hold before its review date; recorded |
| GET | `/api/admin/attention` | Urgent news not yet known to have reached the customer, what closed this week, and refunds past the date customers were told (`refundsOverdue`) |
| POST | `/api/admin/attention` | `{ id, action: "told" }` — staff told the customer another way |
| GET | `/api/admin/auth/two-factor` | This account's two-factor sign-in: on or off, and whether the install requires it |
| POST | `/api/admin/auth/two-factor` | `{ action: "start" }` → a new secret and its QR code to scan; `{ action: "confirm", code }` → turns it on, with recovery codes shown once; `{ action: "renew", code }` → new recovery codes; `{ action: "disable", code }` → off, where the install allows |
| GET | `/api/admin/billing` | A marketplace venue's invoices. Venue staff see their own venue's; the platform owner sees every venue's, and what each is on |
| POST | `/api/admin/billing` | `{ action: "pay", invoiceId }` — the venue's own staff, or the owner. `{ action: "markPaid" \| "void", invoiceId }` and `{ action: "setPlan", venueId, monthlyFee, billingStartsOn }` and `{ action: "setTiers", tiers: [{ name, upTo, monthlyFee }], extraEach }` — the owner |
| GET | `/api/admin/booking-alerts` | `?venueId` → where the venue hears about bookings made online |
| POST | `/api/admin/booking-alerts` | `{ venueId, email, phone }`: either blank to stop that one |
| GET | `/api/admin/branches` | A business manager's branches: drafts, waiting to go live, and decided |
| POST | `/api/admin/branches` | `{ name, area, address, phone, lat, lng, message? }` — add a branch, as a draft to set up |
| GET | `/api/admin/businesses` | Every business and its branches. The platform owner's |
| POST | `/api/admin/businesses` | `{ name, venueIds, managerIds? }` — a new business from these venues. `{ businessId, venueIds, managerIds? }` — more branches or managers for one |
| GET | `/api/admin/coach-payouts` | `?venueId=&from=&to=[&format=csv]` → each coach's lessons in the period and the fees on them |
| GET | `/api/admin/concessions` | `?venueId` → the concession prices offered here |
| POST | `/api/admin/concessions` | `{ venueId, id?, name, percent, proof, sport?, offPeakOnly?, preset? }`: offer one, or change it (managers). `preset` (`student`, `senior`, `child`, `oku`) is kept only while the name and proof are that built-in one's words, so customers read it in their own language |
| DELETE | `/api/admin/concessions` | `?venueId&id`: no longer offered (managers) |
| POST | `/api/admin/concessions/check` | `{ bookingId, outcome: "seen" \| "refused", remember?, via? }`: the desk has looked at the proof for a concession price. Seen, it is remembered for the time chosen (the fact only); not shown, the full price is charged |
| GET | `/api/admin/counter-sales` | `?venueId=&date=` → that day's counter sales, newest first, with the totals by how they were paid |
| POST | `/api/admin/counter-sales` | `{ venueId, items: [{ addonId, quantity } \| { name, price, quantity }], via, customerName?, customerPhone? }` → the sale, receipted |
| POST | `/api/admin/counter-sales/:id/void` | `{ reason }` → the sale voided and its receipt credited (managers only) |
| GET | `/api/admin/court-links` | `?venueId` → which courts take which |
| POST | `/api/admin/court-links` | `{ courtId, parts: number[] }`: the courts booking this one takes too, replacing the list (managers) |
| GET | `/api/admin/customer-notes` | `?venueId&phone` → the venue's note on that customer |
| POST | `/api/admin/customer-notes` | `{ venueId, phone, note }`: write it; an empty note takes it away |
| GET | `/api/admin/einvoicing` | `?venueId=` → the venue's MyInvois settings and its recent e-invoices |
| POST | `/api/admin/einvoicing` | `{ venueId, action }`: - `save` with the settings' fields; - `test`: sign in to MyInvois with them; - `consolidate`: send last month now, rather than waiting for the scheduler; - `retry` with `id`: send one that failed or was invalid again; - `check`: ask LHDN about those sent and not yet decided |
| GET | `/api/admin/enquiries` | The private hire enquiries at the venues this account runs, open ones first, each with `replyLocale` (the language to answer in where known, else null) |
| POST | `/api/admin/enquiries` | `{ venueId, id, status }`: replied, booked or declined |
| GET | `/api/admin/errors` | `?resolved=1` for those marked fixed: errors by kind, latest first, for the platform owner |
| POST | `/api/admin/errors` | `{ id }`: fixed. It comes back on the list if it happens again |
| GET | `/api/admin/export` | `?venueId&from&to&kind=bookings\|payments\|journal\|summary` → a CSV download, for managers |
| GET | `/api/admin/go-live` | `?venueId=` — draft, waiting, live or off the marketplace, and what it still needs |
| POST | `/api/admin/go-live` | `{ venueId }` — send a draft to the platform owner to go live |
| GET | `/api/admin/google-feeds` | `?feed=merchants\|services\|availability` → that Reserve with Google feed, as JSON to upload (platform owners) |
| POST | `/api/admin/holidays` | `{ venueId, date, name }`: price that date like the weekend. Or `{ venueId, fill: true, state }`: every public holiday to come, in Malaysia the state's own too |
| DELETE | `/api/admin/holidays` | `?venueId&date`: back to an ordinary day |
| GET | `/api/admin/integrations` | `?venueId=` → the venue's API keys (never the keys themselves), webhook addresses and recent deliveries |
| POST | `/api/admin/integrations` | `{ venueId, action }`: `key` with `name`, `scope` (the key is in the answer, this once); `revoke` with `id`; `webhook` with `url` (its signing secret in the answer, this once); `remove`, `ping` or `resume` with `id`; `google` with `on` |
| GET | `/api/admin/leagues` | `?venueId=` — a venue's leagues, for its staff, with the head-to-head templates a new one can be scored by |
| POST | `/api/admin/leagues` | A new league, its first season forming; `template?` and `rules?` set how its matches are scored and boxes ranked (the sport's template by default) |
| GET | `/api/admin/leagues/:id` | The league as staff see it, `?season=` for an earlier one |
| POST | `/api/admin/leagues/:id` | `{ action: "start", startsOn?, endsOn? }` makes the boxes now, and starts it today unless told otherwise; `{ action: "end" }` finishes the season being played; `{ action: "plan", startsOn }` moves the coming season; `{ action: "close" }` stops the league |
| POST | `/api/admin/leagues/:id/matches/:matchId` | `{ winner, score?, walkover? }` decides it; `{ void: true }` strikes it; `{ clear: true }` puts it back to be played |
| POST | `/api/admin/leagues/:id/places/:placeId` | `{ paid }` — a season's fee taken at the counter, or not |
| POST | `/api/admin/leagues/:id/players/:playerId` | `{ startBox }` (a number, or null) for a newcomer, or `{ remove: true }` |
| GET | `/api/admin/loyalty` | `?venueId` → how many paid hours earn a free one here, or null when off |
| POST | `/api/admin/loyalty` | `{ venueId, every: number \| null }` (managers) |
| GET | `/api/admin/marketing` | `?venueId=` → how many agreed to hear from the venue, how many stopped, and what it has sent |
| POST | `/api/admin/marketing` | `{ venueId, action: "test" \| "send", subject, body }`: a copy to yourself, or the real thing |
| GET | `/api/admin/membership-plans` | The plans a venue sells online, and whether it can take the money yet |
| POST | `/api/admin/membership-plans` | `{ venueId, name, months, price, ratePercent?, aheadDays? }`: offer a new plan, a tier with its own benefits where given |
| DELETE | `/api/admin/membership-plans` | `?venueId=&id=`: stop offering a plan. Memberships bought on it run their course |
| PATCH | `/api/admin/membership-plans` | `{ venueId, id, ratePercent, aheadDays }`: a plan's benefits, each null for the venue's. Memberships on it get them from now |
| POST | `/api/admin/memberships/:id/extend` | `{ days, reason? }` → the membership runs that many days longer (managers) |
| GET | `/api/admin/messages` | What this venue has told its customers, and what is still waiting; `?platform=1` (platform owners only): the platform's own emails, links masked |
| POST | `/api/admin/messages` | Put one message back in the queue, optionally at a corrected address (a platform email: owners only; a password reset or confirmation never) |
| GET | `/api/admin/notices` | `?venueId=` → a venue's notices; `?venueId=site` → the site-wide one (platform owner) |
| POST | `/api/admin/notices` | `{ venueId \| "site", text, link?, startsOn, endsOn }` |
| DELETE | `/api/admin/notices/:id` | Taken down: by the venue's staff, or the platform owner |
| GET | `/api/admin/online-payments` | `?venueId=` → the venue's recent online payments, what it owes back (each with how long it has been owed and whether it is overdue), and its refund workload. `?workload=all` → the workload across every venue (the platform's owner) |
| POST | `/api/admin/online-payments` | `{ venueId, paymentId, note? }` → staff have refunded it themselves, with the reference they wrote down. `{ venueId, paymentId, through: "gateway" }` → refund it now, through the gateway's API with the venue's account |
| GET | `/api/admin/outages` | `?venueId=` — its courts' outages, now and to come, and `lateHoursOpen`: the ids of those whose last night's late hours, after midnight, are not closed (from before migration 0090) |
| POST | `/api/admin/outages` | `{ courtId, startsOn, endsOn: string \| null, reason?, cancelAffected? }` — take a court out. 409 with `affected` when something is booked in the stretch and `cancelAffected` was not given |
| PATCH | `/api/admin/outages` | `{ venueId, id? }` — close the late hours of the last night of the venue's outages (or one) where they are free → `repairs`, each with what it `claimed` (minutes of that day) and the bookings and classes there (`collisions`), left as they are ([legacy installs](../archive/migrations/legacy-installs.md#outages-from-before-migration-0090)) |
| DELETE | `/api/admin/outages` | `?id=` — back in service from today |
| GET | `/api/admin/peak-rules` | `?venueId` → when the venue's peak rates apply, and its holidays from today |
| POST | `/api/admin/peak-rules` | `{ venueId, weekdayFrom, weekdayUntil, weekendDays, weekendFrom, weekendUntil }` (times to the minute), or `{ venueId, lastMinute: { hours, percent, offPeakOnly } \| { off: true } }` |
| GET | `/api/admin/photos` | Photos venues added in the last fortnight, for the platform owner to look over |
| POST | `/api/admin/rain-out` | `{ venueId, courtIds, date, fromMin, untilMin, reason?, reasonPreset?, preview? }`: rained off. `reasonPreset: "rained_off"` (or no reason) gives each customer the built-in reason in their own language, `reason` then labelling the blocks; a `reason` alone is sent as typed. With `preview`, only what it would call off |
| GET | `/api/admin/receipts` | `?venueId` → the venue's latest receipts and credit notes, each with its link to print |
| GET | `/api/admin/repeat-blocks` | `?venueId` → the venue's repeating blocks with weeks still to come |
| POST | `/api/admin/repeat-blocks` | `{ venueId, courtIds, from, days, fromMin, untilMin, weeks, reason }`: block that time every week |
| DELETE | `/api/admin/repeat-blocks` | `?venueId&code`: the rest of the run taken off |
| GET | `/api/admin/reports/customers` | `?venueId&from&to` → who the customers were. Managers only, as the other reports |
| GET | `/api/admin/reviews` | `?venueId=` → the venue's reviews, hidden ones too, and whether it asks for them; the platform's owners also get those reported |
| POST | `/api/admin/reviews` | `{ venueId, action }`: - `reply` with `id`, `text` (empty takes the reply away); - `report` with `id`, `reason`: ask the platform to look at it; - `requests` with `on`: email customers once after a first visit, or not; - `hide` with `id`, `reason`, or `show` with `id`: the platform's owners only |
| GET | `/api/admin/setup` | How far this venue has got with setting itself up |
| POST | `/api/admin/setup` | `{ venueId?, action: "detailsChecked" \| "dismiss" }` |
| GET | `/api/admin/sport-rules` | `?venueId` → each sport's own rules here, over the venue's |
| POST | `/api/admin/sport-rules` | `{ venueId, sport, cutoffHours, lateKeep, peak }`, each null for the venue's (managers); starts and lengths are booking rules |
| GET | `/api/admin/booking-policies` | `?venueId` → each level's own booking rules (business, venue, sport at the venue, court, an activity on a court) and what each court, sport and activity on a court (`products`) ends up with, with a summary |
| POST | `/api/admin/booking-policies` | `{ venueId, level: "business" \| "venue" \| "sport" \| "court", sport?, courtId?, settings }` (a court with `sport` is that activity on that court; settings include `signOff`, minimum separation `bufferBefore`/`bufferAfter` and operational time `operationalBefore`/`operationalAfter`, 0–240 minutes each, [buffers](booking-time-model.md#buffers-separation-and-operational-time); `turnover`, `place`, `unit` or `facility`, what a shared facility's buffers apply to, [shared facilities](booking-time-model.md#shared-facilities-how-they-are-turned-over)): set or clear (null) rules at that level (managers; the business level needs the owner or a manager of the business); recorded |
| GET | `/api/admin/storefronts` | Every storefront: domain, name, look and venues (platform owner) |
| POST | `/api/admin/storefronts` | Create, or with `id` update: `{ id?, hostname, name, tagline?, accentColor?, logoUrl?, venueIds }` |
| DELETE | `/api/admin/storefronts` | `?id=` |
| POST | `/api/admin/strikes` | `{ venueId, phone }`: this number's strikes here stop counting |
| POST | `/api/admin/suspensions` | `{ venueId \| businessId, action: "suspend" \| "lift", reason? }` — the platform owner taking a venue or a whole business off the marketplace, or putting it back |
| GET | `/api/admin/system` | What has gone wrong lately, for the platform owner |
| GET | `/api/admin/integrity` | Platform owner: do bookings and the court time they hold agree, now? → `{ok, problems}` ([monitoring](../operations/monitoring.md)) |
| GET | `/api/admin/activities` | `?venueId` → the activities that venue may offer, its own included; the platform owner may leave it out for the whole catalogue |
| POST | `/api/admin/activities` | `{venueId, names: {en, ms?, zh?, ta?}, category, model, noun, icon?, aliases?, capacity?, perPlayer?, maxPlayers?}`: a venue's or business's own activity (managers; the platform owner adds to the catalogue); recorded |
| PATCH | `/api/admin/activities` | `{key, …}`: change or retire (`active: false`) one's own activity; built-ins can only be retired, by the platform owner; recorded |
| GET | `/api/admin/sign-offs` | `?venueId` → sign-offs in force ([activities](../features/activities.md#sign-offs)) |
| POST | `/api/admin/sign-offs` | `{venueId, sport?, phone, name, email?, kind?: "operational" \| "certification", reference?, note?, expiresOn?, wholeBusiness?}`: record one (replacing one for the same number, activity, kind and scope); a certification needs `reference` and `expiresOn`; `wholeBusiness` needs whoever runs the business; `email` links the customer's account; front desk is refused one for an activity whose approval is a safety assessment unless delegated for it (403 `APR_SAFETY_AUTHORITY`); recorded |
| DELETE | `/api/admin/sign-offs` | `?venueId&id[&reason]`: take one back, who and why kept; one an approval wrote revokes that approval, its bookings flagged for staff; recorded |
| POST | `/api/admin/system` | `{ key }`: dealt with; the next one is news again |
| GET | `/api/admin/tournaments` | `?venueId=` — a venue's tournaments and competitions, for its staff, with the sport templates and the venue's own |
| POST | `/api/admin/tournaments` | A new tournament, holding its courts at once; `format` knockout, groups, round_robin or performance; `template` and `rules?` (scoring, ranking, points by set score, somebody leaving); `entryKind` and `roster` for teams; `competitionId?` for a division of a competition (its days, hours and courts; `matchMinutes?` its own match length); `stageMinutes?` (`{ group, knockout, final, heat }`), `thirdPlace?`; `resultsBy?` (`staff` or `players`); who may enter: `entriesCloseOn?`, `ageMin?`, `ageMax?`, `membersOnly?` |
| GET | `/api/admin/competitions` | `?venueId=` — a venue's competitions |
| POST | `/api/admin/competitions` | A new competition, holding its courts for its days and hours: `name`, `sport`, `startsOn`, `endsOn`, `startMin`, `endMin`, `matchMinutes`, `courtIds`, `maxDivisionsPerPlayer?` (managers) |
| GET | `/api/admin/competitions/:id` | A competition and its divisions |
| DELETE | `/api/admin/competitions/:id` | Call it off with every division; its courts go back on sale (managers) |
| GET | `/api/admin/tournaments/:id` | One tournament with its entries and draw, the results players reported and are waiting on or dispute (`reports`), and its officials |
| GET | `/api/admin/tournaments/:id/officials` | The officials who may enter its results through a link |
| POST | `/api/admin/tournaments/:id/officials` | `{ name, expiresOn? }` — a link for an official to enter results, returned this once; it works until the last day unless an earlier one is given |
| DELETE | `/api/admin/tournaments/:id/officials/:officialId` | Withdraw an official's link |
| POST | `/api/admin/tournaments/:id` | `{ action: "close" \| "draw" \| "cancel" }`, `{ action: "rules", rules }` before the draw, `{ action: "final", chosen }` (who takes a performance final's last places when level), or `{ action: "save_template", name }` |
| POST | `/api/admin/tournaments/:id/entries/:entryId` | `{ paid?, seed?, checkedIn?, eligibilityChecked?, withdraw?, reason?, note?, preview? }` — staff on one entry (an eligibility check records who checked, never the document); `reason` withdrawn, retired or disqualified (a manager's); `preview: true` says what it would change |
| POST | `/api/admin/tournaments/:id/matches/:matchId` | `{ winner, score?, walkover?, retired?, outOfEvent? }` — a result (`winner: null` a draw, where the rules allow one); `preview: true` says what it would change; `correction: { mode: "replace" \| "standings_only", reason, token }` after the knockout has begun (a manager's); `{ performances: [{ entryId, attempts?, status?, note? }] }` for a heat or a final; `{ move: { courtId, date, startMin, minutes? } }` moves a fixture still to play or changes its length (a manager's), its sides told |
| GET | `/api/admin/tournaments/:id/issues/:issueId` | A progression issue a correction left open: the fixtures it affects, whether it can be replayed and which matches need a court and time, and a token |
| POST | `/api/admin/tournaments/:id/issues/:issueId` | `{ action: "stand" \| "replay", reason, token, slots? }` — resolve it (a manager's): the results as played stand, or the matches are replayed at the courts and times given |
| GET | `/api/admin/venue-applications` | Venues asking to go live, and how many drafts are being set up, for the platform owner alone |
| POST | `/api/admin/venue-applications` | `{ id, decision: "approve" \| "reject", checks?, reason? }`; approving needs every one of REVIEW_CHECKS in `checks` |
| GET | `/api/admin/venue-tax` | `?venueId` → the venue's own tax, the country's usual one to start from, and the treatment of each deduction reason |
| POST | `/api/admin/venue-tax` | `{ venueId, registered, name, rate, regNo }`, or `{ venueId, deductions: { <reason>: true \| false \| null } }` (which reasons for keeping deposit money carry the tax; `null` is the country's usual) |
| GET | `/api/admin/venue-time-zone` | `?venueId` → the venue's time zone, whether staff chose it, and what its pin says |
| POST | `/api/admin/venue-time-zone` | `{ venueId, zone }`: one of the country's zones, or null to follow the map pin |
| GET | `/api/admin/venues/:id/blocked-phones` | Numbers this venue does not take online bookings from |
| POST | `/api/admin/venues/:id/blocked-phones` | `{ phone, reason? }` |
| DELETE | `/api/admin/venues/:id/blocked-phones` | `{ phone }` |
| GET | `/api/admin/venues/:id/payment-settings` | The venue's gateway account as staff may see it: never the keys |
| PUT | `/api/admin/venues/:id/payment-settings` | `{ provider, credentials, sandbox, enabled }` → connect or change the venue's gateway account (managers) |
| DELETE | `/api/admin/venues/:id/payment-settings` | Disconnect the venue's gateway account (managers) |
| GET | `/api/admin/venues/:id/photos` | The venue's photos, cover first |
| POST | `/api/admin/venues/:id/photos` | A photo, as a form upload: `file`, and `caption` if there is one |
| PATCH | `/api/admin/venues/:id/photos/:photoId` | `{ cover: true }`, `{ move: -1 \| 1 }`, or `{ caption }` |
| DELETE | `/api/admin/venues/:id/photos/:photoId` | Remove a photo |
| GET | `/api/admin/waiver` | `?venueId` → the waiver in force and how many have agreed to it |
| POST | `/api/admin/waiver` | `{ venueId, text }`: new words, agreed to afresh; empty for none (managers) |
| POST | `/api/admin/waiver/sign` | `{ bookingId }`: the customer signed the venue's waiver on paper at the desk |
| GET | `/api/admin/whatsapp` | `?venueId=` — whether the venue sends WhatsApp, and what it has left to send with |
| POST | `/api/admin/whatsapp` | `{ venueId, action }`: - `"mode", mode: "off" \| "urgent" \| "all"` — the venue's staff; - `"buy"` — order a pack, then `"pay", packId` to pay it online; - `"grant", messages` / `"markPaid" \| "void", packId` — the platform owner |

### Public API for venues' own systems (key; see [external API](../integrations/external-api.md))

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/v1/availability` | `?date=YYYY-MM-DD[&sport=]` → each court's day: `starts` (minute, longest length), `policy`, and `slots` in columns of `grid` minutes with price, free or `partly`. `unit` is `grid` in hours, what a booking's `hours` are starts of |
| GET | `/api/v1/bookings` | `?from=&to=` (at most 31 days) → the venue's bookings, cancelled ones included |
| POST | `/api/v1/bookings` | `{ courtId, date, start, end \| minutes, name, phone, email? }` (or `hours: [9, 10]` in the court's `unit`) → a booking, as the venue's own system makes it (write keys). The customer is sent the usual confirmation. Unpaid; the venue settles it as any other |
| GET | `/api/v1/bookings/:code` | One of the venue's bookings, by its code |
| POST | `/api/v1/bookings/:code/cancel` | Cancel one of the venue's bookings, as its staff would (write keys). The customer is told |
| GET | `/api/v1/venue` | The key's venue: its details, hours and courts with their rates |

Prices are always computed server-side; the client's displayed total is informational.
