# Pricing, discounts, memberships and passes

Authoritative for how a price is worked out: prices to the minute, peak bands, holidays, last-minute prices, per-player courts, concessions, promo codes, memberships and multi-visit passes.
Status: [feature status](../product/feature-status.md#pricing) and [memberships, passes and credit](../product/feature-status.md#memberships-passes-and-credit).

## Prices to the minute

A booking costs the minutes booked, each part at the rate in force then
(`priceBooking` in `src/lib/pricing.ts`; how it is computed is in the
[booking time model](../architecture/booking-time-model.md#prices-from-minutes)).
At RM20 an hour off-peak and RM30 at peak from 6 PM, 5:30 to 6:30 PM costs
RM10 + RM15 = RM25, and 75 minutes off-peak costs RM25. Sums are worked in
sen or cents as whole numbers and rounded once, half up, per booking.

A venue can change that court by court, sport by sport or for the whole
venue, under *Courts & rates → Booking rules → More* (inherited like the
other [booking rules](booking.md#booking-rules-starts-lengths-buffers)):

- **All at the rate when it starts**, instead of each part at its own.
- **Prices for set lengths**: 90 minutes for RM40, RM55 when it starts at
  peak. Other lengths are priced by the minute.
- **Charge by steps** (40 minutes billed as an hour with steps of 30) or
  **at least** so many minutes; the extra minutes are priced at the rate in
  force then.
- **Charge at least** an amount for the court time.
- **Setup and cleanup fees**: a fixed amount on every booking, shown apart
  from the time on the booking form, the confirmation and the receipt
  (`bookings.fee_amount`). Buffers kept free around a booking are never
  charged on their own; a fee is how a venue charges for setting up.

The booking form shows the server's quote before anything is booked
(`GET /api/quote`): each part and its rate, the minutes billed and any fees.
That is the price charged. Quotes, bookings, weekly bookings, moves,
rescheduling and refunds all price through the same function, so they never
disagree. Member and tier prices, per-player prices and last-minute prices
apply to each part; concessions and promo codes come off the court time,
never the fees.

## Peak hours and holidays

Each court has an off-peak and a peak rate. **Courts & rates → When peak
rates apply** decides which one each minute costs, venue by venue (a
manager's setting; times to the minute):

- **Weekday hours**: the peak window on working days, 6 PM to midnight to
  begin with. The same time twice means no weekday peak.
- **Weekend hours**: the window on weekend days, all day to begin with.
- **Weekend days**: Saturday and Sunday to begin with. In Kedah, Kelantan and
  Terengganu the weekend is Friday and Saturday, so a venue there picks those.
- **Holidays**: dates priced like the weekend: public holidays as they are
  gazetted, school holidays, festive days. Named, listed from today, up to 60
  ahead. *Fill in* adds the public holidays still to come in one go, in
  Malaysia for the venue's state (its own days as well as the national ones;
  or only the days every state keeps), in Singapore with the Monday after a
  holiday on a Sunday. Days already listed keep their names, and any can be
  removed. Nothing is added without the button: holiday dates differ by state,
  Islamic holidays can move a day once the moon is sighted, and some venues
  open at their usual prices on a holiday anyway.

The list (`src/lib/holiday-calendar.ts`) is Singapore's from the Ministry of
Manpower and Malaysia's federal and state schedule from the Prime Minister's
Department: the rest of 2026 and all of 2027. The settings page says how far
it reaches. Each new year's schedule is added there when it is published,
usually in the middle of the year before.

The rules price the booking grid, search results, cheapest-court ordering,
quotes, bookings, weekly series and moves. A change applies from then on: a
booking keeps the price it was made at. The columns are on `venues`
(`peak_weekday_from_min`, `peak_weekday_until_min`, `peak_weekend_days`,
`peak_weekend_from_min`, `peak_weekend_until_min`, minutes of the day), with the dates in
`venue_holidays` (migration 0038); the defaults are the rule every venue had
before.


### Last-minute prices

A venue can fill time that would otherwise go empty (*Courts & rates → When peak
rates apply → Last-minute prices*, migration 0060): court time starting
within 1 to 24 hours of booking costs 5% to 50% less, for whoever books it
then. Off-peak time only unless the venue unticks that, with a warning
that regulars may learn to wait for the lower price on busy evenings. It is
worked out minute by minute: booked 45 minutes before a one-hour booking
with a one-hour window, the minutes starting within the hour (the first 16)
are discounted and the rest are not.

- The grid marks that time (*−20%*) and shows the lower price; the
  booking form says it is a last-minute price for booking now, and that
  the venue's usual cancellation rules apply. Search results show the price
  as it is now.
- It is a price for a booking made now (`priceBooking({ ..., at })`): a booking
  already made keeps what it cost, a booking moved into such time keeps
  the price it was booked at, and later weeks of a weekly series are too far
  ahead to qualify.
- It cannot be had by cancelling and booking again: somebody who cancelled a
  booking at that venue for that day pays the usual price for a new one there
  that day. A booking at a last-minute price is marked (`last_minute`,
  migration 0064) and takes no promo code on top.
- A member's rate is discounted the same way.

## Courts priced per player

Some courts are sold by the head: pickleball at RM8 a player an hour. Under
*Courts → How one booking is priced*, a court booked whole can be priced *per
player*, taking up to 8 players in one booking unless the venue says
otherwise (`priceBooking` in `src/lib/pricing.ts`).

- Its rates are then per player: the grid reads *RM8–10/player/hr*, search
  results say *per player*, and the booking form asks how many play and
  shows *4 × RM16*.
- The booking keeps the number (`bookings.players`): the price, a move to
  another time and its difference, the receipt (*Pickle 1, …, 4 players*) and
  the staff list all follow it.
- A shared facility (a gym floor, a wall, a fleet of kayaks) takes as many
  places as a booking says, up to the most one booking may take (eight
  unless the venue sets more, up to every place it has). By default each place pays the rate; the venue can instead
  make the rate one price for the whole booking, or set quantity prices
  (from four places, each at 90%), which apply to courts priced per player
  too ([activities](activities.md#pricing-a-booking-with-places)). It cannot
  also be priced per player.

## A court offering several activities

A court booked for more than one activity (badminton or pickleball on one
floor) can give each activity its own off-peak and peak rates; one without
its own uses the court's. The price of a booking is worked out at its
activity's rates, under its activity's peak hours and booking rules
([activities](activities.md#one-resource-several-activities)).

## Concession prices

A student, senior, child or OKU price, under *Courts → Concession prices*
(`src/lib/concessions.ts`): a name, a share off (5–100%), what to bring ("your
student card"), and optionally one sport or off-peak hours only.

- **Built-in quick-picks** (*Student*, *Senior (60+)*, *Child (under 12)*,
  *OKU*, each with its proof) are shown to staff in the dashboard's language.
  One saved as it is keeps its key (`concessions.preset`, migration 0122), and
  every customer reads its name and proof in their own language, on the
  booking form, the confirmation, `/my-booking`, the refusal when it is
  off-peak only (the refusal names it by its key, `vars.nameKey`) and the
  receipt (*Harga Pelajar*;
  [regions and tax](../product/regions-and-tax.md#tax-sst-and-gst)); staff screens show it in
  the staff member's language. Once staff change its name or proof it is the
  venue's own text, shown to everybody as typed. The server keeps the key only
  while the name and proof are word for word the preset's in one of the
  dashboard's or the site's languages (`saveConcession`,
  `src/lib/concessions-shared.ts`). A booking keeps the key it was made at,
  beside the name.

- **Booking:** the customer picks it from *Price* on the booking form and gets
  the lower price at once. The form, the confirmation and `/my-booking` say what
  to bring, and that without it the full price is charged at the counter. It is
  one discount: not with a promo code or a last-minute price. Where it does not
  apply (another sport, a peak hour), the booking stands at the full price and
  says why.
- **At the counter:** the booking shows *Student price (RM10 off): check proof*.
  Staff look at the card and press *Proof seen* (and say until when not to ask
  again: next visit, month end, year end or twelve months) or *No proof*. No
  proof on an unpaid booking adds the difference to what is owed; on one already
  paid, the difference is sold at the counter and receipted like any sale.
- **No proof is ever stored.** No photo, no card or IC number: only that this
  number was seen to qualify, by whom, and until when. A card's image would make
  the venue hold sensitive personal data under the PDPA, to check something a
  person can see in two seconds. The record goes out in the customer's data
  export and the venue's phone-number export, and is erased with the account.
- The receipt shows the concession as its own line.

## Promo codes

A venue advertises a code — `RAYA20` for 20% off, `NEWBIE5` for RM5 — and a
customer types it when booking. A code is scoped to one venue, optionally to
one sport, to bookings of at least N hours (which is how a bulk discount is
expressed), to a date range the **booking** must fall in, and to a number of
uses.

The discount comes off `bookings.total_price` itself, inside the transaction
that records the use. That ordering is the point: paying from credit or with a
pass happens afterwards and reads the discounted figure, and the day's takings
are right without any of that code knowing promo codes exist. Claiming a code
is best-effort in the same way as paying — a code that ran out between the
customer typing it and pressing Book leaves the booking standing at full price
with the reason, rather than losing the booking.

Uses are counted as rows in `promo_uses`, one per booking, re-counted **inside**
the claiming transaction so two customers cannot both take the last use of a
limited code. A `UNIQUE (booking_id)` stops two codes stacking on one booking.
Cancelling gives the use back — the customer never had the benefit, so a limited
code should not be poorer for it — through the same `refundBooking()` helper
that returns credit and pass entries, so every cancellation path is covered.

Withdrawing a code stops further claims; discounts already given stand. A
percentage is rounded **down** and no discount ever exceeds the price, so a
total cannot go negative.

## Memberships and member rates

Every court carries an optional **member rate** beside its public one, per
band: `member_off_peak_rate` and `member_peak_rate`. `NULL` means members pay
the public price on that court, so a venue can discount its quiet courts and
not its premium one. A member rate above the public rate is refused — that is
not a member rate.

A **membership** belongs to one venue and is held against a **phone number**,
not an account. That is the point: a member who books as a guest, without
signing in, still gets their price. Terms may not overlap at one venue, since
two live memberships would make "which rate?" ambiguous.

Price is decided per session against **that session's date**, not today's, so a
weekly series is discounted for the weeks the membership covers and charged
publicly for the rest. A membership that has not started yet, has expired, or
was cancelled gives nothing.

A signed-in member sees **their own rates on the availability grid**, with a
banner saying so, rather than a public price they will not pay. Guests see
public rates and still get the member rate applied at booking when their number
matches.

Member rates and promo codes compose: the member rate sets the price, and a
promo code discounts that. A member on a RM10/hr member rate booking two hours
with a 20% code pays RM16.

Cancelling a membership stops future discounts; bookings already made keep the
price they were given.

**A membership is its holder's.** It prices a booking its holder takes part
in. A booking made only for somebody else on the member's number (a parent
booking their child, [booking for somebody else](booking.md#booking-for-somebody-else))
is at the public rate: a membership held against a number never covers a
participant who is not its holder. Where the member takes part alongside
others, the booking is at the member rate as before (a member's court, their
guests on it). Who may book a members-only venue, and how far ahead a member
may book, stay the booker's.

### Joining online

A club that takes payment online can list up to six **membership plans** (a
name, 1–12 months, a fee of at least RM1) under *Credit & passes → Memberships →
Join online*. Adding and retiring plans is a manager's job. The plans show on
the venue page, inside the members-only notice where there is one. A
signed-in customer picks a plan and pays the venue through its own Billplz
account, and the membership is made **when the payment settles**, against the
account's phone number (the checked one, where phone checks are on). It then
works like one sold at the counter: member rates, and booking at a members-only
venue. Staff see it in the list tagged *online*.

- **Joining** starts today and runs the plan's calendar months (31 January plus
  one month ends on the last day of February).
- **Renewing** opens 45 days before the current membership (here, or at any
  branch of the same business) ends, and the new one starts the day after it.
  The dates are worked out when the money comes in, not when the payment page
  was opened.
- **A payment that buys nothing**, such as a second payment for the same months
  or an account deleted while paying, is marked as owed back to the customer,
  the same as a paid booking that was cancelled.
- **A plan retired** while someone was paying still gives them what they paid
  for. Nobody new can start on it.
- **Private venues** do not sell membership online: their access list is the
  only way in, and a fee does not put anyone on it. Free memberships are
  given at the counter.

#### Renewing automatically

Where the venue takes payment through **Stripe**, the customer can tick
*Renew automatically each time, by card*. The payment page then sets up a
Stripe subscription for the plan's price every plan period (a 3-month plan
charges every 3 months), on the venue's own account:

- **The first payment** makes the membership as usual and records the
  subscription (`membership_subscriptions`, migration 0041).
- **Each later charge** arrives as Stripe's `invoice.paid` webhook. It is
  written as an online payment of its own, and makes the next membership, run
  on from the last whatever day the charge lands, with its receipt. Stripe
  sending it twice counts once. The first invoice is not counted again: its
  checkout session already settled it.
- **Stopping**: the member presses *Stop renewing* on the venue page, or the
  venue voids the membership. Either way MySenam cancels the subscription in
  Stripe and nothing more is charged; what was already paid for runs to its
  end. A subscription ended in Stripe (cancelled there, or the card kept
  failing: `customer.subscription.deleted`) stops renewing here too.
- **A charge that buys nothing** (the account was deleted, say) is owed back
  like any other, and the subscription is cancelled.
- The venue's restricted key needs **Subscriptions: Write** as well, and its
  webhook the `invoice.paid` and `customer.subscription.deleted` events.
  Billplz has no subscriptions, so venues on Billplz sell one period at a time.


### Tiers

A plan can be a tier with benefits of its own (`src/lib/membership-plans.ts`),
set under *Credit → Plans and tiers*:

- **Price:** members on it pay a share of the public price (Gold at 70%)
  instead of each court's member rate. The grid shows a signed-in member
  their own price.
- **Booking window:** they book further ahead than other members (Gold 30
  days); the venue's outer window grows to the longest tier's, and everybody
  else stays on theirs, refused with the reason.
- A membership sold at the counter can be put on a plan too, for its
  benefits (`memberships.tier_id`); one bought online is on the plan it was
  bought on. Changing a tier's benefits applies to its members from then on;
  bookings already made keep their price.
- The venue page lists each plan's benefits beside its price.

## Multi-visit passes

A pass is bought up front — the classic "10 sessions" a Malaysian sports
centre sells over the counter. It counts one of two ways, chosen when it is
sold (*Credit & passes → Spends*; `passes.kind`, `passCost` in
`src/lib/pass-rules.ts`):

- **Entries** (a session pass). Each entry covers so many minutes of a
  booking or part of them, an hour unless the venue says otherwise, so with
  an hour a 90-minute booking spends two entries and a 2-hour booking two.
  Left blank, an entry is one booking whatever its length (a gym visit).
  Passes sold before bookings went to the minute count an hour an entry,
  which is what they were sold as.
- **Court time** (a time pass): hours of court time, sold in quarter hours
  and spent to the minute, so a 75-minute booking takes 75 minutes.

Either kind can be limited to bookings of up to so many minutes. The booking
form says what a booking would spend before it is made, and refuses a
booking longer than the pass allows.

Entries and minutes are an append-only ledger (`pass_entries`), the same shape as the credit
wallet: `remaining = entries + SUM(delta)`, spends negative and refunds
positive. Nothing ever rewrites a running total, so the history is the balance.

A pass pays for a booking only when every one of these holds, and the entry
count is re-read **inside** the paying transaction so two concurrent bookings
cannot spend the same entry:

- the pass is active, in date (`expires_on` is inclusive) and has entries left;
- the booking is at the pass's venue, and for its sport if it names one;
- the booking's phone number matches the holder's. Malaysian numbers are
  compared on digits with the country code folded away, so `+60 12-345 6789`
  and `012-345 6789` are the same person. The holder spends it on bookings
  they make, as they would credit: on a booking for their child, the holder
  pays with it. An entry pays for the booking, not for each person on it;
- the booking is no longer than the pass allows, and enough remains for the
  whole of it. A pass pays in full or not at all — there is no part-paying a
  booking and owing the rest.

Payment is best-effort, like paying from credit: a pass that cannot cover the
booking leaves it standing as **unpaid** with the reason, rather than throwing
the booking away. Cancelling a pass-paid booking returns its entries through
every cancellation path — by code, from an account, a whole series, an admin
cancellation, and the enrolments released when a class is cancelled — and
refunding twice is refused, so a double cancellation cannot mint entries. An
expired pass is still credited: the ledger stays honest even when the entries
can no longer be spent.

Voiding a pass stops further spending but leaves spent entries spent; it is not
a refund. Customers see their passes with a used/remaining meter on `/account`,
and staff sell and cancel them from the *Credit & passes* tab.
