# ADR 0071: A membership keeps the benefits it was sold with; renewals take the plan as it is then; a plan is not silently priced above the member rate; one order in which passes are offered

- **Status:** current, decided 2026-11-07 in the post-audit hardening round on the audit's findings D6 (the owner's decision DEC-34, authorised), D19 and D18; built in
  migrations 0337 and 0338. What staff and members see is in [pricing](../../features/pricing.md#tiers); the plans route is in [the HTTP API](../http-api.md). Builds on
  [ADR 0025](0025-benefits-and-privileges-by-scope.md) (benefits by the scope they apply to), [ADR 0062](0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md)
  (a term is judged on the session's date) and [ADR 0054](0054-money-paid-never-above-price-and-no-silent-price.md) (no silent price).
- **Context:** a membership's price level, booking window, what its price covers, entry admission and suspension rule were read live from its plan, so a venue editing Gold from 70%
  to 95%, or from a 30-day window to 7, changed what every Gold member had already paid for, on the next booking, without their knowing. A family plan's limit and replacements were
  already copied onto the term; the rest was not, so the rule differed inside one product. Separately, a plan could price members above the venue's own member rate with no warning,
  and three screens offered a customer's passes in three orders (newest, oldest, soonest to end).

## Decision 1: a term keeps the benefits it was sold with

- **A snapshot, not a copy of the plan.** When a membership is sold (`sellMembership`: a purchase paid online, a renewal's charge, a counter sale) it records the benefits its plan gives at that
  moment, as one JSON value: `ratePercent`, `aheadDays`, `scope`, `admitsEntry`, `admitsEntrySport`, `extendOnSuspension` (`memberships.benefits`), with the plan's `version` it was taken at
  (`benefits_version`) and where it came from (`benefits_source`: `sold`, or `backfilled`). Whom a family plan covers keeps its own columns (`cover_limit`, `cover_swaps`, migration 0191).
  The plan has a `version`, 1 to begin with and one more, in the same statement, whenever an edit changes a benefit the snapshot holds; saving what it already is does not make a version.
- **Every reader uses the snapshot** and none reads the plan: the price of a booking (`MEMBERSHIP_SELECT` in `lib/store.ts`, through which a booking, a quote, the grid, a group and a
  move are priced), the member's booking window and the venue's outer window (`lib/house-rules.ts`, `longestPlanWindow`, which now reaches as far as any running term's window as well as any plan's
  on offer, so a plan edited down never shuts out a member who paid for the longer window), entry at the desk (`lib/entries.ts`) and a suspension's extension (`lib/membership-suspensions.ts`).
  A row with no snapshot (written by something that does not know the column, such as a copy of the application running during a deploy) is read from its plan as it stands.
- **Edits apply to terms sold after.** A new purchaser sees the updated plan. A **renewal**, sold when its charge comes in, takes the plan as it is then; the term it runs on from is left as
  sold. A term already paid for runs out with what it had, whichever way the edit went (a dearer price level, a shorter window, an admission switched off, one switched on).
- **Upgrades and downgrades** have the explicit effective date they already had: changing plan is buying another plan in the renewal window, starting the day after the current term ends
  ([pricing](../../features/pricing.md#tiers)); nothing changes a membership's plan mid-term. Each term's snapshot applies on its own dates, because every price is judged on the session's date
  (ADR 0062).
- **Staff see which benefits apply.** The membership list (`GET /api/admin/memberships`, *Credit → Memberships*) shows, under the plan's name, the benefits the term has, the version it was
  sold at and, when the plan's version is later, that the plan has been edited since and a renewal takes the new terms. The edit is in the activity log with the plan's version.
- **Historical reporting is unchanged**: what a member paid is the receipt's, which a plan edit never touched; the snapshot only fixes the benefits.
- **Legacy memberships** (migration 0338): every term sold before gets its plan's benefits **as the plan stands when the migration runs**, with `benefits_source = 'backfilled'` and the plan's
  version (1 for every plan then); a membership on no plan gets the plain benefits. That is exactly what each was getting, so the migration changes no price or window by itself. Earlier
  terms are not reconstructed: what a plan was before the migration is not recorded anywhere. Deterministic and repeatable (only rows with no snapshot), and it retires nothing.
- **What a member is told:** no message exists for an upcoming renewal (a membership that renews by itself is charged by the gateway), so nothing tells a member that the renewal comes on changed
  terms. It is recorded as a limitation, not built here; the activity log records the edit and the snapshot records the version of each term.

## Decision 2: a plan is asked about before it prices members above the member rate, and no member pays more than a non-member

- Saving a plan (the plans route, `POST` and `PATCH`) whose share of the public price comes to more than a court's member rate of the venue (at the off-peak or the peak rate) is answered `409`
  with the court and both prices (`needsConfirm: "above-member-rate"`) and **nothing saved** until it is sent again with `confirmAboveMemberRate: true`. The screen shows the sentence and
  saves on the manager's confirmation. A plan already above it is not asked again when another of its settings changes, only when its share changes. Said in English, Malay and Chinese.
- **Pricing never charges a member more than a non-member for the same slot** (`hourlyMinor`, the fixed price and the per-game price in `lib/pricing.ts`): a member rate above the public rate,
  or a share over 100%, is held to the public price. The court editor already refuses a member rate above the public one; this covers a dated rate change and any legacy value. A tier's share
  that is above the member rate but below the public price is **allowed once confirmed**: the venue may mean it (a lower tier priced between the public price and the member rate).

## Decision 3: one order in which passes are offered

- `comparePassesForUse` and `PASS_USE_ORDER_SQL` (`lib/pass-rules.ts`): the pass that ends soonest first, then the older. The booking form and the counter's *Passes…* offer them in that order
  (the counter's list was oldest first, the form's newest first), and the entry desk (soonest first already) uses the same rule. A choice made is kept: nothing is selected for the customer.
  At the entry desk a day pass already used today comes first, as it costs nothing more that day. The customer's own list of passes stays newest first, as history.

## What was left open

- **Nothing tells a member of changed terms before a renewal**, and a membership that renews by itself is charged at the plan's price by the gateway (the price is not editable on a plan). A
  renewal reminder is the missing message (audit finding D11).
- **No way to give current members an improvement** (apply a better edit to terms already sold): none was asked for. A manager can end a term and sell another, or wait for the renewal.
- **Pass options do not show the date a pass ends**; the order is the rule, the date is not yet on the label (it needs a phrase in each language).
- **Not checked against a real gateway:** renewals are tested through the same sale function a charge reaches (`sellMembership`), not a live Stripe charge.
