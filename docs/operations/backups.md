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
data, not one venue's, and no backup setting or key is shown on a venue's
dashboard.

### Backup health

The top of the Backups panel gives one state, worked out by
`src/lib/backup-health.ts`:

| State | Meaning |
| ----- | ------- |
| *Backups: active* | Off-site copies are going, and the newest is within the recovery-point target |
| *Backups: on this server only* | No off-site copies are set up: a lost disk takes every backup with it |
| *Backups: behind the recovery-point target* | The newest copy that would survive losing the server is older than `MYSENAM_BACKUP_RPO_HOURS` (default 26: the nightly cycle and two hours), or nothing has been copied off-site yet |
| *Off-site copies: paused* | The transfer is not allowed (below), and why |
| *Off-site copies: failing* | The last attempt failed after the last copy, and what the storage said |
| *Backups: none yet* | No snapshot on this server |

The panel also shows that copy's age against the target. The scheduler
checks once an hour and after every backup. It alerts the owners
(`backup-stale`) when the newest copy that would survive is past the target,
or when off-site copies are set up but none has gone. It also alerts
(`offsite-near-limit`) when a set's largest part passes 80% of one upload
([monitoring](monitoring.md)). Every failed or paused copy is written to the
server log and raises the `offsite` alert as it happens.

## Off-site copies

Snapshots beside the database survive a bad deploy and a mistyped `DELETE`; they
do not survive the disk. So each one — the nightly one and every *Back up now* —
is also uploaded to object storage that speaks the S3 API. Backblaze B2 is
the preferred provider and Amazon S3 is supported as well; Cloudflare R2 and
Wasabi speak the same API. All of them use the same code. Its photos archive goes first, then the
database, then the manifest; if any part is refused the copy is counted as
failed and the manifest is not sent, so a set in the bucket without its
manifest is recognisably incomplete. Which provider to choose, with prices and
data locations, is in [launch providers](../integrations/launch-providers.md#off-site-backups).

| Variable | Where | Example |
| -------- | ----- | ------- |
| `OFFSITE_S3_ENDPOINT` | server, restore machine | `https://s3.ap-southeast-5.amazonaws.com`, `https://s3.us-west-004.backblazeb2.com`, `https://<account-id>.r2.cloudflarestorage.com` |
| `OFFSITE_S3_BUCKET` | both | `venue-backups` |
| `OFFSITE_S3_REGION` | both | read from a B2 or S3 endpoint (`us-west-004`, `ap-southeast-5`); set it only for another provider; `auto` otherwise |
| `OFFSITE_S3_PREFIX` | both | `mysenam/` (the default) — one bucket can hold several installs |
| `OFFSITE_S3_ACCESS_KEY_ID` / `OFFSITE_S3_SECRET_ACCESS_KEY` | server only | the **upload-only** key |
| `OFFSITE_S3_READ_ACCESS_KEY_ID` / `OFFSITE_S3_READ_SECRET_ACCESS_KEY` | restore machine only | the **read and list** key |
| `OFFSITE_DATA_LOCATION` | server | the country the bucket keeps data in: `MY`, `SG`, `US`… (required) |
| `OFFSITE_TRANSFER_APPROVED` | server | the same country, once a transfer abroad is approved (below) |
| `OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE` | server | encrypt before upload (below); required for a bucket abroad |
| `OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE` | restore machine only | decrypt after download |
| `OFFSITE_SIGNING_KEY_FILE` | server | sign each manifest (below) |
| `OFFSITE_SIGNING_PUBLIC_KEY_FILE` | restore machine only | refuse sets the server did not sign |

Each part goes up in one PUT, streamed from disk, signed over its SHA-256 and
carrying its MD5 as `Content-MD5` (which buckets with Object Lock require), so
the storage service itself rejects a copy that arrived damaged. One PUT
carries about 5 GB on every provider; a larger part is refused before anything
is sent. Multipart uploads are not implemented, because no part comes near the
limit: the 829 MB benchmark database dumps to 25 MB. The part that can grow is
the photos archive, and only without a photo bucket. The size of the largest
part is recorded with each copy, and the owners are warned at 80% of the limit,
well before a copy is refused; the answer then is a photo bucket. An
interrupted upload leaves nothing under that name, since a single PUT is all
or nothing.

The Backups panel shows:

- where copies go and the country the data is kept in;
- what the endpoint itself names;
- the last copy: whether its manifest went, and whether it was encrypted and
  signed;
- in red, the last failure or why copies are paused.

A failed copy also raises an `offsite` alert ([monitoring](monitoring.md)).

### Where the data may go

Nothing is sent until `OFFSITE_DATA_LOCATION` names the country of the
bucket's region (not the provider's head office). A bucket in the install's
own country (`MYSENAM_COUNTRY`) needs nothing more. A bucket anywhere else is
a transfer of customers' personal data abroad, so the app also needs
`OFFSITE_TRANSFER_APPROVED` set to that same country and the encryption below
switched on; until both are, copies are paused and the panel says why. Set
`OFFSITE_TRANSFER_APPROVED` only once the safeguards in
[privacy](../architecture/privacy.md#backups-held-abroad) are in place and
recorded. Backblaze B2 and Cloudflare R2 have no region in Malaysia or
Singapore; Amazon S3 has both (`ap-southeast-5`, `ap-southeast-1`).

**A typed country is checked against the address.** A B2 endpoint names its
region: `s3.us-west-004.backblazeb2.com` is in the US. So does an S3 one:
`s3.ap-southeast-5.amazonaws.com` is in Malaysia. When the country the
endpoint names differs from `OFFSITE_DATA_LOCATION`, copies are paused with
both named, so a mistyped declaration cannot send data somewhere it does not
say. For other providers (R2, Wasabi, a custom domain) the declaration is all
there is, and the panel says the address names no country.

**Moving to B2 from an existing S3 install:**

1. Make the B2 account in the region chosen
   ([launch providers](../integrations/launch-providers.md#off-site-backups)),
   then the bucket with Object Lock, and the keys below.
2. Put the transfer safeguards in place
   ([privacy](../architecture/privacy.md#backups-held-abroad)).
3. Run `npm run verify-offsite -- --go` against it from a test machine (below).
4. On the server, change `OFFSITE_S3_ENDPOINT`, `OFFSITE_S3_BUCKET` and the
   key, set `OFFSITE_DATA_LOCATION=US` and `OFFSITE_TRANSFER_APPROVED=US`, and
   restart.
5. Check the next copy on the Backups panel, then the first fetch with
   `fetch-backup`.

Leave the S3 bucket until its retention has run out: until the first B2 sets
are older than the recovery point you need, it holds the only earlier copies.

### Keys and Object Lock

The server's key should only upload, and a separate key that may read and
list belongs on the machine you restore from, never on the server:

| | Upload key (server) | Read key (restore machine) |
| --- | --- | --- |
| Backblaze B2 | application key with `writeFiles` only, restricted to the bucket and to the prefix | `listFiles`, `readFiles` and, to see the lock, `readFileRetentions`; same bucket and prefix |
| Amazon S3 | IAM policy allowing `s3:PutObject` on `arn:aws:s3:::<bucket>/<prefix>*` | `s3:ListBucket` (with an `s3:prefix` condition), `s3:ListBucketVersions`, `s3:GetObject`, `s3:GetObjectVersion` |
| Cloudflare R2 | no write-only token exists: *Object Read & Write* on that bucket, which can also read and overwrite | *Object Read only* |

The app never asks the upload key for anything but PUT: it does not check
what it uploaded with a HEAD or GET, list the bucket, or delete anything.
B2 maps the S3 PutObject call to `writeFiles`, and the bucket's default
retention applies to an upload without the uploader setting it, so no other
capability should be needed. A real bucket must confirm this
(`verify-offsite`). Neither key may have `deleteFiles`, `writeFileRetentions`,
`bypassGovernance`, `writeBuckets` or any `*Keys` capability. The account's
master key never goes in any app configuration: it creates the bucket and the
two keys, and is kept with the account owner.

**An upload-only key alone does not protect the copies.** It cannot read or
delete, but it can upload a new version over an existing name (and on B2,
hide a name), and a lifecycle rule then deletes the replaced version. Holding
the public key too (it is on the server), a thief could even upload a whole
fake set that checks out on its own. What keeps earlier copies is
**Object Lock**:

- **B2:** turn on Object Lock for the bucket (it can be enabled on an
  existing bucket, and never turned off) with a default retention of
  **14 days, governance mode**, and a lifecycle rule
  `daysFromUploadingToHiding: 14, daysFromHidingToDeleting: 1`.
- **S3:** turn on versioning and Object Lock with a default retention of
  14 days (governance), and a lifecycle rule expiring current versions
  after 14 days and noncurrent versions 1 day after they become noncurrent.
- **R2:** a bucket lock rule of 14 days on the prefix (R2 has no versions:
  a locked object cannot be overwritten at all).

A locked version cannot be deleted by lifecycle, by the upload key or by
anybody without the bypass permission until its retention ends; lifecycle
removes it after that. The app's own pruning applies to the server's disk,
never to the bucket, so the two do not conflict. Expect 15–16 nights of
copies to be stored at any time, not 14, plus any name written again (each
version is stored and billed).

**Governance mode, 14 days**
([ADR 0015](../architecture/decisions/0015-backblaze-b2-preferred-signed-backup-sets.md)):

- **Why governance.** Neither key holds `bypassGovernance`, so a stolen
  application key can destroy nothing that is locked, exactly as under
  compliance mode. An account owner can still correct a mistake. Compliance
  mode cannot be shortened even by the account owner, so it protects against
  a taken-over Backblaze account too, at the cost of copies that cannot be
  removed. Choose it deliberately, if at all.
- **Why 14 days.** That is how long a compromise can go unnoticed before the
  last copy made before it expires. The backup-health alerts and a
  `fetch-backup --list` that reports rewrites shorten detection. A longer
  retention (30 days) roughly doubles what is stored.
- **What the lock does not cover.** A name hidden or written again stays
  restorable as its first version for as long as that version is locked.
  Recovery points are chosen as below.

**Restoring takes each name's first upload.** The server writes every name
once, so where the bucket's versions can be listed (B2 and S3 with the read
key above), `fetch-backup` fetches each part as first uploaded and reports
any name written again or hidden since: treat that as a stolen upload key
(rotate it). On R2 (no versions) it has only the current copy, and says so.

### Signed manifests

Set `OFFSITE_SIGNING_KEY_FILE` to an Ed25519 private key. The server then
signs each set's manifest and uploads the signature beside it
(`<manifest>.sig`) just before the manifest. On the restore machine,
`OFFSITE_SIGNING_PUBLIC_KEY_FILE` makes `fetch-backup` refuse a set whose
manifest is unsigned or signed by another key. It prints whether the set was
checked. Make the pair on a trusted machine:

```bash
openssl genpkey -algorithm ed25519 -out offsite-signing.pem
openssl pkey -in offsite-signing.pem -pubout -out offsite-signing-public.pem
```

The private key goes on the server, as a file readable only by the app,
like the payment-key secret. The public key goes with the restore kit. To
rotate, give the server a new private key. Sets signed with the old key are
checked by pointing `OFFSITE_SIGNING_PUBLIC_KEY_FILE` at the old public key.

### Threat model: what each protection proves

| Property | What gives it | What it does not prove |
| -------- | ------------- | ---------------------- |
| **Integrity**: the bytes are those uploaded | SHA-256 of every part in the manifest; GCM's tag on each encrypted part; `Content-MD5` checked by the provider on upload | That the manifest itself is genuine: whoever can replace the manifest can replace its hashes |
| **Authenticity**: the server made this set | The Ed25519 signature, made with a key only the server holds | Anything once the server itself is taken over: its key signs whatever it is given |
| **Immutability**: it cannot be changed or removed | Object Lock at the provider; the app's tests use a stand-in, so this rests on the provider's configuration (`verify-offsite`) | Protection past the retention period, or against an account owner under governance mode |
| **Authorised creation**: made in the normal course | Signature, plus the provider's own upload time, which the uploader cannot set; a set first uploaded more than six hours after its manifest's `createdAt` is flagged *first uploaded late* | That the server was not already compromised when it made the set |
| **Recovery-point selection** | `fetch-backup --list --before <time>` shows only sets first uploaded before a time (the provider's clock); each name's first version is restored; rewrites are reported | Which time to choose: that comes from the incident's own evidence |

**Residual limits:**

- **Upload key stolen, server intact.** Earlier sets are safe: locked,
  first-version restore, and fake sets fail the signature. The thief can add
  unsigned sets and versions, which are reported. Rotate the key.
- **Server taken over.** Sets made from then on may carry altered data,
  signed by the server's key. Sets made before are safe for as long as they
  are locked, and are encrypted for a key the server never held. Choose a
  recovery point before the compromise with `--before`, restore onto a new
  server, and then rotate:
  - the upload key;
  - the signing key;
  - `MYSENAM_SECRET`;
  - any credentials in the environment.
- **Backblaze account taken over.** Governance-mode copies can be removed by
  whoever has the master key. Protect that account with two-factor sign-in,
  and keep its master key off every server.

### Recovery keys

The encryption private key (and the signing public key) are what a restore
cannot do without, so they are handled as a procedure, not a setting:

1. **Generate** both pairs on a trusted machine that is not the server
   (commands above and below). Copy only the public encryption key and the
   private signing key to the server.
2. **Keep the private encryption key in two places**, neither of them the
   server, Git, a chat, an application log or the production environment:
   - an organisation password manager entry, readable by the people who
     restore;
   - an offline copy (an encrypted USB key, or a printout) in a different
     place.

   The environment variable on the restore machine holds a file path, not the
   key.
3. **Prove it each quarter.** Fetch and decrypt a set with the restore kit
   (`fetch-backup`, then `restore --drill`). A key that has never been used is
   not known to work.
4. **Rotate** by making a new pair and setting the new public key on the
   server. Keep the old private key until every set encrypted for it has
   expired from the bucket: at least the retention period. The file header
   does not name the key, so a set opened with the wrong key is refused
   (*encrypted for another key*) rather than misread.
5. **If a private key may have leaked**, rotate at once. Sets encrypted for
   it should be treated as readable by whoever took it, until they expire.

### Encryption

Set `OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE` and each database and photos archive
is encrypted on the server before it is uploaded, as `<name>.enc`, streamed
so a large file needs no more memory than a small one: a fresh
AES-256-GCM key per file, itself encrypted with an RSA public key
(RSA-OAEP, SHA-256). The server holds only the public key, so it — or anybody
who takes it over — can encrypt tonight's backup but cannot read an earlier
one. The manifest (hashes and counts, no personal data) stays readable,
marked as encrypted. Create the pair on a machine you trust, not the server:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out offsite-private.pem
openssl pkey -in offsite-private.pem -pubout -out offsite-public.pem
```

Copy `offsite-public.pem` to the server; keep `offsite-private.pem` with the
restore key and in a second safe place (a password manager). **Without the
private key no encrypted copy can be read.** A changed or truncated file
fails GCM's check and is refused rather than restored. File names and sizes
are still visible to the provider. Turn on the provider's own encryption at
rest as well (S3 and R2 do it by default; B2 needs it switched on for the
bucket), and reach it only over HTTPS.

**Secrets.** Venues' payment keys inside the snapshot are sealed, and the key
that unlocks them (`secret.key` in the data folder, or `MYSENAM_SECRET`) is
deliberately not in any backup: **keep a copy of it somewhere else safe**,
or after a restore every venue has to reconnect its gateway. The restore drill
(below) says how many payment keys in a snapshot this install's secret can
open.

### Rotating keys

Create the new key, put it in the environment, restart, and check the next
copy on the Backups panel before deleting the old key (B2: delete the
application key; S3: deactivate then delete the access key). A B2 key can be
given an expiry under 1,000 days. To rotate the encryption pair, set the new
public key: older copies still need the old private key until they expire.

## Recovery point and recovery time

- **Recovery point (RPO): up to 24 hours.** The alert threshold is
  `MYSENAM_BACKUP_RPO_HOURS` (default 26), so an hour or two of scheduling
  slack does not raise one. The nightly snapshot is the only automatic one;
  anything after it is lost if the database is lost. Take one with *Back up
  now* before a risky change. A shorter RPO needs the database
  host's own point-in-time recovery (managed Postgres with WAL archiving),
  which this app does not set up.
- **Recovery time (RTO): measured in parts, not end to end.** The time to
  restore the database locally is not the time to recover from losing the
  server.

| Stage | Measured | Where |
| ----- | -------- | ----- |
| Dump the database | about 16 s for the 829 MB benchmark database, to a 25 MB `.dump` | test machine, local disk |
| Restore it with `pg_restore` into an empty database | about 2 minutes (123 s, 4 CPUs, 919,286 bookings, the count checked against the source) | test machine |
| Download from the bucket, decrypt and check | **not measured against a real bucket**; `npm run verify-offsite -- --go --size-mb 200` times it | restore machine |
| Provision a server, install the app, point DNS | not measured; depends on the host | — |
| Restore drill, restore, start, check today's bookings | the drill prints its own time | restore machine |

Plan for an hour, and replace each row with your own drill's figure. A
restore drill on a test machine does not prove that production can be
recovered ([testing](../development/testing.md) has the benchmark).

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

1. Set `OFFSITE_S3_ENDPOINT`, `OFFSITE_S3_BUCKET`, `OFFSITE_S3_PREFIX`, the
   read key in `OFFSITE_S3_READ_ACCESS_KEY_ID` /
   `OFFSITE_S3_READ_SECRET_ACCESS_KEY` and, for encrypted copies,
   `OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE`, with `OFFSITE_SIGNING_PUBLIC_KEY_FILE`
   for signed ones, in the environment (not on the command line), and
   `MYSENAM_SECRET` or `secret.key` from where you keep it.
2. `npm run fetch-backup -- --list` lists the sets in the bucket, newest last,
   each with when it was first uploaded (the provider's clock), marked whole
   (its manifest is there) or not, encrypted, and written again after upload if
   it was. After a compromise, `--list --before 2026-10-20T00:00` shows only
   sets first uploaded before then.
3. `npm run fetch-backup -- mysenam-2026-09-26-030000.dump --to /srv/restore`
   downloads the manifest and then each part it names (each as first
   uploaded, where versions can be listed), decrypts them, and checks every
   part's SHA-256 against the manifest; it exits non-zero, naming the part, if
   anything is missing, differs, cannot be decrypted, or is not signed by the
   server's key. It says whether the signature was checked, and warns when the
   set was first uploaded long after it was made.
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
- Against a stand-in that behaves as B2 is documented to (`tests/offsite.test.ts`):
  an upload-only key (`writeFiles`, one prefix) sends the set by PUTs alone,
  encrypted, with `Content-MD5`, manifest last, and is refused when it tries to
  read, list or delete; a separate read key and the private key fetch it back,
  decrypt it and pass `verifyBackupSet`; no private key, the wrong one, and a
  changed byte are each refused; after a whole fake set is uploaded over the
  real one with the upload key, the real one is restored and the rewrite
  reported; a key outside its prefix and a part over the size limit are
  refused; and copies are paused until the bucket's country is declared, and
  abroad until the transfer is approved and encryption is on.

- The backup health states, the recovery-point alert and the size warning
  (`tests/backup-health.test.ts`); the endpoint's country checked against the
  declared one; manifests signed and checked, an unsigned or forged signature
  refused, and a set first uploaded late flagged (`tests/offsite.test.ts`).
- `scripts/verify-offsite.mjs` run end to end against the B2 stand-in with
  both keys: every refusal passes. A stand-in key given `readFiles` makes the
  script fail (`tests/offsite.test.ts`).

### Verifying a real bucket

Before B2 or S3 is relied on, run the harness from a test machine (not the
production server), with synthetic data only:

1. Make the bucket with Object Lock and the default retention, the
   upload-only key and the read key (above), and a prefix of its own for the
   test, such as `verify/`.
2. Set every `OFFSITE_*` variable for both keys, with the test encryption and
   signing keys, in the environment.
3. `npm run verify-offsite` prints:
   - where it would send;
   - the provider, region and country the endpoint names;
   - whether the transfer is allowed.

   It sends nothing.
4. `npm run verify-offsite -- --go --size-mb 200 --report verify.json`
   backs up a fresh, empty database of its own (never `DATABASE_URL`'s),
   then checks:
   - it is uploaded encrypted and signed with the upload key;
   - the upload key is refused a read, a listing, a versions listing, a
     delete, a version delete, and a retention change with the governance
     bypass;
   - the read key is refused a delete;
   - the Object Lock mode and date are on what was uploaded;
   - an upload under the same name is kept as a new version, with the first
     restored and the rewrite reported;
   - the set is fetched and decrypted with the read key, checked against its
     manifest, and restored in a drill;
   - how long 200 MB takes up and back.

   It exits non-zero if anything failed.
5. Check by hand what the keys cannot show:
   - the lifecycle rules;
   - that encryption at rest is on;
   - the keys' capabilities in the provider's console.

Record the report with the launch checklist. What it uploads stays locked
until its retention ends.

**Not verified:** any of this against a real bucket. The stand-ins speak the
same requests, but signatures (B2's signing region), key capabilities (that
`writeFiles` alone is enough for PutObject), Object Lock with a default
retention, versions listing, lifecycle rules and download speed are only
proven by running `verify-offsite` and the off-site steps above against the
real provider ([feature status](../product/feature-status.md), launch checklist in
[deployment](deployment.md#launch-integration-checklist)). Local tests do not
show that production can be recovered.
