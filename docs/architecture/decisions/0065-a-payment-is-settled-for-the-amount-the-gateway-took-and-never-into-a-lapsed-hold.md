# ADR 0065: A payment is settled for the amount the gateway reports it took, and never into a hold that has lapsed; stored value and e-invoicing wait for the adviser

- **Status:** current, decided 2026-11-07 on the ninth audit's findings C19, C18 (= H7, owner decision DEC-14), C2 (owner decision DEC-19) and G15, in the post-audit
  hardening round; built in migration 0316. What customers and venues see is in
  [payments and credit](../../features/payments-and-credit.md#settlement-checks) (*Settlement checks*, *Paying online to hold a booking*) and
  [MyInvois](../../integrations/myinvois.md); the questions C2 leaves to a tax adviser are in the
  [memo](../../operations/einvoice-stored-credit-memo.md). Builds on [ADR 0054](0054-money-paid-never-above-price-and-no-silent-price.md) (what is paid never ends above the
  price; the refund paths are reused) and [ADR 0055](0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md) (e-invoicing keeps going). **Not decided here:**
  C2's treatment of prepaid value (the owner's, after the adviser), and whether a lapsed hold's late payment should ever become the booking (DEC-14 was authorised as "do not
  revive"; an approval booking keeps its own rule, [ADR 0020](0020-approval-to-booking-payment-and-authority.md)).
- **Context:** a signed report that a Billplz bill was "paid" settled the page for the amount the page asked for, whatever the report said was taken. Billplz documents
  amounts on its callback and on the bill (`amount`, `paid_amount`, `collection_id`, `state`) and none on the browser's redirect; nothing was compared. And a booking
  whose hold had run out but that the scheduler had not yet let go was taken as paid by a payment that arrived after the time, while one let go already was owed back
  without saying why, the customer shown "payment received, thank you" and never written to.

## Decision 1 (C19): the gateway's figures are held against the page's before anything is applied

- `PaymentResult` carries, where the report has them, what the gateway says the page was for (`billedMinor`), what it says it took (`receivedMinor`), the currency, and
  whether the report could be matched to the account (`mismatch`: the bill is in another collection than the one the account pays into; or a paid report lacks the
  amounts Billplz documents on it). `settleBill` asks `assessSettlement` (`src/lib/payment-settlement.ts`) first. Billplz's `state` must be `paid`
  (`due` and `deleted` are not), the callback's `collection_id` must be the account's, `amount` must be the page's amount in sen, `paid_amount` is what was taken.
- **A match** settles exactly as before, and the payment row records `received_amount`.
- **More than the page asked** settles the page's amount and owes the rest back, in one statement under the guard that nothing was recorded yet, so a callback repeated, a
  redirect after it or two at once owe it once: `amount` becomes what was received (everything counted against a payment, owed back, refunded and kept, is counted against that),
  the page's own figure stays in `billed_amount`, the excess joins `refund_due`.
- **Less than the page asked, a bill that is not the one made, another currency, another collection, or a paid report without its amounts** applies **nothing**: the payment is
  claimed once (the same `status = 'pending'` claim every settlement makes), recorded as what was received, **all of it owed back**, flagged (`settlement_issue`) and put
  on the list of payments to check. The booking, pass, membership or top-up it was for is left as it was and can be paid again on a new page; a purchase it was holding
  is let go and a subscription it started is stopped. No receipt is written. A refund *owed* is never a refund *paid*: Billplz refunds stay manual, from *Refunds owed*.
- **A report that disagrees after the payment was applied** (a redirect without amounts came first) cannot undo what was applied: it is recorded and flagged for staff
  (`short_after_settled` where it was short), money untouched.
- **The browser's redirect carries no amount**, so a paid redirect is believed only once Billplz's own bill (`GET /api/v3/bills/:id`, the account's key) says the same. If
  Billplz cannot be asked, or does not say paid, the result is `unconfirmed`: nothing is applied, nothing let go, the return page shows the payment's own state, and the
  callback decides. A direct caller with no amounts (a renewal charge, a test) settles the page's amount as it always did.
- **Siblings.** Stripe's session carries `amount_total` and `currency` and now goes through the same assessment. The payment is identified by `bill_id` (unique), the account
  by the bill's row (so another venue's valid key does not settle this venue's bill), and the settlement by the claim, so a payment is never settled twice.
- **The trail** is rows, never edits: the payment row's columns, and one staff activity-log row per observation (actor MySenam, `payment.settlement_check`). The list of payments
  to check is on *Online payment* and a line in *Needs attention*; staff mark one checked, once, with a note (`payment.settlement_reviewed`).
- **What this does not prove.** The tests use faithful payloads from Billplz's documentation against a stand-in; they prove the arithmetic and the guards. Whether Billplz
  can short- or over-pay a fixed bill, and that its callback and bill carry these fields as documented, is **not** verified until a Billplz sandbox is exercised. A paid callback
  that lacks `paid_amount` is held rather than believed, which is the restricted choice.

## Decision 2 (C18 = H7, DEC-14): a payment after the hold lapsed is owed back and never revives the booking

- At settlement, a booking whose `hold_until` has passed is treated as lapsed **whether or not the scheduler has let it go**, so the outcome does not depend on the tick (late is judged by when the payer paid: the gateway's signed `paid_at`
  where it gives one that can be believed, else the moment it is reported, so a slow or retried callback does not make an in-time payment late; `paidInstant`): the
  payment is not taken into it, the lapsed hold is let go at once (the waiting list is offered the slot), and the payment is recorded as `hold_lapsed`, all of it (or its
  lapsed part) owed back, on the refunds worklist and the list to check. A booking made on approval is exempt: its late payment keeps its own rule (ADR 0020).
- It never takes a slot from anyone and never recreates the reservation. A new booking is made only by the ordinary availability and consent flow; if somebody booked the slot
  meanwhile, theirs is untouched.
- **The payer is told.** By email, once (`payment_not_applied`, keyed by the payment), to the booking's email **when its account has proved that address**
  (`users.email_confirmed_at`); the return page tells everyone, plainly and in their language, that the booking was not confirmed and the money is owed back. A payer with only a
  typed-in address, or none, is shown on the list to check as *no usable contact* for staff to ring. (The generic refund notice, which tells a hand-refunded booking's address the
  date, is unchanged and does not repeat this one.)
- Held bookings are the only thing that holds a scarce place: a membership, pass, voucher or top-up paid after its purchase lapsed is still issued (it is not a reservation) and
  is owed back where what it was for has gone, as before; a class place is a booking and is covered; a split share, game share or tournament or league fee is owed back where its
  booking or event has gone, as before.

## Decision 3 (C2 = DEC-19): stored value and e-invoicing wait for the adviser; the code only refuses to be switched on by accident

- No treatment is chosen. The [memo](../../operations/einvoice-stored-credit-memo.md) records, for every stored-value product, what the code lets anyone refund, when money comes in, when
  the service is supplied, how the consolidated e-invoice is made, exactly where it counts RM100 of credit and the RM30 booking paid from it as RM130, what LHDN's FAQ and Guideline
  say (read 7 November 2026) and do not, and the questions for the adviser.
- Switching e-invoicing on at a venue that has sold stored credit or a gift voucher is refused unless the manager says they understand (`acknowledgeStoredValue`), written to the
  activity log; a venue already on is not switched off. No journal row is excluded on a guess. A regression test pins today's RM130 as **pending policy**, ready to be changed
  with the answer. C2 stays open.

## Decision 4 (G15): a late consolidated e-invoice is marked, nothing more

- A consolidated document, or its credit notes, sent (or, unsent, still waiting) after the seventh day of the month following its period shows *Late*. LHDN's FAQ (question 38) and
  Specific Guideline (3.6.2) say a consolidated e-invoice is to be issued within seven calendar days after the month end; neither says what follows a late one, so nothing else
  is done differently.

## Consequences

- A short or mismatched Billplz payment no longer confirms a booking; the customer is shown it and the venue is shown it. A venue whose Billplz callbacks lack `paid_amount` would
  see every payment held: this is what the sandbox check must settle before online payments are activated.
- One more column set on `online_payments` (migration 0316), none backfilled: a payment settled before it reads as "the figures were not recorded", never as a mismatch.
- Existing test fixtures that signed a paid Billplz callback without `collection_id`, `amount` and `paid_amount` now carry them, as Billplz documents.
