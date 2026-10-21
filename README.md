# MySenam 🏸

**Gelanggang, gim dan kelas — satu tempahan.** An online booking platform for
sports courts (badminton, tennis, pickleball, futsal), shared facilities like gyms and pools,
equipment hire such as kayaks, and instructor-led classes.

## Features

- **Cross-venue search** (`/search`) — pick a sport, day, time window and duration, and see every free court across all venues at once, grouped by venue and cheapest-first; one click deep-links into the venue page with the slot already selected
- **Waitlists** — when a court hour or class is full, customers queue instead; a cancellation offers it to whoever has waited longest, held for 30 minutes before passing on
- **Instructor-led classes** (`/classes`) — schedule a session or a whole weekly term on a shared facility; customers enrol rather than book, the resource is reserved while the class runs, and staff get a live roster showing who has checked in
- **Courts *and* shared facilities** — a resource has a capacity: 1 means exclusive use (a badminton court), more means a gym floor, pool or class where that many people hold the same hour. The booking grid shows places left and colours them by how busy the hour is
- **Facilities and photos** — each venue ticks what it has (showers, parking, surau, near LRT/MRT…) from a fixed list and says what each court is like (indoor, air-con, floodlit, surface); players see it on the venue page and on every card, and filter by it. A cover and up to five photos, optional, checked and redrawn as small WebP files, lazy-loaded so the booking grid never waits
- **Live availability grid** — per venue, per sport, per day, with hourly slots inside that venue's own trading hours
- **Peak / off-peak pricing** — weekday evenings (from 6 PM) and weekends charge the peak rate; prices shown per-slot in MYR
- **"Any court"** — a row above the grid for customers who do not mind which court; it shows the cheapest free rate each hour and books the cheapest court free for the whole slot
- **Instant booking** — pick up to 4 consecutive hours, enter name + phone, get a booking code (e.g. `MS-8F3K2A`); pay at the counter
- **Weekly recurring bookings** — repeat the same slot for up to 8 weeks (leagues, training); each session gets its own code plus a shared series code (`SR-…`), clashing weeks can be skipped or fail the whole series, and a series cancels in one action
- **Double-booking proof** — slot uniqueness is enforced at the database level, so concurrent bookings can never collide
- **Memberships and member rates** — each court can carry a member price alongside its public one; a member of that venue is charged it automatically, and sees it on the grid when signed in; clubs can sell and renew memberships online
- **Promo codes** — a venue advertises a percentage or fixed discount, optionally limited to one sport, a minimum booking length, a date range and a number of uses; customers type the code when booking and it comes off the total
- **Multi-visit passes** — sell a block of entries up front ("10 hours of badminton at PJ"); one entry covers one booked hour, the holder picks the pass on the booking form or quotes its code, and cancelling returns the entries
- **Personal data you can see and remove** — a signed-in customer downloads everything held against their account as one file, or closes the account: upcoming bookings are cancelled and their name comes off past ones, while the hour and the price stay as the venue's accounting record. Old records age out on a published retention schedule that applies itself daily, and a privacy notice at `/privacy` says all of it in plain terms
- **Unstaffed hours** — a venue says when somebody is behind the counter, and a resource says whether it may be used outside that window. Out of hours, a customer who is *inducted* and *paid* is shown the door code an hour before their slot; every reveal is logged against the booking, opening the door counts as checking in, and the entry screen carries the venue's emergency number and who else is inside. Pools can never be left unmanned, and neither can anything hired out against a deposit
- **Equipment hire** — a resource that leaves the building (a kayak, a paddle set) carries a deposit; the desk hands the kit over against it, and the return records condition, any damage note and anything kept back, with the rest given straight back
- **Stored credit** — customers buy credit at any counter or online and pay for bookings and classes from the balance; cancelling refunds it automatically
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

The ready-made way to run it is one DigitalOcean Droplet with Postgres, the app
and Caddy on it, set up by a script and deployed by another. See
[`deploy/digitalocean/README.md`](deploy/digitalocean/README.md).

### Configuration

Everything is an environment variable; there is nothing else to configure.

| Variable | Default | What it does |
| -------- | ------- | ------------ |
| `MYSENAM_MARKETPLACE` | — | `on` for the shared marketplace: venues apply to join, are invoiced monthly, and stored credit is per venue |
| `MYSENAM_CREDIT_SCOPE` | `platform`, or `venue` on a marketplace | Whose stored credit is — see *Whose credit it is* |
| `MYSENAM_ALERT_WEBHOOK` | — | A Slack, Discord or Google Chat incoming-webhook URL; alerts are posted there as `{"text": ...}` as well as emailed to the platform owners |
| `MYSENAM_VENUE_FEE` | `0` | On a marketplace, what a venue pays a month unless it has its own fee, or the owner has set tiers by size (see *Plans by size*) |
| `MYSENAM_FREE_MONTHS` | `1` | Free months from going live before a venue's first invoice |
| `MYSENAM_WHATSAPP_PACK` | `200` | On a marketplace, WhatsApp messages in a prepaid pack — see *What WhatsApp costs, and who pays* |
| `MYSENAM_WHATSAPP_PACK_PRICE` | `20` | RM for a pack, paid before any of it is sent |
| `MYSENAM_TAX_RATE`, `MYSENAM_TAX_REG_NO` | — | The platform operator's own SST or GST, once registered: the rate (%) added to venues' invoices and the registration number printed on them. Both, or no tax. See *Tax* |
| `MYSENAM_TAX_NAME` | the country's (`SST`, `GST`) | What the operator's tax is called on invoices |
| `MYSENAM_PAYMENT_PROVIDERS` | the country's usual one | The payment gateways venues may connect, comma-separated — see *Payment gateways* |
| `MYSENAM_PAYMENT_PROVIDER` | the first of those | The gateway the platform's own account is at, for venues paying invoices and WhatsApp packs online |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | — | The platform's own Stripe account, when `MYSENAM_PAYMENT_PROVIDER=stripe` |
| `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID`, `BILLPLZ_X_SIGNATURE_KEY`, `BILLPLZ_SANDBOX` | — | The platform's own Billplz account, for venues paying their invoices online. `BILLPLZ_SANDBOX=on` for test payments |
| `OPERATOR_NAME`, `OPERATOR_REG_NO`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` | — | Who runs the site, for the terms at `/terms` |
| `MYSENAM_GEOCODER` | OpenStreetMap's Nominatim | Where venue addresses are looked up: a Nominatim URL of your own, or `off` |
| `MYSENAM_AUTO_APPROVE_BRANCHES` | — | `on` to approve a business's new branch without the platform owner, when its location checks pass |
| `MYSENAM_TRUST_FORWARDED_HOST` | — | `on` only behind a proxy that rewrites Host: read the storefront domain from `X-Forwarded-Host` |
| `MYSENAM_COUNTRY` | `MY` | The country this install serves, `MY` or `SG` — currency, phone numbers, time zone, languages, map, default gateway and the laws the terms cite. See *Countries* |
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
| `PHOTOS_S3_*` | — | A bucket of its own for venue photos (`ENDPOINT`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`); without one, photos go in the data folder. See *Venue photos* |
| `PHOTOS_PUBLIC_URL` | — | The photo bucket's public address, so browsers fetch photos from it rather than through this server |
| `MYSENAM_URL` | `http://localhost:3000` | Where this install is reachable, for the links inside customer messages |
| `MYSENAM_SEND` | — | `log` writes customer messages to the server log instead of sending them |
| `WHATSAPP_TOKEN` | — | A WhatsApp Cloud API access token. With the next one, sends messages on WhatsApp |
| `WHATSAPP_PHONE_NUMBER_ID` | — | The Cloud API phone number id messages are sent from |
| `WHATSAPP_CODE_TEMPLATE` | `mysenam_login_code` | The WhatsApp *authentication* template that carries the code checking a customer's number |
| `MYSENAM_PHONE_CHECK` | on when a way to check is set up | `off` to take customers' numbers as given; `on` to check them even without one (with `MYSENAM_SEND=log`, codes go to the server log) |
| `MYSENAM_PHONE_CODES_PER_DAY` | `300` | Most verification codes (SMS or WhatsApp) the whole site sends in a day; the owner is emailed when it is reached |
| `SMS_TWILIO_ACCOUNT_SID`, `SMS_TWILIO_AUTH_TOKEN`, `SMS_FROM` | — | Send verification codes by SMS through Twilio |
| `SMS_HTTP_URL` | — | Or through any gateway that sends with one GET, e.g. `https://gateway.example.my/send?user=…&to={to}&text={text}` — `{to}` and `{text}` are filled in |
| `SMS_PREFIX` | the country's (`RM0` in Malaysia) | What every SMS starts with, as Malaysian rules ask of business texts; empty to leave it off |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Customers can sign in with Google. The redirect to register with Google is `<MYSENAM_URL>/api/auth/google/callback` |
| `WHATSAPP_TEMPLATE_PREFIX` | `mysenam` | Prefix of the approved template names, e.g. `mysenam_booking_confirmed` |
| `WHATSAPP_COUNTRY_CODE` | the country's (`60`, `65`) | Country code put in front of a number typed locally |
| `WHATSAPP_API_VERSION` | `v23.0` | Graph API version |
| `WHATSAPP_CHAT_NUMBER` | — | The platform's WhatsApp number as customers dial it (e.g. `+60 11-2345 6789`). With the next two, confirmations offer *Send it to my WhatsApp* |
| `WHATSAPP_APP_SECRET` | — | The Meta app's secret, which signs each delivery to `/api/whatsapp/webhook` |
| `WHATSAPP_VERIFY_TOKEN` | — | Any long random string, given to Meta when subscribing the webhook |
| `MYSENAM_WHATSAPP_CHAT_HOLD_MINUTES` | `3` | How long a confirmation waits for the customer to open the chat before it goes as a template |
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
due, which also sends any customer messages waiting to go and starts and ends
league seasons on their dates (with it off, staff start and end them from the
dashboard). Set
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

### Being told when something breaks

A failure the owner never hears about is found out from a venue's complaint.
So the platform owners are told (`src/lib/alerts.ts`) when:

- a page or API request ends in a **server error** (Next's `onRequestError`);
- any of the **scheduled work** fails: sending messages, letting go of unpaid
  holds, invoices, overdue checks, league housekeeping, the backup;
- the **nightly backup** or its **off-site copy** fails;
- **messages to customers stop going out**: five or more failed in an hour and
  none sent (one bad address is not news; a rejected SMTP login is).

Each kind is told once, then again only after six hours if it is still
happening, with how many times it has. It goes by email to every platform
owner and, with `MYSENAM_ALERT_WEBHOOK` set, to a Slack, Discord or Google
Chat channel, which still arrives when email is what broke. The owner's
dashboard shows *System health* while anything is outstanding, with the
latest detail and a *Dealt with* button.

**A stopped scheduler** cannot email about itself, so `/api/health` answers
`503` when it has not ticked for ten minutes. Point an uptime monitor
(UptimeRobot, Better Stack, the host's own) at `/api/health` and it covers
both the app being down and the scheduler being stuck.

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

### Plans by size

The owner can price venues by how many bookable resources they have —
courts, pitches, rooms — under *Venues & staff → Billing → Plans by size*
(`src/lib/plans.ts`). With no tiers set, every venue pays the flat
`MYSENAM_VENUE_FEE`, as before; a venue's own agreed fee beats both.

- **Every tier has every feature.** Recurring bookings, cancellations, rate
  schedules, customers and reports are what a booking system is for, so none
  is held back to make a venue upgrade. Only the count sets the price.
- **The count is taken when each month is invoiced**, and written on the
  invoice with the tier ("Growth · 8"), so a venue can see why it paid what it
  paid and a later change of tiers does not rewrite an invoice already issued.
  A court **out of service for the whole month** is not counted, so a hall
  is not charged for a court it closed for repairs. A business's branches are
  each priced by their own size, as lines on its one invoice.
- **The last tier can have a limit** with a fee for each resource past it, so
  a very large hall does not pay the same as a mid-sized one.
- Staff see their venue's tier, its count and the whole tier list under
  *Billing*; tiers take effect from the next invoice.

*Use suggested tiers* fills in a starting point, from the pricing analysis
below. They are a starting point to test with venues, not a finding.

| Tier | Courts or rooms | RM a month |
| ---- | --------------- | ---------- |
| Starter | 1–5 | 19.90 |
| Growth | 6–15 | 39.90 |
| Large | 16–30 | 69.90 |
| Arena | 31–50 | 99.90, then RM2 each |

What a venue costs to serve, a month, at 40% utilisation and 1.5-hour
bookings: about **RM3.35 fixed** (hosting at ~100 venues, RM2.00; collecting
the invoice by FPX, RM1.35) plus about **RM1.07 per court**. Of that, the
SMS phone codes cost RM0.69 (8% of bookings by a first-time customer, half
of whom pick SMS at about RM0.135), urgent WhatsApp news RM0.23 (3% of
bookings cancelled or moved by the venue) and email RM0.15. Checking a number
on WhatsApp costs nothing: the customer sends the message, and nothing is
sent back. So a 10-court hall costs about RM14 a month and a 30-court one
about RM36. Those are assumptions, labelled as such, not measurements.

| Courts | 1 | 5 | 10 | 15 | 20 | 30 | 40 | 60 |
| ------ | - | - | -- | -- | -- | -- | -- | -- |
| Cost to serve (RM) | 4.42 | 8.71 | 14.07 | 19.43 | 24.79 | 35.51 | 46.23 | 67.66 |
| Suggested fee | 19.90 | 19.90 | 39.90 | 39.90 | 69.90 | 69.90 | 99.90 | 119.90 |
| Margin | 78% | 56% | 65% | 51% | 65% | 49% | 54% | 44% |

Without the Large and Arena tiers (Growth up to 15, then RM49.90 for any
size) a 40-court hall leaves about RM4 a month and a 60-court one loses RM18.
On an assumed mix of venue sizes, weighted to small badminton and futsal
halls (2–12 courts), the suggested tiers average about RM37.90 a month and
RM24.65 after costs: about 24 paying venues cover a founder-run install's
own running costs (~RM600 a month), and about 330 would pay for a developer
and a support person (~RM8,047). The biggest unknown is how many bookings
come from first-time customers who choose SMS; the daily cap on codes
(`MYSENAM_PHONE_CODES_PER_DAY`) bounds it.

### Managers and front desk

Branch staff are a **manager** or **front desk** (`src/lib/roles.ts`), chosen
when they are added under *Venues & staff* and changeable there by a business
manager or the platform owner. Staff who were there before this existed are
managers, so nobody lost anything; new ones default to front desk.

| | Front desk | Manager |
| - | :-: | :-: |
| Bookings: make, mark paid (and how), check in, move, change, cancel, no-show | ✓ | ✓ |
| Kit hire, passes, memberships and credit sold at the counter, blocking an hour | ✓ | ✓ |
| Courts and prices, classes, leagues and tournaments set up | | ✓ |
| Venue details, closures, outages, who it is for, house rules, pay to hold | | ✓ |
| Payment account, refunds, voiding passes, memberships and promo codes | | ✓ |
| Promo codes, notices, photos, WhatsApp, the marketplace invoice | | ✓ |
| Reports and the staff activity log | | ✓ |

The rule is one table of addresses and methods, applied in `requireAdmin` for
every admin route, so a new route cannot forget it; `tests/roles.test.ts`
checks each line names a real route, that front desk is refused there and a
manager is not.

**Spreadsheets for the accountant.** *Reports* has *Bookings (CSV)* and
*Online payments (CSV)* for the period shown (`src/lib/export.ts`): every
booking with its price, whether and how it was paid, promo discount, extras,
check-in and no-show; and every payment taken online with what is owed back.
They open straight in Excel (byte-order mark, quoted cells, and a cell that
would start a formula is kept as text). Managers only, and each download is
in the activity log, since customers' names and numbers leave with it.

**The staff activity log** (*Reports → Staff activity*, `src/lib/activity.ts`)
writes down who did what, when, at which venue and to which booking:
payments marked at the desk and how, bookings cancelled, moved or changed,
no-shows, court and price changes (as they were and as they are), refunds,
credit, passes and memberships sold or voided, promo codes, settings, and
staff added, removed or given another role. It squares the till at the end
of a shift and answers "who cancelled my booking?"; search it by booking code
for one booking's history. Entries keep the person's name, so they read right
after an account is removed, and are kept two years.

### Checking a venue is real

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

### Storefront domains

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

### Businesses with several branches

On a marketplace, every venue belongs to a business, and a business can have
any number of branches. Approving an application creates the business, with
that venue as its first branch and the applicant as its manager.

- **Managers** sign in once for every branch. The day list, schedule,
  reports, classes, credit, messages and invoices cover all their branches,
  with a branch picker wherever a screen is about one. They add and remove
  their business's staff, and add branches under *Branches & staff → Add a
  branch*.
- **Branch staff** see their own branch and nothing else.
- **New branches** start as drafts the manager sets up, and go live like the
  first one did — on the platform owner's approval, or on their own where the
  install sets `MYSENAM_AUTO_APPROVE_BRANCHES=on` and the branch's pin and
  address agree (see *Checking a venue is real*).
- **Credit, passes and memberships** bought at any branch work at every
  branch of that business, and nowhere else. A member pays each branch's
  member rate wherever they play, and is not sold a second membership at
  another branch while the first runs. A customer sees one balance under the
  business's name, and the business, not a single branch, is shown as owing
  it.
- **Venues that joined one at a time**, before businesses existed, can be put
  together by the platform owner under *Venues & staff → Businesses*,
  choosing which of their staff become managers.

**One invoice a month per business**, with a line for each branch and its
fee. Its managers pay it, online or otherwise. A venue that is not in a
business is still invoiced on its own, and invoices issued before a venue
joined a business stay as they were.

### A venue business's own copy

The same code runs as the shared MySenam marketplace and as one business's own
booking site under its own name. An own copy is a separate install with its
own database, so its customers, credit and money never sit beside anybody
else's; its owner signs in as the platform owner and sees every one of their
branches, and only theirs.

Each copy is its own Droplet, set up with the same kit
([`deploy/digitalocean`](deploy/digitalocean/README.md)) and with `SITE_NAME`
set in its `/etc/mysenam/env`. Every copy deploys from the same repository, and
`mysenam-deploy` on each puts the new version live; a deploy restarts the app
for a second or two, so do it outside opening hours.

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
| POST   | `/api/auth/forgot`        | `{email}` → emails a reset link; always `{ok}`  |
| POST   | `/api/auth/reset`         | `{token, password}` → new password + signed in  |
| GET    | `/api/my/password`        | `{hasPassword}` (Google accounts may have none) |
| POST   | `/api/my/password`        | `{current, next}` → change it; others signed out |
| GET    | `/api/my/bookings`        | The signed-in user's bookings                   |
| GET    | `/api/my/wallet`          | Credit balance and recent movements             |
| GET    | `/api/my/passes`          | The signed-in customer's multi-visit passes     |
| GET    | `/api/my/membership`      | The signed-in customer's memberships            |
| GET    | `/api/my/waitlist`        | Classes you are queuing for, and any live offer |
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
| GET/POST | `/api/admin/house-rules`    | `?venueId` / `{venueId, upcoming, perWeek, perDay, aheadDays}` |
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

## Courts out of service

Two ways, for two lengths of time:

- **A few hours**: block them on the *Schedule*, with a reason. On a shared
  facility, only some of its places (below).
- **Days, or until further notice**: *Courts & rates → Out of service* — a
  court, a first day, a last day or "until further notice", and a reason,
  which customers see on the venue's page. Nobody can book it, search finds it
  closed, and the reports count it as out. If anything is booked in the
  stretch, it lists those bookings and classes and stops; staff move them, or
  choose to cancel them, which refunds each as a staff cancellation would and
  messages its customer. *Back in service today* ends it early.

An outage is not a row per hour. The database function `blocks_between`
(`db/migrations/0009`) answers "what is blocked between these days" with the
hours blocked by hand and every trading hour of every outage, and everything
that asks what is blocked asks it — so availability, search, booking, moving
a booking, the waitlist, the schedule and the reports close the court without
knowing outages exist. Where an hour is both, the hand-made block wins.

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

## Open games: finding players

A player who has booked a court can open it to others at `/games` (*Games* in
the menu): how many players they want, at what level, and what each pays
towards the court — split evenly unless they say otherwise. Others find open
games by sport, day, level, or *Near me*, and ask to join; the host accepts or
declines from the same page, or lets anybody straight in. Everything needs an
account.

- **Money goes to the venue.** A player who joins pays their share online to
  the venue's own Billplz account, towards the host's booking; staff see
  "RM12 due" instead of the full price, and the host paying online pays only
  the rest. Shares that cover the court mark it paid. Where the venue does not
  take payment online, shares are paid at the counter. The platform never
  holds anybody's money.
- **Owed back when the game does not happen to them**: a player leaving or
  being removed, or the booking being cancelled by anyone, puts their paid
  share on the venue's list of refunds to make, like any online payment for
  something that did not happen. A share that arrives after the court was paid
  for in full, or after they left, is owed back at once.
- **Privacy.** Players see each other's first name and level, never a phone
  number or email. Levels are self-rated per sport: beginner, intermediate,
  advanced or competitive.
- **No-shows.** After the game, the host can mark a player who did not come.
  Three in 90 days, and that player cannot join games until they age out.
- Everyone is emailed when it matters: the host when somebody asks, joins or
  leaves; the player when accepted, declined, removed, or the game is off.
- Closing an account takes the player out of games to come, and calls off
  games they were hosting; the personal data export includes games and levels.

## Notices, and keeping the front page fair

The marketplace does not sell placement. No venue can pay, or post its way,
to the top of the front page or of search: venues are listed in a fair order
that changes by the day, or by distance when the customer asks for nearby.

- **A venue's own notices.** Under *Venue details → Put up a notice*, its staff
  put up a line for some days — an event, a promotion, a change of hours —
  with an optional link to a page on this site (their tournament, league or
  classes). It shows on the venue's own page, and on the home page of its
  storefront domain (up to three, for a business with branches). It never
  shows on the marketplace's front page or in search.
- **The site-wide notice.** Only the platform owner can set the one notice on
  the marketplace's front page (*Venues & staff → Site-wide notice*). It is
  for what concerns every player — a government programme, a large
  collaboration — never one venue's promotion.
- **Text only, links only inward.** 160 characters, up to 60 days at a time,
  and a link must be a path on this site, so a notice cannot send a customer
  to a page that pretends to be the venue. Staff can take theirs down; the
  platform owner can take down any.

## Finding a court from the front page

The home page starts the search: tap a sport, a day (today, tomorrow, or
another), a time of day (morning, afternoon, evening) and, if wanted, *Near
me*, then *Show free courts*. That opens the search with all of it filled in
— `/search?sport=badminton&date=…&from=17&to=23&near=…` — so a search can be
shared or bookmarked too. The venue list stays below for browsing.

The menu is four items — *Find a court*, *Classes*, *Play* (open games,
tournaments and leagues together, at `/play`) and *My Booking* — and a
venue's page puts its booking grid straight after its photos, with its
facilities, map and live crowd below.

The search page works the same way: the time of day is one tap — *Any time*,
*Morning*, *Afternoon*, *Evening* — and *Custom…* opens the from and until
hours for anyone who wants an exact window. On a phone, *Area* and the
must-haves (showers, parking and so on) fold under *More filters*, which says
how many are on; *Near me* stays in view.

**Returning guests.** After a booking, class or waiting-list place made without
an account, the name, phone and email are kept in that browser only
(`localStorage`), so the next booking on that device is filled in. *Not
Aisyah? Clear* forgets them. Nothing is sent anywhere for this, nothing is
kept on the server beyond the booking itself, and a browser that refuses
storage (private windows, blocked site data) just asks again.

## Extras: rentals and sales with a booking

A venue lists what it hires out and sells — rackets, bibs, mats to hire;
shuttles, grip, drinks to buy — under *Venue details → Extras for sale or
hire*, each with a price and, for a rental, optionally how many it has. An
extra can be for one sport only (bibs with futsal) or any. Up to 20 at a time;
an extra is retired rather than deleted, so old bookings still say what they
had.

- **Offered, never chosen for the customer.** The booking bar and the class
  enrolment form show *+ Add extras* only when the venue has some, folded until
  tapped, with − / + for each. The price on the *Book* button includes them.
- **Rentals cannot be over-promised.** Stock is per venue per hour across
  confirmed bookings: with three rackets, a racket hired 8–10 pm is not there
  for another court at 9. The list says how many are left when five or fewer,
  and the server checks again before taking the booking, so a race ends in a
  clear "only 1 racket left" rather than a promise the desk cannot keep. A
  cancelled booking gives its rentals back.
- **On the booking's own price.** Extras go onto `bookings.total_price`
  (after any promo code, which is for the court), so they are paid online,
  from credit or at the counter with the court, refunded with it, and in the
  day's takings with no separate till. Each line is kept in `booking_addons`
  with the name and price at the time. A weekly series carries the same extras
  every week; a week whose rentals have all gone out stands without them and
  says so.
- **A pass is for court time.** Paying with a pass is refused for a booking
  with extras (the booking bar hides the pass when extras are chosen), so a
  ten-hour pass never quietly pays for drinks.
- **At the desk.** The day's bookings show 🎒 *2 × Racket (hire), 1 × Shuttle
  tube*, ready to hand over at check-in; the customer sees the same on their
  confirmation and under *My Booking*.

## Women-only and men-only

Open games, leagues and classes can be for anyone (the default), women only
or men only; tournaments have badminton's categories — open, women's, men's,
and mixed doubles. Women-only matters most: ladies' nights, muslimah
sessions, and women who would not otherwise join strangers. Men-only exists
too, for contact sports and those who keep apart, so the rule reads the same
both ways.

- **What a player says.** *Woman*, *man* or *prefer not to say*, asked the
  first time it matters — never at sign-up — on *Women's and men's games*,
  and then straight back to what asked. It can be changed on the account
  page, is in the data export, and goes with the account. Nobody else sees it:
  a game shows only its own rule. *Prefer not to say* joins everything open
  to anyone.
- **Open games.** The host chooses *Who can join*. A women-only game must be
  opened by a woman (and a men-only game by a man), so the label cannot be
  used to draw people in. Joining checks the player. *Games* has *Women only*
  and *Men only* chips, and each such game carries a badge.
- **Tournaments.** A women's or men's event takes entrants of that gender; in
  doubles the partner is the same. Mixed doubles is doubles only, and the
  entrant says whether their partner is a woman or a man — it must be one of
  each.
- **Leagues** take the same choice as games.
- **Classes.** A signed-in customer is checked by their account. A guest
  enrolling without one ticks "I am a woman: this class is for women only" —
  the same self-declaration an account makes. The waiting list asks the same.
- **It is self-declared**, like a player's level: nothing here can prove it.
  A host can remove a player, and venue staff see who enrolled, and that is
  the backstop.

## Tournaments

Venues run them from the dashboard's *Tournaments* tab; players find them at
`/tournaments`.

- **Setting one up**: sport, singles or doubles, level, entry fee, most
  entries, days (up to two weeks) and daily hours, and which courts. Those
  hours are **held at once** — ordinary blocks with the tournament's name, so
  every booking path already treats them as taken. It will not hold over a
  booking already made, or a court out of service, and says which.
- **Entries**: players enter with their account (naming a partner for
  doubles) and pay the fee online to the venue, or at its counter, where
  staff tick it off. Past the limit they go on a waiting list, and move up,
  and are told, when somebody withdraws.
- **The draw**: a straight knockout, or round-robin groups (3 to 6) whose top
  one or two go through to a knockout. Seeds staff set are kept apart and get
  the byes; everybody else is drawn by lot. Each group's runner-up is put in
  the other half of the knockout from its winner. Every match gets a court and
  an hour within those held, with nobody playing twice at once and no round
  before the one feeding it — or the draw says how many matches did not fit
  and changes nothing. Everybody is emailed their first match.
- **Results**: staff enter the score as sets ("21-15, 18-21, 21-10") and who
  won — a score that says the other side won is refused — or a walkover.
  Winners move on by themselves; the last group match fills the knockout from
  the tables (wins, then sets, then points, then who beat whom); the final
  finishes it. A result can be put right until the match it fed has been
  played.
- **Court time goes back as soon as it is not needed.** Until the draw, every
  hour is held, since nobody knows which will be used. Once it is made, each
  court keeps only the hours from its first match still to play that day to
  its last — the hours between stay held, so a match that runs over does not
  run into a booking — and a court with nothing to play that day is given
  back whole. It is worked out again after every result and walkover, so a
  court is freed the moment its last match is in, and the rest of the final
  day when the final is. Hours already gone stay on the schedule as a record.
  Anybody on the waiting list for that court and day is offered what comes
  free, as with a cancellation.
- **Withdrawals** before the draw free the place for the waiting list and owe
  back a fee paid online; after it, every match still to play is a walkover.
  **Calling it off** gives the courts back (offering them to the waiting
  list), tells every entrant, and owes back every fee paid online.
- The public page shows entries, then the groups, the bracket and every
  match's court and time, refreshing while it is on.

The draw's arithmetic — seeding, byes, round-robins, tables, fitting matches
into court time — is in `src/lib/brackets.ts`, apart from the database, and
tested on its own.

## Box leagues

Venues run them from the dashboard's *Leagues* tab; players find them at
`/leagues`. A league runs season after season, four weeks each by default
(two to eight), rather than as fixed weekly fixtures nobody can keep.

- **Setting one up**: sport, singles or doubles pairs, level, box size (3 to
  6, default 4), one or two up and down, season length, a fee per season, and
  when the first season starts. Nothing is held: players book courts like
  anybody else.
- **Joining**: with an account, at any time. A player joining mid-season goes
  into a box at the next one. Joining says plainly that box-mates will see
  your name and phone number — that is how matches get arranged — and only
  box-mates in the season being played see them, with a WhatsApp link.
- **Boxes**: everybody who has joined goes into one. Those who played last
  season go where their move takes them; a newcomer goes into the bottom box,
  best self-rated level first, unless staff give them a box to start in. Box
  sizes keep to the size asked and spread the odd ones over from the top
  (nine players in boxes of four make 5 and 4, not 3, 3 and 3), so one more
  or one fewer player does not reshuffle the ladder. Everybody plays
  everybody in their box once.
- **Results**: either player reports the score, their own games first, and
  who won; the other confirms it, or says it is wrong and why — staff are
  emailed and decide it. A report nobody answers stands after three days.
  Staff can also enter any result, give a walkover, strike a match, or put it
  back to be played. Tables use the tournament rules: wins, then sets, then
  points, then who beat whom.
- **Seasons start and end by themselves.** A season starts on its date if
  three or more have joined, and ends three days after its last day, for late
  results; staff can do either sooner, or move the start. At the end,
  unanswered reports stand, disputes nobody settled do not count, and the best
  one (or two) of every box but the top go up and the worst of every box but
  the bottom go down — never more than half a box. Everybody is emailed where
  they finished and where they go; the next season starts the day after.
- **Leaving** mid-season makes every match not yet played a walkover to the
  other side; what was played still counts for the opponents.
- **The fee** is paid online to the venue from the league page once the
  boxes are made, or at the counter, where staff tick it off. A fee that
  arrives after the player left, or paid at the counter meanwhile, is owed
  back.
- Closing an account takes the player out of their leagues and their name
  off every box; the personal data export includes leagues and seasons.

The box arithmetic — sizes, who moves, the order for next season — is in
`src/lib/boxes.ts`, apart from the database, and tested on its own.

## Facilities: what players compare

What a venue has besides its courts, and what each court is like, so players
can compare venues and search by it.

- **Worked out, never typed:** per sport, how many courts and the cheapest
  hour, and the opening hours — from the courts themselves, so they cannot
  go out of date.
- **Ticked by the venue, from a fixed list** under *Venue details →
  Facilities*: showers, changing rooms, lockers, toilets, free or paid
  parking, near LRT/MRT, surau, drinking water, café, pro shop, racket
  stringing, equipment rental, coaching, wheelchair access, first aid, Wi-Fi,
  spectator seating. A fixed list rather than free text, so two venues can be
  put side by side and searched; anything else belongs in a photo caption.
- **Per court**, under *Courts & rates*: indoor or outdoor, air-conditioned,
  floodlit, and for court sports the surface (wooden floor, court mat, hard
  court, clay, artificial turf, interlocking tiles, concrete). Saved as soon
  as it is changed.
- **Players see** a *Facilities* panel on the venue's page (per sport: courts,
  indoor/outdoor, air-con, surface, from-price; then the facilities), and up
  to four highlights on each card: air-con or indoor, floodlights, then
  showers, parking, surau and LRT/MRT, in that order.
- **Players filter** by *Must have* chips on the home page and in search:
  air-con, indoor, showers, parking (free or paid), surau, near LRT/MRT
  (`?has=aircon,showers`). Court features apply to the same court as the
  sport asked for: air-con badminton finds venues with an air-conditioned
  badminton court, not any air-conditioned room. In search, only courts with
  the feature are offered.
- What a venue ticks is its own claim. Photos are what back it up.

## Venue photos

A cover and up to five more, under *Venue details → Photos*. All optional:
nothing waits on them, going live included, and the setup checklist only
suggests them.

- **Only real pictures.** JPEG, PNG or WebP, up to 15 MB and 50 megapixels,
  checked by what the file is rather than its name, and by the decoder as
  well as the first bytes. SVG — a program as much as a picture — GIF and
  everything else are refused. Thirty uploads an hour per address.
- **Drawn afresh, never kept as sent.** Each is turned the way the camera
  held it and re-encoded as WebP (quality 78) at 400, 800 and 1600 pixels
  wide, never enlarged. Only the pixels survive: no GPS position, no camera
  details, nothing a crafted file could carry. The original is not stored.
  WebP rather than AVIF, which is a fifth smaller but takes seconds of
  processor per photo on a small server.
- **Never in the way.** Every picture is lazy-loaded, sized by the browser
  from the three widths, and sits in a box of fixed shape filled with its own
  main colour until it arrives, so nothing jumps and the booking grid never
  waits for one. Search results get a small thumbnail; cards get the cover,
  and a venue without one gets its sports' icons in the same space, so no card
  looks lesser for having none. Photos play no part in the order venues are
  listed.
- **Where they are kept.** In their own bucket when `PHOTOS_S3_*` is set — not
  the backup bucket, which must stay private and whose key may only upload —
  served straight from `PHOTOS_PUBLIC_URL` when it is set (an R2 public
  bucket, or a domain in front of it), otherwise through `/photos/...` on this
  server. With no bucket, in `photos/` in the data folder. Either way they are
  not in the database, so backups do not grow with them. Every file name is
  new, so browsers and caches keep them for a year.
- **Looked at.** Going live asks the platform owner to confirm any photos show
  this venue. Photos added since are listed for the owner under *New photos*
  for 14 days, with *Remove*. A draft deleted for going stale takes its photo
  files with it.

## Courts near me

On the home page and the search page, *Near me* uses the phone's location,
or a place typed (Bangsar, KLCC, a postcode) is looked up on the map. The
venue list is then nearest first, with how far each is; search finds free
courts within 5, 10, 25 or 50 km, nearest first at each time. The address can
be shared: `/?near=3.146,101.67&km=10`, and `/api/venues` and `/api/search`
take the same `near` and `km`.

Search results can be sorted three ways (`sort=` on `/api/search`):

- **Soonest**, the default: by start time, the nearest venue first at each.
- **Nearest**, offered only once there is a place: one row per venue, the
  closest first, with every free start time under it as a button straight to
  booking — for "the closest place with anything tonight".
- **Cheapest**: one row per venue, the one with the cheapest hour first.

Each venue and time is still its cheapest court whichever way it is sorted.
Following a result or a card from a search near somewhere carries the place
along, so the venue's page says "6 km from Bangsar" (or "from you") beside
*Directions*. Distances are as the crow flies, not by road.

It uses each venue's pin. Venues that signed up place one; staff move it, or
add one to a venue that never had one, under *Venues & staff* (*Move the
pin*). A venue with no pin is not found by distance. A live venue moving its
pin more than 1 km is reported to the platform owner. Distances are worked out
in SQL, inside a box drawn around the circle first, so a search near KL never
looks at a venue in Johor.

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
| WhatsApp and email messages, once sent or given up on | 90 days | deleted |
| Names and numbers on bookings | 730 days | anonymised, money kept |
| Withdrawn out-of-hours access | 365 days | deleted |
| Venue applications never confirmed by email | 7 days | deleted |
| Draft venues never live, nobody signed in | 90 days | deleted, unless they hold a customer's pass, membership, credit or payment |
| Expired sessions | — | deleted |

Door logs go first and shortest: they tie a named person to a time and a
building, which is the most sensitive thing here and the least useful once an
incident window has passed.

There is no scheduler in this system, so the policy applies itself the first
time anyone opens the dashboard each day — a venue nobody opens is a venue
accumulating nothing either. An owner can see what is due, when it last ran, and
run it early, under *Venues & staff → Keeping nothing too long*.

### How big it gets, and why not TimescaleDB

Measured with 5.4 million bookings on 12,000 courts, a booked hour costs about
450 bytes: 274 for the booking and 179 for its slot, each with its indexes.
That database was 2.3 GB, and `pg_dump` wrote it in 21 seconds to 78 MB.

At national scale, around 160,000 bookings a day, that is roughly 30 GB a
year. Messages add a steady 15–20 GB that does not grow, because they are kept
90 days. None of it slows the pages people use: they read the next fortnight
through indexes, and a day's list loads in about 20 ms with five million
bookings stored. Old rows cost disk and backup time, not speed. Bookings are
kept, anonymised after two years (see *Retention* above), because they are the
venues' accounting records, which Malaysian tax law expects kept for seven
years.

What to do as it grows:

- **Tens of GB:** nightly `pg_dump` gets slow, and a day's loss is too much.
  Move to continuous backups with point-in-time recovery: pgBackRest or WAL-G
  to R2 on the Droplet, or DigitalOcean's managed Postgres, which includes
  them.
- **Hundreds of GB:** partition `booking_slots` by month. Its unique key
  already includes the date, so it partitions cleanly, and old months can be
  detached and archived. `bookings` cannot be partitioned the same way without
  giving up a single unique index on booking codes, which customers look
  bookings up by.
- **Compression:** Postgres compresses only large values, and these rows are
  small, so there is little to gain inside the database. Compression happens
  in the backups, which `pg_dump` compresses roughly 5–10× on real data.

**TimescaleDB does not fit.** It is built for append-only measurements:
millions of sensor readings or metrics a second, rarely changed once written,
and queried in time buckets. Bookings are the opposite. They are updated
after they are written (cancelled, paid, checked in, anonymised). They
depend on unique constraints across all time: no double-booked hour, no
repeated booking code. Ledger rows point back at them with foreign keys.
Hypertables require every unique index to include the time column, and
restrict foreign keys that point at them. Compressed chunks make updates slow.
Its compression and continuous aggregates are not in the open-source edition
that DigitalOcean's managed Postgres offers, and PGlite has no TimescaleDB at
all, so development and production would differ. And the load it is built for
is thousands of writes a second; this one is about two. If high-frequency data
ever arrives, such as door sensors, occupancy pings or page-view analytics,
that one stream could be its own table or service. The bookings stay in plain
Postgres.

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

### Joining online

A club that takes payment online can list up to six **membership plans** (a
name, 1–12 months, a fee of at least RM1) under *Credit & passes → Memberships →
Join online*. Adding and retiring plans is a manager's job. The plans show on
the venue page, inside the members-only notice where there is one. A
signed-in customer picks a plan and pays the venue through its own Billplz
account, and the membership is made **when the payment settles**, against the
account's phone number (the checked one, where phone checks are on). It then
works like one sold at the counter: member rates, and booking at a members-only
venue. Staff see it in the list tagged *online*.

- **Joining** starts today and runs the plan's calendar months (31 January plus
  one month ends on the last day of February).
- **Renewing** opens 45 days before the current membership (here, or at any
  branch of the same business) ends, and the new one starts the day after it.
  The dates are worked out when the money comes in, not when the payment page
  was opened.
- **A payment that buys nothing**, such as a second payment for the same months
  or an account deleted while paying, is marked as owed back to the customer,
  the same as a paid booking that was cancelled.
- **A plan retired** while someone was paying still gives them what they paid
  for. Nobody new can start on it.
- **Private venues** do not sell membership online: their access list is the
  only way in, and a fee does not put anyone on it. Free memberships are
  given at the counter.

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

### Topping up online

A signed-in customer can also buy credit from their account page, through
Billplz into the **venue's own account** (FPX or card, RM10–RM1,000 in whole
ringgit). The account page offers the venues they have booked at or hold credit
at that take payment online. The credit is written to the ledger as *Online
top-up* only when the payment is settled (by callback or the signed return
address, whichever comes first, and only once). If the account is deleted while
they pay, the payment is marked as owed back instead.

Online top-ups are only allowed where the money lands with whoever owes the
credit: per-venue credit on a marketplace, or any credit on a single business's
own copy. On a marketplace with `MYSENAM_CREDIT_SCOPE=platform` they are not
offered, since one venue would take money for credit that other venues honour.

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

The booking code is on the customer's screen the moment the booking is made,
with *Add to Google Calendar* and a calendar file beside it, so nothing waits
on a message arriving. Messages are the copy they keep:

- **Email first** (`SMTP_URL` + `MAIL_FROM`, any SMTP account — Gmail, Zoho,
  Brevo, Amazon SES). Anyone who gives an address gets their confirmation by
  email, with the booking attached as a calendar invite (each week of a
  series, and a reminder an hour before), so it is in their diary in a tap.
  It costs next to nothing. The booking form asks for the address as *Email
  (for your code + calendar)*.
- **WhatsApp for what must not be missed** (`WHATSAPP_TOKEN` +
  `WHATSAPP_PHONE_NUMBER_ID`). Each venue chooses under *Venue details →
  WhatsApp messages*:
  - **Urgent only** (the default): the venue's own cancellations and moves,
    and waitlist offers, go to the customer's phone as well — included, the
    platform pays.
  - **Everything**: confirmations too, and day-before reminders if ticked;
    urgent news is still included, the rest comes from prepaid credit
    (below).
  - **Off**: email only; anyone who cannot be reached shows under *Needs
    attention* for a call.
- **SMS is not offered**: it costs more than WhatsApp and Malaysian sender
  rules make it the harder of the two to run.
- A customer who gave no email, at a venue without WhatsApp, gets no message:
  they have the code on screen, the calendar buttons, and *My Booking*.
- Messages wait in the queue until a channel is configured, and the
  dashboard says so.

**What is sent, and when.** Each message is written the moment the thing
happens and sent at once, then retried (1, 5, 30, 120 minutes; five tries).

| When | Message | Channels |
|---|---|---|
| A booking, a weekly series or a class place is made | Confirmation, with a calendar invite | email; WhatsApp on *everything* |
| The customer cancels | Cancelled | email; WhatsApp on *everything* |
| The venue cancels — at the desk, by closing the day, by taking the court out of service, or by calling off the class | **Cancelled by the venue**, with a *seen it* link (urgent) | email; WhatsApp unless *off* |
| The venue moves a booking to another court | **Moved**, with the new court and a *seen it* link (urgent) | email; WhatsApp unless *off* |
| A waitlist place frees up | Offer, with a link to claim it (urgent: it expires) | email; WhatsApp unless *off* |
| The day before, for a booking made more than a day ahead | Reminder | email; WhatsApp only on *everything* with *Day-before reminders on WhatsApp too* ticked |
| A booking is paid later — online, or marked paid at the counter | Receipt | email only |

Closing a day that has bookings or classes on it is refused until staff say
to cancel them; then each customer is told, as above. Messages are written in
the language the customer booked in.

### Urgent news, and knowing it arrived

A cancellation or a move by the venue is something a customer must not miss —
otherwise they turn up to a court that is not theirs. Each one opens a notice
that stays on **Bookings → Needs attention** until somebody knows the customer
has it:

- The message carries a link; the customer taps *I have seen this* on the
  page it opens (opening the link alone does not count, since email scanners
  open links by themselves), and the notice closes.
- Until then the desk sees how far it got: *waiting to send*, *sent* (email
  accepted by the mail server), *delivered to phone* and *read* (WhatsApp
  reports both back through the webhook), *failed*, or *no email or
  WhatsApp — call them*, with the number to ring. Soonest booking first.
- *I have told them* closes it once staff have rung or spoken to them. Closed
  notices stay visible for a week.

The message list under *Venues & staff* shows the same delivered, read and
not-delivered states for every WhatsApp message.

Numbers are sent the way WhatsApp wants them, whatever was typed:
`012-345 6789` becomes `60123456789`.

### New-booking alerts to the venue

Under *Venue details → New-booking alerts* a venue gives an email address, a
WhatsApp number, both or neither (the default). Each booking a customer makes
online then goes to them too: who booked, their number, the court and time,
the code, the amount and whether it is paid. A booking held for payment is
announced once it is paid, when it stands. Bookings staff make at the desk
are not announced back to the desk.

- They go through the same outbox as customers' messages, so they are retried
  and show under delivery, but are **not held to the daily limit per
  recipient**: that limit is there to keep the site from flooding somebody
  else's phone, and a busy venue takes more bookings than it allows.
- On WhatsApp each alert counts against the venue's messages like any other,
  and needs the `mysenam_venue_new_booking` template below approved.
- They are written in the install's first language.

### What WhatsApp costs, and who pays

Meta charges the platform for each template it delivers to a customer — a
few sen each in Malaysia, more for marketing, which MySenam never sends.
Email costs next to nothing and is the default. The codes that check a
customer's phone number are the platform's own cost: they protect the whole
marketplace, not one venue.

- **Urgent news is included.** A venue's own cancellations and moves, and
  waitlist offers, are few — at an assumed 2% of bookings each and one
  surprise closure a month, roughly RM0.60 a month for a 1-court venue and
  RM11 for 20 courts at a few sen a message — so the platform pays for them
  and no venue needs credit to be sure its customers are told.
- **Prepaid, never billed afterwards,** for everything else. On a marketplace a venue buys
  WhatsApp messages in packs — `MYSENAM_WHATSAPP_PACK` (200) for
  `MYSENAM_WHATSAPP_PACK_PRICE` (RM20) — paid online into the platform's
  Billplz account, or by transfer and marked paid by the owner. Each message
  sent spends one; one that fails to send is given back.
- **At zero, those messages stop; nothing else does.** Email, the on-screen
  code and urgent news on WhatsApp carry on, and nothing is sent on credit. The venue's staff are
  emailed at 20 left and again at none. So a venue that stops paying costs
  the platform nothing.
- **What staff see.** Under *Venue details → WhatsApp messages*: off, urgent
  only or everything; this month's urgent messages (included) and those from
  credit; and on *everything*, messages left, *Buy 200 messages · RM20*, what this month went on,
  and an estimate — bookings a month in, messages and packs out.
- **The platform owner** can mark a pack paid or void it, and give messages
  (a trial, goodwill).
- A venue's own install (not a marketplace) pays Meta itself: choosing
  *everything* is all it takes.

**Customers who ask on WhatsApp.** WhatsApp lets a business answer a customer
who wrote first with plain text; starting the conversation takes an approved
template. Meta's own pricing page says such replies are free, but resellers
report charges for them from 1 October 2026, so each reply spends a message
of the venue's credit like any other. Once `WHATSAPP_CHAT_NUMBER`,
`WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` are set, the confirmation
screen of a venue with WhatsApp on and credit left shows a green *Send it to
my WhatsApp* button. It opens a chat with the platform's number
with *Hi! Please send me booking MS-XXXXXX.* typed in; the customer presses
send.

- The confirmation waits `MYSENAM_WHATSAPP_CHAT_HOLD_MINUTES` (3) before it
  goes as a template. If the customer's message arrives first, the same words
  go as the reply instead, and the template never goes: one message either
  way, whichever Meta charges less for.
- Writing later — or again — gets the latest message about the booking.
- Only to the number the booking was made with. A code from any other number
  gets no answer.
- Waitlist offers and cancellations are never held; nobody is waiting on a
  screen for those.
- Staff see these as *reply in chat* in the message list, counted apart
  under *This month*.

To switch it on, in the Meta app: *WhatsApp → Configuration → Webhook*, set
the callback URL to `<MYSENAM_URL>/api/whatsapp/webhook` and the verify token
to `WHATSAPP_VERIFY_TOKEN`, then subscribe to the `messages` field. The same
subscription carries Meta's delivered, read and failed reports, which is what
lets staff see whether urgent news reached a phone. The app
secret is under *App settings → Basic*. A delivery without a valid signature
is refused.

### Setting up WhatsApp

WhatsApp only lets a business start a conversation with a **template Meta has
approved**. Each kind of message is one template, written from the same phrase
the email is, and what fills it is sent as its parameters.

1. In [Meta for Developers](https://developers.facebook.com/), create an app
   with the WhatsApp product, add the venue's number, and create a permanent
   access token for a system user. Its token is `WHATSAPP_TOKEN`; the number's
   *Phone number ID* is `WHATSAPP_PHONE_NUMBER_ID`.
2. In WhatsApp Manager, create the templates below, category **Utility**,
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

#### `mysenam_booking_cancelled_by_venue`

English (`en`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
Hi {{1}}, we are sorry: {{2}} has had to cancel booking {{3}}.

{{4}}
{{5}}
{{6}}

Please tap {{7}} to let them know you have seen this.
```

Malay (`ms`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
Hai {{1}}, kami memohon maaf: {{2}} terpaksa membatalkan tempahan {{3}}.

{{4}}
{{5}}
{{6}}

Sila tekan {{7}} untuk memberitahu mereka anda telah melihat mesej ini.
```

#### `mysenam_booking_moved`

English (`en`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} ack

```text
Hi {{1}}, {{2}} has moved booking {{3}} to another court.

Now: {{4}}
{{5}}

Same time, same price. Please tap {{6}} to let them know you have seen this.
```

Malay (`ms`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} ack

```text
Hai {{1}}, {{2}} telah memindahkan tempahan {{3}} ke gelanggang lain.

Kini: {{4}}
{{5}}

Masa dan harga yang sama. Sila tekan {{6}} untuk memberitahu mereka anda telah melihat mesej ini.
```

#### `mysenam_booking_rescheduled`

Sent when staff change a booking's date or time (a customer who changes their own is emailed instead).

English (`en`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
Hi {{1}}, {{2}} has changed the time of booking {{3}}.

Now: {{4}}
{{5}}
{{6}}

Please tap {{7}} to let them know you have seen this.
```

Malay (`ms`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
Hai {{1}}, {{2}} telah menukar masa tempahan {{3}}.

Kini: {{4}}
{{5}}
{{6}}

Sila tekan {{7}} untuk memberitahu mereka anda telah melihat mesej ini.
```

#### `mysenam_booking_reminder`

English (`en`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} link

```text
Hi {{1}}, a reminder of your booking.

Code: {{2}}
{{3}}
{{4}}

Cannot make it? Cancel at {{5}} so somebody else can play.
```

Malay (`ms`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} link

```text
Hai {{1}}, peringatan tentang tempahan anda.

Kod: {{2}}
{{3}}
{{4}}

Tidak dapat hadir? Batalkan di {{5}} supaya orang lain boleh bermain.
```

#### `mysenam_venue_new_booking`

To the venue itself, at the number it chose under *Venue details → New-booking alerts*.

English (`en`) — {{1}} name, {{2}} phone, {{3}} where, {{4}} when, {{5}} code, {{6}} amount, {{7}} paid

```text
New booking.

{{1}}, {{2}}
{{3}}
{{4}}

Code {{5}}, {{6}}, {{7}}. It is on your Bookings list.
```

Malay (`ms`) — {{1}} name, {{2}} phone, {{3}} where, {{4}} when, {{5}} code, {{6}} amount, {{7}} paid

```text
Tempahan baharu.

{{1}}, {{2}}
{{3}}
{{4}}

Kod {{5}}, {{6}}, {{7}}. Ia ada dalam senarai Tempahan anda.
```

## Countries

MySenam runs **one install per country**. `MYSENAM_COUNTRY` (`MY`, the
default, or `SG`) decides everything that differs between them, from one
table in `src/lib/region.ts`:

| | Malaysia (`MY`) | Singapore (`SG`) |
|---|---|---|
| Currency | RM, ringgit | S$, dollars |
| Time zone | Asia/Kuala_Lumpur | Asia/Singapore |
| Phone numbers | +60, written locally with a leading 0 | +65, eight digits |
| Languages | English and Bahasa Malaysia | English |
| Map and address lookups | Malaysia | Singapore |
| Default payment gateway | Billplz (FPX, cards) | Stripe (cards, PayNow) |
| Counter QR scheme | DuitNow QR | PayNow QR |
| SMS prefix | `RM0` | none |
| Terms cite | the laws of Malaysia, the Consumer Protection Act 1999, the Personal Data Protection Act 2010 | the laws of Singapore, the Consumer Protection (Fair Trading) Act 2003, the Personal Data Protection Act 2012 |
| Starter venues on a fresh install | four, in the Klang Valley | none |
| Suggested plan tiers (*Plans by size*) | RM19.90 / 39.90 / 69.90 / 99.90, RM2 a resource past 50 | S$29 / 59 / 99 / 149, S$3 a resource past 50 — a starting point to set, not researched |

- **Money** is shown with `money()` and, in phrases, `{cur}`; nothing writes
  a currency symbol by hand. Amounts are kept in major units to the sen or
  cent (S$4.80, RM18.50; a whole amount shows bare, S$20), prices are checked
  with `isAmount()` and totals rounded with `roundMoney()`, so 4.80 × 3 is
  14.40. A gateway is given the currency with each payment and refuses one it
  does not take.
- **The browser** learns the country from the language provider in the root
  layout, so a client component formats money and phone numbers as the
  server does.
- **Time**: both countries are UTC+8 all year. Times are worked out from the
  zone and that fixed offset, which is right for every country without
  daylight saving; a country with it, or with several zones (Indonesia),
  would need the zone kept per venue.
- **Phone numbers** have one key however they are written (`src/lib/phone.ts`
  and the database's `phone_key()`, migration 0035): `+60 12-345 6789` and
  `012-345 6789` are one number, `+65 9123 4567` and `9123 4567` another, and
  a Singapore landline that begins 60 or 65 stays itself.
- **Not covered by the setting**: the brand name (`SITE_NAME`), and the
  privacy notice and terms, which need a lawyer in each country. Demo data
  (`src/lib/demo.ts`) fills whatever venues the install has, with phone
  numbers in its country's shape.
- **Adding a country** is a row in that table, its dictionary if it speaks a
  new language, and a gateway if it needs one (*Payment gateways*).

## Tax (SST and GST)

Two different taxes pass through MySenam, and neither is MySenam's to decide
(`src/lib/tax.ts`). Rates and numbers are settings, so an accountant's answers
drop in without code.

**A venue's own**, on what customers pay it. A venue registered for SST or
GST sets the tax's name, its rate and its registration number under *Venue
details → Tax* (managers only).

- **Prices stay what customers pay, tax included.** Singapore requires
  GST-inclusive prices to consumers, and Malaysians are used to "RM20 incl.
  SST", so tax never changes what anybody pays, only how it is broken down:
  the tax inside RM21.20 at 6% is RM1.20.
- **Each booking keeps the rate it was taken at.** A trigger sets it on every
  new booking, however it is made (migration 0036), so a later change of
  rate, or deregistering, does not rewrite what was charged.
- **Receipts.** A paid booking has a receipt page, `/receipt/<code>?t=…`,
  behind a link signed with the install's secret rather than the customer's
  phone number. Where the venue charges tax it is titled *Tax invoice* and
  shows the amount before tax, the tax at its rate, the total and the venue's
  registration number. The receipt email links to it and says how much tax
  the payment included; My Booking links to it too.
- **Reports and exports.** The Collected figure says how much tax is inside
  it, at each booking's own rate, and the bookings spreadsheet has each
  booking's rate and tax.
- One rate covers the whole booking, add-ons included.

**The platform's own**, on what it invoices venues. Set `MYSENAM_TAX_RATE`
and `MYSENAM_TAX_REG_NO` once the operator is registered:

- Invoices from then on add the tax on top of the fee (tier prices are before
  tax, as is usual between businesses); `amount` is what the venue pays,
  including it. A business's invoice is taxed on its whole net, worked out
  again as each branch's line is added.
- The rate, name and number are kept on each invoice as they were on the day.
  An invoice issued before registration stays without tax.
- *Billing* links each invoice to a printable page, `/admin/invoices/<id>`,
  for that venue's or business's staff and the platform's owners: a *Tax
  invoice* with the operator's details (`OPERATOR_*`), its tax number, the
  venue's own tax number if it has one, the lines, the total before tax, the
  tax and the total.

**Not built: e-invoicing.** Malaysia's MyInvois exempts businesses under RM3
million in annual sales (from 1 September 2026; they may still opt in), and
any single invoice over RM10,000 needs one regardless. Singapore requires
InvoiceNow from the start for anybody registering for GST voluntarily from
1 April 2026, and from 2028 for others. Either is an API integration with the
tax authority, worth building when the operator is in scope. Until then the
printable invoices and the CSV exports are what an accountant works from.

## Payments

Every booking starts `unpaid` and stands whether or not it is ever paid
online. Front-desk staff mark it `paid` from the admin Bookings tab, picking
**how** in one tap: cash, DuitNow QR / e-wallet, bank transfer or card
terminal (a whole recurring series can be settled the same way). Online
payments, passes and stored credit record themselves. The Reports tab splits
what was collected by method, so the till and the bank account can be squared
at the end of the month; counter payments marked before methods were asked
show as *not recorded*. Customers see the payment
state on `/account` and in the `/my-booking` lookup. The daily view splits
**expected** vs **collected** vs **outstanding** revenue so a shift can be
reconciled at closing.

### Paying online to hold a booking

For venues losing slots to people who never come: under *Venues & staff →
Online payments → Pay online to hold a booking* (`src/lib/holds.ts`), a booking
made online must be paid online within a few minutes (15 unless set, 5–60), or
it is let go for somebody else and the customer is charged nothing.

- The customer sees *Held for you: pay to confirm* and the time it is held
  until, with the button to pay. Paid, it stands and the usual confirmation
  goes out, calendar invite and all; until then nobody is told it is theirs.
- Opening the payment page holds it 30 minutes more from then, so somebody
  part-way through paying is not undercut. On Stripe the page itself closes
  then too, so a slot already let go cannot be paid for; a page opened earlier
  is sent again only while it has time left. Billplz pages cannot be closed: a
  payment that still lands after the hold was let go is listed under *Refunds
  owed*, as for any booking cancelled after paying.
- A held slot comes free on time: holds are let go on the scheduler's tick,
  and on the way past whenever anybody books, searches or opens a day's
  availability. The waitlist is offered it.
- Staff see *held till 3:45 PM* on the booking, and *released (unpaid)* after.
  Bookings staff make at the counter, ones paid at once from credit or a
  pass, and free ones are never held. It needs the venue's Billplz account;
  without one it cannot be turned on.

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

### Payment gateways

Billplz is the first gateway, not the only one the code can have. Everything
gateway-specific sits behind one interface in `src/lib/gateways/`; the rest of
MySenam (what a payment is for, settling it once, money owed back, holds)
never knows which gateway a payment went through.

- **A gateway** implements `PaymentGateway` (`src/lib/gateways/types.ts`): the
  fields a venue types in to connect (and which are secret), a check on them,
  opening a hosted payment page, reading its server-to-server callback (raw
  body and headers, so JSON webhooks with a signature header fit as well as
  Billplz's signed form), reading the customer's redirect back, and the
  platform's own account from environment variables. Adding one is a file
  beside `billplz.ts` and a line in `src/lib/gateways/index.ts`.
- **Callbacks** arrive at `/api/payments/<gateway>/callback`. Billplz's address
  is unchanged, so payment pages already out keep reporting.
- **A report is checked only by the gateway the payment was made through**,
  under the key of the account it was made with. A Billplz page reported as if
  from another gateway is not checked at all.
- **A venue's account** is stored as that gateway's own fields in one JSON
  column, each secret sealed on its own. *Online payment* in the admin shows
  whatever fields the chosen gateway asks for, with a choice of gateway when
  the install offers more than one (`MYSENAM_PAYMENT_PROVIDERS`). Switching
  gateway means entering the new one's keys. Migration 0034 moved existing
  Billplz accounts across without unsealing anything.
- **The currency** comes from the install's country (`MYSENAM_COUNTRY`, see
  *Countries*), and a gateway that does not take it refuses to open a page
  (Billplz takes ringgit only).
- **Verification may ask the gateway.** A report's check can be a signature or
  a call to the gateway's own API, which is how a return address that carries
  no signature is checked.

#### Stripe

The usual gateway for Singapore (cards, PayNow and the wallets a venue turns on
in its Stripe dashboard), through Stripe Checkout, into **the venue's own
Stripe account**.

- **Connecting**: the venue creates a *restricted key* in Stripe with Checkout
  Sessions set to Write, and a *webhook endpoint* pointing at the address the
  settings form shows (`/api/payments/stripe/callback`) for the
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed` and `checkout.session.expired`
  events, and pastes the key (`rk_live_…`) and the endpoint's signing secret
  (`whsec_…`). Unlike Billplz, Stripe has to be told where to report: a
  payment does not carry that.
- **Reports** are believed only with a valid `Stripe-Signature` under that
  venue's signing secret, no more than five minutes old. Other events on the
  venue's account are answered OK and ignored, so Stripe does not retry them.
- **Paid** means Stripe says the session's payment is `paid`. A method that
  confirms later (PayNow can) settles on
  `checkout.session.async_payment_succeeded`.
- **Coming back**: the customer returns to `/payments/return?stripe_session=…`.
  Nothing in that address is signed, so the page asks Stripe for the session
  with the venue's key rather than believing it.
- **The platform's own account** (venues' fees on a marketplace) is
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, with
  `MYSENAM_PAYMENT_PROVIDER=stripe`.

Stripe Connect, where a venue presses *Connect with Stripe* instead of
creating a key and a webhook, would be easier for venues; it needs the platform
registered as a Connect platform, and would replace the two fields with a
connected account id.

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

### Changing the date or time

`rescheduleBooking(code, { date, startHour, courtId? }, by)` moves a booking to
another day or hour — the same length, at the same venue, for the same sport —
keeping its code, its payment, its extras and any promo. It is the step that
otherwise means cancel, refund and book again, with the risk the slot goes
while the customer rebooks.

- **Customers** change their own from `/my-booking` (*Change date or time*),
  with the code and phone number, up to the venue's cancellation cutoff and
  within the booking window. **Staff** use *Change time* on any booking in the
  Bookings tab, at any time before it has finished.
- Only times free for the whole length are offered (`rescheduleOptions`), its
  own court first, then another court of the same sport. The booking's own
  places count as free, so it can slide by an hour.
- **The price follows the court time.** Unpaid, it is repriced at the new
  time's rate, up or down. Paid, it keeps what was paid: a customer cannot move
  it somewhere dearer (that would be peak hours at an off-peak price), and
  staff who do have chosen not to charge the difference.
- Refused for a class place (it moves with its class), an open game with
  players in it, a checked-in booking, or kit still out.
- The customer is told. Changed by the venue, it is urgent news with an
  acknowledge link (`mysenam_booking_rescheduled` on WhatsApp, in the venue's
  *Needs attention* panel until they see it). Changed by the customer, it is an
  email with the new calendar invite. The time it left goes to whoever is
  waiting for it.

## Who a venue is for: public, members only, private

Each venue chooses under *Venues & staff → Who it is for* (`src/lib/access.ts`):

| Mode | Found in search and lists | Who can book | For example |
| ---- | ------------------------- | ------------ | ----------- |
| **Public** (default) | Yes | Anybody | A commercial badminton centre or futsal hall |
| **Members only** | Yes, unless the venue turns that off | Signed-in customers with an active membership here, or on the venue's list | A private club taking new members |
| **Private** | Never | Signed-in customers on the venue's list, and its staff | A condominium's courts, pool or gym |

- **The list** is phone numbers, with a name, a unit or membership number,
  and whether each is a resident, a member or a guest. Staff add people one at
  a time or paste a spreadsheet (`phone, name, unit` a line); a number already
  on the list is updated, not doubled. **Guests** need an end date and drop
  off after it (the daily housekeeping removes them). Up to 5,000 people.
- **Matching is by the phone number on the customer's account** — and, where
  this site checks numbers (*Checking a customer's phone number*), only once
  the customer has checked it, because a number is not identity until
  somebody shows they hold it. Without phone checks, anyone who types a
  number on the list gets in; the editor says so.
- **Members only**: the venue page says *Members only* with the venue's own
  note (how to join, who to ask), and search results carry the badge. Booking,
  enrolling in a class, joining its waitlist, an open game, a tournament or a
  league all need an account that is eligible. Staff still book anyone at the
  counter.
- **Private**: in no search, list, map, classes, games, tournaments or leagues
  page — not even on its own storefront's lists. Its page, availability and
  QR poster answer only its staff and the people on its list; somebody not
  signed in is asked to sign in, without being told whose venue it is, and
  anybody else gets *not found*. Residents find it under *Your private venues*
  on their account page, or from the QR poster on the noticeboard.
- One rule decides what lists show (`LISTED_PUBLICLY` / `listRule` in
  `src/lib/listing.ts`) and one decides who may book (`accessRefusal`), so a
  new page or endpoint has one place to ask.

### Residents inviting their own guests

A members-only or private venue can let the **residents and members on its
list** add their own guests from their account page (*Your guests*), rather
than asking the management office each time. The venue sets two numbers in
the same editor: **guests each at a time** (0 to 10; 0, the default, turns it
off) and **for up to how many days** (1 to 14). Changing them is a manager's job
(`src/lib/guest-invites.ts`).

- A guest goes on the list as a *guest* with an end date (today plus the days
  chosen), and drops off after it like any other guest. The resident can take
  them off early.
- **A guest takes the host's unit.** Their bookings count towards that
  household's house rules, so inviting a friend does not double a unit's
  allowance. This applies even where the host has no unit label, because
  the household also follows who invited whom.
- **Removing a resident removes their guests.** Staff see *Guest of Hafiz* on
  the list. A number staff add themselves becomes staff's entry, not the
  resident's guest.
- A number already on the list stays as it is: a resident, a member, or
  another resident's guest whose visit is still running cannot be taken over.
  Re-inviting one's own guest extends the visit and uses no extra place. A
  guest whose visit has ended can be invited by anyone.
- Guests cannot invite guests, and nobody can invite their own number.
- The guest needs an account with that number (checked, where phone checks
  are on). The resident is shown the venue link to send them.

## Free courts and house rules

**A court can be free.** Rates may be RM0 — a condominium's tennis court, a
club's member-only pool lane. A booking that comes to RM0 owes nothing: it
shows as *Free* to the customer and the desk, is never offered online
payment, and does not count towards the cap on unpaid bookings a number may
hold.

**House rules** (*Venues & staff → House rules*, `src/lib/house-rules.ts`) are a
venue's fair-use limits for online bookings, each blank for none:

| Rule | Example |
| ---- | ------- |
| Bookings coming up at once | 2 — a third waits until one is played or cancelled |
| Bookings a week (Monday to Sunday) | 3 |
| Bookings a day | 1 |
| Days ahead they may book | 7 (0 is today only; the site's own window is 14) |

- **Counted per household.** Everybody the venue's list gives the same unit
  (*Who a venue is for*) shares one allowance: a family in B-07-2 gets two
  bookings a week between them, not two each. Anybody else is counted by the
  number on the booking **and** the account making it, so typing a different
  number does not buy another booking.
- Only court bookings count; a class place is limited by the class.
- Checked when a customer books (every week of a weekly series), and when
  they move a booking to another day. Staff at the counter are not held to
  them.
- The venue page shows them (*House rules: up to 2 a week for each person or
  household; book up to 7 days ahead*), and its dates stop at the last day
  the venue takes bookings for.

## Booking again

Past bookings on `/account` have *Book again*, and the account page opens with
*Play again*: the last few courts and times a customer actually played. One tap
opens the venue page with the same court and hours picked on the **next day
they are free** — the same weekday first, since most regulars play the same
night each week — else another court of the same sport. It is a link, not a
booking: the customer still sees the price and taps *Book*. `/my-booking` has
the same button for a booking looked up by code and phone.

## Your booking link and QR poster

Venue staff see **their booking link** on the Bookings tab, with *Copy link*,
*Share on WhatsApp* and *Print QR poster*. The link is the venue's page on its
storefront domain if it has one. The poster (`/venue/<id>/poster`) prints the QR
code, the link and three steps in English and Malay, for the counter, the door
or the noticeboard. The QR code is also an image at `/api/venues/<id>/qr`. A
draft venue's link, code and poster are for its own staff only.

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

## Signing in with Google

With `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set, the sign-in page
offers *Continue with Google* above the email and password form, which stays.

- **The flow** is OpenID Connect's authorisation code with PKCE, a `state`
  tying the answer to the browser that asked (kept for ten minutes in an
  HTTP-only cookie) and a `nonce` tying the ID token to the request. The token
  comes straight from Google's token endpoint over TLS; its issuer, audience,
  expiry and nonce are checked. Nothing of Google's but the person's id, email
  and name is kept, and no Google token at all.
- **Which account.** Google's id for the person, which never changes, finds
  it. The first time, an existing account with the same email is joined to it
  only if Google says it has verified that email — otherwise anybody could
  create a Google account with somebody else's address and walk into theirs.
  Failing both, a new account is made, with no password and no phone number.
- **Only at the main address.** Google sends people back to the one redirect
  registered with it, so the button is not shown on a venue's own storefront
  domain, where the session would land on another site.
- **Staff** still sign in with email and password, so a venue's dashboard is
  never tied to somebody's personal Google account.

Set it up in Google Cloud: *APIs & Services → Credentials → Create OAuth
client ID → Web application*, with the redirect URI above, and the consent
screen published. Apple's *Sign in with Apple* fits the same shape
(`user_identities` already allows `apple`) once there is an Apple developer
account to configure it with.

## Checking a customer's phone number

A venue rings the number on a booking, confirmations go to it, limits and
blocks are kept by it, and league box-mates are given it — so an account
proves it holds its number, once. *Verify your phone number* offers two ways:

- **Verify via WhatsApp** (recommended). The customer taps the button;
  WhatsApp opens with *Verify my number: V-K7P2QX* ready to send to the
  platform's number; they press send. The message arriving, through the
  webhook, from the number being proved is the proof — stronger than a typed
  code, since it can only come from that phone. Nothing is sent to the
  customer, so it costs nothing and cannot be used to make the site message
  strangers. The page carries on by itself once the message arrives (it checks
  every few seconds); the token lasts 15 minutes. Needs
  `WHATSAPP_CHAT_NUMBER` and `WHATSAPP_APP_SECRET` with the webhook subscribed
  (see *Customers who ask on WhatsApp*).
- **Verify via SMS.** A six-digit code by text, through Twilio or any
  HTTP-GET gateway (`SMS_*`). Every text starts `RM0` and names the site. A
  local Malaysian aggregator is usually several times cheaper per message than
  Twilio for Malaysian numbers. Where no SMS gateway is set up but WhatsApp
  sending is, this option sends the code on WhatsApp instead (an
  authentication template, below).
- **A ceiling on codes.** Codes cost money, so the whole site sends at most
  `MYSENAM_PHONE_CODES_PER_DAY` (300) in a day; past that, customers are asked
  to verify via WhatsApp, and the platform owner is emailed once that day.

- **When.** Not at sign-in: before the first thing that needs it — booking,
  enrolling in a class, opening or joining a game, entering a tournament,
  joining a league — the account is sent to *Your phone number*, and then
  straight back to the same court, day and hour. An account made with Google
  adds its number there.
- **The code** lasts 10 minutes and allows 5 tries; an account may ask for 3
  an hour (6 WhatsApp verifications) and a number be sent 5 a day, so nobody
  can use it to flood a phone. Only a keyed hash of the code is stored, and codes are gone within a
  day.
- **Checked stays checked** until the number on the account changes. If
  another account proves the same number, the first loses its check: only one
  of them can be holding that phone now.
- **Staff see** a ✓ beside a booking's number when it was booked from an
  account that proved that number.
- **Guests** booking one court without an account are not asked, any more
  than at a counter; weekly series already need an account.
- **On** whenever either way is set up (`MYSENAM_PHONE_CHECK=off` turns it
  off). With neither, there is nothing to check with, and numbers are taken
  as given, as before.
- **The template**, only for codes on WhatsApp. In WhatsApp Manager create a template named
  `mysenam_login_code` (or set `WHATSAPP_CODE_TEMPLATE`), category
  *Authentication*, with the *Copy code* button, in English and Malay. Meta
  writes the wording of authentication templates itself; the code goes in as
  its one parameter.

## Forgotten passwords

*Forgot your password?* sits under both sign-in forms — the customer one at
`/login` and the staff one at `/admin` — so a forgotten password is not a
message to whoever runs the site (`src/lib/password-reset.ts`).

- It emails a link to `/reset-password`. The link works **once**, for **30
  minutes**; using it voids any other link still out for that account.
- Only a keyed hash of the token is stored (`password_resets.token_hash`), so a
  copy of the database cannot be used to take an account over. The reset page
  sends no `Referer`, so the token in its address is not passed on.
- Setting a new password **signs the account out everywhere**, then signs in
  the browser that used the link. Whoever had the old password no longer has
  a session.
- The form never says whether an address has an account: the reply is the
  same either way, and the email is sent without waiting on it so the timing
  does not tell either. An account gets at most three links an hour, and the
  endpoints share the sign-in rate limit.
- Customers get the email in their language; staff emails are in English.

Signed in, a password is changed from the account page (*Change password*,
under *Sign out*) or the admin dashboard (under *Sign out*). The current
password is needed, and every other session ends; this one stays. An account
made with Google has no password, so it can set one without giving one —
then it can sign in with email too.

The links go out by email (`SMTP_URL` and `MAIL_FROM`). An install with no email set up cannot
send them; with `MYSENAM_SEND=log` they are written to the server log instead,
which is how to test it locally.

## Session cookies

Both session cookies (`ms_session`, `ms_admin`) are `HttpOnly`, `SameSite=Lax`,
site-wide, and `Secure` — but only when the request is actually on HTTPS.
Marking `Secure` on a plain-HTTP deployment would stop the browser sending the
cookie at all, so the flag follows the connection rather than a build-time
guess: the request's own protocol, or `x-forwarded-proto` behind a proxy.
`SECURE_COOKIES=1` forces it on for a proxy that sets no such header.

Every place that issues a session cookie (signing in, Google, a password
reset) goes through one `sessionCookieOptions()` helper, so another cannot
quietly ship without the flags.

## Rate limiting

Password endpoints and anything addressable by a short code are rate limited
per client IP (`src/lib/rate-limit.ts`), returning `429` with `Retry-After`:

| Endpoint | Budget |
| -------- | ------ |
| Admin & customer sign-in | 10 per 10 min, per IP **and** per email |
| Forgot / reset / change password | Same budget as signing in |
| Registration | 5 per hour |
| Booking lookup / cancel by code | 20 per 10 min |
| Booking creation | 20 per hour |

Counters live in process memory, so each instance keeps its own. A horizontally
scaled deploy should move them to a shared store (Redis) with the same policies.
Client identity comes from `x-forwarded-for`, which is only trustworthy behind a
proxy that sets it.

### Limits that follow the phone number

A phone on mobile data gets a new IP address whenever it likes, so the limits
that matter most follow the number instead (`src/lib/limits.ts`). Numbers are
compared as digits, so `+60 12-345 6789` and `0123456789` are the same.

| Limit | Value |
| ----- | ----- |
| Unpaid bookings coming up, one number, one venue | 3 |
| Unpaid bookings coming up, one number, every venue | 6 |
| The same slot every week | needs a signed-in account |
| Messages to one number or email address | 8 a day; any more are kept, marked not sent |

Paying for a booking, playing it or cancelling it frees its place, and a weekly
series counts once. Staff booking at the counter are not limited.

**Blocked numbers.** A venue can stop a number booking or queueing with it
online: *Block number* on any booking, or under *Venue details → Blocked
numbers*. That person can still ring the venue.

**Order and names.** Venues are listed in an order shuffled once a day, not
alphabetically, so an "AAA" name gains nothing. When a venue operator renames
their venue, every platform owner gets an email.

**Forms.** The venue application and sign-up forms have a field no person
sees; a submission that fills it in is dropped.

**One venue cannot crowd out the rest.** Search shows each venue once per
start time, with its cheapest court, and counts its other free courts rather
than listing them, so adding courts gains a venue no ground. The classes page
shows two weeks ahead and at most six of one venue's sessions a day (a venue's
own page shows all of them). A venue's own staff can add up to 50 courts and
keep up to 300 class sessions in the diary; the platform owner can add more,
and is emailed each time a venue passes another 10 courts or 50 sessions.

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
- Set strong `ADMIN_EMAIL` / `ADMIN_PASSWORD` values before deploying
