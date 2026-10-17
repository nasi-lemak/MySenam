# MySenam 🏸

**Gelanggang, gim dan kelas — satu tempahan.** An online booking platform for
sports courts (badminton, tennis, pickleball, futsal), shared facilities like gyms and pools,
equipment hire such as kayaks, and instructor-led classes.

## Features

- **Cross-venue search** (`/search`) — pick a sport, day, time window and duration, and see every free court across all venues at once, grouped by venue and cheapest-first; one click deep-links into the venue page with the slot already selected
- **Waitlists** — when a court hour or class is full, customers queue instead; a cancellation offers it to whoever has waited longest, held for 30 minutes before passing on
- **Instructor-led classes** (`/classes`) — schedule a session or a whole weekly term on a shared facility; customers enrol rather than book, the resource is reserved while the class runs, and staff get a live roster showing who has checked in
- **Courts *and* shared facilities** — a resource has a capacity: 1 means exclusive use (a badminton court), more means a gym floor, pool or class where that many people hold the same hour. The booking grid shows places left and colours them by how busy the hour is
- **Live availability grid** — per venue, per sport, per day, with hourly slots inside that venue's own trading hours
- **Peak / off-peak pricing** — weekday evenings (from 6 PM) and weekends charge the peak rate; prices shown per-slot in MYR
- **"Any court"** — a row above the grid for customers who do not mind which court; it shows the cheapest free rate each hour and books the cheapest court free for the whole slot
- **Instant booking** — pick up to 4 consecutive hours, enter name + phone, get a booking code (e.g. `MS-8F3K2A`); pay at the counter
- **Weekly recurring bookings** — repeat the same slot for up to 8 weeks (leagues, training); each session gets its own code plus a shared series code (`SR-…`), clashing weeks can be skipped or fail the whole series, and a series cancels in one action
- **Double-booking proof** — slot uniqueness is enforced at the database level, so concurrent bookings can never collide
- **Memberships and member rates** — each court can carry a member price alongside its public one; a member of that venue is charged it automatically, and sees it on the grid when signed in
- **Promo codes** — a venue advertises a percentage or fixed discount, optionally limited to one sport, a minimum booking length, a date range and a number of uses; customers type the code when booking and it comes off the total
- **Multi-visit passes** — sell a block of entries up front ("10 hours of badminton at PJ"); one entry covers one booked hour, the holder picks the pass on the booking form or quotes its code, and cancelling returns the entries
- **Personal data you can see and remove** — a signed-in customer downloads everything held against their account as one file, or closes the account: upcoming bookings are cancelled and their name comes off past ones, while the hour and the price stay as the venue's accounting record. Old records age out on a published retention schedule that applies itself daily, and a privacy notice at `/privacy` says all of it in plain terms
- **Unstaffed hours** — a venue says when somebody is behind the counter, and a resource says whether it may be used outside that window. Out of hours, a customer who is *inducted* and *paid* is shown the door code an hour before their slot; every reveal is logged against the booking, opening the door counts as checking in, and the entry screen carries the venue's emergency number and who else is inside. Pools can never be left unmanned, and neither can anything hired out against a deposit
- **Equipment hire** — a resource that leaves the building (a kayak, a paddle set) carries a deposit; the desk hands the kit over against it, and the return records condition, any damage note and anything kept back, with the rest given straight back
- **Stored credit** — customers buy credit at any counter and pay for bookings and classes from the balance; cancelling refunds it automatically
- **Customer accounts** — register/sign in (`/login`, scrypt-hashed passwords, HTTP-only session cookies, no external auth service); bookings made while signed in appear on `/account` with upcoming/past views, one-click cancel, and prefilled booking forms
- **Operating hours & closed days** — each venue sets its own opening and closing hour (a pool can open at 7 AM, a club shut at 10 PM); whole days can be closed for a public holiday, a private hire or a refit, which blocks booking, enrolment and waitlist joins for that date and drops the venue out of cross-venue search
- **Cancellation policy** — each venue sets how many hours before a slot customers may still cancel (default 2); the window is shown up front on the venue page and in the booking lookup, and staff can always override from the dashboard
- **Check-in & live crowd levels** — customers scan a QR code on their booking to check themselves in (or the desk does it), and the venue page shows a public *Here right now* panel counting who is actually inside each shared facility, refreshed every 30 seconds
- **No-show tracking** — staff flag a passed booking whose customer never turned up, and the day list warns when that phone number has prior no-shows
- **Self-service management** — no account needed: look up or cancel any booking with the code + phone number (`/my-booking`)
- **Share & export** — WhatsApp share, Google Calendar link and `.ics` download for every confirmed booking
- **Per-venue admin accounts** — operators sign in with email + password; a venue admin only ever sees their own venue's bookings, schedule, courts and revenue, while a platform owner manages every venue, creates venues and issues staff accounts
- **Admin dashboard** (`/admin`) — behind an operator sign-in:
  - **Bookings**: all bookings for any date with expected/collected/outstanding revenue, one-click paid/unpaid toggle (and pay-a-whole-series), check-in/check-out, no-show flagging, handing hire kit out and taking it back in, moving a booking to another court, plus admin cancellation
  - **Court schedule**: per-court hourly grid; click to block slots for maintenance (with a reason) or release them — booked hours can never be blocked
  - **Occupancy**: 7-day utilisation heatmap per court with venue totals
  - **First run**: while nothing has been sold, an owner is offered a demo fortnight in one click, beside a three-step checklist for setting up a real venue. It disappears the moment a real booking exists
  - **Reports**: any period up to 400 days — collected, still owed, how full, cancellations and no-shows; revenue by month, by sport and by court; hours sold by time of day; and what the venue still owes in unspent pass entries and live memberships
  - **Courts & rates**: rename courts, edit peak/off-peak rates, member rates, capacity and the hire deposit, set a resource unmanned with the code that is on its lock, induct people for unstaffed hours or withdraw them, read the door log, add new courts
  - **Classes**: schedule one-off or weekly classes, view the roster and waiting queue, cancel a class (releasing every enrolment)
  - **Credit**: look a customer up by email or phone, see their balance and history, sell them credit
  - **Backups** (owner): every snapshot with its age and size, a warning when the newest is over two days old, and a button to take one before a risky change
  - **Venues & staff**: edit venue details, trading hours, the staffed window, the emergency details shown to anyone letting themselves in, and the cancellation cutoff, and schedule or lift whole-day closures; owners can also add venues and create/remove staff accounts
- **14-day booking window**, Malaysia timezone-aware (past slots on today's date are blocked)

## Tech stack

- [Next.js 15](https://nextjs.org/) (App Router) + React 19 + TypeScript
- [Tailwind CSS 4](https://tailwindcss.com/)
- PostgreSQL — a Postgres server in production (`DATABASE_URL`), and
  [PGlite](https://pglite.dev), Postgres compiled to WebAssembly and run inside
  the app, for development and the tests, so neither needs a server

## Getting started

```bash
npm install
cp .env.example .env.local   # optional: every value has a working default
npm run dev
```

Run the test suite (Vitest; each test file gets its own in-memory PGlite) with:

```bash
npm test
```

and against a real Postgres server — each test file gets a throwaway database
there, dropped when it finishes — with:

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test
```

Open http://localhost:3000. With no `DATABASE_URL` the database is PGlite in
`data/pglite`; it is created, migrated and seeded with four demo venues
(Petaling Jaya, Subang Jaya, Bangsar, Putrajaya) on first request. PGlite is
for development: running Postgres inside the app's own process costs it the
best part of a gigabyte of memory, against about 250 MB with a server. Node 22
is what this is developed against; `.nvmrc` pins it.

Nothing has been *booked* at those venues, though, so every admin tab opens
empty. Sign in at `/admin` and the dashboard offers to fix that: **Load demo
data** writes a plausible fortnight either side of today — bookings across every
sport, a class with a roster, passes, a membership, a promo code, arrivals, a
no-show, a maintenance block and a public holiday. It is deterministic, so the
same install always produces the same fortnight.

The offer appears only while nothing has been sold, and the endpoint behind it
refuses once anything has, so invented customers can never turn up in a working
venue's day list.

### Admin access

`/admin` is protected by operator accounts (scrypt-hashed passwords, HTTP-only
session cookies) held in the `admins` table. On a fresh database the first
platform owner is created automatically:

- Email: `ADMIN_EMAIL`, default `admin@mysenam.my`
- Password: `ADMIN_PASSWORD`, default `mysenam-admin`

**Set both before deploying.** Once signed in, the owner can add venues and
issue staff accounts from the *Venues & staff* tab.

There are two roles:

| Role | `venue_id` | Can do |
| ---- | ---------- | ------ |
| Platform owner | `NULL` | Everything, across every venue; create venues and staff accounts |
| Venue operator | a venue id | Only that venue: its bookings, payments, schedule, courts, occupancy and venue details |

Every admin endpoint checks the scope server-side, so a venue operator gets a
403 for another venue's data even by calling the API directly.

That is enforced by a test rather than by care. `tests/routes.test.ts` globs
**every** route under `/api/admin` and `/api/my`, calls each exported method
with no cookie, and fails on anything that does not answer `401` — so an
endpoint added without `requireAdmin` fails CI without anybody remembering to
write a test for it. On top of that sweep, the venue boundary and the
owner-only routes are checked with real sessions: its own venue `200`, another
venue `403`, a venue operator on a platform-wide route `403`.

Both halves were confirmed to fail when they should: removing one
`denyVenue` call, and adding a new admin route with no auth at all, each turn
the suite red.

## Deploying

Production runs against a Postgres server, version 16 or later:

```bash
npm ci
npm run build
DATABASE_URL=postgres://mysenam:…@127.0.0.1:5432/mysenam npm start
                   # listens on 3000; put a TLS-terminating proxy in front
```

The schema is created on the first start and moved on by every later one: the
files in `db/migrations` are applied in order, each once, under a lock, so two
servers starting together do not both run one.

There are two ready-made ways to run it:

- **A server of your own**: one DigitalOcean Droplet with Postgres, the app and
  Caddy on it, set up by a script and deployed by another. See
  [`deploy/digitalocean/README.md`](deploy/digitalocean/README.md).
- **Render**: a Blueprint per tenant, each with its own Render Postgres. See
  *A venue business's own copy*, below.

### Configuration

Everything is an environment variable; there is nothing else to configure.

| Variable | Default | What it does |
| -------- | ------- | ------------ |
| `MYSENAM_MARKETPLACE` | — | `on` for the shared marketplace: venues apply to join, are invoiced monthly, and stored credit is per venue |
| `MYSENAM_CREDIT_SCOPE` | `platform`, or `venue` on a marketplace | Whose stored credit is — see *Whose credit it is* |
| `MYSENAM_VENUE_FEE` | `0` | On a marketplace, what a venue pays a month unless it has its own fee |
| `MYSENAM_FREE_MONTHS` | `0` | Free months for a newly approved venue before its first invoice |
| `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID`, `BILLPLZ_X_SIGNATURE_KEY`, `BILLPLZ_SANDBOX` | — | The platform's own Billplz account, for venues paying their invoices online. `BILLPLZ_SANDBOX=on` for test payments |
| `OPERATOR_NAME`, `OPERATOR_REG_NO`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` | — | Who runs the site, for the terms at `/terms` |
| `MYSENAM_TRUST_FORWARDED_HOST` | — | `on` only behind a proxy that rewrites Host: read the storefront domain from `X-Forwarded-Host` |
| `SITE_NAME` | `MySenam` | What the site calls itself — the header, page titles, privacy notice, shared links |
| `ADMIN_EMAIL` | `admin@mysenam.my` | The first platform owner, created on a fresh database |
| `ADMIN_PASSWORD` | `mysenam-admin` | **Set this.** The default is in this README |
| `DATABASE_URL` | PGlite in `data/pglite` | `postgres://user:password@host:5432/db` in production. `pglite:/some/folder` or `pglite:memory` for PGlite |
| `DATABASE_POOL_SIZE` | `10` | Connections the app keeps open to the server |
| `MYSENAM_DATA_DIR` | `data/` | The app's own folder: backups, and `secret.key` when `MYSENAM_SECRET` is not set. Put it on a disk that survives a redeploy |
| `MYSENAM_BACKUP_DIR` | `backups/` in the data folder | Where snapshots are written |
| `MYSENAM_BACKUP_KEEP` | `14` | How many snapshots to keep before the oldest are retired |
| `MYSENAM_BACKUP_HOUR` | `3` | The hour, Malaysia time, of the nightly backup |
| `MYSENAM_SCHEDULER` | on in production | `off` to leave nightly backups and message sending to your own cron |
| `OFFSITE_S3_*` | — | Where to copy each backup off the machine; see *Off-site copies* |
| `MYSENAM_URL` | `http://localhost:3000` | Where this install is reachable, for the links inside customer messages |
| `MYSENAM_SEND` | — | `log` writes customer messages to the server log instead of sending them |
| `WHATSAPP_TOKEN` | — | A WhatsApp Cloud API access token. With the next one, sends messages on WhatsApp |
| `WHATSAPP_PHONE_NUMBER_ID` | — | The Cloud API phone number id messages are sent from |
| `WHATSAPP_TEMPLATE_PREFIX` | `mysenam` | Prefix of the approved template names, e.g. `mysenam_booking_confirmed` |
| `WHATSAPP_COUNTRY_CODE` | `60` | Country code put in front of a number typed with a leading 0 |
| `WHATSAPP_API_VERSION` | `v23.0` | Graph API version |
| `SMTP_URL` | — | `smtp://user:pass@host:587` (or `smtps://…:465`). With `MAIL_FROM`, sends email |
| `MAIL_FROM` | — | The sender, e.g. `Arena Bookings <bookings@arena.my>` |
| `MYSENAM_SECRET` | `secret.key` in the data folder | Encrypts stored payment keys. Keep it out of the backups |

`.env.example` lists all of them with comments; copy it to `.env.local`.

On a production start the server warns about a default `ADMIN_PASSWORD` and an
unset backup directory. It warns rather than refuses, because a venue in the
middle of a Saturday does not want its booking system declining to boot.

### Behind a proxy

Two things depend on the proxy being configured properly:

- **Session cookies** are marked `Secure` when the request arrived over HTTPS,
  which is read from the request rather than from a build flag. The proxy must
  set `X-Forwarded-Proto`, or cookies will not carry the flag.
- **Rate limits** identify a client by `X-Forwarded-For`. If the proxy does not
  set it, every request looks like one client and the limits apply to the whole
  internet at once. It must also *replace* what the visitor sent rather than add
  to it, or a visitor can pick their own address. The DigitalOcean kit's
  Caddyfile does both.

`GET /api/health` answers `{"ok":true}` while the database is readable, and
`503` when it is not. It deliberately says nothing else — anything reachable by
the load balancer is reachable by everyone else too.

### Backups

Everything is in one database. Losing it loses every booking, the credit
ledger, and the record of who opened which door.

```bash
npm run backup                       # one snapshot, verified, oldest retired
npm run backup -- --keep 30          # keep more
npm run backup -- --dir /mnt/backups # somewhere else
```

**The server takes one every night by itself**, at 03:00 Malaysia time
(`MYSENAM_BACKUP_HOUR`), and catches up as soon as it is back if it was down at
the hour. Hosts like Render cannot point a cron job at a web service's disk, so
the schedule lives in the app: `next start` ticks once a minute and does what is
due, which also sends any customer messages waiting to go. Set
`MYSENAM_SCHEDULER=off` to run `npm run backup` from your own cron instead —
and do, if more than one server shares the database:

```cron
0 3 * * *  cd /srv/mysenam && /usr/bin/npm run backup >> /var/log/mysenam-backup.log 2>&1
```

On a Postgres server each run is `pg_dump` in its custom format (`.dump`):
consistent while the app keeps serving, and taken with the password passed in
the environment, never on a command line where the process list would show it.
It then **reads the snapshot back**: `pg_restore --list` must find the tables
that hold the business. `pg_dump` has to be installed where the app runs
(`apt install postgresql-client`, at the server's version or newer; the
DigitalOcean kit installs it). On PGlite a snapshot is a copy of its data folder
(`.tar.gz`), loaded into a fresh PGlite and its bookings counted.

Either way, a snapshot that does not verify is deleted rather than kept, and
the script exits non-zero so a failing backup shows up as a failing cron job
instead of a quiet no-op. It is written under a temporary name and renamed on
success, so an interrupted run never leaves a half-file that looks real.

A platform owner can see the same list under *Venues & staff → Backups*, take
one by hand before a risky change, and is told in red when the newest snapshot
is more than two days old. Venue operators cannot: a backup is every venue's
data, not one venue's.

### Off-site copies

Snapshots beside the database survive a bad deploy and a mistyped `DELETE`; they
do not survive the disk. So each one — the nightly one and every *Back up now* —
is also uploaded to object storage that speaks the S3 API: Cloudflare R2,
Backblaze B2, Amazon S3, Wasabi.

| Variable | Example |
| -------- | ------- |
| `OFFSITE_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com` |
| `OFFSITE_S3_BUCKET` | `venue-backups` |
| `OFFSITE_S3_REGION` | `auto` for R2 (the default); the bucket's region for B2 and S3 |
| `OFFSITE_S3_ACCESS_KEY_ID` / `OFFSITE_S3_SECRET_ACCESS_KEY` | A key for that bucket |
| `OFFSITE_S3_PREFIX` | `mysenam/` (the default) — one bucket can hold several installs |

The upload is streamed from disk and signed over the file's SHA-256, so the
storage service itself rejects a copy that arrived damaged. The Backups panel
shows the last copy, and in red the last failure, so an upload that has been
failing quietly is visible long before the day it is needed.

**Nothing off-site is ever deleted by the app.** Set a lifecycle rule on the
bucket to expire old copies (30 days is plenty), and give the app a key that
may only *write* to the bucket. Then somebody who takes over the server cannot
reach back and delete the copies that would undo the damage.

The backups hold customers' names and phone numbers: keep the bucket private.
Venues' payment keys inside are encrypted, and the key that unlocks them
(`secret.key`, or `MYSENAM_SECRET`) is deliberately not in the backup.

### Restoring

```bash
# Stop the app first.
npm run restore -- /var/lib/mysenam/backups/mysenam-2026-09-26-030000.dump --force
```

The script refuses a file that is not a backup it could restore, prints what it
is about to replace, and does nothing at all without `--force`. A `.dump` goes
back into the server in `DATABASE_URL` with `pg_restore`, in one transaction:
all of it or none of it. Before it touches anything it takes a fresh snapshot
of what is there, and a PGlite folder it replaces is moved aside rather than
deleted, because the worst restore is the one that turns out to have used the
wrong file.

### Upgrading

Migrations run when the app starts, so a deploy is build, restart, done.
**Take a backup first** (`npm run backup`), because a migration cannot be undone
from inside the app. The DigitalOcean kit's deploy script takes one with the
live version, just before it switches to the new one, and puts the old version
back if the new one does not answer.

### Moving from SQLite

Before Postgres, an install kept everything in one SQLite file
(`data/mysenam.db`, or wherever `MYSENAM_DB` pointed). Started on this version,
such an install **refuses to start**, and says why, rather than open a new,
empty database beside the old one and look to its staff as if everything had
gone. To bring it across:

1. Stop the old app, so nothing is written to the file halfway through.
2. Set `DATABASE_URL` (and `MYSENAM_DATA_DIR`), and remove `MYSENAM_DB`.
3. Run:

   ```bash
   npm run import-sqlite -- /var/data/mysenam.db
   ```

It copies every table, keeping every id, so booking codes, links and the ledger
still line up. It runs as one transaction, so if anything does not fit, nothing
is changed. Then it counts every table on both sides. Saved payment keys are
locked with the old install's `secret.key`, so that is brought across from
beside the file too, unless `MYSENAM_SECRET` is set, in which case it must hold
the old value. It refuses a database that already has customers, bookings or
staff of its own unless told `--force`, which wipes them first.

### Running the marketplace

With `MYSENAM_MARKETPLACE=on`, the install is the shared MySenam marketplace:
independent venues, players booking across them.

- **Venues apply** at `/list-your-venue` (linked from the footer): their
  details, and a password for their first operator account, held hashed. The
  platform owner approves or turns them down under *Venues & staff → Venue
  applications*. Approving makes the venue and the operator's account in one
  step; nobody sends anybody a password. With email set up, the applicant is
  told either way; without it, the panel says who to tell.
- **Stored credit is per venue** — see *Whose credit it is*.
- **Venues are invoiced monthly.** Each pays `MYSENAM_VENUE_FEE` a month, or
  its own fee, from the date billing starts — set on approval, after
  `MYSENAM_FREE_MONTHS`. Every full month from then is invoiced once, on the
  first; a venue joining on the 16th has the rest of that month free, and
  nothing is prorated or back-billed. Venues that predate billing are not
  billed until the owner gives them a start date. Invoices are due in 14 days.
  Venue staff see theirs under *Venues & staff → Billing* and can pay online
  into **the platform's own Billplz account** (`BILLPLZ_*`), which is never a
  venue's: this is the platform's income. The owner sets each venue's fee and
  start date there, and marks a bank transfer paid or voids an invoice. Nothing
  is switched off automatically for an unpaid invoice — the panel shows what is
  overdue, and what to do about it is a conversation.
- **Terms** live at `/terms`, for players and, on a marketplace, for venues.
  They are a starting draft written to match what the software does — who
  holds the money, who refunds it, whose credit is whose — and **not legal
  advice: have a Malaysian lawyer review them before relying on them.** Set
  `OPERATOR_NAME`, `OPERATOR_REG_NO`, `OPERATOR_ADDRESS` and `OPERATOR_EMAIL`;
  until `OPERATOR_NAME` is set the page says it has not been completed.

### Storefront domains

A marketplace venue can have its own website on the same server: `abc.com`
shows ABC's venues, under ABC's name, tagline, logo and colour, and nothing
else. The platform owner sets one up under *Venues & staff → Storefront
domains* — the domain, the name, and which venues it shows — and then:

- **on a server of its own** (the DigitalOcean kit), points the domain's A
  record at the server. Caddy gets the certificate on the first visit, once it
  has asked the app (`/api/tls-check`) and been told the domain is a registered
  storefront, so nobody can point domains of their own at the box and have it
  request certificates for them;
- **on Render**, adds the domain to the service (*Settings → Custom Domains*;
  Render issues the certificate, but check its per-service limit if you expect
  many), and points the domain's DNS where Render says.

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
itself. Render passes Host through as it is, so leave it off there.

### A venue business's own copy

The same code runs as the shared MySenam marketplace and as one business's own
booking site under its own name. An own copy is a separate install with its
own database, so its customers, credit and money never sit beside anybody
else's; its owner signs in as the platform owner and sees every one of their
branches, and only theirs.

On Render, each copy is a Blueprint made from its own file:

```bash
npm run new-tenant -- arena "Arena Sports Booking"
git add deploy/render/arena.yaml && git commit -m "Add Arena" && git push
```

Then in Render: **New → Blueprint**, this repository, Blueprint path
`deploy/render/arena.yaml`. Render asks for the admin email and password and
the site's URL, and sets up the service with its own Render Postgres
(`basic-256mb`; the free plan is deleted after 30 days), a 1 GB disk for the
nightly backups, and a generated `MYSENAM_SECRET`. Each tenant gets its own file because a
Blueprint applies itself to any existing service of the same name: two tenants
sharing one file would be one service, overwritten.

Every copy deploys from the same branch, so one push updates them all. Each
restarts on deploy (a service with a disk runs as one instance), so push
outside opening hours.

### What one box gives you

Postgres takes any number of writers. Every path that checks and then writes
(a court's last free hour, a wallet balance, a pass entry, a class's last
place) runs in one serializable transaction, retried when two collide, and
`tests/concurrency.test.ts` fires each of them several times at once and counts
what got through. So more than one app instance can share a database. Two
things still live in each process: rate-limit counters, so several instances
each keep their own (that wants Redis with the same policies); and the
scheduler, so with several instances set `MYSENAM_SCHEDULER=off` on all but
one.

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
| GET    | `/api/my/bookings`        | The signed-in user's bookings                   |
| GET    | `/api/my/wallet`          | Credit balance and recent movements             |
| GET    | `/api/my/passes`          | The signed-in customer's multi-visit passes     |
| GET    | `/api/my/membership`      | The signed-in customer's memberships            |
| GET    | `/api/my/waitlist`        | Classes you are queuing for, and any live offer |
| GET    | `/api/my/data`            | Everything held against this account, as a file |
| POST   | `/api/my/erase`           | `{confirm:"DELETE"}` → close the account        |
| POST   | `/api/my/bookings/cancel` | `{bookingId}` → cancel own booking              |

Admin endpoints (all require an admin session cookie; venue-scoped unless noted):

| Method | Path                          | Description                                          |
| ------ | ----------------------------- | ---------------------------------------------------- |
| POST   | `/api/admin/auth/login`       | `{email, password}` → admin session                  |
| POST   | `/api/admin/auth/logout`      | Ends the admin session                               |
| GET    | `/api/admin/auth/me`          | Current admin + the venues they may manage           |
| GET    | `/api/admin/bookings`         | `?date=` → bookings + expected/collected/outstanding |
| POST   | `/api/admin/bookings/cancel`  | `{code}` → cancel any booking (no phone check)       |
| GET    | `/api/admin/bookings/move`    | `?code=` → courts this booking could move to         |
| POST   | `/api/admin/bookings/move`    | `{code, courtId}` → move it, keeping code and payment |
| POST   | `/api/admin/payments`         | `{code, paid}` or `{seriesCode}` → payment tracking  |
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
    db.ts             # Postgres (server or PGlite), migrations + seed data
    store.ts          # All queries & booking/cancel/block logic
    auth.ts           # Accounts: scrypt passwords + session cookies
    admin-auth.ts     # Operator accounts, sessions and venue scoping
    booking-links.ts  # WhatsApp / Google Calendar / .ics helpers
    backup.ts         # Verified pg_dump / PGlite snapshots, retention, staleness
    reports.ts        # Period reporting: revenue, utilisation, liabilities
    privacy.ts        # Export, erasure and the retention schedule
    demo.ts           # A deterministic demo fortnight for an empty install
    rate-limit.ts     # Fixed-window limiter for password and code endpoints
    time.ts           # Malaysia-timezone helpers, peak-hour rules
    types.ts          # Shared types & constants
db/migrations/        # The schema, one numbered .sql file per change
scripts/              # backup, restore, and import-sqlite for moving off SQLite
deploy/               # digitalocean/ (one server, set up by a script), render/
vitest.config.mts     # Resolves the @/ alias, so tests can call route handlers
tests/                # Vitest suite (booking rules, blocks, series, search,
                      # payments, customer auth, admin scoping, equipment hire,
                      # unstaffed hours, inductions, backups, reporting,
                      # export, erasure, retention, route authorisation)
```

## Taking some of a shared facility out of service

A court is blocked whole — blocking it *is* taking the unit out, because a
court is capacity 1. Equipment is where that breaks down: one kayak of six
with a cracked hull should not cost you the other five, and dropping `capacity`
to 5 would apply to every date rather than just the week it is being repaired.

`slot_blocks` therefore carries a `places` column. `NULL` is the whole
resource, which is the only thing a court can mean and exactly what every
pre-existing row already meant. A number takes that many places out and leaves
the rest bookable, so the hour reads `1/5` rather than closed.

Everything that consults a block resolves it the same way — `COALESCE(places,
capacity)` — so availability, cross-venue search, "any court", booking, moving
a booking, the waitlist and the staff schedule all compare `booked + out`
against capacity instead of asking whether a block exists. A partial block
therefore only closes an hour once it has taken the last place, and only then
does queuing become possible.

Staff cannot take out more places than are free, since that would strand a
booking; the refusal names how many remain. Re-blocking an hour revises it
rather than duplicating it. The occupancy report counts only full blocks, since
a partial one does not remove an hour from the day.

## Resources nobody is standing next to

Unstaffed gyms are a proven model — Anytime Fitness, Snap, Jetts, chocoZAP —
and what makes them work is not an absence of staff but a specific stack:
staffed hours daily, an induction in person before out-of-hours access, a
credential tied to one identity, cameras, a duress button, and equipment chosen
for use with nobody watching. MySenam models the parts of that stack that are
software.

**Two dials, not one.** A **venue** says when somebody is behind the counter
(`staffed_from`/`staffed_to`; both `NULL` means always, equal values mean
never). A **resource** says whether it may be used outside that window
(`unmanned`). The same gym floor is staffed at 10 AM and unstaffed at midnight,
which is how these places really run, and a centre can leave its courts
unattended overnight while the kayak counter keeps someone on it.

Two combinations are refused outright, whatever a venue asks for:

- **Swimming** (`NEVER_UNMANNED`). Drowning is silent and fast, which is why
  the 24-hour chains sell gym floors and not lap pools.
- **Anything hired out against a deposit.** There is nobody to hold the money
  and nobody to look at the hull when it comes back.

**MySenam does not open the door.** It relays a code that staff have programmed
into the lock, and the lock stays the source of truth. Generating or rotating a
code here would be worse than useless: the lock would not know about it, and
the court would be unopenable by the one person entitled to be inside. Staff
type in what they set; MySenam stamps when it changed and nags after
`ACCESS_CODE_STALE_DAYS`.

**MySenam does not open the door.** It relays a code that staff have programmed
into the lock, and the lock stays the source of truth. Generating or rotating a
code here would be worse than useless: the lock would not know about it, and
the court would be unopenable by the one person entitled to be inside. Staff
type in what they set; MySenam stamps when it changed and nags after
`ACCESS_CODE_STALE_DAYS`.

Who gets the code, and when:

| Condition | Why |
| --------- | --- |
| The resource is unmanned and has a code | Otherwise there is nothing to give, and the customer is told someone will let them in |
| The booked hour is **unstaffed** | During staffed hours the counter does this, and a code handed out then is a code in circulation for no reason |
| The customer has been **inducted** at that venue | Nobody is there to show a stranger where the emergency button is, so it has to have happened already, in person |
| The booking is not cancelled | — |
| **The booking is paid** | Nobody is on site to take payment, so the door is the till. An unpaid booking still holds its slot; the code appears the moment staff or a payment marks it paid |
| Inside the check-in window | The same hour before the slot that check-in already uses |
| Before the slot ends | — |

Each refusal carries its own `reason`, so the customer is told what to do about
it rather than getting a flat no.

**Inductions** are the part that turns unstaffed hours from reckless into
insurable, so they are recorded by a named operator and can never be
self-declared: `POST /api/admin/inductions` takes the admin from the session,
not the body. One row per person per venue, revived rather than duplicated if
access is withdrawn and later restored, matched on a normalised phone number so
`+60 12-345 6789` and `012-345 6789` are the same person. Withdrawing access
shuts the door on the next request.

Four consequences worth stating plainly:

- **Every reveal is written down**, one row per look, with the booking, name and
  phone behind it. When a court is found in a state on Tuesday night, "who had
  the code" is the whole investigation — so the log is append-only and the
  venue's staff can read it from the Courts tab.
- **Opening the door is the arrival.** The reveal checks the customer in, so
  *Here right now* stays honest and no-shows stay meaningful with nobody at a
  desk to press a button.
- **The entry screen carries the emergency details.** The venue's out-of-hours
  number and whatever it wants people to know — where the AED is, the nearest
  clinic — plus how many people are checked in right now, so somebody letting
  themselves into an empty building at 2 AM knows they are on their own. It is
  the one screen you know they are looking at while standing inside.
- **The code never travels with the court.** `Court` is served by the public
  `/api/venues` and availability routes, so it carries `unmanned` but never the
  code itself; the code is only ever read through an admin route or handed to
  one authenticated customer, with `Cache-Control: no-store`. Asking for it is
  a `POST` for the same reason — it writes a log line, and has no business in a
  browser history or a proxy log.

The customer-facing reveal is rate limited to 10 per 10 minutes per IP, tighter
than an ordinary booking lookup, because a booking code plus a phone number is
now a door.

## Personal data

Malaysia's PDPA gives a person the right to see what is held about them and to
have it removed, and expects data to be kept no longer than its purpose needs.
Three obligations, three functions in `lib/privacy.ts`: **export**, **erasure**,
**retention**.

### A phone number is not identity

This is the constraint everything else follows from. Nothing in MySenam
verifies a phone number, so anybody can register an account claiming any
number. Keying "your data" on the phone number would therefore mean:

- **registering with a stranger's number dumps their booking history**, and
- **closing that account cancels the stranger's upcoming courts.**

Both were live in the first cut of this feature and were caught by testing it
against real data, where a demo number turned out to be shared by three
walk-ins. Export and erasure now follow `user_id` and nothing else.

The same rule was later found still broken on the account page, which listed
passes and memberships by matching the phone number on the account against the
one a pass was sold to. Registering with somebody else's number showed you
their pass codes, and a pass code is bearer money — paying with one asks for
the code and a booking in that name, both of which the stranger would then
have. Those lists are keyed on the account now.

That leaves a real question the counter has to answer: a pass sold across a
desk has no account on it. Staff can add one at the point of sale — there is an
"account email (optional)" field on both forms — and email is the right key
because an account is identified by it, exactly one account can hold it, and
the person is standing there to say it. A pass with no account on it simply
does not appear on anybody's page, and the page says so rather than implying
nothing was sold.

Memberships are different on purpose. A membership is held against the phone
number so that a member who books as a guest, without signing in, still gets
their price — which also means anybody who types that number gets the member
rate. That is a discount the venue chose to make easy to claim, not a hole; it
costs the difference between two rates, and it is pinned by a test so that
changing it is a decision rather than an accident.

### Erasure keeps the books

A booking is also the venue's accounting record, so "forget me" cannot mean
"make the takings disappear". Closing an account:

- cancels upcoming bookings made from it, releasing the courts;
- replaces the name, phone and email on every booking it owns with `(removed)`,
  **keeping the hour and the price**;
- strips the holder from spent passes and lapsed memberships;
- deletes the account and its sessions.

It refuses while the customer is owed something — stored credit, a live pass, a
running membership — because `wallet_entries` cascades from `users`, so erasing
the account would destroy the only record of whose money the venue is holding.

### Retention

| What | Kept | Then |
| ---- | ---- | ---- |
| Door codes shown | 180 days | deleted |
| Arrivals at the desk | 365 days | deleted |
| Settled waiting-list entries | 90 days | deleted |
| Names and numbers on bookings | 730 days | anonymised, money kept |
| Withdrawn out-of-hours access | 365 days | deleted |
| Expired sessions | — | deleted |

Door logs go first and shortest: they tie a named person to a time and a
building, which is the most sensitive thing here and the least useful once an
incident window has passed.

There is no scheduler in this system, so the policy applies itself the first
time anyone opens the dashboard each day — a venue nobody opens is a venue
accumulating nothing either. An owner can see what is due, when it last ran, and
run it early, under *Venues & staff → Keeping nothing too long*.

**`/privacy` is not legal advice.** It describes what the software actually
does, which is the hard part, but PDPA expects the notice in Bahasa Malaysia as
well as English and expects a named person to write to. Add both, and have a
lawyer read it, before taking a real customer's booking.

## Reporting

The daily dashboard answers *what is happening today*. A venue owner asks a
different set of questions once a month, and before this they could only be
answered by exporting the database.

Everything is keyed on the date the slot was **played**, not the date the
booking was taken, because that is how an operator thinks about a month.

- **Revenue** is split into *booked* and *collected*, so the gap between them is
  the number a venue chases. Cancellations are counted as their own figure
  rather than folded into revenue: a thin month should read as either "we sold
  less" or "they cancelled", never an ambiguous total.
- **Utilisation** measures against hours that could *actually* have been sold —
  the trading day times capacity, less whole-day closures and any places staff
  took out of service. Marking a court out for maintenance should not make the
  venue look idle.
- **Hours sold by time of day** is the one chart that changes a decision:
  it shows where peak really is, which is a question about the peak rate.
- **Utilisation is reported twice**, for exclusive courts and for shared floors
  and pools, never blended. A forty-place gym offers more place-hours in a
  fortnight than every court in the building put together, so one combined
  figure lets the gym decide the headline and teaches an owner nothing about
  either. The demo data is what made that obvious: courts read 13% while the
  building read 2%.
- **What you still owe** is the part a spreadsheet usually misses. Unspent pass
  entries are hours already paid for that somebody can still walk in and take,
  and lapsing memberships are next month's renewals. Stored credit is shown to
  the platform owner only, because credit is bought at one counter and
  spendable at any — the platform owes it, not the venue that sold it.

Two colours carry the whole tab and mean one thing each: teal is money in hand,
amber is money still owed. The pair is checked for colour-vision separation and
contrast rather than chosen by eye, both are direct-labelled and legended, and
every figure is also available as a number, so nothing is readable by colour
alone.

## Equipment hire and deposits

Most resources stay where they are: you cannot walk off with a badminton court.
A kayak is different. It goes out on the water, it can come back damaged, and
the venue holds something against that — usually cash or a card imprint at the
desk, handed straight back when the hull is.

A court carries a `deposit`. `0`, the default and the only sensible value for
anything fixed, means the resource is not handed over at all and no hire
appears anywhere in the flow. Above zero turns on the counter workflow:

- **Handing over** records the deposit held against that booking and checks the
  customer in, since those are one action at the desk. The check-in window
  applies unchanged, so kit cannot leave an hour before the slot it belongs to.
  Staff may override the amount, including waiving it — the record is worth
  keeping either way, because the kayak is out.
- **Taking it back** records the condition (fine, damaged, not returned),
  anything kept back out of the hold, and a note. Nothing can be kept back that
  was not held, and anything short of a clean return needs a note: the customer
  is about to be told why they are not getting all of their money, and
  "damaged" on its own is not a reason that stands up a week later.
- **While kit is out** the booking cannot be cancelled or moved, by staff or by
  the customer, and the venue cannot switch the deposit off on that resource.
  All three would quietly destroy the only record of what is out and what is
  being held against it.

The deposit is deliberately *not* a wallet movement. Stored credit is money the
venue owes the customer against future bookings; a deposit is a hold at the
counter that mostly ends up handed back untouched. Modelling it as credit would
put both in the same balance and make a refund look like a top-up. `hire_records`
therefore tracks the state of the hold — taken, returned, how much was kept and
why — and leaves the ledger alone.

Customers see the deposit before they commit: on the grid row, on the booking
panel and on the confirmation, phrased as what it is rather than as a charge.

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

## Memberships and member rates

Every court carries an optional **member rate** beside its public one, per
band: `member_off_peak_rate` and `member_peak_rate`. `NULL` means members pay
the public price on that court, so a venue can discount its quiet courts and
not its premium one. A member rate above the public rate is refused — that is
not a member rate.

A **membership** belongs to one venue and is held against a **phone number**,
not an account. That is the point: a member who books as a guest, without
signing in, still gets their price. Terms may not overlap at one venue, since
two live memberships would make "which rate?" ambiguous.

Price is decided per session against **that session's date**, not today's, so a
weekly series is discounted for the weeks the membership covers and charged
publicly for the rest. A membership that has not started yet, has expired, or
was cancelled gives nothing.

A signed-in member sees **their own rates on the availability grid**, with a
banner saying so, rather than a public price they will not pay. Guests see
public rates and still get the member rate applied at booking when their number
matches.

Member rates and promo codes compose: the member rate sets the price, and a
promo code discounts that. A member on a RM10/hr member rate booking two hours
with a 20% code pays RM16.

Cancelling a membership stops future discounts; bookings already made keep the
price they were given.

## Promo codes

A venue advertises a code — `RAYA20` for 20% off, `NEWBIE5` for RM5 — and a
customer types it when booking. A code is scoped to one venue, optionally to
one sport, to bookings of at least N hours (which is how a bulk discount is
expressed), to a date range the **booking** must fall in, and to a number of
uses.

The discount comes off `bookings.total_price` itself, inside the transaction
that records the use. That ordering is the point: paying from credit or with a
pass happens afterwards and reads the discounted figure, and the day's takings
are right without any of that code knowing promo codes exist. Claiming a code
is best-effort in the same way as paying — a code that ran out between the
customer typing it and pressing Book leaves the booking standing at full price
with the reason, rather than losing the booking.

Uses are counted as rows in `promo_uses`, one per booking, re-counted **inside**
the claiming transaction so two customers cannot both take the last use of a
limited code. A `UNIQUE (booking_id)` stops two codes stacking on one booking.
Cancelling gives the use back — the customer never had the benefit, so a limited
code should not be poorer for it — through the same `refundBooking()` helper
that returns credit and pass entries, so every cancellation path is covered.

Withdrawing a code stops further claims; discounts already given stand. A
percentage is rounded **down** and no discount ever exceeds the price, so a
total cannot go negative.

## Multi-visit passes

A pass is a block of entries bought up front — the classic "10 sessions" a
Malaysian sports centre sells over the counter. **One entry covers one booked
hour**, so a 2-hour booking spends two. That keeps a pass worth exactly what it
replaces, rather than making a 4-hour block the same price as a 1-hour one.

Entries are an append-only ledger (`pass_entries`), the same shape as the credit
wallet: `remaining = entries + SUM(delta)`, spends negative and refunds
positive. Nothing ever rewrites a running total, so the history is the balance.

A pass pays for a booking only when every one of these holds, and the entry
count is re-read **inside** the paying transaction so two concurrent bookings
cannot spend the same entry:

- the pass is active, in date (`expires_on` is inclusive) and has entries left;
- the booking is at the pass's venue, and for its sport if it names one;
- the booking's phone number matches the holder's. Malaysian numbers are
  compared on digits with the country code folded away, so `+60 12-345 6789`
  and `012-345 6789` are the same person;
- enough entries remain for the whole booking. A pass pays in full or not at
  all — there is no part-paying a slot and owing the rest.

Payment is best-effort, like paying from credit: a pass that cannot cover the
booking leaves it standing as **unpaid** with the reason, rather than throwing
the booking away. Cancelling a pass-paid booking returns its entries through
every cancellation path — by code, from an account, a whole series, an admin
cancellation, and the enrolments released when a class is cancelled — and
refunding twice is refused, so a double cancellation cannot mint entries. An
expired pass is still credited: the ledger stays honest even when the entries
can no longer be spent.

Voiding a pass stops further spending but leaves spent entries spent; it is not
a refund. Customers see their passes with a used/remaining meter on `/account`,
and staff sell and cancel them from the *Credit & passes* tab.

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

### Whose credit it is

`MYSENAM_CREDIT_SCOPE` decides who owes the money customers have put on
account:

- **`platform`** (the default for a single business's own copy) — bought at any
  counter, spendable at any venue. The install owes it, which is right when
  every venue is one business's branch.
- **`venue`** (the default with `MYSENAM_MARKETPLACE=on`) — bought at a venue,
  spendable only there, owed by that venue and shown on its own report. A
  platform holding money strangers paid to other businesses is running a
  payments business, which in Malaysia may need a licence; this keeps each
  venue's customers' money with that venue. It is not legal advice — ask a
  lawyer before taking any money on behalf of venues.

Switching from `platform` to `venue` shrinks nobody's balance: credit bought
before the switch stays spendable anywhere. A booking is paid from the venue's
own credit first and then from that older pot, a ledger line for each, and a
refund puts each line back where it came from.

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

## Messages to customers

Confirmations, cancellations, class enrolments and waitlist offers are written
to an outbox the moment the thing happens, then sent separately and retried
with backoff — a mail server being down delays a confirmation; it never loses
the court. Staff see every message, and why one failed, under *Venues*.

Nothing leaves the machine until a channel is configured:

- **WhatsApp** (`WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`) is the first
  choice, because everybody books with a phone number.
- **Email** (`SMTP_URL` + `MAIL_FROM`) works with any SMTP account — Gmail,
  Zoho, Brevo, Amazon SES. With email alone, anyone who gave an address is
  emailed; somebody who gave only a phone number has their message kept, and
  the dashboard says it is waiting for WhatsApp.
- Neither: messages queue, and the dashboard says so.

Numbers are sent the way WhatsApp wants them, whatever was typed:
`012-345 6789` becomes `60123456789`.

### Setting up WhatsApp

WhatsApp only lets a business start a conversation with a **template Meta has
approved**. Each kind of message is one template, written from the same phrase
the email is, and what fills it is sent as its parameters.

1. In [Meta for Developers](https://developers.facebook.com/), create an app
   with the WhatsApp product, add the venue's number, and create a permanent
   access token for a system user. Its token is `WHATSAPP_TOKEN`; the number's
   *Phone number ID* is `WHATSAPP_PHONE_NUMBER_ID`.
2. In WhatsApp Manager, create the five templates below, category **Utility**,
   each with an English (`en`) and a Malay (`ms`) translation, the body exactly
   as given. The name must match, prefix included.
3. Wait for approval, then set the two variables. Anything that failed while
   waiting can be retried from the dashboard.

If the wording of a message changes, the template has to be resubmitted: the
test suite fails when this README and the code disagree, and the text below is
what to paste.

#### `mysenam_booking_confirmed`

English (`en`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} total, {{6}} link

```text
Hi {{1}}, your booking is confirmed.

Code: {{2}}
{{3}}
{{4}}
Total: {{5}}

Show the code at the front desk. To see, pay or cancel it, open {{6}} and enter the code.
```

Malay (`ms`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} total, {{6}} link

```text
Hai {{1}}, tempahan anda telah disahkan.

Kod: {{2}}
{{3}}
{{4}}
Jumlah: {{5}}

Tunjukkan kod ini di kaunter hadapan. Untuk melihat, membayar atau membatalkannya, buka {{6}} dan masukkan kod ini.
```

#### `mysenam_booking_series_confirmed`

English (`en`) — {{1}} name, {{2}} code, {{3}} where, {{4}} weeks, {{5}} when, {{6}} total, {{7}} link

```text
Hi {{1}}, your weekly sessions are booked.

Series code: {{2}}
{{3}}
{{4}} weeks from {{5}}
Total: {{6}}

Show the code at the front desk. To see, pay or cancel, open {{7}} and enter the series code.
```

Malay (`ms`) — {{1}} name, {{2}} code, {{3}} where, {{4}} weeks, {{5}} when, {{6}} total, {{7}} link

```text
Hai {{1}}, sesi mingguan anda telah ditempah.

Kod siri: {{2}}
{{3}}
{{4}} minggu bermula {{5}}
Jumlah: {{6}}

Tunjukkan kod ini di kaunter hadapan. Untuk melihat, membayar atau membatalkan, buka {{7}} dan masukkan kod siri.
```

#### `mysenam_booking_cancelled`

English (`en`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when

```text
Hi {{1}}, booking {{2}} has been cancelled.

{{3}}
{{4}}

The slot is free again. Nothing is owed for it.
```

Malay (`ms`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when

```text
Hai {{1}}, tempahan {{2}} telah dibatalkan.

{{3}}
{{4}}

Waktu itu kosong semula. Tiada apa-apa yang perlu dibayar untuknya.
```

#### `mysenam_waitlist_offer`

English (`en`) — {{1}} name, {{2}} what, {{3}} venue, {{4}} date, {{5}} from, {{6}} link

```text
Hi {{1}}, a place has opened up for {{2}} at {{3}}, {{4}} {{5}}.

It is held for you for a short while, and then goes to the next person waiting. Claim it at {{6}} while it is yours.
```

Malay (`ms`) — {{1}} name, {{2}} what, {{3}} venue, {{4}} date, {{5}} from, {{6}} link

```text
Hai {{1}}, ada tempat kosong untuk {{2}} di {{3}}, {{4}} {{5}}.

Ia ditahan untuk anda seketika sahaja, kemudian diberikan kepada orang seterusnya dalam giliran. Tuntut di {{6}} selagi ia milik anda.
```

#### `mysenam_class_enrolled`

English (`en`) — {{1}} name, {{2}} what, {{3}} instructor, {{4}} code, {{5}} venue, {{6}} when, {{7}} total

```text
Hi {{1}}, you are enrolled in {{2}} with {{3}}.

Code: {{4}}
{{5}}
{{6}}
Total: {{7}}

Show the code at the front desk.
```

Malay (`ms`) — {{1}} name, {{2}} what, {{3}} instructor, {{4}} code, {{5}} venue, {{6}} when, {{7}} total

```text
Hai {{1}}, anda telah berdaftar dalam {{2}} bersama {{3}}.

Kod: {{4}}
{{5}}
{{6}}
Jumlah: {{7}}

Tunjukkan kod ini di kaunter hadapan.
```

## Payments

Every booking starts `unpaid` and stands whether or not it is ever paid
online. Front-desk staff toggle it to `paid` from the admin Bookings tab (a
whole recurring series can be settled in one click). Customers see the payment
state on `/account` and in the `/my-booking` lookup. The daily view splits
**expected** vs **collected** vs **outstanding** revenue so a shift can be
reconciled at closing.

### Paying online

A venue can let customers pay by FPX online banking or card through
[Billplz](https://www.billplz.com), **into the venue's own Billplz account**.
The platform never holds a customer's money, which is the difference between
running booking software and running a payments business.

- **Set up** under *Venues & staff → Online payment*: the venue's Billplz
  collection ID, API secret key and X Signature key, and whether it is a
  sandbox account. Nothing needs configuring on the Billplz side — each bill
  says where to report back, which is why `MYSENAM_URL` must be the install's
  public `https://` address.
- **Paying** — a *Pay online* button appears on the booking confirmation, on
  `/my-booking`, and the confirmation message says the booking can be paid
  online. A weekly series is paid in one bill; weeks already settled are left
  out. Pressing the button twice sends the customer to the same bill.
- **Marked paid** only when Billplz says so, in a callback or the customer's
  redirect back, and only after its signature checks out under that venue's
  key. Either can arrive first; both are safe to repeat. The Bookings tab shows
  these as `✓ online`, which cannot be toggled off by mistake: that money is in
  Billplz, not the till.
- **Refunds** — a booking paid online and then cancelled, or paid at the counter
  as well, is listed under *Refunds owed* with who to pay back. Refund it in
  Billplz, then mark it done.

The keys are encrypted in the database, which is the file that gets backed up
and copied off the machine. The key that unlocks them is `MYSENAM_SECRET`, or,
when that is unset, one generated into `secret.key` in the data folder —
never in the database. A backup restored onto another machine without that key asks
for the venue's payment keys to be entered again instead of handing them over.

## Booking without naming a court

Courts are chosen cinema-seat style: the grid is a row per court, and tapping a
cell books that court. Courts genuinely differ — a premium court costs more, and
regulars have preferences — so auto-assigning by default would take a real
choice away and make the price column meaningless.

For customers who *don't* mind, an **Any court** row sits above the grid. Each
hour shows the cheapest rate among the courts free that hour (so it reads RM18
in an hour when only the premium court is left), and booking it takes the
cheapest court free for the **whole** slot, not hour by hour — nobody is moved
mid-session.

`createBookingOnAnyCourt()` re-reads the candidate list server-side rather than
trusting the client, orders it by what that slot actually costs (peak-aware, so
the order can differ morning to evening), and walks it: if the cheapest is
taken between choosing and inserting, the next is tried. That is the point of
not naming a court — a race should cost the customer a different court, not the
booking. It stops walking as soon as an error applies to every court equally.

Each attempt goes through the ordinary `createBookingSeries()` path, so the
uniqueness guarantee, seat allocation, trading hours, closures and series
handling are the same code as a named-court booking. When nothing is free the
error says so, rather than reporting the last court's "someone just took it";
structural reasons — venue closed, outside trading hours, no courts of that
sport — are surfaced as themselves.

## Moving a booking

A net breaks, a court floods, a league wants to be side by side — the booking
has to change court without changing anything else. Without this the only
option is cancel-and-rebook, which issues a new code the customer does not
have, drops the payment record, and un-checks-in anyone already inside.

`moveBooking(code, courtId)` re-points the booking and rewrites its
`booking_slots` rows in one transaction, so a move either happens completely or
not at all — a target that is free for three of four hours leaves the booking
exactly where it was. Seats are re-allocated on the target, so a move onto a
shared facility takes the lowest free place; the unique index is still the real
guard, and a racing insert fails rather than double-selling.

A move is refused across venues, across sports, onto the court it is already
on, onto a blocked hour or one a class owns, and for a booking that is
cancelled or already finished. A class enrolment cannot be moved on its own —
it belongs to the class.

**The price does not change.** A move is the venue's convenience, not the
customer's, so it never costs them more — and they do not gain from being put
on a cheaper court either. The code, payment status, pass or credit charge, and
any check-in all survive untouched, and the court they left is immediately
offered to anyone waiting on it.

Staff pick from a list of courts that are genuinely free for the whole booking
(`moveTargetsFor`), so the refusals above are mostly unreachable from the UI —
they exist because the API is reachable without it.

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

## Operating hours and closed days

Hours are a property of the venue, not the platform. Every venue carries an
`open_hour` and a `close_hour` (defaults 8 and 23, bounds 0–24): the first
bookable hour starts at `open_hour` and the last one ends at `close_hour`. That
single pair sizes the customer grid, the admin schedule, the occupancy
denominator, and the hours accepted by booking, class scheduling, slot blocking
and waitlist joins. Cross-venue search clamps the requested window to each
venue's own day, so a 7 AM search only ever returns the venues that are open at
7 AM, and a 2-hour block is only offered if it still finishes by that venue's
close.

Narrowing a venue's day is refused while bookings exist outside the proposed
hours — otherwise a customer would hold a slot the venue no longer sells. Staff
have to cancel or move those first.

A **closure** shuts one venue for one whole date (`venue_closures`, unique on
venue + date). Closed days read as blocked everywhere: no slot is selectable,
booking, series, class scheduling, enrolment and waitlist joins are all refused
with "The venue is closed that day", the venue disappears from search for that
date, and customers see the reason both as an upcoming-closures banner on the
venue page and on the grid itself. Staff still see the day in the schedule,
marked with the closure reason rather than blank, so bookings taken before the
closure was declared remain visible for them to handle.

## Session cookies

Both session cookies (`ms_session`, `ms_admin`) are `HttpOnly`, `SameSite=Lax`,
site-wide, and `Secure` — but only when the request is actually on HTTPS.
Marking `Secure` on a plain-HTTP deployment would stop the browser sending the
cookie at all, so the flag follows the connection rather than a build-time
guess: the request's own protocol, or `x-forwarded-proto` behind a proxy.
`SECURE_COOKIES=1` forces it on for a proxy that sets no such header.

All three places that issue a session cookie go through one
`sessionCookieOptions()` helper, so a fourth cannot quietly ship without the
flags.

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

## Renamed from MudahTempah

The project was renamed to **MySenam**. Everything user-facing moved with it —
the wordmark, page titles, calendar invites, WhatsApp share text and the
booking-code prefix (new codes read `MS-…`). Three notes for an existing
install:

- Booking codes already issued keep their `MT-` prefix and still resolve; lookup
  matches the whole code, never the prefix.
- The SQLite file became `data/mysenam.db`, set by `MYSENAM_DB`. Both that and
  the older `data/mudahtempah.db` / `MUDAHTEMPAH_DB` are recognised by the
  check described in *Moving from SQLite*, and brought across the same way.
- Session cookies are now `ms_session` and `ms_admin`, so everyone signed in
  under the old names has to sign in once more.
- The bootstrap owner's default email is now `admin@mysenam.my`. That default
  only applies to a *fresh* database — an install created before the rename
  keeps the account it already has at `admin@mudahtempah.my`.

## Continuous integration

`.github/workflows/ci.yml` runs type-check, tests and a production build on every
push and pull request (Node 22, `npm ci`).

## Roadmap ideas

- Per-member credentials through a smart-lock vendor (TTLock, Igloohome — whose
  offline algoPIN would suit a door with no wifi), so an unmanned resource can
  issue one credential per person instead of one code per lock. This is what
  the 24-hour chains use instead of a shared code, and it is the single biggest
  remaining gap. Blocked on vendor credentials; the induction record and the
  customer-facing screen are already the right shape for it
- A turnstile rather than a door, which is the only real answer to tailgating:
  one credential, one body. Software can attribute an entry; it cannot stop
  five people walking in behind one of them
- Online top-ups, so credit can be bought without visiting a counter
- Requiring payment online to hold a booking, with unpaid holds released after a few minutes
- Reminders the day before a booking, on the same outbox and templates
- Set strong `ADMIN_EMAIL` / `ADMIN_PASSWORD` values before deploying
