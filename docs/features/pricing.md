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
  code is RM14; moved to a RM30 court it is RM24); a paid one keeps what was
  paid, the customer unable to move it somewhere dearer and staff choosing
  not to charge the difference. A last-minute price stays with the time it
  was given for: moving away from it costs the difference, and a move never
  earns one. A booking keeps its last-minute mark when moved; no discount
  can be added after booking on any path, so it decides nothing more.

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
  counter*. A renewal starting the day after the old one ends covers the
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
cancelled, voided by a chargeback or ended for that day since it was booked,
or a dependant taken off a family membership.

- **Self check-in from the QR code** is refused with the reason (*… was
  cancelled. Check in at the desk: staff will decide*; `MV6_CHECKIN_ENDED`,
  `MV6_CHECKIN_CANCELLED`, `MV6_CHECKIN_NONE`).
- **The door code** is not given, with the reason (`reason: "membership"`,
  `MV6_DOOR_*`), so nobody is let in unattended
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
**cancelled** by staff (*Void*), **voided by a chargeback** (revoked), or a
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
(`POST`, a note required; in the activity log). Memberships have no
suspended state: cancelling (staff) and voiding on a chargeback (revoked)
are the two ways one stops early, besides taking a dependant off a family
membership.

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
  a manager cancels it (*Void*), with a credit note on its receipt, which also
  stops its renewal. For one bought online the manager is asked whether the
  money goes back too: if so, what its payment took is owed back in the same
  change, in full (nothing is prorated), and refunded from *Refunds owed*
  ([refunds](payments-and-credit.md#paying-online)); if not, nothing is owed
  back, as before.

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
- **Changing plan** (upgrading or downgrading) takes effect at renewal,
  never mid-term and never silently unprorated: the new plan is bought in
  the renewal window and starts the day after the current membership ends,
  at the new plan's price, while the current one runs to its end as paid. A
  membership that renews by itself is stopped first (*Stop renewing*);
  buying another plan for the same holder while it still renews is refused
  (`MBO_RENEWS`), so the next term is never bought twice. Nothing changes a
  membership's plan mid-term, online or at the counter.

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

- the pass is active, in date (`expires_on` is inclusive) and has entries left;
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
expired pass is still credited: the ledger stays honest even when the entries
can no longer be spent. Taking one person off a booking gives back their
place's entries where the pass was spent per place, and nothing where it paid
for the booking as a whole
([taking one person off a booking](booking.md#taking-one-person-off-a-booking)).

Voiding a pass stops further spending but leaves spent entries spent; it is not
a refund. Customers see their passes with a used/remaining meter on `/account`,
and staff sell and cancel them from the *Credit & passes* tab.
