# ADR 0068: A credit note is not cash paid; a booking a pass paid takes back entries and no money; "spent" is money paid; the till lists every payout; a hire deposit's method can be stated once; an invoice shows what was paid

- **Status:** current, decided 2026-11-07 in the post-audit hardening round (brief MONEY; audit 9 findings D16, D17, C11, D1, C10, C6 and C13); built in migrations 0326 and 0327. What staff and
  customers see is in [payments and credit](../../features/payments-and-credit.md#owed-back-after-the-venue-cancels), [pricing](../../features/pricing.md), [reporting](../../features/reporting.md)
  and [tournaments](../../features/tournaments.md#entry-fees-taken-at-the-counter-owed-back); the routes are in [the HTTP API](../http-api.md). Builds on [ADR 0054](0054-money-paid-never-above-price-and-no-silent-price.md)
  (money paid never above the price, credit never taken for a cancelled booking), [ADR 0055](0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md) (the report's money is the journal's),
  [ADR 0059](0059-competition-notices-fees-owed-fixtures-lost-and-message-review.md) (a counter fee owed back, never paid out by itself), [ADR 0061](0061-company-accounts-and-the-cash-up.md)
  (the cash-up, hire deposits, part payments) and [ADR 0062](0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md) (a pass cancelled with a refund is credited, not revived).
  Each point is the smallest change that gives the business outcome the brief states; nothing already written (a receipt, a credit note, a ledger line, a booking) is rewritten.
- **Context:** seven small defects in how money is shown and tracked, none of which changes what the ledger holds. A credit note was written for a booking a pass paid, a document for money never taken. The
  customer report counted the price of a booking, not what was paid. A refund handed back at the counter for a tournament entry fee, a pass or a membership was a credit note and a log line, not a task
  on a list and not a line in the till's payouts. A hire deposit taken before its method was recorded could only be given a method on the way back. A company's invoice page did not show what had been
  paid on it. And two modules round a half sen differently.

## Decision 1 (D16): a booking a pass paid gives entries back and writes no credit note

- `creditBooking` returns nothing for a booking whose own payment was a pass. Cancelling it (the customer, the venue, staff, a closed day) returns the entries to the pass's ledger (`Refund for MS-…`,
  with the booking), as before, and no credit note is written, because no money was taken: such a booking has no receipt (the journal draws none), and a credit note for it left gaps in the numbers the
  journal hides.
- The trail is the pass's ledger and the staff activity log, which now says what went back (*1 entry went back to the pass, no money paid out*; minutes for a time pass; *nothing went back to it*
  for a late cancellation that keeps the entry) in the single cancellation and in a bulk one (a closed day, a rain-out).
- The sibling credit-note paths (a place taken off, a cheaper coach, a manager's price adjustment) already return nothing for a pass-paid booking (no money share; adjustments refused), so only this one
  changed. A credit note written for a pass-paid booking before this change stays (history is not rewritten); the journal's filter that hides it stays.

## Decision 2 (D17): "spent" in the customer report is money paid

- A customer's *spent* is, for each confirmed booking in the period: its own receipt as the journal draws it (`bookingGross`) less the credit notes taken off it (`bookingCredited`), when it is paid and
  not paid with a pass, plus the deposit they paid online towards it (net of what places taken off took of it). So an unpaid booking, one a pass paid (the pass was the sale; entries are not money) and a
  friend's share (on their own receipt) are not their spending; a booking paid from stored credit already sold counts (it is theirs spent, as the journal counts it); a paid no-show counts (the money
  was paid and kept). The report's ranking of the ten best customers follows money.
- The ledger is untouched: this is the report's query only, and `tests/customer-spent.test.ts` proves a venue's report agrees with the journal's rows for its bookings.

## Decision 3 (C11, D1): one list of what is owed back at the counter, and one list of what was handed back

- **A credit note is not cash paid.** The credit note is the tax document, and it counts in the till when it is written, as before. Whether the customer has the money is a separate fact: a
  named member of staff says so, once, when it is handed over. This is the rule the bookings' owed-back list already had (ADR 0059 for fees).
- `counter_fee_refunds_owed` (migration 0304, an entry fee owed back) is generalised, not duplicated: its subject is exactly one of a tournament entry, a pass or a membership (migration 0326), and a
  credit note is owed once (a unique credit note). Voiding a counter-sold pass or membership with a refund, and the entries a cancelled booking gives back as money to a pass that was cancelled with a refund,
  write the amount here in the same transaction as the credit note, open, with how it was paid. It is listed with the entry fees and the bookings owed back (`feesOwed`, with a `kind`), the list
  saying that a credit note is not money paid, and settled by `POST /api/admin/bookings/owed` (`kind: "entry_fee"`, the row's id, for any kind): once, by a named member of staff, the front desk only
  for a refund written today, another venue's staff refused. An entry's credit note is still written at settling (ADR 0059); a pass's or a membership's was written at the cancellation and is only linked.
- Only money taken at the counter is handed back across the desk. A pass bought online is owed on its payment, as before; one paid for with stored credit is not a counter payout.
- **The day's payouts list** (`counterPayoutsOn`) holds every settled counter payout: a booking's and, from the owed list, an entry fee, a pass's refund and a membership's, each with how it was paid, the credit note,
  who and when. For an entry fee the credit note is in that day's cash-up under the method it was paid by, so the payout list and the till agree. Marking an entry's *paid* tick off by hand still credits it
  directly, as a booking's *Mark unpaid* does: the undo of a mistaken tick, in the cash-up as a credit note, not a payout.
- **Not done:** refunds written before this change are not turned into tasks (nobody can say whether the money was handed over; a credit note stands as it always did); a box league's place fee
  is still not owed back (the owner's decision on mid-season removals, ADR 0059); a voucher's refund and a counter sale's void are not on the list (outside the brief).

## Decision 4 (C10): a legacy hire deposit's method can be stated, once

- A deposit taken before migration 0308 has no method (`deposit_via` NULL), shown as *not recorded*, never as cash; that marker stays. Staff can say how it was held
  (`POST /api/admin/hire`, `action: "state_method"`), and it is written beside the marker (`deposit_via_stated`, with who and when, migration 0327), never over it. From then on the deposit is counted under that
  method: what is held, taken and given back by method in the cash-up, and an amount kept back goes in the takings under it, with no method to say again.
- Once: the same again changes nothing (and logs nothing), another method is refused, and a deposit whose method was recorded when it was taken, or said when the kit came back, takes no statement. Two
  statements at once leave one (the row is locked).
- A cash-up of a day already counted does not change: a count keeps what was expected when it was made. The cash-up of an earlier day read again counts the deposit under the stated method (the statement
  is what staff then knew it always was); nothing in the books changes.

## Decision 5 (C6): the invoice page shows what was paid; the journal keeps its granularity

- The page an account opens from its invoice link lists each amount received (the day and how) and the **balance to pay**, and, until paid, says how much is still to pay by its day, in the account's
  language. An invoice paid in one go before part payments were recorded shows only its paid line, as before.
- The journal is **not changed**. A booking enters it when the money received covers it, in the order played (ADR 0061), so an amount received that covers no whole booking is on the invoice's payments and
  not yet in the journal or the cash-up's expected till for that day. They agree to the sen once the invoice is paid (`tests/invoice-part-payments.test.ts`). A clean allocation of a part to a receipt's
  lines and tax does not exist without deciding the tax treatment of a part payment of an invoice, which is not the code's to decide (rule: never invent legal or tax behaviour); it is a recorded limitation.

## Decision 6 (C13): half-sen rounding is understood, pinned, and not changed

- `roundMoney` (a float, `Math.round`) and SQL `ROUND` (numeric, half away from zero) part by exactly one sen where the exact product is a half sen that a float holds a hair below (RM10.10 at 75%:
  the credit note RM7.57, the amount owed back RM7.58). Over every price from RM0.01 to RM99.99 and a keep of 5% to 95% they part only at half-sen products, and JavaScript is always the one that is a sen short.
- **No change.** Replacing either needs a single amount in integer sen computed once and passed to the credit note, the wallet, the pass and the refund owed; that touches every refund path, and the
  rule is that financial rounding is never changed without proving the replacement is more correct. `tests/rounding-half-sen.test.ts` pins both behaviours and the end-to-end case so a later change is
  made on purpose, in its own change, and says which figure it moves.

## What was left open

- **The journal's part-payment granularity** (Decision 5) and the tax treatment of a part payment on an invoice: an adviser's and the owner's.
- **Half-sen rounding** (Decision 6): the integer-sen replacement is its own change.
- **Refunds before this change** are not on the owed list; the venue's staff know what they handed back.
- **A box league's place fee, a gift voucher's refund and a counter sale's void** are not on the owed list (outside this brief).

## Alternatives considered

- **Write a new table for pass and membership refunds:** rejected; the owed list's shape (how much, how it was paid, why, who settled, when) is the same, and a second list would split what staff
  look at. The table is generalised in place with a check that each row is for exactly one thing.
- **Defer the pass's or membership's credit note to the settling, as an entry fee's is:** rejected here; it would change when the tax document is written for every pass and membership refund and the
  tests and reports that read it. Adding the task and the payout record gives the outcome without moving the books.
- **Fill in `deposit_via` for a legacy deposit:** rejected; it would erase the marker that the method was not recorded and make a guess look recorded.
- **Count a customer's friends' shares in their "spent":** rejected; they are other people's money on their own receipts.

## Addendum, 7 November 2026: more than one hand-back for one booking

The cross-domain tests found that `counter_payouts.booking_id` was `UNIQUE` (migration
0231, written when a booking had one cancellation and so one hand-back). A paid booking
moved cheaper owes a difference for each move ([ADR 0067](0067-a-paid-booking-moved-cheaper-gives-the-difference-back-and-a-move-never-silently-changes-a-discount.md)),
so a second hand-back (a second move, an outage's share, a cancellation after a move) threw,
the booking stayed confirmed and the sum stayed owed with no way to settle it in the app.
Migration 0342 replaces the constraint with a plain index. A hand-back is still claimed once,
by its own owed row, so the constraint was not what prevented a double payout; two staff
settling one difference at once still pay it once (`tests/counter-payouts-many.test.ts`,
on both engines).
