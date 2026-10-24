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

**Each snapshot is a set**: the database, its photos archive if there is one,
and a manifest (`mysenam-2026-09-26-030000.manifest.json`) naming each part
with its size and SHA-256, the number of photos and the number of bookings.
The manifest is written last, once both parts are in place and verified, so a
manifest beside a snapshot means the set is whole. Before anything is restored
the set is checked against it: a missing photos archive, or either part
changed since it was taken (a damaged disk, a truncated download), refuses the
restore and says which part. A snapshot from before manifests were written is
still restorable, with a warning that nothing can say whether its photos
belong to it. The Backups panel marks each snapshot *Whole* or not.

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
Backblaze B2, Amazon S3, Wasabi. Its photos archive goes first, then the
database, then the manifest; if any part is refused the copy is counted as
failed and the manifest is not sent, so a set in the bucket without its
manifest is recognisably incomplete.

| Variable | Example |
| -------- | ------- |
| `OFFSITE_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com` |
| `OFFSITE_S3_BUCKET` | `venue-backups` |
| `OFFSITE_S3_REGION` | `auto` for R2 (the default); the bucket's region for B2 and S3 |
| `OFFSITE_S3_ACCESS_KEY_ID` / `OFFSITE_S3_SECRET_ACCESS_KEY` | A key for that bucket |
| `OFFSITE_S3_PREFIX` | `mysenam/` (the default) — one bucket can hold several installs |

The upload is streamed from disk and signed over the file's SHA-256, so the
storage service itself rejects a copy that arrived damaged. The Backups panel
shows the last copy (and whether its manifest went), and in red the last
failure; a failed copy also raises an `offsite` alert
([monitoring](monitoring.md)), so an upload that has been failing quietly is
visible long before the day it is needed.

**Nothing off-site is ever deleted by the app.** Set a lifecycle rule on the
bucket to expire old copies (30 days is plenty), and give the app a key that
may only *write* to the bucket. Then somebody who takes over the server cannot
reach back and delete the copies that would undo the damage.

**Encryption and secrets.** The app does not encrypt the snapshot itself.
The backups hold customers' names, phone numbers and email addresses: keep the
bucket private, turn on the provider's encryption at rest (R2 and S3 do it by
default; B2 needs server-side encryption switched on for the bucket), and
reach it only over HTTPS. Venues' payment keys inside are sealed, and the key
that unlocks them (`secret.key` in the data folder, or `MYSENAM_SECRET`) is
deliberately not in any backup: **keep a copy of it somewhere else safe**
(a password manager), or after a restore every venue has to reconnect its
gateway. The restore drill (below) says how many payment keys in a snapshot
this install's secret can open.

## Recovery point and recovery time

- **Recovery point (RPO): up to 24 hours.** The nightly snapshot is the only
  automatic one; anything after it is lost if the database is lost. Take one
  with *Back up now* before a risky change. A shorter RPO needs the database
  host's own point-in-time recovery (managed Postgres with WAL archiving),
  which this app does not set up.
- **Recovery time (RTO): measured, not guaranteed.** On the test machine
  (shared CPU, local disk) the 829 MB benchmark database
  ([testing](../development/testing.md)) took about 16 s to dump to a 25 MB
  `.dump`, and about 2 minutes (123 s, 4 CPUs, 919,286 bookings, the count checked
  against the source) to restore with `pg_restore` into an empty
  database. Add the download from the bucket, the photos, and the time to stop
  the app, run the drill, restore and check: plan for an hour, and time your
  own drill (`--drill` prints how long the restore took).

## Restoring

```bash
# Stop the app first.
npm run restore -- /var/lib/mysenam/backups/mysenam-2026-09-26-030000.dump --force
```

The script refuses a file that is not a backup it could restore, refuses a
set that does not match its manifest, prints what it is about to replace, and
does nothing at all without `--force`. While an app instance still holds the
scheduler's lease (it renews it every minute,
[architecture](../architecture/overview.md#more-than-one-instance)) it
refuses too: stop every instance and wait three minutes, or pass
`--app-stopped` when you are sure. That lease is only held where the
scheduler runs, so it is a backstop, not a substitute for stopping the app.
A `.dump` goes
back into the server in `DATABASE_URL` with `pg_restore`, in one transaction:
all of it or none of it. Before it touches anything it takes a fresh snapshot
of what is there, and a PGlite folder it replaces is moved aside rather than
deleted, because the worst restore is the one that turns out to have used the
wrong file.

The photos that went with the snapshot are put back too: the photos folder
there now is moved aside (`photos.replaced-<time>`) and the archive unpacked
in its place. The script ends by counting the bookings and photos it brought
back.

### A restore drill

```bash
npm run restore -- /path/to/mysenam-2026-09-26-030000.dump --drill
```

restores the set somewhere it can do no harm — a database of its own on the
Postgres server in `DATABASE_URL` (`mysenam_drill_<time>`, dropped
afterwards), or a temporary PGlite copy — unpacks its photos into a temporary
folder, counts venues, courts, users, bookings, claims, the credit ledger,
receipts, online payments and photos, compares the bookings and photos with
the manifest, checks whether this install's secret opens the venues' payment
keys, and prints how long it took. Nothing live is touched. Run it against a
staging server (point `DATABASE_URL` at it) rather than production: it needs
the right to create a database, and a large restore competes with live
traffic.

### Restoring from the off-site copy

Do this on a machine that is not the one that failed, with a key that may
**read and list** the bucket (the server's own key should only upload). The
same steps are the quarterly drill: they are how you find out the copies
work before you need them.

1. Set `OFFSITE_S3_ENDPOINT`, `OFFSITE_S3_BUCKET`, `OFFSITE_S3_REGION`,
   `OFFSITE_S3_PREFIX` and the read key in `OFFSITE_S3_ACCESS_KEY_ID` /
   `OFFSITE_S3_SECRET_ACCESS_KEY` in the environment (not on the command
   line), and `MYSENAM_SECRET` or `secret.key` from where you keep it.
2. `npm run fetch-backup -- --list` lists the sets in the bucket, newest last,
   each marked whole (its manifest is there) or not.
3. `npm run fetch-backup -- mysenam-2026-09-26-030000.dump --to /srv/restore`
   downloads the manifest and then each part it names, and checks every part's
   SHA-256 against it; it exits non-zero, naming the part, if anything is
   missing or differs.
4. Point `DATABASE_URL` at an isolated Postgres server (a staging instance, or
   a new empty one) and run
   `npm run restore -- /srv/restore/mysenam-2026-09-26-030000.dump --drill`.
   It must print *Drill passed* with the counts you expect and `unreadable 0`
   payment keys.
5. To recover for real: provision the new server, set `DATABASE_URL` to it,
   keep the app stopped, and run
   `npm run restore -- /srv/restore/mysenam-2026-09-26-030000.dump --force`;
   then start the app and check today's bookings.

**What is tested** (`tests/backup.test.ts`, `tests/offsite.test.ts`,
`tests/backup-scripts.test.ts`, on PGlite and on Postgres 16):

- A venue's settings, a customer's credit, a booking paid from it and a photo
  are backed up with the script; then the booking is cancelled and refunded,
  the venue renamed, the photo deleted and the photos folder lost; then the
  restore script runs, and every row of the venues, courts, users, bookings,
  claims, credit ledger, receipts, online payments and photo tables, each
  customer's balance, and each photo file's SHA-256 must equal what was backed
  up.
- The manifest names each part's hash; a missing photos archive, a changed
  archive and a changed database are each detected; pruning removes the
  manifest with its snapshot.
- A set is copied to a stand-in S3 service (manifest last), listed and
  fetched back with `fetch-backup`, hashed against its manifest, and drilled
  with `restore --drill` while the live database stays exactly as it was; a
  photos archive damaged in the bucket is caught by the fetch, refused by the
  restore and failed by the drill; and a restore while an instance holds the
  scheduler's lease changes nothing.

**Not verified:** any of this against a real bucket. The stand-in speaks the
same requests, but signatures, permissions, lifecycle rules and download
speed are only proven by running the off-site steps above against the real
provider ([feature status](../product/feature-status.md), launch checklist in
[deployment](deployment.md#launch-integration-checklist)). Local tests do not
show that production can be recovered.
