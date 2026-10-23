# Backups, off-site copies and restoring

Authoritative for backup and restore. Disaster recovery comes down to these procedures.

## Backups

Everything is in one database. Losing it loses every booking, the credit
ledger, and the record of who opened which door. Venue photos are not in it: they are
files, in their bucket when `PHOTOS_S3_*` is set and otherwise in `photos/` in
the data folder, which no backup copies; copy that folder yourself or set a
bucket ([known limitations](../roadmap/known-limitations.md), S10).

```bash
npm run backup                       # one snapshot, verified, oldest retired
npm run backup -- --keep 30          # keep more
npm run backup -- --dir /mnt/backups # somewhere else
```

**The server takes one every night by itself**, at 03:00 in the install's own country (`MYSENAM_COUNTRY`)
(`MYSENAM_BACKUP_HOUR`), and catches up as soon as it is back if it was down at
the hour. Hosts like Render cannot point a cron job at a web service's disk, so
the schedule lives in the app: `next start` ticks once a minute and does what is
due, which also sends any customer messages waiting to go and starts and ends
league seasons on their dates (with it off, staff start and end them from the
dashboard). Set
`MYSENAM_SCHEDULER=off` to run `npm run backup` from your own cron instead.
Several servers sharing one database do not need this: only the instance
holding the scheduler's lease does scheduled work
([architecture](../architecture/overview.md#more-than-one-instance)). With the
scheduler off, the rest of its work (sending messages, releasing unpaid holds,
settling interrupted refunds, invoices, offers) happens only lazily, when requests or dashboard buttons
trigger it (`src/lib/scheduler.ts`). The backup then needs a cron line such as:

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
Snapshots are named by local time (`mysenam-2026-09-26-030000.dump`); a second
one in the same second, such as the copy a restore keeps of what was there,
gets `-2` after the time.

A platform owner can see the same list under *Venues & staff → Backups*, take
one by hand before a risky change, and is told in red when the newest snapshot
is more than two days old. Venue operators cannot: a backup is every venue's
data, not one venue's.

## Off-site copies

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

## Restoring

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
