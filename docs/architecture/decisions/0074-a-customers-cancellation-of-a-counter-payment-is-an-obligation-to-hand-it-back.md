# ADR 0074: A customer's cancellation of a booking paid at the counter is an obligation to hand the money back; a credit note is the record of the cancellation, not the refund

- **Status:** current, decided 2026-11-07 in the final operational hardening round (brief REFUND; the defect was verified in the audit and the cross-domain
  tests). Built in migrations 0346 and 0347. What staff and customers see is in [payments and credit](../../features/payments-and-credit.md#owed-back-after-a-customer-cancels);
  the routes are in [the HTTP API](../http-api.md). Builds on [ADR 0058](0058-safety-and-access-after-a-booking-is-made.md) and [ADR 0069](0069-the-terms-a-booking-was-sold-on-govern-it-arrival-goes-to-staff-and-edits-meet-bookings-in-one-transaction.md)
  (what a customer who has arrived, and the terms a booking was sold on, mean for a cancellation), [ADR 0067](0067-a-paid-booking-moved-cheaper-gives-the-difference-back-and-a-move-never-silently-changes-a-discount.md)
  (the list of counter money owed back also holds a move's difference) and [ADR 0068](0068-money-hardening-credit-notes-are-not-cash-spent-is-money-paid-and-the-till-lists-every-payout.md)
  (a credit note is not cash paid; one list of what is owed and one of what was handed back).
- **Context:** when staff or the venue cancel a booking paid at the counter, the money is either handed back at once and written as a payout (staff) or written as owed back on a list for
  staff to settle (the venue's closures, outages, rain-outs, API key, a class called off, a move to a cheaper time). A customer cancelling the same booking wrote the credit note, the tax
  document, and **nothing else**: no row on that list, no payout, no task. The customer was told "nothing is owed" and the venue had the cash with no instruction to return it. The credit note
  was taken for the refund. Reproduced at every customer-initiated path: the single cancellation (by code and phone, and from the account), a week of a series, a class place, an account closed over
  a booking, a person taken off a paid booking, a deposit paid online with the rest at the counter, and a cheaper move followed by a cancellation.

## Decision 1: one more cause on the same list, written in the cancellation's own transaction

- **No second ledger.** The list of counter money owed back (`counter_refunds_owed`, migration 0258, widened by 0325) takes two more causes: `customer_cancelled` (the whole booking: a customer's own
  cancellation, a week of a series, a class place, or a booking cancelled because their account was closed) and `place_withdrawn` (one person the customer, or the venue's API key, took off a paid booking).
  Migration 0346 widens the cause check (added `NOT VALID` then validated, as migration 0326 did) and replaces the one-row-per-cancellation index with one that leaves a withdrawal's rows aside: one row per
  booking cancelled, one per move (0325), one per withdrawal (`withdrawal_id`, a deferrable foreign key as every row that points at a booking). A booking can lose several people, move cheaper more than once, and
  then be cancelled: each is its own legitimate obligation, and together they are exactly what was paid.
- **The amount** is what the booking's own counter payment still holds (`counterMoney`: its price less shares paid online and less what places taken off, a manager's adjustments and moves already gave back),
  times the share the venue does not keep. The late share comes from the **terms the booking was sold on** (ADR 0069), already read by the cancellation; an edit of the venue's policy after the sale changes
  nothing. A deposit paid online goes back online as it always did and is not in the counter sum.
- **The credit note is written as it always was**, at the cancellation, for the same amount. It is the tax document and the till's record; it is **not** proof that the customer has the money, and the list,
  the panel and the documents say so. Owed back once: the row is written in the same transaction as the cancellation, under the booking's claim (`status` claimed in one statement), so a double submit, the customer
  against staff, and a customer against the desk taking the payment back (the booking row is now locked in `setPaymentStatus`) leave one outcome. A second try writes nothing (`ON CONFLICT DO NOTHING`).
- **Not on the list:** a booking not paid at the counter (unpaid, online, credit, a pass, an account); a person taken off by staff at the counter (they hand the money over as they do it, as a staff cancellation does);
  and shares in an open game or a split, which are only ever paid online (owed on the payment, as before). The venue's own bulk cancellations keep their causes and their rules: a customer's cause is never added on top.

## Decision 2: settled only by a named member of staff, once, and recorded

- `POST /api/admin/bookings/owed` settles it as it settles every row: *handed back* (a payout for the till: the amount, who, when, on which credit note) or *as stored credit* on the booking's account. The row is
  claimed by `settled_at` in the settling transaction, so two members of staff at the same moment settle it once; nothing is marked paid before staff say so. The front desk hands back a payment taken today and a manager
  anything older, as in every counter refund. Settling a customer's row **does not write a second credit note**: it links the one written at the cancellation, and hands back exactly what was written down as owed.
- **An agreed alternative method.** The customer may agree to be handed it another way than they paid (cash, QR, transfer or card): the request carries `via`, the payout and the row record the method actually used
  (`settled_via`) beside the one it was paid with, and the activity log says "not the way it was paid". `credit` is the other alternative and is the outcome. The credit note is never rewritten.
- States are **owed** (open) and **completed** (settled); the model has no failed or disputed state and none is invented.
- **What the till shows.** The credit note counts in the cash-up on the day it was written, under the method it was paid by (ADR 0068); the payout is in the list of money handed back on the day it was handed over. They
  agree in amount and method when the money goes back the way it was paid; on another day they sit on two days, and an alternative method puts the cash-up and the payout under different methods. This follows from keeping
  the credit note as it was (the brief) and is **recorded as a limitation, with the alternative below, for the owner**.

## Decision 3: the customer is told what is true

- The cancel response (`refunds`) and the cancellation message carry one more kind of line, `how: "counter"`: "the venue will return RM x to you at the counter, where you paid it. It has not been returned yet: the credit
  note is only the record of the cancellation, not the refund" (English, Malay, Chinese and Tamil: `rf74.refundCounter`). It replaces the old "nothing is owed for it" line when only a counter payment is owed. The cancel
  routes, the sweep that writes a message a stopped server never wrote (`tellOwedNotices`) and the two cancel-after-a-move routes all say it; the message goes through the existing outbox, by email or WhatsApp where the customer left
  an address. The row records when they were told (`customer_notified_at`, migration 0347); with no address it stays empty and the panel tells staff to tell the customer at the counter.
- The staff panel (*Owed back at the counter*) shows, for each row, the customer and booking code, the amount, the method it was paid by, why, the day it arose, its status, the credit note, whether the customer has
  been told, and what to do, with a choice of method when handing it back.

## Decision 4: past cancellations are listed, not turned into tasks

- Customers' cancellations from before this change have a credit note and no row. Nobody can say from the data whether the money was handed over at the time (a payout was only written when staff cancelled). They are
  **not** backfilled by a migration, and no row is invented as owed or as completed: a refund must not be paid twice. `scripts/reconcile-counter-cancellations.sql` is read only and lists the candidates for a manager to
  review (cancelled, paid at the counter, a credit note, no owed row, no payout, no credit given by staff, not logged as a staff cancellation). A manager who finds one not handed back settles it by hand.

## Not decided here (for the owner)

- **Defer the credit note to the settling?** The venue's own cancellations write the credit note when staff settle it, so the cash-up and the payouts always agree; a customer's keeps today's timing, as the brief says.
  Deferring would make the cash-up exact and attribute the note to the member of staff who hands the money back (today the note has no member of staff, so it is not in a desk's own till), but it moves the tax document's
  date and changes what a customer's receipt shows until they are paid. Not changed without the owner's decision.
- **Staff taking a person off at the counter** writes no payout (the cash goes across the desk, but the till's list does not show it). Not in this brief.

## Alternatives considered

- **A new table for customer refunds:** rejected; the list's shape (how much, how it was paid, why, who settled, when) is the same and a second list would split what staff look at.
- **Backfill past cancellations as owed:** rejected; it would invite paying twice.
- **Defer the credit note (as the venue's causes do):** not done; see above.
