# ADR 0075: The till is compared with the cash received and the cash actually handed back that day; a credit note is the record of a cancellation, not a payout; an unpaid refund is shown as still owed

- **Status:** current, decided 2026-11-08 in the pilot-activation round (brief CASH; the limitation was named in [ADR 0074](0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md)
  and the final-hardening audit's *remaining risk*). No migration: the existing columns (`counter_payouts.paid_out_at`, `via`, `credit_note_id`; `counter_refunds_owed.owed_since`, `settled_at`;
  `counter_fee_refunds_owed`) are enough. What staff see is in [payments and credit](../../features/payments-and-credit.md#cash-up); the route is in [the HTTP API](../http-api.md).
  Builds on [ADR 0061](0061-company-accounts-and-the-cash-up.md) (the cash-up), [ADR 0068](0068-money-hardening-credit-notes-are-not-cash-spent-is-money-paid-and-the-till-lists-every-payout.md)
  (a credit note is not cash paid; one list of what was handed back) and ADR 0074.
- **Context:** a customer cancels on 8 November and is owed RM30; staff pay RM30 in cash on 9 November. The obligation arises on the 8th and the cash leaves the till on the 9th. The cash-up
  compared the till with the sales journal, and a customer's credit note is written when they cancel, so the till was lowered by RM30 on the 8th, while the cash was still in the drawer, and nothing
  was lowered on the 9th, when it left. Counted at the end of the 8th the drawer was RM30 over; counted at the end of the 9th it was RM30 short, with nothing on the sheet to explain either.
  Paid by DuitNow and handed back in cash the effect was on two tills as well as two days.

## How the cash-up worked out the expected till (the trace, before this decision)

`cashUp` (src/lib/cash-up.ts) took one source, the sales journal for the day on the venue's calendar (`salesJournal`), plus hire deposits:

| Source | Date used | Sign | Method |
| ------ | --------- | ---- | ------ |
| Booking receipt (drawn from the booking) | `bookings.paid_at` | + | `paid_via` |
| Stored receipts: counter sales, passes, memberships, entry and league fees, credit, vouchers, hire deposit kept | `receipts.issued_at` | + | the receipt's `paid_via` |
| Credit notes (cancellations, place taken off, cheaper move, adjustments, voids, pass and membership refunds) | `receipts.issued_at` | − | the credit note's `paid_via`, which is how the customer paid (or *Stored credit* where it went back as credit) |
| Hire deposits | taken, returned | + / − | `deposit_via` |
| `counter_payouts`, `counter_refunds_owed`, `counter_fee_refunds_owed` | **not read at all** | | |

The expected amount per till was the journal's net plus the deposits. A credit note therefore lowered the till on the day it was **written** and under the method the customer **paid**, whatever was
handed over, when or how. Where the credit note and the payout come together it was right: a staff cancellation at the counter (note and payout at once), and the venue's own cancellations (their note is
written when staff settle the row, so note and payout share a moment and a method). It was wrong where they were apart: a customer's cancellation (the note at the cancellation, the payout when staff
settle the row, perhaps days later, perhaps by another method by agreement, `settled_via`), and a counter-sold pass or membership refunded (the note when it was cancelled, the payout when staff hand it over).
An alternative method put the refund under the wrong till. A settlement as stored credit never moves cash and still lowered the cash till.

## Decision 1: the expected till is cash received less cash actually handed back, each on its own day and under its own method

Expected for a method on a day = **the journal's net** + **the day's credit notes that record a refund (put back)** − **the refunds handed over that day by that method** + **the deposits' part**.

- **Handed back** is read from the payouts: `counter_payouts` by `paid_out_at`, and the settled rows of `counter_fee_refunds_owed` by `settled_at`, on the venue's calendar, by the method actually used
  (`via`, which is the agreed alternative where there was one). A payout is taken out of the till on its day.
- **A credit note that records a refund** is one that a payout points at (`counter_payouts.credit_note_id`, `counter_fee_refunds_owed.credit_note_id`), or the note of a customer's own cancellation or
  withdrawn place (`counter_refunds_owed`, causes `customer_cancelled`, `place_withdrawn`, found by its source). It stays in the journal exactly as written, with its date, number and tax (`byMethod`,
  `totals` and `entries` are unchanged and equal the accountant's journal row for row); it is only not counted as cash leaving the till. Its amount is shown beside the expected amount (`refundNotes`) so
  the sheet adds up.
- **Every other credit note stays a till movement as before**: a sale voided, a price adjusted, a place a member of staff took off, a "mark unpaid", a refund of a kind no payout list covers.
- **The credit note's date is not changed to the refund's.** Tax recognition and the credit note's number, date and amount are untouched. No row is written, rewritten or backfilled; nothing is migrated.
- **No double counting.** A refund leaves the till once, by its payout. The credit note of a refund with a payout is put back on the day it is dated; the payout takes the cash out on the day it was handed over. Where
  the two fall on one day, as in a staff cancellation at the counter or the venue's own cancellations, the expected amount is what it always was. A payout that names no credit note (rows written before the link)
  is **not** taken out: its credit note is counted as it always was, and the sheet lists the payout marked *counted by its credit note*. A customer cancellation from before ADR 0074 (credit note, no row, no
  payout) is unchanged. A refund settled as stored credit has no payout and its note is put back: no cash moves, and the account's balance carries the obligation. A refund of an unrecorded method
  (the tick that never said how) is in no till, before and after.
- **Own shift.** A member of staff's own cash-up takes out the payouts they handed over; the customer's credit note names nobody, so it is in nobody's own cash-up and nothing is put back there. The all-staff
  cash-up has both.
- Per day, not cumulative: over the days a refund spans the till ends where it did, only the day each figure falls on moves.

## Decision 2: refunds still owed are a separate line, never money gone

The cash-up carries `refunds.owed`: obligations that had arisen by the end of the day and were not settled until after it (`counter_refunds_owed`, `counter_fee_refunds_owed`), with the reference (booking, pass or
membership code, tournament name), the amount, how the customer paid, the cause, since when, and the credit note where one was written; no customer is named. It is the venue's obligation, not one person's,
so it is shown whoever's till is viewed. `refunds.handed` lists what was handed back that day with the method actually used and the one the customer paid with. The cash-up screen and its printout show both,
under a note that a credit note is the record and the till goes down only by what was handed back (staff text in English, Malay and Chinese).

The five facts the owner asked to keep apart are all in the data and on the sheet: refund owed (`owed`), refund settled (`handed`), the original payment method (`paidWith`), the actual payout method (`method`),
and the cancellation date (the credit note's date in the journal) against the settlement date (the payout's).

## Decision 3: the historical review table

`scripts/reconcile-counter-cancellations.sql` stays read only and still selects the same candidates (nothing is backfilled, no task or refund is created). Its output is the manual-review table: venue, booking
code, cancellation date (the credit note's, on the venue's calendar: there is no cancelled-at column), the amount possibly owed, how the customer paid, payout evidence (the activity log's `payment.paid_out`
or `payment.owed_credited` for the booking, which the payout list may not hold), a possible duplicate (other credit notes on the booking, such as a cheaper move's or a place taken off, and stored credit added for
it), and the action for staff. It no longer selects the customer's name or phone.

## Not decided here, for the owner and the venue's adviser

- **Whether the credit note should be dated at the settlement for a customer's cancellation** (as the venue's own cancellations' are). Not done: it moves the tax document's date and changes what a customer's
  receipt shows. This decision makes it unnecessary for the till.
- **Tax treatment of a credit note whose refund is not yet paid** is unchanged and is the adviser's.
- **A person taken off a booking by staff at the counter writes no payout** (ADR 0074); its credit note therefore still lowers the till on its day, as before.

## Alternatives considered

- **Keep the cash-up as the journal and add a note** (the position before): rejected; it is wrong on two days and, with an alternative method, on two tills.
- **Write the customer's credit note when the refund is settled** (as the venue's causes do): rejected here; it moves the tax document's date and changes what the customer's receipt shows until they are paid
  (the owner's and the adviser's choice), and would not help the pass and membership refunds, whose note is written when they are cancelled.
- **A cumulative till** (a running float): rejected; the cash-up is per day and per shift by design; the sum of the days is unchanged.
- **Subtract unpaid obligations from the till as a provision:** rejected; the owner's rule is that an unpaid refund is not money removed from the till.

## What the tests do not prove

The numbers are checked against rows the tests date by hand (`tests/cash-up-refunds-across-days.test.ts`, PGlite and Postgres) and the sheet against a rendered component; no real drawer, terminal or QR
account was counted, and no payment provider is involved. Whether a venue's staff will enter payouts on the day they hand the money over is a practice, not a check: a refund handed over and not recorded stays
*owed* and the drawer is over by that amount until it is.
