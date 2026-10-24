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
| Settlement | FPX next business day, cards two business days | Stripe's schedule | Stripe's schedule | *unverified* |
| Refunds | **No refund API**: FPX refunds are a payout to the customer's bank account (a V5 Payment Order); card refunds through support | API; no refund fee, processing fee not returned | Same | API; no refund fee |
| Disputes | Through Billplz | RM90 each | S$15 each | *unverified* |
| Recurring | Card tokens charged by the merchant (Auto-Deduct, applied for separately) | Billing, 0.7% of volume | Billing, 0.7% | Recurring billing offered |
| Who can sign up | Businesses registered with SSM or ROS with a Malaysian corporate bank account; sole proprietors *unverified* | A business registration number for FPX | A Singapore business | *unverified* |
| Platform accounts | Not offered | Connect only with Stripe owning fees and loss (each venue its own Standard-style account); Express and Custom not listed for Malaysia | Express and Custom available | Platform API with sub-accounts; who checks the sub-merchants and how they are settled *unverified* |
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
[HitPay platform API](https://docs.hitpayapp.com/apis/guide/platform-apis).
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
- **Evaluate HitPay as the first new adapter**, before Southeast Asian
  expansion: cheaper cards in Malaysia, DuitNow, the Philippines, and a
  platform API. Confirm first how it vets and settles sub-merchants. Xendit
  is the candidate for Indonesia and Vietnam.

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

**Recommendation: Amazon SES in Singapore (ap-southeast-1) over SMTP**,
switched to pay-as-you-go pricing. It works with `SMTP_URL` as it is, it is
the cheapest at this volume by far, and its bounce and complaint
notifications are what reading bounces back would use later. Set up SPF,
DKIM and DMARC on the sending domain. Resend is the simpler alternative if a
flat $20 a month and webhooks out of the box are worth more than the
saving.

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

**Recommendation.**

- **Venue photos: Cloudflare R2.** Photos are read far more than written, and
  R2 charges nothing for downloads; the first 10 GB are free.
- **Off-site backups: Amazon S3 in Malaysia (ap-southeast-5) or Singapore**,
  with versioning and object lock on, a lifecycle rule to expire old copies,
  an upload-only key on the server and a read key kept off it. At a few
  gigabytes a night this costs well under a dollar a month, keeps customers'
  data in the region, and gives the upload-only key the backup design
  relies on. **Not R2 for backups:** it cannot issue an upload-only key.
  Backblaze B2 is cheaper and can, but has no Asia-Pacific region; storing
  customers' data in the US or EU is a data-protection question for the
  operator's adviser, not one answered here.

## Launch stack, and what is still to decide

| Need | Recommended | Alternative |
| ---- | ----------- | ----------- |
| Venue payments, Malaysia | Billplz (each venue's own account) | Stripe Malaysia |
| Venue payments, Singapore | Stripe (each venue's own account) | HitPay, once an adapter is built |
| MySenam's invoices to venues | Stripe (Singapore); Billplz or Stripe (Malaysia) | — |
| Email | Amazon SES, Singapore, SMTP | Resend |
| Phone checks | WhatsApp authentication templates | SMS in Singapore through a registered sender |
| Photos | Cloudflare R2 | Amazon S3 |
| Off-site backups | Amazon S3 (Malaysia or Singapore), versioned, upload-only key | Backblaze B2 |

Decisions for the operator, before anything is signed up for or paid:

1. Which company operates MySenam in each country. It decides the Billplz
   and Stripe accounts for invoices, and what WhatsApp costs per country.
2. Whether Billplz's manual refunds are acceptable for Malaysian venues at
   launch, or whether Stripe Malaysia should be the default despite its fees.
3. Whether to build a HitPay adapter before expanding beyond Malaysia and
   Singapore.
4. Whether customer data may be stored outside Malaysia and Singapore (B2).
5. Each provider's terms, checked by the operator; and the live checks in
   the [launch checklist](../operations/deployment.md#launch-integration-checklist)
   once accounts exist.
