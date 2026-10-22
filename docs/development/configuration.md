# Configuration

Authoritative list of environment variables. `tests/docs.test.ts` checks that every variable the code reads is listed here and that every listed variable is read somewhere.

Everything is an environment variable; there is nothing else to configure.

| Variable | Default | What it does |
| -------- | ------- | ------------ |
| `MYSENAM_MARKETPLACE` | — | `on` for the shared marketplace: venues apply to join, are invoiced monthly, and stored credit is per venue |
| `MYSENAM_CREDIT_SCOPE` | `platform`, or `venue` on a marketplace | Whose stored credit is — see [whose credit it is](../features/payments-and-credit.md#whose-credit-it-is) |
| `SENTRY_DSN` | — | Also send each error to Sentry or GlitchTip (`https://key@host/project`); the dashboard's list works without it |
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
| `MYSENAM_STAFF_2FA` | — | Make two-factor sign-in compulsory for staff: `owners` (platform owners), `managers` (owners and managers, not front desk) or `all`. Unset, each account chooses. See *Two-factor sign-in* |
| `SITE_NAME` | `MySenam` | What the site calls itself — the header, page titles, privacy notice, shared links |
| `ADMIN_EMAIL` | `admin@mysenam.my` | The first platform owner, created on a fresh database |
| `ADMIN_PASSWORD` | `mysenam-admin` | **Set this.** The default is in this README |
| `DATABASE_URL` | PGlite in `data/pglite` | `postgres://user:password@host:5432/db` in production. `pglite:/some/folder` or `pglite:memory` for PGlite |
| `DATABASE_POOL_SIZE` | `10` | Connections the app keeps open to the server |
| `MYSENAM_DATA_DIR` | `data/` | The app's own folder: backups, and `secret.key` when `MYSENAM_SECRET` is not set. Put it on a disk that survives a redeploy |
| `MYSENAM_BACKUP_DIR` | `backups/` in the data folder | Where snapshots are written |
| `MYSENAM_BACKUP_KEEP` | `14` | How many snapshots to keep before the oldest are retired |
| `MYSENAM_BACKUP_HOUR` | `3` | The hour, in the install country's time, of the nightly backup |
| `MYSENAM_SCHEDULER` | on in production | `off` to leave nightly backups, message sending and the rest of the scheduled work to your own cron. Not needed for several instances, which share the work by a lease |
| `MYSENAM_RATE_LIMITS` | `memory` | `shared` to keep rate-limit counters in Postgres, for more than one instance |
| `MYINVOIS_CLIENT_ID`, `MYINVOIS_CLIENT_SECRET` | unset | The platform's own MyInvois ERP client, to act as venues' intermediary for LHDN e-invoicing (Malaysia) |
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
| `SECURE_COOKIES` | — | `1` forces the `Secure` flag on session cookies, for a proxy that sets no `X-Forwarded-Proto`. See [authentication](../architecture/authentication.md#session-cookies) |
| `MYSENAM_PG_DUMP`, `MYSENAM_PG_RESTORE` | `pg_dump`, `pg_restore` | Paths to the Postgres client tools used by backups and restores, when they are not on `PATH` |
| `MYSENAM_DB` | — | `:memory:` runs on an in-memory PGlite (what the test suite uses). Any other value, or the older `MUDAHTEMPAH_DB`, marks a pre-Postgres SQLite install, which refuses to start until imported; see [legacy installs](../archive/migrations/legacy-installs.md) |

Set by the platform rather than by you, and read by the code: `NODE_ENV` (production checks and the scheduler), `NEXT_RUNTIME` (server instrumentation), `HOSTNAME` (names this instance in the scheduler lease). The test suite also reads `TEST_DATABASE_URL`; see [testing](testing.md).

`.env.example` lists the commonly set variables with comments; copy it to `.env.local`. This table is the complete list.

On a production start the server warns about a default or unset
`ADMIN_PASSWORD`, an unset `ADMIN_EMAIL`, and missing off-site backup settings
(`src/instrumentation-node.ts`). It warns rather than refuses, because a venue in the
middle of a Saturday does not want its booking system declining to boot.
