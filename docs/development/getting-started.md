# Getting started

Run MySenam on your own machine. Node 22 is what it is developed against;
`.nvmrc` pins it.

```bash
npm install
cp .env.example .env.local   # optional: every value has a working default
npm run dev
```

Open http://localhost:3000. With no `DATABASE_URL` the database is PGlite in
`data/pglite`; it is created and migrated on first request and, in Malaysia
(the default `MYSENAM_COUNTRY`), seeded with four starter venues (Petaling
Jaya, Subang Jaya, Bangsar, Putrajaya). PGlite is
for development: running Postgres inside the app's own process costs it the
best part of a gigabyte of memory, against about 250 MB with a server.

Sign in to the staff dashboard at `/admin` with `ADMIN_EMAIL` /
`ADMIN_PASSWORD` (defaults `admin@mysenam.my` / `mysenam-admin`; see
[authentication](../architecture/authentication.md#admin-access)). Messages to
customers go nowhere until email or WhatsApp is configured; set
`MYSENAM_SEND=log` to see them in the server log.

Nothing has been *booked* at those venues, though, so every admin tab opens
empty. Sign in at `/admin` and the dashboard offers to fix that: **Load demo
data** writes a plausible fortnight either side of today — bookings across every
sport, a class with a roster, passes, a membership, a promo code, arrivals, a
no-show, a maintenance block and a public holiday. It is deterministic, so the
same install always produces the same fortnight.

The offer appears only while nothing has been sold, and the endpoint behind it
refuses once anything has, so invented customers can never turn up in a working
venue's day list.

## Everyday commands

| Command | What it does |
| ------- | ------------ |
| `npm run dev` | Development server on port 3000 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | The whole suite on PGlite; see [testing](testing.md) |
| `npm run docs:check` | Checks the documentation's links and references; see [testing](testing.md#documentation-checks) |
| `npm run build` | Production build |
| `npm start` | Serves the build; see [deployment](../operations/deployment.md) |
| `npm run backup`, `npm run restore` | See [backups](../operations/backups.md) |
| `npm run import-sqlite` | Only for an install from before Postgres; see [legacy installs](../archive/migrations/legacy-installs.md) |

`npm run lint` is declared but no ESLint configuration is committed, so it is
not a working check and CI does not run it.

Before changing behaviour, read [`AGENTS.md`](../../AGENTS.md): documentation,
feature status and tests change with the code.
