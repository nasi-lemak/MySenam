# Feature status

The inventory of what MySenam does, how far each capability is implemented,
and what verifies it. It describes what exists; ideas are in the
[roadmap](../roadmap/roadmap.md), and defects and gaps in
[known limitations](../roadmap/known-limitations.md) (IDs such as B1, M1, S1
below refer there). Built from the code and test suite in the October 2026
[documentation audit](../documentation-audit.md); keep it current as
[`AGENTS.md`](../../AGENTS.md) describes.

## Statuses

| Status | Meaning |
| ------ | ------- |
| IMPLEMENTED_AND_TESTED | Exists, and automated tests meaningfully exercise the behaviour |
| IMPLEMENTED_UNTESTED | Exists, but no meaningful automated test |
| INTEGRATION_VERIFICATION_REQUIRED | Exists and is tested against fakes only; the live third-party service has never been exercised |
| PARTIALLY_IMPLEMENTED | Some of what is needed exists |
| PLANNED | Intended, not built |
| BLOCKED | Cannot proceed without a partner, credential, approval or decision |
| DEFERRED | Postponed on purpose |
| UNSUPPORTED | Deliberately excluded |
| UNKNOWN | Not enough evidence |

Rules used: a test file's existence is not coverage; a mocked integration test
does not prove the live service; a migration or route alone does not prove a
working workflow. "Tested" means the library behaviour is tested; many admin
routes are covered only by the authorisation sweeps (`tests/routes.test.ts`,
`tests/roles.test.ts`) and through the library functions they call. A known
defect does not change a status by itself; it is named in the gaps. A row
that takes money or sends messages is tested for MySenam's side; its gateway,
email or WhatsApp leg is the matching INTEGRATION_VERIFICATION_REQUIRED row,
named in its gaps. Implementation status is not production readiness: what
stands between the two is in [known limitations](../roadmap/known-limitations.md#production-readiness).

## Summary

| Status | Capabilities |
| ------ | ------------ |
| IMPLEMENTED_AND_TESTED | 132 |
| INTEGRATION_VERIFICATION_REQUIRED | 20 |
| IMPLEMENTED_UNTESTED | 4 |
| PARTIALLY_IMPLEMENTED | 3 |
| PLANNED | 2 |
| BLOCKED | 2 |
| UNSUPPORTED | 1 |

## Booking and availability

Authoritative: [booking](../features/booking.md), [booking concurrency](../architecture/booking-concurrency.md), [booking time model](../architecture/interval-booking-review.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Availability grid | IMPLEMENTED_AND_TESTED | Per venue, sport and day: columns as wide as the courts' rules need, free, partly held or held, price, places left, member price, closures; each court's allowed starts and longest length; start and length pickers; server quote before booking | `src/lib/store.ts`, `src/app/api/availability/route.ts`, `src/components/BookingBoard.tsx` | `tests/store.test.ts`, `tests/components/booking-board.test.tsx`, `tests/intervals.test.ts` | — |
| Booking and the double-booking guard | IMPLEMENTED_AND_TESTED | Server-priced booking with an `MS-` code, any minute the court's rules allow; claims under an exclusion constraint and a capacity trigger refuse overlaps whatever writes them; serializable retry | `src/lib/store.ts`, `src/lib/claims.ts`, `src/app/api/bookings/route.ts`, `db/migrations/0089_interval_schema.sql` | `tests/store.test.ts`, `tests/concurrency.test.ts`, `tests/capacity.test.ts`, `tests/intervals.test.ts` | Truly parallel only on the Postgres CI run; at marketplace size a burst of bookings gave errors (B13) |
| Booking rules (policies) | IMPLEMENTED_AND_TESTED | Starts (every N minutes from an offset, or listed times), lengths (steps between shortest and longest, or listed), length offered first, buffers before and after, notice, a court's own weekly hours, sign-off or certification, pricing rules; inherited activity on a court → court → activity at venue → venue → business → the activity's catalogue rules → platform; managers set them in the editor | `src/lib/booking-rules.ts`, `src/lib/booking-policy.ts`, `src/app/api/admin/booking-policies/route.ts`, `src/components/admin/BookingPolicyEditor.tsx` | `tests/booking-policies.test.ts`, `tests/booking-lengths.test.ts`, `tests/intervals.test.ts`, `tests/activities.test.ts` | The editor itself has no component test |
| Staff booking outside the rules | IMPLEMENTED_AND_TESTED | Managers book, move or reschedule past a court's rules, never past a claim or buffer; marked on the booking and in the activity log | `src/app/api/bookings/route.ts`, `src/app/api/admin/bookings/reschedule/route.ts`, `src/lib/store.ts` | `tests/intervals.test.ts`, `tests/components/booking-board.test.tsx` | — |
| Buffers | IMPLEMENTED_AND_TESTED | Time kept free before and after each booking, refused to everyone; customers see it as taken, staff see it with its reason; not charged | `src/lib/claims.ts`, `src/lib/store.ts` | `tests/intervals.test.ts` | Adjacent buffers add up rather than share |
| Shared facilities (capacity > 1) | IMPLEMENTED_AND_TESTED | Places held to the minute, never more than capacity at any moment (database trigger); a booking takes as many places as it says, up to the most per booking; capacity cannot shrink below what is booked | `src/lib/store.ts`, `src/lib/court-activities.ts` | `tests/capacity.test.ts`, `tests/activities.test.ts`, `tests/hire-pricing.test.ts` | — |
| Blocks, whole or partial places | IMPLEMENTED_AND_TESTED | Staff block any minutes with a reason; partial places for fleets; never over bookings, worked out again if a booking lands meanwhile | `src/lib/store.ts`, `src/app/api/admin/blocks/route.ts` | `tests/partial-blocks.test.ts`, `tests/move.test.ts` | Occupancy counts full blocks only |
| "Any court" | IMPLEMENTED_AND_TESTED | Cheapest court free for the whole booking whose rules allow it, re-read on the server | `src/lib/store.ts` | `tests/anycourt.test.ts` | — |
| Weekly series | IMPLEMENTED_AND_TESTED | `SR-` series of 8 weeks (up to 26 where allowed), the same minutes each week, skip or fail clashes and closed weeks | `src/lib/store.ts`, `src/app/api/bookings/cancel-series/route.ts` | `tests/store.test.ts`, `tests/booking-rules.test.ts`, `tests/booking-lengths.test.ts`, `tests/intervals.test.ts` | Series needs an account; series cancel skips late weeks silently |
| Several courts in one booking | IMPLEMENTED_AND_TESTED | 2–6 courts, `GR-` code, one bill and one confirmation; all claimed in one transaction or none | `src/lib/store.ts` | `tests/group-bookings.test.ts`, `tests/intervals.test.ts` | One date, no extras or coach |
| Reservations as intervals | IMPLEMENTED_AND_TESTED | Every occupant of a court is a claim to the minute; linked courts by shared spaces; coaches by their own claims; migration from the half-hour diary checked half hour by half hour, then the diary dropped ([ADR 0010](../architecture/decisions/0010-interval-booking.md)) | `src/lib/claims.ts`, `src/lib/interval.ts`, `src/lib/db-steps.ts`, `db/migrations/0089_interval_schema.sql`, `db/migrations/0090_interval_claims.sql`, `db/migrations/0091_drop_half_hour_diary.sql` | `tests/intervals.test.ts`, `tests/interval-migration.test.ts`, `tests/capacity.test.ts` | Benchmarked at marketplace size ([results](../development/testing.md#results)): claims are read by time, not court (B12); unstaffed hours stay whole hours; zones with daylight saving are refused at setup, when read and by test (`tests/time-zones.test.ts`) |
| Activity catalogue | IMPLEMENTED_AND_TESTED | 32 built-in activities as data (categories, names in four languages, aliases, per-country names and filters, templates, usual rules, support level); foreign keys from every table naming one; synced at start; the browser gets it with the page; padel's 90 minutes and other defaults as catalogue rules ([activities](../features/activities.md), [ADR 0011](../architecture/decisions/0011-activities-as-data.md)) | `src/lib/activity-catalogue.ts`, `src/lib/activity-registry.ts`, `src/lib/activities.ts`, `db/migrations/0092_activities.sql` | `tests/activities.test.ts`, `tests/activity-coverage.test.ts`, `tests/sports.test.ts`, `tests/booking-policies.test.ts` | 23 full, 8 basic, 1 specialised in the [support matrix](../features/activities.md#support-matrix); no DUPR or padel-specific ratings |
| Operators' own activities | IMPLEMENTED_AND_TESTED | Managers add an activity (names, category, model, noun) for their business or venue from the dashboard, offered and searched like any other; retired without losing what was booked; built-ins only retired, by the platform owner | `src/lib/activities.ts`, `src/app/api/admin/activities/route.ts`, `src/components/admin/ResourcesEditor.tsx` | `tests/activities.test.ts` | Basic support until its workflow is reviewed; no translations asked for beyond English |
| Resources offering several activities | IMPLEMENTED_AND_TESTED | One court offers several activities, each with its own rates if set and its own rules level; booked for one at a time under the same constraint; bookings record their activity; moves, cutoffs, peaks, passes, promos and reports follow it; an activity with bookings to come cannot be dropped | `src/lib/court-activities.ts`, `src/lib/resources.ts`, `src/lib/store.ts`, `src/app/api/admin/courts/[id]/route.ts`, `src/components/admin/ResourcesEditor.tsx` | `tests/activities.test.ts` | — |
| Resource templates and batches | IMPLEMENTED_AND_TESTED | Exclusive, lanes, shared, class and hire models fill the add form (noun, places, count, per player, indoor or outdoor; a class room classes only, booked through its classes); up to 20 made at once, numbered on; all editable; contradictory settings refused, in the database too | `src/lib/resources.ts`, `src/app/api/admin/courts/route.ts`, `src/components/admin/ResourcesEditor.tsx` | `tests/activities.test.ts`, `tests/activity-coverage.test.ts`, `tests/hire-pricing.test.ts`, `tests/components/activities-ui.test.tsx` | — |
| Activity sign-offs and certifications | IMPLEMENTED_AND_TESTED | Booking rules ask for an operational sign-off (on by default for climbing and archery) or a certification (with its number, issuer and expiry); each record keeps the person, account, activity, branch or business scope, who gave it and when, expiry, and who took it back and why. Online only the customer's own account counts (linked by staff, or a proved phone number); the counter and the venue's API key by number; managers past the rules on record. Checked on bookings, any court, weekly series (to the last week), rescheduling, the waiting list and open games; one place per sign-off online; in exports and retention | `src/lib/sign-offs.ts`, `src/lib/store.ts`, `src/lib/games.ts`, `src/app/api/admin/sign-offs/route.ts`, `src/components/admin/ResourcesEditor.tsx` | `tests/sign-offs.test.ts`, `tests/activity-coverage.test.ts` | Online it rests on the account's phone check; where an install has no WhatsApp or SMS to check with, only sign-offs staff link to an account work online |
| Courts that share a floor | IMPLEMENTED_AND_TESTED | Whole and part courts take each other through shared spaces in one exclusion constraint | `src/lib/court-links.ts`, `src/lib/claims.ts`, `db/migrations/0090_interval_claims.sql` | `tests/court-links.test.ts`, `tests/intervals.test.ts` | One level deep; utilisation counts the floor once per court (B11) |
| Opening hours, weekday hours, closures | IMPLEMENTED_AND_TESTED | Hours to the minute per venue and per weekday, past midnight; whole-day closures on every path | `src/lib/store.ts`, `src/lib/week-hours.ts`, `src/app/api/admin/venues/[id]/closures/route.ts` | `tests/hours.test.ts`, `tests/week-hours.test.ts` | — |
| Look up and cancel by code and phone | IMPLEMENTED_AND_TESTED | `/my-booking`; cancel before the cutoff; claimed once | `src/app/my-booking/page.tsx`, `src/app/api/bookings/cancel/route.ts` | `tests/store.test.ts`, `tests/booking-rules.test.ts` | — |
| Late cancels, strikes, booking terms, rules by sport | IMPLEMENTED_AND_TESTED | Late share kept; strikes force online pay or the counter; terms box; per-sport cutoff and peak | `src/lib/cancel-policy.ts`, `src/lib/booking-terms.ts`, `src/lib/sport-rules.ts` | `tests/cancel-policy.test.ts`, `tests/booking-terms.test.ts`, `tests/sport-rules.test.ts` | — |
| Moving, rescheduling, booking again | IMPLEMENTED_AND_TESTED | Move court keeping code and payment; change date or time to any start and length the target court's rules allow, on courts offering the booked activity, repriced by the same pricing; "book again" | `src/lib/store.ts`, `src/app/api/admin/bookings/move/route.ts`, `src/app/api/bookings/reschedule/route.ts`, `src/app/api/bookings/again/route.ts` | `tests/move.test.ts`, `tests/reschedule.test.ts` | — |
| Waitlists (court time) | IMPLEMENTED_AND_TESTED | Queue for taken time (start and length, as long as the court allows); a 30-minute offer held as a claim on the court and every court sharing its floor, counted by search, any court, moving and rescheduling; passed on by the scheduler | `src/lib/store.ts`, `src/lib/claims.ts`, `src/app/api/waitlist/route.ts`, `src/app/api/waitlist/claim/route.ts` | `tests/waitlist.test.ts`, `tests/booking-lengths.test.ts`, `tests/intervals.test.ts` | The class waiting list is under [classes](#classes-coaching-and-programmes) |
| House rules, booking window, free courts | IMPLEMENTED_AND_TESTED | Per-person or household limits; up to 90 days ahead; members' longer window; free courts | `src/lib/house-rules.ts` | `tests/house-rules.test.ts`, `tests/booking-window.test.ts` | Counter bookings exempt |
| Who a venue is for, residents' guests | IMPLEMENTED_AND_TESTED | Public, members-only, private; list by phone; residents invite guests | `src/lib/access.ts`, `src/lib/listing.ts`, `src/lib/guest-invites.ts` | `tests/visibility.test.ts`, `tests/guest-invites.test.ts` | Without phone checks, a listed number can be typed by anyone |
| Phone limits, blocked numbers, guest flood | IMPLEMENTED_AND_TESTED | 3 unpaid per venue, 6 overall; block list; flood → pay or sign in | `src/lib/limits.ts` | `tests/limits.test.ts`, `tests/guest-surge.test.ts` | — |
| Extras with a booking | IMPLEMENTED_AND_TESTED | Hire and sale items; rental stock per hour | `src/lib/addons.ts`, `src/components/AddonPicker.tsx` | `tests/addons.test.ts` | Sale items have no stock count |

## Pricing

Authoritative: [pricing](../features/pricing.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Prices to the minute | IMPLEMENTED_AND_TESTED | Pro rata, each part at its rate; or whole at the start rate; fixed-length prices; billing steps, minimum minutes and charge; setup and cleanup fees apart; minor units, rounded once; one function for quotes, bookings, series, moves and refunds | `src/lib/pricing.ts`, `src/app/api/quote/route.ts` | `tests/pricing.test.ts`, `tests/intervals.test.ts`, `tests/money-rules.test.ts` | — |
| Peak bands and holidays | IMPLEMENTED_AND_TESTED | Weekday and weekend windows to the minute; holiday list; gazetted MY/SG holidays filled in | `src/lib/peak.ts`, `src/lib/holiday-calendar.ts` | `tests/peak-rules.test.ts`, `tests/holiday-calendar.test.ts` | Holiday data ends 2027 and is updated by hand; Malaysian 2027 dates from a secondary source |
| Last-minute prices | IMPLEMENTED_AND_TESTED | 5–50% off the minutes starting shortly after booking; loopholes closed | `src/lib/pricing.ts`, `src/lib/store.ts` | `tests/last-minute.test.ts`, `tests/pricing.test.ts` | — |
| Pricing a booking with places | IMPLEMENTED_AND_TESTED | Per place by default; one price for the whole booking (`flatRate`); quantity prices (from so many, each at a percent); kinds of kit as resources of their own; set per resource in the dashboard | `src/lib/pricing.ts`, `src/lib/store.ts`, `src/components/admin/CourtsTab.tsx`, `db/migrations/0093_pricing_and_signoffs.sql` | `tests/hire-pricing.test.ts`, `tests/activities.test.ts` | Kinds within one fleet are planned ([roadmap](../roadmap/roadmap.md)) |
| Promo codes | IMPLEMENTED_AND_TESTED | Percent or fixed, scoped, use and per-customer limits | `src/lib/store.ts`, `src/app/api/admin/promos/route.ts` | `tests/promo.test.ts`, `tests/money-rules.test.ts` | — |
| Concession prices | IMPLEMENTED_AND_TESTED | Share off; proof seen at the desk; only the fact that it was seen is kept, for the period the venue chooses | `src/lib/concessions.ts` | `tests/concessions.test.ts` | — |
| Member rates | IMPLEMENTED_AND_TESTED | Per-court member price by phone, on the session's date | `src/lib/store.ts` | `tests/membership.test.ts` | A member's number typed by anyone gets the rate (by design) |
| Per-player pricing | IMPLEMENTED_AND_TESTED | Court priced per head up to a maximum | `src/lib/store.ts` | `tests/per-player.test.ts` | Not for shared facilities |
| A free hour for regulars | IMPLEMENTED_AND_TESTED | Every N paid hours earns a one-hour pass | `src/lib/loyalty.ts` | `tests/loyalty.test.ts` | Off by default |

## Payments and money

Authoritative: [payments and credit](../features/payments-and-credit.md), [business rules](business-rules.md#money).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Counter payments and the day's takings | IMPLEMENTED_AND_TESTED | Mark paid by method, a whole series; expected, collected, outstanding; un-marking rules | `src/lib/store.ts`, `src/app/api/admin/payments/route.ts`, `src/components/admin/BookingsTab.tsx` | `tests/payment-methods.test.ts`, `tests/staff-tools.test.ts`, `tests/series-payment.test.ts`, `tests/components/bookings-tab.test.tsx` | — |
| Paying online to hold, and deposit shares | IMPLEMENTED_AND_TESTED | Online booking held, released if unpaid; optional part-payment (a share of the price) to hold it, the rest at the venue | `src/lib/holds.ts`, `src/lib/payments.ts` | `tests/holds.test.ts`, `tests/deposits.test.ts`, `tests/payments.test.ts` | Gateway leg: [integrations](#integrations). Not the security deposit on hire ([venue operations](#venue-operations)) |
| Split the cost | IMPLEMENTED_AND_TESTED | 2–10 shares by link; friends pay the venue | `src/lib/splits.ts`, `src/app/split/[token]` | `tests/splits.test.ts` | Pay route not tested directly; shares are paid online only, so the gateway leg is in [integrations](#integrations) |
| Settlement and refunds owed | IMPLEMENTED_AND_TESTED | Settle once; what each page billed; owed-back list | `src/lib/payments.ts`, `src/components/admin/OnlinePaymentsPanel.tsx` | `tests/payments.test.ts`, `tests/money-rules.test.ts`, `tests/stripe-refunds.test.ts` | — |
| Refund when a customer cancels | IMPLEMENTED_AND_TESTED | By staff, through Stripe, or as credit in the pot the credit scope names; the cancellation is claimed once | `src/lib/payments.ts`, `src/lib/store.ts` | `tests/auto-refunds.test.ts`, `tests/booking-rules.test.ts` | The refund steps run after the cancellation commits, not in its transaction (M15); the Stripe leg is in [integrations](#integrations) |
| Receipts, credit notes, venue tax | IMPLEMENTED_AND_TESTED | Per-venue numbering; signed receipt links; SST/GST inside prices | `src/lib/documents.ts`, `src/lib/receipts.ts`, `src/lib/tax.ts` | `tests/receipts.test.ts`, `tests/tax.test.ts` | — |
| Gateway layer and sealed keys | IMPLEMENTED_AND_TESTED | One interface; per-venue keys sealed with `MYSENAM_SECRET` | `src/lib/gateways/index.ts`, `src/lib/secrets.ts` | `tests/gateways.test.ts` | Keys must be re-entered after a restore without the secret |
| Open-game shares | IMPLEMENTED_AND_TESTED | Players pay their share online to the venue; owed back when they leave or the booking goes; the host owes the rest | `src/lib/games.ts` | `tests/games.test.ts` | Gateway leg: [integrations](#integrations) |

## Memberships, passes and credit

Authoritative: [pricing](../features/pricing.md), [payments and credit](../features/payments-and-credit.md), [ADR 0007](../architecture/decisions/0007-stored-credit-ownership.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Memberships sold at the counter | IMPLEMENTED_AND_TESTED | By phone, no overlaps, void, days back, every branch | `src/lib/store.ts`, `src/app/api/admin/memberships/route.ts` | `tests/membership.test.ts`, `tests/branches.test.ts` | — |
| Membership plans and tiers online | IMPLEMENTED_AND_TESTED | Join or renew online; tiers with price share and booking window | `src/lib/membership-plans.ts`, `src/components/JoinMembership.tsx` | `tests/membership-join.test.ts`, `tests/membership-tiers.test.ts`, `tests/components/join-membership.test.tsx` | Not sold at private venues; gateway leg (a fake Billplz in the tests) and renewals in [integrations](#integrations) |
| Multi-visit passes and lesson packs | IMPLEMENTED_AND_TESTED | Ledger of entries or minutes: session passes an entry per so many minutes or part (60 unless set) or per booking; time passes the minutes booked; a longest booking per pass; sold as either at the counter | `src/lib/store.ts`, `src/lib/pass-rules.ts`, `src/lib/coaching.ts`, `src/app/api/admin/passes/route.ts` | `tests/passes.test.ts`, `tests/intervals.test.ts`, `tests/concurrency.test.ts` | — |
| Stored credit and its scope | IMPLEMENTED_AND_TESTED | Append-only ledger; sold at the counter; spent once; venue or platform scope | `src/lib/store.ts`, `src/lib/mode.ts` | `tests/wallet.test.ts`, `tests/credit-scope.test.ts`, `tests/concurrency.test.ts` | Spending never goes below nothing, but a chargeback on credit already spent does, on purpose, with no database guard; the liability reports leave such balances out (M14) |
| Online top-ups | IMPLEMENTED_AND_TESTED | Into the venue's account; credited once on settlement | `src/lib/payments.ts`, `src/app/api/my/wallet/route.ts` | `tests/topups.test.ts` | Gateway leg below |
| Gift vouchers | IMPLEMENTED_AND_TESTED | Sold at the counter or online; printable; redeemed as credit | `src/lib/vouchers.ts` | `tests/vouchers.test.ts` | Online purchase: gateway and email legs in [integrations](#integrations) |
| Company and school accounts | IMPLEMENTED_AND_TESTED | Named bookers, limit, monthly emailed invoice, mark paid | `src/lib/accounts.ts`, `src/app/account-invoice/[token]` | `tests/accounts.test.ts` | Invoice email and page in English only |

## Classes, coaching and programmes

Authoritative: [programmes](../features/programmes.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Classes and terms | IMPLEMENTED_AND_TESTED | One-off or weekly classes on a room or court, hidden from court booking; enrol, roster, cancel; whole term at a discount | `src/lib/store.ts`, `src/app/api/classes/enrol/route.ts`, `src/app/api/classes/term/route.ts` | `tests/classes.test.ts`, `tests/class-terms.test.ts` | Term route not tested directly; a class is cancelled, never moved; the instructor is a name, not one of the venue's coaches; no attendance register of its own |
| Class waiting list | IMPLEMENTED_AND_TESTED | Queue for a full class; a freed place offered to the first, claimed by link within the offer time | `src/lib/store.ts`, `src/app/api/waitlist/route.ts`, `src/app/api/waitlist/claim/route.ts` | `tests/waitlist.test.ts` | Offers a place, not court time, so it holds no claim |
| One-to-one coaching | IMPLEMENTED_AND_TESTED | A lesson is a booking plus the coach's time, inside the coach's hours and sports; weekly for up to 8 weeks for a signed-in customer; paid whole by a lesson pack | `src/lib/coaching.ts`, `src/app/api/coaching/slots/route.ts` | `tests/coaching.test.ts`, `tests/coaching-two.test.ts` | Nobody, staff included, moves a lesson's time: it is cancelled and booked again |
| Coach link, feed, alerts, payouts | IMPLEMENTED_AND_TESTED | Private coach page and calendar; own hours and time off; emails of lessons booked and cancelled; a payouts report of fees for lessons held and late cancels | `src/lib/coach-schedule.ts`, `src/app/coach/[token]` | `tests/coaching-two.test.ts`, `tests/coach-self.test.ts` | Payouts are a report (CSV), nothing is paid; email delivery live-unverified |
| Tournaments: setup and court time | IMPLEMENTED_AND_TESTED | Staff set one up for a sport, dates and courts; the courts are held whole until the draw, then from each court's first match to its last; time a walkover leaves is given back and offered to whoever waits | `src/lib/tournaments.ts`, `src/app/api/admin/tournaments/route.ts` | `tests/tournaments.test.ts` | Entries close when staff close them (no deadline); no divisions or age groups; a level is shown, not enforced |
| Tournament entries, waiting list and fees | IMPLEMENTED_AND_TESTED | Players with an account enter singles or doubles (partner named); full → waiting list, promoted when somebody withdraws; fee paid online to the venue or marked paid at the counter | `src/lib/tournaments.ts`, `src/lib/payments.ts`, `src/app/api/tournaments/[id]/route.ts` | `tests/tournaments.test.ts`, `tests/who.test.ts` | Partner is a name, not an account; an online fee settling after a counter mark is kept, not owed back (M12); refund on withdrawal before the draw untested; gateway leg in [integrations](#integrations) |
| Tournament draw, seeding and schedule | IMPLEMENTED_AND_TESTED | Knockout, or groups then knockout; seeds set by staff, byes to the top seeds, the rest drawn by chance; matches scheduled side by side on the held courts, saying what did not fit | `src/lib/tournaments.ts`, `src/lib/brackets.ts` | `tests/tournaments.test.ts`, `tests/brackets.test.ts` | Seeding by hand only; no round robin alone, consolation or Swiss formats |
| Tournament results, standings and public bracket | IMPLEMENTED_AND_TESTED | Staff enter scores as sets; corrected until the next match is played; groups ranked on wins, sets, points, then head to head; group places fill the knockout; public page with the draw and results | `src/lib/tournaments.ts`, `src/lib/brackets.ts`, `src/app/tournaments/[id]` | `tests/tournaments.test.ts`, `tests/brackets.test.ts` | Players cannot enter results; no check-in on the day; no rankings across events; a group result changed after the knockout is filled leaves it as it was (B9) |
| Tournament withdrawals and call-off | IMPLEMENTED_AND_TESTED | Before the draw a withdrawal lets the next one in; after it, a walkover where the opponent is known; call-off gives the courts back, emails every entrant and owes back fees paid online; an account closed withdraws its entries | `src/lib/tournaments.ts` | `tests/tournaments.test.ts` | Later walkovers are entered by staff, and a withdrawn player's group wins still count (B10); no refund after the draw |
| Box leagues: setup and seasons | IMPLEMENTED_AND_TESTED | Staff set one up (singles or doubles) and its season dates; three players or more are boxed by level; a season ends by itself a few days after its last day and the next begins on its day; staff can stop a league or remove a player | `src/lib/leagues.ts`, `src/lib/boxes.ts`, `src/lib/scheduler.ts` | `tests/leagues.test.ts`, `tests/boxes.test.ts` | Box leagues only: no team leagues or fixture lists |
| League places and fees | IMPLEMENTED_AND_TESTED | Players with an account join once, doubles with a partner named; the fee is paid online once the boxes are made, or at the counter; leaving hands the matches still to play to the other side | `src/lib/leagues.ts`, `src/lib/payments.ts` | `tests/leagues.test.ts`, `tests/who.test.ts` | Women-only or men-only checks the player, not the partner; a level is not enforced; refund of a fee paid after leaving untested; gateway leg in [integrations](#integrations) |
| League results and disputes | IMPLEMENTED_AND_TESTED | One side reports, the other confirms or disputes; disputes go to the venue's staff, who decide; unanswered reports stand after three days; box-mates see each other's numbers, nobody else does | `src/lib/leagues.ts`, `src/app/leagues/[id]` | `tests/leagues.test.ts` | Emails go out for reports and disputes, not for staff decisions or walkovers |
| League promotion and relegation | IMPLEMENTED_AND_TESTED | The best move up and the worst down, never more than half a box, never off the top or bottom; newcomers placed by staff | `src/lib/boxes.ts`, `src/lib/leagues.ts` | `tests/boxes.test.ts`, `tests/leagues.test.ts` | No ranking that carries across leagues |
| Open games: hosting | IMPLEMENTED_AND_TESTED | The host opens a game on their own upcoming booking, once: places, level, a share suggested to split the court evenly, everybody in or asked; closed by the host; called off with the booking | `src/lib/games.ts`, `src/app/api/games/route.ts` | `tests/games.test.ts` | No "call off the game" apart from cancelling the booking; a booking that has had a game cannot be rescheduled by anybody |
| Finding open games | IMPLEMENTED_AND_TESTED | Public games for the next 14 days by activity, level, distance, area and who it is for, full ones hidden, yours marked; the `/play` hub | `src/lib/games.ts`, `src/app/play/page.tsx`, `src/app/api/games/route.ts` | `tests/games.test.ts`, `tests/who.test.ts` | Finds games, not players: no player discovery or matchmaking (row below) |
| Joining open games and host decisions | IMPLEMENTED_AND_TESTED | Players with an account ask, or are straight in; the host accepts, declines, removes or marks a no-show; joining stops after repeated no-shows; players leave; emails to host and player | `src/lib/games.ts`, `src/app/api/games/[id]/players/[playerId]/route.ts` | `tests/games.test.ts` | Removal by the host is not tested; emails sent once, not through the outbox (S9) |
| Player levels | IMPLEMENTED_AND_TESTED | Each player rates themselves per activity; shown on games and used as a filter | `src/lib/games.ts` | `tests/games.test.ts` | Self-rated, not verified; no rating from results |
| Player discovery and matchmaking | PLANNED | Not built: nobody can look for players, and nothing matches players by level or availability ([roadmap](../roadmap/roadmap.md)) | — | — | Recruitment is by advertising places in a public game only |
| Invite-only games, invitations and a game waiting list | PLANNED | Not built: every open game is public, a full game cannot be queued for, and nobody is invited ([roadmap](../roadmap/roadmap.md)) | — | — | — |
| Women-only and men-only | IMPLEMENTED_AND_TESTED | Self-declared gates on games, leagues, classes, tournaments | `src/lib/who.ts` | `tests/who.test.ts` | Cannot be verified |

## Venue operations

Authoritative: [venue operations](../features/venue-operations.md), [booking](../features/booking.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Check-in, no-shows, live crowd | IMPLEMENTED_AND_TESTED | Check in and out; no-show flags; public "here right now" | `src/app/api/admin/check-in/route.ts`, `src/app/api/venues/[id]/live/route.ts` | `tests/checkin.test.ts` | — |
| QR self check-in | IMPLEMENTED_AND_TESTED | Token per booking | `src/app/checkin/[token]` | `tests/checkin.test.ts` | QR image route untested |
| Unstaffed hours and door codes | IMPLEMENTED_AND_TESTED | Code shown to an inducted, paid customer; every look logged | `src/app/api/access/route.ts`, `src/app/api/admin/inductions/route.ts` | `tests/access.test.ts` | One code per lock; no lock integration; staffed hours are whole hours, judged by the booking's start ([known limitations](../roadmap/known-limitations.md#booking-and-availability-b)) |
| Equipment hire and deposits | IMPLEMENTED_AND_TESTED | Hand over against a security deposit; return with condition, keeping back up to the deposit with a note | `src/lib/store.ts`, `src/app/api/admin/hire/route.ts` | `tests/hire.test.ts` | What is kept back gets no receipt and is in no takings, report or export (M13) |
| Counter sales | IMPLEMENTED_AND_TESTED | Receipted walk-in sales; manager void | `src/lib/counter-sales.ts` | `tests/counter-sales.test.ts` | No stock count |
| Notes on a customer | IMPLEMENTED_AND_TESTED | One note per number per venue | `src/lib/customer-notes.ts` | `tests/customer-notes.test.ts` | — |
| Waivers | IMPLEMENTED_AND_TESTED | Versioned; ticked when booking or enrolling; paper signatures | `src/lib/waivers.ts`, `src/components/WaiverTick.tsx` | `tests/waivers.test.ts` | Waiver page route untested |
| Private hire enquiries | IMPLEMENTED_AND_TESTED | Venue-page form; staff list and email; status | `src/lib/enquiries.ts`, `src/components/HireEnquiry.tsx` | `tests/enquiries.test.ts` | Staff book the courts by hand |
| Rain-outs | IMPLEMENTED_AND_TESTED | Preview, then cancel, refund, notify and block | `src/lib/rain-outs.ts` | `tests/rain-outs.test.ts` | No weather feed |
| Weekly blocks | IMPLEMENTED_AND_TESTED | Same hours every week up to 52 weeks | `src/lib/repeat-blocks.ts` | `tests/repeat-blocks.test.ts` | — |
| Courts out of service | IMPLEMENTED_AND_TESTED | Outage over dates; cancel and refund on request | `src/lib/outages.ts` | `tests/outages.test.ts` | — |
| Booking link and QR poster | IMPLEMENTED_AND_TESTED | Venue link, QR, printable poster | `src/lib/venue-link.ts` | `tests/booking-link.test.ts` | Poster page untested |
| First-run checklist and demo data | IMPLEMENTED_AND_TESTED | Checklist; one-click demo fortnight | `src/lib/setup.ts`, `src/lib/demo.ts` | `tests/setup.test.ts`, `tests/demo.test.ts` | — |

## Customer accounts and authentication

Authoritative: [authentication](../architecture/authentication.md), [privacy](../architecture/privacy.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Register, sign in, sessions | IMPLEMENTED_AND_TESTED | scrypt passwords; HttpOnly cookie, Secure on HTTPS | `src/lib/auth.ts`, `src/lib/session-cookie.ts` | `tests/auth.test.ts`, `tests/session-cookie.test.ts`, `tests/login-limits.test.ts` | No CSRF token; cross-site writes refused by `Origin` (row below) |
| Security headers and cross-site check | IMPLEMENTED_AND_TESTED | CSP, framing, HSTS and others on every response; signed-in cross-site writes refused | `src/lib/security-headers.ts`, `src/lib/same-origin.ts`, `src/middleware.ts` | `tests/launch-security.test.ts`, `tests/e2e/launch.e2e.ts` | CSP allows inline scripts (nonces under review) |
| Tenant isolation | IMPLEMENTED_AND_TESTED | Venue staff reach only their venues; customers only their own records | `src/lib/admin-auth.ts` (`denyVenue`), `src/lib/auth.ts` | `tests/tenant-sweep.test.ts`, `tests/routes.test.ts`, `tests/branches.test.ts` | Server-to-server callbacks are covered by their signature tests, not this sweep |
| Owner password in production | IMPLEMENTED_AND_TESTED | No owner without a 12+ character `ADMIN_PASSWORD`; the default refused at sign-in; replaced at start | `src/lib/admin-auth.ts`, `src/instrumentation-node.ts` | `tests/launch-security.test.ts`, `tests/e2e/launch.e2e.ts` | — |
| Password reset and change | IMPLEMENTED_AND_TESTED | Single-use hashed token; signs out everywhere | `src/lib/password-reset.ts` | `tests/password-reset.test.ts` | Email delivery live-unverified |
| Phone verification | IMPLEMENTED_AND_TESTED | Inbound WhatsApp token or a code by SMS or WhatsApp; caps | `src/lib/phone-check.ts` | `tests/phone-methods.test.ts`, `tests/sign-in.test.ts` | Live channels below |
| Account page and phone-is-not-identity guards | IMPLEMENTED_AND_TESTED | Passes, memberships, wallet keyed on the account | `src/app/account`, `src/app/api/my/passes/route.ts` | `tests/impersonation.test.ts`, `tests/components/customer-bits.test.tsx` | A membership's rate goes to whoever types the member's number, by design ([member rates](#pricing)) |
| Data export, erasure, retention | IMPLEMENTED_AND_TESTED | Export and close account (books kept); retention schedule | `src/lib/privacy.ts` | `tests/privacy.test.ts`, `tests/data-request.test.ts` | Erasure clears only what is provably the account's; rows sharing just a phone number wait for retention; the two-year prune of the staff activity log is not tested |
| Privacy notice and terms | PARTIALLY_IMPLEMENTED | Pages describe what the software does; the notice is in all four languages and names the operator to write to from `OPERATOR_*` | `src/app/privacy/page.tsx`, `src/app/terms/page.tsx` | `tests/privacy-notice.test.tsx` | Drafts: no lawyer has read them or any translation; the terms are in English only |

## Staff, roles and tenancy

Authoritative: [tenancy](../architecture/tenancy.md), [marketplace](marketplace.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Staff accounts and venue scoping | IMPLEMENTED_AND_TESTED | Owners, managers, branch staff; every admin route scoped | `src/lib/admin-auth.ts` | `tests/admin.test.ts`, `tests/routes.test.ts`, `tests/tenant-sweep.test.ts` | — |
| Manager and front-desk roles | IMPLEMENTED_AND_TESTED | One route table enforced in `requireAdmin` | `src/lib/roles.ts` | `tests/roles.test.ts` | — |
| Staff activity log | IMPLEMENTED_AND_TESTED | Who did what and when; kept two years | `src/lib/activity.ts`, `src/lib/privacy.ts` | `tests/roles.test.ts` | Entries mostly asserted inside feature tests; the two-year prune is not tested |
| Two-factor sign-in for staff | IMPLEMENTED_AND_TESTED | TOTP, recovery codes, replay guard, compulsory option | `src/lib/two-factor.ts` | `tests/two-factor.test.ts` | Lost phone and codes needs a database edit ([known limitations](../roadmap/known-limitations.md#operations-and-security-s)) |
| Businesses and branches | IMPLEMENTED_AND_TESTED | One sign-in for every branch; shared credit; one invoice | `src/lib/branches.ts` | `tests/branches.test.ts` | — |
| Suspensions and overdue-invoice holds | IMPLEMENTED_AND_TESTED | Owner suspends; overdue venues delisted until paid | `src/lib/suspensions.ts`, `src/lib/payment-holds.ts` | `tests/suspensions.test.ts` | — |

## Messaging

Authoritative: [messaging](../integrations/messaging.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Message outbox | IMPLEMENTED_AND_TESTED | Written, then sent once with backoff; 8 a day per recipient | `src/lib/outbox.ts` | `tests/outbox.test.ts`, `tests/limits.test.ts`, `tests/booking-alerts.test.ts` | Programme emails bypass it (S9) |
| Confirmations, reminders, receipts | IMPLEMENTED_AND_TESTED | In the customer's language, with a calendar invite | `src/lib/notify.ts`, `src/lib/booking-links.ts` | `tests/transports.test.ts`, `tests/urgent.test.ts`, `tests/booking-links.test.ts`, `tests/components/download-ics.test.ts` | Live delivery below |
| Urgent notices and acknowledgement | IMPLEMENTED_AND_TESTED | Venue cancels or moves → "seen it" link; needs-attention panel | `src/lib/urgent.ts` | `tests/urgent.test.ts`, `tests/components/attention-panel.test.tsx` | — |
| New-booking alerts to the venue | IMPLEMENTED_AND_TESTED | Email or WhatsApp per online booking | `src/lib/notify.ts` | `tests/booking-alerts.test.ts` | Live delivery: email and WhatsApp in [integrations](#integrations) |
| WhatsApp per venue and prepaid packs | IMPLEMENTED_AND_TESTED | Off, urgent or everything; packs spent per message | `src/lib/whatsapp-credit.ts`, `src/lib/whatsapp-usage.ts` | `tests/whatsapp-usage.test.ts`, `tests/components/whatsapp-panel.test.tsx` | Packs bought online: gateway leg in [integrations](#integrations) |
| Marketing email | IMPLEMENTED_AND_TESTED | Consent kept with its wording; double opt-in; one-click unsubscribe | `src/lib/marketing.ts` | `tests/marketing.test.ts` | Live delivery: email in [integrations](#integrations) |
| Staff calendar feed | IMPLEMENTED_AND_TESTED | Tokenised calendar of bookings and classes | `src/lib/staff-calendar.ts` | `tests/staff-calendar.test.ts` | — |

## Marketplace and discovery

Authoritative: [discovery](../features/discovery.md), [marketplace](marketplace.md), [business: pricing](../business/pricing.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Cross-venue search | IMPLEMENTED_AND_TESTED | Activity, day, time window; one row per venue and time | `src/lib/store.ts`, `src/app/api/search/route.ts` | `tests/store.test.ts`, `tests/browse.test.ts` | Seconds at marketplace size (B12) |
| Finding an activity | IMPLEMENTED_AND_TESTED | Search lists every court-bookable activity offered, by category in the catalogue's order; found by any name or alias in any language (`q=`); class-only activities named with a link to Classes; court filters that suit the activity; the home page's eight buttons are the most booked in the last 30 days where the customer is looking, the rest in a list; results keep the customer's order (soonest, nearest, cheapest) | `src/app/search/SearchClient.tsx`, `src/app/search/page.tsx`, `src/app/QuickSearch.tsx`, `src/app/api/search/route.ts`, `src/lib/store.ts`, `src/lib/activity-registry.ts` | `tests/activities.test.ts`, `tests/components/activities-ui.test.tsx`, `tests/sports.test.ts`, `tests/e2e/activities.e2e.ts` | Popularity counts bookings, not searches |
| Courts near me | IMPLEMENTED_AND_TESTED | Location or typed place; distance in SQL | `src/lib/geo.ts` | `tests/near.test.ts`, `tests/geo.test.ts` | Straight-line distance; a typed place needs the geocoder ([integrations](#integrations)) |
| Venue list and fairness | IMPLEMENTED_AND_TESTED | Paged; daily shuffle; caps per venue | `src/lib/listing.ts`, `src/lib/store.ts` | `tests/browse.test.ts`, `tests/fairness.test.ts` | The daily shuffle's order is not asserted by a test |
| Facilities and court features | IMPLEMENTED_AND_TESTED | Fixed vocabulary; filters | `src/lib/facilities.ts` | `tests/facilities.test.ts` | — |
| Venue photos | IMPLEMENTED_AND_TESTED | Sniffed, re-encoded WebP, metadata stripped | `src/lib/photos.ts` | `tests/photos.test.ts` | — |
| Reviews | IMPLEMENTED_AND_TESTED | Only after a visit; replies and reports | `src/lib/reviews.ts` | `tests/reviews.test.ts` | — |
| Notices | IMPLEMENTED_AND_TESTED | Venue and site-wide notices | `src/lib/notices.ts` | `tests/notices.test.ts` | — |
| Search engines | IMPLEMENTED_AND_TESTED | Sitemap, robots, structured data | `src/lib/seo.ts`, `src/app/sitemap.ts` | `tests/seo.test.ts` | — |
| Installing as an app | IMPLEMENTED_UNTESTED | Web manifest and icons | `src/app/manifest.ts` | — | No service worker, offline mode or push |
| Storefront domains | IMPLEMENTED_AND_TESTED | Branded subset by hostname | `src/lib/storefront.ts`, `src/app/api/tls-check/route.ts` | `tests/storefront.test.ts` | A window, not a data wall |
| Venue sign-up and location checks | IMPLEMENTED_AND_TESTED | Apply, confirm email, pin and address checks | `src/lib/applications.ts` | `tests/applications.test.ts`, `tests/components/applications-panel.test.tsx` | Geocoder live-unverified |
| Drafts and going live | IMPLEMENTED_AND_TESTED | Draft hidden; owner approves | `src/lib/drafts.ts` | `tests/drafts.test.ts` | — |
| Venue billing, tiers, platform tax | IMPLEMENTED_AND_TESTED | Monthly invoices; tiers by size; operator SST/GST | `src/lib/billing.ts`, `src/lib/plans.ts` | `tests/billing.test.ts`, `tests/plans.test.ts`, `tests/platform-tax.test.ts` | Tier prices are assumptions; a lost dispute on the platform account is put to the owners, not undone; invoices paid online: gateway leg in [integrations](#integrations) |

## Reporting

Authoritative: [reporting](../features/reporting.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Period reports and occupancy | IMPLEMENTED_AND_TESTED | Booked vs collected; utilisation; what is owed | `src/lib/reports.ts` | `tests/reports.test.ts`, `tests/court-links.test.ts` | Linked courts: time sold counted once, but each court's floor time counted as sellable, so utilisation reads low (B11); hire money kept back (M13) and negative credit balances (M14) are not reported |
| Customer report | IMPLEMENTED_AND_TESTED | New vs returning; top customers; lapsed regulars; no-shows | `src/lib/customer-report.ts` | `tests/customer-report.test.ts` | — |
| Exports and sales journal | IMPLEMENTED_AND_TESTED | Excel-safe CSV; journal by category, tax and method | `src/lib/export.ts`, `src/lib/accounting.ts` | `tests/export.test.ts`, `tests/accounting.test.ts` | — |

## Integrations

Every row marked INTEGRATION_VERIFICATION_REQUIRED is exercised by tests
against fakes only (stubbed `fetch`, mocked mail, a fake LHDN, a local fake
S3); the public API and outgoing webhooks are MySenam's own code. Rows above
that take money or send messages name their leg here. Authoritative:
[payment gateways](../integrations/payment-gateways.md),
[messaging](../integrations/messaging.md), [MyInvois](../integrations/myinvois.md),
[external API](../integrations/external-api.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Billplz bill creation | INTEGRATION_VERIFICATION_REQUIRED | Venue and platform bills, FPX and card | `src/lib/billplz.ts`, `src/lib/gateways/billplz.ts` | `tests/payments.test.ts`, `tests/billing.test.ts`, `tests/whatsapp-usage.test.ts` | Billplz sandbox; no test tells FPX from card |
| Billplz callback verification | INTEGRATION_VERIFICATION_REQUIRED | X-Signature on callback and redirect; settled once | `src/app/api/payments/[provider]/callback/route.ts` | `tests/payments.test.ts` | Checked against Billplz's documented example only |
| Stripe Checkout | INTEGRATION_VERIFICATION_REQUIRED | Session in cents on the venue's key; closes with the hold | `src/lib/gateways/stripe.ts` | `tests/stripe.test.ts` | Key permissions unverified |
| Stripe webhook and return verification | INTEGRATION_VERIFICATION_REQUIRED | Signature within five minutes; return page re-checks | `src/lib/gateways/stripe.ts`, `src/app/payments/return` | `tests/stripe.test.ts` | — |
| Stripe refunds | INTEGRATION_VERIFICATION_REQUIRED | One-click and automatic, with an idempotency key; claimed before Stripe is asked, interrupted ones asked again | `src/lib/payments.ts`, `src/lib/scheduler.ts` | `tests/stripe-refunds.test.ts` | Needs Refunds: Write |
| Stripe disputes | INTEGRATION_VERIFICATION_REQUIRED | Recorded once; lost → what it paid for undone; on the platform's account → owners told | `src/lib/payments.ts` | `tests/stripe-disputes.test.ts` | Needs a test-mode dispute against real Stripe |
| Stripe membership renewals | INTEGRATION_VERIFICATION_REQUIRED | Subscription per plan; `invoice.paid` → next period | `src/lib/payments.ts` | `tests/membership-renewal.test.ts` | Stripe only |
| MyInvois connection | INTEGRATION_VERIFICATION_REQUIRED | Venue's own client or platform as intermediary | `src/lib/myinvois/client.ts` | `tests/myinvois.test.ts` | Never tried against LHDN |
| MyInvois consolidated and credit notes | INTEGRATION_VERIFICATION_REQUIRED | Monthly consolidated documents; large sales alone | `src/lib/myinvois.ts`, `src/lib/myinvois/ubl.ts` | `tests/myinvois.test.ts` | Cancelling done in the portal |
| MyInvois customer's own e-invoice | INTEGRATION_VERIFICATION_REQUIRED | Buyer details through the receipt link | `src/app/api/receipts/einvoice/route.ts` | `tests/myinvois.test.ts` | — |
| Google sign-in | INTEGRATION_VERIFICATION_REQUIRED | OIDC with PKCE, state and nonce | `src/lib/oauth.ts`, `src/app/api/auth/google/callback/route.ts` | `tests/sign-in.test.ts` | Main domain only |
| Off-site backup copies | INTEGRATION_VERIFICATION_REQUIRED | Signed streamed upload of each backup | `src/lib/offsite.ts` | `tests/offsite.test.ts` | R2, B2 or S3 bucket |
| Photo bucket | INTEGRATION_VERIFICATION_REQUIRED | Photos in their own bucket | `src/lib/photo-store.ts` | `tests/photos.test.ts` | — |
| WhatsApp template messages | INTEGRATION_VERIFICATION_REQUIRED | Templates in four languages, kept in step with the docs by a test | `src/lib/transports.ts` | `tests/transports.test.ts` | Meta approval |
| WhatsApp webhook | INTEGRATION_VERIFICATION_REQUIRED | Signed delivery statuses; inbound verification | `src/app/api/whatsapp/webhook/route.ts` | `tests/whatsapp-usage.test.ts`, `tests/urgent.test.ts`, `tests/phone-methods.test.ts` | — |
| WhatsApp chat replies | INTEGRATION_VERIFICATION_REQUIRED | Reply in the chat if the customer writes first | `src/lib/whatsapp-chat.ts` | `tests/whatsapp-usage.test.ts` | Pricing assumption unverified |
| SMS codes | INTEGRATION_VERIFICATION_REQUIRED | Twilio or an HTTP gateway | `src/lib/transports.ts` | `tests/phone-methods.test.ts` | — |
| Email (SMTP) | INTEGRATION_VERIFICATION_REQUIRED | nodemailer with calendar invite and unsubscribe headers | `src/lib/transports.ts` | `tests/transports.test.ts` | SPF/DKIM unverified |
| Geocoding | INTEGRATION_VERIFICATION_REQUIRED | Address and pin lookups, cached | `src/lib/geo.ts` | `tests/geo.test.ts` | Public server's usage policy |
| Error and alert sinks | INTEGRATION_VERIFICATION_REQUIRED | Sentry envelope; chat webhooks | `src/lib/error-log.ts`, `src/lib/alerts.ts` | `tests/error-log.test.ts`, `tests/alerts.test.ts` | — |
| Public API and keys | IMPLEMENTED_AND_TESTED | Read, write and availability keys; venue-scoped | `src/lib/api-keys.ts`, `src/lib/public-api.ts` | `tests/public-api.test.ts` | — |
| Outgoing signed webhooks | IMPLEMENTED_AND_TESTED | Sweep, HMAC, retries, private addresses refused by the connection's own lookup | `src/lib/webhooks.ts` | `tests/public-api.test.ts` | — |
| Reserve with Google feeds | PARTIALLY_IMPLEMENTED | Merchant, service and availability feeds, downloaded by owners | `src/lib/google-feeds.ts` | `tests/public-api.test.ts` | One test, of which venues are listed; the feeds' shapes and field names are unchecked; no upload; no partner status |
| Reserve with Google booking server | BLOCKED | Not built | — | — | Actions Center partner approval |
| Smart-lock credentials | BLOCKED | Not built | — | — | Vendor credentials |
| Billplz refunds and subscriptions | UNSUPPORTED | Billplz offers no such API; refunds are marked by hand | `src/lib/payments.ts` | — | — |

## Localisation and regions

Authoritative: [regions and tax](regions-and-tax.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| English, Malay, Chinese; translated refusals | IMPLEMENTED_AND_TESTED | Typed dictionaries; refusals carry codes | `src/lib/i18n.ts`, `src/lib/i18n-zh.ts`, `src/lib/api.ts` | `tests/i18n.test.ts`, `tests/locale.test.ts`, `tests/components/language.test.tsx` | Built-in activity names in Malay and Chinese are machine-assisted, awaiting a native speaker |
| Tamil | PARTIALLY_IMPLEMENTED | Complete dictionary | `src/lib/i18n-ta.ts` | `tests/i18n.test.ts` | Machine translation awaiting a native speaker's review |
| Countries, money, phone numbers | IMPLEMENTED_AND_TESTED | Malaysia or Singapore per install; cents; `phone_key()` | `src/lib/region.ts`, `src/lib/phone.ts` | `tests/region.test.ts`, `tests/cents.test.ts`, `tests/phone-region.test.ts` | One country per install |
| Per-venue time zones | IMPLEMENTED_AND_TESTED | From the map pin or chosen, among the country's zones | `src/lib/zones.ts`, `src/lib/time.ts` | `tests/time-zones.test.ts` | Zones with daylight saving refused ([known limitations](../roadmap/known-limitations.md#booking-and-availability-b)) |

## Operations

Authoritative: [deployment](../operations/deployment.md), [backups](../operations/backups.md), [monitoring](../operations/monitoring.md).

| Capability | Status | Implemented behaviour | Code | Tests | Gaps and dependencies |
| ---------- | ------ | --------------------- | ---- | ----- | --------------------- |
| Scheduler and its lease | IMPLEMENTED_AND_TESTED | Minute tick; one instance works | `src/lib/scheduler.ts` | `tests/scheduler.test.ts`, `tests/scale-out.test.ts` | Runs inside a long-running `next start`; with `MYSENAM_SCHEDULER=off` an operator's own cron must do the work |
| Rate limiting | IMPLEMENTED_AND_TESTED | In memory or shared in Postgres; IPv6 per /64 | `src/lib/rate-limit.ts` | `tests/rate-limit.test.ts`, `tests/login-limits.test.ts` | More than one instance needs `MYSENAM_RATE_LIMITS=shared` |
| Nightly backups by the app | IMPLEMENTED_AND_TESTED | `pg_dump` or PGlite snapshot; verified; kept 14 | `src/lib/backup.ts` | `tests/backup.test.ts` | A `pg_dump` copy is listed, not loaded |
| Backup and restore scripts | IMPLEMENTED_AND_TESTED | `npm run backup`, `npm run restore` | `scripts/backup.mjs`, `scripts/restore.mjs` | `tests/backup-scripts.test.ts` | Run on a database with starter venues and no bookings; the test checks the scripts succeed, not that the data restored matches; photos outside a bucket are in no backup |
| SQLite import script | IMPLEMENTED_UNTESTED | `npm run import-sqlite` moves an old SQLite install into Postgres | `scripts/import-sqlite.mjs` | — | Tested only for starting and printing its usage, never on a real old file |
| Alerts, health, error log | IMPLEMENTED_AND_TESTED | Alert once, again after six hours; `/api/health` | `src/lib/alerts.ts`, `src/app/api/health/route.ts` | `tests/alerts.test.ts`, `tests/error-log.test.ts` | — |
| Booking integrity check | IMPLEMENTED_AND_TESTED | Daily from the scheduler, and on demand for the platform owner: live bookings without held time or held at another time, cancelled bookings or classes still holding, bookings for an activity their court no longer offers; an alert when any | `src/lib/integrity.ts`, `src/app/api/admin/integrity/route.ts`, `src/lib/scheduler.ts` | `tests/integrity.test.ts`, `tests/concurrency.test.ts` | Looks from yesterday on, 50 of each kind |
| Marketplace benchmark | IMPLEMENTED_UNTESTED | `npm run bench` fills a Postgres database with a multi-tenant marketplace and times search, grids, booking, popularity and the integrity check ([testing](../development/testing.md#marketplace-benchmark)) | `tests/bench/marketplace.bench.ts`, `vitest.bench.config.mts` | — | Run once by hand ([results](../development/testing.md#results)), on one machine; not in CI |
| Site name per install | IMPLEMENTED_AND_TESTED | `SITE_NAME` names the site in the header, titles, phrases, the privacy notice and shared links | `src/lib/site.ts` | `tests/site.test.ts` | — |
| Database layer and migrations | IMPLEMENTED_AND_TESTED | Postgres or PGlite; migrations under a lock | `src/lib/db.ts` | `tests/db.test.ts`, `tests/query-plans.test.ts` | Migration lock not tested directly |
| DigitalOcean kit and CI | IMPLEMENTED_UNTESTED | Droplet set-up, deploy with rollback; CI on both engines | `deploy/digitalocean/setup.sh`, `deploy/digitalocean/deploy.sh`, `.github/workflows/ci.yml` | — | Not run on a real droplet by any test |
| Documentation checks | IMPLEMENTED_AND_TESTED | Links, paths, scripts, variables, routes, this matrix | `tests/docs.test.ts` | `tests/docs.test.ts` | Cannot check behaviour |
