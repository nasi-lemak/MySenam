# Backups, off-site copies and restoring

Authoritative for backup and restore. Disaster recovery comes down to these procedures.

## Backups

Everything is in one database. Losing it loses every booking, the credit
ledger, and the record of who opened which door. Venue photos are files, not
rows: with a `PHOTOS_S3_*` bucket they are the bucket's to keep (turn on its
versioning, or the provider's own backups); without one they are in `photos/`
in the data folder, and every snapshot takes them with it (below).

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

**Photos on disk** go into an archive beside the snapshot
(`mysenam-2026-09-26-030000.photos.tar.gz`), which is read back before the
snapshot is kept: every photo on disk when it began must be in it (a
half-written upload is left out). If the photos cannot be archived, the
backup fails as a whole, since a snapshot whose photos are missing is not one
to restore from. The archive is pruned with its snapshot. With a photo bucket
there is no archive.

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
Backblaze B2, Amazon S3, Wasabi. Its photos archive goes first; if that is
refused, the copy is counted as failed, not sent as if it were whole.

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

The photos that went with the snapshot are put back too: the photos folder
there now is moved aside (`photos.replaced-<time>`) and the archive unpacked
in its place. The script ends by counting the bookings and photos it brought
back.

**What is tested** (`tests/backup-scripts.test.ts`, on PGlite and on Postgres
16): a venue's settings, a customer's credit, a booking paid from it and a
photo are backed up with the script; then the booking is cancelled and
refunded, the venue renamed, the photo deleted and the photos folder lost;
then the restore script runs, and every row of the venues, courts, users,
bookings, claims, credit ledger, receipts, online payments and photo tables,
each customer's balance, and each photo file's SHA-256 must equal what was
backed up. Not tested: restoring from the off-site copy, which has to be
fetched from the bucket by hand first.
