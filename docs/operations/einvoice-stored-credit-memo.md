# E-invoicing and stored value: a memo for the tax adviser

**Status: open. No treatment has been chosen, by the code or by this memo.** Audit finding C2
and owner decision DEC-19 ([findings register](../audits/findings-register-2026-11-06.md),
[business decisions](../audits/business-decisions-2026-11-06.md)). This document says what
MySenam does today with each kind of stored value, where its consolidated e-invoice counts
the same ringgit twice, what LHDN's published material says and does not say, and the
questions a qualified Malaysian tax adviser must answer before the code is changed. Written
7 November 2026. It is not tax advice, and nothing in it is a tax treatment.

Until the adviser has answered, the restriction in
[known limitations](../roadmap/known-limitations.md) stands: do not switch e-invoicing on
for a venue that sells credit or vouchers. The code now refuses to do that by accident
([what the code does meanwhile](#what-the-code-does-meanwhile)).

## What each kind of stored value is in this code

"Refundable" below means only what the code lets anyone do. Whether a product is
"refundable in nature", which is the test LHDN's FAQ applies
([below](#what-lhdns-published-material-says)), is a question of the terms it is sold on and
of law, not of software: it is put to the adviser.

| Product | Receipt and journal row | Revenue in the journal? | Tax on the receipt | Refundable in this code | Consideration received | Service supplied |
| ------- | ----------------------- | ----------------------- | ------------------ | ----------------------- | ---------------------- | ---------------- |
| **Stored credit** (a top-up at the counter or online) | `wallet:<id>` receipt, category *Stored credit* (`src/lib/store.ts` `topUpWallet`; online: `src/lib/payments.ts` `settleBill`, purpose `topup`) | No: "owed to customers until spent" (`OWED` in `src/lib/accounting.ts`) | None at sale ("taxed when it is spent, on what it buys") | **No path pays unspent credit out.** Credit never expires. A booking paid from credit and then cancelled goes back to credit, not to money. Account closure is refused while credit is held ("ask a venue to refund it": that happens outside the app, with no record of it in it) | At the top-up | When a booking, class or lesson is paid from it |
| **Gift voucher** | `voucher:<id>` receipt, category *Gift vouchers* (`src/lib/vouchers.ts`) | No, as credit | None at sale | A manager may cancel a voucher **nobody has used**: sold at the counter, its receipt gets a credit note and the money goes back by hand; bought online, it is owed back. Not a customer's right in the code. Good for a year (`expires_on`); after that it cannot be redeemed, and **nothing is recorded** at expiry | At the sale | When the code is redeemed into credit, and then as credit is spent |
| **Pass** (entries or minutes) | `pass:<id>` receipt, *Passes* (or *Coaching* for a pack of lessons) | Yes | At the sale | Voiding is not a refund; a manager may hand back the **unused part** (price × share left) with a credit note (`voidPass`). Entries not used by the end date lapse, with nothing recorded | At the sale | As entries are used; **a booking paid with a pass is not a journal row** (`paid_via <> 'pass'`, `src/lib/accounting.ts`) |
| **Membership** | `membership:` receipt, *Memberships* | Yes | At the sale | Voiding is not a refund; a manager may refund the whole fee (receipt credited, owed back; nothing prorated) | At the sale (and each renewal) | Over the term |
| **Booking deposit** (a share of the price paid online to hold a booking) | A receipt of its own (`srv.line.deposit`); the booking's own receipt is for the rest (`bookingGross` = price less shares paid) | Yes, as court hire | At the deposit | Owed back with a credit note when the booking is cancelled in time; a late cancellation keeps the venue's share | At the deposit | When the court time is used |
| **Hire deposit** (kit out against a deposit) | **None** while held: "deliberately not a wallet movement" (`hire_records`, `src/lib/hire-deposits.ts`); a receipt only for what is **kept** (damage, extras, penalties), as a counter sale | Only what is kept | Only on what is kept (provisional, marked) | Handed back on return unless deducted | When it is taken: nothing is recognised; when kept: at the deduction | n/a |
| **Tournament entry fee** | `entry:<id>` receipt, *Tournament entries* | Yes | At the payment | Owed back when the venue calls the event off, and before the draw where the event's rules refund; a counter-paid fee is owed back as a recorded debt, handed back by a named person | At the payment | When the event is played |

## The accounting entries today

The sales journal (`salesJournal`, `src/lib/accounting.ts`) is the books' view. For the
RM100 top-up and the RM30 booking paid from it:

| Date | Journal row | Gross | `revenue` |
| ---- | ----------- | ----- | --------- |
| Top-up | Receipt, *Stored credit* | 100.00 | false |
| Booking paid from credit | Receipt, *Court hire*, paid via credit | 30.00 | true |

The report's revenue is RM30. Credit still held is a liability to the customer (`walletLiability`
in the reports), RM70. For a gift voucher the voucher's receipt is the first row and the
redeemed credit then pays bookings the same way. A pass is the other design: the pass sale is
the revenue and the booking it pays is not a row.

## How the consolidated e-invoice is made today

`consolidate(venueId, period)` in `src/lib/myinvois.ts`, from `runEInvoicing` on the
scheduler (first seven days of a month, then hourly catch-up) or a manager's *Send last
month now*:

1. It reads the month's sales journal (less a not-yet-live venue's test bookings).
2. A single sale above RM10,000, and any receipt a customer asked an e-invoice for in their
   own name, are taken out and invoiced on their own.
3. **Every other journal row with `type = 'Receipt'` and gross above zero** is one receipt of the
   consolidated e-invoice: `journal.filter((r) => r.type === "Receipt" && !own.has(r.number) && r.gross > 0)`,
   in `consolidate` and again in `linesFor`. The row's `revenue` flag is **not** looked at.
4. The receipts are grouped into one line per category and tax rate ("Stored credit, 2026-10:
   1 receipt (R-…)"), classification 004, buyer the general public.
5. The month's credit notes become consolidated credit notes, each against the e-invoice that
   carried the sale it reverses.

## Exactly where the double count is

Step 3. The RM100 *Stored credit* receipt (`revenue: false`) and the RM30 *Court hire*
receipt paid from that credit are both receipts of the month, so the consolidated e-invoice
totals **RM130 for RM30 of sales**. `tests/einvoice-stored-credit.test.ts` pins this, labelled
as pending policy. The same happens with a gift voucher: the voucher's receipt and, once
redeemed, the bookings it pays. A pass does not do this, because the booking it pays is
not a journal row.

What the double count leaves untreated, whichever way the adviser answers:

- **A cancelled credit-paid booking** gives the money back to credit and writes a credit note
  for the booking's receipt; the consolidated credit note reverses the RM30, the RM100 stays.
- **Credit never spent** (it does not expire) and **vouchers that lapse** have no e-invoice
  event at all, and no journal event at lapse.
- **Credit given back by a venue by hand**, outside the app, has no record in it, so nothing
  corrects the e-invoice that carried it.
- **A voucher voided** before use gets a credit note on its receipt, which becomes a
  consolidated credit note against the e-invoice that carried the sale.

## What LHDN's published material says

Read on 7 November 2026, from the documents themselves:

- **E-Invoice FAQ, "updated on 04 September 2026"**: <https://www.hasil.gov.my/media/0xqitc2t/lhdnm-e-invoice-general-faqs.pdf>.
  Section (ix), *e-Invoice treatment for vouchers, gift cards and loyalty points*, begins:
  "Note that this applies to both monetary vouchers (e.g., gift card, token, stamp (other than
  postage stamp), **credit reload** etc.) and non-monetary vouchers". Then, in substance
  (questions 71 to 75): a voucher given free or **refundable** in nature needs no e-invoice when it
  is given or sold, and a **non-refundable** voucher sold needs one; on expiry, a free or non-refundable
  voucher needs none, a **refundable** one needs one; on redemption of a refundable voucher an
  e-invoice is issued for the sale, with the voucher in the optional "prepayment" field and
  "Total Excluding Tax" equal to the total sales; on redemption of a non-refundable voucher an e-invoice
  is issued whose "Total Excluding Tax" equals the sales **not settled by the voucher**, the voucher
  in a separate invoice line. Question 57 treats deposits the same way: refundable, none;
  non-refundable, required. Question 38: a consolidated e-invoice is to be issued "within seven (7)
  calendar days after the month end". Question 53: one credit note may adjust several e-invoices,
  consolidated ones included.
- **E-Invoice Specific Guideline, version 4.9, "date of publication: 7 September 2026"**:
  <https://www.hasil.gov.my/wp-content/uploads/IRBM-e-Invoice-Specific-Guideline.pdf>. Section 3.6.2:
  suppliers may aggregate transactions with buyers who do not require an e-invoice monthly and
  submit a consolidated e-invoice "within seven (7) calendar days after the month end". It has no
  text on vouchers, credit reloads or prepayments (searched: gift, loyalty, coupon, deposit, advance,
  prepaid).

What I could not find: a definition of "refundable in nature"; any worked example of how
a **consolidated** e-invoice, as against an individual one, carries a voucher sale, a credit
reload or their redemption; any treatment of unspent credit that never expires; what follows a
consolidated e-invoice issued after the seventh day. The FAQ was read as a PDF fetched from
hasil.gov.my; the Guideline likewise. Nothing was checked against the MyInvois sandbox, and
secondary summaries (accounting-software vendors' articles) were not relied on.

## The questions for a qualified Malaysian tax adviser

1. **Is stored credit sold by a venue "refundable in nature" or not, for the FAQ's section (ix)?**
   In this code no path pays unspent credit out and it never expires, but venues may refund by hand
   outside the app. Does the answer turn on the terms the venue sells it on, on what the venue
   does in practice, or on consumer-protection law? Is a *different* answer right for a gift
   voucher (sold to one person, redeemed by another, good for a year) than for credit?
2. If **non-refundable**: is an e-invoice due **at the sale** of the credit or voucher, and may it be
   in the monthly consolidated e-invoice? Then, at redemption, the FAQ asks for an e-invoice whose
   total is the sales not settled by the voucher: **how is that shown in a consolidated e-invoice**
   for a booking paid wholly from credit (a nil-payable line carrying the voucher in a separate
   line, or no e-invoice for the booking)?
3. If **refundable**: no e-invoice at the sale, an e-invoice at redemption for the whole price
   with the credit as a prepayment, and **an e-invoice on expiry**. Credit here does not expire; do
   gift vouchers' expiry at one year, and a venue's closure, bring that event? What is the sale
   figure at expiry?
4. **Service tax (SST).** The receipts carry no tax at the sale of credit or a voucher ("taxed
   when spent"). Is that the right time for SST on a service paid for in advance, for a
   registered venue? Does the answer change with the answer to question 1?
5. **Which document and which date.** For a booking paid from credit, is the supply made, and the
   consolidated e-invoice's month decided, by the booking's date or the date the credit was
   spent? For credit sold in one month and spent in the next, which month carries what?
6. **Reversals.** A credit-paid booking cancelled (the money returns to credit): is a credit note
   against the consolidated e-invoice right, and does it follow the credit or the booking? A voucher
   voided before use: a credit note, or no e-invoice ever? Credit a venue gives back by hand: what
   must the venue record, and where?
7. **Passes and memberships**, which this code already treats as the sale (a booking paid with a pass
   is not a row): is that consistent with the answer for credit, or does the same prepayment rule
   apply to them?
8. **Deposits.** Booking deposits (a share of the price, own receipt, balance paid later) and hire
   deposits (held, nothing recognised until kept) against question 57: are they "refundable" for
   this purpose? Does the deposit paid online for a booking belong in the consolidated e-invoice at
   receipt, as it does today?
9. **Timing.** A consolidated e-invoice made after the seventh day because of an outage: is it
   accepted, and what must the venue record? (MySenam marks it late and does nothing else.)
10. Whether a **venue, or the platform**, is the supplier for credit whose scope is the whole install
    (`MYSENAM_CREDIT_SCOPE=platform`, a single business's own copy) rather than one venue.

## Recommended implementation, conditional on the answer

Nothing below is to be built before the adviser answers in writing, and each is a change to a
tax record, so each needs a decision record.

- **If credit and vouchers are refundable in nature** (the FAQ's first branch): leave the credit
  and voucher receipts, and their credit notes, out of consolidated e-invoices
  (`revenue = false` rows); the booking paid from credit stays in. This matches the journal and
  the audit's default (A). Needs: an e-invoice **on expiry** for a voucher that lapses unspent
  (and for credit, if it can lapse), and the credit entered as the "prepayment" on any individual
  e-invoice for a credit-paid booking. Unspent credit sends nothing.
- **If non-refundable** (the second branch): the receipt of the credit or voucher stays in the
  consolidated e-invoice at the sale, and a booking paid from it must **not** add its price again:
  it is left out of the consolidated e-invoice as a pass-paid booking is (option B), or carried so
  that the total excludes the part settled by the credit. Needs: the same exclusion for the
  credit notes of such a booking, and none on expiry.
- **If it differs by product** (credit one way, vouchers another): the rule is per category, by the
  journal's category, and the exclusion above is chosen per category.
- **Either way:** the exclusion belongs where step 3 filters (`consolidate` and `linesFor`), as a
  single predicate over the journal row, never a guess at what a row is; the existing test
  `tests/einvoice-stored-credit.test.ts` is then changed to the answer (RM30 or RM100), and the audit
  scenario is kept; and the settings screen's warning is removed or reworded.
- **Not done by guessing:** nothing is reclassified automatically for a venue already e-invoicing;
  a venue's earlier consolidated e-invoices that carried both are an adviser's matter (a credit
  note and a replacement), not a migration.

## What the code does meanwhile

- **Nothing about the treatment changed.** The consolidated e-invoice carries what it carried, and
  `tests/einvoice-stored-credit.test.ts` says so, labelled pending policy.
- **A venue that has sold stored credit or a gift voucher** (a receipt for either, a paid online
  top-up or voucher, or a voucher issued: `storedValueSales`, `src/lib/myinvois.ts`) **is refused**
  when it switches e-invoicing on, with the explanation in the staff's language, unless its
  manager ticks that they understand (`acknowledgeStoredValue`); the acknowledgement is written
  to the activity log. A venue already on is not switched off and can edit its details. A venue
  that has sold neither is not held back, and one that starts selling credit **after** it
  switched e-invoicing on is not warned by the code: that gap is for the adviser's answer to close.
- **A consolidated e-invoice made or sent after the seventh day** of the following month shows a
  *Late* marker beside its status, with the date it was due after (audit G15). The marker is only
  a marker: LHDN's FAQ and Guideline state the seven-day period and say nothing on what follows a
  late one, so nothing else is done differently ([MyInvois](../integrations/myinvois.md)).

Related: [MyInvois](../integrations/myinvois.md), [payments and credit](../features/payments-and-credit.md),
[regions and tax](../product/regions-and-tax.md), [reporting](../features/reporting.md).
