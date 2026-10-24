# Venue pricing and cost assumptions

What a marketplace venue pays, and the cost assumptions behind the suggested tiers. These are assumptions, not measurements. The market research behind them is the [go-to-market research](../research/go-to-market/index.md) of 18 October 2026.

## Plans by size

The owner can price venues by how many bookable resources they have —
courts, pitches, rooms — under *Venues & staff → Billing → Plans by size*
(`src/lib/plans.ts`). With no tiers set, every venue pays the flat
`MYSENAM_VENUE_FEE`, as before; a venue's own agreed fee beats both.

- **Every tier has every feature.** Recurring bookings, cancellations, rate
  schedules, customers and reports are what a booking system is for, so none
  is held back to make a venue upgrade. Only the count sets the price.
- **The count is taken when each month is invoiced**, and written on the
  invoice with the tier ("Growth · 8"), so a venue can see why it paid what it
  paid and a later change of tiers does not rewrite an invoice already issued.
  A court **out of service for the whole month** is not counted, so a hall
  is not charged for a court it closed for repairs. A business's branches are
  each priced by their own size, as lines on its one invoice.
- **The last tier can have a limit** with a fee for each resource past it, so
  a very large hall does not pay the same as a mid-sized one.
- Staff see their venue's tier, its count and the whole tier list under
  *Billing*; tiers take effect from the next invoice.

*Use suggested tiers* fills in a starting point, from the pricing analysis
below. They are a starting point to test with venues, not a finding.

| Tier | Courts or rooms | RM a month |
| ---- | --------------- | ---------- |
| Starter | 1–5 | 19.90 |
| Growth | 6–15 | 39.90 |
| Large | 16–30 | 69.90 |
| Arena | 31–50 | 99.90, then RM2 each |

What a venue costs to serve, a month, at 40% utilisation and 1.5-hour
bookings: about **RM3.35 fixed** (hosting at ~100 venues, RM2.00; collecting
the invoice by FPX, RM1.35) plus about **RM1.07 per court**. Of that, the
SMS phone codes cost RM0.69 (8% of bookings by a first-time customer, half
of whom pick SMS at about RM0.135), urgent WhatsApp news RM0.23 (3% of
bookings cancelled or moved by the venue) and email RM0.15. Checking a number
on WhatsApp costs nothing: the customer sends the message, and nothing is
sent back. So a 10-court hall costs about RM14 a month and a 30-court one
about RM36. Those are assumptions, labelled as such, not measurements.

| Courts | 1 | 5 | 10 | 15 | 20 | 30 | 40 | 60 |
| ------ | - | - | -- | -- | -- | -- | -- | -- |
| Cost to serve (RM) | 4.42 | 8.71 | 14.07 | 19.43 | 24.79 | 35.51 | 46.23 | 67.66 |
| Suggested fee | 19.90 | 19.90 | 39.90 | 39.90 | 69.90 | 69.90 | 99.90 | 119.90 |
| Margin | 78% | 56% | 65% | 51% | 65% | 49% | 54% | 44% |

Without the Large and Arena tiers (Growth up to 15, then RM49.90 for any
size) a 40-court hall leaves about RM4 a month and a 60-court one loses RM18.
On an assumed mix of venue sizes, weighted to small badminton and futsal
halls (2–12 courts), the suggested tiers average about RM37.90 a month and
RM24.65 after costs: about 24 paying venues cover a founder-run install's
own running costs (~RM600 a month), and about 330 would pay for a developer
and a support person (~RM8,047). The biggest unknown is how many bookings
come from first-time customers who choose SMS; the daily cap on codes
(`MYSENAM_PHONE_CODES_PER_DAY`) bounds it.

## Pricing for launch: comparison and recommendation

Prepared on 24 October 2026 for the owner's decision. **Nothing here is an
approved price**, and nothing in the code was changed to match it: what venues
pay is still whatever the owner sets (default free, below). Figures marked
VERIFIED were read on the provider's own page on 18 October 2026, in the
[go-to-market research](../research/go-to-market/index.md); the rest are
assumptions from the cost model above.

### What is implemented today

| Setting | Default | Where |
| ------- | ------- | ----- |
| Flat fee for every venue | RM0 (`MYSENAM_VENUE_FEE`) | `src/lib/billing.ts` |
| Free months after going live | 1, plus the rest of that month (`MYSENAM_FREE_MONTHS`) | `src/lib/billing.ts` |
| Tiers by number of courts and rooms | none set; *Use suggested tiers* offers RM19.90 / 39.90 / 69.90 / 99.90 + RM2 each past 50 | `src/lib/plans.ts` |
| A venue's own agreed fee, and the day its billing starts | none; set per venue by the owner under *Billing* | `src/app/api/admin/billing/route.ts` |
| WhatsApp beyond urgent news | prepaid packs, RM20 for 200 (`MYSENAM_WHATSAPP_PACK_PRICE`, `MYSENAM_WHATSAPP_PACK`) | [messaging](../integrations/messaging.md#what-whatsapp-costs-and-who-pays) |
| Commission on bookings | none: booking money goes to the venue's own gateway account | [ADR 0006](../architecture/decisions/0006-per-venue-payment-accounts.md) |

The public `/pricing` page shows only what is configured, from the same
settings the invoices use. With the defaults it says listing is free while
the platform launches, and that prices are not set yet.

### What the research explored (hypotheses, 18 October 2026)

| Option | Price | Research verdict |
| ------ | ----- | ---------------- |
| A | RM10 a month, flat | Rejected: loses money at most sizes |
| B | RM19.90 a month, flat | Rejected: loses money from about 10 courts |
| C (base card) | RM9.90 + RM3 per active court | Proposed for pilots |
| Higher card | RM19.90 + RM5 per court | To test against C |
| D | Court-count tiers | Stronger per venue, set aside until interviews show how venues think about size |
| WhatsApp | RM0.10 per message from the first, opt-in | Proposed; the code instead sells prepaid packs (about RM0.10 a message) with urgent news included |

None of these was tested with a venue: there is no customer evidence.

### What each costs and earns by venue size

Monthly, in ringgit, against the cost to serve above (RM3.35 fixed plus about
RM1.07 a court, at 40% use and 1.5-hour bookings; ASSUMPTION):

| Courts | Cost to serve | Implemented tiers | Card C | Higher card | Courtsite / AFA (VERIFIED list price) |
| ------ | ------------- | ----------------- | ------ | ----------- | ------------------------------------- |
| 1 | 4.42 | 19.90 | 12.90 | 24.90 | 99 + transaction fee (UNKNOWN) |
| 4 | 7.63 | 19.90 | 21.90 | 39.90 | 99 + fee |
| 10 | 14.07 | 39.90 | 39.90 | 69.90 | 99 + fee |
| 20 | 24.79 | 69.90 | 69.90 | 119.90 | 99–199 + fee |
| 40 | 46.23 | 99.90 | 129.90 | 219.90 | 199 or custom + fee |

The implemented tiers and card C charge the same at 10 and 20 courts; the
tiers charge more for small venues and less for very large ones. Both stay
above the cost to serve at every size; flat prices do not.

### Payment processing

- **Booking money** goes to each venue's own Billplz or Stripe account, so its
  fees are the venue's, agreed with its gateway (VERIFIED list prices: Billplz
  FPX RM1.25, or RM0.75 on its paid membership; cards 1.8%; Stripe 3% + RM1).
  MySenam earns nothing from it and pays nothing for it.
- **Collecting MySenam's own invoice** costs MySenam a gateway fee each
  month: about RM1.35 by FPX in the cost model, which is 7% of RM19.90 and
  10% of card C's RM12.90 for one court. Annual billing would cut that to one
  fee a year; it is **not built** (invoices are monthly).

### Support and onboarding

The research's loaded cost for a support person is about RM22 an hour
(REPORTED salaries), and a three-hour onboarding about RM65 (ASSUMPTION). What
each price leaves for support, after the cost to serve:

| | 1 court | 10 courts |
| - | ------- | --------- |
| Implemented tiers | RM15.48: about 40 minutes a month; onboarding repaid in about 4 months | RM25.83: about 70 minutes; about 2.5 months |
| Card C | RM8.48: about 23 minutes; about 8 months | RM25.83: the same as the tiers |

The smallest venues are the most likely to need help setting up and the least
able to pay for it. Self-service set-up (the first-run checklist, templates
for courts) is what keeps them viable at these prices, more than the price
itself.

### Charging per venue, per outlet, per resource or per transaction

| Unit | For | Against | In the code |
| ---- | --- | ------- | ----------- |
| Per venue (flat) | Simplest to explain | Cost grows with courts and a flat fee does not: large venues are served at a loss, small ones overpay | Yes (`MYSENAM_VENUE_FEE`) |
| Per outlet (branch) | Fits businesses with several branches | For a single-site venue it is the same as per venue | Yes: each branch is priced on its own line of one invoice |
| Per resource (court, room) | Follows the cost to serve; what venues already count | "Courts I don't use" disputes; whole-month outages are already not counted | Yes (tiers) |
| Per transaction | Follows use; nothing to pay in a quiet month | MySenam never holds booking money, so it would invoice per booking afterwards; unpredictable for the venue; undercuts the "no commission" difference from Courtsite and AFA | No |

### Free trials and pilot offers

Pilot terms need no new code: the owner can give a named venue its own agreed
fee (including RM0) and the day its billing starts. A pilot is therefore a
venue-by-venue agreement with an end date, not a free tier. Setting
`MYSENAM_VENUE_FEE` to 0 for everyone is a different thing: a free platform
until it is changed, with no end date any venue has agreed to.

### Recommendation, for approval

1. **Keep charging by number of courts and rooms**, the structure already
   built: it follows the cost to serve, and the research's card C and its
   tiers come to the same price for the venues most likely to sign up.
2. **Offer early venues a written pilot**: free for three months from going
   live (by setting their billing start date), then the published price, with
   the end date agreed in writing. Not a permanent free tier, and not a lower
   price nobody agreed to raise later.
3. **Publish the suggested tiers (RM19.90 / 39.90 / 69.90 / 99.90) as the
   price after the pilot**, once a handful of pilot venues have said they
   would pay them. Raise them, rather than discount them, if the pilots
   suggest the low price reads as a hobby product (the research's warning:
   these are a fifth of the RM99 local anchor).
4. **Keep WhatsApp as prepaid packs**, with urgent news included, as built.
5. **Consider annual billing later** to cut collection fees; it needs
   building and is not a reason to delay.

Trade-offs accepted by this recommendation: prices this low need many venues
(about 24 to cover a founder-run install, about 330 for a developer and a
support person, on the assumptions above), and they rely on venues setting
themselves up with little help.

## Open decisions

Not settled in code or in these documents; each is the owner's to decide.

- **The price venues pay after a pilot**, and whether to publish it: the
  recommendation above, or another. Until then `MYSENAM_VENUE_FEE` stays 0
  and `/pricing` says prices are not set yet.
- **The pilot terms**: how many venues, how long, and what they agree to
  afterwards.
- **Claims on the public `/pricing` page that are commercial terms, not
  software facts:** "no contract" and "no setup fee" (the code charges no
  setup fee; whether venues sign a contract is not decided in the code or the
  draft terms).
- **Whether to run the research's 30-day validation plan** before more
  building, and with which segment.
