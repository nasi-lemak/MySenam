# MySenam on one DigitalOcean Droplet

Everything on one machine: Postgres, the app, and Caddy in front of it for
HTTPS. Caddy also issues storefront domains' certificates as they are first
visited. One script sets the machine up; another deploys each new version.

```
visitors ──https──▶ Caddy :443 ──▶ app 127.0.0.1:3000 ──▶ Postgres (localhost only)
                     (certificates)    (systemd: mysenam)      (nightly pg_dump → off-site)
                                              │
                                              └──▶ clamd 127.0.0.1:3310 (supporting documents; started by the app
                                                   while documents wait, on a 2 GB Droplet; freshclam updates it)
```

## What it costs

| | USD / month |
| --- | --- |
| Droplet: Basic, Regular, **2 GB / 1 vCPU / 50 GB**, Singapore | 12 |
| Droplet backups (weekly snapshots of the whole machine), optional | 2.40 |
| Off-site copies on Backblaze B2 (preferred; Amazon S3 supported): the first 10 GB free, then about USD 7 a TB | 0 at first |

The app uses about 250–340 MB and Postgres is set up to use about 300 MB, so
2 GB leaves the operating system room to cache the database. Move to 4 GB
(USD 24) when the database outgrows a few gigabytes, or when pages that list
a lot start to feel slow. DigitalOcean resizes a Droplet in place, with a reboot.

**The malware scanner fits the 2 GB Droplet by running only when needed.**
ClamAV, which checks the documents customers send with applications, holds
its signatures in memory while it runs: about 1 GiB measured (ClamAV
recommends 3 to 4 GiB of RAM for a machine that keeps it running), and a few
hundred megabytes of disk. On this Droplet the setup chooses
`--scanner=on-demand`: the app starts clamd itself when a document waits and
enough memory is free, and stops it a few minutes after the last one is
scanned, and freshclam updates the signatures on a timer, never while clamd
runs. A document sent while clamd is stopped is released about a minute
later instead of at once. On 4 GB or more, `--scanner=always-on` keeps clamd
running (the default there). `--scanner=none` leaves it out: the app then
takes supporting documents into quarantine and nobody can open them, or
approve an application that needs one, until a scanner is set up; there is no
setting to release them unscanned ([deployment](../../docs/operations/deployment.md#choosing-how-clamd-runs)).

## Setting it up

You need a domain you can add DNS records to, and the repository on GitHub.

**1. Create the Droplet.** Ubuntu 24.04 (LTS), Basic, Regular, 2 GB, region
Singapore (SGP1). Authentication: **SSH key**. Tick *Monitoring*. Optionally
tick *Backups*.

**2. Point the domain at it.** An `A` record for the site's address (say
`book.example.my`) with the Droplet's IPv4 address. If the domain is on
Cloudflare, leave the cloud **grey** (DNS only) for now; see *Cloudflare*
below.

**3. Run the setup.** From your copy of the repository:

```bash
scp -r deploy/digitalocean root@<droplet-ip>:mysenam-kit
ssh root@<droplet-ip> bash mysenam-kit/setup.sh \
    --domain book.example.my --email you@example.my \
    --repo git@github.com:<owner>/<repo>.git --branch main
```

It installs Postgres 16, Node 22 and Caddy, and turns on the firewall (SSH, HTTP
and HTTPS only) and automatic security updates. It adds 2 GB of swap as a
safety net, so a build never runs the machine out of memory; it is not
capacity, and nothing is sized to run in it. It installs ClamAV in the mode
chosen for the machine's memory (add `--scanner=on-demand`, `always-on` or
`none` to choose yourself) and, on demand, fetches the first signatures. Then
it creates the database with a generated password and writes the app's
settings to `/etc/mysenam/env`, with a generated `MYSENAM_SECRET`. It finishes
by printing a deploy key.

**4. Let the server read the repository.** On GitHub: *Settings → Deploy keys →
Add deploy key*. Paste the key it printed, and leave *Allow write access*
unticked.

**5. Set the first operator account.** In `/etc/mysenam/env`, fill in
`ADMIN_EMAIL` and `ADMIN_PASSWORD`. While you are there, write down
`MYSENAM_SECRET` somewhere safe, outside the server: venues' saved payment keys
cannot be opened without it.

**6. Deploy.**

```bash
ssh root@<droplet-ip> mysenam-deploy
```

Open `https://book.example.my`. The first visit can take a few seconds while
Caddy gets the certificate. Sign in at `/admin`.

## Day to day

| To… | Run, as root |
| --- | --- |
| Put the latest version live | `mysenam-deploy` (or `mysenam-deploy <tag or commit>`) |
| See what the app is saying | `journalctl -u mysenam -f` |
| Change a setting | edit `/etc/mysenam/env`, then `systemctl restart mysenam` |
| Take a backup now | `mysenam-run npm run backup` |
| Look inside the database | `sudo -u postgres psql mysenam` |
| See Caddy's side | `journalctl -u caddy -f` |
| Check the malware scanner and its signature updates | On demand: `journalctl -u mysenam \| grep 'malware scanner'` (starts and stops), `journalctl -u mysenam-freshclam`, `systemctl list-timers mysenam-freshclam`. Always on: `systemctl status clamav-daemon`, `journalctl -u clamav-freshclam`. The owner's *Supporting documents* panel shows the same |
| Update the signatures now (on demand) | `systemctl start mysenam-freshclam` (it waits for clamd to stop first) |

**Deploying** builds the new version beside the live one, so the site stays up
while it builds. It takes a backup with the live version, switches, and checks
the site answers within a minute. If it does not, the previous version goes
straight back and the deploy fails with the app's last log lines. The last three
versions are kept in `/srv/mysenam/releases`.

**Backups** are taken by the app every night at 03:00 local time with
`pg_dump`, checked by reading them back, and kept in `/var/lib/mysenam/backups`
(the last 14). Copies on the same disk do not survive losing the disk, so set
up off-site copies, through the one S3-compatible setting: **Backblaze B2** is
the preferred provider and Amazon S3 is supported as well
([ADR 0015](../../docs/architecture/decisions/0015-backblaze-b2-preferred-signed-backup-sets.md)).
Create a private bucket with Object Lock and an application key that can only
upload to it, keeping the read key and the decryption key off the server.
Fill in the `OFFSITE_S3_*` lines in `/etc/mysenam/env`, with
`OFFSITE_DATA_LOCATION`; a B2 bucket is abroad (it has no region in Asia), so
nothing is copied until the transfer is approved (`OFFSITE_TRANSFER_APPROVED`)
and copies are encrypted ([backups](../../docs/operations/backups.md#off-site-copies),
[privacy](../../docs/architecture/privacy.md#backups-held-abroad)). Restart, and
press *Back up now* under *Venues & staff → Backups* to see the first copy
arrive. Add a lifecycle rule on the bucket to delete copies after 30 days.

**Restoring**:

```bash
systemctl stop mysenam
mysenam-run npm run restore -- /var/lib/mysenam/backups/mysenam-2026-09-26-030000.dump --force
systemctl start mysenam
```

It keeps a snapshot of what it replaced, beside the others.

## Storefront domains

A storefront's domain needs only an `A` record pointing at the Droplet, made
by whoever owns the domain. Add the storefront under *Venues & staff →
Storefront domains* first. The first visit to the domain then gets its
certificate: Caddy asks the app, and is told yes only for a registered
storefront. `www.` works too, with its own `A` record.

## Cloudflare

Nothing here needs Cloudflare, and it works with Cloudflare as plain DNS (the
grey cloud). Turning the orange cloud on (proxied) puts Cloudflare's network in
front: the Droplet's address is hidden, static files are cached nearer the
visitor, and attacks are absorbed before they reach the machine. If you turn it
on:

1. Set *SSL/TLS → Overview* to **Full (strict)**. Caddy's certificate is a real
   one, so strict works, and anything weaker would let Cloudflare talk to the
   server unencrypted or unverified.
2. In `/etc/caddy/Caddyfile`, uncomment the `servers { trusted_proxies … }`
   block and run `systemctl reload caddy`. Every visitor then arrives from a
   Cloudflare address, and without this block they would all share one rate
   limit for login attempts.
3. After the first certificate renewal (about 60 days), check
   `journalctl -u caddy` for ACME errors. Caddy renews over plain HTTP, which
   Cloudflare passes through.

Storefront domains on other people's Cloudflare accounts can be proxied or not.
If they are proxied, they also need *Full (strict)*.

Cloudflare Workers are not used: the app needs a long-running Node.js process
and a database connection, which is what the Droplet is for.

## Moving an install here

**From another Postgres install** (another Droplet, say): take a backup there, copy the `.dump` here, and restore it as
above. Put the old install's `MYSENAM_SECRET` into `/etc/mysenam/env` in place
of the generated one, so saved payment keys still open.

**From the SQLite version** (an install with a `mysenam.db` file): stop it and
copy the file into `/var/lib/mysenam/` on the Droplet, with its `-wal` file
if there is one beside it. In `/etc/mysenam/env`,
replace the generated `MYSENAM_SECRET` with the old install's key. That is its
own `MYSENAM_SECRET` if it had one, or otherwise the
contents of the `secret.key` file beside its database. Then:

```bash
chown mysenam: /var/lib/mysenam/mysenam.db
mysenam-run npm run import-sqlite -- /var/lib/mysenam/mysenam.db
systemctl restart mysenam
```

The import checks that this install's key opens the old install's saved payment
keys before it copies anything. Then it copies every table in one transaction
and counts them on both sides. Once the new site is checked, the old file can
go; nothing reads it again.

## What is where

| Path | What |
| --- | --- |
| `/etc/mysenam/env` | The app's settings and secrets (readable by root and the app only) |
| `/etc/mysenam/deploy.conf` | The repository and branch `mysenam-deploy` uses |
| `/srv/mysenam/current` | The live version; `releases/` holds the last three |
| `/var/lib/mysenam/backups` | Nightly and pre-deploy backups |
| `/etc/caddy/Caddyfile` | Caddy's configuration |
| `/etc/postgresql/16/main/conf.d/mysenam.conf` | Postgres sized for this machine |
| `/etc/mysenam/clamd-ondemand.conf` | On demand: clamd as the app starts it, on 127.0.0.1:3310; signatures in `/var/lib/clamav` |
| `/var/lib/mysenam/scanner/` | On demand: the app's clamd lock and freshclam's, so the two never run together |
| `/usr/local/sbin/mysenam-freshclam`, `/etc/systemd/system/mysenam-freshclam.{service,timer}` | On demand: signature updates twice a day, waiting for clamd to stop |
| `/etc/clamav/clamd.conf`, `/etc/systemd/system/clamav-daemon.socket.d/mysenam.conf` | Always on: the malware scanner, listening on 127.0.0.1:3310; signatures in `/var/lib/clamav` |
| `/var/lib/mysenam/backups/erasure-ledger.jsonl` | Erasures, applied again after a restore |
| `/etc/systemd/system/mysenam.service` | How the app is run |
