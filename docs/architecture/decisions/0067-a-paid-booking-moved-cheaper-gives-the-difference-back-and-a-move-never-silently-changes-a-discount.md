# ADR 0067: A paid booking moved to a cheaper time gives the difference back; a move never silently creates, removes or wastes a discount; a dearer move of an invoiced booking is refused

- **Status:** current, decided 2026-11-07 in the post-audit hardening round on audit 9's findings B16 = C12 = D15 (the owner's decision DEC-16), B11 (the owner's
  principle, written up as DEC-60), D3 (a discount kept as an amount must not make an hour free) and the rest of C5. Built in migrations 0324 and 0325. What customers and
  venues see is in [booking](../../features/booking.md#changing-the-date-or-time), [pricing](../../features/pricing.md#discounts-together) and
  [payments and credit](../../features/payments-and-credit.md#a-paid-booking-moved-to-a-cheaper-time); the routes are in [the HTTP API](../http-api.md). Builds on
  [ADR 0054](0054-money-paid-never-above-price-and-no-silent-price.md) (what has been paid never ends above the price) and [ADR 0061](0061-company-accounts-and-the-cash-up.md)
  (an issued invoice never drifts).
- **Context:** a booking moved to another time is repriced by the court time's difference. Unpaid, the price follows. Paid, it kept the price paid whatever the new time cost: a
  peak RM60 booking moved to an RM25 hour left the customer RM35 out of pocket with no warning and no route to get it back, though an online payment whose price fell while its page
  was open was owed back. Three neighbours had the same shape: a last-minute price (the venue's discount for time nobody wanted) was priced at the old time and never at the new, so a move
  between two times that both qualified cost the customer the discount; a discount kept as an amount ([pricing](../../features/pricing.md#discounts-together), decided 27 October 2026) could take
  an hour to nothing; and a staff move of a booking on an issued company invoice to a dearer time was reported to staff as "not charged" with nothing on the account.

## Decision 1: the difference of a paid booking moved to a cheaper time goes back, the way it was paid

- **Who:** a customer's move always (they may move only before the venue's cancellation cutoff, as for cancelling). Staff's move gives it back by default while the customer could still have
  changed the booking themselves, and keeps it by default after (what every staff move did); either way staff can say `difference: "refund" | "keep"` (keeping a customer's money is a manager's choice: `MOVE_KEEP_MANAGER` for the front desk, whose default after the cutoff is still to keep). A lesson the venue moves keeps the
  price agreed ([programmes](../../features/programmes.md#a-lesson-moved-by-the-venue)) and a lesson given to another coach is settled by its own rule: neither is touched.
- **How much:** what the booker has paid for the booking itself and is still on it, less what the booking costs at the new time: the court time at the new time, the discounts it was given
  kept as amounts ([Decision 3](#decision-3-a-move-never-silently-creates-removes-or-wastes-a-discount)), never below what a deposit or friends' shares took. What has gone back before (a
  place taken off, a manager's adjustment, an earlier move) is already off the sum that is paid, so the total returned can never exceed what was paid, however often it is moved.
- **Which way:** the original payment's route. Paid online: owed back on the payment (`refund_due`, never more than it took) with a credit note, and sent through the venue's refund path the
  moment the move commits: Stripe refunds it through its API (idempotent, claimed before it is asked); where the gateway has no refund API (Billplz), or refuses, it stays owed for staff under
  *Refunds owed* with its due date and is never said to be refunded. Paid at the counter (cash, QR, transfer, card, or a tick whose method was never recorded): written on the list of counter
  money owed back (`counter_refunds_owed`, cause `moved_cheaper`, migration 0325), settled by staff when the customer comes, exactly as money owed after the venue cancels: handed back the way it
  was paid (a payout in that day's cash-up), the credit note written then; the front desk hands back only a payment taken today. Paid from stored credit: back to the pots it was taken from, in
  proportion, with a credit note. Paid with a pass: no money moves, the same entries cover the same length of time. On an issued company invoice: a credit note on the account, as before
  ([payments and credit](../../features/payments-and-credit.md#company-and-school-accounts)), and now also where the invoice is already paid.
- **Never credit nobody chose:** cash and card money is never turned into the venue's credit by the move. A counter debt becomes stored credit only when staff settle it that way at the
  customer's request, for an account (as for a cancellation).
- **Recorded, not rewritten:** the booking's price and its receipt stay as sold. Each move that returns money is a row of `booking_move_refunds` (who moved it, from and to where, what had been
  paid, the price at the new time, the sum, the route, the payment), added in the move's own transaction under the booking's row lock and never edited; `paidPartLeft` counts it, so a later
  cancellation gives back only what is left. Its credit note is keyed to the booking and the move (`booking:<id>:move:<n>`), found by the booking's receipts and by the period report's
  credited sum.
- **Once:** the move reads the booking under its row lock and is refused (`RESCHEDULE_CHANGED`) if it was paid, re-priced, invoiced, moved or cancelled since the customer was shown the price. A
  repeated or simultaneous request finds the booking already at the new time (`RESCHEDULE_SAME`); a move racing a cancellation gives the money back exactly once whichever wins.
- **Refused rather than left unsettled:** friends' or players' shares paid (`MOVE_DIFFERENCE_SHARED`: those are other people's money, so staff keep the difference or settle the shares first;
  customers were already refused, `RESCHEDULE_SHARED`), a new price below what a deposit or shares paid (`MOVE_DIFFERENCE_BELOW_PAID`), and a payment or credit that cannot be found to give it back on
  (`MOVE_DIFFERENCE_UNTRACED`). In each the booking stays where it was.

## Decision 2: the price is shown before the change is confirmed

- Every change of time answers with `money`: the price now (a paid booking: what was paid for it), the price at the new time, the difference, and what becomes of it (`price`, `refund` with its
  sum and route, `kept`, `account`, `pass`, `none`), and whether a last-minute price went with the old time. A preview (`preview: true`, on the customer's route and on staff's) returns it and
  changes nothing: nothing is owed, no row is written. The customer's screen asks for it when a time is chosen and shows it with *Confirm the change*; staff see it with the choice to give
  the difference back or keep it. The confirmation says what is being given back, and how.

## Decision 3: a move never silently creates, removes or wastes a discount

(The owner's principle, recorded as DEC-60 *Discounts when a booking moves*; the unpaid price already followed the court time.)

- **A last-minute price** is the venue's discount for time nobody wanted, given to a booking made when the time was within the window ([pricing](../../features/pricing.md#last-minute-prices)). It is
  an entitlement fixed when the booking was made (the booking carries the mark `last_minute`), tied to the time: a marked booking moved to another time is priced as it was made, minute by minute
  (the minutes that still start within the window from when it was made keep the discount), so a move between two times that both qualify costs nothing extra; moved to a time the window no longer
  reaches, the discount goes with the old time and the change of price is shown before it is confirmed. A booking never given one never earns one by moving into the window. (Before, no move ever
  kept it: a customer who moved one hour later paid the full price and, if paid, was refused as "dearer".)
- **A concession or promo code** stays at the amount it took off (decided 27 October 2026), as before, but a move never takes a time to nothing: where the amounts kept would leave no price, the
  price is the share of the new court time the booking was paying (RM60 with RM30 off moved to an RM20 hour is RM10, not RM0). Between those, the amount kept stands. Whether a percentage
  should always be worked out again on the new time stays the owner's (DEC-33).

## Decision 4: an issued company invoice is never billed for a dearer move that nobody can see

- A staff move of a booking on an issued invoice to a dearer time is refused (`RESCHEDULE_INVOICED_DEARER`) with the way out (a time that costs the same or less, or cancel it and book the other
  time on the account), instead of being reported as "not charged" with nothing on the account. A debit line on the next invoice is a receipt of its own and is not built. Customers were already
  refused (`RESCHEDULE_DEARER`); a lesson the venue moves keeps its agreed price and is unaffected.

## What this changes

- A customer or staff member moving a paid booking cheaper no longer loses the difference unseen: it is shown first and then owed back or credited the way it was paid. A paid booking moved dearer is
  as before (customers refused, staff's keeps the price as paid).
- *Refunds owed* and the counter list can hold a move's difference; a venue's liabilities and the period report count it as owed until settled and a credit note once written.
- Moving a last-minute booking between qualifying times no longer raises its price; a discounted booking can no longer be moved to a free hour.
- Staff cannot move an invoiced company booking to a dearer time.
- One new table and two new columns, nothing deleted: `booking_move_refunds` (new), `wallet_entries.move_refund_id`, `counter_refunds_owed.move_refund_id`; the counter list's one-row-per-booking rule becomes one
  per cancellation and one per move.

## Consequences / not built

- The booking's own price column keeps the price as sold (its receipt too), so a customer's booking list still shows the old price beside a note; what was paid for it now is the price less what went back.
- A paid booking that staff moved to a dearer time without charge (price kept) and is then moved cheaper by the customer is treated as having been discounted by the same share: the discount rule cannot
  tell a discount from a free upgrade without a history, which is not kept.
- The customer is not offered stored credit instead of a refund on the screen: a customer who wants credit asks the venue, which settles a counter debt as credit. Offering the choice in the app is a
  possible later change.
- The move of a booking to another court by staff for the venue's convenience (`moveBooking`) still keeps the price ("a move is the venue's convenience, not the customer's"): not changed here, left to the owner.
- Percentages recomputed on every move (DEC-33), pass entries returned pro rata (DEC-30) and a debit line on an invoice are not built.
- Against a stand-in for Stripe only: that Stripe refunds the sum is `INTEGRATION_VERIFICATION_REQUIRED`, as for every refund; Billplz refunds are by hand.

## Alternatives considered

- *Refund the difference as stored credit by default* (the audit's recommended default). Rejected by the owner's direction: cash is never converted into venue credit without consent.
- *Forbid moves to a cheaper band.* Rejected: the customer's move is legitimate and the money is theirs.
- *Lower the booking's price and rewrite its receipt.* Rejected: nothing already written is edited; a credit note and a ledger row say what happened.
- *Keep the price paid and show a warning only.* Rejected for the customer's own move: it would warn of a loss the venue could prevent.
- *A new refund table for counter money.* Rejected: the existing list of counter money owed back, its settling and its cash-up lines are reused; only its one-row-per-booking rule changed.
