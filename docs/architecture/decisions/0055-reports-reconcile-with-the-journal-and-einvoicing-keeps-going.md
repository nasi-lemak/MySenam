# ADR 0055: The period report's money is the sales journal's, the venue's liabilities are in ringgit, and e-invoicing keeps going

- **Status:** current, decided 2026-11-06 (the audit 9 fixes G2, G3, G4, G5, G15, G16 and C8, C9). No migration. What a venue sees is
  [reports and exports](../../features/reporting.md); the e-invoice states and retries are in
  [MyInvois](../../integrations/myinvois.md). Builds on the sales journal (`src/lib/accounting.ts`) and on the owner's recommendation in
  the audit: a **cash basis that matches the journal**, one number for the accountant and the venue.
- **Context:** the period report (`venueReport`) summed the booking row's `total_price`, the sales journal sums receipts and credit notes,
  and the two disagreed in four ways. A goodwill price adjustment on a paid booking that stays confirmed is a credit note the journal
  nets and the report ignored (RM40 collected against RM30 in the journal). A deposit or friends' shares paid online are on receipts the
  journal counts, and the report counted no part of them as collected and the whole price as outstanding. A booking paid with a pass was
  counted as RM collected though the pass sale is the money, and its tax was not (two bases in one report). And the CSV guard for
  formulas turned every negative amount, a credit note's `-40.00`, into the text `'-40.00`, so a column of the journal export did not
  sum. Separately, the venue's liabilities were pass hours and a count of memberships, with no ringgit, no vouchers, no deposits and no
  refunds owed; and e-invoicing stopped every venue on one venue's error, tried the month's consolidation only on days 1 to 7, and left
  a document that was *not sent* until somebody pressed *Send*, alerting nobody.
- **Decision, 1: one definition of each money figure, implemented once.** `bookingMoney` (`src/lib/reports.ts`) reads, for every
  non-test booking played in the period that is confirmed or cancelled late, the journal's own parts: the booking's receipt
  (`bookingGross`) when paid and not by pass, plus the deposit and friends' shares on their own receipts (a confirmed booking's
  `shares_paid`; a cancelled one's receipts and their credit notes, `bookingSideNet`), less the credit notes on its receipt
  (`bookingCredited`). Everything the report says about booking money (`collected`, `collectedBy`, by activity, by month, `lateKept`, the
  booking part of `tax`, `outstanding`, and the new `adjusted` and `passPaid`) is summed from that one list. The definitions are the table
  in [reporting](../../features/reporting.md#reporting). *Still owed* is the price less the deposit and shares already paid, for confirmed
  bookings not paid in full. *Booked* is accounted for by the others (collected less kept, plus owed, given back and paid with a pass), and a
  test asserts it.
- **Decision, 2: a booking paid with a pass is not collected.** The pass sale is the money (the journal's own rule: the pass is a row of
  *Passes*, taxed when sold; a booking paid with it is not a row). The report leaves the booking out of *collected*, its split, its tax
  and *outstanding*, and shows it as `passPaid` (how many, at their price) beside *collected* so the figures bridge. The usage basis (count pass
  hours at value) was the alternative and was not chosen: it would make the report and the journal differ for ever.
- **Decision, 3: the basis stays the date played, and the difference from the journal is said.** The report counts a booking on the day it
  was played; the journal counts money on the day it was paid. Changing the report to the payment date would move every month's trend and
  the per-court figures; the two agree over any period that holds both dates of a booking, which is what the reconciliation test sets up
  (cash, deposit then balance, split shares, pass, credit, refund, adjustment, late cancellation with and without a deposit and a share).
  A venue reconciling a month in which bookings were paid before it and played in it will see that difference, and the page says why.
- **Decision, 4: the liabilities in ringgit, provisional.** `liabilities.owed` adds, as of today: stored credit where it is the venue's;
  gift vouchers not yet redeemed and unexpired (lapsed ones apart, not in the total, until the venue's adviser says how they are treated,
  which is [audit C15](../../audits/index.md)'s open owner decision); deposits and shares held on confirmed bookings not paid in full and still to
  be played; deposits held on kit out on hire; refunds owed (online and at the counter). **Prepaid passes:** the one RM value the code
  already has is what voiding a pass with a refund gives back (its price times the share of entries left), so it is shown as an
  *estimate*, outside the total (passes are sold as takings). Memberships stay a count. Nothing in the report is a statement of how any of
  it is treated in the venue's books; every label says provisional.
- **Decision, 5: the CSV guard is for text.** `toCsv` (`src/lib/export.ts`) guards a text cell that starts `=`, `+`, `-`, `@`, tab or CR
  with an apostrophe, as before. A JavaScript number, and a string of nothing but a minus sign, digits and one decimal point, is a number
  and is written as it is. A string such as `-1+1` is still guarded. Every `toCsv` caller was read: the sales journal and summary, the
  bookings list and payments list, the coach schedule, the attendance export and the ratings ledger. The ledger's negative rating
  changes were text too, and are now numbers.
- **Decision, 6: e-invoicing is isolated per venue, retried, and never silent.** (a) `runEInvoicing` wraps each venue's consolidation in
  its own `try`, and `submitPending` each document's send, so one failing venue no longer stops the others, nor the sending and checking
  of that tick; the failure is an alert for the platform's owner (`raiseAlert`, key `einvoice:<venue>:…`, told again every
  `RESEND_HOURS`) and, whenever the owner is told, a message to that venue's staff in their own staff language. (b) The month before is
  consolidated on any day of the month, not once in the first seven days: every run in the first seven days, then once an hour, and then
  only for a venue that e-invoiced before the month began (so a venue that has just switched it on is not sent earlier sales
  unasked). `consolidate` is idempotent by its number, so a repeat or a second server makes nothing twice. A month further back is not made
  by itself. LHDN's timing for a consolidated e-invoice is `UNVERIFIED` and stays so; what a late one means is for the adviser. (c) A
  document that **certainly did not reach LHDN** (*not sent*) is put back to waiting after a back-off (15, 30, 60, 120, 240 minutes, then
  6 hours, by how many tries it has had, from its history) and sent again by the same claim as any send; each failed try is on its
  history and alerts as in (a). A document whose outcome at LHDN **is unknown** is never retried by itself: staff settle it against the
  portal, as before. MyInvois remains a stand-in, `INTEGRATION_VERIFICATION_REQUIRED`.
- **What this changes:** `collected` for a paid booking adjusted down is the adjusted amount (RM30, not RM40); a deposit or friends'
  shares are inside *collected* and out of *outstanding*; a pass-paid booking is out of *collected* and its "pass" line out of *collected
  by*; the tax of an adjusted booking has the credit note's tax taken off; `lateKept` includes the deposit and shares a venue kept of a
  booking cancelled late; the journal CSV and the other exports write negative amounts as numbers. The staff Reports tab shows what the
  basis is, *given back*, *paid with a pass*, and the liabilities block.
- **Not done, and why:** [C2](../../audits/index.md) (what the consolidated e-invoice does with stored-credit sales and the bookings they
  pay) is a tax adviser's question and is left as it is. The `bookingSideNet` attribution of a deposit shared by several bookings is by
  what each took of it, and a chargeback credit note across a multi-booking deposit is not shared out. A receipt for a share paid at the
  counter does not exist, so it is in neither the report nor the journal. The 1 sen difference between the JavaScript and SQL rounding of
  a half sen (C13) is left: `roundMoney` is used by every money path and changing it is a decision for its own change.
