# MySenam needs proof, not more features

> **Research report, 18 October 2026.** The synthesis of the
> go-to-market research. Moved from `reports/MySenam go to market research.md`
> on 24 October 2026; its findings and recommendations are unchanged, and its
> links to code now point to commit `77f0401`, the code it read. Its
> recommendations are not product decisions: which were adopted is in the
> [overview](index.md).

MySenam should not launch at RM10 or RM19.90 per venue. It should spend the next 30 days finding out whether any Malaysian venue will pay for it at all, and it should not build more features while it does. As built, the business loses money on every venue. The default monthly fee is **RM0**, and WhatsApp is free for venues on that fee, so each venue costs the platform about **RM17 to RM203 a month** depending on size ([repo: src/lib/billing.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/billing.ts); [repo: src/lib/whatsapp-usage.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/whatsapp-usage.ts)). Flat prices of RM10 or RM19.90 that include 300 WhatsApp messages are loss-making for most venue sizes once messaging is costed at the worst-case Meta rate. Those 300 messages alone cost up to **RM18.27**, more than the whole RM10 fee. The one structure that stays positive in every size band we modelled is a subscription that grows with court count, with WhatsApp billed from the first message. But most of its margin comes from reselling messages, and that margin disappears if Meta's reported 1 October 2026 charges for in-window replies are real. The market already has a price anchor: Courtsite, AFA and Courtease all list **RM99 a month**. Courtsite and AFA add an undisclosed transaction fee. Courtsite claims **389 centres and 807,360 users** ([Courtsite Business](https://business.courtsite.my)). MySenam has **no customers, no pilots and no customer evidence of any kind**. All 80 commits were written by an AI over five weeks, and every "working" feature has been tested only against its own test suite ([product audit, repo git log](https://github.com/nasi-lemak/MySenam/commits/77f0401)). The recommendation is to fix a short list of trust blockers, set a contribution-positive price, and run a 30-day validation sprint with explicit kill criteria aimed at independent badminton and futsal halls that still book by hand. MySenam should go to market as a venue operations tool, not a marketplace.

**How to read this report.** Every factual claim carries one of four labels. **VERIFIED** means it was read on the official or primary page, or in MySenam's own code. **REPORTED** means it came from third parties, search snippets or interested vendors. **ASSUMPTION** means it is our modelling input. **UNKNOWN** means we looked and could not find it. All web sources were retrieved on **2026-10-18**. Repository paths refer to `/home/user/MySenam` at HEAD `77f0401`. FX is USD 1 = RM4.0837 (BNM reference rate, 16 Oct 2026, VERIFIED) ([BNM](https://www.bnm.gov.my/kuala-lumpur-usd/myr-reference-rate)).

## Executive recommendation: run an evidence sprint, not a launch

The evidence supports five decisions.

The first is to **stop treating the price question as RM10 versus RM19.90**. Both flat options lose money at the 4-court and 10-court sizes in our base case, and at almost every utilisation level once the 300 included messages are used. The decision should be between court-count structures with messaging billed separately.

The second is a **pricing decision for pilots** (detailed below): RM9.90 base plus RM3 per active court. WhatsApp is opt-in at RM0.10 per template from the first message, with no bundled allowance. Email confirmations are free and are the default. Annual prepay gets two months free. A higher price card (RM19.90 plus RM5 per court) is tested in parallel. These are hypotheses to test, not validated prices.

The third is a **launch position** built on the one claim MySenam can prove and Courtsite and AFA cannot: every ringgit MySenam charges is published, and booking money goes straight into the venue's own Billplz account, never through MySenam. This needs care, because Courtease already claims "RM 0 commission" and direct settlement ([Courtease business](https://courtease.my/business)). It is a transparency claim, not a uniqueness claim.

The fourth is a **pre-pilot fix list** taken from the audit. Add password reset and change. Refuse to start in production with the default admin password. Record who marked a booking paid. Alert by email when a backup fails. Add security headers. Confirm Meta's billing in WhatsApp Manager. Set `MYSENAM_VENUE_FEE` above zero. A paying operator would hit each of these gaps within weeks ([repo: src/lib/admin-auth.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/admin-auth.ts); [repo: db/migrations/0001_initial.sql](https://github.com/nasi-lemak/MySenam/blob/77f0401/db/migrations/0001_initial.sql); [repo: src/lib/scheduler.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/scheduler.ts)).

The fifth is a **feature freeze**. The codebase already has 118 API routes, 54 tables and tournaments, leagues, storefronts and open games. Not one of these has been used by a real venue. The commercial question is distribution and willingness to pay, and more features will not answer it.

## Incumbents anchor at RM99 a month plus hidden transaction fees

The Malaysian market has converged on a visible price point. **Courtsite** lists Starter at **RM99 a month plus a transaction fee** and Advanced at **RM199 plus a transaction fee**, which adds IoT lighting and a multi-sports scheduler. Elite is custom. All three are VERIFIED on its pricing page ([Courtsite pricing](https://business.courtsite.my/pricing)). The transaction fee is defined only as fees "as agreed in writing" (amount UNKNOWN) ([Courtsite business terms](https://business.courtsite.my/terms/service)). **AFA** publishes almost the same structure: Standard **RM99** and PRO **RM199**, each plus an unpublished transaction fee, or RM990 and RM1,990 a year ([AFA for Business](https://www.afa.community/afa-for-business/)). **Courtease**, registered as COURTEASE ENTERPRISE in Kampar, Perak, charges a flat **RM99 a month per venue with "RM 0 commission"**. Perak early adopters get six months free, then RM49 for six months ([Courtease help](https://courtease.my/help)). The notes conflict on Courtsite. Two research passes recorded Courtsite's venue pricing as UNKNOWN because `courtsite.my/pricing` returned 404 and the FAQ showed no fees. The third pass read the figures directly on `business.courtsite.my/pricing`. We treat the RM99 and RM199 figures as VERIFIED from that page, and the transaction fee as UNKNOWN.

The international benchmarks sit far above the proposed MySenam prices. **CourtReserve** charges **US$199, US$369 and US$549 a month** for 8, 16 and 32 courts, which is about **RM70–102 per court per month**. It includes **500 SMS a month**, then US$5 per 500 ([CourtReserve pricing](https://courtreserve.com/pricing/)). **Playtomic Manager's** embedded price data shows **€59 to €279 a month** for Spain (Standard, about RM271). No Malaysian or SEA billing region appears ([Playtomic pricing](https://playtomic.com/pricing)). On top of that, Playtomic takes a contract-defined booking commission from clubs ([Playtomic OBM guide](https://helpmanager.playtomic.com/hc/en-gb/articles/44898846238609-OBM-Guide-How-the-Old-Billing-Model-Works)). Players pay a **4% service fee on open matches and activities** in Singapore, Indonesia and Thailand. **Malaysia is not on that list**, so whether Malaysian players pay is UNKNOWN ([Playtomic service fee](https://playerhelp.playtomic.com/hc/en-gb/articles/19831779272337-Service-Fee)). Playtomic is nonetheless live in KL: City Padel KL, SkyCourts at Perdana KLCC and PadelDepot all have Playtomic club pages (VERIFIED) ([City Padel KL](https://playtomic.com/clubs/city-padel-kl)).

Nobody publishes WhatsApp messaging prices. Courtsite documents email confirmations only ([Courtsite help: booking](https://www.courtsite.my/support/faq/booking)). AFA documents push notifications and RSVP reminders ([AFA](https://www.afa.community/)). Courtease's confirmation channel is UNKNOWN. That makes MySenam's metered WhatsApp a real point of difference, but "not documented" is not the same as "absent". The claim has to be checked by trialling each competitor before MySenam uses it in marketing.

### Competitor comparison

| Platform | Model | Venue price | Transaction / payment fees | Messaging | Who holds booking money | Target customers | Scale claim |
|---|---|---|---|---|---|---|---|
| **Courtsite** (MY) | Marketplace (PWA) + venue SaaS | RM99 / RM199 / custom per month; yearly saves 15% (VERIFIED) | Transaction fee charged, amount UNKNOWN; Curlec gateway (VERIFIED) | Email confirmations VERIFIED; WhatsApp/SMS to players UNKNOWN; support via WhatsApp and live chat | Courtsite collects, sets off fees, pays out within 3 business days of cycle end (VERIFIED); cycle length UNKNOWN | Badminton, pickleball, futsal and 65 sports; PSM and BAM anchor clients | 389 centres, 807,360 users, 12.35M booking hours (VERIFIED own counter) |
| **AFA Community** (MY) | Consumer superapp + venue SaaS | RM99 / RM199 / custom; RM990 / RM1,990 yearly (VERIFIED) | Transaction fee UNKNOWN; split-payment fees "may be charged" (VERIFIED terms) | Push notifications ("10 units worth RM4000" bundled), RSVP reminders (VERIFIED); WhatsApp to players UNKNOWN | AFA as agent; AFA e-wallet (VERIFIED) | Social players and venues; padel and pickleball listed | 600,000+ users, 280+ vendors, 4 countries (VERIFIED own claim) |
| **Courtease** (MY) | Marketplace + venue SaaS, very early | RM99 per venue; Perak promo 6 months free then RM49 (VERIFIED) | No Courtease commission; "standard FPX gateway fee" via ToyyibPay, amount passed on UNKNOWN (ToyyibPay FPX list price RM1.00, VERIFIED) | UNKNOWN | Direct to venue via ToyyibPay, 1–3 business days (VERIFIED) | Independent courts, Perak-first | UNKNOWN (homepage count loads client-side) |
| **CourtReserve** (US) | Pure SaaS | US$199/369/549 for 8/16/32 courts; add-ons US$25–99 (VERIFIED) | Stripe 2.9% + US$0.30 (VERIFIED); MYR/FPX UNKNOWN | 500 SMS included, US$5 per 500 after; push unlimited (VERIFIED) | Club's own Stripe (implied) | Tennis, pickleball, padel clubs | UNKNOWN |
| **Playtomic** (ES) | SaaS + marketplace + player fees | €59–279/month Spain region; MY region UNKNOWN (VERIFIED data) | Club commission % by contract, UNKNOWN; player service fee 4% on matches in SG/ID/TH (VERIFIED); MY UNKNOWN | Chats, campaigns; SMS/WhatsApp UNKNOWN | Playtomic collects, pays net biweekly under old model (VERIFIED) | Padel-first commercial clubs | 6,700+ clubs (VERIFIED claim); €29M net revenue to Sep 2025 (REPORTED) |
| **Reclub** (VN/SG) | Free social app, supporter subscription | Free; supporter US$2–3/month (VERIFIED) | "Does not support payments yet" (VERIFIED) | In-app only | n/a | Pickleball open-play organisers | 4.82★ from 4,519 MY App Store ratings (VERIFIED) |
| **Vyrox SPORTSERVA** (MY) | Venue SaaS | Free RM0 (one module) / Premium RM700 (VERIFIED) | UNKNOWN | UNKNOWN | UNKNOWN | Sports facilities | No named clients |
| **Playbypoint** (US) | Venue SaaS | UNKNOWN (pricing page blocked) | UNKNOWN | UNKNOWN | UNKNOWN | Pickleball/racquet | 2 of 26 sampled KL pickleball venues (VERIFIED sample) |
| **Book & Go** | White-label club app | "Simple subscription", price UNKNOWN; "zero commissions" (VERIFIED claim) | UNKNOWN | UNKNOWN | UNKNOWN | Badminton/padel clubs | Malaysia dashboard labelled "SAMPLE DATA" |
| **MySenam** (as built) | Venue SaaS + optional marketplace | Default **RM0**, 1 free month, per-venue fee settable (VERIFIED code) | No commission; booking money to venue's own Billplz; platform pays Billplz on its own invoice collection (VERIFIED code) | WhatsApp 300/month included then RM0.08; click-to-chat free replies; email; **no reminders** (VERIFIED code) | Venue's own Billplz account (VERIFIED code) | Not chosen | **Zero venues, zero users** (VERIFIED: seed data only) |

The structural lesson goes beyond price. Courtsite's terms tie marketplace listing to the paid Console subscription: "suspension or termination of your subscription to the Courtsite Console Service shall result in the suspension and/or termination of … Courtsite Platform Service" ([Courtsite business terms](https://business.courtsite.my/terms/service)). A venue cannot keep a free Courtsite listing for demand while running operations on MySenam. To coexist, it would pay RM99 or more to Courtsite plus whatever MySenam charges. That weakens the "keep your listing, switch your back office" pitch the segment research proposed. It points MySenam at venues that are on no platform at all.

## Flat RM10 and RM19.90 lose money once WhatsApp is counted

### Inputs: verified versus assumed

| Input | Value used | Label | Source |
|---|---|---|---|
| WhatsApp utility template, Malaysia | RM0.0564 per delivered message | REPORTED (Meta rate card not fetchable; three consistent third parties) | [Flowcall](https://www.flowcall.co/blog/whatsapp-business-api-pricing); [Seampify](https://www.seampify.com/whatsapp-api-price/) |
| Meta charges only templates, per delivered message | Since 1 Jul 2025 | VERIFIED | [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing) |
| In-window replies and utility templates free | Official page says free; BSPs say chargeable from 1 Oct 2026 after 1,000 free service messages per number | **CONFLICT, unresolved** | [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing) vs [YCloud](https://www.ycloud.com/blog/whatsapp-api-message-pricing-update-effective-october-1-2026) |
| 8% SToDS on Meta and DigitalOcean bills | ×1.08 → WhatsApp RM0.0609 | ASSUMPTION (worst case) | [PayPro Global](https://payproglobal.com/saas-sales-tax/malaysia/) on SToDS generally |
| Malaysian BSP reseller utility rate | RM0.12 | REPORTED | [iWSApp](https://iwsapp.my/pricing.php) |
| MySenam allowance and overage | 300 included, RM0.08 each after, counted on paid templates only; free replies counted separately and not billed | VERIFIED code | [repo: src/lib/whatsapp-usage.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/whatsapp-usage.ts) |
| Messages per booking | 1.1 (one confirmation + 10% cancellations); reminders do not exist | ASSUMPTION built on VERIFIED code (5 message kinds, no reminders) | [repo: src/lib/outbox.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/outbox.ts) |
| Phone-verification OTP | 0.05 per booking at RM0.0609, platform's cost | ASSUMPTION; that OTP is the platform's cost is VERIFIED in the README | [repo: README.md](https://github.com/nasi-lemak/MySenam/blob/77f0401/README.md) |
| Billplz FPX Basic | RM1.25 per transaction (×1.08 worst-case tax = RM1.35) | VERIFIED fee; tax ASSUMPTION | [Billplz pricing](https://main.billplz.com/pricing) |
| HitPay DuitNow QR / Billplz card | 1.2% / 1.8% | VERIFIED | [HitPay](https://www.hitpayapp.com/my/pricing); [Billplz](https://main.billplz.com/pricing) |
| Hosting per venue | RM7.92 (10 venues), RM2.00 (100), RM0.74 (1,000), ×1.08 | VERIFIED DO list prices; stack ASSUMPTION | [DO droplets](https://www.digitalocean.com/pricing/droplets); [DO managed DB](https://www.digitalocean.com/pricing/managed-databases) |
| Loaded support cost | RM21.8 per productive hour (RM2,500 salary + EPF/SOCSO/EIS, 75% productive) | REPORTED salary; ASSUMPTION productivity | [AJobThing](https://www.ajobthing.com/resources/recruitment-tools/salary-comparison-tool/customer-service-executive-salary-in-kuala-lumpur) |
| Support hours per venue per month | 0.25 / 0.5 / 0.75 / 1.0 for 1 / 4 / 10 / 20 courts | ASSUMPTION | none; no public benchmark found |
| Open hours, utilisation, booking length | 16 h/day, 30 days; 20/40/60%; average 1, 1.5, 2 h (bookings are whole hours, so 1.5 h is a mix) | ASSUMPTION; Malaysian court utilisation is UNKNOWN | [repo: src/lib/types.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/types.ts) for whole-hour limit |
| Monthly logo churn | 6.1% (ARPA < US$25) | REPORTED | [ChartMogul blog](https://chartmogul.com/blog/saas-churn) |
| Service tax on MySenam | 8% only above RM500k taxable turnover in 12 months; not charged below | REPORTED | [Grant Thornton MY](https://www.grantthornton.com.my/insights/articles-and-publications/sales-service-tax-sst-malaysia-overview/) |

### Formulas

All figures are RM per venue per month, excluding SST. The arithmetic was run in a short Python script. No repository file other than this report was changed.

**Bookings** B = courts × 16 × utilisation × 30 ÷ average booking hours
**Template messages** M = B × 1.1. In the worst case, chat replies are also charged by Meta.
**WhatsApp cost** = (M_charged + 0.05·B) × 0.0609
**Messaging revenue** = max(0, M_billable − allowance) × price. The allowance is 300 and the price RM0.08 as built. In the metered models the allowance is 0.
**Subscription:** A = RM10; B = RM19.90; C = RM9.90 + RM3 × courts; D = court tiers (ASSUMPTION: RM15 for 1–3 courts, RM29 for 4–8, RM49 for 9–16, RM79 for 17–32, mirroring CourtReserve's banding); E = RM19.90 with all WhatsApp metered; F = C with all WhatsApp metered.
**Gateway** = RM1.35 per monthly invoice (Billplz FPX), or 1.2% / 1.8% of the invoice
**Contribution margin (CM)** = revenue − WhatsApp − gateway − hosting (RM2.16) − support (hours × 21.8)

### Base case: 40% utilisation, 1.5-hour average booking, worst-case WhatsApp

| Model | 1 court | 4 courts | 10 courts | 20 courts |
|---|---|---|---|---|
| Bookings / template messages | 128 / 141 | 512 / 563 | 1,280 / 1,408 | 2,560 / 2,816 |
| WhatsApp cost to MySenam | 8.97 | 35.86 | 89.66 | 179.32 |
| Support cost | 5.45 | 10.90 | 16.35 | 21.80 |
| **A RM10 flat, 300 included** (revenue → CM) | 10.00 → **−7.93** | 31.06 → **−19.22** | 98.64 → **−10.88** | 211.28 → **+6.65** |
| **B RM19.90 flat, 300 included** | 19.90 → **+1.97** | 40.96 → **−9.32** | 108.54 → **−0.98** | 221.18 → **+16.55** |
| **C RM9.90 + RM3/court, 300 included** | 12.90 → **−5.03** | 42.96 → **−7.32** | 128.54 → **+19.02** | 271.18 → **+66.55** |
| **D court tiers, 300 included** | 15.00 → **−2.93** | 50.06 → **−0.22** | 137.64 → **+28.12** | 280.28 → **+75.65** |
| **E RM19.90 + all WhatsApp at RM0.08** | 31.16 → **+13.24** | 64.96 → **+14.68** | 132.54 → **+23.02** | 245.18 → **+40.55** |
| **F RM9.90 + RM3/court + all WhatsApp at RM0.08** | 24.16 → **+6.24** | 66.96 → **+16.68** | 152.54 → **+43.02** | 295.18 → **+90.55** |
| **As built: RM0 fee, WhatsApp free** | 0 → **−16.58** | 0 → **−48.92** | 0 → **−108.17** | 0 → **−203.28** |

The table shows three things. The included allowance is the problem. At the worst-case unit cost, 300 included messages cost **RM18.27**, so any flat fee under about RM25 that bundles them loses money on a venue that uses its allowance. The overage line also produces most of the revenue. A 10-court venue's RM98.64 bill under model A is 90% WhatsApp. In other words, "RM10 a venue" is not what a busy venue would actually pay. And the built default (RM0 fee, free messaging) is not a pricing model at all. It is a subsidy of about **RM71 per venue per month in messaging alone** on our assumed venue mix, and about **RM927 a month in total for 10 mixed-size pilots** once hosting at small scale and support are added.

### Utilisation and booking-length grid (CM, worst-case WhatsApp)

Columns are utilisation (20/40/60%) by average booking length (1 h / 1.5 h / 2 h).

| Model, courts | 20%·1h | 20%·1.5h | 20%·2h | 40%·1h | 40%·1.5h | 40%·2h | 60%·1h | 60%·1.5h | 60%·2h |
|---|---|---|---|---|---|---|---|---|---|
| A, 1 | −5.68 | −3.44 | −2.32 | −12.41 | −7.93 | −5.68 | −17.79 | −12.41 | −9.05 |
| A, 4 | −21.52 | −22.34 | −17.86 | −14.62 | −19.22 | −21.52 | −7.73 | −14.62 | −18.07 |
| A, 10 | −16.63 | −22.37 | −25.24 | 0.61 | −10.88 | −16.63 | 17.84 | 0.61 | −8.01 |
| A, 20 | −4.84 | −16.33 | −22.08 | 29.62 | 6.65 | −4.84 | 64.09 | 29.62 | 12.39 |
| B, 1 | 4.22 | 6.46 | 7.58 | −2.51 | 1.97 | 4.22 | −7.89 | −2.51 | 0.85 |
| B, 4 | −11.62 | −12.44 | −7.96 | −4.72 | −9.32 | −11.62 | 2.17 | −4.72 | −8.17 |
| B, 10 | −6.73 | −12.47 | −15.34 | 10.51 | −0.98 | −6.73 | 27.74 | 10.51 | 1.89 |
| B, 20 | 5.06 | −6.43 | −12.18 | 39.52 | 16.55 | 5.06 | 73.99 | 39.52 | 22.29 |
| C, 1 | −2.78 | −0.54 | 0.58 | −9.51 | −5.03 | −2.78 | −14.89 | −9.51 | −6.15 |
| C, 4 | −9.62 | −10.44 | −5.96 | −2.72 | −7.32 | −9.62 | 4.17 | −2.72 | −6.17 |
| C, 10 | 13.27 | 7.53 | 4.66 | 30.51 | 19.02 | 13.27 | 47.74 | 30.51 | 21.89 |
| C, 20 | 55.06 | 43.57 | 37.82 | 89.52 | 66.55 | 55.06 | 123.99 | 89.52 | 72.29 |
| D, 1 | −0.68 | 1.56 | 2.68 | −7.41 | −2.93 | −0.68 | −12.79 | −7.41 | −4.05 |
| D, 4 | −2.52 | −3.34 | 1.14 | 4.38 | −0.22 | −2.52 | 11.27 | 4.38 | 0.93 |
| D, 10 | 22.37 | 16.63 | 13.76 | 39.61 | 28.12 | 22.37 | 56.84 | 39.61 | 30.99 |
| D, 20 | 64.16 | 52.67 | 46.92 | 98.62 | 75.65 | 64.16 | 133.09 | 98.62 | 81.39 |
| E, 1 | 12.66 | 12.09 | 11.80 | 14.39 | 13.24 | 12.66 | 16.11 | 14.39 | 13.52 |
| E, 4 | 12.38 | 10.09 | 8.94 | 19.28 | 14.68 | 12.38 | 26.17 | 19.28 | 15.83 |
| E, 10 | 17.27 | 11.53 | 8.66 | 34.51 | 23.02 | 17.27 | 51.74 | 34.51 | 25.89 |
| E, 20 | 29.06 | 17.57 | 11.82 | 63.52 | 40.55 | 29.06 | 97.99 | 63.52 | 46.29 |
| F, 1 | 5.66 | 5.09 | 4.80 | 7.39 | 6.24 | 5.66 | 9.11 | 7.39 | 6.52 |
| F, 4 | 14.38 | 12.09 | 10.94 | 21.28 | 16.68 | 14.38 | 28.17 | 21.28 | 17.83 |
| F, 10 | 37.27 | 31.53 | 28.66 | 54.51 | 43.02 | 37.27 | 71.74 | 54.51 | 45.89 |
| F, 20 | 79.06 | 67.57 | 61.82 | 113.52 | 90.55 | 79.06 | 147.99 | 113.52 | 96.29 |

The models with an allowance behave in a way that runs against intuition. The 4-court venue is the worst customer at almost every utilisation. It burns through most or all of the 300 free messages, but it generates too little overage to pay for the subscription's fixed costs. Only the fully metered models (E and F) are positive in all 36 cells.

### Messaging scenarios and the unresolved Meta risk

The worst case set by the brief is that Meta now charges service and in-window messages. That case hits MySenam's "Send it to my WhatsApp" feature in a way the code does not anticipate. The usage meter counts chat replies **separately as free and never bills them to the venue** ([repo: src/lib/whatsapp-usage.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/whatsapp-usage.ts)). The platform sends from one shared number. The reported allowance of 1,000 free service messages per business number per month would therefore be used up across all venues within days ([YCloud](https://www.ycloud.com/blog/whatsapp-api-message-pricing-update-effective-october-1-2026)). If half of customers use the chat button and Meta charges those replies, the feature becomes a margin leak.

| Scenario, 10 courts, 40%, 1.5 h | C (300 incl.) CM | D (300 incl.) CM | F (metered RM0.08) CM | A (RM10) CM |
|---|---|---|---|---|
| Worst case set by brief: all messages charged, RM0.0609 | 19.02 | 28.12 | 43.02 | −10.88 |
| Best case: Meta page correct, 50% of confirmations go free | 10.56 | 19.66 | 34.56 | −19.34 |
| **Worst+: 50% use chat, Meta charges replies, MySenam bills none** | **−32.18** | **−23.08** | **−8.18** | **−62.08** |
| Reminders added (2.1 messages/booking) | 43.45 | 52.55 | 67.45 | 13.55 |
| Forced through a BSP at RM0.12 | −67.96 | −58.86 | −43.96 | −97.86 |

Even in the best case, the free-reply feature *reduces* MySenam's contribution, because it removes billable overage messages. Its value is to the venue's bill, not to MySenam's margin. That is a legitimate sales feature. But it has to be priced into the subscription, not paid for out of messaging margin. Until WhatsApp Manager shows how MySenam's own account is actually billed, the code should count chat replies as billable whenever Meta charges for them.

### Sensitivity analysis

One input is varied at a time around the 10-court base case (40%, 1.5 h, worst-case WhatsApp). Model F is the strongest candidate and model C is the "allowance" variant of the same structure.

| Variable changed | F: CM (Δ) | C: CM (Δ) |
|---|---|---|
| Base | 43.02 | 19.02 |
| WhatsApp via BSP at RM0.12 | −43.96 (−86.98) | −67.96 (−86.98) |
| Support hours ×4 (3 h/month) | −6.03 (−49.05) | −30.03 (−49.05) |
| Overage price RM0.10 instead of RM0.08 | 71.18 (+28.16) | 41.18 (+22.16) |
| Reminders added (2.1 messages/booking) | 67.45 (+24.43) | 43.45 (+24.43) |
| Support hours ×2 | 26.67 (−16.35) | 2.67 (−16.35) |
| Utilisation 20% / 60% | 31.53 / 54.51 (∓11.49) | 7.53 / 30.51 (∓11.49) |
| Booking length 1 h / 2 h | 54.51 / 37.27 | 30.51 / 13.27 |
| Support hours ×0.5 | 51.19 (+8.17) | 27.19 (+8.17) |
| WhatsApp RM0.0564 with no SToDS | 49.66 (+6.64) | 25.66 (+6.64) |
| Hosting at 10-venue scale | 36.62 (−6.39) | 12.62 (−6.39) |
| Collection: card 1.8% / DuitNow QR 1.2% / annual FPX | 41.40 / 42.39 / 44.26 | 17.87 / 18.70 / 20.26 |
| Hosting at 1,000-venue scale | 44.38 (+1.36) | 20.38 (+1.36) |

The ranking is clear. **Support time and the per-message cost dominate. Utilisation is second-order. Hosting and the collection method barely matter at 10 courts.** The break-even support load under model F is **0.54 h a month for a 1-court venue, 1.27 h for 4 courts, 2.72 h for 10 and 5.15 h for 20**. One onboarding call a month for a small venue wipes out its contribution. The collection fee matters only at the bottom: Billplz FPX takes **13.5% of a RM10 invoice** but only 3.4% of RM39.90. Annual billing fixes that.

### Email-only economics: the subscription has to carry the business

If venues choose email, which costs about RM0.0004 per message on Amazon SES (VERIFIED) ([AWS SES](https://aws.amazon.com/ses/pricing/)), MySenam earns nothing from messaging. The subscription alone must then cover support, hosting and collection.

| Model, email only | 1 court | 4 courts | 10 courts | 20 courts |
|---|---|---|---|---|
| A RM10 | +0.98 (10%) | −4.66 | −10.48 | −16.55 |
| B RM19.90 | +10.88 (55%) | +5.24 (26%) | −0.58 | −6.65 |
| C RM9.90 + RM3/court | +3.88 (30%) | +7.24 (33%) | +19.42 (49%) | +43.35 (62%) |
| D court tiers | +5.98 (40%) | +14.34 (49%) | +28.52 (58%) | +52.45 (66%) |

Only the court-scaled models (C and D) stay positive at every size without messaging revenue. The reason is that support cost grows with venue size and a flat fee does not.

### Lifetime, fixed costs and tax thresholds

The lifetime assumptions are 6.1% monthly churn (about 16.4-month expected life, REPORTED benchmark), one free month (VERIFIED default) and a 3-hour onboarding (ASSUMPTION, RM65). On those, lifetime contribution per venue in the base case is negative for A and B at every size: A runs from **−RM166 to −RM410** and B from **−RM14 to −RM258**. Model C is negative below 10 courts. Model F is positive at every size, from **RM14 for 1 court to RM1,125 for 20**. The fixed-cost test is harsher. Covering one junior developer plus one support executive (about RM8,047 a month loaded, REPORTED salaries) takes about **231 paying venues** under model F at RM0.08, or **141** under the recommended model at RM0.10. It takes **495** under model C with email only, and A and B never get there, using an ASSUMPTION mix of 20% 1-court, 30% 4-court, 35% 10-court and 15% 20-court venues. For scale, **Courtsite reports 389 centres after nine years** ([Courtsite about](https://www.courtsite.my/about)). Messaging resale also counts toward turnover (ASSUMPTION that it is part of the taxable IT service). So the RM500k SST registration threshold would arrive at roughly **290–540 venues**, far sooner than the roughly 2,780 venues a subscription-only calculation suggests. Corporate income tax (15% on the first RM150k of chargeable income, REPORTED) applies to profit, not contribution, so it is outside this model ([Aspire](https://aspireapp.com/blog/malaysia-corporate-tax-rate)). E-invoicing is not a cost driver for MySenam or for most venues while the reported exemption threshold stands at **RM3m turnover** ([The Star](https://thestar.com.my/news/nation/2026/08/30/over-11-million-businesses-to-benefit-from-higher-e-invoicing-threshold-says-lhdn)).

## Pricing decision: per-court base, WhatsApp metered from message one

The pricing to test in pilots is **RM9.90 a month plus RM3 per active court**. WhatsApp is **opt-in at RM0.10 per template from the first message**, with no bundled allowance. Email confirmations are free and are the default. A venue can cap its monthly WhatsApp spend. Annual prepay gets **two months free**, matching AFA's published "2 months waived" and Bukku's "save 2 months" ([AFA](https://www.afa.community/afa-for-business/); [Bukku](https://www.bukku.my/pricing)).

Under this structure, base-case contribution is **RM9.05 for 1 court, RM27.95 for 4, RM71.18 for 10 and RM146.87 for 20**, and it stays positive across the whole utilisation grid. The 1-court venue is the thin exception, falling to about **RM2.65** if hosting runs at 10-venue scale or chat replies are charged. Raising the per-message price from RM0.08 to RM0.10 matters because the worst-case unit cost is RM0.0609. That leaves **RM0.039 of margin (39%)** instead of RM0.019, and it is still below the reported RM0.12 reseller rate a venue would pay to run WhatsApp itself ([iWSApp](https://iwsapp.my/pricing.php)).

We rejected the RM10 and RM19.90 flat prices because the arithmetic does not work: they lose money at most sizes and never cover a team. We rejected the court-count tiers (model D) for now. They are stronger per venue, but their breakpoints are arbitrary until interviews reveal how venues think about size, and RM3 per court is simpler to explain. Tiers remain the fallback if per-court pricing causes "unused court" disputes.

The pricing still has unresolved problems.

**Busy large venues may face a WhatsApp bill bigger than a competitor's entire subscription.** A 20-court venue at 40% and 1.5 h generates about RM282 a month in WhatsApp at RM0.10. At 60% and 1 h, the total bill reaches about **RM704** against Courtsite Advanced at RM199 plus fees. WhatsApp has to stay opt-in and configurable per message type, the meter already built has to be visible, and big venues should be pushed toward email for regulars.

**The headline price is roughly 3% of CourtReserve's per-court price and a tenth of the local RM99 anchor.** Below US$50 a month, ChartMogul's data shows retention about 20 points worse than classic B2B SaaS ([ChartMogul](https://chartmogul.com/reports/saas-retention-the-ai-churn-wave/)). A low price may signal a hobby product to the very owners MySenam needs to trust it with their money. That is why the validation plan tests a **higher card, RM19.90 plus RM5 per court** (RM24.90 for 1 court, RM39.90 for 4, RM69.90 for 10, RM119.90 for 20), alongside the base card.

**Neither card supports a team at realistic early volume.** Covering RM8,047 a month with 50 venues needs about **RM161 of contribution per venue**. At RM9.90 plus RM3, MySenam is a founder-run business until it has well over a hundred paying venues.

## Manual badminton and futsal halls are the first segment to test

The ranking below combines market evidence with MySenam's actual product fit. Confidence is low throughout because **no operator has been interviewed**, and the national count of badminton and futsal venues is UNKNOWN.

| Rank | Segment | Why this rank | Acquisition channels | Willingness-to-pay hypothesis | Switching costs and onboarding obstacles |
|---|---|---|---|---|---|
| 1 | **Independent badminton and futsal halls not on any platform** | Largest base of court venues; football, futsal and badminton lead Malaysian participation (11.6%, 11.0%, 8.5%, REPORTED) ([UM eprints](https://eprints.um.edu.my/44967/)); no incumbent lock-in; recurring regulars match MySenam's weekly series and WhatsApp confirmations. Share still booking by hand: UNKNOWN | Walk-ins and calls to halls; coaches and academies running classes at halls; Chinese-language WhatsApp and Facebook groups (HYPOTHESIS, undocumented) | Low. Courts earn about RM15–30/hour in JB (REPORTED) ([TheSmartLocal](https://thesmartlocal.com/read/forum-tebrau-toppen-shopping-centre-jb/)). The reference point is "WhatsApp is free" and POS at about RM100/month (REPORTED). A 10-court hall at RM20/hour and 40% grosses about RM38k/month (ASSUMPTION), so RM40–180 is under 0.5% of revenue. Perceived value, not affordability, is the barrier | Moving fixed weekly regulars and phone lists; cash habit; older owners; **admin UI is English only** while Chinese-language support is likely needed (HYPOTHESIS; admin English-only VERIFIED in code); 2-hour group bookings fit the whole-hour limit |
| 2 | **Pickleball venues, especially pre-opening or outside the Klang Valley** | Fastest venue formation: KL went from 6 venues to "over 200", June 2024 to August 2025 (VERIFIED quote) ([The Star](https://www.thestar.com.my/metro/metro-news/2025/08/09/pickleball-craze-takes-over-malaysian-courts)); highest rates at RM29–80/hour (VERIFIED) ([Vulcan Post](https://vulcanpost.com/883329/pickleball-courts-online-booking-price-rental-malaysia-klang-valley-2025/)). But **20 of 26 sampled KL venues already use Courtsite or AFA** | Court builders and flooring suppliers during fit-out; state pickleball associations; Reclub organisers (HYPOTHESIS) | Higher. 6 courts at RM50/hour support RM100–300/month (HYPOTHESIS). They also want open play, ladders and DUPR, which MySenam lacks (no DUPR, VERIFIED) | Marketplace demand from Courtsite or AFA is a reason to stay; Courtsite listing requires its paid Console; pickleball-on-badminton conflicts favour multi-sport scheduling (REPORTED) ([FMT](https://www.freemalaysiatoday.com/category/leisure/2025/04/19/what-a-pickle-not-everyones-thrilled-with-the-rapid-rise-of-pickleball)). Padel venues are excluded: no padel and no 90-minute slots (VERIFIED code) |
| 3 | **Small multi-site operators (2–10 sites)** | Best fit for MySenam's built branch, shared-credit and staff-scoping features; higher value per account. Pool is small: Sports Planet 10+ futsal outlets (REPORTED), Hyprground with 3 sites and The Pickle Vibe with 2, both on Courtsite (VERIFIED) | Direct founder sales to named operators | Medium to high, but they expect POS, reporting export and deposits | Migrating several sites at once; existing Courtsite contracts (30-day notice, VERIFIED); no CSV export or audit log in MySenam (VERIFIED) |
| 4 | **Condominium facilities** | 26,334 strata schemes (REPORTED) ([Malay Mail](https://www.malaymail.com/news/malaysia/2025/04/08/housing-ministry-new-law-in-the-works-to-fix-poor-property-building-management-in-malaysia/172326)), but booking is one feature inside bundled community apps at RM500–900/month (VERIFIED) ([i-Neighbour](https://www.i-neighbour.com/pricing)) | 594 licensed managing agents (REPORTED) | Exists, but captured by bundled apps; residents usually book free, so payments add little | Committee decisions; visitor management and billing bundles that MySenam does not offer; 1–2 courts per site gives the weakest unit economics in our model |
| 5 | **Community centres and council halls** | DBKL (Tempah@KL, MyTempahan) and MBPJ (MyPJTempahan) run their own portals (VERIFIED/REPORTED) ([DBKL](https://www.dbkl.gov.my/en/fasiliti-awam/dewan-serbaguna)); Courtsite holds the PSM and BAM anchors | Tenders; NGO and residents' association networks for non-council halls | Very low, and tender-driven | Procurement cycles, Malay-language admin needs, in-house systems |
| 6 | **Gyms and fitness studios** | About 4,903 gyms (REPORTED) ([Ezypay](https://www.ezypay.com/blog/malaysia-a-connected-wellness-driven-market-in-southeast-asia)), but the core workflow is recurring membership billing, which **MySenam does not have** (VERIFIED: no auto-renew or subscription code) | n/a in 12 months | Glofox from US$99 (VERIFIED headline) and Rezerv from RM120 (REPORTED) set the bar | Franchisor systems (Anytime Fitness 100+ clubs); recurring billing gap |

Our ranking differs from the segment research, which put pickleball first. MySenam has no player demand to offer. In the Klang Valley, pickleball venues mostly buy demand from Courtsite and AFA, and Courtsite's terms make it costly to run a second system alongside. A hall that still runs on WhatsApp and a whiteboard has no incumbent to leave, and it is the one most likely to value MySenam's operations tooling over discovery. The case for pickleball is real too: higher revenue per court, digital-native owners and new fit-outs with no system in place. The validation plan therefore interviews both segments and lets commitment rates, not this table, settle the order.

## Most MySenam features are table stakes; trust gaps block payment

| MySenam feature (as built) | Competitor evidence | Verdict |
|---|---|---|
| WhatsApp transactional confirmations with a venue meter and allowance | Courtsite documents email only; AFA push and RSVP reminders; CourtReserve SMS. No competitor publishes WhatsApp pricing | **Potentially differentiated**, but unverified until competitors are trialled, and the margin is fragile (see Meta risk) |
| Click-to-chat free confirmations | No competitor evidence found | **Differentiated for the venue's bill**, negative for MySenam's margin in the worst case |
| Booking money to the venue's own Billplz; published, commission-free pricing | Courtease: direct via ToyyibPay, RM0 commission; Courtsite and AFA collect and net off undisclosed fees | **Partly differentiated** against Courtsite and AFA; **matched** by Courtease |
| No account needed to book; booking code plus phone | Courtease the same; Courtsite requires an account | Common among small entrants |
| Booking grid, live availability, recurring series, promo codes, reports, staff roles, online payment | All offered by Courtsite, AFA and CourtReserve; AFA lists recurring bookings and deposits | **Table stakes** |
| Open games with split payments, tournaments, box leagues, classes, waitlists | Courtsite games and events; AFA social games and AFA Class; Playtomic matches and leagues; CourtReserve leagues | **Common**; unlikely to win a badminton hall |
| Multi-branch businesses with shared credit and passes | CourtReserve and Playtomic gate multi-location to top or custom tiers | **Useful for segment 3**; small pool |
| Women-only and men-only sessions | No competitor evidence found | Differentiated but **unlikely to drive purchase** for most venues; untested |
| Storefront domains, occupancy heatmap, PDPA export and erase | CourtReserve branded domains at its top tier | **Unlikely to influence purchase** at this price |
| EN/MS customer UI | Courtsite has a language switcher | Table stakes; admin is English only and there is no Chinese |

The gaps that competitors cover and MySenam does not matter more than its extras. MySenam has **no reminders**, while Courtsite promises "payments, reminders, and cancellations handled for you" and AFA lists automated reminders ([Courtsite about](https://www.courtsite.my/about); [AFA for Business](https://www.afa.community/afa-for-business/)). It has **no deposits or required prepayment**: every booking "stands whether or not it is ever paid online", with no-shows capped only at three unpaid bookings per number per venue (VERIFIED) ([repo: src/lib/limits.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/limits.ts)). AFA lists a deposit feature. MySenam has **no IoT lighting**, which all three local competitors sell at RM199. It has **no receipts or invoices**: AFA lists invoices and receipts, Courtease claims tax-compliant invoicing, and Courtsite offers player e-invoices. It has **no padel and no 30- or 90-minute slots**, no per-venue peak hours, no POS, no CSV export and no native app. AFA has native apps; Courtsite is PWA-only like MySenam ([Courtsite help: general](https://www.courtsite.my/support/faq/general)). The biggest gap is the **demand side**: Courtsite's 807,360 users against MySenam's zero.

The audit's trust gaps would surface before any feature gap. On **security**, there is no password reset or change for anyone, so a forgotten owner password means a support emergency. There is no 2FA. Session tokens are stored in plain text. There are no CSP, HSTS or framing headers and no CSRF Origin check (it relies on SameSite=Lax). The default admin password `mysenam-admin` is published in the README and only triggers a warning at startup. There is no audit log, and in particular **nothing records which staff member marked a booking paid**, which creates a cash-handling fraud risk at the counter ([repo: src/lib/auth.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/auth.ts); [repo: next.config.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/next.config.ts); [repo: src/instrumentation-node.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/instrumentation-node.ts)). On **operational reliability**, the app, Postgres and backups share one Droplet with no replica. There is no uptime monitor, error tracking or paging. Backup failures reach only the server log and a red admin panel. Restoring is a manual job that has never been timed. Deploys restart the app ([repo: src/lib/scheduler.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/scheduler.ts); [repo: deploy/digitalocean/README.md](https://github.com/nasi-lemak/MySenam/blob/77f0401/deploy/digitalocean/README.md)). On **payment readiness**, Billplz is the only gateway. Each venue needs its own approved Billplz merchant account. There is no reconciliation poll for missed callbacks, no expiry on pending bills and no refund API (refunds are done by hand in Billplz). The counter-payment route has 15% test coverage, and the admin UI as a whole has 14% ([repo: src/lib/payments.ts](https://github.com/nasi-lemak/MySenam/blob/77f0401/src/lib/payments.ts); repo: `coverage/index.html` (a locally generated report, never committed)). MySenam does handle the regulatory side correctly. Because venues collect into their own gateway accounts, MySenam stays outside Bank Negara's merchant-acquiring test, which covers entities that "conduct or are responsible for fund settlement" and carries penalties of up to RM25M ([BNM MA FAQ](https://www.bnm.gov.my/documents/20124/57659/FAQ+for+Application+to+Provide+Merchant+Acquiring+Services.pdf)). That architecture should not change for the sake of a commission model.

## Launch positioning: an operations tool that publishes every ringgit

The positioning that the evidence can support is: **"Run your hall's bookings, regulars and payments from your phone. Your customers' money goes straight to your own account. Every ringgit we charge is on our price page."** It goes to independent halls that still book by WhatsApp. It is not a marketplace pitch, because MySenam has no players to bring, and saying otherwise would be the easiest claim for Courtsite's sales team to puncture. It contrasts honestly with Courtsite's and AFA's "transaction fee as agreed in writing" without inventing a number for those fees. It should not claim to be cheaper than Courtsite "all-in" for busy venues that turn WhatsApp on, because at high volume it is not. It should not claim WhatsApp is unique until trials of Courtsite, AFA and Courtease confirm they do not send WhatsApp confirmations. It should not mention tournaments, leagues or storefronts on the landing page, since nothing suggests they drive purchase. For SEA expansion, nothing in the notes supports a timeline. Each target market has local incumbents (ActiveSG and Reclub in Singapore, AYO in Indonesia, a crowded Philippine pickleball field) and different payment rails, and the product is MYR- and Billplz-only ([AYO](https://ayo.co/venues); [Pickle Time](https://www.pickletime.ph/)). Expansion should not appear in launch messaging.

## A 30-day validation plan with kill criteria

**No customer evidence exists yet.** No interview, demo, pilot, letter of intent or customer feedback has been collected. Nothing in this report should be read as operator opinion. The plan below is designed to produce that evidence, and it treats commitments (time, introductions, money) as the only signal, following the Mom Test principle that compliments are not commitments ([mtlynch summary](https://mtlynch.io/book-reports/the-mom-test/)). The thresholds are our judgement, not published benchmarks. No credible benchmark for LOI-to-paid conversion was found.

**Days 1–5: make the product safe to show and settle the Meta question.** Build password reset and change. Refuse the default admin password in production. Record the acting staff member on booking payment changes. Email owners when a backup fails. Add security headers. Set `MYSENAM_VENUE_FEE` and the WhatsApp price per the pricing decision. Get the five utility templates approved. Then confirm in WhatsApp Manager how service and in-window messages are billed on MySenam's own WhatsApp Business Account. *Pass:* all items shipped and the billing treatment documented with a screenshot. *Fail:* if Meta charges chat replies, change the meter to bill them before any pilot. In parallel, build a list of 60 target venues: 40 badminton and futsal halls with no visible Courtsite, AFA or Courtease listing, and 20 pickleball venues that are pre-opening or outside KL. Also trial-book at least two Courtsite, AFA and Courtease venues to check whether they send WhatsApp confirmations.

**Days 4–14: operator interviews.** Hold **25 conversations**: 15 badminton and futsal, 8 pickleball, 2 multi-site. Ask about past behaviour, not hypotheticals: how bookings arrived last week, how many no-shows there were, what software they pay for and how much, and who decides. Record booking-channel mix, weekly-regulars share, language preference and current software spend. *Success:* **at least 40% (10 of 25) agree to a concrete next step**, such as a demo set up with their own courts, an introduction to the owner, or a pilot. *Failure:* **fewer than 20% (5)** agree to a next step, or more than half of halls report they already use a platform they are satisfied with. If so, pause and re-segment rather than adjusting the pitch.

**Days 8–20: demos with real court data and the price experiment.** Run **at least 10 demos** on the venue's own courts and rates, loaded before the visit. Alternate two price cards. **Card 1** is RM9.90 plus RM3 per court; **card 2** is RM19.90 plus RM5 per court. Both have WhatsApp at RM0.10 per message, email free and annual prepay with two months free. Ask for the commitment at the end of each demo, not a rating. Use the Van Westendorp questions only after the commitment ask, and treat them as a range with fewer than 30 respondents ([Monetizely](https://www.getmonetizely.com/articles/how-to-implement-van-westendorp-price-sensitivity-meter-for-saas-research)). *Success:* **at least 5 of 10 demos convert to a pilot**, and card 2 converts at no less than **half the rate of card 1**. That would mean the higher price is viable and should become list. *Failure:* fewer than 3 pilots from 10 demos.

**Days 10–30: concierge pilots.** Run **5 pilots** with setup done by MySenam: courts, rates, a regulars import and recurring series. Each pilot venue agrees in writing to a stated list price after the trial. Track bookings entered per week, the share of the venue's total bookings that runs through MySenam, support minutes per venue, WhatsApp messages sent and incidents. *Success:* **at least 3 venues put 50% or more of their bookings through MySenam for two consecutive weeks**, support time averages **under 1.3 hours a venue a month after week one** (the 4-court break-even in our model), and **at least 2 venues pay at list price or prepay annually** by day 30. Discount-only conversions count as weak evidence. *Failure:* no venue sustains 50% usage for two weeks, or support time exceeds 3 hours a venue a month. If either happens, the product is too complex for its price.

**Days 6–30: landing-page test.** Build a single page with two headline variants. **(a)** "No commission. Your money, straight to your account." **(b)** "WhatsApp confirmations your regulars actually read." Each has a "Book a 15-minute setup" call to action. Drive about RM500 of targeted Facebook and Google traffic at Klang Valley and Johor venue owners, plus posts in operator groups. *Success:* **conversion of 3.8% or more** (Unbounce's median SaaS landing page, used only as a sanity check) ([Unbounce](https://unbounce.com/conversion-benchmark-report/saas-conversion-rate/)) and **at least 5 qualified demo requests** from real venue owners. *Failure:* under 1.5% with no qualified requests. Treat a landing-page click as weaker evidence than any interview commitment.

**Day 30 decision.** **Continue** if at least two of these four hold: the interview next-step rate is 40% or more, 3 or more pilots are active, 2 or more venues are paying, and card 2 is viable. **Pivot the segment** if interviews pass but pilots fail. **Stop or reconsider the business model** if both the interview and pilot criteria fail.

## Red team: why MySenam could fail

**There is no demand side.** Courtsite brings venues 807,360 users and federation credibility through PSM and BAM. MySenam brings none. If venue owners buy booking software mainly to get bookings rather than to manage them, MySenam's whole proposition collapses into "a cheaper scheduler". A free or near-free status quo already competes for that position: WhatsApp, Vyrox's RM0 tier and Courtease's six free months in Perak ([Vyrox](https://www.vyrox.com/sport-club-management-software-system.php)).

**The unit economics only work at a scale the market may not hold.** Covering even a two-person team takes 141 to 495 paying venues depending on the model, against Courtsite's 389 centres after nine years. The national count of badminton and futsal halls is UNKNOWN, so the addressable pool may be too small at RM30–150 a venue.

**Messaging margin is rented from Meta.** Most of the positive contribution in the recommended model comes from reselling WhatsApp at RM0.10 against a RM0.0609 worst-case cost. Meta sets the price, the categories and the free-window rules, and it reportedly changed them on 1 October 2026. A further move, or being pushed onto a BSP, turns every model negative (−RM44 to −RM98 at 10 courts).

**Low price invites high churn.** Reported monthly logo churn of about 6% at this price band means losing roughly half the base every year. One free month plus a 3-hour onboarding means a venue that churns within three months never pays back.

**Trust gaps meet money.** The first time an owner forgets a password, a cashier toggles a payment with no record, or the single Droplet dies with no alert, the venue will reasonably conclude the product is not production software. The admin UI, which staff use all day, has 14% test coverage, and no real venue has used it.

**Breadth is a support liability.** 118 routes and features such as tournaments, leagues, storefronts and door codes give a solo operator a large support surface at RM30 a month. The code was written entirely by an AI in five weeks. Whoever runs MySenam must be able to support it without a team that understands it from the inside.

**Incumbents can copy the differentiator quickly.** WhatsApp confirmations and published pricing are weeks of work for Courtsite or AFA, which already run WhatsApp support lines. Courtease already owns "RM 0 commission". MySenam has no lasting advantage beyond execution and price.

**Operators may simply refuse unpaid holds.** Bookings stand unpaid, and there are no deposits or reminders. A hall burned by no-shows may see MySenam as a step backwards from Courtsite's prepaid, non-refundable model ([Courtsite help: booking](https://www.courtsite.my/support/faq/booking)).

## Conclusion

MySenam is a pricing and distribution problem, not a feature-building problem. The model shows that the cheapest prices on the table are the most dangerous, because they bundle the one cost that grows with success: messages. They leave too little room to pay for the support each venue needs. The surprising result is that MySenam's most distinctive engineering choice, free WhatsApp replies, protects the venue's bill but erodes MySenam's own margin. Under Meta's possible new rules, it becomes a direct loss unless the meter starts billing those replies. A second result is that the realistic break-even (more than a hundred paying venues just to fund two people) puts MySenam in Courtsite's weight class on venue count while offering none of Courtsite's demand. Success therefore depends on finding venues that want an operations tool and not a marketplace.

The next 30 days should answer one question with commitments rather than opinions: will independent halls running on WhatsApp pay a published, court-scaled fee for a tool that keeps their money in their own account? If at least two venues pay at list price and three run half their bookings through it, MySenam has a foothold worth hardening. If not, the honest conclusion is that a well-tested codebase has not found a buyer, and no further features will change that.
