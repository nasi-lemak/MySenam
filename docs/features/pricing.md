# Pricing, discounts, memberships and passes

Authoritative for how a price is worked out: prices to the minute, peak bands, holidays, last-minute prices, per-player courts, concessions, promo codes, discounts together, memberships and multi-visit passes.
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

## Prices from a date

A price rise from 1 January is set ahead, under *Courts & rates → Rates and a
court's own hours from a date*: a court, a date after today, and its off-peak,
peak and member rates from then, with each of its other activities' own rates
(blank: the court's), as a whole (`court_changes`, migration 0253;
`src/lib/dated-changes.ts`;
[ADR 0027](../architecture/decisions/0027-hours-and-rates-from-a-date.md)).
The rates table above it changes them from today, as before.

- **The date booked decides.** `priceBooking` prices each date at the rates
  set for it: the latest set from that date or an earlier one, else today's.
  So the quote, the booking board and its rates, the booking form, the
  counter, search and its cheapest-court order, the venue's API and a weekly
  series (week by week) all show the price of the date asked about.
- **A booking already made keeps the price it was sold at**: nothing is
  recalculated when rates are set, changed, withdrawn or come into force. A
  move prices each date at its own rates, as it always priced the two times.
- **Waiting to apply**: each set is listed under the form, and can be changed
  or withdrawn until its date. When its date comes it applies by that rule
  alone; the next time staff open or change the court's rates it becomes the
  court's rates in the table.
- Managers only; each set, change and withdrawal is in the activity log, the
  rates before and after with the date (`rates.scheduled`, `rates.withdrawn`).
- Only the rates are set from a date. Peak windows, holidays, a policy's
  prices for set lengths, minimums and fees, concessions and membership or
  tier prices change from the moment they are saved.

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
  already made keeps what it cost, and later weeks of a weekly series are too far
  ahead to qualify. It is an entitlement fixed when the booking was made (the
  booking carries the mark `last_minute`) and tied to the time: a booking moved to
  another time is priced as it was made, minute by minute, so the minutes that
  still start within the window from when it was made keep the discount and the
  rest do not; a booking that never had it never earns it by moving into the
  window (a change of price is shown before it is confirmed,
  [changing the date or time](booking.md#changing-the-date-or-time), ADR 0067,
  DEC-60).
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

## A price per game

Where a resource is sold by the game ([booking](booking.md#by-the-game-and-a-lane-given-on-arrival)),
its booking rules give the price of a game, and of a game at peak where it
differs (*Courts & rates → Booking rules → Sold by the game*). A booking
costs that times its games, and times its players on a lane priced per
player: four bowlers, two games at RM12 a game, RM96. It is priced as a
fixed price for a length is (`priceBooking` in `src/lib/pricing.ts`, a
`games` line): at peak by when it starts, a tier's share of the price where
the member's tier has one, a last-minute price where one applies, quantity
prices and the minimum charge as for any booking; setup and cleanup fees
apart. With no price for a game set, a game booking costs the time it holds
at the lane's rates, as a booking by time would. Concessions, promo codes,
passes, credit, deposits and refunds work on that price as on any other.
Games added at the desk ([playing on](booking.md#by-the-game-and-a-lane-given-on-arrival))
are priced the same way on the day, without the discounts already on the
booking.

## A court offering several activities

A court booked for more than one activity (badminton or pickleball on one
floor) can give each activity its own off-peak and peak rates; one without
its own uses the court's. The price of a booking is worked out at its
activity's rates, under its activity's peak hours and booking rules
([activities](activities.md#one-resource-several-activities)).

## What a benefit applies to

A pass, a concession and a membership plan's price each say what one use of
them covers (`lib/entitlements.ts`;
[ADR 0025](../architecture/decisions/0025-benefits-and-privileges-by-scope.md)),
chosen by staff when it is set up:

| Covers | What one use pays or takes off | For example |
| ------ | ------------------------------ | ----------- |
| **The whole booking** (`booking`) | The reservation, whoever is on it | A court pass, a promotion, a venue's voucher, a member reserving a court |
| **A resource hired whole** (`resource`, passes) | The resource's time, never places sold one by one | Ten hours of the hall |
| **One person's place** (`participant`) | That person's place alone | A child's swim pass, one child's concession, a coaching pack for one person, a child's own membership |
| **Each place** (`places`, passes) | Every place the booking takes, each one using it | A family pass spent per person |

What it is good for stays said apart, as before: one sport, a lesson pack's
coach. Promo codes and gift vouchers are always for the whole booking.
Everything sold before this was set up is for the whole booking, and does
exactly what it did.

- **One person's place** has a price only where the booking is priced by
  the place: places on a shared facility, players on a court priced per
  player. Its share is the booking's court time as charged, split between
  its places in whole sen (fees, a coach's fee and extras stay with the
  booking; a booking-wide code is shared between the places as
  [discounts together](#discounts-together) says). A guardian booking
  three children on a pool at RM10 a place, one of them on a 50% child's
  price, pays RM25. On a court hired whole nothing is priced per person:
  one person's concession does not apply there, and the booking says why.
- **Each redemption is kept per place** (`place_benefits`, and a pass's
  spends name their place) and is made once: a second concession for one
  place, a second spend for one place, or one spend given back twice is
  refused by the database, however many requests arrive at once and from
  wherever (the booking form, the counter, the venue's API key, a group of
  courts).
- **On the booking form** a concession for one person asks whose it is,
  among those taking part, and a pass is chosen for the whole booking or one
  for each person ([several passes](#several-passes-for-one-booking)).
  Through the API, `placeConcessions` names each person's own, and
  `payWithPasses` pays with each one's own pass
  ([HTTP API](../architecture/http-api.md)).

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
  not with a last-minute price, and with a promo code only where the venue and
  the code allow it ([discounts together](#discounts-together)). Where it does
  not apply (another sport, a peak hour), the booking stands at the full price
  and says why.
- **For the whole booking, or one person's place.** Staff say which under
  *Applies to* ([what a benefit applies to](#what-a-benefit-applies-to)).
  One for one person's place comes off that person's share alone, on a
  booking priced by the place; several people on one booking may each have
  their own. Its proof is that person's: staff check it person by person
  (*Student price for Alya: check their proof*), a proof seen is remembered
  for that participant for as long as staff say, as below
  (`participant_concession_proofs`), and no proof
  charges that place alone in full. The receipt names whose price it was.
- **At the counter:** the booking shows *Student price (RM10 off): check proof*.
  Staff look at the card and press *Proof seen* (and say until when not to ask
  again: next visit, month end, year end or twelve months) or *No proof*. No
  proof on an unpaid booking adds the difference to what is owed; on one already
  paid, the difference is sold at the counter and receipted like any sale. The
  outcome is decided **once**, under the booking's row lock
  ([ADR 0062](../architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md)):
  a double click, a second desk or a retry is refused (*The full price is
  already charged on this one*) and charges nothing more, and a proof marked
  *Seen* stays seen: a later *No proof* is refused (a manager corrects it by
  hand), so a click cannot silently turn a seen proof into a charge. Both for
  the whole booking and for one person's place
  (`tests/concession-check-once.test.ts`).
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
with the reason, rather than losing the booking — except where the request
settles at once (credit, a pass, the counter, an account), when it is a
refusal and nothing is booked or charged (`DISCOUNT_NOT_APPLIED`), and where
the request carries `expectedTotal`
([nothing is charged at a price the customer did not accept](payments-and-credit.md#stored-credit)).

Uses are counted as rows in `promo_uses`, one per booking, re-counted **inside**
the claiming transaction so two customers cannot both take the last use of a
limited code; each use also counts itself on the code's own row
(`promo_codes.used_count`, migration 0165), where the database refuses one past
the limit whichever path claims it (`STK_USED_UP`). A `UNIQUE (booking_id)`
stops two codes stacking on one booking. Whether a code goes with a concession
price is said when it is made (*Goes with a concession price*,
`promo_codes.combinable`; off unless ticked), and counts only where the venue
allows discounts together ([below](#discounts-together)).
Cancelling gives the use back — the customer never had the benefit, so a limited
code should not be poorer for it — through the same `refundBooking()` helper
that returns credit and pass entries, so every cancellation path is covered.

Withdrawing a code stops further claims; discounts already given stand. A
percentage is rounded **down** to the sen (15% of RM10.05 is RM1.50) and no
discount ever exceeds the price, so a total cannot go negative.

### Checked before booking

The booking form checks a code as it is typed, with the price
(`GET /api/quote?…&promoCode=`, `quotePromo` in `src/lib/store.ts`): valid,
it says what the code takes off and the total on *Book* includes it, by the
same arithmetic the booking uses (`promoDiscount`, `src/lib/promo-math.ts`,
after the concession chosen where the venue and the code allow both);
refused, it says why (not valid here, not started or run out, not this sport,
too short a booking, used up) and *Book* waits until the code is put right or
cleared, so nobody is booked at full price by surprise. A code that does not
go with the concession chosen is refused there as the booking would refuse it.
The check is advisory: the booking checks the code again with its use limits
(one customer's uses, the last use), and a code that runs out in between
still leaves the booking at full price with the reason, as above. A weekly
series is checked on its first date.

## Discounts together

Which benefits are discounts, which go together, and the one order every path
prices by (`src/lib/discounts.ts`;
[ADR 0025](../architecture/decisions/0025-benefits-and-privileges-by-scope.md)).

| What | Is | Goes with a discount? |
| ---- | -- | --------------------- |
| The public rate, a member's or tier's rate (for the booking or a member's own place) | A price | Always: it is what the time costs |
| A last-minute price | A price for booking now | No: it takes no concession and no code |
| A concession (the booking's, or one person's place's) | A discount | With a code only where the venue and the code allow it; never a second concession on one place |
| A promo code | A discount | As above |
| Stored credit, a gift voucher (it becomes credit), a pass, a payment | A means of paying | Applied after the price; changes no price |

**The rule.** Each venue says, under *Credit & passes → Promo codes → A
concession price and a code together* (a manager's setting,
`venues.discount_stacking`): **never**, one discount at a time (the
default, and every venue before), or **where the code allows it**. Each code
says whether it goes with a concession price (off unless ticked). A
concession and a code go together only where both say yes; otherwise the one
asked for second is refused, the booking standing at the first, and it is
refused the same way on every path: the booking form (which then takes the
code's field away and says why), the counter (staff book through the same
form and route), the venue's API key (`POST /api/v1/bookings`), several
courts at once and lessons. The refusal's
code is `ONE_DISCOUNT` where the venue gives one discount at a time and
`STK_NOT_COMBINABLE` where the code does not combine; each route returns it as
`promoErrorCode` beside `promoError`. A class enrolment takes neither.

**The same request, the same price.** The form, the counter and the venue's
API key put the discounts asked for on through one function
(`applyAskedDiscounts`, `src/lib/booking-discounts.ts`), with the same
fields: `concessionId` (the booking's concession), `placeConcessions` (one
person's own, `[{ participantId, concessionId }]`, `null` for the
customer's place) and `promoCode`. So the stacking rule, the order, the
rounding, each place's share of a code, a code's limits (its last use, one
customer's uses) and the refusals are the same whichever path booked it. A
concession is taken on the word of whoever booked, the customer online or
the venue at its counter or through its system, and proof is looked at when
the person arrives (*Concession prices*, above), as for any concession.
Each is best-effort: a discount refused leaves the booking at the price
before it, with `concessionError` or `promoError` saying why.

**The order**, in whole sen:

1. Each place's share of the court time at the public price: the court time
   split evenly between the places, the earlier places taking the odd sen
   (RM10.00 in three is RM3.34, RM3.33, RM3.33).
2. Its member price, where the place is a member's.
3. Its concession: that share of what the place costs then, rounded half up;
   a booking's own concession comes off the whole court time.
4. The code, worked out on the court time after all of those: a percentage
   rounded down, a fixed amount never more than the court time. On a booking
   sold by the place it is shared between the places in proportion to what
   each costs by then, by largest remainder (the earlier place first on a
   tie), and each named place's share is recorded (`promo_place_shares`).
5. Tax, which is inside the price ([regions and tax](../product/regions-and-tax.md#tax-sst-and-gst)).
6. The means of paying: credit, a pass, a payment.

A manager's [price adjustment](#a-managers-price-adjustment) comes after all
of these, as a difference of its own, and no discount is added after it.

Fees, a coach's fee and extras are never discounted, and no price goes below
nothing. Three children at RM10 a place, one on a 50% child's price, with a
10% code the venue allows with it: RM30, less RM5 for the child, is RM25; 10%
of that is RM2.50, shared RM1, RM1 and RM0.50; RM22.50 to pay. The receipt
shows each discount as its own line, the concessions and member prices first,
then the code, adding up to what is owed.

**Whatever came first.** A concession added after the code (by the library;
the form and the API always put the concession on first), or refused at the
counter for no proof, works the code out again on the new price, so the result
is the same either way.

**Afterwards.** Taking one person off a booking takes exactly their place's
share: its member price, its concession and its recorded share of the code
([taking one person off a booking](booking.md#taking-one-person-off-a-booking));
places nobody is named on share what is left of the code evenly. A move keeps
the discounts as they were given (their amounts), repricing only the court
time. A cancellation gives the code's use back, with its shares. A booking
made before shares were recorded keeps every stored amount; its code is shared
evenly between its places, as it was.

**Decided, and kept** (confirmed 27 October 2026 against the owner's rule
that history is not recalculated):

- **A last-minute price takes no other discount**, on every path (the form,
  the counter, the venue's API key): it is already the venue's discount for
  time nobody wanted, so a concession is refused (`ONE_DISCOUNT`) and a code
  too (`PROMO_NOT_LAST_MINUTE`). A member's rate is not a discount and is
  discounted the same way ([last-minute prices](#last-minute-prices)).
- **A move keeps what was charged.** The concession and the code stay at
  the amounts they took off when given, and are not worked out again on the
  new time's price; the court time follows the existing price-difference
  rule ([changing the date or time](booking.md#changing-the-date-or-time)): an unpaid booking
  changes by the difference between what the court time cost when booked
  and what it costs at the new time (RM20 less a RM4 concession and a RM2
  code is RM14; moved to a RM30 court it is RM24), **but never to nothing**:
  where the amounts kept would take the price to zero, it is the share of the
  new court time the booking was paying (RM60 with RM30 off moved to an RM20
  hour is RM10, not RM0; ADR 0067, audit D3). A paid one is not charged more: a
  customer cannot move it somewhere dearer and staff choosing not to charge the
  difference; moved cheaper, what it was paid above the new price goes back the
  way it was paid ([a paid booking moved to a cheaper time](payments-and-credit.md#a-paid-booking-moved-to-a-cheaper-time)).
  A last-minute price stays with its time, as above, and a move never earns one. A booking keeps its
  last-minute mark when moved; no discount can be added after booking on any
  path, so it decides nothing more. Whether a percentage should always be worked
  out again on the new time is the owner's open question (DEC-33).

## Memberships and member rates

Every court carries an optional **member rate** beside its public one, per
band: `member_off_peak_rate` and `member_peak_rate`. `NULL` means members pay
the public price on that court, so a venue can discount its quiet courts and
not its premium one. A member rate above the public rate is refused — that is
not a member rate.

A **membership** belongs to one venue and is held against a **phone number**,
not an account. That is the point: a member who books as a guest, without
signing in, still gets their price. Terms may not overlap at one venue, since
two live memberships would make "which rate?" ambiguous. **Giving days back**
(*Give days back*, up to 90 at once, a manager's) holds to the same rule: it is
refused where the days would run into the holder's next term (or one holding or
covering somebody this one covers), the same rule a suspension's extension
already keeps, saying how many days fit (`FX8_EXTEND_INTO_NEXT`; none fit where
the next term starts the day after: `FX8_EXTEND_NEXT_FOLLOWS`), and nothing is
changed. Two live terms for the same days are never left
([ADR 0062](../architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md);
`tests/membership-extension-and-renewing-suspension.test.ts`).

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
price they were given. Those at a members-only venue it no longer covers are
flagged for staff, never cancelled ([when a membership stops](#when-a-membership-stops)).

**A membership is its holder's**, and of the people it names
([ADR 0025](../architecture/decisions/0025-benefits-and-privileges-by-scope.md)):

- **Whose.** The number's holder's own, as every membership sold before; or
  a participant's own, sold at the counter on their guardian's number (a
  child's swim-club membership; *Whose membership* under *Credit & passes →
  Memberships*) or bought online by an account that is their active
  guardian ([for somebody you look after](#for-somebody-you-look-after-or-a-family)).
  A participant's membership is theirs alone: it never gives
  the number's holder a member's price, window or entry.
- **Whom else.** A family membership names the dependants it covers (*A
  family membership also covers*), each a participant the venue knows with a
  guardian on the holder's number at the counter, or one the buying account
  is an active guardian of online. Nothing is inferred from a shared number
  or surname, and the holder's own membership covers nobody it does not name.
- **Nobody covered twice, at the counter as online.** A participant who
  already holds, or is covered by, a membership for any of the same days
  (here, or at a branch of the same business) is refused, whether the new one
  would be their own or a family membership naming them: *Alya is already a
  member here until 2027-01-01*, the reason buying online gives
  (`coveredUntil` in `src/lib/membership-purchases.ts`, asked by
  `sellMembership`). There is no override: an overlap would make which
  membership prices a place ambiguous. Staff sell the new one from the day
  after the old one ends, or cancel the old one first.
- **What its price covers**, the plan's (*and the price covers*, under *Plans
  and tiers*): the whole booking its member takes part in (as every plan
  before: a member reserving a court pays the member's price whoever else
  plays), or the members' own places only, on a session priced by the place
  (two places at RM10, the member's at their plan's 50%: RM15). A membership
  on no plan is for the whole booking. On a court hired whole, a price for
  members' own places applies only where the member is the only one on it.
- A booking made only for people who are not members (a parent booking a
  child the membership does not name,
  [booking for somebody else](booking.md#booking-for-somebody-else)) is at
  the public rate, whoever's number it is on. The quote says the same as the
  booking, for the people named on it.

Who may book a members-only venue, and how far ahead a member may book, are
the account's: a member books a court for their children further ahead. A
place on a members' session is each person's own to hold
([who a venue is for](booking.md#who-a-venue-is-for-public-members-only-private)).

### Membership validity

Two things a membership gives are kept apart, and each is checked at its own
time on every path: online, the counter, the venue's API key, a group of
courts, a waiting list (joining, the offer and its claim), a class, a move,
check-in and the door (the owner's decision of 27 October 2026;
`src/lib/entitlements.ts`).

| | Whose | Checked | For example |
| - | ----- | ------- | ----------- |
| **Booking privileges** | The account's (its own membership, on a number it has proved or is linked to online) | When the booking is made, and again when it is moved (a move books the new day): by the venue's rules (`windowFor`, `aheadFor`, `houseRuleRefusal` in `src/lib/house-rules.ts`) | Members book further ahead; a member reserves a court at a members-only venue |
| **Participation** | The person taking the place: their own membership, or a family one naming them; the customer's own place, theirs (or a place on the venue's list) | For **the session's date**, never today's answer: when booked, offered, claimed or moved (`membersOnlyRefusal`), and again before they take part (`participationLapses`) | A members-only swim session; a class at a members-only club |

- **A membership ending before the session does not cover it**, however
  live it is today. Booking is refused with why and when: *Aina's membership
  here ends on 15 Nov, before the session on 27 Nov. Renew it, then book*
  (`MV6_ENDS_BEFORE`; the customer's own place: `MV6_OWN_ENDS_BEFORE`, or
  `MV6_OWN_NOT_MEMBER` with no membership at all; `ENT_MEMBERS_PLACE` for a
  participant with none). The booking form says the same before booking,
  person by person, from the quote (`members` on `/api/quote`,
  `src/components/MembershipEligibility.tsx`), with **where to renew**: the
  venue's plans on its page (`/venue/:id#membership`) where it sells a
  membership online for that person, else *ask the venue to renew it at the
  counter*. Following that link closes the booking form, so on a phone its
  sheet does not cover the plans it leads to
  (`tests/components/booking-dialogs.test.tsx`). A renewal starting the day after the old one ends covers the
  session, and the booking goes through. The venue page tells a member until
  when their membership runs.
- **A booking privilege is not taken back.** A booking made inside the
  members' window stands when the membership later ends or is cancelled;
  moving it asks the window again for the new day. A move by the customer
  counts a member's number only where the account that made the booking has
  proved it or is linked to the membership, as booking online does; the
  number typed on the booking alone gives no member's window.
- **Waiting lists**: nobody joins for a members' place they could not take on
  its date; a place freed is not offered to an entry whose membership no
  longer covers the date (it keeps its place in the queue, to renew), and a
  claim made after it lapsed is refused with the reason, the entry back to
  waiting and the place to the next.
- **A manager going past the rules** may still book somebody a membership does
  not cover, recorded as an override; such a booking is met by staff at the
  desk, never let in unattended (below).

#### Before taking part

Check-in and the door ask again, for the session's date, about everybody
taking a place on a members' session (`participationLapses`): a membership
cancelled, voided by a chargeback, ended or
[suspended](#suspending-a-membership) for that day since it was booked, or a
dependant taken off a family membership.

- **Self check-in from the QR code** is refused with the reason (*… was
  cancelled. Check in at the desk: staff will decide*; `MV6_CHECKIN_ENDED`,
  `MV6_CHECKIN_CANCELLED`, `MV6_CHECKIN_NONE`, `MS7_CHECKIN_SUSPENDED`).
- **The door code** is not given, with the reason (`reason: "membership"`,
  `MV6_DOOR_*`, `MS7_DOOR_SUSPENDED`), so nobody is let in unattended
  ([doors](venue-operations.md#resources-nobody-is-standing-next-to)).
- **At the desk** staff see a clear warning naming each person and why
  (`MV6_DESK_WARNING`, with `warnings`), and decide. Admitting them anyway is
  their decision, with a note: kept on the booking (`membership_admissions`,
  migration 0196: who, why, what they were warned of) and in the activity
  log (`checkin.membership_admitted`). The same holds when one person on a
  booking is marked arrived.
- A court reserved whole is a booking privilege: not asked again here.

#### When a membership stops

A paid booking is never cancelled or taken silently. When a membership is
**cancelled** by staff (*Void*), **voided by a chargeback** (revoked),
**suspended** for some days ([below](#suspending-a-membership)), or a
dependant is **taken off** a family membership, the confirmed bookings from
today on at a members-only venue of its business that it no longer covers
are **flagged for staff** (`membership_booking_flags`, migration 0195;
`src/lib/membership-flags.ts`), in the same pattern as a revoked approval's
([ADR 0020](../architecture/decisions/0020-approval-to-booking-payment-and-authority.md)):
each place its holder or a person it covered takes on a members' session,
and each resource the holder reserved whole there (flagged so staff know; it
was a privilege when booked, and is not barred). Somebody still covered on
the day by another membership or the venue's list is not flagged.

Staff see them under *Bookings* (*Bookings to decide: a membership no longer
covers them*, `GET /api/admin/memberships/flags`) and deal with each: cancel
it the ordinary way (the venue's cancellation terms and refund policy apply
then, and only then), admit them at the desk, or keep it, and say which
(`POST`, a note required; in the activity log). A flag says why: cancelled,
voided on a chargeback, taken off a family membership, or *membership
suspended*.

#### Suspending a membership

A manager can suspend a membership for a period and reactivate it (the
owner's decision of 28 October 2026; `src/lib/membership-suspensions.ts`),
under *Credit & passes → Memberships → Suspend or reactivate* on the
membership. The desk reads its history but cannot suspend or reactivate,
like voiding it or giving days back: both take away or give back what was
paid for. Another venue's staff cannot see or change it.

- **What is asked.** A reason, the first day (today or later, and on or
  before the day it ends), and the last day, or none: suspended until it is
  reactivated. Two suspensions of one membership may not overlap
  (`MS7_OVERLAP`, `MS7_OVERLAP_OPEN`); one starting the day after another
  ends is fine.
- **History is kept, never overwritten.** Each suspension is a record of its
  own (`membership_suspensions`, migration 0216): its dates, who suspended
  it, when and why, and who reactivated it, when and why. Staff see them on
  the membership with its status (*Suspended from … until …*); the holder's
  account page shows a suspension now or ahead with its dates; the
  account's data export lists each one, its reasons included. Each person it
  covers has the suspension and reactivation in their own history. In the
  activity log: *Suspended a membership* (`membership.suspended`),
  *Reactivated a membership* (`membership.reactivated`).
- **The whole membership, everybody together.** On a date inside a
  suspension the membership covers nobody: its holder, the participant
  whose own it is, and every dependant a family membership names lose cover
  together; nobody is split off it, and nobody's cover moves elsewhere. A
  place on the venue's list is not a membership and is not suspended.
- **Judged on the date.** Everything a membership gives is asked for the
  date it is for (`activeMembership`, `participantMembership` in
  `src/lib/store.ts` leave a suspended membership out on its dates): the
  member's price for a session inside it is the public one; a members' place
  inside it is refused with why (*… membership here is suspended on 5 Nov.
  Ask the venue*; `MS7_SUSPENDED`, `MS7_OWN_SUSPENDED`), and the booking form
  says so before booking (`lapse.kind` `suspended`, with its dates). A
  session outside it is as before. The members' booking window and reserving
  a court at a members-only venue are booking privileges, asked when the
  booking is made, so a member suspended today has neither, and one booking
  today for a day inside a suspension that has not started yet keeps the
  window and the reservation (it was a privilege when booked; the booking
  is flagged). A member suspended today is told so when a members-only
  venue refuses her, whatever the date she asks for (*… your membership here
  is suspended on* today; `MS7_OWN_SUSPENDED`), never asked to join it.
- **Again at check-in and the door, on the day**: self check-in and the door
  code refuse a place on a members' session inside a suspension
  (`MS7_CHECKIN_SUSPENDED`, `MS7_DOOR_SUSPENDED`); the desk is warned
  (*… membership is suspended on …*) and decides, admitting them on the
  record (`membership_admissions` keeps `suspended`, migration 0217), as
  [before taking part](#before-taking-part).
- **Bookings already made are never cancelled or refunded.** Confirmed
  bookings for dates inside the suspension at a members-only venue of its
  business are flagged for staff with the reason *membership suspended*
  (`membership_booking_flags.suspension_id`, migration 0217), as
  [when a membership stops](#when-a-membership-stops): each place its
  people take on a members' session, and each resource its holder reserved
  whole. Staff cancel one on the venue's terms, admit them, or keep it. A
  booking at an ordinary (public) venue made at a member's price keeps the
  price it was given and is not flagged, as for a cancelled membership.
- **A booking made at the same moment** as the suspension: the booking asks
  about memberships again in its own transaction, and the suspension flags
  bookings in its, so one made before the suspension is saved is flagged and
  one after is refused (or priced publicly at an ordinary venue); never
  neither (`tests/membership-suspensions.test.ts`, Postgres and PGlite).
- **Reactivating.** A manager lifts it with a reason, from today: the
  membership covers again from today, and a suspension that had not begun
  covers no day at all. A dated suspension also ends by itself after its
  last day. Reactivating clears nothing: the records stay, and the bookings
  it flagged stay for staff to decide, since flags are not resolved by
  themselves on a renewal either.
- **Its end does not move**, unless its plan says so: *a suspension extends
  the end*, under *Plans and tiers* (`membership_plans.extend_on_suspension`,
  migration 0218; off unless a manager turns it on). On, the days the
  suspension takes out of the term are added to the end once its last day is
  known: when it is suspended with a last day, or when an open-ended one is
  reactivated. A dated one reactivated early has its extension corrected to
  the days it actually took; it is never added twice. The days are recorded
  on the suspension and in the activity log. Where a later term of the same
  holder (or a membership of somebody it covers) already starts after the
  end, the end is not moved into it, and staff are told why. A membership on
  no plan (sold at the counter without one) is not extended; *Give days
  back* is still there.
- **Renewing.** A renewal is not skipped: a subscription is still charged on
  its date and the next term made, running on from the current end (later,
  where the plan extended it). A suspension still in force when a later term
  of the same holder starts (renewed by itself, bought again online, or sold
  at the counter) is carried on to it from its first day to the same end,
  so a renewal never lifts a suspension silently; reactivating either lifts
  both. The carried one is in the activity log, by *MySenam*. Nothing pauses
  a subscription's charges: no plan says it may.
  **An open-ended suspension of a membership that renews by itself** (a
  subscription still charging for it) always extends its end by the days it
  took, whatever its plan says
  ([ADR 0062](../architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md)):
  the gateway keeps charging while it is suspended and nothing here can hold a
  charge, so the member is given those days back when it is lifted, not charged
  for nothing. When renewals were charged meanwhile, the days of every term the
  suspension ran through are added to the last term's end (the earlier terms
  keep theirs, their suspensions noting *Carried to MB-…*), so no term is
  charged for and not given. Nothing moves while it is open (its last day is
  not known); lifted early, the extension is corrected as for a plan that
  extends. A dated suspension, and one of a membership that does not renew by
  itself, still follow the plan's setting. Pausing collection in the gateway
  is not done from here
  ([known limitations](../roadmap/known-limitations.md)).
- **The holder is told** by email, through the outbox, in the language their
  account last used: when it is suspended (the dates, whether its end moves,
  that bookings already made are not cancelled, and the venue's reason) and
  when it is reactivated. The holder is the account that holds the
  membership or bought it (a family membership's holder; a child's own
  membership's guardian who bought it). Nobody it covers is written to, nor
  an account that said it is under 18; one sold at the counter with no
  account is the venue's to tell. Ending by itself on its last day sends
  nothing more: the first email gave the date.
- **Erasure**: closing the holder's account clears the suspensions' reasons
  with their name; the dates stay with the membership's money.

### Joining online

A club that takes payment online can list up to six **membership plans** (a
name, 1–12 months, a fee of at least RM1) under *Credit & passes → Memberships →
Join online*. Adding and retiring plans is a manager's job. The plans show on
the venue page, inside the members-only notice where there is one. A
signed-in customer picks a plan, for themself or, where the plan is sold
for them, for somebody they look after or their family
([below](#for-somebody-you-look-after-or-a-family)), and pays the venue
through its own gateway account; the membership is made **when the payment
settles**, against the account's phone number (the checked one, where phone
checks are on). It then
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
- **Price and dates first.** Choosing a plan shows its price, whom it is for
  and the dates it would run (`POST /api/my/membership/quote`) before any
  payment page opens; *Pay* then opens it.
- **Never a member unpaid.** Until the gateway settles the payment, the
  purchase waits (`membership_purchases`, migration 0168, *pending*) and
  nobody is a member. It holds the people it names for an hour: opening the
  same purchase again goes back to the same payment page, and another
  purchase naming any of them is refused until the first is paid, fails or
  lapses. A payment that fails or expires (Stripe's
  `checkout.session.expired` or `async_payment_failed`, or a return saying
  it was not paid) *releases* it; so does the hour running out, on the
  scheduler's tick. How the hour fits each gateway's payment page, and what
  happens to money that arrives after it, is in
  [a membership paid online](payments-and-credit.md#a-membership-paid-online):
  in short, a Stripe page closes when the hold does, and a Billplz page,
  which cannot be closed, can still be paid after it, when the membership is
  made if it still can be and the money is owed back otherwise. The
  gateway's callback and the customer's return, each repeated, make one
  membership. Plans have no cap on how many members they take, so a hold
  reserves nothing scarce: it only stops a second purchase naming the same
  people.

#### For somebody you look after, or a family

Each plan says whom customers can buy it for online (*sold online for*,
under *Plans and tiers*; `membership_plans.offered_for`, migration 0167;
`src/lib/membership-purchases.ts`):

| Sold online for | Who it is bought for | Whose membership it makes |
| --------------- | -------------------- | ------------------------- |
| **The account holder** (every plan before; the default) | The signed-in customer | Theirs, on their number, as above |
| **Somebody they look after** (a junior plan) | One participant the account is an active guardian of | The participant's own (`holder_participant_id`), on the guardian's number |
| **Either, one person** | The customer, or one participant as above | Theirs, or the participant's |
| **A family**, up to a limit (1–12) | The customer and the dependants they name, at least one and no more than the plan's limit | The customer's, naming the dependants it covers (`membership_participants`) |

- **Only people the account acts for now**: an active relationship
  ([people an adult manages](booking.md#booking-for-somebody-else)), not
  paused for a review, archived or revoked. Somebody whose guardian request
  is still waiting is nobody's dependant yet. The child needs no account of
  their own. Refused with the reason otherwise, and nothing is held.
- **Ages and categories** are as the guardian declared them; plans have no
  age or category rule of their own, so none is checked here.
- **Nobody covered twice**: a person who already holds, or is covered by, a
  membership for any of the same days (here, or at a branch of the same
  business) is refused, with the day it ends. A participant's own membership
  renews like the customer's: from 45 days before it ends, starting the day
  after.
- **Checked again when the money comes in**: an account that has stopped
  acting for somebody it named by then gets nothing for that payment, which
  is owed back.
- **The receipt names whom it is for**: *Membership MB-… for Alya, …* or,
  for a family, the holder and each dependant. So does the page the customer
  comes back to from the gateway: *Alya is a member* for a participant's own
  membership (*You're a member* for the buyer's own), and *It covers Alya,
  Badrul too* for those a family membership covers, in the customer's
  language (`src/app/payments/return/page.tsx`). The child's history records
  who bought it (*membership.bought*). Staff see these memberships in the list
  exactly as counter-sold ones, tagged *online*, with whose they are and
  whom they cover; they count for member prices and members-only places
  per person as above. The account's data export lists each membership with
  whom it is for and covers, and each purchase as chosen and what became of
  it.
- **Changing whom a family membership covers** is limited by the plan's
  policy ([below](#changing-whom-a-family-membership-covers)). Somebody taken
  off is no longer a member through it from then on; bookings already made
  keep their price, and their places on members' sessions it no longer covers
  are flagged for staff ([when a membership stops](#when-a-membership-stops)).
- **Cancelling** is as for any membership: the customer can stop it renewing;
  a manager cancels it (*Void*), which also stops its renewal. Voiding is not
  a refund: the sale stays sold, with no credit note. For one bought online
  the manager is asked whether the money goes back too: if so, its receipt is
  credited and what its payment took is owed back in the same change, in full
  (nothing is prorated), and refunded from *Refunds owed*
  ([refunds](payments-and-credit.md#paying-online)); if not, nothing is owed
  back and nothing credited (`tests/void-credit-notes.test.ts`).

#### Changing whom a family membership covers

Dependants are not freely swappable (the owner's decision of 27 October
2026; `src/lib/membership-purchases.ts`). Each family membership is one
**term**, and a term has a number of **places** for the people it covers:
the plan's limit, plus the plan's **replacements per term** (*put on in
place of others per term*, under *Plans and tiers*; `cover_swaps`,
migration 0191: none unless the venue sets it, at most 12). The limit and
replacements are kept with the membership as it was sold (`cover_limit`,
`cover_swaps`), so a plan changed later does not change a term already paid
for; a membership sold before this has the plan's limit and no
replacements.

| Change | Who | When | Money |
| ------ | --- | ---- | ----- |
| **Adding** somebody the account looks after, within the limit | The account that bought it, on the venue page (`PATCH /api/my/membership`) | At once, while the term has places left | None: a family plan's price is the same however many it covers |
| **Removing** somebody | The same account | At once | Nothing back; the place they used stays used |
| **Replacing** somebody taken off with somebody else | The same account | At once only while the term has places left (the limit plus the plan's replacements); otherwise from the next term | None |
| **Renewing with a different list**, within the limit | The same account | From the next term: chosen now where it renews by itself (`at: "renewal"`), or named when it is bought again | The next term's price |
| **Correcting** a person entered wrongly | A manager, with the reason (*Who it covered* on the membership, under *Credit & passes → Memberships*; `POST /api/admin/memberships/:id/covers`) | At once | None; uses no place |

- **Every person put on uses a place for the rest of the term**, the people
  named when it was sold included, and taking somebody off gives none back.
  So a family covering four, with no replacements, can add up to four, take
  any of them off, and put nobody new on (nor the person taken off back)
  until the next term; with one replacement it can put one more on, once.
  Taking the same person off and putting them back uses a place each time.
  Past its places a change is refused whole (`MBO_NO_PLACES_LEFT`), and the
  page offers the next term instead.
- **The limit always holds**: never more people covered at once than the
  plan's limit, whatever the order of changes; two changes at once are made
  one after the other under the membership's lock, each counted against
  the places the other left.
- **Nobody covered twice**: somebody another membership holds or covers for
  any of the days left is refused, with the day it ends, however they are
  put on (added, named for the next term, or corrected).
- **Benefits are not reset by a change.** A membership counts no visits,
  hours or bookings of its own (its benefits are prices, booking windows and
  members-only places), so there is nothing per person or per term a swap
  could restart; the places a term has used are the one thing it counts, and
  only ever go up. Bookings already made keep the people they were made for
  and the price they were given: somebody taken off keeps what they booked as
  a member, and pays the public price for anything booked after.
- **The next term** of one that renews by itself names the list chosen for
  it (`membership_next_covers`, migration 0193), less anybody the account no
  longer acts for when the charge comes, or, if none was chosen, whom it
  covers then; it starts with places of its own. One that does not renew by
  itself is renewed by buying it again, naming whom it should cover.
- **A manager's correction** takes the person entered wrongly off, and puts
  the right one on in their place where given: somebody the buying account
  acts for now, or, for one sold at the counter, a participant the venue
  knows with a guardian on the holder's number. It uses no place, and a
  person taken off with nobody in their place gives theirs back. The reason
  is required, and it is in the activity log (*Corrected whom a membership
  covers*) and in each person's history. The desk can read the history but
  not correct it.
- **Who was covered when** is kept as records, never overwritten
  (`membership_cover_changes`, migration 0192): named, added, removed,
  corrected, with when, by whom and why. *Who it covered* shows them to
  staff, with the term's places. A person whose record is erased stays
  counted, unnamed. Memberships sold before this keep whom they cover now as
  named when they were added (changes made before were not recorded).
- **In the holder's data export** (`membershipCoverChanges`;
  `coverChangesExport`): every change on the memberships the account holds,
  oldest first, with the membership, the venue, what changed and when, and
  whether the account (`you`) or the venue's staff (`staff`, never a name)
  made it. A person is named, and a correction's reason given, only where the
  holder is already shown them: the membership covers them now, or the
  account acts for them; anybody else (somebody corrected off who is not the
  account's, an erased person) is left unnamed. Tested in
  `tests/membership-cover-export.test.ts`.

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
- **A child's or a family membership** renews for the same holder, naming
  the dependants the membership it runs on from names when the charge comes
  (so a change to whom it covers carries on), or the list its buyer chose for
  the next term ([above](#changing-whom-a-family-membership-covers)), less
  anybody the account no longer acts for then. A child's own membership whose guardian no longer
  acts for them buys nothing: the charge is owed back and the subscription
  cancelled, as below. Each renewing membership is listed on the venue page
  with whose it is, and stopped on its own.
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
- **A suspension extends the end** (off unless set): a plan's memberships
  run on by the days a suspension takes out of their term
  ([suspending a membership](#suspending-a-membership)).
- **Members come in without a booking** (off unless set; migration 0266): at a
  resource taking [entry with no set time](venue-operations.md#entry-with-no-set-time),
  the plan's members are let in on their membership alone, anywhere in the
  business or only where a resource offers one activity (`admitsEntrySport`,
  set through the plans route; the screen sets the plan on or off). It admits
  whom the membership covers on the day, each person once, and moves no
  money. A membership sold at the counter admits only if it is on such a
  plan.
- **Changing plan** (upgrading or downgrading) takes effect at renewal,
  never mid-term and never silently unprorated: the new plan is bought in
  the renewal window and starts the day after the current membership ends,
  at the new plan's price, while the current one runs to its end as paid. A
  membership that renews by itself is stopped first (*Stop renewing*);
  buying another plan for the same holder while it still renews is refused
  (`MBO_RENEWS`), so the next term is never bought twice. Nothing changes a
  membership's plan mid-term, online or at the counter.

## Selling at the counter

The venue's prices are a manager's ([tenancy](../architecture/tenancy.md)):
the desk sells passes and memberships from the venue's own list, at its price
(`src/lib/counter-prices.ts`, `src/lib/pass-products.ts`, migration 0235).

- **Memberships** are sold on one of the venue's plans (the same plans
  customers join online): the plan's fee, and its months from the day it
  starts, the end worked out.
- **Passes** are sold from the venue's pass products, *Credit & passes →
  Passes the counter sells*: each with its name, what it spends (entries of
  so many minutes, or hours of court time), the longest booking it pays for,
  its sport or coach, what one use covers, how many days it lasts from the
  day it is sold, and its price. A manager adds and retires them; a pass sold
  from one copies its terms and names it (`passes.product_id`), so retiring
  a product changes no pass already sold.
- **Anything else** (another price or end date, a membership without a plan,
  a pass not on the list, a free one) is a manager's, with a reason of 5 to
  300 characters. It is written with the sale in its transaction
  (`counter_price_overrides`: the list price, the price, the reason and the
  manager), shown under the sale in the lists, and in the activity log
  (`sale.price_set`). Front desk is refused (`P8B_PRICE_MANAGER`,
  `P8B_SELL_FROM_LIST`), so a venue sells passes and memberships at the
  counter only once a manager has put them on the list.

## A manager's price adjustment

A manager may change one booking's price, or make it complimentary, with a
reason: a goodwill discount, a free hour for a coach or sponsor, a quote
given on the phone (*Adjust price* on the day list;
`src/lib/price-adjustments.ts`, migration 0236). It is recorded as a policy
override is ([ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md)):
the booking, the price before and after, complimentary or not, the reason,
the manager by id and name, in the same transaction, and in the activity log
(`booking.price_adjusted`). Front desk never adjusts a price.

- **Before it is paid** the booking's price becomes the new amount. Its
  receipt, drawn from the booking, keeps every line it had and adds the
  difference last (*Price adjusted by the venue*, or *Complimentary*, in the
  customer's language). Paid afterwards, by any way, the adjusted price is
  what is paid, taxed and in the sales journal.
- **After it was paid at the counter** the receipt stays as sold. Only a
  lower price is accepted, and the difference goes on a credit note of its
  own, by the way it was paid, for the desk to hand back (the
  [cash-up](payments-and-credit.md#cash-up) counts it); a later cancellation
  gives back only what is left (`paidPartLeft`). Paid online, with credit or
  with a pass, money goes back by the refund paths, and the adjustment is
  refused.
- **Discounts already on it stay**: the new amount is what the customer pays
  for the booking as it stands after member prices, concessions and any
  code, which stay on the receipt as they were worked out (a code stays
  used). The manager's figure is the last word: no code or concession is
  added to an adjusted booking afterwards (`P8B_PRICE_ADJUSTED`, asked by
  the one rule every path asks, `stackRefusal`), so it is never discounted
  again behind the manager's back. What changes the booking itself later
  (extras added, a concession whose proof is not shown, moving to a dearer
  hour) moves its price by its own difference, as it would have anyway.
- **Refused** for a cancelled booking, below what a deposit or shares have
  paid on it, while others share its cost (a split or an open game), while a
  payment page for it is open, and once it is on an account invoice.
- The bookings export has a *Price adjusted* column with the difference.

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

### Several passes for one booking

On the booking form, a signed-in customer's passes are offered under *Using a
pass?*: one for the whole booking, or *A pass for each person*, which lists
each person taking part with that person's own passes only (a child's swim
pass for that child). Each line says what it would spend of what it has left
and says so when a pass has too little; until every place has its own pass
the form says whose place is still to pay, in the words the server would use
(`ENT_PASS_*`). At the counter, the payment step of an unpaid booking offers
*Passes…*: the passes the booking's number holds here (its own, and those it
holds for the people it acts for), chosen the same way, and paid all or
nothing (`/api/admin/bookings/passes`). Both show the booking engine's own
plan (`planPassSpends` in `src/lib/pass-rules.ts`), which the engine then
spends under its transaction, re-reading every balance: nothing is decided on
the screen that the server does not decide again.

Entries and minutes are an append-only ledger (`pass_entries`), the same shape as the credit
wallet: `remaining = entries + SUM(delta)`, spends negative and refunds
positive. Nothing ever rewrites a running total, so the history is the balance.

A pass pays for a booking only when every one of these holds, and the entry
count is re-read **inside** the paying transaction so two concurrent bookings
cannot spend the same entry:

- the pass is active, in date and has entries left. `expires_on` is inclusive
  and is **the last day it can be played**, not the last day it can be booked:
  it is judged on the date of the session it pays (as a membership is), so a
  pass that ends before the session cannot pay it, and in a weekly series the
  weeks inside its validity are paid and the weeks after are left unpaid with
  the reason (`srv.unusable.passEndsBefore`), to pay another way. A booking
  paid with a pass is not moved to a day after its end
  (`FX8_MOVE_PAST_PASS`); the counter's list offers only passes good on the
  booking's day. A pass still good today and on the session's day is as before;
- the booking is at the pass's venue, and for its sport if it names one;
- the booking's phone number matches the holder's. Malaysian numbers are
  compared on digits with the country code folded away, so `+60 12-345 6789`
  and `012-345 6789` are the same person. The holder spends it on bookings
  they make, as they would credit: on a booking for their child, the holder
  pays with it;
- what it covers fits the booking ([what a benefit applies to](#what-a-benefit-applies-to)):
  a pass for the whole booking spends once for the booking, not for each
  person on it (every pass sold before); one for a resource hired whole pays
  no places sold one by one; one spent per place spends for each place the
  booking takes; and one for one person's place (sold for the holder, or for
  a participant they act for, *Whose place it pays*) pays only that person's
  place, so a booking for several is paid by such passes only when each
  place has its own. Each spend names its place and is given back once;
- the booking is no longer than the pass allows, and enough remains for the
  whole of it. A pass pays in full or not at all — there is no part-paying a
  booking and owing the rest.

Payment is best-effort, like paying from credit: a pass that cannot cover the
booking leaves it standing as **unpaid** with the reason, rather than throwing
the booking away. Cancelling a pass-paid booking returns its entries through
every cancellation path — by code, from an account, a whole series, an admin
cancellation, and the enrolments released when a class is cancelled — and
refunding twice is refused, so a double cancellation cannot mint entries. An
expired pass is still credited, and its entries are not left dead
([below](#passes-that-end-and-entries-given-back)). Taking one person off a booking gives back their
place's entries where the pass was spent per place, and nothing where it paid
for the booking as a whole
([taking one person off a booking](booking.md#taking-one-person-off-a-booking)).

Voiding a pass stops further spending but leaves spent entries spent; it is not
a refund: the sale stays sold, with no credit note, its tax with it. When the
manager hands back the unused part (asked when voiding), it is the pass's
price times the share of entries (or minutes) left, and a credit note is
written for that much only, at the tax the pass was sold at; what was spent
stays revenue (`voidPass` in `src/lib/store.ts`; `tests/void-credit-notes.test.ts`).
Customers see their passes with a used/remaining meter on `/account`,
and staff sell and cancel them from the *Credit & passes* tab.

### Passes that end, and entries given back

([ADR 0062](../architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md);
`giveBackToPass` in `src/lib/store.ts`, `src/lib/pass-validity.ts`;
`tests/pass-restore-and-validity.test.ts`.) An entry a cancellation gives back
is never left where it cannot be used. It goes back to the ledger as it always
did, by every path that gives entries back (the customer's cancellation, the
venue's, a place taken off a booking, a class cancelled), and then:

- **A pass that has ended is extended.** The pass runs on to today plus the
  venue's *days an ended pass is extended by when entries are given back*
  (`venues.pass_restore_grace_days`, migration 0309; **30 by default, which is
  the recommended value**, 0 to 365; **0 turns it off** and keeps what used to
  happen: the entry goes back but the pass stays ended). Set under *Credit &
  passes → Passes the counter sells*, a manager's, with the recommended value
  in its help text, and in the activity log. The extension is a line of the
  pass's own history with its reason (*Valid until A → B: 1 entry given back
  for MB-… after the pass had ended, 30 days to use them*), is made once
  however many cancellations arrive together, and happens only where entries
  actually go back (a late cancellation that keeps the whole entry changes
  nothing). A pass still in date is not touched.
- **A cancelled pass is never revived.** If a pass was cancelled with the
  unused part handed back (`passes.void_refunded`; one cancelled before that
  column, or by a chargeback, is read from the credit note on its sale) while it
  still paid a booking ahead, cancelling that booking hands the entry's value
  back in money instead: a credit note on the pass's sale for the entries'
  share of its price (never above what the sale took, so the notes together
  never exceed the price), owed back on its payment where the pass was bought
  online (refunded from *Refunds owed*), and a line in the activity log
  (`pass.restored_after_void`) so the venue pays it to a customer who bought
  at the counter. The pass's history shows the entries handed back as money and
  it stays at what it was when it was cancelled. A pass cancelled **without** a
  refund is the venue's decision to keep the sale: the entries go back to the
  ledger and the history says they are not handed back.
- **A manager can extend a pass's end**, with a reason, from the pass list
  (*Extend*): `POST /api/admin/passes/:id/extend` with a day or a number of
  days. Not past what a pass may run, never earlier than its present end, never
  for a cancelled pass. It is a line of the pass's history and in the activity
  log (`pass.extended`).

### Day passes

A **day pass** is a pass product marked *Day pass* (migration 0266;
`dayPass` on `pass_products` and `passes`): one entry for one person (a pass
for one person's place, `participant` scope, whatever else the form says),
for a resource taking [entry with no set time](venue-operations.md#entry-with-no-set-time).
Its first use spends the entry and keeps the venue's date of that day on the
pass; that person is then let in again all that day, at any resource there
taking entries, and on no other day. It is valid from the day it is sold for
as many days as the product says, like any pass, so a customer may buy it
ahead and use it on the day they come (from first use, not the date bought:
the owner may want to choose otherwise). It pays for no booking (refused with
the reason). It is sold at the counter from the venue's list and online as
any pass is (below), receipted and accounted as a pass; voided with money
back, an unused day pass is refunded in full and a used one not at all, by
the pass refund rule above.

### Buying a pass online

A venue that takes payment online can sell passes from its list online too,
as memberships, credit and gift vouchers are (`src/lib/pass-purchases.ts`,
`startPassPayment` in `src/lib/payments.ts`, migration 0264). Nothing about a
pass changes: what is sold is the pass the counter sells from the same
product, at the price paid.

- **Which passes**: a manager marks a product *Also sold online* when adding
  it, or *Sell online* / *Stop selling online* on the list under
  *Passes the counter sells* (`PATCH /api/admin/pass-products`, a manager's;
  logged as `pass_product.online` and `pass_product.offline`). Off by
  default. A product sold online costs at least RM1 (a free pass is given at
  the counter). Stopping changes no pass already sold and no page already
  open.
- **Where**: the venue's page lists them under *Passes*, each with its price,
  what it spends (entries, entries of so many minutes, or hours of court
  time), that it lasts so many days from the day it is paid, the longest
  booking it pays for, its sport or coach, and what one use covers, with the
  rules in a line: paid on the venue's own page, held on the account's phone
  number and spent on bookings made with it, a refund of what is unused the
  venue's to decide. A private venue shows them, and sells them, only to the
  people on its list.
- **Who and for whom**: a signed-in customer with a phone number on their
  account (the checked one, where phone checks are on), which holds the pass
  as the counter's holder number does. A pass for one person's place
  (*Whose place it pays*) can be bought for a participant the account acts
  for now (an active relationship, not paused for a review, archived or
  revoked), as a membership is ([for somebody you look after](#for-somebody-you-look-after-or-a-family));
  any other pass only for the buyer's own bookings, as the counter allows.
  Refused with the reason otherwise (`PSO_NOT_FOR_PARTICIPANT`,
  `PSO_NOT_GUARDIAN`, `PSO_PAUSED`, `PSO_NO_PHONE`), and nothing is opened.
- **Refused outright**: a product of another venue, one not sold online or
  retired, and every product of a draft venue (a test venue never takes real
  money) or of one taken off the marketplace (`PSO_NOT_SOLD`, `PSO_OFFLINE`).
- **Never a pass unpaid.** `POST /api/my/passes` opens the venue's payment
  page (Billplz or Stripe, [ADR 0006](../architecture/decisions/0006-per-venue-payment-accounts.md)),
  its expiry as a membership's (Stripe closes it after an hour; a Billplz
  bill cannot be closed); the same pass for the same person asked for again
  while that page is open goes back to it. The pass is issued only when the
  gateway settles the payment, in the transaction that claims it: from its
  product, at the price paid, its last day counted from the day it is paid;
  the callback and the customer's return, each repeated or racing, issue one
  (`online_payments.pass_id`, unique). A page that fails or expires issues
  nothing and is not offered again; money that still comes in on a Billplz
  bill issues the pass then. A product retired while the customer paid still
  gives what they paid for. Checked again when the money comes in: an account
  that no longer acts for the person, or has gone, gets nothing, and the
  money is owed back ([a pass paid online](payments-and-credit.md#a-pass-paid-online)).
- **Money** as at the counter: the pass's own receipt (`pass:<id>`), taxed as
  the venue's tax setting taxes passes, by *Online (gateway)*; in the sales
  journal and its export under *Passes* (a lesson pack under *Coaching*), in
  the cash-up under online, in the period report's tax, and in the month's
  consolidated e-invoice like any other online sale.
- **Staff** see it in the passes list like any other, marked *Bought online*
  with the gateway and the payment's reference; the activity log records the
  purchase (`pass.bought_online`). A child's history records who bought it
  (*pass.bought*). The page the customer returns to names the pass, its code
  and last day, and whose place it pays.
- **Refunds** follow voiding above: a manager voiding a pass bought online and
  handing back its unused part (all of it, when nothing was used; the unused
  share otherwise) credits that much and owes the same back on its payment in
  the same change, listed under *Refunds owed* and refunded through the
  gateway's refund API in one click (Stripe) or in its dashboard and marked
  refunded (Billplz), once. Voided without money back, nothing is owed.

Tested against stand-ins for Stripe's and Billplz's APIs and signed
callbacks, on PGlite and Postgres (`tests/passes-online.test.ts`), never
against the real gateways.
