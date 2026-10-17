# MySenam on one DigitalOcean Droplet

Everything on one machine: Postgres, the app, and Caddy in front of it for
HTTPS. Caddy also issues storefront domains' certificates as they are first
visited. One script sets the machine up; another deploys each new version.

```
visitors ──https──▶ Caddy :443 ──▶ app 127.0.0.1:3000 ──▶ Postgres (localhost only)
                     (certificates)    (systemd: mysenam)      (nightly pg_dump → off-site)
```

## What it costs

| | USD / month |
| --- | --- |
| Droplet: Basic, Regular, **2 GB / 1 vCPU / 50 GB**, Singapore | 12 |
| Droplet backups (weekly snapshots of the whole machine), optional | 2.40 |
| Off-site copies on Cloudflare R2: free under 10 GB | 0 |

The app uses about 250 MB and Postgres is set up to use about 300 MB, so 2 GB
leaves the operating system room to cache the database. Move to 4 GB
(USD 24) when the database outgrows a few gigabytes, or when pages that list
a lot start to feel slow. DigitalOcean resizes a Droplet in place, with a reboot.

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
and HTTPS only) and automatic security updates. It adds 2 GB of swap, so a build
never runs the machine out of memory. Then it creates the database with a
generated password and writes the app's settings to `/etc/mysenam/env`, with a
generated `MYSENAM_SECRET`. It finishes by printing a deploy key.

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

**Deploying** builds the new version beside the live one, so the site stays up
while it builds. It takes a backup with the live version, switches, and checks
the site answers within a minute. If it does not, the previous version goes
straight back and the deploy fails with the app's last log lines. The last three
versions are kept in `/srv/mysenam/releases`.

**Backups** are taken by the app every night at 03:00 Malaysia time with
`pg_dump`, checked by reading them back, and kept in `/var/lib/mysenam/backups`
(the last 14). Copies on the same disk do not survive losing the disk, so set
up off-site copies: create a Cloudflare R2 bucket and an API token that can only
write objects to it. Fill in the `OFFSITE_S3_*` lines in `/etc/mysenam/env`,
restart, and press *Back up now* under *Venues & staff → Backups* to see the
first copy arrive. Add a lifecycle rule on the bucket to delete copies after 30
days.

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

**From another Postgres install** (a Render tenant using Render Postgres, or
another Droplet): take a backup there, copy the `.dump` here, and restore it as
above. Put the old install's `MYSENAM_SECRET` into `/etc/mysenam/env` in place
of the generated one, so saved payment keys still open.

**From the SQLite version** (an install with a `mysenam.db` file): stop it and
copy the file into `/var/lib/mysenam/` on the Droplet, with its `-wal` file
if there is one beside it. In `/etc/mysenam/env`,
replace the generated `MYSENAM_SECRET` with the old install's key. That is its
own `MYSENAM_SECRET` if it had one (Render tenants did), or otherwise the
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
| `/etc/systemd/system/mysenam.service` | How the app is run |
