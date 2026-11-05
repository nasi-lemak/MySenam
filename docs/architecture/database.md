# Database

Authoritative for how the schema is kept and changed. Why Postgres (and PGlite
in development) is [ADR 0001](decisions/0001-postgres-in-production-pglite-in-development.md);
why not TimescaleDB is [ADR 0004](decisions/0004-plain-postgres-not-timescaledb.md).

## Migrations

- The schema is the numbered SQL files in `db/migrations/`
  (`0001_initial.sql` onwards), applied in name order, each once, recorded in
  `schema_migrations` (`src/lib/db.ts`).
- They run on the first database query after the app starts. On Postgres they
  run under an advisory lock, so two instances starting together do not both
  apply one; each file runs in its own transaction.
- **A released migration is never edited or deleted.** Change the schema with
  a new file; write it to be safe to run on a database that already holds
  data (`IF NOT EXISTS`, backfills in the same file).
- There is no down-migration. Take a backup before deploying a version with
  new migrations ([deployment](../operations/deployment.md#upgrading)).

## Conventions that matter

- **Times are text.** Timestamps are stored as UTC text
  `YYYY-MM-DD HH:MM:SS`, produced by an SQL function `datetime()` defined in
  `0001_initial.sql`, so they sort and compare as strings. A value written in
  another shape (for example ISO text with a `T`) compares wrongly against
  `datetime('now')`, so write such columns through `datetime()` or in that
  exact form.
- **Dates and times of day are the venue's own.** A booking's `date` and
  `start_min`/`end_min` are its business day and minutes from that day's
  midnight in the venue's time zone, past 1440 after midnight
  ([booking](../features/booking.md#hours-by-weekday-and-after-midnight)).
  Court time itself is a `tstzrange` of real moments on each claim
  ([booking time model](booking-time-model.md#time)).
- **Money** is `NUMERIC(12,2)` in the currency's major unit (ringgit or
  dollars); arithmetic is rounded to the cent (`roundMoney` in
  `src/lib/region.ts`).
- **Phone numbers** are compared through the SQL function `phone_key()`
  (latest definition in `0066_phone_key_00.sql`), stored as a generated
  column where a table is searched by number.
- **Ledgers are append-only.** Stored credit (`wallet_entries`) and pass
  entries are sums of rows, never a balance column.
- **Court time is claims.** `claims` and `coach_claims` carry the database's
  own refusals of overlapping time (exclusion constraints), of time within a
  neighbour's minimum separation (`claim_gaps_apart` on `claim_gaps`, rows
  triggers keep in step with `claims`, migration 0119), of a shared
  facility over capacity (trigger `claims_capacity`) and of anyone in a
  facility while it is turned over whole (`facility_gaps_clear` and
  `facility_gaps_work` on `facility_gaps`, migration 0131); triggers keep a claim's
  court, space and venue consistent and a court's own space in step with its
  capacity (migrations 0089 and 0090).
- **Who supervises a session is a roster, worked out and recorded.** `roster_roles`,
  `roster_qualifications`, `roster_shifts` and `roster_exceptions` are what a venue rosters,
  `supervision_rules` what needs somebody on shift, and `session_supervisors` the record kept on a booking or class
  session of who supervised it (rows are deactivated, never deleted). What is covered is worked out from them
  each time and never stored; a booking asks under the venue's roster lock, an advisory transaction lock taken
  before the court locks and the coach's (migration 0277,
  [ADR 0036](decisions/0036-who-supervises-a-session.md)).
- **Court time that is over is archived, not kept in `claims`** (off unless
  `CLAIMS_ARCHIVE_AFTER_DAYS` is set): [below](#archiving-past-claims).
- **Activities are a table.** Every column naming an activity (`sport`, kept
  under that name) has a foreign key to `activities(key)`; what a court offers
  is `court_activities`, and triggers keep its main activity among them and
  the `courts.activities` list in step. `bookings.sport` and `classes.sport`
  default to the court's main activity when not given (migration 0092,
  [ADR 0011](decisions/0011-activities-as-data.md)). The built-in rows are
  written by the application at every start. Checks on `courts` refuse a
  resource with places priced per player and a court booked whole priced
  flat (migration 0093).
- **People are ids, never contact details.** A participant (somebody who
  takes part other than the account holder) is a row in `participants`;
  who may act for them is `participant_guardians` (migration 0138). Who takes
  a place on a booking is `booking_participants` (migration 0139):
  `bookings.participant_id` and `participant_name` are a summary a trigger
  keeps in step with it, never written by code. A waiting-list entry names its people
  the same way (`waitlist_participants`, with `waitlist.places`, migration
  0146), and attendance per person hangs off a booking's places
  (`place_attendance`, 0147). Inductions, sign-offs and
  waiver signatures name a participant by id, a flag keeping a participant's
  record a participant's when their row goes (migration 0140). A phone number
  finds the number holder's own records, or candidates for staff to choose
  from; it never merges people or moves a record between them
  ([ADR 0023](decisions/0023-participants-apart-from-accounts.md)).
- **Migration steps.** Where a migration needs the application (a venue's
  time zone from its pin, checking a conversion), a step in
  `src/lib/db-steps.ts` runs straight after that migration's SQL in the same
  transaction; if it throws, the migration is undone.

## Archiving past claims

`claims` has a row for every interval a court was ever held, and it cannot be
partitioned by month: a partitioned table's exclusion constraint must include
the partition key by equality, which a booking past midnight crosses
([ADR 0004](decisions/0004-plain-postgres-not-timescaledb.md)). Court time
that is over decides nothing, so a scheduled job moves it into
`claims_archive` (migration 0267, `src/lib/claims-archive.ts`). It is **off
unless the install sets `CLAIMS_ARCHIVE_AFTER_DAYS`** (90 is a good value:
[configuration](../development/configuration.md)); an install that never sets
it keeps every claim in `claims`, as before. It is an install setting, not a
venue's: nothing changes for what a venue or customer can do.

**The table.** `claims_archive` has the columns of `claims`, in their order,
and one more, `archived_at`; the same checks; the same foreign keys with the
same `ON DELETE CASCADE` (a booking's checked at commit, as every row pointing
at a booking is, [booking concurrency](booking-concurrency.md#status-of-each-guarantee)).
It has no exclusion constraint, no capacity or separation trigger and no gap
rows: those are what make a live claim dear, and what an archived one has no
use for. It is indexed by venue and date, by space and by court and the moment
the time ends (the two reads the day's board makes), and by what each kind
belongs to. `claims_all` is the two together, with the columns listed. A test
(`tests/claims-archive.test.ts`) fails when a column is added to `claims`
without being added to the archive and the view.

**What moves.** A claim moves only when all of these hold; one condition
counts what is due and moves it (`eligibleClaims`):

- its `occupied` time has an end, and the end is more than the horizon ago
  (30 days at the least: a smaller number is raised to 30, a number that is not
  a whole one switches the archive off). An outage with no last day has no
  end and never moves;
- what holds it is finished or cancelled: a booking that is not held for
  payment (confirmed, unpaid, with a hold still set), has no online payment
  still pending from the last 30 days, no payment dispute not won, and is
  not on an application under a legal, safety or dispute hold
  ([retention](privacy.md#applications-to-be-approved-for-an-activity)); a class, block or outage that is over; a
  waiting-list offer that was claimed, expired or cancelled; a proposed move
  that is no longer pending; an approval application's slot once the
  application is decided and no hold is in force;
- no other transaction is changing the row (`FOR UPDATE SKIP LOCKED`): a run
  never waits for a booking, and a booking never waits for a run.

Nothing that can still affect availability is touched: a claim that ended
before the horizon has no later claim that could overlap it, because a booking,
a move or an outage refuses a start in the past (`SLOT_PAST`). A block may be
placed over time that has gone; one over archived time is not checked against
it, and changes no booking.

**How.** The scheduler (every tick, on the instance that holds the lease)
calls `archiveClaimsIfDue`. A run moves up to 20 batches of 500 claims, oldest
first; each batch is one transaction that deletes the live rows and inserts
the archive's in a single statement, so a claim is in exactly one table. A
crash leaves the batch undone and nothing else: there is no state to resume
from, because what has moved is no longer there to move, and running again at
any time is safe. After a run that left nothing due, the next waits an hour;
after one that stopped at its limit, the next tick carries on; after a failure,
ten minutes. The deletes fire the triggers that remove the claim's gap rows.
On Postgres the migration creates `idx_claims_ended` on `claims` (a write lock
on the table while it builds; the upgrade does it once).

**What reads the past.** Each reader either reads `claims_all` or stays on
`claims`, because it never looks at time that old; the tests prove each.

| Reader | Reads | Why |
| ------ | ----- | --- |
| `occupantsOn` (availability, search, the board and schedule for a day, moves, waiting lists) | `claims` for a day within 25 days of today; `claims_all` for an older one | Every claim that ends within the horizon is live, and the horizon is never less than 30 days, so nothing that could matter is missed; the schedule of a day long gone shows what it showed |
| Utilisation and occupancy reports (`venueReport`, `utilisationByDay`, the occupancy grid) | Bookings from `bookings`; blocks and outages through `claims_all` | The period asked for may be as old as the venue |
| Booking history, a customer's list, data export, erasure and anonymisation | `bookings` and their own tables, not claims | A claim holds no name, number or address; nothing in the archive is personal data |
| Retention by purpose, erasure of an account, a venue's data | The foreign keys | Deleting a booking, waiting-list entry, class, block, outage, application, court or venue deletes its archived claims by the same cascade; a booking or other source let go after it was archived has its archived claim let go too (`release`, `unclaim`), so the archive says what the live table would |
| Legal holds and disputes | The job itself | A held or disputed claim is never moved (above) |
| Integrity check, scheduled daily and on request | Live claims, from yesterday on; and the archive for time that has not ended | A mismatch of a booking and its court time matters only from yesterday on; `claim_archived_early` finds archived time that could still matter (a hand-edited row, half a restore) |
| Backup, restore drill | The whole database | `claims_archive` is in the dump or the PGlite copy; the drill counts it (a backup from before migration 0267 has none) |
| Linking courts, outages, rain-outs, entries, tournament holds, repeated blocks, changing a court's capacity | `claims` | They look from now on |
| The migration step of 0090 | `claims` | Runs once, before any archive exists |

**Watching it.** A failed run raises the alert `scheduler:claims-archive-failed`,
and due claims that have waited three days or more past the horizon (the
job is not keeping up, or has stopped) raise `claims-archive-behind`; both
appear on the owner's *System health* panel, by email and on the alert webhook
([monitoring](../operations/monitoring.md)). `GET /api/admin/system` carries
`claimsArchive`: the days in force (0 is off, and whether the setting was
raised or refused), when it last ran, how many it moved, how many are due (to
1,000), whether it is behind, and the last failure.

**Measured**, once, on Postgres 16 in the development container (not a
server): 300,000 bookings of one claim each over 100 courts, half of them
more than 90 days old; a batch of 500 took a median of 41 ms (95th percentile
59 ms, worst 74 ms over 100 batches); the next batch is found by an index scan
of 500 rows; `occupantsOn` for a day today and for a day 400 days ago (through
`claims_all`) read in the same time as before the move (about 50 ms for 20
courts). That is one machine and one synthetic fill, not production. The
table and its indexes shrink only when Postgres is vacuumed (`VACUUM FULL`
returned 7 MB of 43 for 50,000 moved claims; plain vacuum reuses the space but
does not return it), so the benefit is to scans, indexes and the working set
rather than disk, until it is.

## Engines

The same migrations run on PGlite and on Postgres 16+, and CI runs the suite
on both ([testing](../development/testing.md)). Anything engine-specific must
work on both; PGlite has no extensions beyond what it bundles.

On Postgres the app keeps a pool of connections (`DATABASE_POOL_SIZE`, ten by
default). A connection cut while it waits in the pool is thrown away and
replaced; one cut while a transaction holds it (the server restarting, an
administrator ending it) fails that transaction, which is not committed, and
is thrown away rather than handed to the next request, without stopping the
process (`tests/db-connection-lost.test.ts`). The server needs
`max_locks_per_transaction` of 256 or more for a restore, which locks every
table, index and sequence in one transaction
([`deploy/digitalocean/postgresql.conf`](../../deploy/digitalocean/postgresql.conf);
[below](#the-lock-table-on-the-2-gb-droplet)).

### The lock table on the 2 GB Droplet

Postgres keeps one lock table in shared memory, sized when it starts:
`max_locks_per_transaction` × (connections + background processes +
prepared transactions), shared by every session, so one transaction may use
far more than its "per transaction" number while others use few. With the
kit's settings (`max_connections` 40, the defaults for autovacuum, worker
and WAL-sender processes, no prepared transactions) that is 62 × the
setting. Measured on 28 October 2026 on Postgres 16 with the kit's
configuration file (`postgres -C shared_memory_size`, a throwaway cluster on
the development container, not the Droplet):

| `max_locks_per_transaction` | Lock slots | Shared memory Postgres asks for at start |
| --------------------------- | ---------- | ---------------------------------------- |
| 64 (the default) | 3,968 | 276 MB |
| 128 | 7,936 | 278 MB |
| **256 (the kit)** | **15,872** | **281 MB** |
| 512 | 31,744 | 286 MB |

Nearly all of it is `shared_buffers` (256 MB); 256 lock slots per process
cost about 5 MB more than the default, taken once when the server starts
and not growing with use. A restore of the schema at migration 0207, loaded
in one transaction as `scripts/restore.mjs` does (`--single-transaction`),
held **3,678 locks on 1,117 relations** at its end: 93% of the default's
slots on its own, so a restore at 64 succeeds today only while nothing else
holds locks, and fails ("out of shared memory") as the schema grows or
beside a busy app. At 256 the same restore uses under a quarter.

On the 2 GB Droplet, the 281 MB is inside the "up to about 300 MB" the
deployment's memory budget already gives Postgres
([deployment](../operations/deployment.md#the-malware-scanner)); nothing else
changes. What this does not show: the Droplet's own memory under load, which
only a measurement on it can (local tests and these figures are not that
proof); and per-connection memory (`work_mem`, each session's own lock
cache), which grows with what each query does, not with this setting. No
upsizing is needed for it; none has been made.
