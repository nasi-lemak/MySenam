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
show as *not recorded*. Customers see the payment
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
- A held slot comes free on time: holds are let go on the scheduler's tick,
  and on the way past whenever anybody books, searches or opens a day's
  availability. The waitlist is offered it.
- Staff see *held till 3:45 PM* on the booking, and *released (unpaid)* after.
  Bookings staff make at the counter, ones paid at once from credit or a
  pass, and free ones are never held. It needs the venue's own payment
  gateway account (Billplz or Stripe); without one it cannot be turned on.
- A held booking with a deposit paid on it is never let go as unpaid, even in
  the moment before its hold is cleared.

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
  `/my-booking`, and the confirmation message says the booking can be paid
  online. A weekly series is paid in one bill; weeks already settled are left
  out. Pressing the button twice sends the customer to the same bill.
- **Marked paid** only when Billplz says so, in a callback or the customer's
  redirect back, and only after its signature checks out under that venue's
  key. Either can arrive first; both are safe to repeat. The Bookings tab shows
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

The keys are encrypted in the database, which is the file that gets backed up
and copied off the machine. The key that unlocks them is `MYSENAM_SECRET`, or,
when that is unset, one generated into `secret.key` in the data folder —
never in the database. A backup restored onto another machine without that key asks
for the venue's payment keys to be entered again instead of handing them over.

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
  operator to check, not settled here.
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

### Refunds for one person's place

Taking one person off a paid booking, the others staying booked
([taking one person off a booking](booking.md#taking-one-person-off-a-booking);
`lib/place-withdrawals.ts`), gives back that place's price as charged, on
the venue's cancellation terms (a late withdrawal keeps the venue's share),
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
  give the money back.
- **A pass** spent for that place gives back its entries (whole entries,
  rounded down on a late withdrawal); one that paid for the booking as a
  whole gives back nothing for one person.
- **Not yet paid**, the place's price comes off what is owed instead, its
  share of a booking-wide discount with it.
- Bookings others paid shares of, held by a deposit, charged to an account,
  or with a payment page open are refused: the venue can change those
  ([taking one person off a booking](booking.md#taking-one-person-off-a-booking)).

Tested in `tests/place-withdrawals.test.ts` on PGlite and Postgres, against
a stand-in gateway for the online case.

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
  the booking standing as unpaid with a `walletError` explaining why, rather
  than throwing the booking away.

Cancelling a wallet-paid booking refunds it automatically, through every path:
by code, from an account, a whole series, an admin cancellation, and the
enrolments released when a class is cancelled.

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
  remainder. The number of ways can be changed until a friend has paid.
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

Early on the first of each month, what was played on each account last month
and not yet invoiced goes on one invoice, which is emailed to the account
with a link to print it or save it as a PDF: each booking, its date and court,
who booked it, and what it cost, with the SST or GST included where the venue
is registered. The email and the invoice are in the account's language, one
of the site's that the venue picks when opening it (the site's first unless
it picks another), whoever opens the link; court names, payment methods and
what staff typed stay as written. A manager can also invoice an account at once, for last month
or this month so far. *Mark paid* records how it came in and marks every
booking on it paid the same way. An unpaid invoice can be withdrawn; its
bookings go on the next one. Closing an account stops new bookings on it;
what is on it is still invoiced.

Managers open, change and close accounts and invoice them; the desk charges
bookings to them and marks invoices paid. Every step is in the activity log.
The numbers listed on an account go out with what a venue holds against a
number, and come off every account when the customer erases their own.
