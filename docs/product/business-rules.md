# Cross-cutting business rules

Rules that hold across features and must not be broken by a change to any one
of them. Rules that belong to a single feature are in that feature's document
under [`docs/features/`](../features/); this page links there rather than
repeating them. Changing one of these is a product decision: say so in the
change, update this page, and update [feature status](feature-status.md).

## Identity

- **A phone number is not identity.** A typed number proves nothing; data
  export and erasure follow the account (`user_id`), and anything granted by
  a number uses the number an account has *proved* (`users.verified_phone`).
  See [privacy](../architecture/privacy.md#a-phone-number-is-not-identity).
- **Numbers are compared however they are typed.** Finding a booking,
  cancelling a series, duplicates in classes and waitlists, inductions,
  limits, notes and waivers all compare `phone_key()`, so `012-345 6789`,
  `+60123456789` and `0060123456789` are the same person (migration
  `0066_phone_key_00.sql`).
- **Signing in with Google** to an account that already has that address
  clears the account's password and signs it out everywhere: nothing proved
  that whoever set the password owned the address.

## Bookings

- **Nothing overlaps on a court.** Everything that holds court time
  (bookings, held bookings, waiting-list offers, classes, blocks, tournament
  holds, outages, buffers) is a claim, and the database refuses an overlap
  or a shared facility over capacity whatever wrote it
  ([booking time model](../architecture/booking-time-model.md)).
- **One set of booking rules everywhere.** Every route that takes a time
  (booking, any court, several courts, weekly bookings, waitlist, moving,
  rescheduling, the public API) checks the court's booking rules (starts,
  lengths, hours, notice) the same way. Only a manager may go past them, and
  it is recorded; nobody goes past a claim or a buffer
  ([booking](../features/booking.md#booking-rules-starts-lengths-buffers)).
- **One price for the same time.** Quotes, bookings, weekly bookings,
  moves, rescheduling and refunds price court time through one function,
  to the minute, rounded once; discounts come off the court time, never
  setup or cleanup fees ([pricing](../features/pricing.md#prices-to-the-minute)).
- **Weekly bookings skip closed weeks**, saying which and why, rather than
  booking into a day the venue is shut.
- **Cancelling happens once.** A cancellation claims the booking
  (`… WHERE status = 'confirmed'`) before any refund, so two taps, or a
  customer and the desk at the same moment, cannot refund it twice.
  Cancelling a weekly series sends one message and offers each freed place to
  the waitlist.
- **Staff cannot cancel a booking that is over** (that would refund an hour
  that was used); one under way can still be called off, for a leak or a
  power cut. A day gone by cannot be closed.
- **Booking codes** come from a cryptographic random source; lookups match the
  whole code, case-insensitively.
- **Unpaid holds** can be extended once, while still running and within the
  payment page's own expiry. A hold released for not being paid settles
  anything already paid against it (a split share, credit).
- **Open games** cannot be opened on a court held until paid and not yet paid.
- **Last-minute prices** cannot be had by cancelling and rebooking, by moving
  an older booking, or with a promo code on top
  ([pricing](../features/pricing.md#last-minute-prices)).
- **Customers cannot move a booking friends have paid a share of**; the venue
  can.
- **A booking is for one activity.** On a court offering several, it records
  which, takes that activity's rates and booking rules, and holds the whole
  court; it moves only to courts offering that activity, and a court cannot
  stop offering an activity with bookings still to come
  ([activities](../features/activities.md#one-resource-several-activities)).
- **A rescheduled booking keeps to the new court's rules**, length included:
  a customer cannot move a 60-minute booking onto a court that sells 90
  minutes at least. Only a manager can, recorded.
- **Places are counted one by one.** A booking of a shared facility takes the
  places it says (kayaks, climbers), never more than the facility has at any
  moment; it pays per place unless the venue made the rate one price for the
  booking or set quantity prices.
- **A sign-off is the customer's own.** Where an activity's rules ask for a
  sign-off or a certification, a customer online books only from the account
  it is linked to or one that has proved its number, for one place, while it
  holds on every day booked; the same holds for weekly series, rescheduling,
  waiting lists and each player joining an open game. Staff at the counter
  book by number; a manager may go past it, recorded
  ([sign-offs](../features/activities.md#sign-offs)).
- **A manager going past the rules never goes past what holds a court**:
  starts, lengths, hours, notice and sign-offs may be overridden, on record;
  claims, capacity, buffers and a members' place may not.
- **The same venue policies on every path.** The booking form, the counter
  and the venue's API key are held to the same policies: who may book a
  members-only or private venue, the house rules, no-show strikes, the guest
  limit, blocked numbers and the unpaid-bookings limit. The counter takes
  payment as it books where online a booking would be held until paid; a
  manager may override the house rules' limits, strikes, the guest limit or
  an assisted weekly booking for one booking where the venue allows it, with
  a reason, on record; never a blocked number, unpaid bookings, eligibility,
  the waiver, the booking window, capacity or payment
  ([booking](../features/booking.md#the-same-policies-on-every-path)).

## Money

- **A payment page settles what it was for.** Each booking on a page records
  what it was billed (`online_payment_bookings.amount`). If the price came
  down while the page was open, the booking is paid and the difference is
  owed back; if it went up, the page does not pay for it and its money is owed
  back instead. Moving an unpaid booking to a dearer time is refused while a
  page for it is open. What is owed back on a payment is never more than the
  payment.
- **Marking unpaid is not a refund.** A booking paid online, with credit or
  with a pass cannot be ticked back to unpaid; it is refunded instead. Front
  desk can take back only a counter payment marked today; anything older is a
  manager's.
- **What staff cancel is refunded at once**: a booking cancelled by staff, by
  the API or by a closed day has what was paid online refunded, to the card
  where the venue refunds through its gateway, even if it gives credit when a
  customer cancels.
- **Shares handed back are owed again.** A player who paid a game share and
  leaves, or is taken out, is refunded by the venue; the share comes off what
  the booking has had paid towards it, so the host owes it again. If the host
  had already paid the rest online, what they paid stands on a receipt of its
  own, dated when it was paid, and the booking is unpaid for just the share.
  The same holds for a friend's share in a split cost.
- **Chargebacks take back what they paid for.** Lost on a top-up, the credit
  goes (a balance can go below zero until the next top-up); on a gift voucher,
  the voucher is void, or its credit goes if redeemed; on a membership, it is
  void and renewals stop; on a game or split share, it no longer counts towards
  the booking; on a tournament or league fee, the place is unpaid again.
  On a booking it paid for, the booking owes what went back again; on a
  deposit, the deposit stops counting towards the booking, and a booking whose
  rest was paid at the counter, with credit or with a pass is unpaid again for
  the deposit's part (the counter payment keeps its own receipt). A booking
  whose rest was paid online stays paid. On what a venue paid the platform
  (an invoice, a WhatsApp pack), nothing is undone automatically: the
  platform owners are told and decide. A dispute for part
  of a payment takes back only that part (a membership, entry or league place,
  which cannot be split, goes whole). Nothing more is owed back on a payment
  the bank has already returned, and a lost dispute is acted on once however
  often, or however simultaneously, the gateway reports it.
- **Paid twice, owed back once.** When something already paid is paid for
  again, the first payment is the fee and the only receipt; the second is
  money received and owed back, never revenue, and is refunded once however
  often it is asked for. What a venue paid the platform twice is owed back by
  the platform owners.
- **A cancellation and its refunds are one change**; what goes back through a
  gateway is owed from that moment and asked for after it, under a key that
  makes it once however often it is asked; a refund the gateway reports
  failed is owed again, not resent by itself. Refunds are reconciled for
  every venue, but refunded automatically only where the venue's policy was
  automatic when the money first became owed; a venue's own refund policy
  is never changed by the reconciliation
  ([payments](../features/payments-and-credit.md#refunds-that-are-interrupted)).
- **Money kept from a hire deposit is a sale per reason**, receipted when it
  is kept. Staff give the reason; the reason's nature and the venue's tax
  settings decide the tax, starting from a provisional country default
  (charges for a service or a fee taxed; compensation, replacement, penalties
  and other not) that stays marked provisional until the venue records its
  adviser's review; a later change needs reviewing again
  ([venue operations](../features/venue-operations.md#money-kept-from-a-deposit)).
- **Credit below nothing is a debt, not income**: reported apart from credit
  held, customer by customer, never netted.
- **A receipt stays in the period it was issued.** A booking that stops being
  paid (a chargeback lost) keeps its receipt, written down as a document of its
  own dated when it was paid; the credit note falls in the period of the loss.
- **Counter sales voided later** come off the takings on the day of the void,
  not the day of the sale, so a day already cashed up does not change.
- **Promo codes** can be limited per customer (by phone number however typed).
- **Coach payouts** list paid lessons cancelled late at the coach's fee times
  the share the venue kept (`bookings.late_kept_percent`), beside no-shows,
  for the venue to decide on.

## Trust and abuse

- **Reviews** come only from a booking that was paid for or checked in.
  Venue staff do not see which booking wrote a review (platform owners do, on
  a reported one). Rewriting a review clears a report on the old words;
  reporting one twice tells the owners once.
- **Resending a message** is only for one not sent (failed or held back); a
  new address must look like one for its channel; a venue's news, a review
  request and a marketing confirmation go only to whoever they were written
  for; the daily limit per recipient holds for the new recipient.
- **Marketing email** goes only to an address that said yes itself; a box
  ticked for an address that is not the signed-in account's own sends one
  email asking first ([messaging](../integrations/messaging.md)).
- **Stored credit at the counter** shows only that venue's entries.
- **Tournaments and leagues**: closing entries, drawing, calling off (which
  refunds every entry) and starting or ending a season are a manager's, and
  each is in the activity log.
- **A tournament's knockout follows its groups until it starts**: a group
  result put right refills it while no knockout match has been played. After
  that nothing changes silently: a manager reviews what a correction would
  change and confirms it with a reason, into the knockout only where every
  match it changes is still to play with its court, otherwise in the group
  table (or a knockout match's record) only; a result played stands. Where
  that leaves the wrong competitor having gone on, the tournament does not
  finish until a manager lets the results stand or replays them.
- **Somebody leaving a tournament** (withdrawn, retired, disqualified — the
  last a manager's, with its reason; after the draw, confirmed against a
  preview) loses every match left by walkover and never goes through; their group results stand or are void by the tournament's rules
  (by default they stand for a withdrawal or retirement, and are void for a
  disqualification); they are never simply put last. Before the draw a fee
  paid online is owed back unless the rules say not; after it, nothing is
  ([tournaments](../features/tournaments.md)).
- **API keys** can be *availability only*: the venue and its free times, no
  customer's name or number.
- **A flood of guest bookings** (past 30 unpaid bookings without an account at
  one venue in an hour): the next guest pays online to hold theirs where the
  venue takes payment online, or signs in where it does not.
- Rate limits, phone-number limits, blocked numbers and the fair ordering of
  venues are in [security](../architecture/security.md).

## Reliability

- **A message is sent once** however many drains run at the same moment: each
  claims a message by moving its next try ten minutes on before sending, and
  only the one whose claim landed sends. A server that dies mid-send leaves it
  to be tried again when that runs out.
- **Reminders** are looked for at most once a minute per server.
- **The retention policy** runs from the scheduler once a day (and from the
  dashboard where the scheduler is off).
- **Bookings and held time are checked against each other** once a day: a
  live booking holding no court time, or holding a different time, or a
  cancelled one still holding it, raises an alert for the platform owner
  ([monitoring](../operations/monitoring.md)).

## What customers are told

- **Emergency numbers** follow the country: 999 in Malaysia; 995 (ambulance
  and fire) and 999 (police) in Singapore.
- **A waiting-list offer** says the place is held for 30 minutes.
- **Booking terms** say when a venue gives stored credit rather than money
  back for a booking paid online and cancelled; a number past its strikes at a
  venue that sends such numbers to the counter is told that, rather than to
  pay online.
- Destructive staff actions (withdrawing a promo code, cancelling a
  membership, retiring a plan, taking down a notice, ending an outage) ask
  first.

## Deliberately not built

Decisions not to build something are recorded in
[known limitations](../roadmap/known-limitations.md#deliberately-unsupported).
