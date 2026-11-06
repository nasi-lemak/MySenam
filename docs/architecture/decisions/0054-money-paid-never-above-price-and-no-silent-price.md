# ADR 0054: What has been paid never ends above the price; credit is never taken for a cancelled booking; nothing is charged at a price the customer did not accept; a booking whose request died is held or let go

- **Status:** current, decided 2026-11-06 from the ninth audit (findings B3, B8, B10, B16, C1, C3, C4, C16, D20 and H1). Built in migration 0297. What customers and venues see is in
  [payments and credit](../../features/payments-and-credit.md) (*Paying online to hold a booking*, *Stored credit*), [booking](../../features/booking.md) and
  [pricing](../../features/pricing.md#discounts-together). Builds on [ADR 0002](0002-database-enforced-concurrency.md) (the database decides who wins).
- **Context:** five defects on the booking's money path, each a case of the same shape: a check made outside the transaction that writes, or a writer that forgot a rule another
  one states. Credit and pass payments read the booking's status before their transaction, so a cancellation committing in between left credit taken for a cancelled booking
  that the cancellation's refund had already run past; three writers of `bookings.total_price` (a move to a cheaper court or time, a promo code, a concession) never looked at
  the deposit or friends' shares already paid, so a deposit could end above the price with nothing owed back (only a manager's price adjustment refused that); a promo code or
  concession refused after the customer saw its price still let the booking be made and paid from credit at the full price; the unpaid-bookings brake counted the number typed,
  so one account could hold any number of them; and the booking route applies the hold last, so a request that died after the booking was saved left a confirmed, unpaid,
  unheld booking at a venue that holds.

## Decision 1: credit and pass payments are decided with the booking's status, in the paying transaction

- `payBookingFromWallet` and `payBookingWithPasses` read the booking **inside** their transaction under its row lock (`lockPayable`), and refuse a cancelled one
  (`BOOKING_WAS_CANCELLED`) or one paid meanwhile (`ALREADY_PAID`) **before** anything is debited. The price debited is the one the booking has when it is read there, not the one
  read before the transaction. `claimPayment` marks only a **confirmed** booking paid (`AND status = 'confirmed'`), so the guard is also in the statement that marks it.
- A cancellation that commits first is seen; one that comes after waits for the payment's lock (serialisable, retried) and then refunds it by the existing paths
  (`refundBookingToWallet`, `refundBookingToPass`). No new refund path. The online payment, the counter and a friend's share already read the status inside their transactions
  and are unchanged.

## Decision 2: one rule for every path that lowers an unpaid booking's price: what is paid never exceeds the price

- `keepPaidWithinPrice` (`src/lib/paid-within-price.ts`) runs, inside the transaction that wrote the lower `total_price` and under the booking's row lock, from a **reschedule or
  move to a cheaper court or time** (customer or staff), a **promo code** (`applyPromo`), a **concession** and a **place's concession**. A manager's price adjustment keeps its own
  guard (`P8B_ADJUST_BELOW_PAID`); a place taken off a booking settles its deposit part as before (`place-withdrawals`).
- Where a **deposit paid online** is the part above the new price, that part comes off the booking (`deposit_paid`, `shares_paid`) and off the deposit payment's share of the booking
  (`online_payment_bookings.amount`), and is **owed back on the deposit's payment** (`refund_due`) with a **credit note on the deposit's receipt**, in the same transaction, as for a
  place taken off a booking or a price that came down while a page was open. It then goes back by the venue's own refund path. A later cancellation owes back only what is left, so
  never more than was taken.
- Where **friends' shares** (or a deposit that cannot be identified) are above the new price, the change is **refused** (`PAID_ABOVE_PRICE`) and undone: those are other people's
  money, for the venue to square with them. A booking **paid in full** is left alone: what it keeps when moved to a cheaper time is a separate, deliberate rule that this decision
  does not touch (audit findings C12 and D15 await the owner).
- The reschedule answer carries `owedBack` where a deposit's excess was given back, also in a preview (which changes nothing).

## Decision 3: nothing is charged at a price the customer did not accept

- A booking request may carry **`expectedTotal`** (whole cents, over all the bookings the request makes), on the booking form's route and on the venue API's. Where the bookings now
  cost another price (more or less, beyond a sen a booking for rounding), the request is refused with **`PRICE_CHANGED`** (the price now in `vars`) **before anything is settled**
  and the bookings, discounts and coach are discarded: nothing is booked or charged. The booking form sends the total it showed (not for a weekly booking, a court picked for the
  customer or a concession, whose figures it does not work out to the sen); after a refusal the customer reads the new price and pressing Book again accepts it.
- A promo code or concession that was **asked for and refused**, on a request that **settles at once** (credit, a pass, the counter, an account), is a refusal
  (**`DISCOUNT_NOT_APPLIED`**) with nothing kept, instead of the full price taken. Without settling, it stays best-effort as before (the booking stands at its price and says why).
- A failed payment from credit or a pass still leaves the booking made, unpaid and held where the venue holds (existing behaviour, tested), and the answer now carries
  `walletErrorCode`; the booking form's confirmation says in all four languages that the credit or pass was not used and what is still to pay.

## Decision 4: the unpaid-bookings brake counts the account as well as the number

- The count of unpaid bookings coming up (3 at a venue, 6 anywhere) is by the typed number **or** the signed-in account (`bookings.user_id`), as the house rules count both. Staff
  and the venue's API key book by the number (they have no customer account).

## Decision 5: a booking whose request died before its hold is held or let go by the scheduler

- `holdStrandedBookings` (the scheduler's tick, before `releaseExpiredHolds`) puts the hold such a booking would have had, counted from when it was made; if that has passed, the
  next release lets it go. It is one idempotent UPDATE guarded by "still unpaid, still no hold", so it is safe to run twice or at once, and never moves a hold that is there. It only
  touches what the route holds: made online by a customer, not on an account, not a class place, unpaid, nothing paid towards it, no payment ever started, not made for an approval,
  at a venue whose holds are in force and **made since they were turned on** (`venues.pay_to_hold_since`, migration 0297, set by `setHoldPolicy` when the setting goes on; null for
  venues that had it on before the column), made 5 minutes to 3 hours ago.
- **Not done:** setting the hold inside the booking's own transaction (the other remedy the audit named) and sweeping a booking whose confirmation was lost with the request; the
  sweep releases an unheld booking the customer was never told about, as a hold that lapsed would.

## What this changes

- A deposit-paid booking moved or discounted below its deposit gives the excess back instead of silently keeping it; friends' shares refuse the change.
- A cancelled booking can no longer be paid from credit or a pass; `claimPayment` returns false for it.
- A booking request may be refused with `PRICE_CHANGED` or `DISCOUNT_NOT_APPLIED`; two codes new to API clients (both 409), and `expectedTotal` is optional.
- One account can no longer hold more unpaid bookings than a number may.

## Consequences / not built

- The reschedule of a **paid** booking to a cheaper time still keeps the price paid (C12/D15, owner decisions pending), and a booking paid in full is not touched by Decision 2.
- A refund owed on a deposit goes by the venue's refund path; on Billplz (refunds by hand) it appears under *Refunds owed* and the daily digest like any other, and the customer is told only
  by the venue.
- The credit note's wording (`receipt.why.priceLowered`) is machine-assisted in Malay, Chinese and Tamil.
- `expectedTotal` is exact to the sen per booking; a client that works the price out itself and differs by more is refused and should send the price the refusal names.

## Alternatives considered

- *A database constraint that `shares_paid <= total_price`.* Rejected for now: place withdrawals, game shares and corrections lower the total and the paid part in steps, and a deferred
  check would turn an application rule into an error nobody can read; the helper gives a customer a reason in their language.
- *Capping the deposit at the new price and keeping the rest.* Rejected: it takes money the customer paid for a price that no longer exists.
- *Refusing every move below a deposit.* Rejected: the customer's move to a cheaper court is legitimate; the excess is theirs and is owed back.
- *Sweeping only by time.* Rejected: a booking made before a venue turned holds on would be released unannounced; hence `pay_to_hold_since`.
