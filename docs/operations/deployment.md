# Deploying and upgrading

Authoritative for putting MySenam into production and keeping it there. The ready-made kit is in [`deploy/digitalocean`](../../deploy/digitalocean/README.md).

## Deploying

Production runs against a Postgres server, version 16 or later:

```bash
npm ci
npm run build
DATABASE_URL=postgres://mysenam:…@127.0.0.1:5432/mysenam npm start
                   # listens on 3000; put a TLS-terminating proxy in front
```

The schema is created on the first database query after a start, and moved
on by every later start: the
files in `db/migrations` are applied in order, each once, under a lock, so two
servers starting together do not both run one.

The ready-made way to run it is one DigitalOcean Droplet with Postgres, the app
and Caddy on it, set up by a script and deployed by another. See
[`deploy/digitalocean/README.md`](../../deploy/digitalocean/README.md).

## Behind a proxy

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

## Upgrading

Migrations run when the app starts, so a deploy is build, restart, done.
**Take a backup first** (`npm run backup`; see [backups](backups.md)), because a migration cannot be undone
from inside the app. The DigitalOcean kit's deploy script takes one with the
live version, just before it switches to the new one, and puts the old version
back if the new one does not answer.

## Before going live: what only a live account can prove

The tests run every gateway and API against recorded answers, not the real
services. Before taking real money or sending real messages, check each of
these once with a real account, in its sandbox where it has one:

- [ ] **Secrets**: `ADMIN_EMAIL` and an `ADMIN_PASSWORD` of 12 characters or
      more set before the first start (without it production makes no owner
      and refuses the published default); `MYSENAM_SECRET` set and
      kept out of backups; two-factor sign-in on for the owner account.
- [ ] **Email**: `SMTP_URL` and `MAIL_FROM` send a booking confirmation that
      arrives in an inbox, not spam (SPF/DKIM on the sending domain), with
      its calendar invite, and a venue's news shows the mail app's own
      unsubscribe button.
- [ ] **WhatsApp**: every template under *Messages to customers* submitted
      and approved by Meta in each language, word for word; a confirmation
      and a waitlist offer arrive; the delivery webhook reaches
      `/api/whatsapp/webhook` (a message shows *delivered* under Messages).
- [ ] **Billplz** (Malaysia): a sandbox bill paid by FPX and by card marks
      the booking paid by callback and by redirect; the X-Signature key is
      checked (a tampered callback is refused); a held booking's bill expires
      with its hold.
- [ ] **Stripe** (Singapore, renewals): a test-mode checkout paid; the
      webhook secret checked; a refund from *Refunds owed* goes through; a
      test dispute (card `4000 0000 0000 0259`) shows under Disputes and, lost,
      takes back what it paid for; a renewing membership charges again.
- [ ] **MyInvois** (Malaysia): the sandbox (preprod) accepts a consolidated
      e-invoice and a single one, with the venue's own TIN and certificate.
- [ ] **Google sign-in**: the redirect URI registered matches
      `<MYSENAM_URL>/api/auth/google/callback`.
- [ ] **Backups**: the nightly backup runs, the off-site copy lands, and a
      restore into a spare database works (see *Restoring*).
- [ ] **The scheduler**: `/api/health` shows its heartbeat a minute old at
      most, so holds, reminders, offers and backups happen on time.
- [ ] **A real venue, end to end**: book, pay online, get the messages,
      check in at the desk, cancel one late, see it in the reports and the
      accounting export.

Not built here, and needing a partner or a contract first: Reserve with
Google's live booking server (the feeds are ready), Singapore's InvoiceNow,
smart locks, Stripe Connect payouts to venues, web push, LINE and Zalo.
