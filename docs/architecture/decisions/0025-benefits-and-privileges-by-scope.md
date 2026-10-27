# ADR 0025: Benefits and privileges by the scope they apply to

- **Status:** current, decided 2026-10-27 by the product owner (an approved
  business and architectural decision). Amended the same day (the owner's
  decision on discounts together, M16: one configurable rule and one order
  on every path, and several passes chosen on the booking form and at the
  counter; see *Changes*). Extends
  [ADR 0023](0023-participants-apart-from-accounts.md): of the things it
  left assuming the account (or number) is the person, passes,
  concessions and memberships now say whom they are for, and a booking of
  several people no longer has to be cancelled whole. How customers and
  staff use it is [what a benefit applies to](../../features/pricing.md#what-a-benefit-applies-to),
  [memberships and member rates](../../features/pricing.md#memberships-and-member-rates),
  [who a venue is for](../../features/booking.md#who-a-venue-is-for-public-members-only-private)
  and [taking one person off a booking](../../features/booking.md#taking-one-person-off-a-booking);
  the money is [refunds for one person's place](../../features/payments-and-credit.md#refunds-for-one-persons-place).
- **Context:** once a booking named several people (ADR 0023), every
  benefit still applied per booking and every membership rule per number.
  A pass paid for a booking whoever was on it; a concession came off the
  whole booking; a membership priced a booking its holder took part in; a
  members-only venue asked only whether the account was a member; and a
  booking of three children could only be cancelled whole. That is right
  for a court pass, a promotion or a member reserving a court, and wrong for
  a child's swim pass, one child's concession among three, a members'
  swim session a parent books for a child who is not a member, or one child
  who falls ill. The owner decided that benefits support both scopes, that
  membership rules are enforced by their real scope, and that one
  participant can be withdrawn where the activity permits it.
- **Decision:**
  - **Every benefit says what one use covers**, in the model that already
    holds it (`lib/entitlements.ts`): `passes.scope` (`booking`,
    `resource`, `participant`, `places`), `concessions.scope` (`booking`,
    `participant`), `membership_plans.scope` (`booking`, `participant`;
    migrations 0155–0156). `booking`: the reservation as a whole (a court
    pass, a promotion, a venue's voucher, a member reserving a court).
    `resource`: a resource hired whole, for its time (court hours), never
    places sold one by one. `participant`: one person's place (a child's
    concession, an individual swim pass, a coaching pack for one person, a
    participant's own membership). `places`: each place a booking takes,
    each one using it. What it is good for (a sport, a lesson pack's coach)
    stays as it was, apart from the scope. Promo codes and gift vouchers
    stay booking-wide and need no column. No pricing engine was added: a
    place's share is the booking's court time as charged split between its
    places (`placeShares`), and prices are still `lib/pricing.ts`.
  - **What each benefit is, and which go together** (`lib/discounts.ts`).
    A price is not a discount: the public rate, a member's rate (for the
    booking or a member's own place) and a last-minute price. A discount is
    a concession (the booking's, or one person's place's) or a promo code.
    A means of paying changes no price and comes after it: stored credit, a
    gift voucher (it becomes credit), a pass, a payment. A concession and a
    code go together only where the venue allows discounts together
    (`venues.discount_stacking`: `never`, the default, or `promotion`) and
    the code says it may (`promo_codes.combinable`, off unless staff tick
    it); otherwise the second one asked for is refused, with the same code
    on every path (`ONE_DISCOUNT` where the venue gives one discount at a
    time, `STK_NOT_COMBINABLE` where the code does not combine; migration
    0163). A member's rate goes with either; a last-minute price takes
    neither; two concessions never cover one place.
  - **One order, in whole sen, whatever came first.** Each place's share of
    the court time at the public price, split evenly with the earlier places
    taking the odd sen; its member price; its concession (a share of what the
    place costs then, half up); then the code on the court time after all of
    those (a percentage rounded down, a fixed amount never more than the
    court time), shared between the places in proportion to what each costs
    by then, by largest remainder, each named place's share recorded
    (`promo_place_shares`, migration 0164); then tax, inside the price; then
    the means of paying. Fees, a coach's fee and extras are never
    discounted, and no price goes below nothing. A concession added or
    refused after the code works the code out again, so the order holds
    whichever was asked first. The form, the counter (the same route as
    staff), the API, several courts at once and lessons all reach it through
    `applyConcession`, `applyPlaceConcession` and `applyPromo`; a class
    enrolment takes neither. A move keeps the discounts as they were given;
    a cancellation gives the code's use back with its shares. A limited
    code's last use is counted on the code's own row, where the database
    refuses one past the limit (migration 0165).
  - **Whose a benefit is.** A pass or a membership is the number's holder's
    own (`holder_kind = 'customer'`, everything issued before), or a
    participant's they act for (`holder_participant_id`): sold at the counter
    only for a participant the venue knows with a guardian on the holder's
    number. A family membership names the dependants it covers
    (`membership_participants`); nothing is inferred from a shared number or
    surname. A participant's membership never makes the number's holder a
    member (`activeMembership` reads the holder's own only), and a holder's
    never covers a participant it does not name.
  - **Redemptions per place, once, by the database.** A concession or a
    member's price for one person's place is a `place_benefits` row with the
    money it took off; a pass spent per place is a `pass_entries` line naming
    the place; each refund or withdrawal settles the spend it gives back
    (`settles_entry_id`). Unique indexes refuse a second concession for one
    place, a second spend for one place and a second settlement of one spend,
    whatever path the requests come by (the customer, the counter, the API,
    a group of courts) and however many arrive at once; balances are read in
    the paying transaction, which is serializable.
  - **Mixed eligibility priced per place, booking-wide benefits whole.** On
    a booking priced by the place (places on a shared facility, players on a
    court priced per player) one person's concession or member price comes
    off that person's place alone; a pass for one person pays only their
    place, so a booking is paid by such passes only when every place on it is
    covered (a pass pays in full or not at all, as before). On a resource
    hired whole nothing is priced per person: one person's concession does
    not apply there and says why, and a member's price for members' own
    places applies only where the member is the only one on it. A
    booking-wide membership prices the whole booking where its holder or a
    person it names takes part.
  - **Membership rules by their real scope, one check for every path.**
    Reserving a resource whole and booking further ahead are the account's
    privileges (a member parent books a court for children who are not
    members; house limits count the account's and household's bookings,
    whoever they are for). A place on a shared-capacity session at a
    members-only venue (a facility's places, a class) is each person's own to
    hold: each participant needs their own membership or a family one naming
    them, on every date booked (`membersOnlyRefusal`), asked by the booking
    engine for online bookings, the counter, the venue's API key, groups of
    courts, waiting-list offers and classes, and by a move to another date; a
    manager going past the rules may book without it, recorded as an
    override. The customer's own place is the account's, as before: online
    the account must be eligible, and staff at the counter book anyone. An
    account that is not a member may book its member child's place; one
    joining a waiting list for a child who is not a member is refused.
  - **One person taken off a booking**, the others staying booked
    (`lib/place-withdrawals.ts`, migration 0157), where the booking rule
    `separatePlaces` allows it (yes unless the venue sells the places as one).
    Their `booking_participants` row goes, so the door, the roster and every
    eligibility check simply no longer see them; `place_withdrawals` keeps
    who it was, what their place cost, what went back and how, what the venue
    kept, the pass entries returned, who did it and why. A place on a shared
    session is released and offered to the waiting list; a place priced by
    the place comes off what is owed, or goes back the way it was paid on the
    venue's cancellation terms, with the place's own benefits and its
    recorded share of a code (kept on the withdrawal, `promo_share`);
    booking-wide benefits stay with the booking; a player taken off a court hired whole is
    no longer named on it, the court booked and paid as it was. A paid
    booking's price stays as sold: the place has its own credit note and is
    left out of a later cancellation's refund. Refused with the reason: a
    lesson, a class place (each is already its own enrolment), an open game,
    shares paid by others, a deposit, an account charge, a payment page open,
    kit out, somebody already marked at the door, the last person, past the
    cutoff. Staff can do it at the counter in full; it is in the activity log,
    the participant's history, and an email to the customer naming them.
- **Consequences:** every pass, concession and plan issued before keeps its
  meaning (`booking`, set explicitly), and no historical redemption,
  receipt or refund changed. A child's swim pass, concession or membership
  is the child's; one child among three can have a concession, a pass or a
  member's price on their own place; a members' session cannot be booked
  for a child on a parent's membership; and one child can be withdrawn. A
  withdrawal's notice goes by email only (WhatsApp would need a template of
  its own approved). The customer's booking form offers one person's
  concession for one person, and says which pass pays for whom: one for the
  whole booking or each person's own for their place, with what each spends
  of what it has left; the counter can pay a booking so at the payment step
  (`/api/admin/bookings/passes`), both by the plan the booking engine pays by
  (`planPassSpends`). Memberships for a participant and family memberships
  were sold at the counter only when this was decided (online since; see
  *Changes*). A late withdrawal of an unpaid place
  takes its price off without a strike. A place withdrawn takes exactly its
  recorded share of a booking-wide code; bookings made before shares were
  recorded share their code evenly between their places, as before, and
  keep every stored amount.
- **Alternatives considered:** a per-person benefits engine beside the
  booking's price (two prices of one booking to keep in step); a universal
  per-booking rule, or a universal per-person one (each wrong for half the
  products the owner listed); giving a participant's place to the holder
  when the participant's record goes (it would turn a child's pass into the
  parent's); lowering a paid booking's price on a withdrawal (its receipt is
  drawn from the booking and would change after it was issued); cancelling
  and re-booking the others (new codes, lost places, the money twice);
  checking a child's membership requirement against the parent's
  membership (exactly what the owner ruled out).
- **Changes:**
  - 2026-10-27 (the owner's decision): memberships for a participant and
    family memberships can be bought online as well as at the counter, by an
    account that is the active, unpaused guardian of each person named; a
    plan says whom it is sold for (`offered_for`, and a family plan's limit,
    migration 0167). The purchase is kept with its payment
    (`membership_purchases`, migration 0168) and the membership made only
    when the payment settles; a family membership's dependants can be
    changed online within its limit, with no proration. The model of whose a
    membership is and whom it covers is unchanged
    ([for somebody you look after, or a family](../../features/pricing.md#for-somebody-you-look-after-or-a-family)).
  - 2026-10-27 (amendment, the owner's decision on M16): a person's
    concession and a promo code had combined through the API only (the
    concession first) while the booking form hid the code and the counter
    refused a concession after a code. Now one rule, configurable per venue
    and per code, refuses or allows them the same way on every path, in one
    order with one rounding; each place's share of a code is recorded, so a
    withdrawn place takes exactly its share; a limited code's last use is
    held by the database; the booking form and the counter choose several
    passes, one per person, by the engine's own plan. A percentage code is
    now rounded down to the sen as documented (it had been rounded half up
    first). Migrations 0163–0165.
  - 2026-10-27 (benefits the same on every path): the venue's API key, which
    had booked with no discount, takes the booking form's and the counter's
    concessions and code through the same function
    (`lib/booking-discounts.ts`), as this record said it did; a membership
    sold at the counter refuses a participant already covered for any of its
    days, as buying online does. Confirmed as decided, unchanged: a
    last-minute price takes no other discount, and a move keeps the
    discounts as given, the court time following the price-difference rule
    ([discounts together](../../features/pricing.md#discounts-together)).
  - 2026-10-27 (the owner's decision on taking one person off a booking):
    the deliberate commercial restrictions stay (a court hired whole gives
    nothing back when one person leaves; a lesson is booked as one with the
    coach; an open game's players leave the game; a class place is its own
    enrolment; shares other players paid, each worked out from the whole
    price, a payment page open, kit out, a place marked at the door and the
    cutoff refuse it), and the cases that were refused only for want of the
    money path are built on the same withdrawal: a booking held by a deposit
    (the place off the balance still owed first, then what was paid beyond
    the new total back to the deposit's payment on the cancellation terms,
    with a credit note; `place_withdrawals.deposit_part`, migration 0200)
    and a booking charged to a company or school account (off its charge
    before the month's invoice; after it the invoice stays as issued and the
    place is a credit note on the account, taken off its next invoice;
    `account_credits`, migration 0201). A split nobody has paid a share of
    is worked out again on the new price
    ([taking one person off a booking](../../features/booking.md#taking-one-person-off-a-booking)).
