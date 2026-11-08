# ADR 0077: Staff taking a person off a booking at the counter hand the money over then, and it is written as the payout it is, by the member of staff who did it

- **Status:** current, decided 2026-11-08 in the pilot-completion round (brief WDRAW; the limitation was named in [ADR 0074](0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md)
  and [ADR 0075](0075-the-till-is-compared-with-cash-received-and-cash-handed-back-and-a-credit-note-is-not-a-payout.md)). No migration: `counter_payouts` already holds the row and
  many payouts to one booking (migration 0342). What staff see is in [payments and credit](../../features/payments-and-credit.md#refunds-for-one-persons-place);
  the route is in [the HTTP API](../http-api.md). Builds on ADR 0074 (an obligation to hand money back) and ADR 0075 (the till is compared with the cash actually handed back).
- **Context:** staff taking one person off a booking paid at the counter (`POST /api/admin/bookings/withdraw`) wrote the person's credit note and nothing else, on the reading that
  staff hand the money across the desk as they do it. ADR 0075 counts a credit note that no payout points at as cash leaving the till, on the day it is dated and under the method the
  customer paid with. The question was whether that is an actual reconciliation error, tested against three cases.

## What the tests found (`tests/staff-withdrawal-cash-up.test.ts`)

| Case | Before this decision | Verdict |
| ---- | -------------------- | ------- |
| (a) Handed over at that moment, same method, everybody's cash-up | The credit note lowered the paid-by method's till on its day, which is when and where the cash left | **Right.** No error. |
| (a) The same, one member of staff's own cash-up | The route did not act as the member of staff (`asStaff`), so the credit note named nobody and was in nobody's own cash-up: the desk's own sheet expected the drawer unchanged, and counted against it the drawer was short by the whole refund | **Wrong: reproduced.** A real defect in the normal flow, found by comparing the all-staff and the own-shift sheets. |
| (a) The till's list of money handed back (bookings screen, `counterPayoutsOn`), and the sheet's *handed back* | Showed a staff cancellation's payout and not a staff withdrawal's, though both were handed across the desk | An omission, not a till error: the one list of what was handed back (ADR 0068) was not complete. |
| (b) Handed back on another day, or by another method than it was paid | Not expressible: the staff withdrawal offers no choice of method and no "hand it back later"; it writes no owed row. A staff cancellation is the same (`settleCounter` pays out the way it was paid). If it is done anyway, the till is wrong on both days and by method, and nothing on the sheet says so | A boundary of the feature, **not a defect of the code**: the contract is that the cash is handed over at that moment, as paid. |
| (c) Not handed back at all (stored credit instead, online, a pass, an account, not yet paid) | A booking not paid at the counter writes a credit note that is in no cash till (credit, online) or none (not yet paid): no error | **No error.** The counter never offers credit for a staff withdrawal. |

## Decision

1. **The route acts as the member of staff** (`asStaff`), as every other staff route that writes a credit note does (the cancel, the owed settlement, a price adjustment). The credit note then names who gave the
   money back, and that member of staff's own cash-up counts it. This alone makes the own-shift sheet right.
2. **A staff withdrawal of a place paid at the counter writes the payout it is**, in the withdrawal's transaction under the booking's lock, after the credit note: a `counter_payouts` row with the amount
   handed over, the method the booking was paid with, the credit note it is on, the late share kept (none: staff withdraw in full), and the member of staff and their name. It is the row a staff cancellation
   writes. ADR 0075 then counts the pair as one movement on one day: the credit note is put back and the payout is taken out, the till ends where the note alone left it, and the day's list of money
   handed back and the sheet's *handed back* now show it, with who handed it over.
3. **Not a payout where nothing was handed over**: not paid yet (the price comes off what is owed), paid from stored credit (it goes back to credit), online, with a pass, or on an account. These use the
   qualification a staff cancellation uses (`counterMoney`), so the two cannot disagree.
4. **A customer's or the venue's API key's withdrawal is unchanged**: nobody is at the till, so the money is owed back (ADR 0074).
5. **Nothing is backfilled.** A withdrawal from before this change has its credit note and no payout, and ADR 0075 counts it by the credit note as it always did (its rule for a payout that names no note).
   There is no way to tell afterwards whether cash was handed over, and none is invented.
6. **The credit note is untouched**: its number, date, tax and amount are as before. Only who wrote it (the member of staff) and the new payout row are different.

## Siblings with the same shape, checked

- **A price adjusted after payment at the counter** (`POST /api/admin/bookings/adjust-price`): credit note for the difference, no payout, no owed row; the route already acts as the manager. The difference
  is counted as cash leaving the till on the day of the note. Right if the manager hands it over at that moment; the system has no way to say otherwise. Unchanged, not decided here.
- **A cheaper coach's difference, paid at the counter** (`POST /api/admin/bookings/reschedule` with `coachMoney: adjust`): credit note, no payout, no owed row, **and the route does not act as the member
  of staff**. The customer is told the venue *will* give it back, so the hand-over is not necessarily at the moment of the change. This is the ADR 0074 shape (an obligation recorded as a refund) and
  needs an owed row, which is a business decision. Unchanged and recorded as a limitation.
- **A cheaper move** (ADR 0067): already an owed row, settled with a payout. Right.
- **Mark unpaid** writes no credit note: the booking's receipt leaves the journal on the day it was paid (the code, not the documents, which call it a credit note). On the day of the payment this is right;
  taking back a payment from an earlier day changes that day's figures after it was counted. Unchanged, recorded.

## Not decided here

- Whether staff should ever be able to hand a withdrawal's money back later, or another way, or as credit (an owed row with a staff cause). Not offered; no case for it was found in the normal flow.
- The tax treatment of the credit note is unchanged and is the adviser's.

## Alternatives considered

- **Only the `asStaff` fix** (the smallest change that makes the own-shift sheet right): sufficient for the reproduced error, but leaves the withdrawal as the one counter refund by staff that the
  list of money handed back does not show. The payout is one insert with the same shape as a cancellation's, so it was added.
- **Write an owed row for staff too and settle it at once:** rejected; it is the same row twice for one moment, and the front desk's rule (hand back only a payment taken today) would apply to the
  withdrawal, which staff may do up to the end of the booking.
- **Count a staff withdrawal's credit note as a record and require a payout:** rejected; it would make every withdrawal from before this change drop out of the till.

## What the tests do not prove

The numbers are checked against rows the tests date by hand, on PGlite and Postgres; no drawer was counted. That staff hand the money over at the moment they take the person off, by the
method it was paid with, is a practice the system cannot check: money handed over otherwise, or not at all, makes the drawer over or short by that amount and nothing on the sheet says why.
