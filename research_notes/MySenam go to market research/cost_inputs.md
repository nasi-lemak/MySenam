# MySenam cost and tax inputs for unit economics (Malaysia, retrieved 2026-10-18)

Every URL below was retrieved on **2026-10-18**. Labels:
- **VERIFIED**: read on the official or primary page (the provider's own pricing page, a regulator, or the central bank).
- **REPORTED**: from a third party (law or accounting firm, BSP or reseller blog, aggregator, job board), or from an official page seen only as a search snippet.
- **ASSUMPTION/UNKNOWN**: a modelling assumption, or something no source could confirm.

FX used throughout: **USD 1 = RM 4.0837** (BNM KL USD/MYR reference rate, 16 Oct 2026).

## Master input table (for the contribution-margin model)

### Takeaway
At RM10–RM20 per venue per month, three costs can swamp revenue: per-booking WhatsApp or SMS messages, the gateway fee on collecting a small subscription, and fixed infrastructure while there are only a few venues. Email, tax and compliance are small or zero for a sub-threshold startup. Messaging must be metered or passed through to venues. It cannot be bundled without limit.

### Cited Findings

| # | Input | Value | Label | Source | Source date | Retrieved |
|---|---|---|---|---|---|---|
| 1 | FX USD/MYR | 4.0837 (16 Oct 2026); range 4.0819–4.0887 in Oct 2026 | VERIFIED | [BNM KL USD/MYR reference rate](https://www.bnm.gov.my/kuala-lumpur-usd/myr-reference-rate) | 16 Oct 2026 | 2026-10-18 |
| 2 | WhatsApp pricing model | Per delivered template message, effective 1 Jul 2025; only templates charged | VERIFIED | [Meta WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing) | Undated, live page (lists 2026 schedule) | 2026-10-18 |
| 3 | WhatsApp Malaysia marketing template | US$0.086 / RM0.3467 per message | REPORTED (official rate card not fetchable as text) | [Flowcall](https://www.flowcall.co/blog/whatsapp-business-api-pricing); [Seampify](https://www.seampify.com/whatsapp-api-price/); [search summary of Bixtech, WhAutomate](https://bixtech.co/blog/whatsapp-business-api-pricing-malaysia) | Flowcall 2 Oct 2026 (rates checked 28 Sep 2026); Seampify Sep 2026 | 2026-10-18 |
| 4 | WhatsApp Malaysia utility template | US$0.014 / RM0.0564 per message | REPORTED | Same as #3 | Same as #3 | 2026-10-18 |
| 5 | WhatsApp Malaysia authentication (domestic) | US$0.014 / RM0.0564 | REPORTED | Same as #3 | Same as #3 | 2026-10-18 |
| 6 | WhatsApp authentication-international (MY recipient, non-MY WABA) | ~US$0.0418 / RM0.1685 | REPORTED | [Flowcall](https://www.flowcall.co/blog/whatsapp-business-api-pricing); [Seampify](https://www.seampify.com/whatsapp-api-price/) | Oct/Sep 2026 | 2026-10-18 |
| 7 | WhatsApp service messages (customer-initiated, non-template) | Official page: free within the 24h window. Third parties: **from 1 Oct 2026, 1,000 free per phone number per month, then billed at the utility rate** | CONFLICT: VERIFIED page says free; REPORTED says charged | [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing) vs [YCloud (BSP)](https://www.ycloud.com/blog/whatsapp-api-message-pricing-update-effective-october-1-2026), [Flowcall](https://www.flowcall.co/blog/whatsapp-business-api-pricing) | Meta undated; YCloud 4 Sep 2026 | 2026-10-18 |
| 8 | Utility templates inside an open customer-service window | Official page: free. Third parties: chargeable from 1 Oct 2026 | CONFLICT (as #7) | Same as #7 | Same as #7 | 2026-10-18 |
| 9 | WhatsApp volume tiers | Utility and authentication only; aggregated per business portfolio per market/category; reset monthly; set by Meta; free in-window messages don't count | VERIFIED (tier rates not obtained) | [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing) | Undated | 2026-10-18 |
| 10 | WhatsApp MYR billing | MYR became a billing currency on 1 Apr 2026 | VERIFIED | [Meta pricing updates](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing) | Undated | 2026-10-18 |
| 11 | BSP markup (reseller examples) | RM0.50 marketing / RM0.12 utility / RM0.10 authentication per message (vs Meta's RM0.35 / RM0.056) | REPORTED | [iWSApp pricing](https://iwsapp.my/pricing.php); [PBX.com.my](https://www.pbx.com.my/whatsapp.php) (via search) | Undated | 2026-10-18 |
| 12 | SMS, Twilio Malaysia | US$0.3389 per outbound segment (~RM1.38); another Twilio locale page shows US$0.2594; failed-message fee US$0.001 | VERIFIED page; which column the rate belongs to is unclear | [Twilio SMS pricing MY](https://www.twilio.com/en-us/sms/pricing/my) | Undated (©2026) | 2026-10-18 |
| 13 | SMS, Exabytes iSMS one-way | RM0.125 (1k credits) down to RM0.105 (100k credits); credits valid 1 yr; SST treatment not stated | VERIFIED | [Exabytes iSMS one-way](https://smsportal.exabytes.my/one-way-sms.php) | Undated (©2026) | 2026-10-18 |
| 14 | SMS, typical Malaysian bulk range | RM0.03–RM0.15 per SMS | REPORTED (undated vendor blog) | [MoceanAPI blog](https://smsblog.moceanapi.com/?p=785) | Undated | 2026-10-18 |
| 15 | SMS: Macro Kiosk, Isentric, SMS123, Onewaysms, Vonage | Not obtained | UNKNOWN | No public price found | n/a | 2026-10-18 |
| 16 | Email, Amazon SES | US$0.10 per 1,000 emails (à la carte); US$0.12/GB attachments; dedicated IP US$24.95/mo | VERIFIED | [AWS SES pricing](https://aws.amazon.com/ses/pricing/) | Undated | 2026-10-18 |
| 17 | Email, Brevo free plan | 300 emails/day | REPORTED (official page didn't render) | [ecommerce-platforms.com](https://ecommerce-platforms.com/email-marketing-services-reviews/sendinblue-pricing); [dreamlit.ai](https://dreamlit.ai/blog/brevo-review) | 2026 | 2026-10-18 |
| 18 | Email, Zoho ZeptoMail | US$2.50 per 10,000 emails (credits expire after 6 months); first credit reportedly free | REPORTED | [SoftwareAdvice listing](https://www.softwareadvice.com.au/software/401947/zoho-zeptomail) | Undated | 2026-10-18 |
| 19 | Billplz FPX B2C | RM1.25 (Basic) / RM0.75 (Standard) per transaction; next business day | VERIFIED | [Billplz pricing](https://main.billplz.com/pricing) | Undated | 2026-10-18 |
| 20 | Billplz cards (MYR) | 1.8% / 1.5%; T+2 business days. Non-MYR 3.8% / 3.5% | VERIFIED | Same | Undated | 2026-10-18 |
| 21 | Billplz e-wallets (DuitNow QR, TNG, Boost, GrabPay) | 1.5%; next day (separate application) | VERIFIED | Same | Undated | 2026-10-18 |
| 22 | Billplz recurring card (Auto-Deduct) | 2.3% + RM1.25 / 2% + RM0.75; T+2 | VERIFIED | Same | Undated | 2026-10-18 |
| 23 | Billplz membership | Basic free. RM999/yr probably Standard (layout ambiguous) | VERIFIED (column ambiguous) | Same | Undated | 2026-10-18 |
| 24 | ToyyibPay FPX B2C | RM1.00 (Standard); settles in 1–4 business days. Santai plan (non-profits only) RM0 | VERIFIED | [ToyyibPay pricing](https://www.toyyibpay.com/pricing-plans/) | Undated | 2026-10-18 |
| 25 | ToyyibPay cards | Local 1.5%, foreign 3.5%; RM100 onboarding + RM100/yr; settles in about 4 business days | VERIFIED | Same | Undated | 2026-10-18 |
| 26 | ToyyibPay DuitNow QR | "1.00% or RM1.00 per transaction"; settles in 2 business days | VERIFIED (wording ambiguous) | Same | Undated | 2026-10-18 |
| 27 | Stripe MY cards | 3% + RM1.00 domestic; +1% international; +2% FX conversion | VERIFIED | [Stripe MY pricing](https://stripe.com/en-my/pricing) | Undated | 2026-10-18 |
| 28 | Stripe MY FPX / bank methods | 3% + RM1.00 | VERIFIED | Same | Undated | 2026-10-18 |
| 29 | Stripe MY GrabPay / Alipay | 3% (wallets generally 2.9% + RM1.00) | VERIFIED | Same | Undated | 2026-10-18 |
| 30 | Stripe disputes / payouts | RM90 per dispute; standard payouts free; instant payouts 1% (min RM2); no setup or monthly fee; settlement time not stated | VERIFIED | Same | Undated | 2026-10-18 |
| 31 | HitPay MY | FPX 1.8% + RM0.40 (T+1); domestic cards 1.2% + RM1; international 3% + RM1 (+2% FX); DuitNow QR 1.2%; GrabPay 2%; TNG 1.9%; ShopeePay 2.2%; no monthly fee; custom pricing above RM50k/month | VERIFIED | [HitPay MY pricing](https://www.hitpayapp.com/my/pricing) | Undated | 2026-10-18 |
| 32 | Razorpay Curlec | FPX 1.5% / 1.0% (min RM1); domestic cards 2.4% / 2.0%; foreign 3.3% / 3.1%; DuitNow Pay 1.2% / 1.0% (min RM0.30); TNG/Boost 1.5% / 1.3%; GrabPay 1.5%; Basic setup RM0 (FAQ says RM99), Premium RM999; page footnote says "18% GST" (looks like an India template error) | VERIFIED (columns assumed Basic/Premium) | [Curlec pricing](https://curlec.com/pricing/) | Undated | 2026-10-18 |
| 33 | senangPay | FPX max(RM1, 1.5%); local cards max(RM0.65, 2.5%); e-wallets max(RM0.65, 1.5%); annual package fee not confirmed | REPORTED (official page seen as a search snippet) | [senangPay fees](https://senangpay.com/fee-costing-features/) | Undated | 2026-10-18 |
| 34 | Fiuu (ex-Razer Merchant Services) | Premium: RM400 setup + RM499/yr (+SST); cards 2.4%; FPX 2.4% or RM0.60 (higher); Lite: RM499 setup, RM99/yr, FPX + BNPL only; weekly settlement in one source | REPORTED | [Airwallex Fiuu review](https://www.airwallex.com/my/blog/fiuu-review) | 2026 (approx.) | 2026-10-18 |
| 35 | iPay88 | SME RM488 setup; ~2.9% commission (older reseller page: RM500/yr, cards 2.7%, FPX 2.7% min RM0.60) | REPORTED (dated) | [DHL MY comparison](https://www.dhl.com/discover/en-my/e-commerce-advice/e-commerce-best-practice/online-payment-gateway-comparison-malaysia) | Undated | 2026-10-18 |
| 36 | Service tax rate (most taxable services, incl. IT) | 8% since 1 Mar 2024 (some groups stay at 6%) | REPORTED (Big-4 alert; RMCD not fetched) | [Deloitte Budget 2024 alert](https://www2.deloitte.com/content/dam/Deloitte/my/Documents/tax/my-tax-indirect-alert-budget-2024-expansion-of-service-tax-scope-and-rate-appendix-34.pdf); [Grant Thornton MY](https://www.grantthornton.com.my/insights/articles-and-publications/sales-service-tax-sst-malaysia-overview/) | Oct 2023 / 24 Sep 2025 | 2026-10-18 |
| 37 | Service tax registration threshold (most services) | RM500,000 over 12 months; some services NIL, RM1m or RM1.5m | REPORTED | [Grant Thornton MY](https://www.grantthornton.com.my/insights/articles-and-publications/sales-service-tax-sst-malaysia-overview/) | 24 Sep 2025 | 2026-10-18 |
| 38 | RMCD IT Services Guide | Updated guide issued 26 Feb 2026 (covers software, cloud, B2B exemptions) | REPORTED (article blocked, 403) | [Wolters Kluwer](https://www.wolterskluwer.com/en-my/expert-insights/service-tax-on-it-services-in-malaysia) (search snippet) | 30 Jul 2026 | 2026-10-18 |
| 39 | Rental/leasing service tax (Group K) | From 1 Jul 2025 at 8%; threshold RM1m; 2nd-edition guide (14 May 2026) reportedly shows **6% from 1 Jan 2026** | REPORTED (unconfirmed with RMCD) | [L&Co](https://landco.my/information-sharing/2026-rental-leasing-services-guide-update/); [Wolters Kluwer SST expansion](https://www.wolterskluwer.com/en-my/expert-insights/service-tax-sst-expansion-in-malaysia) | 5 Jun 2026; 24 Jul 2025 | 2026-10-18 |
| 40 | e-Invoice exemption threshold | **RM3m** annual turnover (Guideline v4.8, 30 Aug 2026); before that RM1m (from 1 Jan 2026) and RM500k (June 2025) | REPORTED (cites official PDF, which wasn't fetched) | [Lookuptax](https://lookuptax.com/tax-changes/malaysia/einvoice-exemption-threshold-3m-2026); [Kaizen CPA](https://www.kaizencpa.com/download/my/Changes%20in%20E-Invoice%20Implementation%20Threshold%20Value%20in%20Malaysia.pdf); [Malay Mail](https://www.malaymail.com/news/malaysia/2025/06/06/irb-malaysia-exempts-businesses-below-rm500000-from-e-invoicing-delays-mandate-for-rm1-5m-group-to-2026/179391); official PDF named: [IRBM e-Invoice Guideline](https://www.hasil.gov.my/wp-content/uploads/IRBM-e-Invoice-Guideline.pdf) | 30 Aug 2026; 6 Jun 2025 | 2026-10-18 |
| 41 | SME corporate income tax | 15% on the first RM150k, 17% on the next RM450k, 24% above (YA 2026) | REPORTED | [Aspire](https://aspireapp.com/blog/malaysia-corporate-tax-rate); [KC Group](https://kcgroup.biz/corporate-tax-malaysia-2026/) | 2026 | 2026-10-18 |
| 42 | DigitalOcean Basic droplets | 1GB US$6 · 2GB US$12 · 2GB/2vCPU US$18 · 4GB US$24 · 8GB US$48 per month; includes 1–5 TB transfer | VERIFIED (no Singapore-specific price shown) | [DO droplet pricing](https://www.digitalocean.com/pricing/droplets) | Undated | 2026-10-18 |
| 43 | DO droplet backups | 20% of droplet price (weekly), 30% (daily) | VERIFIED | Same | Undated | 2026-10-18 |
| 44 | DO Managed PostgreSQL | 1GB US$15.15 · 2GB US$30.45 · 4GB US$60.90 per month; extra storage US$0.215/GiB | VERIFIED | [DO managed DB pricing](https://www.digitalocean.com/pricing/managed-databases) | Undated | 2026-10-18 |
| 45 | DO Spaces | US$5/mo for 250GB + 1TB outbound; overage US$0.02/GiB storage, US$0.01/GiB transfer | REPORTED (2017 launch article, 2021 DO community answer) | [DO community](https://digitalocean.com/community/questions/how-are-digitalocean-spaces-charged-when-i-overpass-250-gb-of-storage-or-1-tb-of-transfer); [TechCrunch](https://techcrunch.com/2017/09/20/digital-ocean-launches-spaces-its-object-storage-service) | 2021 / 2017 | 2026-10-18 |
| 46 | Customer service executive salary (KL) | ~RM2,500/month average; advertised RM1,800–4,200 | REPORTED | [AJobThing](https://www.ajobthing.com/resources/recruitment-tools/salary-comparison-tool/customer-service-executive-salary-in-kuala-lumpur) | Undated | 2026-10-18 |
| 47 | Junior software developer salary | RM3,000–5,500/month; JobStreet median for all software engineers RM5,000 (Aug 2026); KL junior ads RM3,800–5,700 | REPORTED | [Second Talent](https://www.secondtalent.com/developer-rate-card/malaysia/); [Indeed MY](https://malaysia.indeed.com/career/junior-python-developer/salaries) | Aug 2026 | 2026-10-18 |
| 48 | EPF employer | 13% (wage ≤RM5,000) / 12% (>RM5,000); foreign workers 2% from Oct 2025 | REPORTED | [AJobThing EPF guide](https://www.ajobthing.com/resources/blog/epf-socso-eis-contribution-2026-latest-rates-rules-employer-guide-malaysia); [KC Group](https://kcgroup.biz/epf-contribution-malaysia-2026-complete-guide/) | 2026 | 2026-10-18 |
| 49 | SOCSO employer | 1.75% (wage ceiling RM6,000 since Oct 2024) | REPORTED | Same, plus [Kakitangan](https://blog.kakitangan.com/statutory-compliance-faq-pcb-epf-socso-eis-for-malaysian-employers/) | 2026 | 2026-10-18 |
| 50 | EIS employer | 0.2% (ceiling RM6,000; one source says RM5,000) | REPORTED | [web.hr](https://web.hr/glossary/eis-contribution-malaysia) | 2026 | 2026-10-18 |
| 51 | PDPA (Amendment) 2024 | Processor security duties, higher fines (to RM1m) and cross-border changes from 1 Apr 2025; DPO appointment, breach notification and data portability from 1 Jun 2025 | REPORTED (law firms) | [Baker McKenzie](https://insightplus.bakermckenzie.com/bm/data-technology/malaysia-personal-data-protection-amendment-act-2024-to-come-into-force); [ASEAN Briefing](https://www.aseanbriefing.com/news/malaysia-tightens-data-protection-from-june-2025/) | 2025 | 2026-10-18 |
| 52 | Breach notification timing | Commissioner within 72h when "significant harm" is likely; affected individuals within 7 days after that | REPORTED | [Securiti](https://securiti.ai/malaysia-data-protection-guidelines-dpo-appointment-and-breach-notification); [Hogan Lovells](https://www.hlc.com/en/publications/malaysia-imposes-data-breach-reporting-what-your-business-needs-to-know) | Mar–Apr 2025 | 2026-10-18 |

### Inferences
- **Derived WhatsApp cost per booking (ASSUMPTION: 2 utility templates per booking, confirmation plus reminder, sent outside any open window):** 2 × RM0.0564 = **RM0.113 per booking**. The same flow by SMS at Exabytes rates costs RM0.21–0.25. By SES email it costs about RM0.0008.
- **Messaging cost by venue size (ASSUMPTION: 3 bookings per court per day, 30 days, so 90 bookings per court per month; 2 WhatsApp utility templates per booking):**

| Courts | Bookings/month | WhatsApp @ RM0.0564 x2 | SMS @ RM0.105 x2 | Email (SES) |
|---|---|---|---|---|
| 1 | 90 | RM10.15 | RM18.90 | ~RM0.07 |
| 4 | 360 | RM40.61 | RM75.60 | ~RM0.29 |
| 10 | 900 | RM101.52 | RM189.00 | ~RM0.74 |
| 20 | 1,800 | RM203.04 | RM378.00 | ~RM1.47 |

  Even a 1-court venue's WhatsApp reminders roughly equal the whole RM10–20 subscription. Messaging has to be capped as an allowance with overage billing (MySenam's task list already includes "WhatsApp allowance, overage billing"), sent by email by default, or reduced to one message per booking (which halves the figures). Bookings per court is the most sensitive assumption, so replace it with real venue data.
- **Gateway fee on a single monthly subscription payment (VERIFIED rates applied by me):**

| Gateway / method | RM10 | RM15 | RM20 |
|---|---|---|---|
| Billplz FPX Basic (RM1.25) | 12.5% | 8.3% | 6.3% |
| ToyyibPay FPX (RM1.00) | 10.0% | 6.7% | 5.0% |
| Curlec FPX Basic (1.5%, min RM1) | 10.0% | 6.7% | 5.0% |
| HitPay FPX (1.8% + RM0.40) | 5.8% | 4.5% | 3.8% |
| HitPay DuitNow QR (1.2%) | 1.2% | 1.2% | 1.2% |
| Stripe card or FPX (3% + RM1) | 13.0% | 9.7% | 8.0% |
| Billplz card MYR (1.8%) | 1.8% | 1.8% | 1.8% |

  Billing annually (e.g. RM180 per year) cuts fixed-fee FPX drag to under 1%. Percentage-only methods (DuitNow QR, one-off card) are cheapest for monthly billing. Recurring card auto-debit (Billplz 2.3% + RM1.25) is expensive at this ticket size.
- **Who bears fees:** official gateway pages show merchant-side pricing, so by default the merchant (the venue, or MySenam for its own subscription) absorbs them. No source said consumer surcharging is standard. Treat surcharging as UNKNOWN.
- **Infra scenarios (ASSUMPTION; VERIFIED DO list prices; FX 4.0837; excludes load balancer, monitoring, domains, and any 8% SToDS DO may add for MY customers):**

| Venues | Stack | USD/mo | RM/mo | RM per venue |
|---|---|---|---|---|
| 10 | 1× 2GB droplet (app + Postgres on one box) US$12 + weekly backups US$2.40 + Spaces US$5 | 19.40 | ~79 | ~7.92 |
| 100 | 1× 4GB droplet US$24 + backups US$4.80 + Managed PG 1GB US$15.15 + Spaces US$5 | 48.95 | ~200 | ~2.00 |
| 1,000 | 2× 8GB droplets US$96 + backups US$19.20 + Managed PG 4GB US$60.90 + Spaces US$5 | 181.10 | ~740 | ~0.74 |

  At 10 venues, infra alone uses 40–80% of RM10–20 revenue. It becomes immaterial at a few hundred venues.
- **Loaded labour cost per hour (ASSUMPTION: 176 paid hours per month, 75% productive; statutory rates applied as flat percentages, though the real schedules use wage bands):**
  - Support executive: RM2,500 + EPF RM325 + SOCSO ~RM43.75 + EIS RM5 = **~RM2,874/month**, so ~RM16.3 per paid hour or **~RM21.8 per productive hour**.
  - Junior developer (RM4,500 midpoint): RM4,500 + EPF RM585 + SOCSO ~RM78.75 + EIS RM9 = **~RM5,173/month**, so ~RM29.4 per paid hour or **~RM39.2 per productive hour**.
  - One support hour per venue per month (~RM22) exceeds the subscription. Onboarding and support must be self-serve or done by the founder.

### Gaps
- Meta's official MYR/USD rate card (CSV/PDF) couldn't be retrieved as text. Malaysia rates are REPORTED from several consistent third parties.
- Whether Meta charges service messages and in-window utility templates from 1 Oct 2026 is unresolved. See the WhatsApp section.
- Volume-tier breakpoints and discounts for Malaysia utility messages weren't obtained.
- No public 2026 per-SMS prices were found for Macro Kiosk, Isentric, SMS123, Onewaysms or Vonage.

## WhatsApp Business Platform pricing (Malaysia, 2026)

### Takeaway
Meta charges per delivered template message (since 1 Jul 2025). Third-party sources consistently put Malaysia at about US$0.086 (RM0.3467) for marketing and US$0.014 (RM0.0564) for utility and authentication. Whether customer-service replies and in-window utility templates stopped being free on 1 Oct 2026 is contested: BSPs say yes, while Meta's developer page (as fetched) still says they're free.

### Cited Findings
- "Effective July 1, 2025, Meta charges on a per-message basis"; only templates are charged, and only when delivered; rates vary by category, volume tier and recipient country code — [Meta WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- The official page states that service messages are free within an open customer service window and "Utility templates delivered within an open customer service window are free." It also gives a 72-hour free entry-point window for Click-to-WhatsApp ads and Page CTAs — [Meta WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing); same content on [Meta documentation mirror](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- Volume tiers apply to utility and authentication only. They aggregate across WABAs in a business portfolio per market and category, reset monthly, and from 1 Oct 2025 a `VOLUME_BASED_PRICING_TIER_UPDATE` webhook fires on tier changes — [Meta WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- Malaysia's authentication rate was lowered effective 1 Feb 2025. MYR became a billing currency on 1 Apr 2026. Rate cards in 16 currencies (including MYR) are effective 1 Jul 2026. No Malaysia-specific rate change is listed for 2026 — [Meta pricing updates](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing)
- Malaysia rates, effective 1 Oct 2026: marketing MYR0.3467 (US$0.086); utility, authentication and service MYR0.0564 (US$0.014); authentication-international MYR0.1685 (US$0.0418). "Rates checked 28 September 2026" — [Flowcall](https://www.flowcall.co/blog/whatsapp-business-api-pricing) (updated 2 Oct 2026)
- The same MYR figures appear, rates "accurate as of September 2026" — [Seampify](https://www.seampify.com/whatsapp-api-price/)
- From 1 Oct 2026, service messages are billed per delivered message at the market's utility rate after 1,000 free per business phone number per month, with no rollover. Utility templates inside the 24h window also become billable. The article links a Google-Sheets copy of the Oct 2026 rate card, not a Meta notice — [YCloud (BSP)](https://www.ycloud.com/blog/whatsapp-api-message-pricing-update-effective-october-1-2026) (4 Sep 2026)
- Other outlets also report the Oct 2026 change, and say businesses without a payment method on file by 30 Sep would stop having service messages delivered — [Oman Observer](https://www.omanobserver.om/article/1197025/scitech/technology/met-to-charge-messages-on-whatsapp-business); [Zoho community](https://help.zoho.com/portal/en/community/topic/whatsapp-service-messages-pricing-update); [respond.io](https://respond.io/blog/whatsapp-pricing-change-2026.md)
- Malaysian resellers charge RM0.50 marketing, RM0.12 utility and RM0.10 authentication per message — [iWSApp](https://iwsapp.my/pricing.php); [PBX.com.my](https://www.pbx.com.my/whatsapp.php)

### Inferences
- Using Cloud API directly means paying Meta's rate card only, with no BSP markup. That's my inference from Meta billing per message to the WABA's payment method. Resellers add roughly 40–110% on utility messages (RM0.12 vs RM0.0564).
- Model the worst case (all booking messages charged at RM0.0564, including replies after the 1,000 free service messages per number) until Meta's live page or WhatsApp Manager confirms otherwise. One MySenam sender number shared by all venues would use up the 1,000 free service messages quickly.
- Meta may add SToDS/SST on invoices to Malaysian businesses. UNKNOWN; no source checked.

### Gaps
- Meta's official MYR/USD rate-card files couldn't be fetched as text, and the developer page didn't render the Oct 2026 service-message change. That could be page lag or a fetch limitation. Check in WhatsApp Manager.
- Malaysia utility volume-tier breakpoints weren't obtained.

## SMS pricing and rules in Malaysia

### Takeaway
Local bulk SMS costs about RM0.10–0.125 per message (Exabytes iSMS, VERIFIED). Twilio's international route is far dearer, at about US$0.26–0.34 (RM1.06–1.38). Malaysian A2P SMS conventionally starts with "RM0" and the brand name, URLs must be whitelisted (rules from 2024), and marketing SMS is limited to 8am–8pm. All of these rules come from provider guidance, not MCMC primary text.

### Cited Findings
- Exabytes iSMS one-way: RM0.125 (1,000 credits) to RM0.105 (100,000 credits); 300k+ is quoted on request; credits valid 1 year — [Exabytes iSMS](https://smsportal.exabytes.my/one-way-sms.php)
- An older Exabytes page lists RM0.115–0.100, last updated Sep 2022 — [Exabytes buy/reload](https://smsportal.exabytes.my/buy_reload.php) (via search)
- Twilio Malaysia: US$0.3389 per segment, "International Numbers" only; carrier fees may apply; contact sales for domestic or alphanumeric sender IDs; another locale page shows US$0.2594 — [Twilio](https://www.twilio.com/en-us/sms/pricing/my)
- Messages must start with "RM0" followed by the brand or company name — [Clickatell](https://clickatell.com/sms-country-regulations/malaysia); [Vonage](https://api.support.vonage.com/hc/en-us/articles/204017243-Malaysia-SMS-Features-and-Restrictions)
- "RM0.00" is added so recipients know the message is free. Operators may insert it if it's missing, reducing usable length. Messages without a brand may be billed at international rates — [8x8](https://support.cpaas.8x8.com/hc/en-us/articles/900003330986-MALAYSIA-SMS-Products-and-Compliance)
- Marketing traffic is allowed only 8am–8pm. From 1 Sep 2024, SMS containing URLs or phone numbers must be whitelisted — [Clickatell](https://clickatell.com/sms-country-regulations/malaysia); [Sent.dm](https://www.sent.dm/resources/my-sms-guidance)
- Typical range RM0.03–0.15 per SMS — [MoceanAPI](https://smsblog.moceanapi.com/?p=785) (undated vendor blog)

### Inferences
- SMS costs about 2× a WhatsApp utility template and adds compliance friction (prefix, URL whitelisting). Keep it as a fallback channel only.

### Gaps
- No 2026 public prices for Macro Kiosk, Isentric, SMS123, Onewaysms or Vonage.
- No MCMC primary document found for the RM0 prefix or URL whitelisting.
- Whether Exabytes prices include SST isn't stated.

## Email sending costs

### Takeaway
Transactional email is close to free: SES costs US$0.10 per 1,000 (about RM0.0004 per email), and the free tiers (Brevo 300/day, ZeptoMail's first 10k credit) cover early stages.

### Cited Findings
- SES outbound US$0.10 per 1,000 (à la carte); attachments US$0.12/GB; new AWS accounts get up to US$200 in Free Tier credits (6-month free plan); dedicated IP US$24.95/mo — [AWS SES pricing](https://aws.amazon.com/ses/pricing/)
- Brevo free plan: 300 emails/day — [ecommerce-platforms.com](https://ecommerce-platforms.com/email-marketing-services-reviews/sendinblue-pricing); [dreamlit.ai](https://dreamlit.ai/blog/brevo-review) (official [Brevo pricing](https://www.brevo.com/pricing/) didn't render)
- ZeptoMail: 1 credit = 10,000 emails at US$2.50, expires in 6 months, first credit reportedly free — [SoftwareAdvice](https://www.softwareadvice.com.au/software/401947/zoho-zeptomail)

### Inferences
- Email-first notifications with optional WhatsApp would keep variable messaging costs under RM2/month even for a 20-court venue (see the master table).

### Gaps
- Brevo's official free-plan terms weren't verified directly.

## Payment gateway fees in Malaysia

### Takeaway
For a RM10–20 subscription, fixed per-transaction FPX fees (RM0.75–RM1.25) cost 4–13% of revenue. Percentage-only methods (HitPay DuitNow QR 1.2%, Billplz cards 1.8%) or annual billing are much cheaper. Stripe (3% + RM1 on everything) is the most expensive for small tickets.

### Cited Findings
- Billplz: FPX B2C RM1.25 / RM0.75 (next business day); cards 1.8% / 1.5% (T+2); wallets 1.5% (next day); Auto-Deduct 2.3% + RM1.25 / 2% + RM0.75; DuitNow Transfer payment order RM1.25 / RM0.75 (real-time); membership Free / RM999 per year — [Billplz pricing](https://main.billplz.com/pricing)
- ToyyibPay: FPX B2C RM1.00, B2B RM2.00, settles in 1–4 business days; cards 1.5% local / 3.5% foreign plus RM100 onboarding and RM100/yr; DuitNow QR "1.00% or RM1.00" — [ToyyibPay pricing](https://www.toyyibpay.com/pricing-plans/). Daily automated settlement, next day — [ToyyibPay](https://toyyibpay.com/)
- Stripe MY: 3% + RM1.00 domestic cards; +1% international; +2% FX; FPX and bank methods 3% + RM1.00; GrabPay and Alipay 3%; disputes RM90; standard payouts free; no setup or monthly fee — [Stripe MY](https://stripe.com/en-my/pricing)
- HitPay MY: FPX 1.8% + RM0.40 (T+1); domestic cards 1.2% + RM1; international 3% + RM1 (+2% FX); DuitNow QR 1.2%; GrabPay 2%; TNG 1.9%; ShopeePay 2.2%; no setup or monthly fee — [HitPay MY](https://www.hitpayapp.com/my/pricing)
- Curlec: FPX 1.5% / 1.0% (min RM1); cards 2.4% / 2.0%; foreign 3.3% / 3.1%; DuitNow Pay 1.2% / 1.0% (min RM0.30); e-wallets 1.3–1.5%; setup RM0 (Basic) or RM999 (Premium) — [Curlec pricing](https://curlec.com/pricing/)
- senangPay: FPX max(RM1, 1.5%); local cards max(RM0.65, 2.5%); e-wallets max(RM0.65, 1.5%); annual subscription fee depends on package — [senangPay](https://senangpay.com/fee-costing-features/); [senangPay guide](https://guide.senangpay.com/what-are-the-charges-or-fees)
- Fiuu Premium: RM400 setup + RM499/yr (+SST); cards 2.4%; FPX 2.4% or RM0.60 (higher) — [Airwallex](https://www.airwallex.com/my/blog/fiuu-review)
- iPay88 SME: RM488 setup, ~2.9% commission — [DHL](https://www.dhl.com/discover/en-my/e-commerce-advice/e-commerce-best-practice/online-payment-gateway-comparison-malaysia). A negotiated contract filed with the SEC shows 1.5% cards and 1.5%/min RM0.60 FPX — [SEC exhibit](https://sec.gov/Archives/edgar/data/1905956/000157587222000291/cm045_ex10-11.htm)

### Inferences
- For venues' own court bookings (e.g. RM20–80 per hour), Billplz Basic FPX at RM1.25 is 1.6–6%. HitPay FPX would be RM0.76–1.84. The venue usually bears this.
- Settlement ranges: next business day for Billplz FPX, T+1 for HitPay FPX, 1–4 days for ToyyibPay, T+2 for Billplz cards, and weekly for Fiuu (REPORTED).

### Gaps
- Stripe MY's settlement time isn't stated on its pricing page.
- No source states the market norm for passing fees to customers.

## Taxes: SST, e-Invoicing, income tax

### Takeaway
MySenam's IT/SaaS service would be taxable at 8% only after crossing RM500k taxable turnover in 12 months. At RM15 per venue per month that takes about 2,780 paying venues, so a small SaaS doesn't register or charge SST. The e-Invoice exemption was reportedly raised to RM3m turnover (Guideline v4.8, 30 Aug 2026), which exempts MySenam and almost all venues. That makes e-invoicing a low-priority feature.

### Cited Findings
- The service tax rate rose from 6% to 8% from 1 Mar 2024, with some groups kept at 6% — [Deloitte](https://www2.deloitte.com/content/dam/Deloitte/my/Documents/tax/my-tax-indirect-alert-budget-2024-expansion-of-service-tax-scope-and-rate-appendix-34.pdf)
- "The service tax rates are 6% and 8%"; registration threshold RM500,000 over 12 months for most services (some NIL, RM1m or RM1.5m) — [Grant Thornton MY](https://www.grantthornton.com.my/insights/articles-and-publications/sales-service-tax-sst-malaysia-overview/) (24 Sep 2025)
- RMCD issued an updated Guide on Information Technology Services on 26 Feb 2026, covering software and system development, cloud, maintenance and B2B exemptions — [Wolters Kluwer](https://www.wolterskluwer.com/en-my/expert-insights/service-tax-on-it-services-in-malaysia) (30 Jul 2026, snippet only)
- Foreign digital-service providers (SToDS) must register above RM500k; the rate is 8% — [PayPro Global](https://payproglobal.com/saas-sales-tax/malaysia/); [Grant Thornton global](https://www.grantthornton.global/en/insights/indirect-tax-guide/indirect-tax---Malaysia/)
- Rental and leasing became taxable at 8% from 1 Jul 2025, with an RM1m threshold. Residential leases are excluded — [Wolters Kluwer](https://www.wolterskluwer.com/en-my/expert-insights/service-tax-sst-expansion-in-malaysia); [Mondaq](https://admin.mondaq.com/sales-taxes-vat-gst/1662338/expansion-of-sales-and-service-tax-sst-scope)
- The RMCD Rental & Leasing Guide 2nd ed. (14 May 2026) reportedly shows 8% for 1 Jul–31 Dec 2025 and 6% from 1 Jan 2026. The Group K threshold is RM1m. SME tenants may get an exemption via MyPMK — [L&Co](https://landco.my/information-sharing/2026-rental-leasing-services-guide-update/) (5 Jun 2026)
- In June 2025, LHDN exempted businesses under RM500k and moved the RM1–5m group to 1 Jan 2026 — [Malay Mail](https://www.malaymail.com/news/malaysia/2025/06/06/irb-malaysia-exempts-businesses-below-rm500000-from-e-invoicing-delays-mandate-for-rm1-5m-group-to-2026/179391)
- The exemption rose to RM1m from 1 Jan 2026 (announced 7 Dec 2025) — [e-invoice.app](https://www.e-invoice.app/blog/malaysia-myinvois-guide); [Chillhub](https://chillhub.com.my/?p=2669)
- The exemption rose to **RM3m** under IRBM e-Invoice Guideline v4.8 dated 30 Aug 2026, which replaces v4.7 of 7 Jul 2026. It doesn't apply if a corporate shareholder, holding or related company has turnover of RM3m or more. Businesses started in 2026 onward implement from 1 Jul 2026 or their start date, or from the second year after reaching RM3m — [Lookuptax](https://lookuptax.com/tax-changes/malaysia/einvoice-exemption-threshold-3m-2026); [Kaizen CPA](https://www.kaizencpa.com/download/my/Changes%20in%20E-Invoice%20Implementation%20Threshold%20Value%20in%20Malaysia.pdf). The official PDF cited is [IRBM e-Invoice Guideline](https://www.hasil.gov.my/wp-content/uploads/IRBM-e-Invoice-Guideline.pdf) (not fetched)
- SME income tax for YA 2026: 15% on the first RM150k, 17% on RM150,001–600k, 24% above — [Aspire](https://aspireapp.com/blog/malaysia-corporate-tax-rate); [KC Group](https://kcgroup.biz/corporate-tax-malaysia-2026/)

### Inferences
- RM500,000 ÷ (RM15 × 12) ≈ 2,778 venues (or 4,167 at RM10, 2,084 at RM20) before SST registration. Below that, price ex-SST and don't charge it.
- Foreign-supplier bills (DigitalOcean, AWS, Meta, Twilio) may carry 8% SToDS for Malaysian customers. Add 8% to those lines as a conservative ASSUMPTION.
- At an RM3m e-invoice threshold, almost no single-site sports venue needs MyInvois output from MySenam. Treat it as a later feature for chains and corporate-linked venues (the group rule).
- Whether venues' court-hire charges fall under Group K rental/leasing service tax is UNKNOWN. The guides cover property, space and equipment, not hourly sports-court hire. Even if they do, the RM1m threshold excludes most small venues.

### Gaps
- No RMCD (mysst.customs.gov.my) page was fetched. The 8% rate for IT services and the RM500k threshold are REPORTED by Big-4 and other firms.
- The reported change of rental/leasing to 6% from 1 Jan 2026 is unconfirmed.
- No HASiL page was fetched (e-invoice URLs returned 404). The RM3m threshold relies on secondary sources citing the guideline PDF.

## Hosting costs (DigitalOcean)

### Takeaway
DigitalOcean list prices are VERIFIED: droplets cost US$6–48 per month, Managed Postgres US$15.15–60.90, and backups 20–30% of the droplet price. Spaces' US$5 (250GB + 1TB) is REPORTED. Infra is about RM8 per venue at 10 venues, about RM2 at 100, and under RM1 at 1,000 (scenarios in the master table).

### Cited Findings
- Basic droplets: 1GB/1vCPU US$6 (1,000 GiB transfer); 2GB US$12 (2,000 GiB); 2GB/2vCPU US$18; 4GB/2vCPU US$24 (4,000 GiB); 8GB/4vCPU US$48 (5,000 GiB). Backups cost 20% (weekly) or 30% (daily). Singapore is listed as a region with no separate price — [DO droplets](https://www.digitalocean.com/pricing/droplets)
- Managed PostgreSQL: 1GB US$15.15, 2GB US$30.45, 4GB US$60.90 per month; storage US$0.215/GiB in 10 GiB steps — [DO managed DBs](https://www.digitalocean.com/pricing/managed-databases)
- Spaces: US$5 for 250GB plus 1TB outbound, shared across all Spaces; overage US$0.02/GiB stored and US$0.01/GiB transferred — [DO community](https://digitalocean.com/community/questions/how-are-digitalocean-spaces-charged-when-i-overpass-250-gb-of-storage-or-1-tb-of-transfer); [TechCrunch 2017](https://techcrunch.com/2017/09/20/digital-ocean-launches-spaces-its-object-storage-service)

### Inferences
- See the master-table infra scenarios. The 10-venue figure assumes app and Postgres on one droplet, matching MySenam's existing "DigitalOcean kit: app + Postgres on one droplet".

### Gaps
- Droplet bandwidth overage price, load-balancer price, Managed Postgres standby-node pricing and the current Spaces page weren't verified.

## Support and labour costs

### Takeaway
A KL support executive costs about RM2,900 per month fully loaded (about RM22 per productive hour). A junior developer costs about RM5,200 (about RM39 per productive hour). Salaries are REPORTED and statutory rates are REPORTED and consistent.

### Cited Findings
- Customer service executive in KL averages ~RM2,500 per month; offers range RM1,800–4,200 — [AJobThing](https://www.ajobthing.com/resources/recruitment-tools/salary-comparison-tool/customer-service-executive-salary-in-kuala-lumpur)
- JobStreet median for all software engineers is RM5,000 (Aug 2026), with P10 RM2,400 and P90 RM7,800; junior range RM3k–5.5k — [Second Talent](https://www.secondtalent.com/developer-rate-card/malaysia/). KL junior job ads show RM3,800–5,700 (JobStreet listings, via search)
- Hays Asia Salary Guide 2026 role tables require registration and weren't obtained — [Hays](https://web.hays.co.jp/salary-guide)
- EPF employer 13% (≤RM5,000) / 12% (>RM5,000); SOCSO employer 1.75% (ceiling RM6,000); EIS 0.2% (ceiling RM6,000, one source says RM5,000); a new employee-side SKBBK deduction from June 2026 is single-sourced — [AJobThing](https://www.ajobthing.com/resources/blog/epf-socso-eis-contribution-2026-latest-rates-rules-employer-guide-malaysia); [Kakitangan](https://blog.kakitangan.com/statutory-compliance-faq-pcb-epf-socso-eis-for-malaysian-employers/); [web.hr](https://web.hr/glossary/eis-contribution-malaysia); [aniday](https://aniday.com/de/malaysia/epf-socso-eis)

### Inferences
- See the loaded-cost calculation in the master table. At RM10–20 per venue, support time must stay under about 30–50 minutes per venue per month for a positive contribution, before messaging and gateway costs.

### Gaps
- No JobStreet or Hays figure for these exact titles. EPF, SOCSO and EIS weren't confirmed on kwsp.gov.my or perkeso.gov.my.

## PDPA 2010 (Amendment) 2024 obligations for a SaaS processor

### Takeaway
Since 1 Apr 2025, processors carry direct security obligations and face fines up to RM1m. Since 1 Jun 2025, controllers and processors must appoint a DPO, and controllers must notify breaches (Commissioner within 72h where significant harm is likely, individuals within 7 days) and honour data portability. The costs are mainly founder time, a breach-response runbook, and export tooling.

### Cited Findings
- 1 Apr 2025: direct processor obligations under the security principle, cross-border transfer changes, and higher penalties (max fine RM1m, up from RM300k; up to 3 years' imprisonment) — [Baker McKenzie](https://insightplus.bakermckenzie.com/bm/data-technology/malaysia-personal-data-protection-amendment-act-2024-to-come-into-force)
- 1 Jun 2025: controllers and processors must appoint at least one DPO, with 21 days to register them with the Commissioner. Breach notification and data portability (subject to technical feasibility) also start — [ASEAN Briefing](https://www.aseanbriefing.com/news/malaysia-tightens-data-protection-from-june-2025/); [HHQ](https://hhq.com.my/posts/full-implementation-of-the-personal-data-protection-amendment-act-2024-final-roundup/)
- Breach guideline issued 25 Feb 2025, effective 1 Jun 2025: notify the Commissioner within 72h of awareness where significant harm is likely (including breaches affecting more than 1,000 data subjects); notify individuals within 7 days; prescribed form on pdp.gov.my — [Securiti](https://securiti.ai/malaysia-data-protection-guidelines-dpo-appointment-and-breach-notification); [Hogan Lovells](https://www.hlc.com/en/publications/malaysia-imposes-data-breach-reporting-what-your-business-needs-to-know)
- One source says notification is due "as soon as practicable" rather than within 72h — [Legal500](https://legal500.com/developments/thought-leadership/countdown-to-compliance-personal-data-protection-amendment-act-2024-in-force-starting-1-january-2025)

### Inferences
- For MySenam, mostly a processor for venues' customer data, the costs are a DPO (the founder can fill this role if the guideline allows; that wasn't verified), a breach runbook, processor terms with venues, and a customer-data export. Model it as founder time plus perhaps RM0–3k a year in legal templates (ASSUMPTION, no source).

### Gaps
- The official pdp.gov.my guideline text wasn't fetched. Whether a small processor can appoint an internal or part-time DPO, and any DPO competency requirements, weren't confirmed.
