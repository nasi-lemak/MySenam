# Choosing launch providers

A recommendation for the first production deployment in Malaysia and
Singapore, from what MySenam already implements and the providers' own
published pricing and documentation, read on 24 October 2026. Prices change:
check each provider's page before signing up. Nothing here has been signed up
for, and no integration below is verified against the live service yet; each
stays `INTEGRATION_VERIFICATION_REQUIRED` in
[feature status](../product/feature-status.md) until its check in the
[launch checklist](../operations/deployment.md#launch-integration-checklist)
passes. Where a fact could not be confirmed from the provider's own page it
says *unverified*.

## What is already built

| Need | Built | Fits |
| ---- | ----- | ---- |
| Taking payment | A gateway layer with two adapters, Billplz and Stripe; each venue connects its own merchant account and money settles to it directly ([payment gateways](payment-gateways.md), [ADR 0006](../architecture/decisions/0006-per-venue-payment-accounts.md)) | Any provider with a hosted payment page, signed callbacks and, ideally, a refund API |
| Email | Plain SMTP behind the outbox, retried; bounces not read back ([messaging](messaging.md)) | Any provider with SMTP |
| Phone checks | WhatsApp Cloud API, or SMS through Twilio or any HTTP gateway | Meta, Twilio, an HTTP SMS aggregator |
| Photos and off-site backups | Any S3-compatible API; backups expect an upload-only key ([backups](../operations/backups.md)) | S3, R2, B2, Wasabi |

Recommending providers changes none of this. Venue money keeps settling to
each venue's own account; MySenam's own merchant account is only for
invoicing venues.

## Payments

| | Billplz | Stripe Malaysia | Stripe Singapore | HitPay (not built) |
| - | ------- | --------------- | ---------------- | ------------------ |
| Countries | Malaysia only | Malaysia | Singapore | Singapore, Malaysia, Philippines (Thailand through Stripe) |
| Local methods and fees | FPX RM1.25 per payment (RM0.75 on the RM999 a year plan); DuitNow QR and e-wallets 1.5%; Malaysian cards 1.8% (1.5%) | Cards 3% + RM1.00; FPX 3% + RM1.00; GrabPay 3%; DuitNow not offered | Cards 3.4% + S$0.50; PayNow 1.3%; GrabPay 3.3% | MY: cards 1.2% + RM1, FPX 1.8% + RM0.40, DuitNow QR 1.2%. SG: PayNow 0.9% (0.65% + S$0.30 from S$100), cards 2.8% + S$0.50 |
| Settlement | FPX next business day, cards two business days | Stripe's schedule | Stripe's schedule | MY: FPX and cards T+1 business day (settled through Stripe), DuitNow T+2; minimum payout RM5. SG: T+1 |
| Refunds | **No refund API**: FPX refunds are a payout to the customer's bank account (a V5 Payment Order); card refunds through support | API; no refund fee, processing fee not returned | Same | API (`POST /v1/refund`, full or partial) for cards, FPX (30 days), Touch 'n Go, GrabPay, ShopeePay, PayNow; **DuitNow cannot be refunded through HitPay**; processing fee not returned; no idempotency key documented |
| Disputes | Through Billplz | RM90 each | S$15 each | RM200 each in Malaysia, S$20 in Singapore |
| Recurring | Card tokens charged by the merchant (Auto-Deduct, applied for separately) | Billing, 0.7% of volume | Billing, 0.7% | Recurring billing and saved methods (MY: cards, Touch 'n Go, GrabPay, ShopeePay); 0.2% add-on |
| Who can sign up | Businesses registered with SSM or ROS with a Malaysian corporate bank account; sole proprietors *unverified* | A business registration number for FPX | A Singapore business | MY: SSM profile, ID and selfie; sole proprietors accepted, personal bank account allowed. SG: ACRA registration and proof of business |
| Platform accounts | Not offered | Connect only with Stripe owning fees and loss (each venue its own Standard-style account); Express and Custom not listed for Malaysia | Express and Custom available | Each venue its own HitPay account, verified by HitPay and paid out to its own bank; connected by the venue's API key, or by OAuth (beta, scopes approved by HitPay, webhooks still need the API key) |
| Testing | Sandbox | Test mode | Test mode | Sandbox is a Singapore account only: **FPX, DuitNow and Touch 'n Go cannot be tested** without real money |
| Expansion | — | Thailand self-serve; Indonesia in preview; the Philippines and Vietnam not offered | | Philippines |

Sources: [Billplz pricing](https://main.billplz.com/pricing),
[terms](https://main.billplz.com/terms),
[refunds](https://support.billplz.com/guide/issue-a-refund),
[API](https://support.billplz.com/api);
[Stripe Malaysia pricing](https://stripe.com/my/pricing),
[Stripe Singapore pricing](https://stripe.com/en-sg/pricing),
[FPX](https://docs.stripe.com/payments/fpx),
[PayNow](https://docs.stripe.com/payments/paynow),
[Connect in Malaysia](https://support.stripe.com/questions/connect-availability-for-businesses-located-in-malaysia),
[Connect accounts](https://docs.stripe.com/connect/accounts),
[Stripe countries](https://stripe.com/global);
[HitPay pricing](https://hitpayapp.com/pricing),
[HitPay Malaysia](https://hitpayapp.com/my/payment-gateway),
[HitPay platform API](https://docs.hitpayapp.com/apis/guide/platform-apis),
[HitPay Malaysia pricing](https://hitpayapp.com/my/pricing),
[refunds](https://docs.hitpayapp.com/payments/refund),
[DuitNow](https://docs.hitpayapp.com/payment-methods/duitnow),
[sandbox](https://docs.hitpayapp.com/apis/guide/sandbox),
[platforms](https://docs.hitpayapp.com/platforms/overview),
[OAuth](https://docs.hitpayapp.com/platforms/oauth),
[webhooks](https://docs.hitpayapp.com/apis/guide/events),
[Malaysian onboarding](https://docs.hitpayapp.com/onboarding/requirements-my).
Razorpay Curlec (Malaysia: FPX 1.5%, DuitNow 1.2%, cards 2.4%,
[pricing](https://curlec.com/pricing/)) and Xendit (sub-accounts, split
payments and refunds across Southeast Asia,
[xenPlatform](https://docs.xendit.co/docs/xenplatform-overview.md); fees
*unverified*) are candidates for later.

**Recommendation.**

- **Malaysian venues: Billplz**, each venue on its own account. It is built,
  and much the cheapest on FPX, DuitNow and e-wallets, which is how
  Malaysians pay for a court. The cost is refunds by hand: Billplz has no
  refund API. That is now handled: every refund owed is reconciled, listed,
  and put to the venue's staff daily until marked
  ([payments](../features/payments-and-credit.md#refunds-that-are-interrupted)).
  Offer **Stripe Malaysia** as the alternative for a venue that mostly
  takes cards, or wants membership renewals charged automatically.
- **Singapore venues: Stripe**, each venue on its own (Standard) account:
  PayNow at 1.3%, cards, a refund API, disputes and renewals, all built.
- **MySenam's own invoices to venues:** Stripe in Singapore; Billplz or
  Stripe in Malaysia, as the operating company's registration allows.
- **Do not route venues' takings through MySenam's own merchant account.**
  The current model keeps each venue's money in the venue's account. Holding
  other businesses' money brings licensing and safeguarding questions the
  product does not need to answer now.
- **HitPay: not built now; the next adapter when there is a reason.** See
  below.

### HitPay for small Malaysian venues

What a booking costs the venue in gateway fees (domestic cards; Billplz's
RM999 a year plan not counted in the per-payment figure):

| Booking | Billplz | Billplz, RM999/yr plan | Stripe Malaysia | HitPay Malaysia |
| ------- | ------- | ---------------------- | --------------- | --------------- |
| RM20 by FPX | RM1.25 | RM0.75 | RM1.60 | RM0.76 |
| RM20 by DuitNow QR | RM0.30 | RM0.30 | not offered | RM0.24 |
| RM20 by card | RM0.36 | RM0.36 | RM1.60 | RM1.24 |
| RM50 by FPX | RM1.25 | RM0.75 | RM2.50 | RM1.30 |
| RM50 by DuitNow QR | RM0.75 | RM0.75 | not offered | RM0.60 |
| RM50 by card | RM0.90 | RM0.90 | RM2.50 | RM1.60 |

HitPay saves a small venue a few sen on DuitNow and about RM0.50 on a small
FPX payment against Billplz's free plan; it costs more on cards and on larger
FPX payments. Its refund API would end manual refunds for FPX and cards, but
**not for DuitNow QR**, the cheapest method and the one the comparison is
about; its Malaysian methods cannot be tried in its sandbox; its platform
OAuth is in beta; it documents no idempotency key; and a dispute costs RM200
against a RM15–60 booking. In person, the cheapest QR is the venue's own
bank DuitNow QR at the counter, which MySenam already records as a counter
payment ([payments](../features/payments-and-credit.md)); HitPay's static
DuitNow QR exists only in its own app, not its API.

**Recommendation: keep Billplz and the gateway layer as they are, and do not
build HitPay yet.** It is not a material improvement for Malaysian venues
today. Build it as a third adapter behind the same gateway interface (no
second payment system) when one of these becomes true: the manual-refund
workload recorded on the dashboard ([payments](../features/payments-and-credit.md#refunds-that-are-interrupted))
proves too heavy and venues take mostly FPX and cards; Singapore venues want
PayNow cheaper than Stripe's 1.3% (HitPay 0.9%); or MySenam expands to the
Philippines. Before building, confirm with HitPay how a platform is enabled
for Malaysian merchants and how webhooks reach a platform without each
venue's key, and plan a live check with real money, since the sandbox cannot
do it. Xendit stays the candidate for Indonesia and Vietnam.

## Transactional email

| Provider | ~10,000 a month | ~50,000 a month | SMTP | Bounces to the app |
| -------- | --------------- | --------------- | ---- | ------------------ |
| Amazon SES | $1 (pay as you go); $1.60 on the Essentials plan new accounts default to | $5; $8 | Yes, in Singapore (ap-southeast-1); not in the Malaysia region | Through SNS |
| Resend | $20 (Pro) | $20 (Pro includes 50,000) | Yes | Webhooks |
| Mailgun | $15 | $35 | Yes | Webhooks |
| Brevo | about $17 | about $56 | Yes | Webhooks |
| Postmark | $15 | about $66–87 | Yes | Webhooks |

Sources: [SES pricing](https://aws.amazon.com/ses/pricing/),
[SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html),
[SES notifications](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html),
[Resend](https://resend.com/pricing), [Mailgun](https://www.mailgun.com/pricing/),
[Brevo](https://www.brevo.com/pricing.md), [Postmark](https://postmarkapp.com/pricing).

**Recommendation: Amazon SES in Singapore (ap-southeast-1), over its HTTPS
API or over SMTP**, switched to pay-as-you-go pricing. The app has both
([email transports](messaging.md#email-transports)): the HTTPS API
(`SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_REGION`, `MAIL_FROM`) is
the one to start with, because many cloud hosts refuse outgoing SMTP ports
(25, 465 and 587), the real-service checks cannot reach them from the cloud
environment they run in, and port 443 is not refused; `SMTP_URL` works as it
is wherever those ports are open. SES is the cheapest at this volume by far,
and its bounce and complaint notifications are what reading bounces back
would use later. A new account is in the sandbox (verified recipients only)
until production access is requested. Set up DKIM and DMARC on the sending
domain. Resend is the simpler alternative if a flat $20 a month and webhooks
out of the box are worth more than the saving, but it would need its own
transport, which is not built.

## Phone verification

| Channel | Malaysia | Singapore | Needs |
| ------- | -------- | --------- | ----- |
| WhatsApp authentication template (Meta, per delivered message, rates from 1 October 2026) | US$0.014; **US$0.0418 if the sending business is not Malaysian** | US$0.016 | A verified Meta business, approved templates; a new account reaches 250 people a day, more after verification |
| SMS through Twilio | $0.3389 a message; "RM0" prefix and brand required; links blocked; sender ID replaced by a number; about two weeks to register | $0.0591 a message; the sender ID must be registered with Singapore's SMS Sender ID Registry (S$545 once, S$218 a year), or messages show as "Likely-SCAM" | A UEN and Corppass for Singapore |

Sources: [WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing),
[authentication-international rates](https://developers.facebook.com/docs/whatsapp/pricing/authentication-international-rates),
[messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits),
[Twilio Malaysia](https://www.twilio.com/en-us/sms/pricing/my) and
[guidelines](https://www.twilio.com/en-us/guidelines/my/sms),
[Twilio Singapore](https://www.twilio.com/en-us/sms/pricing/sg),
[SMS Sender ID Registry](https://www.sgnic.sg/smsregistry/overview).
Local SMS aggregators' prices could not be confirmed from official pages.

**Recommendation: WhatsApp first in both countries**, from a WhatsApp
Business account belonging to a company registered in the country whose
numbers it mostly checks (Malaysian numbers cost three times as much from a
foreign business). **No SMS in Malaysia:** it is 24 times the price and the
rules block what a code message needs. **SMS in Singapore only if needed**,
through a registered sender ID. The phone-check settings already work with
either, or neither (numbers are then taken as given; see
[known limitations](../roadmap/known-limitations.md#production-readiness)).

## Photos and off-site backups

| | Cloudflare R2 | Backblaze B2 | AWS S3 Singapore | AWS S3 Malaysia | Wasabi |
| - | ------------- | ------------ | ---------------- | --------------- | ------ |
| Storage, per GB a month | $0.015 | about $0.007 | $0.025 | $0.0225 | from $7.99 a TB, **1 TB minimum** |
| Downloads | Free | Free up to three times what is stored | $0.12 a GB after 100 GB | $0.108 a GB after 100 GB | Free |
| Near Malaysia and Singapore | Best-effort Asia-Pacific hint | **No Asia-Pacific region** | Singapore | Malaysia | Singapore |
| Upload-only key | **No** (read and write at least) | Yes | Yes (an IAM policy allowing only uploads) | Yes | Through policies |
| Versioning, object lock | Not through the S3 API (its own bucket locks) | Yes | Yes | Yes | Yes, set when the bucket is made |

Sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/),
[R2 tokens](https://developers.cloudflare.com/r2/api/tokens/),
[B2 pricing](https://www.backblaze.com/cloud-storage/pricing),
[B2 key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities),
[B2 regions](https://www.backblaze.com/docs/cloud-storage-data-regions),
[Wasabi pricing](https://wasabi.com/pricing); AWS prices from its price list
files of September and October 2026.

**Venue photos: Cloudflare R2.** Photos are read far more than written, and
R2 charges nothing for downloads; the first 10 GB are free.

### Off-site backups

Fourteen nightly sets kept (`T` below is everything stored: a 1 GB nightly
set is about 14 GB, plus a night or two of overlap), one restore a month;
list prices in US dollars a month, before tax:

| Stored | Backblaze B2 | S3 Standard, Malaysia | S3 Standard, Singapore | S3 Glacier Instant Retrieval, Singapore | Cloudflare R2 |
| ------ | ------------ | --------------------- | ---------------------- | --------------------------------------- | ------------- |
| 10 GB | $0.00 | $0.23 | $0.25 | $0.36 | $0.00 |
| 100 GB | $0.63 | $2.25 | $2.50 | $3.45 | $1.35 |
| 1 TB | $6.88 | $22.50 | $25.00 | $34.30 | $14.85 |

- **B2:** $6.95 a TB, first 10 GB free; uploads, listings and downloads free
  (downloads up to three times what is stored); no minimum duration; versions
  billed as storage.
- **S3:** uploads $0.0045–0.005 per 1,000; downloads free within AWS's 100 GB
  a month, then $0.108–0.12 a GB (a whole 71 GB restore adds about $8).
  Archival classes cost *more* for a 14-day rotation: Glacier Instant
  Retrieval bills 90 days for every copy, Standard-IA 30, so each night is
  paid for six or two times over. Use Standard.
- **R2:** free downloads, but no upload-only key and no S3 versions.

| | Backblaze B2 | Amazon S3 | Cloudflare R2 |
| - | ------------ | --------- | ------------- |
| Upload-only key | Yes: `writeFiles`, restricted to a bucket and a prefix (can also hide and overwrite names) | Yes: `s3:PutObject` on the prefix (can overwrite) | **No**: read and write at least |
| Separate read key | `listFiles` + `readFiles` | `s3:ListBucket(Versions)` + `s3:GetObject(Version)` | Object Read only |
| Keeps copies a stolen key cannot destroy | Object Lock (on an existing bucket too), governance or compliance, 1–3,000 days | Object Lock with versioning | Bucket lock rules (no versions) |
| Lock vs lifecycle | Lifecycle cannot delete a locked version | Same | Lock takes precedence |
| Needs `Content-MD5` on upload under a lock | Reported by users; the app always sends it | Yes, documented | Accepted |
| One upload | 5 GB | 5 GiB | 4.995 GiB |
| Regions | US East, US West, EU (Amsterdam), Canada: **none in Asia** | Malaysia (`ap-southeast-5`), Singapore (`ap-southeast-1`) | Location hint `apac`, best effort only; no Asian jurisdiction |
| Encryption at rest | SSE-B2 (switch on) or SSE-C | SSE-S3 by default | Always |

Sources: [B2 key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities),
[B2 keys and the S3 API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys),
[B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock),
[on an existing bucket](https://www.backblaze.com/docs/cloud-storage-enable-object-lock-or-a-legal-hold-on-an-existing-bucket),
[B2 lifecycle rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules),
[B2 S3 API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api),
[B2 pricing](https://www.backblaze.com/cloud-storage/pricing),
[B2 regions](https://www.backblaze.com/docs/cloud-storage-data-regions);
[S3 PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html),
[S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html),
[S3 policy actions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html),
[storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html),
AWS price list files of 15 October 2026;
[R2 tokens](https://developers.cloudflare.com/r2/api/tokens/),
[R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/),
[R2 data location](https://developers.cloudflare.com/r2/reference/data-location/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/).
*Unverified until tried against a real bucket* (`npm run verify-offsite`):
whether a B2 key with `writeFiles` alone may PutObject into a bucket with a
default retention; the region B2 expects in the signature; default retention
on an existing B2 bucket (Backblaze's pages disagree); and whether S3 needs
`Content-MD5` under a default retention alone.

**The app works with all three without changes** — signed PUTs with
`Content-MD5` (in parts, for a large backup), an upload key that is never asked to read, list or delete, a
separate read key, client-side encryption, and a restore that takes each
name's first version where versions can be listed — tested against stand-ins,
not real buckets ([backups](../operations/backups.md#off-site-copies)).

**Recommendation: Backblaze B2, US West region, for both installs**
(decided 2026-10-24, [ADR 0015](../architecture/decisions/0015-backblaze-b2-preferred-signed-backup-sets.md),
superseding the earlier recommendation of S3 in the install's own country).
Set it up with Object Lock (14 days, governance), the lifecycle rule, an
upload-only key, the read key off the server, encryption and manifest signing
on, and the transfer safeguards in
[privacy](../architecture/privacy.md#backups-held-abroad) in place; the app
will not send to it until `OFFSITE_TRANSFER_APPROVED=US` is set. B2 is
cheaper than S3 by about a third at 100 GB and two thirds at 1 TB, and meets
the security requirements with Object Lock.

Choosing the B2 region:

| | US West | US East | EU Central | CA East |
| - | ------- | ------- | ---------- | ------- |
| Where | Sacramento and Phoenix areas | Reston, Virginia | Amsterdam | Toronto |
| Round trip from Singapore (estimate, not measured) | 170–210 ms | 220–260 ms | 150–190 ms | not estimated |
| Jurisdiction | US | US | Netherlands (EU) | Canada |

- **US West is recommended** of the two US regions: it is the shorter path
  from Malaysia and Singapore, and so the faster restore. A nightly upload
  of a few hundred MB is not sensitive to latency either way.
- **Durability and availability are not published per region.** Backblaze
  states 11 nines of durability as a design target and a 99.9% uptime SLA.
- **EU Central is the alternative** if the operator prefers EU
  jurisdiction; it is the shortest path of the four.
- **The region is fixed when the B2 account is created** and cannot be
  changed; moving means a new account and copying the data across.
- **Record the region you get.** The cluster number is assigned by
  Backblaze, so record the endpoint the Buckets page shows (for example
  `s3.us-west-004.backblazeb2.com`) as `OFFSITE_S3_ENDPOINT`. The app reads
  the region and country from it and pauses copies if they disagree with
  `OFFSITE_DATA_LOCATION`.
- **Measure before relying on it.** Ping the endpoint, and run
  `npm run verify-offsite -- --go --size-mb 200` with synthetic data.

Sources: [B2 data regions](https://www.backblaze.com/docs/cloud-storage-data-regions),
[sub-processors](https://www.backblaze.com/company/policy/subprocessors),
[S3 endpoints](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api),
[SLA](https://www.backblaze.com/company/policy/sla).

**Amazon S3 stays fully supported.** It is the choice when data must stay
in the country: Malaysia (`ap-southeast-5`) or Singapore (`ap-southeast-1`),
with versioning, Object Lock and the same keys. Existing S3 configurations
need no change. **Not R2 for backups:** it has no upload-only key.

## Launch stack, and what is still to decide

| Need | Recommended | Alternative |
| ---- | ----------- | ----------- |
| Venue payments, Malaysia | Billplz (each venue's own account) | Stripe Malaysia |
| Venue payments, Singapore | Stripe (each venue's own account) | HitPay, once an adapter is built |
| MySenam's invoices to venues | Stripe (Singapore); Billplz or Stripe (Malaysia) | — |
| Email | Amazon SES, Singapore, SMTP | Resend |
| Phone checks | WhatsApp authentication templates | SMS in Singapore through a registered sender |
| Photos | Cloudflare R2 | Amazon S3 |
| Off-site backups | Backblaze B2, US West, Object Lock, upload-only key, encrypted and signed, once the transfer safeguards are in place | Amazon S3 Standard in the install's country |

Decided: Billplz's manual refunds are accepted for a small Malaysian launch,
provisionally, with the refund workload watched on the dashboard; HitPay is
deferred (above).

### Operating company and jurisdictions

MySenam runs one install per country, and everything that depends on who
operates it is configuration, not code, so no company structure is built in:

| What | Set by | Per |
| ---- | ------ | --- |
| Operating company named in the terms and privacy notice | `OPERATOR_NAME`, `OPERATOR_REG_NO`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` | install |
| Venue country: currency, tax names, phone numbers, time zone, laws cited | `MYSENAM_COUNTRY` | install |
| Venues' takings | each venue's own gateway account | venue |
| MySenam's invoices to venues, and its tax registration | `MYSENAM_PAYMENT_PROVIDER` and its keys, `MYSENAM_TAX_RATE`, `MYSENAM_TAX_REG_NO`, `MYINVOIS_*` | install |
| WhatsApp and messaging | `WHATSAPP_*`, `SES_*` or `SMTP_URL`, `MAIL_FROM`, `SMS_*` | install |
| Where data is kept | the database host, `PHOTOS_S3_*`, `OFFSITE_S3_*` with `OFFSITE_DATA_LOCATION` | install |

Customers' own countries do not change any of these: a booking is governed
by the install of the venue's country.

Decisions for the operator, before commercial deployment:

1. Which legal entity operates each install, and so signs the Billplz or
   Stripe account for invoices, the WhatsApp Business account, the provider
   contracts and the privacy notice; whether one company serves both
   countries or each has its own.
2. Whether that entity must register for SST (Malaysia) or GST (Singapore)
   on what it charges venues, and for MyInvois as an intermediary.
3. Where each install's database, photos and backups are hosted, and the
   privacy notice and venue agreement wording that says so.
4. The roles and safeguards in [privacy](../architecture/privacy.md#where-personal-data-is-kept).
   Backups may be held abroad (decided by the owner on 24 October 2026); the
   transfer safeguards in [privacy](../architecture/privacy.md#backups-held-abroad)
   are still to be done and recorded.
5. Each provider's terms, checked by the operator; and the live checks in
   the [launch checklist](../operations/deployment.md#launch-integration-checklist)
   once accounts exist.
