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

## Open decisions

Not settled in code or in these documents; each is the owner's to decide.

- **What venues are charged at launch.** `MYSENAM_VENUE_FEE` defaults to 0
  and one free month (`MYSENAM_FREE_MONTHS`); the suggested tiers above are a
  starting point. The research proposed different pilot prices (RM9.90 plus
  RM3 per active court, tested against RM19.90 plus RM5) as hypotheses to
  test, not validated prices ([research](../research/go-to-market/index.md#what-became-of-the-recommendations)).
- **Whether to run the research's 30-day validation plan** before more
  building, and with which segment.
