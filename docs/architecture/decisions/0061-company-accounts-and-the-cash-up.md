# ADR 0061: Company accounts and the cash-up: credit notes taken off part by part, an issued invoice never drifts, overdue accounts reminded and optionally blocked, hire deposits and the counted till

- **Status:** current, decided 2026-11-06 from the ninth audit (findings C5, C6, C7, C10, E13 and H10). Built in migrations 0307 and 0308. What venues see is in
  [payments and credit](../../features/payments-and-credit.md#company-and-school-accounts) (*Company and school accounts*, *Cash-up*) and
  [venue operations](../../features/venue-operations.md#equipment-hire-and-deposits). Builds on [ADR 0055](0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md)
  (the journal and the reports' liabilities are one set of figures) and [ADR 0054](0054-money-paid-never-above-price-and-no-silent-price.md).
- **Context:** an issued invoice to a company or school account was said never to change, but its lines were drawn from the bookings' live price, a reschedule re-priced an
  invoiced booking, and a later cancellation credited the live price; a credit note was taken whole or not at all (one too big for an invoice blocked the smaller ones behind it)
  and an invoice could only be paid in full; an account with an invoice 90 days overdue could still book, with nothing on the dashboard and no reminder; and hire deposits,
  money in the drawer, were nowhere in the cash-up, with no record of how each was held and the return defaulting silently to cash.

## Decision 1: credit notes are taken off invoices part by part, each part recorded

- `account_credit_allocations` holds one row per part: which credit, which invoice, the amount, who issued the invoice (the member of staff acting, or *scheduled invoicing*),
  when. A credit's waiting balance is its amount less its parts; an account's `credit` is the sum of those, and an invoice's `credited` the sum of the parts taken off it.
  Credits applied whole before this were copied in by the migration. `applied_invoice_id` is still set when one invoice takes a credit whole, so older readers and tests see what
  they always did.
- Issuing an invoice allocates oldest credit first as far as the invoice's total goes; a credit bigger than the room is taken as far as it goes and the rest waits. A withdrawn
  invoice takes its parts with it (cascade), so they wait again. "Paid back by hand" settles what *still* waits of each credit (`settled_amount`); credits are locked first and the
  balance read afterwards, so an invoice being issued at the same moment and a hand payment never both take the same money.
- An invoice can be part-paid: `account_invoice_payments` records each amount (how, who, when). The bookings on the invoice are marked paid, in the order played, as the money
  received covers them, with the method of the payment that covered them, so the cash-up and the journal show the money when it came in, by method, to the granularity of a
  booking; the credit notes taken off an invoice cover the tail and are paid when the invoice is. An invoice paid in one go behaves exactly as before. The part of a payment
  not yet covering a whole booking is on the invoice (`received`) but not in the journal until it does: a known limit (the journal is drawn from bookings, which are not part-paid).
  An invoice with money received on it cannot be withdrawn.

## Decision 2: an issued invoice never follows the booking's price

- The price each booking was invoiced at is kept on the booking when the invoice is issued (`invoiced_amount`; for older invoices, the price as it stood at the migration). The
  invoice's lines and the credit for a cancellation read it, never the live price.
- A reschedule of a booking on an issued invoice behaves as for a paid booking: the price stands. Cheaper, the difference is a credit note on the account against that invoice
  (`account_credits.for_adjustment`, once per move), in the move's transaction, waiting for the next invoice; a later cancellation gives back the invoiced price less those credits
  (`paidPartLeft`). Dearer, the booking is not charged more and staff are told the difference (`unchargedDifference`), a customer's move to a dearer time being refused as for a paid
  booking. **Not built:** a debit adjustment line on the next invoice for a dearer move: it would need its own receipt in the journal; the difference is reported, not billed
  (an owner decision, listed in the report). A booking not yet invoiced is re-priced as before.

## Decision 3: overdue accounts are seen, reminded, and may stop new bookings (off by default)

- One definition of an overdue invoice (`overdueInvoices`): unpaid, past its due day on the venue's calendar, with something still to pay. It feeds the needs-attention list
  (`accountsOverdue` on `GET /api/admin/attention`), the weekly reminder to the account's address (first day overdue, then weekly, six at most, through the outbox with a dedupe key and
  a claim on the count, so two ticks send once) and the block.
- `venues.company_overdue_block_days` (null = never, today's behaviour; the settings screen's help recommends 30). Once an invoice of the account is that many days overdue,
  `chargeToAccount` refuses a new booking with `ACCOUNT_OVERDUE`, naming the amount and days. Staff may charge it anyway with a reason of at least three characters, recorded in the
  activity log with the amount overdue; a customer booking online has no override. The setting is a manager's.

## Decision 4: hire deposits are in the cash-up, by method, and never default to cash

- `hire_records.deposit_via` is recorded when the kit goes out (required for a deposit above nothing), with who took it and who gave it back. On return the recorded method is
  used for what is kept (a different one is refused); for a deposit taken before it was recorded, a kept amount needs the method said; nothing is put down as cash by default.
- `src/lib/hire-deposits.ts` is the one definition of a deposit held (taken, not yet back); the reports' `venueOwes.hireDeposits` and the cash-up's held figure both read it.
- The cash-up gains a *deposits* block (taken, given back, kept by method, held at the end of the day), the **expected** amount per till (journal net plus deposits taken less every
  deposit let go of, the kept part counted once as the sale it is), and **counts**: `cash_up_counts` keeps what a cashier counted per till with the expected amount and the variance
  at that moment; a recount is another row; nothing is edited. The server works out the expected amount; the caller says only what was counted.
- **Before and after:** `venueReport(...).liabilities.owed.hireDeposits` is unchanged (the same query, now shared); the cash-up's tills gain `depositsNet` where a hire venue's
  day had deposits (before, they were nowhere in it); no other figure changes.

## Consequences

- Migrations 0307 and 0308 add tables and nullable columns only; nothing past is rewritten. Existing open hires keep a null method, shown as *not recorded*.
- Not decided here and left to the venue's adviser: whether held deposits are a liability in its books (the reports list them as money held, provisional as in ADR 0055).
