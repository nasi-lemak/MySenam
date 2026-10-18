# MySenam product audit: what it really does today, versus what is planned or claimed (as of 2026-10-18)

Scope and method: a read-only audit of `/home/user/MySenam`, branch `claude/sports-court-booking-w99x22`, HEAD `77f0401`. Every claim below cites a repo path. "Source" links are repo-relative file paths, not web URLs. "README says" marks a documentation claim. "Code does" marks behaviour checked in source. The test suite was run once in memory (`MYSENAM_DB=":memory:"`, no `--coverage`). The coverage figures quoted come from a `coverage/` report that a previous session left in the repo (timestamped 2026-10-18 04:25). This audit did not generate them.

---

## 1. Feature inventory by area: implemented, tested, in the UI, and dependent on outside setup

### Takeaway
The code is broad: about 20k lines in `src/lib`, 118 API routes, 54 tables and 883 passing tests. Most venue-operations features are real and tested (booking grid, recurring bookings, passes, memberships, promos, credit, classes, waitlists, check-in, kit hire, add-ons, open games, tournaments, box leagues, multi-branch businesses, storefronts, marketplace invoicing). But every customer-reaching channel depends on outside setup that is not in place in the repo: WhatsApp (Meta app plus six approved templates), email (SMTP), online payment (each venue's own Billplz account), Google sign-in and S3 off-site backups. There are also basic product gaps. Booking is in whole hours only. The sports list is fixed and has no padel. Peak pricing is hard-coded. Nobody can change or reset a password.

### Cited findings

**Scale and shape of the codebase**
- 80 commits, 2026-09-12 to 2026-10-18 (about 5 weeks). Every commit is authored "Claude <noreply@anthropic.com>" — `git log` ([Source](.git)).
- 63 modules in `src/lib`, about 20,361 lines in total ([Source](src/lib/)). 118 `route.ts` handlers under `src/app/api` ([Source](src/app/api/)). 23 pages ([Source](src/app/)). 54 `CREATE TABLE` statements across 19 migrations ([Source](db/migrations/)).
- Stack: Next 15.5, React 19.1, `pg`, `@electric-sql/pglite`, `nodemailer`, `qrcode`, `sharp`, `leaflet`. No payment SDK, no AWS SDK (S3 calls are signed by hand with SigV4 in `src/lib/offsite.ts`), no Redis, no error tracker ([Source](package.json); [Source](src/lib/offsite.ts)).

**Inventory table** (Status key: W = Working (code+tests+UI); W-ext = Working but needs outside setup; P = Partial; D = Documented-only/planned; ? = Unknown)

| Area | Code | Tests | UI | Outside dependency | Status |
|---|---|---|---|---|---|
| Customer booking grid, instant booking, booking code, cancel by code+phone | `src/lib/store.ts`, `src/app/api/bookings/route.ts`, `src/app/api/bookings/cancel/route.ts`, `src/components/BookingBoard.tsx` | `tests/store.test.ts`, `tests/api.test.ts`, `tests/components/booking-board.test.tsx`, `tests/concurrency.test.ts` | `/venue/[id]`, `/my-booking` | none | W. Limits: whole hours only (`bookings.start_hour/end_hour INTEGER`, `db/migrations/0001_initial.sql`), at most 4 hours (`MAX_HOURS_PER_BOOKING = 4`) and 14 days ahead (`MAX_ADVANCE_DAYS = 14`), both hard-coded in `src/lib/types.ts` |
| Weekly recurring series (up to 8 weeks) | `src/lib/store.ts`, `src/app/api/bookings/cancel-series/route.ts` | covered in store tests; the cancel-series route is at 0% in the existing coverage report | yes | none | W (route under-tested) |
| "Any court" auto-assign | `src/lib/store.ts` | `tests/anycourt.test.ts` | yes | none | W |
| Sports supported | fixed union: badminton, tennis, pickleball, futsal, gym, swimming, kayak (`src/lib/types.ts`) | — | — | — | P: no padel, squash, basketball, volleyball, table tennis or sepak takraw. `grep -ri padel src` finds 0 hits |
| Peak/off-peak pricing | `isPeak()` = all weekend hours plus weekdays from 18:00, hard-coded for every venue (`src/lib/time.ts:39-41`) | `tests/time.test.ts` | rates are editable per court | none | P: two price tiers per court. Peak hours cannot be set per venue. No dynamic pricing (`grep -i "dynamic pric\|surge"` finds 0) |
| Member rates | `src/lib/store.ts` | `tests/membership.test.ts` | yes | none | W |
| Cross-venue search, time-of-day, sort by soonest/nearest/cheapest, near me | `src/app/api/search/route.ts`, `src/lib/day-parts.ts`, `src/lib/geo.ts` | `tests/browse.test.ts`, `tests/near.test.ts`, `tests/geo.test.ts`, `tests/fairness.test.ts` | `/search`, home page | Geocoding uses OpenStreetMap's public Nominatim by default (usage-policy limits; README advises running your own) | W (W-ext at scale) |
| Venue pages, facilities, photos | `src/lib/facilities.ts`, `src/lib/photos.ts`, `src/lib/photo-store.ts` | `tests/facilities.test.ts`, `tests/photos.test.ts` | `/venue/[id]`, admin `PhotosEditor.tsx`, `FacilitiesEditor.tsx` | Optional `PHOTOS_S3_*`; otherwise photos go on local disk | W |
| Notices (front-page banners) | `src/lib/notices.ts`, `src/app/api/admin/notices/*` | `tests/notices.test.ts` | `NoticeBar.tsx`, `NoticesEditor.tsx` | none | W |
| Online payments (Billplz FPX/cards) | `src/lib/billplz.ts`, `src/lib/payments.ts`, `src/app/api/payments/route.ts`, `src/app/api/payments/billplz/callback/route.ts` | `tests/payments.test.ts` (callback route about 87%) | `PayOnline.tsx`, `OnlinePaymentsPanel.tsx`, `/payments/return` | Each venue needs **its own Billplz account** (API key, collection ID, X-Signature key); see section 3 | W-ext. Optional, not required to hold a booking |
| Pay at counter (manual paid/unpaid toggle) | `src/app/api/admin/payments/route.ts` | that route is at 15% in the existing coverage report | `BookingsTab.tsx` | none | W (thinly tested at the route) |
| Stored credit/wallet (append-only ledger) | `src/lib/store.ts` (`topUpWallet`), `src/app/api/admin/wallet/route.ts` | `tests/wallet.test.ts`, `tests/credit-scope.test.ts` | `CreditTab.tsx`, `Wallet.tsx` | none | W, but top-ups happen **only at the counter by staff**. No online top-up: no 'wallet' purpose in the `online_payments` CHECK (`db/migrations/0012_leagues.sql:100-102`), and online top-ups are on the README roadmap |
| Multi-visit passes | `src/lib/store.ts`, `src/app/api/admin/passes/*` | `tests/passes.test.ts` | `MyPasses.tsx` | none | W. Sold by staff only; `/api/my/passes` is GET-only (`src/app/api/my/passes/route.ts`) |
| Memberships | `memberships` table: fixed `starts_on`/`expires_on`, price, sold by an admin (`db/migrations/0001_initial.sql`) | `tests/membership.test.ts` | admin, plus `/api/my/membership` (GET only) | none | P: fixed-term memberships sold at the counter. No auto-renew, recurring billing or online purchase (`grep -i "subscription\|auto.?renew"` finds 0) |
| Promo codes | `src/app/api/admin/promos/*`, `src/lib/store.ts` | `tests/promo.test.ts` | yes | none | W |
| Classes, enrolment, roster | `src/app/api/classes/*`, `src/app/api/admin/classes/*` | `tests/classes.test.ts` | `/classes`, `ClassesTab.tsx` | none | W |
| Waitlist (classes and court slots, 30-min hold) | `src/app/api/waitlist/*` | `tests/waitlist.test.ts` (the claim route is at 0% in the existing coverage report) | `MyWaitlist.tsx`, `/waitlist/[token]` | The offer only reaches the customer by WhatsApp or email | W-ext |
| Open games (find players, split share payments) | `src/lib/games.ts`, `src/app/api/games/*` | `tests/games.test.ts` | `/games`, `/play` | Billplz for share payments | W / W-ext |
| Tournaments and brackets | `src/lib/tournaments.ts`, `src/lib/brackets.ts` | `tests/tournaments.test.ts`, `tests/brackets.test.ts` | `/tournaments`, `TournamentsTab.tsx` | Billplz for entry fees | W, with admin tournament routes at 25-47% route coverage |
| Box leagues | `src/lib/leagues.ts`, `src/lib/boxes.ts` | `tests/leagues.test.ts`, `tests/boxes.test.ts` | `/leagues`, `LeaguesTab.tsx` | Billplz for fees | W |
| Women-only/men-only | `src/lib/who.ts`, `src/lib/who-shared.ts` | `tests/who.test.ts` | yes | none | W |
| Check-in/QR, live crowd levels | `src/app/api/checkin/*`, `src/components/CheckInQr.tsx`, `LiveOccupancy.tsx` | `tests/checkin.test.ts`. The customer `checkin` and `checkin/qr` routes are at 0% route coverage in the existing report | `/checkin/[token]` | none | W (routes untested) |
| Unstaffed hours, door codes | `src/app/api/access/route.ts`, `src/app/api/admin/inductions/*` | `tests/access.test.ts` | yes | No lock hardware integration: one shared static code per lock (README "Roadmap ideas"; `grep -i "ttlock\|igloo"` finds 0) | P |
| Kit hire with deposit | `src/app/api/admin/hire/route.ts` | `tests/hire.test.ts`, `tests/partial-blocks.test.ts` | `BookingsTab.tsx` | none | W |
| Add-ons/extras (rentals and sales with a booking, optional stock count) | `src/lib/addons.ts`, `src/app/api/addons/route.ts`, `src/app/api/admin/addons/*` | `tests/addons.test.ts`, `tests/components/extras-and-guests.test.tsx` | `AddonPicker.tsx`, `AddonsEditor.tsx` | none | W (sold with a booking only; not a POS) |
| Messaging (outbox, WhatsApp plus email, retries) | `src/lib/outbox.ts`, `src/lib/transports.ts`, `src/lib/notify.ts` | `tests/outbox.test.ts`, `tests/transports.test.ts` | `MessagesPanel.tsx` | WhatsApp: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and **5 Utility templates approved by Meta, in en and ms**. Email: `SMTP_URL`, `MAIL_FROM`. Without them, messages queue and never send (README "Messages to customers") | W-ext. Only 5 message kinds exist: booking_confirmed, booking_series_confirmed, booking_cancelled, waitlist_offer, class_enrolled (`src/lib/outbox.ts:29-34`). **No reminders** (`grep -ri reminder src` finds 0; reminders are on the roadmap) |
| Free WhatsApp replies (click-to-chat) | `src/lib/whatsapp-chat.ts`, `src/app/api/whatsapp/webhook/route.ts` | webhook route about 97% covered | `ChatLink.tsx` | `WHATSAPP_CHAT_NUMBER`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, plus the Meta webhook subscription | W-ext |
| Phone verification by WhatsApp OTP | `src/lib/phone-check.ts` (10-min code, 3 sends an hour per account, 5 a day per number) | `tests/sign-in.test.ts` | `/account/phone` | Approved Meta *Authentication* template `mysenam_login_code`. Off when WhatsApp is not configured, and then numbers are taken as typed | W-ext |
| Google sign-in (OIDC + PKCE) | `src/lib/oauth.ts`, `src/app/api/auth/google/*` | `tests/sign-in.test.ts`; Google routes 90-100% covered | `/login` | `GOOGLE_CLIENT_ID`/`SECRET` and a published consent screen | W-ext |
| Multi-venue businesses/branches | `src/lib/branches.ts`, `src/app/api/admin/branches|businesses` | `tests/branches.test.ts` (these admin routes are at about 30% route coverage) | `BusinessPanels.tsx` | needs marketplace mode | W |
| Storefront domains | `src/lib/storefront.ts`, `src/app/api/tls-check/route.ts` | `tests/storefront.test.ts` | `StorefrontsPanel.tsx` | DNS A record per domain, plus Caddy on-demand TLS (`deploy/digitalocean/Caddyfile`) | W-ext |
| Marketplace self-signup, draft venues, go-live approval, geocode checks | `src/lib/applications.ts`, `src/lib/drafts.ts`, `src/lib/review-checks.ts`, `src/lib/listing.ts` | `tests/applications.test.ts`, `tests/drafts.test.ts`, `tests/components/applications-panel.test.tsx` | `/list-your-venue`, `ApplicationsPanel.tsx`, `GoLiveBanner.tsx` | Email confirmation needs SMTP. Without SMTP, accounts open at once and are flagged unconfirmed (README "Checking a venue is real") | W-ext |
| Marketplace billing and invoices (monthly fee, free months, overdue unlisting, suspensions) | `src/lib/billing.ts`, `src/lib/payment-holds.ts`, `src/lib/suspensions.ts` | `tests/billing.test.ts`, `tests/suspensions.test.ts` | `BillingPanel.tsx` | Platform Billplz account `BILLPLZ_*`, plus SMTP for overdue emails | W-ext. No PDF invoices, receipts, tax lines or e-invoicing (`grep -ri "pdf\|csv\|receipt"` over src finds 0 files; no tax columns in migrations) |
| WhatsApp allowance and overage on invoices | `src/lib/whatsapp-usage.ts` (defaults 300 included, RM0.08 each beyond) | `tests/whatsapp-usage.test.ts`, `tests/components/billing-usage.test.tsx` | `BillingPanel.tsx` meter | needs WhatsApp live, so there is anything to count | W-ext |
| Courts out of service, closures, operating hours | `src/lib/outages.ts`, `src/app/api/admin/venues/[id]/closures` | `tests/outages.test.ts`, `tests/hours.test.ts` | `OutagesPanel.tsx` | none | W |
| Reports (up to 400 days; revenue by month/sport/court; liabilities) | `src/lib/reports.ts` | `tests/reports.test.ts` | `ReportsTab.tsx` | none | W, view only. **No CSV/PDF export** (0 files match `csv\|pdf`) |
| Occupancy heatmap | `src/app/api/admin/occupancy/route.ts` | about 83% route coverage | `OccupancyTab.tsx` | none | W |
| Backups (nightly pg_dump, verify, retain 14) and restore | `src/lib/backup.ts`, `scripts/backup.mjs`, `scripts/restore.mjs`, `src/lib/scheduler.ts` | `tests/backup.test.ts`, `tests/scheduler.test.ts` | Backups panel (owner) | `pg_dump` on the host; `MYSENAM_DATA_DIR` on persistent disk | W |
| Off-site backup copies | `src/lib/offsite.ts` (hand-written SigV4) | `tests/offsite.test.ts` | Backups panel | `OFFSITE_S3_*` bucket (R2/B2/S3) | W-ext |
| Privacy: export, erase, retention | `src/lib/privacy.ts` (`exportCustomerData`, `eraseCustomer`, `RETENTION` schedule: door reveals 180d, messages 90d, booking identity 730d, ...), `/api/my/data`, `/api/my/erase` | `tests/privacy.test.ts`, `tests/impersonation.test.ts` | `/account`, `/privacy` | none | W. The privacy and terms pages are drafts; README: "not legal advice: have a Malaysian lawyer review" |
| i18n EN/MS | `src/lib/i18n.ts` (`LOCALES = ["en","ms"]`, about 1,500 keyed strings) | `tests/i18n.test.ts`, `tests/locale.test.ts`, `tests/components/language.test.tsx` | Customer pages only. Admin UI strings are hard-coded English (e.g. `src/components/admin/BookingsTab.tsx:256`, "Mark all unpaid sessions in series ... as paid?") | none | P: customer side EN/MS. Admin is English only. No Chinese or Tamil (`grep -i "chinese\|tamil\|zh"` finds 0 relevant hits) |
| Admin roles | platform owner (`venue_id NULL`), business manager, branch staff (`src/lib/admin-auth.ts:164-188`) | `tests/admin.test.ts`, `tests/routes.test.ts` (sweeps every `/api/admin` and `/api/my` route for 401) | admin dashboard | none | W. Coarse roles only: no read-only or cashier role, no per-permission grants |
| Demo data | `src/lib/demo.ts`, `/api/admin/demo` | `tests/demo.test.ts` | `FirstRun.tsx` | none | W (for showing the product only) |

### Inferences
- The product is closer to "Malaysian Playtomic-lite plus gym/class desk tools" than to a minimum viable product, but it has gaps a padel or pickleball operator would notice at once. There is no padel. Bookings are whole hours only, so the common 90-minute padel slot or 30-minute increments are impossible. Peak windows cannot be set per venue.
- "Working" here means "the code exists and passes its own tests". No feature has been exercised by a real venue (see section 7).
- The admin UI is the least-tested layer: `components/admin` sits at about 14% statement coverage in the existing report. It is also the layer a paying operator uses all day.

### Gaps
- There are no end-to-end browser tests in CI. `playwright-core` is a dependency, and the scratchpad holds `*-walk.mjs` scripts from development sessions, but CI runs only typecheck plus Vitest (`.github/workflows/ci.yml`). UI behaviour beyond the component tests is unverified.
- Whether `npm run build` passes on this HEAD was not checked (the build writes `.next/`). CI is configured to build.

---

## 2. Features competitors typically have that MySenam lacks (checked by grep, not assumed)

### Takeaway
Grep finds nothing for SMS, Stripe or other Malaysian gateways (iPay88, senangPay, toyyibPay, Razer/MOLPay, eGHL, Curlec, DuitNow, GrabPay, TNG), accounting integrations, LHDN MyInvois e-invoicing, SST/tax, recurring member billing, refunds to card through an API, dynamic pricing, coach marketplace, player ratings/DUPR, smart-lock or turnstile hardware, offline/PWA, analytics or error tracking, multi-currency and languages other than EN/MS. There are no native mobile apps. The app is a responsive website only.

### Cited findings
- 0 files match each of these patterns across `src` and `db`: `stripe`; `sms|twilio`; `ipay88|senangpay|toyyibpay|razer|molpay|eghl|curlec|duitnow|grabpay|touch.n.go|tng`; `xero|quickbooks|sql account|autocount`; `commission|take.rate|platform fee|service fee`; `reminder`; `offline|service.?worker|manifest`; `turnstile|ttlock|igloo`; `recurring billing|auto.?renew|subscription`; `dynamic pric|surge` (grep run during this audit over [Source](src/), [Source](db/migrations/)).
- `e-invoic|myinvois|lhdn` matches only the platform's own `invoice` code (`issueDueInvoices`, `settleInvoice`), nothing about LHDN ([Source](src/lib/billing.ts)).
- `tax|sst|gst` as whole words: no hits in source or migrations ([Source](db/migrations/)).
- `analytics|sentry|...`: the only hit is privacy-notice text saying "there is no advertising or analytics service in this site" ([Source](src/lib/i18n.ts)).
- `coach`: only a facility tag "coaching" and a demo instructor "Coach Rahim" ([Source](src/lib/facilities.ts); [Source](src/lib/demo.ts)). Classes name an instructor as free text; there are no coach accounts, coach booking or coach payouts.
- `rating|elo|dupr`: the hits are league "level" ordering in box leagues (`src/lib/boxes.ts`) and skill "levels" (`/api/my/levels`). There is no rating system or DUPR integration ([Source](src/lib/boxes.ts)).
- Currency: everything is RM/MYR; `toSen()` converts ringgit to sen for Billplz ([Source](src/lib/billplz.ts)). There is no currency column ([Source](db/migrations/0001_initial.sql)).
- POS/retail: add-ons with an optional `stock` count are sold only attached to a booking. There is no walk-in POS, no cash drawer and no product catalogue ([Source](src/lib/addons.ts); [Source](src/components/admin/AddonsEditor.tsx)).
- Mobile: no `ios/`, `android/`, Expo, Capacitor or PWA manifest in the repo ([Source](package.json)).
- Apple sign-in: README notes `user_identities` "already allows `apple`", but it is not implemented (README "Signing in with Google").
- Customer self-service purchase of passes, memberships or credit online: not implemented. The `online_payments.purpose` CHECK allows only `booking, invoice, share, entry, league` ([Source](db/migrations/0012_leagues.sql)).
- Requiring payment to hold a booking, releasing unpaid holds, and reminders are all listed under README "Roadmap ideas", i.e. not built ([Source](README.md)).

### Inferences
- In the Malaysian market the most visible missing items are: no padel; no deposits or prepayment rules for no-shows (bookings are free holds, capped at 3 unpaid per number per venue); no reminders; no online pass/membership/top-up sales; no e-invoicing readiness; no native app; no reporting export to accounting.

### Gaps
- Which competitor features actually decide a Malaysian venue's purchase was not tested here. That belongs to the competitor researcher.

---

## 3. Payment readiness

### Takeaway
Billplz is the only gateway. It is integrated well enough to take money into **each venue's own Billplz account**. The platform never touches booking money. Callbacks are HMAC-SHA256 verified with a timing-safe compare under that venue's key, and settlement is idempotent. But paying online is optional and never required to hold a booking. There is no reconciliation poll for missed callbacks, no expiry for pending bills, and no refund API: refunds are done by hand in Billplz and then marked done. There are no receipts, tax or e-invoices. To take money on day one, each venue needs its own approved Billplz merchant account, and the install needs a public HTTPS `MYSENAM_URL`.

### Cited findings
- The only gateway is Billplz v3 bills: `createBill` POSTs to `/api/v3/bills`; the host is `billplz.com` or `billplz-sandbox.com` ([Source](src/lib/billplz.ts)).
- Money flow for bookings: README says "into the venue's own Billplz account. The platform never holds a customer's money". The code backs this up. Per-venue keys are stored in `payment_settings`, sealed with AES-256-GCM (`seal`/`unseal`), and `accountForBill` looks up the venue's account for each bill ([Source](src/lib/payments.ts); [Source](src/lib/secrets.ts)).
- Money flow for platform fees: marketplace invoices are paid into the platform's own Billplz account from the `BILLPLZ_*` env vars (`platformAccount()`) ([Source](src/lib/billing.ts)).
- Commission: none. There is no per-booking commission, take rate or service fee anywhere (grep finds 0). Platform revenue is the monthly venue fee plus WhatsApp overage ([Source](src/lib/billing.ts); [Source](src/lib/whatsapp-usage.ts)).
- Webhook verification: the callback route rejects with 400 unless `verifyCallback(fields, account.xSignatureKey)` passes. `xSignature()` builds the Billplz X-Signature HMAC, and the compare uses `crypto.timingSafeEqual` ([Source](src/app/api/payments/billplz/callback/route.ts); [Source](src/lib/billplz.ts)). The redirect is verified the same way (`verifyRedirect`).
- Idempotency: `settleBill` claims with `UPDATE ... WHERE status = 'pending'` inside a transaction. If the booking was already cancelled or paid at the counter, the amount is moved into `refund_due` instead of being lost ([Source](src/lib/payments.ts)).
- The callback's `amount` is not compared with the stored amount. The bill is server-created and the signature is venue-keyed, so the risk is low ([Source](src/lib/payments.ts)).
- No reconciliation. The only outbound Billplz call is creating a bill; there is no GET of bill status. If both the callback and the redirect are lost, a payment stays `pending` and nothing ever checks Billplz ([Source](src/lib/billplz.ts); [Source](src/lib/scheduler.ts)).
- Refunds: README says "Refund it in Billplz, then mark it done". The code: `refundsOwed()` lists payments, and `markRefunded()` only sets `refunded = refund_due` in the database. Nothing calls Billplz ([Source](src/lib/payments.ts)).
- Bookings stand unpaid. "Every booking starts `unpaid` and stands whether or not it is ever paid online" (README "Payments"). The `bookings.payment_status` default is `'unpaid'` ([Source](db/migrations/0001_initial.sql)). Limits on unpaid bookings: 3 per number per venue and 6 across venues ([Source](src/lib/limits.ts)).
- Manual paid toggle: `/api/admin/payments` lets staff flip paid/unpaid. Bookings record only `paid_at` and `paid_via`, not which staff member did it ([Source](db/migrations/0001_initial.sql)). That route is at 15% statement coverage in the existing coverage report ([Source](coverage/index.html)).
- Settlement and payouts are Billplz's business with each venue. The app has no settlement report, payout matching or fee accounting. The daily view shows expected, collected and outstanding money (README "Payments").
- No receipts, PDF invoices, SST lines or LHDN e-invoice fields: 0 grep hits ([Source](src/); [Source](db/migrations/0006_business_invoices.sql)).
- The online-payment admin routes are partly tested: `/api/admin/online-payments` is at about 52% and `payment-settings` at about 55% in the existing coverage report ([Source](coverage/index.html)).

### Inferences
- Day-one blockers for real money:
  1. The venue's own Billplz merchant account, approved (outside the code).
  2. `MYSENAM_URL` set to a public HTTPS address so callbacks arrive.
  3. Staff trained to refund by hand in Billplz.
  4. The operator accepting that customers can book without paying (the no-show risk is only capped).
  5. The terms reviewed by a lawyer (the README says they are a draft).
  6. For the marketplace: the platform's own Billplz account and SMTP.
- A cash-handling or fraud risk exists. Staff can toggle a counter payment off and on with no record of who did it.

### Gaps
- Billplz fees, onboarding time and whether Billplz has a refund API today were not checked here. That is outside the code.

---

## 4. Security posture

### Takeaway
The basics are sound: scrypt with salt, timing-safe compares, 32-byte random session tokens, HttpOnly/SameSite=Lax/Secure-on-HTTPS cookies, venue scoping enforced server-side and swept by a test over every admin route, signed webhooks, encrypted payment keys and PDPA-style export, erasure and retention. The gaps that matter to a paying operator:
- No password change or reset, for anyone.
- No 2FA.
- No general audit trail of staff actions.
- No security headers (CSP, HSTS, framing).
- No explicit CSRF or Origin check; it relies on SameSite=Lax.
- Session tokens stored in plain text.
- Rate limits held in process memory.
- The bootstrap owner password defaults to a value published in the README, with only a warning at startup.

### Cited findings
- Password hashing: `crypto.scryptSync(password, salt, 64)` with a 16-byte random salt; verified with `timingSafeEqual` ([Source](src/lib/auth.ts)). Minimum length is 8 for customers and staff ([Source](src/app/api/auth/register/route.ts); [Source](src/app/api/admin/admins/route.ts)).
- Sessions: a 32-byte random hex token is stored as is in the `sessions`/`admin_sessions` tables. Customer sessions last 30 days, admin sessions 7 ([Source](src/lib/auth.ts); [Source](src/lib/admin-auth.ts)). Tokens are not hashed at rest, so a database or backup leak gives working session tokens until they expire.
- Cookies: `ms_session`/`ms_admin` are HttpOnly and SameSite=Lax, with `Secure` when the request is HTTPS (or `x-forwarded-proto`), all set through `sessionCookieOptions()` ([Source](src/lib/session-cookie.ts)).
- **No password change or reset.** There is no forgot-password flow, no change-password endpoint and no `UPDATE ... password_hash` anywhere. `admins/[id]` exports only `DELETE` ([Source](src/app/api/admin/admins/[id]/route.ts)). A grep for `forgot|reset.?password|change.?password|SET password_hash` finds only UI state setters ([Source](src/app/login/page.tsx)). The bootstrap owner is created from `ADMIN_PASSWORD` only when no admin exists ([Source](src/lib/admin-auth.ts):77-90), so its password cannot be rotated from the app.
- Default credentials: `ADMIN_PASSWORD` defaults to `mysenam-admin`, which is printed in the README. Startup only warns ("Anyone who knows this project owns every venue") and does not refuse to start ([Source](src/instrumentation-node.ts); [Source](src/lib/admin-auth.ts)).
- **No 2FA/TOTP for anyone.** `totp|2fa|two.factor|\botp\b` finds 0 hits ([Source](src/)). The phone OTP checks a customer's number; it is not a login factor ([Source](src/lib/phone-check.ts)).
- **No audit log.** `audit` finds 0 hits. Some tables record the acting admin (`wallet_entries`, `memberships`, `inductions`, `storefront_venues`; `blocked_by`, `suspended_by`, `created_by` on outages, tournaments, leagues, photos, notices) ([Source](db/migrations/0001_initial.sql); [Source](db/migrations/0009_outages_suspensions.sql)). **Bookings do not record who marked them paid, cancelled, moved or flagged a no-show** (bookings schema in [Source](db/migrations/0001_initial.sql)). Door-code reveals are logged (`access_reveals`).
- No admin impersonation feature (`impersonat` finds 0 in src). `tests/impersonation.test.ts` is about stopping one customer reading another's pass codes by typing their phone number, not about staff impersonating anyone ([Source](tests/impersonation.test.ts)).
- Tenant isolation: `requireAdmin`, `canAccessVenue`, `denyVenue` and `requireOwner` ([Source](src/lib/admin-auth.ts)). `tests/routes.test.ts` globs every `/api/admin` and `/api/my` route, checks that each answers 401 without a cookie, and checks own venue 200, other venue 403 ([Source](tests/routes.test.ts); README "Admin access"). This is shared-database, shared-schema tenancy. README states plainly that storefronts are "not a wall around a business's data"; a business that wants isolation needs its own install.
- CSRF: no middleware (`src/middleware.ts` does not exist) and no Origin or token check. The only "origin" hits are unrelated ([Source](src/app/api/checkin/qr/route.ts)). Protection rests on SameSite=Lax cookies and JSON bodies.
- Security headers: `next.config.ts` sets no headers ([Source](next.config.ts)). The Caddyfile does compression and the reverse proxy only, with no HSTS or framing headers ([Source](deploy/digitalocean/Caddyfile)). The only CSP is on served photos (`default-src 'none'`) ([Source](src/app/photos/[...key]/route.ts)).
- Rate limiting: in-memory `Map` windows ([Source](src/lib/rate-limit.ts)), applied on sign-in, registration, booking create/cancel, waitlist, games, phone code, geocode, payments and more (22 route files import it). Limits keyed by phone number are in `src/lib/limits.ts`. Several instances would each keep their own counters (README "Rate limiting").
- WhatsApp webhook: the signature is checked with `WHATSAPP_APP_SECRET`. README: "A delivery without a valid signature is refused". The route is about 97% covered ([Source](src/app/api/whatsapp/webhook/route.ts)).
- Secrets: venue payment keys are AES-256-GCM sealed. The key comes from `MYSENAM_SECRET`, or from `secret.key` in the data folder, which is kept out of backups ([Source](src/lib/secrets.ts); README "Paying online").
- Storefront TLS abuse guard: Caddy on-demand TLS asks `/api/tls-check`, which approves only registered storefront domains ([Source](deploy/digitalocean/Caddyfile); [Source](src/app/api/tls-check/route.ts)).
- PDPA-related: data export (`exportCustomerData`), erasure that keeps the accounting record (`eraseCustomer`), a retention schedule applied daily (`pruneIfDue`), and a `/privacy` page ([Source](src/lib/privacy.ts); `tests/privacy.test.ts`). Retention periods are constants in code (`RETENTION`), not per-venue settings.
- Login brute force: 10 attempts per 10 minutes per IP and per email (README "Rate limiting"; [Source](src/lib/rate-limit.ts)). The admin and customer login routes show 0% statement coverage in the existing coverage report ([Source](coverage/index.html)), though `tests/auth.test.ts` and `tests/rate-limit.test.ts` test the library functions.

### Inferences
- Before a paying operator relies on this, the priority fixes are: password reset and change (support burden and lock-out risk), 2FA for owners and managers, an audit trail for booking payment state changes (staff fraud), refusing the default admin password in production, and security headers.
- No penetration test or dependency audit was run in this audit (the brief excludes scanners that write files).

### Gaps
- Dependency vulnerability status today was not checked (`npm audit` was not run). One commit (`cffdade`) shows patched releases were taken earlier.

---

## 5. Operational reliability

### Takeaway
The design targets one box: one DigitalOcean Droplet (2 GB, about USD 12 a month) running Postgres 16, the app and Caddy. It has nightly pg_dump backups, verified by reading them back, optional S3 off-site copies, a deploy script with automatic rollback and a database-only health check. The scheduler and rate limits live inside the app process. There is no error tracking, metrics or paging. Backup failures only reach the server log and a red panel in the admin UI. Postgres runs on the same machine as the app, with no replica and no high availability.

### Cited findings
- Database: Postgres 16+ in production through `DATABASE_URL`; PGlite (Postgres in WebAssembly) for development and tests. README: PGlite "costs ... the best part of a gigabyte of memory" against about 250 MB with a server ([Source](README.md); [Source](src/lib/db.ts)). Migrations run under a lock on start ([Source](db/migrations/)).
- SQLite compatibility shims stay in the Postgres schema (e.g. a `datetime()` SQL function; dates stored as TEXT) ([Source](db/migrations/0001_initial.sql)).
- Scheduler: `setInterval` once a minute inside `next start`. It drains the outbox, issues invoices, applies payment holds, does league housekeeping and runs the nightly backup plus off-site copy ([Source](src/lib/scheduler.ts)). With several instances, `MYSENAM_SCHEDULER=off` must be set on all but one (README "What one box gives you").
- Outbox: at most 5 attempts with backoff (1 minute, then 5, then 30, ...), then `abandoned`. A cap of 8 messages per recipient per day ([Source](src/lib/outbox.ts)).
- Backups: `pg_dump` custom format, checked with `pg_restore --list`, the last 14 kept, written to a temporary file and renamed. Restore runs in one transaction and takes a snapshot first (README "Backups", "Restoring"; [Source](src/lib/backup.ts); [Source](scripts/restore.mjs)).
- Backup failure alerting: only `console.error` plus the admin panel's red warning. There is no email to owners on failure ([Source](src/lib/scheduler.ts):86-105). `tellOwners` is used only for applications and payment holds ([Source](src/lib/owner-alerts.ts); [Source](src/lib/payment-holds.ts)).
- Health check: `GET /api/health` runs `SELECT 1`; it is at 0% route coverage in the existing report ([Source](src/app/api/health/route.ts)).
- Deploy kit: `setup.sh` installs Postgres 16, Node 22 and Caddy, enables ufw (SSH, 80, 443), unattended-upgrades and 2 GB swap, and generates the DB password and `MYSENAM_SECRET`. `deploy.sh` builds beside the live release, backs up, switches over, health-checks, rolls back on failure and keeps 3 releases ([Source](deploy/digitalocean/README.md); [Source](deploy/digitalocean/setup.sh)). Cost: Droplet USD 12 a month, optional DO backups USD 2.40, R2 free under 10 GB ([Source](deploy/digitalocean/README.md)). README: "a deploy restarts the app for a second or two, so do it outside opening hours" ([Source](README.md)).
- Observability: logs via `journalctl -u mysenam`. No Sentry, Prometheus or OpenTelemetry (0 grep hits). The README suggests DO Monitoring as a tick-box option ([Source](deploy/digitalocean/README.md)).
- Single-server caveats in the code: rate-limit counters and the scheduler are per process. Photos sit on local disk unless `PHOTOS_S3_*` is set. The geocoder defaults to public Nominatim at one request a second ([Source](src/lib/rate-limit.ts); [Source](src/lib/photo-store.ts); README "Checking a venue is real").
- Concurrency: README says check-then-write paths run in serializable transactions with retries, and `tests/concurrency.test.ts` fires them at the same time ([Source](tests/concurrency.test.ts)).
- "Own copy" model: each white-label business is a separate Droplet and database, deployed by hand with `mysenam-deploy` (README "A venue business's own copy"). That means N boxes to patch and monitor.

### Inferences
- For a paid service level, the missing pieces are: an uptime monitor plus alerting (none built in), error tracking, email or push alerts when backups fail, a managed or replicated Postgres, and a status page. One Droplet means the app, database and backups go down together on hardware failure. The off-site copy is the only recovery path, and restoring is manual.
- The recovery time after losing the box is unknown and untested: there is no documented restore drill or timing.

### Gaps
- No load test or measured capacity figures were found beyond an index test (`tests/query-plans.test.ts`). The scratchpad holds `capacity-bench.ts` and `scale.log` from development, but they are not part of the repo.

---

## 6. Test suite

### Takeaway
883 tests in 75 files all pass on in-memory PGlite (about 133 s). CI also runs the suite against real Postgres 16. Library code is well covered (about 91%); admin UI components are barely covered (about 14%), and several money-handling admin routes are at 15-25%.

### Cited findings
- Run during this audit: `Test Files 75 passed (75)`, `Tests 883 passed (883)`, duration 133.23 s, with `MYSENAM_DB=":memory:"` and Vitest 5.0.3 (local run output; no file written to the repo; `git status` clean afterwards).
- Files: 66 `tests/*.test.ts` plus 9 under `tests/components/` ([Source](tests/)).
- Real Postgres: CI runs `npm test` twice, once on PGlite and once with `TEST_DATABASE_URL` pointing at a `postgres:16` service ([Source](.github/workflows/ci.yml)). Each test file gets a throwaway database ([Source](tests/setup-db.ts)). CI runs only on pull requests and on pushes to `main` and this branch.
- Coverage thresholds (a floor): global 55% statements, 45% branches, 57% functions, 55% lines; `src/lib/**` 90/83/95/94. The config comment says "seven admin tabs are still untested" ([Source](vitest.config.mts)).
- Existing coverage report (not generated by this audit): 67.2% statements (7681/11429), 57.9% branches, 64.2% functions, 69.2% lines. By folder: `lib` 91.45%, `components` 46.13%, `components/admin` 14.11% ([Source](coverage/index.html)).
- Low-coverage routes in that report: `admin/auth/login|logout|me` 0%, `auth/login|logout|me` 0%, `bookings/cancel-series` 0%, `checkin` 0%, `checkin/qr` 0%, `health` 0%, `tournaments` 0%, `waitlist/claim` 0%, `admin/payments` 15%, `admin/bookings/move` 19.5%, `admin/venues` 21%, `admin/wallet` 23%, `admin/no-show` 23%, `admin/*/void` 22% ([Source](coverage/index.html)).
- There are no browser end-to-end tests in CI ([Source](.github/workflows/ci.yml)).

### Inferences
- The test suite really is a strength for the business rules. The gaps sit in what staff touch every day (admin UI, counter payment toggles, credit top-ups, voids), which is where operator-reported bugs would show up first.

### Gaps
- Branch-level coverage of the payment and refund paths was not drilled into file by file.

---

## 7. Business model as implemented, and evidence of traction

### Takeaway
In marketplace mode (`MYSENAM_MARKETPLACE=on`) the platform earns a flat monthly venue fee (default **RM0**), after 1 free month from going live, plus WhatsApp overage (300 messages included, then RM0.08 each). There is **no per-booking commission**. Booking money goes to the venue (counter, or the venue's own Billplz). The repo shows no real users, customers or deployments. All data is generated demo or seed data, and every commit was written by Claude over about 5 weeks. Demo data is not evidence of traction.

### Cited findings
- Mode switch: `isMarketplace()` reads `MYSENAM_MARKETPLACE` ([Source](src/lib/mode.ts)).
- Fee: `defaultFee()` returns `Number(process.env.MYSENAM_VENUE_FEE ?? 0)`, so the default monthly fee is RM0. The owner can set a fee per venue ([Source](src/lib/billing.ts):160-162, 223).
- Free months: `MYSENAM_FREE_MONTHS ?? 1`, counted from going live. No prorating or back-billing. Invoices are due in 14 days. A venue more than 14 days overdue is unlisted ([Source](src/lib/billing.ts):171; [Source](src/lib/payment-holds.ts); README "Running the marketplace").
- WhatsApp: `MYSENAM_WHATSAPP_INCLUDED ?? 300`, `MYSENAM_WHATSAPP_PRICE ?? 0.08`, per venue per Malaysian calendar month. Charged on the next month's invoice. Free during free months and for venues on an RM0 fee ([Source](src/lib/whatsapp-usage.ts):20-28; README "What WhatsApp costs, and who pays").
- Phone-verification OTP messages are the platform's own cost (README "What WhatsApp costs").
- Commission: none (0 grep hits for commission, take rate, platform fee or service fee) ([Source](src/)).
- Credit scope: per venue on a marketplace (`MYSENAM_CREDIT_SCOPE`), so stored credit is the venue's liability ([Source](src/lib/mode.ts)).
- Non-marketplace mode: one operator's own install, branded with `SITE_NAME`. There is no licence or billing code for this mode; the platform would charge outside the software (README "A venue business's own copy").
- Traction evidence: the seed venues are invented ("Arena MySenam @ Petaling Jaya", "12 Jalan SS2/61...") ([Source](src/lib/db.ts):560-562). The demo fortnight is deterministic and flagged `demo = 1` on bookings ([Source](src/lib/demo.ts); [Source](db/migrations/0001_initial.sql)). The only domains in code and deploy are placeholders (`book.example.my`, `abc.com`) ([Source](deploy/digitalocean/README.md)). All 80 commits are by "Claude <noreply@anthropic.com>", 2026-09-12 to 2026-10-18 (`git log`). The remote is `github.com/nasi-lemak/MySenam` (`git remote -v`). The CI comment mentions "the branch the demo deploys from" ([Source](.github/workflows/ci.yml)), suggesting at most a demo deployment.
- Terms: `/terms` is "a starting draft ... not legal advice". It says it is incomplete until `OPERATOR_NAME` is set (README "Running the marketplace").

### Inferences
- As built, the revenue model is pure SaaS subscription plus messaging pass-through. The defaults earn nothing until someone sets `MYSENAM_VENUE_FEE`. Unit economics depend entirely on that fee. Hosting is about USD 12-15 a month per Droplet (per the deploy README), and the platform also pays Meta for WhatsApp templates up to each venue's allowance.
- The product has not met a real venue. Every "Working" status in section 1 means "works in tests and in the author's walkthroughs", not "validated in production".

### Gaps
- No pricing decision, sales pipeline, letters of intent or pilot venues were found in the repo. Whether the demo is deployed anywhere could not be confirmed from the code.
