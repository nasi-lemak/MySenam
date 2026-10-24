# International and SEA sports-facility booking / club-management platforms: benchmark for MySenam

> **Research record, 18 October 2026.** Moved from `research_notes/MySenam go to market research/global_competitors.md` on
> 24 October 2026; its findings, sources, labels and dates are unchanged. Not
> maintained: prices and figures are as retrieved then. What was adopted from
> this research, and what was not, is in the [overview](index.md).

Retrieval date for every URL below: **2026-10-18** (unless a page states its own "updated" date, which is quoted).
Labels: **VERIFIED** = read on the vendor's own page or help centre on 2026-10-18. **REPORTED** = third-party press, aggregator or competitor page, or a search-result snippet I could not open in full. **UNKNOWN** = not found; do not fill in.

**FX used for every MYR approximation:** Bank Negara Malaysia (BNM) 12:00 middle rate, dated 2026-10-16 (the last business day before retrieval), from the [BNM Open API](https://api.bnm.gov.my/public/exchange-rate?session=1200&quote=rm):
- USD 1 = RM 4.0835
- EUR 1 = RM 4.5888
- SGD 1 = RM 3.1874
- GBP 1 = RM 5.4321
- THB 100 = RM 12.2005
- IDR 100 = RM 0.0226
- AED 100 = RM 111.1883

All "≈RM" figures are approximations at these rates. They exclude tax, FX spread and card-scheme fees.

**Platforms chosen after a quick scan (9):**
1. CourtReserve (US; pickleball, tennis and padel club SaaS)
2. Playtomic / Playtomic Manager (Spain; padel-first marketplace plus SaaS, already live in KL)
3. Reclub (Vietnam/Singapore-origin social pickleball app with many Malaysian clubs)
4. Playbypoint (US pickleball and racquet SaaS)
5. Skedda (generic space booking with explicit APAC pricing)
6. Spond (free team and club app; fees only on payments)
7. ABC Glofox (gym and studio segment)
8. AYO Indonesia (SEA-regional marketplace plus venue app)
9. ActiveSG / MyActiveSG+ (Singapore public-sector booking; price-anchor benchmark)

Courtsite (Malaysia) is noted briefly for context only, since local competitors are presumably covered elsewhere.

**Not researched in this pass:** Matchi, ClubSpark/LTA, Teamup, EZFacility, Upper Hand, Picktime, SimplyBook.me, Bookee and Mindbody. I found no SEA-specific evidence for them in the time available. Treat their status as UNKNOWN, not as "absent from SEA".

---

## Q1. Pricing tiers: exact numbers, currency, basis (per court/location/member), setup fees

### Takeaway
Only CourtReserve, Playtomic (in its page data), Skedda, Spond (fees only) and Reclub (consumer subscription) publish usable numbers. CourtReserve is the clearest benchmark: US$199/159/369/329/549/499 per month, banded by court count (8/16/32 courts), with paid add-ons. Playtomic Manager's SaaS tiers are cheaper (about €59–€279/month in Spain), but Playtomic also earns booking commissions and player service fees.

### Cited Findings

**CourtReserve (VERIFIED, [courtreserve.com/pricing](https://courtreserve.com/pricing/))**

The page uses "$" without a currency code. USD is inferred because CourtReserve is US-based and the help centre quotes Stripe US rates. Prices are per club, banded by included courts; all tiers include "Unlimited Players & Members" and "Unlimited Staff, Instructors & Pros".

| Tier | Monthly | Billed annually (per month) | Courts included | ≈RM monthly / annual-per-month | ≈RM per court-month (monthly price) |
|---|---|---|---|---|---|
| Launch | $199 | $159 | 8 | RM 812.6 / RM 649.3 | ≈RM 101.6 |
| Advance ("Most popular") | $369 | $329 | 16 | RM 1,506.8 / RM 1,343.5 | ≈RM 94.2 |
| Momentum | $549 | $499 | 32 | RM 2,241.8 / RM 2,037.7 | ≈RM 70.1 |
| Custom | "Contact us for Custom pricing" (more courts, multiple locations, network memberships) | – | – | UNKNOWN | – |

What each tier adds:
- **Launch:** "Court booking and lessons, Events and programming, Membership management, Reporting suite, Public booking, Payments."
- **Advance:** adds "API access, Stringing module, Flex leagues, Select integrations included".
- **Momentum:** adds "Branded domains, Branded mobile app, All integrations included".

Add-ons:
- Each integration is **$25/month (≈RM 102)**: Access Control, DUPR, WPR (World Padel Rating), USTA Connect (WTN/NTRP), Swish, Video Recording, PourMyBev.
- Stringing Module is $25/month on Launch.
- Flex Leagues is **$99/month (≈RM 404)** on Launch.

Other terms:
- **Branded app:** "One-time $499 setup fee & 1-year contract" (≈RM 2,038).
- **Tax:** "Prices shown do not include sales tax."
- **Contract:** "Unless otherwise agreed, CourtReserve plans are subscription based."
- **Other setup or onboarding fee:** none stated beyond the app fee. "Seasonal Club? Contact Us for Seasonal Pricing."

**Playtomic Manager (VERIFIED with caveat, [playtomic.com/pricing](https://playtomic.com/pricing))**

The rendered page shows four tiers but no numbers in server-side HTML, because prices are geo-loaded. The page's embedded data (`pricing_plan_price`) carries `monthly_price` and `yearly_price` per `billing_region`. The currency per region is **inferred** from the region label; the page does not print the currency code. Whether a price is per club or per court is **UNKNOWN**; the page does not say "per court".

| Plan (tagline) | Stripe_ES (EUR inferred) monthly / yearly | Stripe_US (USD inferred) | Stripe_US_NON-US (USD inferred) | Stripe_AE (AED inferred) | Stripe_MX (MXN inferred) |
|---|---|---|---|---|---|
| Standard ("Entry-level plan for essential features") | 59 / 588 (≈RM 270.7/mo; ≈RM 2,698/yr) | 119 / 1,188 (≈RM 485.9/mo) | 59 / 588 (≈RM 240.9/mo) | 349 / 2,268 | 820 / 8,200 |
| Professional ("Advanced tools and performance") | 89 / 888 (≈RM 408.4/mo) | 179 / 1,788 (≈RM 730.9/mo) | 99 / 990 (≈RM 404.3/mo) | 396 / 3,564 | 1,616 / 16,159 |
| Champion ("Optimal plan for growing your club", "MOST POPULAR") | 139 / 1,428 (≈RM 637.8/mo) | 249 / 2,388 (≈RM 1,016.8/mo) | 149 / 1,490.04 (≈RM 608.4/mo) | 588 / 5,304 | 2,408 / 24,079 |
| Master ("Top-tier benefits and priority support") | 279 / 2,748 (≈RM 1,280.3/mo) | 349 / 3,588 (≈RM 1,425.1/mo) | 279 / 2,748 (≈RM 1,139.3/mo) | 1,188 / 10,692 | 5,004 / 48,219 |

Plan contents as listed on the page:
- **Standard:** "Blocking, Chats, Customers, Integrations, Matches, Payments, Public classes, Reports, Schedule, Tournaments, 48h response time".
- **Professional:** "Everything in standard, Court information display, User categories, Money wallet, 8h response time, POS system".
- **Champion:** "Everything in professional, Coaches, Courses, Customer memberships, Invoices, Leagues, Private classes, 4h response time, POS system, API integrations, Multiple legal entities, Campaigns".
- **Master:** "Everything in champion … Highest priority with tickets/chat".

Other pricing facts:
- The page claims "Join over 6,700 thriving clubs".
- No MYR or SEA billing region appears in the price data. Which region a Malaysian club would be billed under is **UNKNOWN**.
- A third-party listing of $38/$88/$132 per month ([SoftwareSuggest](https://www.softwaresuggest.com/playtomic-manager)) **conflicts** with Playtomic's own data and should be disregarded (REPORTED, likely outdated).

**Skedda (VERIFIED, [skedda.com/pricing](https://www.skedda.com/pricing))**

Priced per space and billed annually. The page shows "$" without a code.
- **EMEA & APAC:** Starter "starting at $99/mo" with 15 spaces (≈RM 404); Plus $149/mo with 20 spaces (≈RM 608); Premier $199/mo with 25 spaces (≈RM 813). Additional spaces cost "$4.99" each. The page layout made the exact space band per plan ambiguous.
- **US & Canada:** Plus $249/mo (35 spaces) and Premier $349/mo (45 spaces).
- **Contact sales:** Enterprise and "AllBooked". AllBooked is the tier that includes "embedded pricing and payments, membership management".
- **Add-ons:** "Administrators $99/mo add-on" and "Membership Subscriptions $99/mo add-on".

**Spond (VERIFIED for fees, [help.spond.com](https://help.spond.com/club/en/articles/58192-what-is-the-transaction-fee-in-spond-club))**

The fees article covers transaction fees only. It does not state a subscription price for Spond Club ("UNKNOWN" from the vendor). SportMember, a competitor, claims Spond has a free plan ([SportMember](https://www.sportmember.co.uk/en/clubmanagement/sportmember-vs-spond)); this is REPORTED.

**Reclub (VERIFIED, [pickleball.reclub.co/faq](https://pickleball.reclub.co/faq))**
- "Reclub is free to use."
- The optional "Reclub Supporter" subscription costs "$2-$3 USD" per month, or "$20-$30 USD/ year", which is about RM 8–12 per month or RM 82–123 per year. The FAQ says pricing "depends on the location and currency of your Mobile App Store".
- No club or venue SaaS fee is stated.

**ABC Glofox (VERIFIED headline only, [glofox.com/plans](https://www.glofox.com/plans/))**
- The plans page says "PLANS STARTING AT $99 PER MONTH" (≈RM 404). The tiers Essential, Boost, Elite and Enterprise all show "Request Pricing".
- Third-party estimates of $80–$110 (Standard), $190–$250 (mid) and over $600 (Enterprise) per month, plus mostly quarterly or annual billing, come from [vibefam](https://vibefam.com/glofox-pricing-2026/) and [costbench](https://costbench.com/software/gym-management/glofox/). These are REPORTED and not vendor-confirmed.

**Playbypoint:** the pricing page ([playbypoint.com/pricing](https://www.playbypoint.com/pricing)) returned a Cloudflare challenge (403), so tier prices are **UNKNOWN**.
- Capterra lists a starting price of "$99.99 Per Feature, Per Month" under the name "Playbycourt" ([Capterra](https://www.capterra.com/p/179783/PlayByCourt/)). This is REPORTED, and it may not be the same product or current.
- For comparison, a pickleball gear site reports that PodPlay charges "$30 to $350 per court" per month ([Pickleheads](https://www.pickleheads.com/pickleball-gear/best-pickleball-court-reservation-software)) (REPORTED).

**AYO Indonesia:** venue-side (AVM app) pricing is **UNKNOWN**; no public pricing was found.

**ActiveSG (Singapore, public sector):** this is not a SaaS vendor. As a consumer price anchor, ActiveSG sport-centre badminton courts are reported at S$3.50/hour (≈RM 11.16) before 6pm, per a rate comparison checked 24 Aug 2026 ([MissLobang](https://www.misslobang.com/article/best-badminton-courts-singapore-2026)) (REPORTED). Older guides cite S$4.60–S$14.60 depending on time and membership ([TheSmartLocal](https://thesmartlocal.com/read/badminton-court-singapore-booking/)) (REPORTED, possibly outdated).

**Courtsite (Malaysia, context only):** venue pricing is **UNKNOWN**; its business FAQ ([business.courtsite.my/support/faq](https://business.courtsite.my/support/faq)) shows no fee schedule.

### Inferences
- Per court, CourtReserve works out to about RM 70–102 per court per month at list price before add-ons. Playtomic's Spain-region SaaS price is roughly 1/3 of CourtReserve's entry tier, but Playtomic adds commission and player fees (see Q2 and Q4). A RM-priced Malaysian product well below RM 270 per venue per month would undercut both on headline subscription.
- CourtReserve monetises "feature unbundling": DUPR, access control and leagues are each priced separately. A competitor that bundles DUPR, open play and leagues into its base tier has a clear honest-comparison story.

### Gaps
- Playtomic: per-court vs per-club basis, the Malaysia/APAC billing region and onboarding fees are all UNKNOWN.
- Playbypoint, AYO (AVM) and Courtsite list prices are UNKNOWN.
- Glofox tier prices are not vendor-published.

---

## Q2. Payment processing: processor, fees, platform fee, who holds funds, payouts

### Takeaway
CourtReserve passes through Stripe's US rates (2.9% + $0.30). It dropped its own 0.2% usage fee for new Stripe integrations from 18 Feb 2025. Playtomic runs payments through Stripe Connect-style flows and takes a contract-defined percentage commission from clubs, plus a separate service fee from players. None of the international players shows FPX, DuitNow or MYR support.

### Cited Findings

**CourtReserve (VERIFIED, [help.courtreserve.com – integrated payment partners](https://help.courtreserve.com/en/articles/5772805-overview-of-integrated-payment-partners))**
- Stripe is its "preferred integrated payment partner". SafeSave is the alternative (US and Canada only).
- **Stripe rates:** credit cards 2.9% + $0.30; ACH 0.8%; Canadian pre-authorised debit 1.0% + $0.40.
- **SafeSave rates:** Visa/MC/Discover 2.89% + $0.30; Amex 3.39% + $0.30; eCheck 0.75% + $0.35; no setup or monthly fee.
- CourtReserve previously charged an additional 0.2% usage fee. New Stripe integrations on or after **18 Feb 2025** avoid it.
- **Payouts:** the article describes Stripe fees as deducted before payouts to the club's account (it mentions monthly payouts). Who holds funds is not stated explicitly; the club's own Stripe account is implied.
- MYR, FPX and DuitNow support: **UNKNOWN**, not mentioned.

**Playtomic (VERIFIED)**

From [OBM Guide](https://helpmanager.playtomic.com/hc/en-gb/articles/44898846238609-OBM-Guide-How-the-Old-Billing-Model-Works) (updated 2026-10-13):
- Under the "Old Billing Model", "Payouts are sent biweekly, on the 1st and 16th of each month."
- Playtomic issues a "B2C service fee invoice (to the player)" and a "B2B commission invoice (to your club)… biweekly".
- "The B2B commission is calculated as a percentage of the gross booking amount… The specific commission percentage is defined in your club's contract with Playtomic." The rate is not published (**UNKNOWN**).
- The article mentions "Stripe payout logic", and the PDF reports show "Gross Volume… Service Fee (%)… Net payout to the club". That implies Playtomic collects and then pays out net (inferred).
- The existence of a newer billing model is implied by the "Old" label. Its terms are **UNKNOWN**.

From [Club Initiated Transactions](https://helpmanager.playtomic.com/hc/en-gb/articles/40645779207569-Club-Initiated-Transactions-How-to-charge-your-players-stored-credit-cards) (updated 2026-09-08):
- Card-on-file charges are "securely stored and processed through Stripe". The feature is US only.
- "Clubs will be charged a percentage commission on each CIT transaction, similar to other online payments processed through Playtomic."

Other reports:
- Book & Go, a competitor, claims Playtomic takes "4% commission on every booking" ([bookandgo.app](https://www.bookandgo.app/de/playtomic-alternative)). This is REPORTED from an interested party and unverified.

**Spond (VERIFIED, [help.spond.com](https://help.spond.com/club/en/articles/58192-what-is-the-transaction-fee-in-spond-club))**
- Transaction fees, which include Stripe:
  - EUR 2.5% + €0.20
  - GBP 2.5% + £0.20
  - USD 3.29% + $1.00
  - AUD 2.5% + AU$0.30
  - CAD 3.29% + CA$1.00
  - CHF 2.5% + CHF 0.20
  - NOK 2.99% + 2 NOK
- Reduced EUR and CHF rates of 1.25% + 0.10 apply from 1–31 Oct 2026.
- "the transaction fee is covered by the club" by default.
- **No MYR, SGD or other SEA currency is listed.**

**Skedda:** "Accept online payments through Stripe Connect" ([pricing](https://www.skedda.com/pricing)). Fee level is **UNKNOWN**.

**Reclub:** "Reclub does not support payments yet, but it is in the roadmap" ([FAQ](https://pickleball.reclub.co/faq)) (VERIFIED as of the FAQ text retrieved 2026-10-18).

**ABC Glofox:** the plans page lists "Payment processing" in Essential, with rates **UNKNOWN**. A blog claims a "2.9% + $0.30 Glofox platform surcharge on top of Stripe" ([vibefam](https://vibefam.com/glofox-review-pricing-features-pros-cons-2026/)); this is REPORTED and unverified.

**AYO Indonesia:** the consumer app supports deposit or full payment via GoPay, Alfamart and virtual accounts ([App Store](https://apps.apple.com/app/id1539581877)) (REPORTED via the listing). Fees are **UNKNOWN**.

**Courtsite (Malaysia, context):** its blog announces a payments partnership with Curlec ([blog.courtsite.my](https://blog.courtsite.my/courtsite-and-curlec-unite-to-provide-uncompromised-payments/)) (REPORTED, page title only).

**AFA (Malaysian sports app):** reported to charge venue partners an MDR on transactions plus a subscription ([search snippet re App Store](https://apps.apple.com/us/app/id1526420132)). This is REPORTED and amounts are **UNKNOWN**.

### Inferences
- The international incumbents' payment stacks are Stripe-centric and US/EU-currency oriented. For a Malaysian venue, local rails such as FPX, DuitNow QR and e-wallets via a local PSP are a real differentiator. Note that Stripe itself does operate in Malaysia; whether CourtReserve or Playtomic enable MYR is UNKNOWN.
- Playtomic's "collect, then pay out net twice a month" model means venues wait up to about 2 weeks for cash. A model that pays venues directly or faster is a pitch point, but only if MySenam actually does so.

### Gaps
- Playtomic's commission %, its new billing model terms and Malaysian payment methods are UNKNOWN.
- Payment fees for Playbypoint, AYO and Glofox (official) are UNKNOWN.
- I found no evidence of FPX or DuitNow support at any international vendor.

---

## Q3. Messaging: SMS / WhatsApp / email / push allowances and charges

### Takeaway
CourtReserve is the only vendor with published messaging economics: 500 SMS per month included, then $5 per 500 (about RM 0.04 per SMS segment), 5,000 marketing emails per month included, and unlimited push. No international vendor found advertises WhatsApp messaging.

### Cited Findings

**CourtReserve (VERIFIED, [pricing footnotes](https://courtreserve.com/pricing/))**
- "Launch, Advanced, and Momentum plans include 500 SMS messages per month. All additional SMS notifications incur a $5 fee per 500 texts sent." That is about RM 20.42 per 500, or about RM 0.041 per SMS.
- "System notifications and automated emails are not billed. Bulk/manual marketing emails includes 5,000 emails sent per month, with a $5 charge for each additional 1,000."
- "Unlimited push notifications (both automated and bulk/manual)."

Help article [Using Text Alerts](https://help.courtreserve.com/en/articles/5964582-text-alerts) (dated June 1, 2026):
- "The first 500 are included, but any following would be an additional $5 per 500 texts. All text messages are priced in arrears."
- Messages over 160 characters are split into segments, and "Each segment is counted and billed as a separate message."
- Public Booking "security validation texts are not counted or charged", but confirmation texts count.
- There is a "Text Country Code" setting. Clubs get a local US-style number chosen from up to 10 options.
- Text alerts are not allowed in trial mode.

**Conflicting older source:** an older help-centre copy states "$15 / month (includes your first 500 messages), plus $5 / month for each 500" ([intercom.help](https://intercom.help/courtreserve/en/articles/5964582-text-alerts), via search snippet). The current pricing page and the June 2026 article supersede it.

**Playtomic:** plans list "Chats" (Standard) and "Campaigns" (Champion+) ([pricing](https://playtomic.com/pricing)). Players get "both an email and app notification" for CIT charges ([help](https://helpmanager.playtomic.com/hc/en-gb/articles/40645779207569-Club-Initiated-Transactions-How-to-charge-your-players-stored-credit-cards)). SMS and WhatsApp allowances and prices are **UNKNOWN**.

**Glofox:** "Targeted communications" is listed in Boost ([plans](https://www.glofox.com/plans/)). Allowances are **UNKNOWN**.

**Reclub:** the FAQ mentions an inbox "Club Support" channel. In-app chat details and SMS/WhatsApp are **UNKNOWN**.

**Skedda, Spond, Playbypoint and AYO:** messaging allowances and charges are **UNKNOWN**.

### Inferences
- In Malaysia, WhatsApp is the dominant customer channel. None of the incumbents found publicly prices WhatsApp, so MySenam's WhatsApp allowance is a differentiator to state with real numbers.
- WhatsApp utility/marketing template costs are higher per message than CourtReserve's US SMS rate of about RM 0.04. Benchmark against that carefully, and do not claim "cheaper messaging" without cost data.

### Gaps
- No public SMS or WhatsApp pricing was found for Playtomic, Playbypoint, Glofox, Skedda, Spond, Reclub or AYO.

---

## Q4. Business model and reported scale (especially Playtomic)

### Takeaway
Playtomic is a two-sided marketplace: SaaS fees plus a contract-defined booking commission from clubs plus a percentage service fee from players. It reports over 6,000 (pricing page: over 6,700) clubs, 4.7M+ players, 66 countries and €29M net revenue (YTD to 25 Sep 2025). CourtReserve, Skedda and Glofox are pure SaaS. Reclub is free and ad- or supporter-funded. Spond monetises payments.

### Cited Findings

**Playtomic player service fee** (VERIFIED, [player help "Service Fee"](https://playerhelp.playtomic.com/hc/en-gb/articles/19831779272337-Service-Fee), updated 2026-10-02)
- The fee applies to "every transaction processed online, with the exception of wallet transactions". It is not refunded if a reservation or tournament is cancelled. It is not applied to vouchers, club wallets or zero-price courts.
- The per-country fee tables are embedded as images. The SEA tables, read from the article's images:

| Country | Open Matches | Player Bookings | Classes / Courses / Leagues / Tournaments |
|---|---|---|---|
| Singapore | 4.0%, min SGD 0.59 (≈RM 1.88), no max | NO FEE | 4.0%, min SGD 0.49 (≈RM 1.56), max SGD 4.49 (≈RM 14.31) |
| Indonesia | 4.0%, min IDR 5,500 (≈RM 1.24), no max | NO FEE | 4.0%, min IDR 5,500, max IDR 37,900 (≈RM 8.57) |
| Thailand | 4.0%, min THB 11 (≈RM 1.34), no max | NO FEE | 4.0%, min THB 11, max THB 75 (≈RM 9.15) |

- **Malaysia is not in the article's country list.** The listed countries include Indonesia, Singapore and Thailand, but not Malaysia or the Philippines. Whether Malaysian players pay a service fee is **UNKNOWN**.
- An older Intercom help page cited "4% for tournaments and 20% for booking a match" ([intercom.help](https://intercom.help/getplaytomic/en/articles/5757197-service-fee), via search snippet). This is REPORTED, likely outdated, and conflicts with the current tables.

**Playtomic club commission:** a percentage of gross booking, set by contract ([OBM Guide](https://helpmanager.playtomic.com/hc/en-gb/articles/44898846238609-OBM-Guide-How-the-Old-Billing-Model-Works)) (VERIFIED). Dealroom describes the revenue as commission-based ([Dealroom](https://app.dealroom.co/companies/playtomic)) (REPORTED).

**Playtomic scale and funding**
- The Dec 16 2025 press release ([FITT Insider press release](https://insider.fitt.co/press-release/playtomic-raises-over-e5-1-million-thanks-to-the-support-of-its-community/)) reports (REPORTED, company-originated):
  - over €5.1M raised on Crowdcube from more than 4,600 investors;
  - "over €346 million in transactions (+51% YoY) and €29 million in net revenue (+38% YoY)" as of 25 Sep 2025;
  - more than 4.7M players, more than 6,000 partner clubs and 66 countries;
  - the claim that it "grows quickly and profitably" (no profit figure given);
  - valuation not disclosed.
- The pricing page says "Join over 6,700 thriving clubs" ([playtomic.com/pricing](https://playtomic.com/pricing)) (VERIFIED claim).
- **March 2025 round:** about €65M, comprising €55M equity and €10M Santander debt, led by Match Invest and Luxembourg Finance House, targeting the US, UK and Germany. Sources: [Techleap](https://finder.techleap.nl/news/feed/playtomic-raises-65m-for-us-expansion) and [SGI Europe](https://www.sgieurope.com/corporate/playtomic-raises-70m-in-funding-round/113807.article) (REPORTED). Some outlets say $70M ([The Padel Weekly](https://thepadelweekly.com/playtomic-secures-70-million-in-funding-to-accelerate-u-s-expansion/)).
- **Third-party estimates that conflict:** CB Insights lists 2025 revenue of $33.77M ([CB Insights](https://www.cbinsights.com/company/playtomic/financials)). Preqin cites 2023 revenue of about $145.8M and EBITDA of about -$2.45M ([Preqin](https://www.preqin.com/data/profile/asset/playtomic-s-l-/261425)), which looks internally inconsistent. Treat both as low-confidence.

**Other platforms**
- **CourtReserve:** a subscription SaaS. Revenue comes from subscriptions, paid add-ons, usage (SMS and email overage) and branded-app setup ([pricing](https://courtreserve.com/pricing/)) (VERIFIED). Scale and funding: **UNKNOWN**, not researched.
- **Reclub:** free app with an optional "Reclub Supporter" subscription, which removes the "top banner ad" ([FAQ](https://pickleball.reclub.co/faq)) (VERIFIED). The FAQ says it has "active communities in 35+ countries".
  - Dealroom lists it at seed stage with backing from 500 Global, HQ in Saigon, as a public benefit corporation founded 2017 ([Dealroom](https://app.beta.dealroom.co/companies/reclub)) (REPORTED, aggregator; the round size is paywalled and UNKNOWN).
  - The App Store seller name is "Reclub PBC" ([App Store MY](https://apps.apple.com/my/app/reclub-social-sports-nearby/id1323924315)) (VERIFIED).
- **Spond:** free app, monetised via payment transaction fees ([help.spond.com](https://help.spond.com/club/en/articles/58192-what-is-the-transaction-fee-in-spond-club)) (VERIFIED fees; free-plan claim REPORTED by [SportMember](https://www.sportmember.co.uk/en/clubmanagement/sportmember-vs-spond)).
- **Skedda and Glofox:** subscription SaaS ([Skedda](https://www.skedda.com/pricing), [Glofox](https://www.glofox.com/plans/)) (VERIFIED).
- **AYO Indonesia:**
  - Run by PT Ayo Indonesia Maju, Jakarta, founded 2016. A funding round was led by Alpha Momentum ([DailySocial](https://en.dailysocial.id/post/Come-on%2C-Indonesia-gets-a-new-funding-round-led-by-Alpha-Momentum)) (REPORTED; amount UNKNOWN).
  - Its Glints profile cites over 9,000 communities and 180,000 players ([Glints](https://glints.com/id/en/companies/pt-ayo-indonesia-maju/fcd2e7b5-96e6-44b7-b323-18a658899347)) (REPORTED).
  - Bookings launched in March 2022 with 8 venues in 5 provinces ([Bisnis.com](https://teknologi.bisnis.com/read/20220318/266/1512094/ayo-indonesia-bikin-fitur-booking-lapangan-di-jawa-dan-sumatra)) (REPORTED).
  - Model: consumer community app plus a separate venue-management app (AVM). Fees are UNKNOWN.
- **ActiveSG:** a government (SportSG) facility booking system with credits and a ballot ("Ballot to Play" beta) ([ActiveSG Circle](https://www.activesgcircle.gov.sg/facilities/sport-centres/ballot-to-play-beta-launch)) (REPORTED, page title only). It is not a commercial competitor, but it sets Singapore consumer price expectations.

### Inferences
- Playtomic's take, combining a club commission with a roughly 4% player fee on matches, classes and tournaments, means the marketplace effectively charges both sides. Booking-only flows in SG, ID and TH carry "NO FEE" to players, so Playtomic monetises open matches and activities on the player side.
- MySenam's open games model, where shares are paid to the venue, competes directly with Playtomic's highest-margin player-fee surface.
- Implied Playtomic net take rate is about €29M / €346M ≈ 8.4% of transaction volume. This is my calculation from the company's YTD figures, which mix SaaS and fee revenue, so treat it as rough.

### Gaps
- Playtomic SEA-specific venue counts and revenue are UNKNOWN.
- CourtReserve funding, customer count and revenue were not researched (UNKNOWN).
- Reclub round size is UNKNOWN.

---

## Q5. Feature sets

### Takeaway
CourtReserve is the most complete club-operations suite for tennis, pickleball and padel. It has DUPR, WPR and USTA integrations, leagues, ladders, POS, access control, a branded app and an API. Playtomic leads on player-side matchmaking, open matches and a consumer app, with POS from its Professional tier. Reclub is strongest on community open play and DUPR submission, but has no payments.

### Cited Findings

| Feature | CourtReserve | Playtomic Manager | Reclub | Skedda | Glofox |
|---|---|---|---|---|---|
| Court/space booking, public booking | Yes; "Includes Reserve with Google" ([pricing](https://courtreserve.com/pricing/)) | Yes, "Schedule" ([pricing](https://playtomic.com/pricing)) | Activities/sessions ([FAQ](https://pickleball.reclub.co/faq)) | Yes ([pricing](https://www.skedda.com/pricing)) | Class booking ([plans](https://www.glofox.com/plans/)) |
| Memberships / recurring billing | "Membership Management", "Batch Billing & Invoicing", "Packages" | "Customer memberships", "Invoices" (Champion+), "Money wallet" (Pro+) | UNKNOWN | "Membership Subscriptions $99/mo add-on" | "Member management" |
| Leagues / tournaments / ladders | "Flex Leagues" ($99 on Launch); "Leagues & Ladders" in nav | "Tournaments" (Standard), "Leagues" (Champion+) | Round Robin, Pool, Single Elimination | No | No |
| Open play / matchmaking | "Player Match-Maker" | "Matches" (Standard); open matches on app | Core use case (Discover, request to join) | No | No |
| Ratings / DUPR | DUPR $25/mo; WPR $25/mo; USTA WTN/NTRP $25/mo | UNKNOWN (own level system not verified here) | DUPR integration, hosts can "bulk submit matches"; leaderboards, "Street Cred" | No | No |
| Coaching / lessons | "Court booking and lessons", "Program & Clinic Management" | "Public classes" (Standard); "Coaches, Courses, Private classes" (Champion+) | UNKNOWN | No | Yes (classes) |
| POS | "Point of Sale (POS)" in all tiers | "POS system" (Professional+) | No | No | "Store / Retail Products" (Boost) |
| Access control | $25/mo integration ("Remote Access" in nav) | UNKNOWN | No | UNKNOWN | "Access Control & Check-in" (nav) |
| Lighting control | UNKNOWN | UNKNOWN | No | UNKNOWN | UNKNOWN |
| Kiosk | UNKNOWN | "Court information display" (Pro+) | No | UNKNOWN | UNKNOWN |
| Mobile app / white-label | Member app, co-branded; branded app on Momentum ($499 setup) | Playtomic consumer app (not white-label) | Consumer app | UNKNOWN | Member app; "Custom Branded Member App" add-on |
| API | Advance+ | "API integrations" (Champion+) | UNKNOWN | Zapier (extra fee) | UNKNOWN |
| Multi-location | Custom pricing | "Multiple legal entities" (Champion+) | n/a | Enterprise | "Multi-Location" (Elite bulk config) |
| Reports | "Reporting Suite", "Pulse Dashboard" | "Reports" | Supporter "stats analytics" | Insights dashboard | Reporting and analytics |
| E-waivers | "Electronic Waivers & Agreements" | UNKNOWN | No | UNKNOWN | "E-Agreements" (Boost) |
| Payments | Yes (Stripe/SafeSave) | Yes ("Payments", Stripe) | **No** ("does not support payments yet") | Stripe Connect | "Payment processing" |

Notes on other platforms:
- **Playbypoint:** feature detail is **UNKNOWN**, because the pricing page was blocked. Its App Store seller PBC LABS LLC also publishes a "The Picklr" app ([App Store US](https://apps.apple.com/us/app/the-picklr/id1663342732)) (VERIFIED listing), which suggests white-label apps for franchise clients (inference).
- **AYO AVM** handles booking schedules, court availability, transactions and staff access ([App Store](https://apps.apple.com/app/id1607354989)) (REPORTED via listing summary).
- **Courtsite (MY)** is reported to offer a facility suite automating "bookings, payments, check-ins, and even court light controls" (REPORTED, search snippet; source page not opened).

### Inferences
- Lighting control and kiosks are rarely advertised by the internationals found here. Courtsite reportedly offers light control locally, so this may be a table-stakes item in Malaysia.
- Playtomic gates POS, memberships and leagues behind higher tiers; CourtReserve gates the API, branded app and integrations. MySenam can benchmark tier-by-tier against those specific gates.

### Gaps
- Lighting control, kiosk and language support were not confirmed for any vendor.
- Playtomic's level or rating system and DUPR status were not verified.
- The Playbypoint feature list is UNKNOWN.

---

## Q6. Presence and availability in Malaysia / SEA (MYR, FPX/DuitNow, local language, local venues)

### Takeaway
Playtomic is the only international SaaS with verified Malaysian venues: several KL padel and pickleball clubs are listed. Reclub has substantial Malaysian pickleball community traction. CourtReserve, Skedda, Spond and Glofox show no Malaysian-specific payment or currency evidence. No vendor shows FPX or DuitNow.

### Cited Findings

**Playtomic in Malaysia**
- City Padel KL's Playtomic page data shows `"country":"Malaysia"`, `"timezone":"Asia/Kuala_Lumpur"`, `"sport_ids":["PADEL","PICKLEBALL"]` and `"communications_language":"en"`, and describes "three premium super-panoramic" courts ([playtomic.com/clubs/city-padel-kl](https://playtomic.com/clubs/city-padel-kl)) (VERIFIED).
- Other KL clubs on Playtomic include SkyCourts Padel & Pickle at Perdana KLCC ([link](https://playtomic.com/clubs/skycourts-padle-pickle)) and PadelDepot in Sentul West ([link](https://playtomic.com/clubs/padeldepot)). Base Pickle Padel Club is also listed ([link](https://playtomic.com/clubs/base-pickle-padel-club)). Jom Padel, Padel Bintang and The Rally Padel Club appear as "nearby clubs" (REPORTED via search summary).
- Whether online payment in MYR is enabled for Malaysian Playtomic clubs is **UNKNOWN**: the page's currency field was not found. Malaysia is absent from the player service-fee country list, which includes Singapore, Indonesia and Thailand ([Service Fee](https://playerhelp.playtomic.com/hc/en-gb/articles/19831779272337-Service-Fee)).
- iOS app "Playtomic - Play padel" on the Malaysian storefront: 4.86 stars from 148 ratings ([App Store MY](https://apps.apple.com/my/app/playtomic-play-padel/id1242321076)) (VERIFIED via iTunes Search API).

**Reclub in Malaysia** (VERIFIED club pages; counts are snapshots)
- 16S Club x Franklin Malaysia, Puchong: about 1,274 members ([link](https://reclub.co/id/clubs/@16s)).
- Pickle Addicts Club: 783 members ([link](https://reclub.co/id/clubs/@fridayafterdark)).
- Stadium Pickleball KWC, KL: 97 members ([link](https://reclub.co/clubs/@stadium-pickleball-kwc)).
- iOS app "Reclub - Social Sports Nearby" on the MY storefront: 4.82 stars from 4,519 ratings ([App Store MY](https://apps.apple.com/my/app/reclub-social-sports-nearby/id1323924315)) (VERIFIED). The rating count is storefront-specific.
- Club pages are served in Thai, Vietnamese and Indonesian locales (e.g. `/th/`, `/vi/`, `/id/` paths) ([example](https://reclub.co/th/clubs/@punggol-pickleball-club)) (VERIFIED). A Malay locale was not observed (UNKNOWN).
- Singapore traction: Punggol Pickleball Club shows about 1,500+ members ([link](https://reclub.co/clubs/@punggol-pickleball-club)) (VERIFIED snapshot).

**Other vendors**
- **CourtReserve:** the Stripe partner list includes US, Canada, UK, Australia, Germany and others; SafeSave covers the US and Canada only ([help](https://help.courtreserve.com/en/articles/5772805-overview-of-integrated-payment-partners)). Malaysian venues or MYR: **UNKNOWN**, none found. SMS uses local US-style numbers ([text alerts](https://help.courtreserve.com/en/articles/5964582-text-alerts)).
- **Spond:** fee schedule lists no SEA currency ([help](https://help.spond.com/club/en/articles/58192-what-is-the-transaction-fee-in-spond-club)) (VERIFIED). Spond did not surface in an iTunes search of the MY storefront; this is weak evidence and availability is UNKNOWN.
- **Skedda:** has an "EMEA & APAC" price list in "$" ([pricing](https://www.skedda.com/pricing)) (VERIFIED). Malaysian sports venues: UNKNOWN.
- **Playbypoint:** the MY storefront shows the app at 2.35 stars from 20 ratings ([App Store MY](https://apps.apple.com/my/app/playbypoint/id1555133217)) (VERIFIED). Malaysian venue usage: UNKNOWN.
- **AYO:** Indonesia only, with IDR payments via GoPay, Alfamart and virtual accounts ([App Store](https://apps.apple.com/app/id1539581877)) (REPORTED). Malaysia: none found.
- **ActiveSG:** Singapore public facilities only.
- **Courtsite (MY, context):** Shah Alam-based; described as covering 27 sports in one web app ([Business Today, Jan 2023](https://www.businesstoday.com.my/2023/01/10/courtsite-helps-malaysians-book-sports-facilities-for-27-sports-with-just-one-web-app/)) (REPORTED). The blog notes 8% SST applies if the centre is SST-registered (REPORTED via search snippet).
- **Rezerv (rezerv.co):** Malaysian fitness-studio booking software "starting at RM120 per month" ([lp.rezerv.co](https://lp.rezerv.co/rezerv-fitness-studio-management-software-my-ex)) (REPORTED via search snippet). It also publishes padel guides for Malaysia.

### Inferences
- Playtomic is the incumbent to beat for KL padel. Reclub owns the pickleball community and open-play layer but has no payments. That gives MySenam an opening: pair Reclub-style open play with venue payments over FPX and DuitNow, which no international vendor shows.
- Reclub's DUPR bulk-submission and free model set a "free for organisers" expectation among Malaysian pickleball groups.

### Gaps
- MYR, FPX and DuitNow support at Playtomic and CourtReserve is UNKNOWN.
- No vendor showed Bahasa Malaysia UI evidence.
- Philippines and Vietnam regional players were not researched.

---

## Q7. Target customers

### Takeaway
CourtReserve targets US-style racquet clubs (tennis, pickleball, padel). Playtomic targets padel-first commercial clubs and their players. Reclub targets social pickleball organisers and players. Glofox targets gyms and studios. Skedda targets generic space booking. Spond targets amateur teams and clubs. AYO targets Indonesian futsal, soccer, tennis and community sport.

### Cited Findings
- **CourtReserve:** footer "Solutions" lists Tennis, Pickleball and Padel, plus Club Owners, Directors, Front Desk, Instructors and Players. It offers seasonal-club pricing ([pricing](https://courtreserve.com/pricing/)) (VERIFIED).
- **Playtomic:** pricing page title is "Flexible plans for racket sports clubs". Nav covers padel, tennis and pickleball courts. Testimonials come from padel clubs in the US, UK and NL ([pricing](https://playtomic.com/pricing)) (VERIFIED).
- **Reclub:** "Structured Pickleball made easy", "powering the global pickleball community" ([pickleball.reclub.co](https://pickleball.reclub.co/)) (VERIFIED/REPORTED via snippet). App title "Social Sports Nearby" ([App Store](https://apps.apple.com/my/app/reclub-social-sports-nearby/id1323924315)).
- **Glofox:** business types are Gym, Pilates, Yoga, Cycling, Wellness, Fitness Studio, Boxing, PT Studio and Martial Arts ([plans](https://www.glofox.com/plans/)) (VERIFIED).
- **Skedda:** priced "per space" with floor plans and spaces; generic venue and space booking ([pricing](https://www.skedda.com/pricing)) (VERIFIED).
- **Spond:** clubs collecting "membership and training fees" ([help](https://help.spond.com/club/en/articles/58192-what-is-the-transaction-fee-in-spond-club)) (VERIFIED).
- **AYO:** "football, futsal, mini soccer, and tennis venues" ([App Store](https://apps.apple.com/app/id1539581877)) (REPORTED).
- **ActiveSG:** the public, booking badminton, pickleball and table tennis at government sport centres ([Little Day Out](https://www.littledayout.com/my-activesg-plus-membership-booking-platform/)) (REPORTED).

### Inferences
- None of the internationals is badminton- or futsal-first, which are mass-market sports in Malaysia. Courtsite (local) and AYO (Indonesia) are the closest analogues for that segment.

### Gaps
- Customer counts by segment for any vendor other than Playtomic are UNKNOWN.

---

## Q8. Public review evidence (G2, Capterra, app stores)

### Takeaway
CourtReserve rates well with operators (Capterra 4.7 from 53 reviews) but poorly with players on iOS (2.84 from 354 US ratings). Playtomic's player app is very highly rated (4.85 from 13,825 US ratings). Reclub's app is 4.82 from 4,519 ratings in Malaysia.

### Cited Findings

| Platform | Source | Rating (count) | Label |
|---|---|---|---|
| CourtReserve | [Capterra](https://www.capterra.com/p/152562/CourtReserve/reviews/) | 4.7/5 (53); 96% positive sentiment | REPORTED (via search summary) |
| CourtReserve | [G2](https://www.g2.com/products/courtreserve/reviews) | 4.5/5 (1 review, Mar 2026) | REPORTED (via search summary) |
| CourtReserve player app | [App Store US](https://apps.apple.com/us/app/courtreserve/id1392556575) | 2.84 (354) | VERIFIED (iTunes API) |
| Playtomic app | [App Store US](https://apps.apple.com/us/app/playtomic-padel-pickleball/id1242321076) | 4.85 (13,825) | VERIFIED (iTunes API) |
| Playtomic app | [App Store MY](https://apps.apple.com/my/app/playtomic-play-padel/id1242321076) | 4.86 (148) | VERIFIED (iTunes API) |
| Playtomic Manager | Capterra/G2 | No listing found | UNKNOWN |
| Reclub | [App Store MY](https://apps.apple.com/my/app/reclub-social-sports-nearby/id1323924315) | 4.82 (4,519) | VERIFIED (iTunes API) |
| Playbypoint | [App Store US](https://apps.apple.com/us/app/playbypoint/id1555133217) | 4.74 (4,279) | VERIFIED (iTunes API) |
| Playbypoint | [App Store MY](https://apps.apple.com/my/app/playbypoint/id1555133217) | 2.35 (20) | VERIFIED (iTunes API) |
| AYO (consumer) | [App Store MY](https://apps.apple.com/my/app/ayo-super-sport-community-app/id1539581877) | 5.0 (3) | VERIFIED (iTunes API) |
| AYO Venue Management | [App Store ID](https://apps.apple.com/id/app/avm-ayo-venue-management/id1607354989) | 4.52 (29) | VERIFIED (iTunes API) |

Google Play ratings for any of these: **UNKNOWN** (not collected).

### Inferences
- CourtReserve's weak player-app rating, set against strong operator reviews, suggests its player UX is a weak point. A Malaysian entrant can credibly compete on the player experience, but only with its own store ratings as proof.

### Gaps
- Capterra and G2 figures for CourtReserve come from search summaries; I did not open the pages directly.
- No Capterra or G2 data was found for Playtomic Manager, Reclub, Skedda (not searched), Spond (not searched) or Glofox (not searched).
- Google Play ratings were not collected.
