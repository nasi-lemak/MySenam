# Payments, stored credit and sales

Authoritative for how money is taken and held: paying online, paying to hold, stored credit and its ownership, gift vouchers, split costs, extras, counter sales and company accounts. Gateway set-up is in [payment gateways](../integrations/payment-gateways.md).
Status: [feature status](../product/feature-status.md#payments-and-money) and [memberships, passes and credit](../product/feature-status.md#memberships-passes-and-credit).

## Payments

Every booking starts `unpaid` and stands whether or not it is ever paid
online. Front-desk staff mark it `paid` from the admin Bookings tab, picking
**how** in one tap: cash, DuitNow QR / e-wallet, bank transfer or card
terminal (a whole recurring series can be settled the same way). Online
payments, passes and stored credit record themselves. The Reports tab splits
what was collected by method, so the till and the bank account can be squared
at the end of the month; counter payments marked before methods were asked
show as *not recorded*. Every other counter sale says how it was paid too
([how each counter sale was paid](#how-each-counter-sale-was-paid)), and the
[cash-up](#cash-up) adds a day's up by method. Customers see the payment
state on `/account` and in the `/my-booking` lookup. The daily view splits
**expected** vs **collected** vs **outstanding** revenue so a shift can be
reconciled at closing.

### Paying online to hold a booking

For venues losing slots to people who never come: under *Venues & staff →
Online payments → Pay online to hold a booking* (`src/lib/holds.ts`), a booking
made online must be paid online within a few minutes (15 unless set, 5–60), or
it is let go for somebody else and the customer is charged nothing.

- The customer sees *Held for you: pay to confirm* and the time it is held
  until, with the button to pay. Paid, it stands and the usual confirmation
  goes out, calendar invite and all; until then nobody is told it is theirs.
- Opening the payment page holds it 30 minutes more from then, so somebody
  part-way through paying is not undercut. On Stripe the page itself closes
  then too, so a slot already let go cannot be paid for; a page opened earlier
  is sent again only while it has time left. Billplz pages cannot be closed: a
  payment that still lands after the hold was let go is listed under *Refunds
  owed*, as for any booking cancelled after paying.
- **Class places are held the same way** ([ADR 0070](../architecture/decisions/0070-class-places-held-for-payment-and-several-offers-at-once.md)):
  an enrolment made online and still to pay (one session, a term, a family's or
  group's places) is held for the same minutes and let go the same way, its place
  offered to the class's waiting list, and a place claimed from that list is held
  by the same rule (`claimHold`). A class place is never held past the start of its
  class, nor by an open payment page. See [programmes](programmes.md#classes).
  payment that still lands after the hold was let go is **never turned back into
  the booking** and is owed back ([settlement checks](#settlement-checks), owner
  decision DEC-14, [ADR 0065](../architecture/decisions/0065-a-payment-is-settled-for-the-amount-the-gateway-took-and-never-into-a-lapsed-hold.md)).
- A held slot comes free on time: holds are let go on the scheduler's tick,
  and on the way past whenever anybody books, searches or opens a day's
  availability, the venue's own system through its API key and the MCP server
  included (`GET /api/v1/availability`, `POST /api/v1/bookings`, `my_availability`,
  `create_booking`: the same `releaseExpiredHolds`, so the venue's system never sees a slot
  taken that the public grid shows free). The waitlist is offered it. The key's *lists of
  bookings* are not a slot's availability and read the bookings as they stand: a lapsed hold
  there shows as unpaid until the next tick or visitor lets it go.
- Staff see *held till 3:45 PM* on the booking, and *released (unpaid)* after.
  Bookings staff make at the counter, ones paid at once from credit or a
  pass, and free ones are never held. It needs the venue's own payment
  gateway account (Billplz or Stripe); without one it cannot be turned on.
- A held booking with a deposit paid on it is never let go as unpaid, even in
  the moment before its hold is cleared.
- **A request that dies half-way.** The booking is saved before its hold is
  applied. Should the request die in between, the scheduler's tick puts the
  hold the booking would have had, counted from when it was made (still
  running, the customer has the rest of their minutes; past, it is let go at
  once). It only touches a booking made online by a customer at a venue whose
  holds are in force, unpaid with nothing paid towards it and no payment ever
  started, not on an account, not a class place, not made for an approval,
  and made since the venue turned holds on (`venues.pay_to_hold_since`,
  migration 0297); it is idempotent and safe to run twice or at once
  (`holdStrandedBookings`, [ADR 0054](../architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md)).
- Every page that shows a held booking says it is held and until when, in the
  reader's language, with the way to pay: the booking form's confirmation,
  My Booking, the account page (*Held*, never *Confirmed (pay at counter)*),
  a waiting-list claim ([waitlists](booking.md#waitlists)), and the payment
  return page.
- **A payment that fails or is abandoned** (the bank page fails, the customer
  presses back): the return page shows the booking's code, and, held, *Held
  until 6:45 PM while you pay online* with *Pay again to keep it* (the
  booking's signed link, [links that open a booking](booking.md#links-that-open-a-booking));
  let go already, that it was let go and nothing was taken. Only a booking not
  held is said to still stand, to pay at the counter or again here. *Go to My
  Booking* opens the booking itself.

**A booking made on approval** ([registering online for approval](activities.md#registering-online-for-approval);
[ADR 0020](../architecture/decisions/0020-approval-to-booking-payment-and-authority.md)).
Approval is eligibility, never payment. At a venue asking payment to hold,
the slot booked on approval is held by this same hold for the activity's
*hours to pay once approved* (24 unless set, never past the slot's start; the
venue's own minutes when the customer books the in-person session there and
then), and the customer is emailed the booking code and the deadline and pays
from their account's approvals page. Paid, it is confirmed as any held
booking; not paid in time, it is let go and the customer told that the
approval stands. A payment that lands after the hold was let go becomes the
booking again, paid, if the approval still stands and the slot is still free
(what was owed back on it reduced by what the booking now costs, in the same
transaction); otherwise it stays under *Refunds owed* and the customer is
told. That happens once per payment, whether the gateway reports it once or
twice or the scheduler retries after an interruption; a booking staff
cancelled, or let go when the approval was revoked, is never revived, and a
late deposit stays owed back. Staff approving may let the booking stand
unheld, paid at the counter, as an exception on record. At a venue that takes
payment at the counter, a booking made on approval stands unpaid as any
booking there does.

**A deposit instead of the whole price.** The same setting can let the
customer hold it with a share of the price (10, 20, 25, 30, 40 or 50 percent)
and pay the rest at the counter. They see both buttons, *Pay RM35.00 online*
and *Pay a 30% deposit now: RM10.50*, and the booking terms say so.

- Paid, the deposit stands the booking exactly as paying in full would, with
  the confirmation, and it is on a receipt of its own (`deposit_paid`, and in
  `shares_paid` like a friend's share, so the balance left is right
  everywhere). `/my-booking` says what was paid and what is left. Ticked paid
  at the counter, the booking's receipt is for the rest.
- Cancelled in time, all of it is owed back under *Refunds owed*, with a
  credit note. Cancelled late, the venue keeps its late-cancel share of it
  and the rest is owed back; a late cancellation with a deposit paid is not a
  strike, since the venue was paid something.
- The customer can still move it themselves; only friends' shares stop that.
  What has been paid never ends above the price: moved to a cheaper time or
  court, or given a promo code or concession that takes the price below the
  deposit, the part of the deposit above the new price comes off the booking
  and is owed back on the deposit's payment under *Refunds owed*, with a credit
  note on the deposit's receipt (the change's answer says how much,
  `owedBack`); the rest of the deposit stays as the booking's. Where friends'
  shares (not a deposit) would be above the new price, the change is refused
  (`PAID_ABOVE_PRICE`: ask the venue, who can square it with them), as a
  manager's own price change is (`P8B_ADJUST_BELOW_PAID`). One rule for all
  of them (`keepPaidWithinPrice`, [ADR 0054](../architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md)).
  A booking paid in full keeps the price it was paid at, as before.
- One person can be taken off it: off the balance first, then out of the
  deposit ([refunds for one person's place](#refunds-for-one-persons-place)).
- A number past its no-show strikes is offered no deposit: it pays it all.
- Several bookings paid together (a weekly series) take the share of the
  whole, split across them. Cancelling one owes back and credits that
  booking's part of the deposit only; a receipt is never credited for more
  than it was.

### Paying online

A venue can let customers pay online **into the venue's own gateway
account**: FPX online banking or card through [Billplz](https://www.billplz.com)
in Malaysia, or card and PayNow through Stripe in Singapore (set-up in
[payment gateways](../integrations/payment-gateways.md); see
[ADR 0006](../architecture/decisions/0006-per-venue-payment-accounts.md)).
The platform never holds a customer's money, which is the difference between
running booking software and running a payments business.

- **Set up** under *Venues & staff → Online payment*: the venue's Billplz
  collection ID, API secret key and X Signature key, and whether it is a
  sandbox account. Nothing needs configuring on the Billplz side — each bill
  says where to report back, which is why `MYSENAM_URL` must be the install's
  public `https://` address.
- **Paying** — a *Pay online* button appears on the booking confirmation, on
  `/my-booking`, on the account page's bookings, after a class enrolment
  (the customer's own, online; the counter takes payment as it enrols), on a
  waiting-list claim and on the payment return page after a failed attempt,
  and the confirmation message says the booking can be paid online. Where no
  phone is to hand (a claim, an enrolment, the return page) the button pays by
  the booking's signed link ([links that open a booking](booking.md#links-that-open-a-booking)). A weekly series is paid in one bill; weeks already settled are left
  out. Pressing the button twice sends the customer to the same bill.
- **Marked paid** only when Billplz says so, in a callback or the customer's
  redirect back, only after its signature checks out under that venue's
  key, and only for the amount the page asked for
  ([settlement checks](#settlement-checks)). Either can arrive first; both are
  safe to repeat. The Bookings tab shows
  these as `✓ online`, which cannot be toggled off by mistake: that money is in
  Billplz, not the till.
- **Refunds** — a booking paid online and then cancelled, or paid at the counter
  as well, is listed under *Refunds owed* with who to pay back. So is a
  tournament entry, league fee, game share, membership or top-up paid for
  something that had gone by the time the money arrived (for a membership
  bought for somebody else, also one whose guardian no longer acted for them
  by then: [joining online](pricing.md#for-somebody-you-look-after-or-a-family)). Through **Stripe**,
  a manager refunds it with one click: MySenam asks Stripe for the session's
  payment and refunds what is owed, in cents, with the venue's own key (which
  needs *Refunds: Write* as well as *Checkout Sessions: Write*). The request
  carries an idempotency key made from the payment and what is owed on it, and
  each refund is written to `online_refunds` under Stripe's own id, so a double
  click or a retry refunds once. The amount is claimed before Stripe is asked:
  while the request is out it counts as refunded, so marking it refunded by
  hand, or a second click, finds nothing owed and cannot send it twice. If
  Stripe refuses, the claim is given back and the amount is owed again. If
  Stripe gives no clear answer (no reply, its own server error) or the app
  stops before it answers, the claim stays and the scheduler asks again after
  ten minutes under the same idempotency key (`settleRefundClaims`), so Stripe
  makes the refund or hands back the one it already made; staff see a message
  saying so, and a customer's own cancellation counts it as on its way. How
  each kind of interruption is finished is [below](#refunds-that-are-interrupted). **Billplz** has no refund API: refund in its
  dashboard, then mark it done. Either way the refund goes in the activity log
  with who made it.
- **Paid twice** — when something already paid is paid for again (a
  tournament entry ticked paid at the counter while its page was open, two
  pages for one entry, a WhatsApp pack or a platform invoice paid by hand and
  then online), the first payment is the fee, with its receipt; the second
  is money received but owed back: no receipt, no revenue, listed under
  *Refunds owed* until it is refunded once. However often the gateway reports
  it, at the same moment or later, it is recorded once. A fee paid online
  cannot be unticked at the counter: it is refunded from the online payments
  list instead. What a venue paid the platform twice is owed back by the
  platform owners, from *Billing → Owed back to venues* (refund through
  Stripe, or mark refunded after paying it back by hand).
- **A cancellation and its refunds are one change**: the booking is let go
  and every refund (receipt credit note, credit, pass entry, promo, game and
  friends' shares, and what is owed back online) is written in one
  transaction, so a failure part-way leaves the booking booked and nothing
  given back, and two cancellations at once refund once. What goes back
  through a gateway cannot be in that transaction: it is written down as
  owed, then asked for. *Refunds on their way* under *Online payments* lists
  each one asked for and not yet answered; one with no answer after an hour,
  or owed for over a week, is raised by the daily integrity check
  ([monitoring](../operations/monitoring.md)). So collection, what is
  recognised as revenue (receipts), what is owed back and what has been
  refunded are each recorded apart.
- **Chargebacks** — when a customer disputes a Stripe payment with their
  bank, Stripe tells the venue's webhook (`charge.dispute.created`, `.updated`
  and `.closed`; add them to the endpoint's events). A dispute names no page of
  ours, so whose it is shows by which venue's signing secret it checks out
  under, and the payment by asking Stripe which checkout session made it. It
  is written to `payment_disputes` once and kept up to date. The venue's staff
  get an email with the amount, the reason and the date to answer by, and it
  shows in red under *Disputed payments* with *Answer it*, a link to the
  dispute in Stripe. **Lost**: the money went back to the customer, so what
  it paid for is owed again for as much as went back, and staff are told. A
  booking paid in full keeps its receipt (written down, dated when it was paid)
  and gets a credit note for what went back, and shows as unpaid for that; a
  deposit stops counting towards its booking, and its receipt is credited. If
  the rest was paid at the counter, with credit or with a pass, what was paid
  that way keeps a receipt of its own, dated when it was paid, and the
  booking shows as unpaid for the deposit's part. If the rest was paid online,
  the same: that payment keeps its receipt under its own key, so cancelling
  the booking later still owes it back, and the booking shows as unpaid for
  the deposit's part.
  Repeats of the same outcome do nothing. **Won**: only the record changes. Billplz (FPX) has no card
  chargebacks to report.
- **Chargebacks on what a venue paid the platform** — a monthly invoice or a
  WhatsApp pack paid through the platform's own Stripe account
  (`STRIPE_WEBHOOK_SECRET`). The dispute is recognised by that secret, written
  to `payment_disputes` once, and the platform owners are emailed when it
  opens and when it is decided; the venue's staff are not, and it is not
  listed among the venue's disputes. Lost in full, what it paid for is owed
  again, so the books do not show as settled what was not: the invoice is due
  again in 14 days (an owner voids it under Billing to let it go), and a pack
  is due again with its messages taken back, those already sent leaving the
  venue's WhatsApp balance below nothing until it is paid, so paying again
  does not give them twice. Lost in part, the owners are told and settle it by
  hand.
- **Refunds when a customer cancels** — a venue can skip the queue for what a
  customer cancels themselves (by code, from their account, or a whole series),
  under *Cancellations, refunds and no-shows* (`refundCancelled` in
  `lib/payments.ts`). *Staff refund it* is the default and the old behaviour.
  *Refund it straight away* sends it back through Stripe as the customer
  cancels, exactly as the one-click refund would. *Give it back as credit*
  turns it into stored credit at the venue for the account that booked, written
  to `online_refunds` under a key made from the payment and what is owed on it,
  so a retry credits once. Whatever cannot go that way stays under *Refunds
  owed*: a Billplz payment, a refusal from Stripe, or credit for a booking made
  without an account. The customer is told which happened, and how much.
- **Refunds when the venue cancels** — one policy for everything the venue
  itself cancels (a closed day, a rain-out, a court out of service, a class or
  a tournament called off, a staff cancellation, the venue's API key; the
  owner's decision of 29 October 2026): the customer did nothing, so the venue's
  setting above, which is for a customer's own cancellation, does not apply.
  What was paid online goes back through the gateway it was paid through
  wherever that gateway has a refund API (Stripe), asked once under a key made
  from the payment and what is owed on it, the amount claimed before the
  gateway is asked; shares other players and friends paid towards the booking
  go the same way. Where the gateway cannot (Billplz), refuses, or the venue no
  longer has it connected, the money stays owed for staff under *Refunds owed*
  with the date it is due, and is settled by hand (*Mark refunded* after
  refunding in the gateway's dashboard), never reported refunded before.
  Credit notes, the activity log and the refund reconciliation are the same as
  for any refund (`refundCancelled`, `refundOwedByVenue`; for a tournament's
  entry fees, `cancelTournament`). A counter payment is not online money: it is
  [owed back at the counter](#owed-back-after-the-venue-cancels) until a named
  person hands it back. Staff voiding a gift voucher or a membership choose
  their own outcome (they are not a bulk cancellation) and stay on *Refunds
  owed* for the one-click or by-hand refund.

### Settlement checks

A report that a payment page was paid is believed for the amount the page asked for,
never on its own (audit C19 and C18, [ADR 0065](../architecture/decisions/0065-a-payment-is-settled-for-the-amount-the-gateway-took-and-never-into-a-lapsed-hold.md);
`src/lib/payment-settlement.ts`, `settleBill` in `src/lib/payments.ts`; migration 0316).
What Billplz sends, as its documentation lists it (read 7 November 2026; **not yet
exercised against a Billplz sandbox**): the callback carries `id`, `collection_id`,
`paid`, `state` (`due`, `paid` or `deleted`), `amount` and `paid_amount` (in sen),
`paid_at` and `x_signature`; the browser's redirect carries only `billplz[id]`,
`billplz[paid]`, `billplz[paid_at]` and `billplz[x_signature]`. So:

- **The callback is checked field by field** after its signature: `state` must be
  `paid`, `collection_id` must be the collection this venue's account pays into,
  `amount` must be the page's amount, and `paid_amount` is what was taken. The
  payment is found by its bill (`bill_id`, unique) and checked under the key of the
  venue it belongs to, so another venue's valid key does not settle it, and it is
  claimed once, so it is never settled twice however often or at once it is reported.
- **The redirect is checked against the bill itself**: a paid redirect is believed only when
  Billplz's own record of the bill (`GET /api/v3/bills/:id`, with the venue's key) says the
  same, with the same figures. If Billplz cannot be asked, nothing is applied and the
  return page shows the payment's own state; the callback decides.
- **The same** for Stripe: the session's amount and currency are held against the page's.

| What the gateway reports | What is done |
| ------------------------ | ------------ |
| The page's amount | Settled as always; `received_amount` recorded |
| More | The page's amount is settled; the excess is **owed back** (`refund_due`), the payment's `amount` becomes what was received and `billed_amount` keeps what was asked; the payment is on the list to check as *overpaid* |
| Less, a bill not for the amount asked, another currency, a bill in another collection, or a paid report missing the amounts Billplz documents on it | **Nothing is applied.** What was received is recorded and all owed back; no receipt; the booking (or pass, membership, top-up) stays as it was and can be paid again on a new page; a purchase it was holding is let go and a subscription it started is stopped. On the list to check |
| Something that disagrees after the payment was applied (a redirect with no figures came first) | Recorded and flagged; nothing undone |

A refund *owed* is never a refund *paid*: Billplz refunds stay manual (*Refunds owed*, then
*Mark refunded* after refunding in Billplz's dashboard). Each observation is one activity-log
row (actor MySenam) beside the payment's own columns; nothing already written is edited.

**Payments to check** (under *Online payment*, and a red line in *Needs attention* with
the venue's count, the amount owed back and the oldest date): each payment that was not
applied, owed an excess, or came after a hold was let go, with what was received against
what was asked, what is owed back, and how the payer can be reached: *told by email* (an
address their account has proved), or *no usable contact* (only an address typed on the
booking, or none: ring them). *Mark checked* takes it off the list, once, with a note,
and is in the activity log (`POST /api/admin/online-payments`); it moves no money. What is owed
back is also under *Refunds owed*, where it is refunded in the usual way.

**The owners are told** ([ADR 0076](../architecture/decisions/0076-three-operator-visibility-gaps-the-heartbeat-a-payment-mismatch-and-counter-refunds-owed.md);
`alertPaymentToCheck`): when a payment is put on the list (any issue above, once, from the statement that claims it), one alert is
raised under the key `payment:check:<payment id>` through the ordinary owner-alert path: an email to each platform owner, the alert
webhook if set, and *System health*. It names the venue and the payment's reference (the gateway's bill id), the issue, the amount
and what is owed back, and says to open *Venues & staff → Online payment → Payments to check*; it holds no customer name, phone or
email. A repeated callback, the redirect after it, or callbacks at once raise it once; *Mark checked* clears it; another payment
later is a new alert. After five alerts standing at one venue, further ones are one line a day for that venue
(`payment:check:many:<venue>:<day>`), cleared when the venue's last payment is checked. The list stays the record and the alert moves no money.

**A payment after the booking's hold was let go** (owner decision DEC-14: do not revive).
At settlement a booking whose hold has run out counts as lapsed whether or not the
scheduler has let it go yet, so the outcome does not depend on the tick. Late is judged
by when the payer paid, as the gateway's signed report says (Billplz's `paid_at`; else the
moment it is reported), so a payment made inside the hold is not late because the callback
came slowly; one made after it is, however soon it is reported. The payment is not
taken into it, any lapsed hold is let go at once (the waiting list is offered the slot), and
the payment is recorded as *paid after the hold was let go*, all of it owed back. The
reservation is never recreated and no slot is taken from anyone who booked it meanwhile; a
new booking is made through the ordinary availability and consent flow. Applies to a payment
for a whole booking, a weekly series and a deposit, and so to a class place, which is a
booking. A booking made on approval keeps its own rule
([above](#paying-online-to-hold-a-booking)). The payer is told: the return page says the
booking was **not confirmed** and the money is owed back, and, when the booking's email is
one its account has proved, an email says so once (`payment_not_applied`); otherwise staff
see *no usable contact*. Memberships, passes, vouchers and top-ups hold no scarce place, so
a late payment for one is still issued, as before. Billplz refunds are by hand.

The keys are encrypted in the database, which is the file that gets backed up
and copied off the machine. The key that unlocks them is `MYSENAM_SECRET`, or,
when that is unset, one generated into `secret.key` in the data folder —
never in the database. A backup restored onto another machine without that key asks
for the venue's payment keys to be entered again instead of handing them over.

### A membership paid online

A membership is made only when its payment settles
([joining online](pricing.md#joining-online)); until then the purchase
waits and holds the people it names for an hour (`HOLD_MINUTES` in
`src/lib/membership-purchases.ts`). That hour is fitted to each gateway's
payment page (the owner's decision of 27 October 2026), as each gateway's
adapter says it can (`pageExpiry` in `src/lib/gateways/types.ts`):

| Gateway | Its page | The hold |
| ------- | -------- | -------- |
| **Stripe** | Asked to close when the hold ends (`expires_at`; Stripe allows 30 minutes to 24 hours, so the hour fits) | Kept until the page closes (`page_closes_at`, migration 0194), never shorter |
| **Billplz** | Cannot be closed at a set time: a bill stays payable until it is paid | The hour all the same: plans have no cap on members, so the hold reserves nothing scarce, and keeping it as long as the bill could be paid would hold the people it names for good |

A gateway whose page could only close later than the hour would have the
hold kept until it does; one that cannot close pages keeps the hour.

- **The hold lapses on its own**, on the scheduler's tick (and whenever a
  new purchase is made): the purchase is *released* and holds nobody. It
  never makes a membership: only money coming in does.
- **Money after the hold** (a Billplz bill paid later, or a Stripe payment
  method that confirms after the page closed, reported by
  `checkout.session.async_payment_succeeded`) is settled like any other: the
  people and dates are checked again, and the membership is made if it still
  can be. If it cannot (another purchase for the same people was paid
  meanwhile, the account no longer acts for them, or the account was
  deleted), the payment is *owed back*: listed under *Refunds owed*, refunded
  through Stripe in one click or in Billplz's dashboard and marked done,
  once ([refunds](#paying-online)). A Stripe page completed with the money
  still on its way releases the hold at once; the money, if it comes,
  settles as above.
- **Reported twice** (the callback and the customer's return, each
  repeated), it makes one membership, or is owed back once.
- **Refunded**: a manager cancelling a membership bought online can owe its
  payment back in the same change, in full; a chargeback lost cancels it
  ([chargebacks](#paying-online)). A refund made in the gateway's own
  dashboard without either is not seen here.

Tested against stand-ins for Stripe's and Billplz's APIs and signed callbacks
(`tests/membership-purchase-holds.test.ts`), never against the real gateways.

### A pass paid online

A pass bought online ([buying a pass online](pricing.md#buying-a-pass-online))
is an online payment of purpose `pass` (migration 0264). It holds nothing
while it is paid: passes are not scarce, so there is no hold, only the page,
which closes when a membership's would (Stripe after an hour; a Billplz bill
stays payable).

- **Issued once**, when the payment settles, in the transaction that claims
  it; the pass is named on the payment (`pass_id`). Its receipt is the
  pass's own, by *Online (gateway)*, so the return page's *Receipt* link,
  the sales journal, the cash-up (under online) and the consolidated
  e-invoice treat it as any other online sale.
- **Nothing issued**: a page that fails or expires is marked closed
  (`page_closed_at`) and not offered again; money that still comes in on it
  is settled as any other. Money that can buy nothing any more (the account
  or the person it was for gone, or the account no longer acting for them)
  is *owed back*, listed under *Refunds owed* as a pass.
- **Refunded**: a manager voiding it with money back owes the credited
  amount (its unused share) back on the payment in the same change
  (`oweBackPass`), refunded from *Refunds owed* through Stripe in one click or
  in Billplz's dashboard and marked done, once. A chargeback lost voids the
  pass and credits its receipt for what went back.

### Refunds that are interrupted

A refund through a gateway passes through steps, each written down before the
next, so a crash or a lost answer at any point is finished once and never
twice:

1. **Owed** — the cancellation (or the second payment) commits with the
   amount owed back on the payment, in the same transaction as everything
   else it changes.
2. **Asked** — the amount is claimed (`online_refunds`, a `claim:` row
   counted as refunded) and the transaction committed before Stripe is called;
   no database transaction is open while Stripe is asked. The request carries
   a stable idempotency key made from the payment and the amount owed, and the
   refund carries that key in its metadata.
3. **Accepted** — Stripe's refund id replaces the claim. A refund Stripe left
   *pending* is marked so, and shown as on its way.
4. **Outcome** — the scheduler asks Stripe about pending refunds at most
   hourly (`settlePendingRefunds`): one that succeeded is no longer on its
   way; one that failed is owed again (`failed_at`), raised by the integrity
   check as `refund_failed` ([monitoring](../operations/monitoring.md)) and
   listed for staff for 30 days. It is not resent on its own; asked again, it
   is a new refund under a new key (`…-r1`), since Stripe would otherwise hand
   back the failed one.
5. **Reconciled** — for every venue, whatever its refund policy. Each amount
   owed is noted when first seen, with the venue's policy at that moment.
   Those that need people — at a venue whose staff refund by hand, through a
   gateway with no refund API (Billplz), failed, or still owed after an
   automatic attempt — are put to the venue's staff in one email a day
   ("2 refunds waiting for you") and stay under *Refunds owed* until staff
   refund them with one click or by hand and mark them; a refund marked as
   made by hand leaves nothing owed, so nothing sends it again. The scheduler
   finishes what a crash left behind:
   - a claim with no answer for ten minutes is asked again under the same key
     (`settleRefundClaims`); before asking, it looks among the payment's
     refunds for one carrying the key, so a refund Stripe made a day ago, when
     Stripe no longer remembers the idempotency key, is recorded rather than
     made again;
   - an amount owed and never asked for, first seen while the venue refunded
     straight away and still so, is asked for ten minutes later, at most
     once a day (`reconcileRefunds`). One first seen while the venue's staff
     refunded by hand is never refunded automatically, even if the venue
     switches later: its staff were handling it. Disputed payments, failed
     refunds and the platform's own payments are left to people;
   - two runs at once, or a run that dies part-way, still record one refund.

Tested against a stand-in for Stripe that keeps its refunds
(`tests/refund-crash.test.ts`, on PGlite and Postgres): a crash after the
claim, a crash before the claim, a lost answer with the key forgotten, the
database failing as the answer is written down, concurrent and interrupted
reconciliation, pending then succeeded, pending then failed, and (on
Postgres) that no connection is idle in a transaction while Stripe is asked.
Not verified against Stripe itself
([integrations](../roadmap/known-limitations.md#integrations-awaiting-live-verification-or-a-partner)).
Billplz has no refund API: its refunds are made in its dashboard and marked
done by hand.

### Refunds made by hand

Where staff refund by hand (Billplz, or a venue that chose *Staff refund it*):

- **The venue says how long it takes**, 1 to 30 days (7 unless changed),
  under *Cancellations, refunds and no-shows*. A refund is owed from when it
  is first seen owed (`refund_seen_at`), and due that many days later. That
  date is the venue's own policy. It is a promise to the customer, not a
  limit on what they are owed: it never shortens a period consumer law or
  the payment provider's rules require, and a refund past it is still owed.
  Whether a venue's period is compatible with those obligations is for the
  operator to check, not settled here. The date customers and staff are told
  is the venue's calendar date (`refundClock` takes the venue's time zone), as
  is the date a refund was made (`refundedOn`); whether it is overdue is
  counted to the minute (`tests/refund-local-date.test.ts`).
- **The customer is told the date** when they cancel ("by 27 October"), and
  can follow the refund afterwards by looking the booking up or in their
  account (`refundStatusFor`), in one of these states:
  - *owed*, and by when;
  - *overdue*, past the date, with a prompt to contact the venue;
  - *requested*: asked of the payment provider, no answer yet;
  - *processing*: accepted by the provider, not yet settled;
  - *failed*: the provider's attempt failed, so it is owed again and the
    venue is told;
  - *completed*: refunded, and when.

  Refunds through the gateway pass through the same states. They are told the venue
  may contact them for bank details: an FPX refund is a transfer to the
  customer's bank account, and MySenam does not collect account numbers.
- **Staff see each one's age** under *Refunds owed* — owed so many days, due
  by a date, or *Overdue* in red — and a manager marks each done with the
  reference of the transfer or the gateway's refund, kept with the refund
  (`online_refunds.note`) and in the activity log with who did it. What is
  owed is re-read and settled in one transaction, so a second click or two
  people at once record it once.
- **Overdue refunds reach the dashboard**: the *Needs attention* panel lists
  each venue's overdue count, amount and oldest age; the daily reminder to
  the venue's staff says how many are past the date.
- **The work is counted**: *Refund workload* shows, month by month, how many
  refunds staff made by hand, for how much, how many days they took on
  average and how many were late, against those made automatically; the
  platform's owner can read it for every venue together
  (`GET /api/admin/online-payments?workload=all`). That is the evidence for
  keeping a gateway without a refund API, or moving to one with
  ([launch providers](../integrations/launch-providers.md#hitpay-for-small-malaysian-venues)).

Tested in `tests/manual-refunds.test.ts` on PGlite and Postgres, against a
stand-in gateway.

### Refunds made in the gateway's dashboard

A venue's staff (or the platform's owners) can refund a Stripe payment in
Stripe's own dashboard, without MySenam asking. Stripe tells the venue's
webhook (`charge.refunded`, and `charge.refund.updated` as a refund moves
on; add them to the endpoint's events), and MySenam reads back every refund
on that payment from Stripe with the venue's key
(`recordGatewayRefunds` in `lib/payments.ts`, `gateway_refunds`, migration
0222):

- **A refund MySenam made is never counted twice.** Each one it asks for
  carries its own key (`mysenam_key`); one made before refunds carried a key
  is known by its id. Those are left to the refund path that made them.
- **Anything else that has gone through is written down once**, by Stripe's
  id, however often or at once it is reported, under the payment's row lock,
  and matched in this order: a refund staff marked as made by hand on that
  payment for the same amount and with no reference from Stripe yet (the same
  money: the mark now carries Stripe's id); else what is owed back on the
  payment (a booking or membership the venue cancelled with a refund),
  recorded as that refund, made in Stripe, so it is not owed or asked for
  again; the rest is money nothing in MySenam owed.
- **Nothing else changes by itself.** No booking or membership is
  cancelled, unpaid or shortened, and no receipt changes for the part nothing
  owed: only the venue knows what it was for. Staff (the platform's owners,
  for what a venue paid the platform) are emailed, it is in the activity log
  (*A refund made in the payment gateway's own dashboard was recorded*,
  under *Stripe*), and the integrity check lists it for 30 days as
  `refund_unasked` ([monitoring](../operations/monitoring.md)).
- **It counts towards what is owed later.** If the venue then cancels what
  it was for, what Stripe already gave back is taken as that refund (cancel
  by the venue, the one-click refund, a hand mark and the daily
  reconciliation each take it first), so Stripe is never asked to give the
  same money back twice; only the rest goes to Stripe.
- A refund still pending is written down once it succeeds (Stripe reports it
  again then); one that failed or was cancelled is not money back.

Billplz has no refund API and reports no refunds, so there is nothing to
read: its refunds are made in its dashboard and marked by hand, as above.
Tested in `tests/stripe-gateway-refunds.test.ts` against a stand-in for
Stripe only; the Stripe check is still to be passed against Stripe itself
([integrations](../roadmap/known-limitations.md#integrations-awaiting-live-verification-or-a-partner)).

### Cancelling a booking paid at the counter

Staff cancelling a booking are first shown what cancelling it would do
(`POST /api/admin/bookings/cancel` with `preview`; `src/lib/counter-refunds.ts`):
what was paid towards it, how and when, any deposit paid online, and the
venue's terms as a customer cancelling now would meet them (free up to the
cutoff; past it, the share the venue keeps of a late cancellation, or that
customers cannot cancel late at all). Staff may still cancel past the cutoff
and while it is being played, and choose how what was paid is settled:

- **Back the way it was paid.** A counter payment (cash, QR, transfer, card
  terminal, or a tick whose method was never recorded) is handed back from
  the till. The booking's credit note says how, and the payout is written
  down (`counter_payouts`, migration 0231: the amount, the method, the
  credit note, the member of staff and when), listed for the till under the
  day's bookings as *Handed back at the counter* (`payouts` on
  `GET /api/admin/bookings`) and in the activity log (`payment.paid_out`).
  Credit goes back to credit and a pass to the pass; money paid online is
  owed back on the payment and refunded at once where the venue refunds
  through its gateway, as every staff cancellation already did. Where a
  request names no outcome, this is what happens.
- **As stored credit.** A counter payment is given as credit on the account
  the booking was made from (a `wallet_entries` row with the booking and the
  member of staff), the credit note saying *Stored credit*; nothing leaves
  the till. Not for a booking made without an account, and not for money
  paid online, which staff send back to the card
  ([business rules](../product/business-rules.md)).
- **Keeping the venue's late share.** Only past the cutoff where the venue
  keeps a share of late cancellations: the booking is recorded as a late
  cancellation at that share (a paid one is no strike), the credit note is
  for the rest, and the rest goes back the way it was paid (a payout for the
  rest, at the counter). A share is never kept where the venue's terms keep
  none.

**Who gives it back.** The front desk gives back its own counter takings of
the day; a counter payment marked on an earlier day is a manager's to give
back, whichever way, as taking one back with *Mark unpaid* is. Bookings
paid online, with credit or with a pass are cancelled by the desk as before.

It is the cancellation and the refund every staff cancellation was
(`adminCancelBooking`, `refundBooking` in `src/lib/store.ts`), not a second
refund engine: the outcome only says what share goes back and records where
the counter's money went. The booking is claimed in one statement and
settled in the same transaction, so two members of staff cancelling at once
settle it once; what goes back is worked out again as it is cancelled, and
refused if it is not what staff were shown (`expectRefund`). The customer's
cancellation message says what the venue kept, or that it went to their
credit, where not all of it went back as paid. A weekly series is cancelled
the same way, week by week on each week's terms
([cancelling a weekly series](booking.md#cancellation-and-no-shows)).
Closed days, outages, rain-outs, the venue's API key and a class called off
cancel without asking staff booking by booking; what was paid at the counter
on them is owed back ([owed back after the venue cancels](#owed-back-after-the-venue-cancels)).
So is what a customer paid at the counter and then cancels themselves
([owed back after a customer cancels](#owed-back-after-a-customer-cancels)).

Tested in `tests/counter-refunds.test.ts` on PGlite and Postgres: each
outcome, the desk and the manager, a booking paid online, a changed amount,
and two cancellations at the same moment (one settles; one payout or one
credit, never both).

### Owed back after the venue cancels

Closing a day, taking a court out of service, a rain-out, the venue's API key
cancelling a booking, and calling off a class (its enrolments) cancel
bookings in bulk, through the same cancellation and refund as a staff one
(`venueCancel` and `cancelClassSession`; `src/lib/counter-refunds.ts`), with
all of what was paid going back, and nobody is asked booking by booking.
Money paid online, with credit or with a pass goes back as the venue's
[policy for what it cancels](#paying-online) has it (online: through the
gateway where it can refund, else owed on the payment). Money paid **at the counter** (cash, QR, transfer, card terminal, or a
tick whose method was never recorded) has not left the till, so it is not
written down as given back: it is **owed back** (`counter_refunds_owed`,
migration 0258: the amount, how it was paid, and what cancelled it), and no
credit note is written yet.

- **Listed for staff.** The day list shows every counter payment still owed
  at the staff's venues, whatever day it was for (*Owed back at the counter*;
  `owed` on `GET /api/admin/bookings`), with the booking, the customer, how it
  was paid and why it was cancelled.
- **Seen without opening the list** ([ADR 0076](../architecture/decisions/0076-three-operator-visibility-gaps-the-heartbeat-a-payment-mismatch-and-counter-refunds-owed.md);
  `src/lib/counter-owed-visibility.ts`). *Needs attention* has a line, `counterOwed` on `GET /api/admin/attention`, for the venue's staff (the
  desk too) and the owner for every venue: per venue how many counter payments are owed back whatever the cause (a customer's
  cancellation, a place taken off, a closure, outage, rain-out, API, class, test, lesson moved, a move to a cheaper time), the sum,
  the whole days the oldest has waited and how many have waited `REFUND_OVERDUE_DAYS` (2) or more (red if any, else amber); no
  customer name. Once per venue per venue-local day, from 09:00 on the venue's clock, the scheduler's short unit queues **one message**
  to the venue's managers (and its business's managers; the front desk is not written to) with the same counts, the sum and the
  oldest age, no customer or booking. The outbox's key `counter-owed:<venue>:<day>:<email>` makes it once a day across restarts,
  repeated ticks and two servers; nothing is sent when nothing is owed. **No message and no line settles anything**: a row leaves
  only through *Handed back* or *Give as credit*.
- **Settled when the customer comes**, as a staff cancellation settles
  (`POST /api/admin/bookings/owed`): *Handed back* the way it was paid (its
  credit note and a counter payout written then, by the member of staff
  handing it back, so it is in that day's payouts and cash-up under their
  name; `payment.paid_out`), or, for a booking made from an account, *as
  credit* on that account (a `wallet_entries` row with the member of staff,
  the credit note saying *Stored credit*; `payment.owed_credited`). Who
  settled it, how and when are kept with it.
- **Who.** The front desk hands back a counter payment taken today; one taken
  on an earlier day is a manager's, as when staff cancel.
- **Once.** The owed row is claimed as it is settled, in the same transaction
  as the credit note and the payout: two members of staff at once settle it
  once.
- **The books.** The booking's receipt stands until it is settled; the
  credit note is dated the day the money goes back. Until then the money is
  in the till and the list shows it as owed.
- **A tournament entry fee taken at the counter** is owed back the same way when the venue calls the
  tournament off, or takes the entrant out before the draw where the tournament's rules refund before the draw
  (`counter_fee_refunds_owed`, migration 0304; ADR 0059; [entry fees taken at the
  counter](tournaments.md#entry-fees-taken-at-the-counter-owed-back)): written down at once, listed under the
  same *Owed back at the counter* panel (`feesOwed` on `GET /api/admin/bookings`), settled with
  `POST /api/admin/bookings/owed` and `kind: "entry_fee"` (handed back the way it was paid, the credit note on the
  entry's receipt written then, who and when kept, `payment.paid_out`), once, the front desk only for a fee taken today.
  Nothing is paid out automatically. A box league's place fee is not covered here yet (known limitations).
- **A pass or a membership sold at the counter and cancelled with a refund** is on the same list
  ([ADR 0068](../architecture/decisions/0068-money-hardening-credit-notes-are-not-cash-spent-is-money-paid-and-the-till-lists-every-payout.md); `counter_fee_refunds_owed`, migration 0326, with a `pass_id` or `membership_id`
  where an entry fee has a `tournament_entry_id`). The manager's *refund the unused part* writes the credit note as it always
  did (it is the tax document, dated that day and in that day's cash-up as given back), and now also writes the amount as **owed back**:
  *Refunds of passes and memberships sold at the counter, still to hand back*, with the holder, the pass or membership, how it was
  paid and the credit note's number. **A credit note is not cash paid**: nothing is handed over until a named member of staff
  says so (`POST /api/admin/bookings/owed`, `kind: "entry_fee"` with the row's id), and the list says it in those words. The entries a
  cancelled booking later gives back to a pass that was cancelled with a refund, handed back as money (a credit note per spend), are
  written the same way. One row per credit note, so a repeat writes nothing twice; two members of staff settling at once settle it once;
  the front desk hands back a refund written today, a manager one from an earlier day; another venue's staff see and settle nothing of it.
  Only money taken at the counter is handed back across the desk: a pass bought online is owed on its payment (*Refunds owed*,
  as before), one bought with stored credit is not a counter payout. Refunds written before this change are not turned into
  tasks (nobody can say whether the money was handed over); their credit notes stand as they always did.
- **Every money handed back at the counter is in one list.** The day's payouts on the bookings screen (*Handed back at the
  counter on…*, `payouts` on `GET /api/admin/bookings`, each with a `kind`: `booking`, `entry`, `pass` or `membership`) hold a
  booking's payout and, once settled from the owed list, an entry fee, a pass's refund and a membership's, each with how it
  was paid, the credit note, who handed it back and when. Settled, an entry fee's credit note is in that day's cash-up under
  the method it was paid by, so the payout list and the till agree (`tests/counter-payouts-owed.test.ts`). Taking an entry's
  *paid* mark off by hand still credits it directly, as a booking's *Mark unpaid* does: that is the undo of a mistaken tick, in the
  cash-up as a credit note, not a payout.
- **A test booking cleared as real money** is owed back the same way (cause
  `test`, added to the cause check by migration 0259): a manager clearing the
  [test bookings](../product/marketplace.md#test-bookings-before-going-live)
  of a venue before it goes live who says real money was taken at the counter
  writes each counter payment here instead of reversing it, so the list shows
  it although the booking is a test, and settling it writes its credit note and
  payout as for any owed refund (`tests/test-bookings-money.test.ts`).

Tested in `tests/counter-owed.test.ts` on PGlite and Postgres: each of the
five ways the venue cancels, both ways of settling, the desk and the manager,
another venue's staff, two settling at once, and the cash-up of the day it was
handed back; the screen in `tests/components/owed-series-move.test.tsx`.

### Owed back after a customer cancels

A customer cancelling a booking they paid at the counter (cash, QR, transfer, card terminal, or a tick whose method was never recorded) used to
get a credit note and nothing else: no task for staff, no payout, and the credit note was taken for the refund. Now the money is **owed back**
on the same list as the venue's own cancellations leave (`counter_refunds_owed`, migrations 0346 and 0347,
[ADR 0074](../architecture/decisions/0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md); `oweCounterToCustomer`
in `src/lib/counter-refunds.ts`), written in the cancellation's own transaction:

- **Every customer path.** The customer's own cancellation (by code and phone, and from their account), a week of a weekly series, a class place
  they cancel, a booking cancelled because they closed their account, and a person they (or the venue's API key) took off a paid booking
  ([refunds for one person's place](#refunds-for-one-persons-place)). Cause `customer_cancelled`, or `place_withdrawn` with one row for each
  withdrawal. What the venue itself cancels keeps its own cause and rules ([owed back after the venue cancels](#owed-back-after-the-venue-cancels));
  a customer's cause is never added on top of those.
- **How much.** What the booking's own counter payment still holds, less the venue's late share where the customer cancelled late. The share is the
  one in the terms the booking was **sold on** ([ADR 0069](../architecture/decisions/0069-the-terms-a-booking-was-sold-on-govern-it-arrival-goes-to-staff-and-edits-meet-bookings-in-one-transaction.md)):
  a policy edit afterwards changes nothing already sold. A deposit paid online goes back online as before; only the counter part is owed here. A
  booking moved to a cheaper time and then cancelled has two obligations (the move's difference and the rest), both settleable, together what was paid.
- **The credit note is written as it always was, and is not the refund.** It is the tax document and the till's record of the cancellation. Nothing
  is paid out, and nothing is marked paid, until a named member of staff says so. The list, the panel and the customer's message say so in those words.
- **Listed for staff** under *Owed back at the counter* (`owed` on `GET /api/admin/bookings`): the customer and booking code, the amount, how it was
  paid, why, the day it arose, its status (*owed*, then *completed* once handed back), the credit note's number, whether the customer has been told, and
  what to do. Not paid at the counter (unpaid, online, credit, a pass, an account) writes nothing.
- **Settled once** (`POST /api/admin/bookings/owed`): *handed back* (a payout for the till: the amount, who, when, the method used and the credit note
  written at the cancellation, which is linked and **not written again**; `payment.paid_out`) or *as stored credit* on the booking's account
  (`payment.owed_credited`). The front desk hands back a payment taken today and a manager an older one. The customer may agree to be handed it another way
  than they paid (cash, QR, transfer or card): the request carries `via`, the method used is recorded beside the one it was paid with (`settled_via`) and
  the log says it was not the way it was paid. Two members of staff at once settle it once; a second go is refused.
- **The customer is told.** The cancellation response and message say "the venue will return RM x to you at the counter, where you paid it; it has not
  been returned yet" (`how: "counter"` in `refunds`; customer text `rf74.refundCounter` in English, Malay, Chinese and Tamil), by email or WhatsApp where
  they left an address, and never that the money was returned. The row records when they were told (`customer_notified_at`); with no address it stays
  empty and the panel asks staff to tell them at the counter.
- **The till.** The credit note is the record of the cancellation, in the journal on the day it was written, under the method it was paid by, with no member
  of staff on it. It is **not** cash leaving the till: the cash-up lowers the till by the payout, on the day it was handed over and by the method used
  ([cash-up](#cash-up), [ADR 0075](../architecture/decisions/0075-the-till-is-compared-with-cash-received-and-cash-handed-back-and-a-credit-note-is-not-a-payout.md)),
  and shows the refund as *still owed back* until then.
- **Past cancellations** are not turned into tasks (nobody can say whether the money was handed over then, and a refund must not be paid twice).
  `scripts/reconcile-counter-cancellations.sql` is read only and lists the candidates for a manager to review: cancelled, paid at the counter, a credit
  note, no owed row, no payout, no credit given by staff, not logged as cancelled by a member of staff.
  Run it with `psql "$DATABASE_URL" -f scripts/reconcile-counter-cancellations.sql` (add `--csv` for a spreadsheet); a row is a lead, not a proof.
  Its columns are the review table: `venue`, `booking_code`, `cancelled_on` (the credit note's date on the venue's calendar), `amount_possibly_owed`,
  `paid_with`, `payout_evidence` (the activity log's `payment.paid_out` or `payment.owed_credited` for the booking, or *none found*), `possible_duplicate`
  (other credit notes on the booking, or stored credit added for it, or *no*), `staff_action` and `credit_note`. It names no customer and creates no task.

Tested in `tests/customer-cancel-counter-owed.test.ts` (each customer path, a late share on the terms sold, an edit of the policy afterwards, the
deposit, the withdrawals, the message, settling once and twice, an alternative method, credit, the desk and the manager, another venue's staff, a double
submit, the customer against staff, against the desk taking the payment back, a cheaper move then a cancellation, the closure, the cash-up and the
reconciliation script) on PGlite and Postgres, and `tests/customer-cancel-counter-owed-migration.test.ts` (the migrations on an install with money
already owed). A mock gateway is not a live check; the counter is not a provider, and nothing here contacts one.

### Refunds for one person's place

Taking one person off a paid booking, the others staying booked
([taking one person off a booking](booking.md#taking-one-person-off-a-booking);
`lib/place-withdrawals.ts`), gives back that place's price as charged (its
share of the court time, less its own member price, concession and recorded
share of a promo code: [discounts together](pricing.md#discounts-together)),
on the venue's cancellation terms (a late withdrawal keeps the venue's share),
through the paths a cancellation uses, and nothing twice:

- **The booking's sale stays as it was sold.** Its receipt is drawn from the
  booking and does not change; what went back for the place has a credit
  note of its own (*Alya, taken off MS-…*), at the tax the booking was sold
  at. The place's price is recorded with the withdrawal
  (`place_withdrawals.price`), and a later cancellation of the booking gives
  back only the rest: its credit note, credit and online refund are of what
  is left (`paidPartLeft`), never more than was paid.
- **Credit** goes back to the pots it came from, in proportion, as entries
  marked with the withdrawal (`wallet_entries.withdrawal_id`), apart from the
  booking's own refund on cancelling.
- **Online**, the amount is owed back on the payment, never more than it
  took, and sent through the venue's refund path at once
  ([refunds that are interrupted](#refunds-that-are-interrupted)): to the card
  through Stripe, to credit, or owed by staff, as the venue chose.
- **Paid at the counter**, the credit note is written and the venue's staff
  give the money back. When the customer (or the venue's API key) takes the
  person off, the money is written down as owed back at the counter, one row
  for the withdrawal (`place_withdrawn`, [ADR 0074](../architecture/decisions/0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md)),
  settled like any other ([owed back after a customer cancels](#owed-back-after-a-customer-cancels));
  staff at the counter hand it over themselves as they take the person off.
- **A pass** spent for that place gives back its entries (whole entries,
  rounded down on a late withdrawal); one that paid for the booking as a
  whole gives back nothing for one person.
- **Not yet paid**, the place's price comes off what is owed instead, and
  the code's use comes down by exactly that place's recorded share
  (`place_withdrawals.promo_share` keeps it either way).
- **Held by a deposit**, the price comes off what the booking costs, off the
  balance still owed first. Only what was paid beyond the new total comes
  out of the deposit: it goes back to the deposit's online payment, on the
  venue's cancellation terms (a late withdrawal keeps the venue's share of
  that part; the part off the balance is never charged), with a credit note
  on the deposit's receipt; the booking's deposit is then what is left
  (`bookings.deposit_paid`). A booking paid in full after its deposit keeps
  its price as sold, and the place is settled from the part paid last (the
  rest, the way it was paid, with its own credit note) and then from the
  deposit. What came out of the deposit (`place_withdrawals.deposit_part`,
  and `deposit_refunded` of it back) is left out of a later cancellation,
  which gives back only the deposit left.
- **Charged to a company or school account**, before the month's invoice
  the price comes off the booking's charge; after it, the invoice stays as
  issued, and the place's price on the venue's cancellation terms is a
  credit note on the account, taken off its next invoice
  ([company and school accounts](#company-and-school-accounts)).
- **Refused**: a booking other players paid shares of (a split share or an
  open game's), each share worked out from the whole price; part of it paid
  online that is no deposit of the booker's; a payment page open, its own or
  a friend's share ([taking one person off a booking](booking.md#taking-one-person-off-a-booking)).

Tested in `tests/place-withdrawals.test.ts`,
`tests/place-withdrawals-money.test.ts` (deposits, accounts, splits) and,
with a concession and a code on the booking,
`tests/discount-stacking.test.ts`, on PGlite and Postgres, against a
stand-in gateway for the online case.

### Refunds for a cheaper coach

A paid lesson a manager gives to another coach, choosing to adjust the price
([giving a lesson to another coach](programmes.md#giving-a-lesson-to-another-coach);
`lib/lesson-coaches.ts`), settles the difference between the two coaches'
fees the way a place taken off a booking is settled, and nothing twice:

- **The lesson's sale stays as it was sold.** Its receipt keeps the coach and
  fee it was sold with. What went back has a credit note of its own
  (*Coaching with Cara Ong in place of Ana Lim, MS-…: the difference*), at the
  tax the booking was sold at; a later cancellation gives back only the rest
  (`paidPartLeft` leaves out `lesson_coach_changes.refunded`).
- **Credit** goes back to the pots it came from, in proportion, as entries
  marked with the change (`wallet_entries.coach_change_id`), apart from the
  booking's own refund on cancelling.
- **Online**, the amount is owed back on the payment, never more than it took,
  and sent through the venue's refund path at once
  ([refunds that are interrupted](#refunds-that-are-interrupted)).
- **Paid at the counter**, the credit note is written and the venue's staff
  give the money back.
- **A dearer coach's difference** is owed, not charged: paid once, at the
  counter or, where the venue takes payment online, on the venue's payment
  page ([paying a dearer coach's difference online](programmes.md#paying-a-dearer-coachs-difference-online)),
  on a receipt of its own (`lesson-coach:<id>`, under *Coaching* in the sales
  journal). A second payment for it (the counter took it meanwhile, it was
  paid on another page) or one after it stopped being owed (the lesson
  cancelled, or given to another coach again) is owed back on that payment
  with no receipt, as any second payment is, and refunded once through the
  refund paths here. A lesson cancelled after it was paid has that receipt
  credited too, and the money goes back the way it was taken: by hand, or
  owed back on its online payment; one cancelled before owes it no longer.
  The day's expected figure counts it once owed, collected once paid.
- **Kept as paid** instead, nothing moves: the venue absorbs the difference
  and the amount is recorded with the change.
- Lessons paid with a lesson pack, with a deposit, or with shares others paid
  are refused: cancel and book again.

Tested in `tests/lesson-coach-changes.test.ts` and, for the difference paid
online, `tests/coach-difference-online.test.ts`, on PGlite and Postgres,
against stand-in gateways for the online case.

### A paid booking moved to a cheaper time

A booking paid in full and moved to a time or court that costs less
([changing the date or time](booking.md#changing-the-date-or-time); the
owner's decision DEC-16, [ADR 0067](../architecture/decisions/0067-a-paid-booking-moved-cheaper-gives-the-difference-back-and-a-move-never-silently-changes-a-discount.md);
`src/lib/move-money.ts`) gives the difference back by the way it was paid, in
the move's own transaction, and shows it before the move is confirmed. The
booking's price and its receipt stay as sold; each move that returns money is a
row of `booking_move_refunds` (migration 0324), added and never edited, which
`paidPartLeft` takes off what a later cancellation gives back, so the total
returned is never more than was paid, however often the booking moves.

- **Paid online:** owed back on the payment, never more than it took, with a
  credit note on the booking's receipt, and sent through the venue's refund path
  the moment the move commits: Stripe through its refund call (once, keyed on
  what has been owed in all); Billplz, or a refusal, stays under *Refunds owed*
  for staff with its due date ([refunds made by hand](#refunds-made-by-hand)),
  never said to be refunded. Never credit the customer did not choose, whatever
  the venue's setting for money paid online that a customer cancels.
- **Paid at the counter** (cash, QR, transfer, card, or a method never
  recorded): owed back at the counter, on the same list as money owed after the
  venue cancels (`counter_refunds_owed`, cause *a paid booking moved to a cheaper
  time*, migration 0325, one row for each move), settled when the customer comes:
  handed back the way it was paid (a payout in that day's cash-up) or, at the
  customer's request and for an account, as stored credit. The credit note is
  written then. Only the difference is settled, never the booking's price; the
  front desk hands back only a payment taken today.
- **Paid from stored credit:** back to the pots it was taken from, in
  proportion, as entries marked with the move (`wallet_entries.move_refund_id`),
  apart from the booking's own refund on cancelling, with a credit note.
- **Paid with a pass:** no money moves; the same entries cover the same length.
- **Charged to a company or school account** whose invoice is issued (paid or
  not): the invoice stays as issued and the difference is a credit note on the
  account ([company and school accounts](#company-and-school-accounts)).
- **Refused, the booking staying where it was**, rather than left unsettled:
  friends' or players' shares paid (`MOVE_DIFFERENCE_SHARED`; staff may keep
  the difference instead), a price at the new time below what a deposit or
  shares paid (`MOVE_DIFFERENCE_BELOW_PAID`), a payment or credit that cannot be
  found (`MOVE_DIFFERENCE_UNTRACED`).
- **Who may keep the difference:** only a manager. A customer's move always gives
  it back (they can move only before the cancellation cutoff). Staff's move gives
  it back by default before that cutoff and keeps it after (the desk's default
  too), and staff can say which (`difference`; the front desk cannot choose to keep
  it, `MOVE_KEEP_MANAGER`); keeping it is in the activity log with the amount. The
  customer's notice of the change says what goes back and how, instead of "same price".

Tested in `tests/move-cheaper.test.ts` (PGlite and Postgres),
`tests/move-cheaper-stripe.test.ts` (a stand-in for Stripe: what MySenam asks
of the gateway, not that Stripe refunds it) and, for the migrations,
`tests/move-cheaper-migration.test.ts`.

### Receipts for a guardian

A guardian paying for children (ADR 0023; [booking for somebody
else](booking.md#booking-for-somebody-else)) is the purchaser: the receipt
is billed to the booking's customer, the account that booked and paid, and
the children are named only to say which place is whose.

- **One booking for several children.** The court-time line says whom its
  places are for, in the order they were put on the booking (*Pool
  (Swimming), … 9:00 AM–10:00 AM, 2 players, for Alya, Bilal*; the customer
  too where they take part). Each child's own price is a line of its own
  naming them (*Child (under 12) price, Bilal*), and a booking-wide code
  stays one line; the lines add up to the total. How much of the court time
  is each place's is the one calculation in `placeShares`
  (`src/lib/entitlements.ts`), which a withdrawal gives back
  ([refunds for one person's place](#refunds-for-one-persons-place)).
- **A booking each** (a class enrolment each, or a court each): each
  receipt names its own child and never the other.
- **An adult's own booking** names nobody, and reads as it always did.
- **Sent to the payer only.** The receipt email goes to the booking's email
  address, nobody else's: another guardian of the same child is not sent
  it (no notification rule says so). It names whom the booking is for, as
  the confirmation does.
- **Nothing more about the children than their names**: no birth year,
  date of birth or anything else they were recorded with.
- **In the reader's language.** The line's words and hours are said in the
  language of whoever opens the receipt, and the receipt email, its link
  opening in that language, in the language the booking was made in
  ([regions](../product/regions-and-tax.md)); the amounts, the line as
  stored and the books are the same for everybody.
- **The children's names are kept apart from the words**, on the receipt
  and on every credit note and kept receipt written from it (whom the court
  time is for, whose place a price was, who was taken off, whom a membership
  covers), so they go when the install stops keeping names, when the
  guardian's account is erased, and, one child's, when that child is
  erased; the amounts and tax stay
  ([privacy](../architecture/privacy.md#receipts-and-credit-notes)).

Tests: `tests/guardian-receipts.test.ts` (two children on one booking with
one child's concession, a booking each, an adult's own; the payer, the
recipient, no birth year, the four languages), on PGlite and Postgres;
`tests/receipt-names.test.ts` (the names cleared by retention, the
guardian's erasure and a child's, and again after a restore).

## Stored credit

Customers buy credit at a venue counter and spend it on bookings and classes by
ticking *Pay from my credit balance*.

It is held as an **append-only ledger** (`wallet_entries`) rather than a balance
column: every movement keeps its reason, the booking it relates to and the
operator who sold it, and the balance is their sum. That makes the money
auditable and means no code path can quietly overwrite a total.

Three guards matter, and each has a test:

- **The balance is re-read inside the payment transaction**, so two concurrent
  bookings cannot overdraw it — a short balance is refused and nothing is
  written to the ledger.
- **A refund can only be claimed once per booking**, so cancelling twice cannot
  mint credit.
- **Paying from credit is best-effort at booking time.** An empty wallet leaves
  the booking standing as unpaid with a `walletError` (and its `walletErrorCode`)
  explaining why, rather than throwing the booking away; it stays held where
  the venue holds, and can be paid or let go as any unpaid booking. The booking
  form's confirmation says so in the customer's language (*your credit or pass
  was not used, nothing has been paid, RM30 is still to pay*).
- **Paying is decided with the booking's status, in the paying transaction.**
  Credit and pass payments read the booking under its row lock and refuse a
  cancelled one (`BOOKING_WAS_CANCELLED`) before anything is debited, and
  `claimPayment` only marks a confirmed booking paid, so credit or entries are
  never taken for a booking that is cancelled meanwhile (by staff, the
  customer, a closure or the hold sweep); one cancelled just after is refunded
  by the usual paths. The price charged is the one the booking has when it is
  read there.
- **Nothing is charged at a price the customer did not accept.** A promo code
  or concession that was asked for and refused (the last use went meanwhile),
  on a request that settles at once (credit, a pass, the counter, an account),
  is a refusal (`DISCOUNT_NOT_APPLIED`): nothing is booked or charged. And a
  booking request may carry `expectedTotal` (whole cents, over all the bookings
  it makes): where they now cost another price (`PRICE_CHANGED`, with the price
  now), nothing is booked or charged. The booking form sends the total it
  showed, not for a weekly booking, a court picked for the customer or a
  concession; after a `PRICE_CHANGED` the customer reads the new price and
  pressing Book again accepts it.

Cancelling a wallet-paid booking refunds it automatically, through every path:
by code, from an account, a whole series, an admin cancellation, and the
enrolments released when a class is cancelled.

Credit, a gift voucher (which becomes credit) and a pass are means of paying,
not discounts: they pay the price as it stands after member prices,
concessions and any promo code, and never change it
([discounts together](pricing.md#discounts-together)).

**E-invoicing is an open question for credit and vouchers.** Their sale is a liability in the
sales journal and the booking they pay is the sale, but the consolidated e-invoice carries both
(RM130 for RM30 of sales, audit C2). What it should do is a tax question for the venue's adviser,
not decided in code: see the [memo for the tax adviser](../operations/einvoice-stored-credit-memo.md).
Switching e-invoicing on at a venue that has sold either is refused unless its manager says they
understand ([MyInvois](../integrations/myinvois.md)).

### Whose credit it is

`MYSENAM_CREDIT_SCOPE` decides who owes the money customers have put on
account:

- **`platform`** (the default for a single business's own copy) — bought at any
  counter, spendable at any venue. The install owes it, which is right when
  every venue is one business's branch.
- **`venue`** (the default with `MYSENAM_MARKETPLACE=on`) — bought at a venue,
  spendable only there, owed by that venue and shown on its own report. A
  platform holding money strangers paid to other businesses is running a
  payments business, which in Malaysia may need a licence; this keeps each
  venue's customers' money with that venue. It is not legal advice — ask a
  lawyer before taking any money on behalf of venues.

A refund given as credit goes into the same pot a top-up at that venue
would. Switching from `platform` to `venue` shrinks nobody's balance: credit bought
before the switch stays spendable anywhere. A booking is paid from the venue's
own credit first and then from that older pot, a ledger line for each, and a
refund puts each line back where it came from.

### Topping up online

A signed-in customer can also buy credit from their account page, through
the venue's own gateway account (Billplz or Stripe), from the minimum online
top-up to `MAX_TOP_UP` (`src/lib/payments.ts`, `src/lib/types.ts`), to the
sen. The account page offers the venues they have booked at or hold credit
at that take payment online. The credit is written to the ledger as *Online
top-up* only when the payment is settled (by callback or the signed return
address, whichever comes first, and only once). If the account is deleted while
they pay, the payment is marked as owed back instead.

Online top-ups are only allowed where the money lands with whoever owes the
credit: per-venue credit on a marketplace, or any credit on a single business's
own copy. On a marketplace with `MYSENAM_CREDIT_SCOPE=platform` they are not
offered, since one venue would take money for credit that other venues honour.

### Gift vouchers

An amount somebody buys for somebody else (`lib/vouchers.ts`). Whoever holds the
code (`GV-XXXX-XXXX`, without 0/O or 1/I so it can be read out at a counter)
enters it under *Have a gift voucher?* on their account page, and it becomes
stored credit at the venue, credited the way an online top-up is. It works
once, and for a year.

- **At the counter** (*Credit → Gift vouchers*): amount, who bought it, and
  optionally their email, who it is for, a message and how they paid. It gets a
  receipt and a link to a printable voucher.
- **Online**, from *🎁 Give a gift voucher* on the venue page (`/venue/:id/gift`),
  where the venue takes payment online and online top-ups are allowed. No
  account is needed, only an email. The voucher is *pending* until the payment
  settles, so nobody can use it before then. It then becomes good, gets a
  receipt, and is emailed once to the buyer with its printable link. A payment
  whose voucher has gone is owed back.
- **The printable voucher** (`/gift/:code?t=…`) is reached only by its signed
  link. The code alone shows nothing, so guessing addresses finds no vouchers.
- **Receipts carry no tax**: like credit, a voucher is taxed when it is spent,
  on what it buys.
- **Cancelling** (managers only) works on a voucher nobody has used. Sold at
  the counter, its receipt gets a credit note and the money goes back by hand.
  Bought online, what was paid is listed under refunds owed.
- Redeeming is rate-limited like a booking lookup, so codes cannot be guessed
  quickly.

## Splitting the cost with friends

A booker who already has their group can split what a booking costs
(`src/lib/splits.ts`, migration 0062), without anybody needing an account:
on the booking confirmation and on My Booking, *Split the cost*, 2 to 10 ways
(the booker included), gives a link to send, with *Copy link* and *Send on
WhatsApp*.

- **Each friend** opens the link (`/split/<token>`), sees the venue, court,
  time, the booker's first name and their share, and pays it with their name
  and number on the venue's own payment page (purpose `split`). It counts
  towards the booking (`bookings.shares_paid`), as an open game's shares do,
  and each share has its own receipt. The page says how many shares are paid
  and stops taking payment once all are, or once the booking is paid,
  cancelled or has started.
- **The booker** pays the rest: *Pay online* asks only for what is left, or
  nothing once friends have covered it. A share is the total divided by the
  number of ways, rounded down to the cent; the booker's part takes the
  remainder. The number of ways can be changed until a friend has paid, and
  not while one is paying (their page asks the share it was opened with).
  Splitting is decided under the booking's lock: two splits at the same
  moment make one ([concurrency](../architecture/booking-concurrency.md#status-of-each-guarantee)).
- **Said up front:** the booking stays the booker's, so until it is all paid
  they owe what is left and the venue's cancellation rules apply to them; a
  friend is told they pay the venue directly, get a receipt, and are owed
  their money back if the booking is cancelled or every share was already
  taken.
- **Owed back:** a share arriving after every share was taken, or after the
  booking was paid in full or cancelled, is written down as owed back (with a
  credit note) and shows under *Refunds owed* for the venue's staff. When the
  booking is cancelled later, each share is owed back as the booker's payment
  is: all of it, or, cancelled late, what is left after the venue's
  late-cancellation fee, so the venue keeps its fee on the whole booking.
- Not for a booking held until paid (pay it first), a weekly series, a class
  enrolment, or an open game (whose players pay there). Search engines are
  kept off split pages.
- **One person taken off** the booking
  ([taking one person off a booking](booking.md#taking-one-person-off-a-booking))
  while no friend has paid: each share is worked out again on the new price.
  While a friend is paying, or once one has paid, nobody can be taken off on
  their own: a share is a part of the whole price, not anybody's place.

## Extras: rentals and sales with a booking

A venue lists what it hires out and sells — rackets, bibs, mats to hire;
shuttles, grip, drinks to buy — under *Venue details → Extras for sale or
hire*, each with a price and, for a rental, optionally how many it has. An
extra can be for one sport only (bibs with futsal) or any. Up to 20 at a time;
an extra is retired rather than deleted, so old bookings still say what they
had.

- **Offered, never chosen for the customer.** The booking bar and the class
  enrolment form show *+ Add extras* only when the venue has some, folded until
  tapped, with − / + for each. The price on the *Book* button includes them.
- **Rentals cannot be over-promised.** Stock is per venue per hour across
  confirmed bookings: with three rackets, a racket hired 8–10 pm is not there
  for another court at 9. The list says how many are left when five or fewer,
  and the server checks again before taking the booking, so a race ends in a
  clear "only 1 racket left" rather than a promise the desk cannot keep. A
  cancelled booking gives its rentals back.
- **On the booking's own price.** Extras go onto `bookings.total_price`
  (after any promo code, which is for the court), so they are paid online,
  from credit or at the counter with the court, refunded with it, and in the
  day's takings with no separate till. Each line is kept in `booking_addons`
  with the name and price at the time. A weekly series carries the same extras
  every week; a week whose rentals have all gone out stands without them and
  says so.
- **A pass is for court time.** Paying with a pass is refused for a booking
  with extras (the booking bar hides the pass when extras are chosen), so a
  ten-hour pass never quietly pays for drinks.
- **At the desk.** The day's bookings show 🎒 *2 × Racket (hire), 1 × Shuttle
  tube*, ready to hand over at check-in; the customer sees the same on their
  confirmation and under *My Booking*.

## Counter sales: selling with no booking

The desk sells a drink, a tube of shuttles, a grip or a racket hired by a
walk-in under *Credit & passes → Counter sales* (`src/lib/counter-sales.ts`,
`counter_sales`, migration 0057). Desk accounts can sell; voiding is for
managers.

- **What can be sold** is the venue's own list of extras, at its price (a
  rental shows as "(hire)"), tapped to add, plus anything typed in with a
  name and a price for the odd item not on it.
- **Paid at the counter**: cash, the QR scheme, a transfer or a card
  terminal, the same methods as a booking marked paid. A customer's name is
  optional.
- **Receipted at once**, with the venue's SST or GST inside the price as
  with everything else. The sale's receipt (`R-000123`) is one click away to
  print, and kept in the venue's book of receipts.
- **The day's sales** are listed below, newest first, with the total by how
  each was paid and who sold it, to count the till against.
- **Voiding** asks for a reason, warns that it does not refund anything, and
  writes a credit note against the receipt. The money goes back by hand.
- **Reports** show *Plus counter sales* under Collected, outside the booking
  figures. The accounting export has them as *Counter sales*, credit notes
  included, and they go into the monthly consolidated e-invoice where the
  venue e-invoices.
- **Not counted: stock.** The list says what is sold, not how many are left.

## How each counter sale was paid

Everything the desk takes money for says how: cash, the QR scheme, a bank
transfer or a card terminal (`COUNTER_METHODS`). A booking marked paid and a
counter sale always asked; so now do a credit top-up, a pass, a membership,
and a tournament entry fee or league fee marked paid (each refused without
one, `P8B_VIA_REQUIRED`, unless it is free). The method is written on the
receipt, and the receipt keeps who took the money (`receipts.staff_id`,
`staff_name`; a booking marked paid keeps it on the booking, `paid_by`,
migration 0234). Receipts written before this say *At the counter*, and are
shown as such. The forms start with no method chosen, so nothing is put down
as cash by default.

## Cash-up

*Credit & passes → Cash-up* (`src/lib/cash-up.ts`, `GET /api/admin/cash-up`)
is what a shift's till is counted against: for a day on the venue's
calendar, every receipt and credit note from every source (bookings paid,
counter sales, credit, passes, memberships, vouchers, entry and league fees,
money kept from deposits, credit notes for cancellations, voids and price
adjustments), summed by method: taken, given back and in hand, each way.
Below the totals, every entry in the order it was written, with its number,
what it was for, the customer, the method and who took or gave back the
money. *Print the cash-up* opens a sheet (`/admin/cash-up`) with lines for
who counted and who checked it.

- **It is the sales journal, not a second ledger**: the day's rows of
  `salesJournal` (lib/accounting.ts), so its figures are the journal's and
  the accountant's, row for row (`tests/cash-up.test.ts`). One addition:
  where credit is the install's own (`MYSENAM_CREDIT_SCOPE=platform`), credit
  sold over this venue's counter is in its till though not in its books, and
  is counted too (`receipts.counter_venue_id`). A
  [test booking's](../product/marketplace.md#test-bookings-before-going-live)
  receipt and credit notes, from before the venue went live, are **not added
  into those totals but are never dropped**: they are shown below in a block of
  their own, *Test bookings, from before the venue went live*, with its own
  lines by method and totals (`test` on `GET /api/admin/cash-up`, on the
  printout too), and one line saying that if any of it was real money the
  booking is kept as real, which moves it into the real totals
  (`tests/cash-up.test.ts`, `tests/test-bookings-money.test.ts`).
- **Money received and money handed back are counted on the day each happened** ([ADR 0075](../architecture/decisions/0075-the-till-is-compared-with-cash-received-and-cash-handed-back-and-a-credit-note-is-not-a-payout.md)).
  A customer who cancels on the 8th is owed RM30 on the 8th; staff pay it in cash on the 9th: the cash leaves the till on the 9th. So each till's
  *expected* amount is the journal's net, plus the credit notes of the day that only record a refund (a payout or an owed row points at them), less the
  refunds actually handed over that day by the method used (`counter_payouts` by `paid_out_at`, and the settled counter fee, pass and membership refunds),
  plus the hire deposits' part. The credit note stays in the journal as written (its date, number, tax and the table above are the accountant's, unchanged);
  it is only not counted as cash leaving the till, and the sheet shows the amount put back (`refundNotes`) and the amount handed back (`handedBack`) so it
  adds up. Every other credit note (a sale voided, a price adjusted, a place staff took off at the counter, a *mark unpaid*) is still a till movement.
  A refund paid by DuitNow and handed back in cash lowers the cash drawer, not the QR account. A refund settled as stored credit moves no cash. A payout from
  before payouts named their credit note is left to its credit note, so nothing leaves a till twice; an unrecorded method is in no till. A desk's own cash-up
  takes out the payouts it handed over (the customer's credit note names nobody, so none is put back there). Over the days a refund spans the total is unchanged;
  only the day each figure falls on moved.
- **Refunds, apart** (*Refunds: handed back and still owed*, `refunds` on `GET /api/admin/cash-up`, on the printout too): what was handed back that day, with the
  method used, the method the customer paid with and who handed it over; and what is **still owed back at the end of that day** (the obligation arose by then and
  was settled after it), by how the customer paid, why and since when, with a total. An unpaid refund is not money gone from a till. No customer is named. Tested in
  `tests/cash-up-refunds-across-days.test.ts` (the owner's example, DuitNow refunded in cash, a late share, a deposit, a cheaper move then a cancellation, a pass,
  settled twice and at once, staff cancelling at the counter, the venue's closures, stored credit, rows from before the link, a desk's own cash-up, another venue's)
  and `tests/components/cash-up-refunds.test.tsx`.
- **What is not money** is shown apart: a booking paid from stored credit
  already sold moves no money, and is left out of the total.
- **Hire deposits are in the drawer but are not takings.** Under the table,
  *Hire deposits held for customers* lists, by how each was held (cash, QR,
  transfer or card; recorded when the kit went out), the deposits taken that day,
  given back and kept, each with who did it, and what is **still held** at the end of
  the day. That figure is the one definition of a deposit held
  (`src/lib/hire-deposits.ts`) that the reports' liabilities use too
  (`venueOwes`, [ADR 0055](../architecture/decisions/0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md)):
  taken, and not yet back. What is kept back from a deposit is a sale in the
  journal, as before, so each till's **expected** amount is the journal's net plus
  deposits taken less every deposit let go of (given back and kept, the kept part
  being already in the journal): *What each till should hold*. A deposit taken before
  the method was recorded shows as *not recorded*, never as cash, and that marker stays. Staff can say, **once**, how it was held
  (*How was it held?* in the kit's return panel, `POST /api/admin/hire` with `action: "state_method"`;
  `hire_records.deposit_via_stated`, with who said it and when, migration 0327, [ADR 0068](../architecture/decisions/0068-money-hardening-credit-notes-are-not-cash-spent-is-money-paid-and-the-till-lists-every-payout.md)): the statement is written
  beside the marker and never over it, the deposit is counted under that method from then on (what is held, taken and given back
  by method, and what is kept back goes in the takings under it, with no method to say again), saying the same again changes
  nothing and saying another is refused, and a deposit whose method was recorded when it was taken, or said when the kit came back,
  takes none (`tests/hire-deposit-method-stated.test.ts`). The cash-up of a day already counted does not change: a count keeps what
  was expected when it was made.
- **What was counted** is recorded under the sheet: the cashier enters what they counted
  in each till (`POST /api/admin/cash-up`), and the sheet shows, beside what was
  expected, what was counted, the **variance** (short or over, worked out by the server
  from the expected amount at that moment) and who counted. Each count is its own
  record, a recount another one, the latest counting; none is edited
  (`cash_up_counts`, migration 0308; *Counted the till…* in the activity log). Front desk
  counts its own shift, a manager anybody's. Tested in `tests/hire-cash-up.test.ts`.
- **Front desk sees its own**: what it took and gave back itself, today or
  yesterday (a shift past midnight). **A manager** sees everybody's, or one
  person's, on any day.
- **Who took it** is known for what staff did from this change on: sales,
  payments marked, fees, voids, adjustments, invoices marked paid, and a
  booking or series staff cancel, and a counter payment owed back after the
  venue cancelled, settled (`asStaff`, lib/acting-staff.ts). A credit note
  written outside a member of staff's request (a closed day's or an outage's
  online or credit refund, the scheduler or a customer's own cancellation)
  names nobody, and shows only in everybody's.

## Finding a record

The lists that grow under *Credit & passes* (memberships, passes, receipts
and credit notes, gift vouchers, company invoices) come fifty at a time,
newest first, with *Newer* and *Older* (`src/lib/list-search.ts`). Each is
searched by a code or number, any part of a name, or a phone number however
it is typed (the booking search's way, `phone_key`), and filtered by a status
of its own: memberships active, *ending within 30 days* (soonest first), not
started, ended or cancelled; passes active, ending within 30 days, used up,
ended or cancelled; receipts or credit notes; vouchers active, ending within
30 days, turned into credit, ended or cancelled; invoices not yet due,
overdue or paid. Suspending, giving days back, correcting, cancelling,
reprinting and marking paid work on any record found this way.

## Company and school accounts

A school's PE department, a firm's sports club, a corporate league: the
people who book are not the people who pay. *Credit & passes → Company and
school accounts* opens an account with the organisation's name, where its
invoices go, its address and registration or tax number for the invoice, how
many days it has to pay (30 unless said, at most 90), and, if the venue wants
one, a limit on what it may owe at once (`lib/accounts.ts`).

The venue lists who may book on it, by name and phone number. One of them,
signed in with that number proved on their account (the code check, never a
number typed into the form), sees *Who pays: SK Taman Klang (on account,
invoiced monthly)* when booking. The booking stands unpaid on the account: not
held for payment online, not paid from credit or a pass, not counted against
the person's own unpaid limit, and refused, with nothing booked, if it would
take the account past its limit. The desk can put any unpaid booking on an
account from the day's list, or take it off until it is invoiced.

**An account that does not pay.** Invoices unpaid past their due day are listed under
*Needs attention* for the venue's staff (account, number, due day, days overdue, what is
still to pay) and reminded to the account's address by email, the first day overdue and
weekly after, six at most per invoice (`remindOverdueAccountInvoices`, the outbox). A
manager can also set, under *Company and school accounts* (*Overdue accounts*), after how
many days overdue **new bookings on the account are refused**: blank, the default, never
(as before); 30 is a sensible start. The refusal names the amount overdue and the days;
the customer is told to pay for that booking themselves or ask the venue, and staff can
charge the booking to the account anyway with a reason, recorded in the activity log
(`company_overdue_block_days`, migration 0307). A paid invoice, or one whose credit notes
and part payments cover it, no longer blocks. Tested in `tests/account-overdue.test.ts`.

Early on the first of each month, what was played on each account last month
and not yet invoiced goes on one invoice, which is emailed to the account
with a link to print it or save it as a PDF: each booking, its date and court,
who booked it, and what it cost, with the SST or GST included where the venue
is registered. The email and the invoice are in the account's language, one
of the site's that the venue picks when opening it (the site's first unless
it picks another), whoever opens the link; court names, payment methods and
what staff typed stay as written. A manager can also invoice an account at once, for last month
or this month so far: everything charged to it for dates up to today,
a session later today included (the account buys on credit as it books;
anything changed after the invoice is a credit note, below). *Mark paid*
records how it came in and marks every booking on it paid the same way, one
cancelled since included, as the invoice charged it. An account that pays in
parts records each amount received (*Mark paid* with an amount, and how): the bookings
the money covers are paid in the order played, by that means, and the invoice is paid
when the last part is in, until then showing what was *received* and the *balance*
(`account_invoice_payments`, migration 0307; `tests/account-credit-parts.test.ts`). The invoice the account opens from its link
shows each amount received (the day and how), the **balance to pay** and, until it is paid, how much is still to pay by its day
([ADR 0068](../architecture/decisions/0068-money-hardening-credit-notes-are-not-cash-spent-is-money-paid-and-the-till-lists-every-payout.md); `tests/invoice-part-payments.test.ts`), in the account's language. **In the sales journal** a booking enters
when the money received covers it, in the order played, at the day it was marked paid, as before: an amount received that covers no
whole booking is on the invoice's payments and not yet in the journal, and so not in the cash-up's expected till for that day; the
journal and the payments agree to the sen once the invoice is paid. That granularity is kept: allocating a part to a booking's tax
and receipt would put an invalid part of a receipt in the books, and what is correct for the tax is the owner's and an adviser's
decision, so it is recorded as a limitation, not guessed. An
unpaid invoice can be withdrawn; its bookings go on the next one; not once any money
was received on it, nor once a booking on it was cancelled or moved with a credit note
against it, as that credit note stands.
What the account **owes** is what its unpaid invoices say: each one's total
as issued, less the credit notes taken off it and what was received. Closing an account stops new bookings on it;
what is on it is still invoiced.

**Credit notes on the account.** One person taken off a booking on the
account ([taking one person off a booking](booking.md#taking-one-person-off-a-booking)),
or the whole booking cancelled, before its invoice is issued comes off the
account's charge. After, an issued invoice never changes: the place's price,
or what the invoice charged for the booking, on the venue's cancellation
terms, is a credit note to the account against that invoice
(`account_credits`, migrations 0201 and 0242, once per booking cancelled; in
the venue's documents at the tax the booking was invoiced at, and never as
well a credit note on the booking's own receipt), whether the invoice is paid
or not, and comes off
the account's next invoice, **part by part**, oldest first, as far as its total
goes: a credit bigger than the invoice is taken as far as the invoice goes and the rest
waits for the next, never blocking the smaller ones behind it, and each part is a
record of its own (which credit, which invoice, how much, who issued the invoice,
when: `account_credit_allocations`, migration 0307). The invoice lists each (*Credit note CN-…, MS-…*) and what is *To
pay*, and its email gives that. Staff see the credit waiting on the
account, and on each invoice what was credited. Withdrawing an invoice gives
its credits back to the account for the next one. **An issued invoice never drifts**:
each booking's invoiced price is kept when the invoice is issued
(`bookings.invoiced_amount`) and the invoice's lines, and the credit for a
cancellation, follow that and never the booking's live price. A booking on an issued
invoice **moved to a cheaper court or time** keeps the price it was invoiced at, and
the difference is a credit note on the account against that invoice, waiting for the
next one (a later cancellation gives back only what is left); moved to a dearer one, it
is not charged more: for staff it is **refused** (`RESCHEDULE_INVOICED_DEARER`,
with the way out: a time that costs the same or less, or cancel it and book the
other time on the account), since a debit line on the next invoice is a receipt
of its own and is not built; a customer is refused as for any paid booking. A
booking not yet invoiced is re-priced when it moves, as before. Tested in `tests/account-invoice-snapshot.test.ts`. Credit can also be paid
back to the account some other way (a bank transfer, or an account closed
with no more to invoice): a manager records it with *Paid back by hand* and
what they wrote down to find it again (`settleAccountCredit`, migration
0223, for what still waits of each credit, parts already taken off invoices staying
taken; *Paid back an account's credit by hand* in the activity log), and it
never comes off an invoice afterwards; an invoice issued at the same moment
either takes it or leaves it to the hand payment, never both. A closed
account stays listed, marked closed, while credit waits on it.
Tested in `tests/place-withdrawals-money.test.ts`,
`tests/account-credit-settled.test.ts`, `tests/account-cancellations.test.ts`
(on Postgres too) and `tests/components/account-credit-settle.test.tsx`.

Managers open, change and close accounts and invoice them; the desk charges
bookings to them and marks invoices paid. Every step is in the activity log.
The numbers listed on an account go out with what a venue holds against a
number, and come off every account when the customer erases their own.
