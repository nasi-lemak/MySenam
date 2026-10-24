# Go-to-market research, October 2026

Research carried out on **18 October 2026** into whether, how and to whom
MySenam could be sold in Malaysia: competitors, costs, pricing, segments, a
validation plan, and an audit of what the code did that day. It is a dated
record, not maintained. It explains why some capabilities may be valuable; it
does not say how MySenam behaves (that is the [features](../../features/)
documents) or what is built (that is [feature status](../../product/feature-status.md)).

## How to read it

Every factual claim carries a label, used the same way in each file:

- **VERIFIED**: read on the official or primary page (or in MySenam's own code)
  on the retrieval date.
- **REPORTED**: from a third party, a search summary, or an interested vendor;
  cited as given, not cross-checked.
- **ASSUMPTION**, **HYPOTHESIS** or **UNKNOWN**: a modelling input, the
  researcher's own inference, or nothing found.

Prices, counts and exchange rates are as retrieved on 18 October 2026 (FX
from Bank Negara Malaysia, 16 October 2026) and will have moved. No customer
was interviewed: there is no customer evidence in any of these files.

## The files

| File | What it holds |
| ---- | ------------- |
| [Report](report.md) | The synthesis: an executive recommendation, competitor comparison, unit economics, a pricing proposal, the first segment, positioning, a 30-day validation plan with kill criteria, and a red team |
| [Malaysian competitors](malaysian-competitors.md) | Courtsite, AFA Community, Courtease and others: products, prices, who holds the money, claimed scale |
| [Global competitors](global-competitors.md) | Nine international and South-East Asian platforms (CourtReserve, Playtomic, Reclub and others) as benchmarks |
| [Cost inputs](cost-inputs.md) | Messaging, gateway, hosting, tax and compliance costs for the unit-economics model |
| [Pricing and validation](pricing-and-validation.md) | How comparable SaaS prices in Malaysia and the region, validation methods, and failure modes |
| [Segments](segments.md) | Market-size indicators and buying behaviour by venue type |
| [Product audit](product-audit.md) | What the code at commit `77f0401` did, with evidence; superseded as a description of the product by feature status |

Code links in the report and the product audit point to commit `77f0401`, the
code the research read, so they show what was audited rather than today's
files.

## What became of the recommendations

The report made five recommendations. None was recorded as a product decision
at the time; this is where each stands, from the code and documents on
24 October 2026.

| Recommendation (report) | Where it stands | Evidence |
| ----------------------- | --------------- | -------- |
| Price by court count, with messaging billed separately | **Built as an option, values not adopted.** The owner can set tiers by number of courts; the suggested tiers are RM19.90, 39.90, 69.90 and 99.90, not the report's pilot card. WhatsApp is sold in prepaid packs (RM20 for 200, about RM0.10 a message), with urgent news included | [Business: pricing](../../business/pricing.md), [messaging](../../integrations/messaging.md#what-whatsapp-costs-and-who-pays) |
| Pilot prices of RM9.90 plus RM3 per active court, tested against RM19.90 plus RM5 | **Not adopted; no decision recorded.** `MYSENAM_VENUE_FEE` still defaults to 0 | [Business: pricing](../../business/pricing.md#open-decisions), [launch audit](../../audits/launch-2026-10-23.md) (decision 6) |
| Launch position: every ringgit published; booking money goes to the venue's own account | **The architecture supports it** (each venue's own gateway account); the positioning itself is a marketing choice not recorded anywhere | [ADR 0006](../../architecture/decisions/0006-per-venue-payment-accounts.md) |
| Pre-pilot fix list | **Done in code**: password reset and change, the default owner password refused in production, a staff activity log of who marked what paid, backup-failure alerts, security headers. **Left to the operator**: confirming Meta's billing, and setting a venue fee above zero | [Launch audit](../../audits/launch-2026-10-23.md), [deployment](../../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove) |
| A feature freeze until venues are found | **Not followed**: tournaments' competition framework, matchmaking, staging and other work were built after it ([roadmap: delivered](../../roadmap/roadmap.md#delivered)) | Git history |

The report's first segment (manual badminton and futsal halls), its 30-day
validation plan and its kill criteria have not been acted on in this
repository: the [launch audit](../../audits/launch-2026-10-23.md) of
23 October records zero venues and zero users. Whether to run that plan, and
at what price, is a business decision for the owner, not something these
documents settle.

## Adding research

New research goes in a dated folder or file under [`research/`](../), with its
retrieval date, its evidence labels and its sources kept. Research never
becomes a requirement by being written down: an accepted conclusion is
recorded where it applies (a [business](../../business/) or
[product](../../product/) document, a feature specification, or the
[roadmap](../../roadmap/roadmap.md)) with a link back to the research
([documentation](../../development/documentation.md)).
