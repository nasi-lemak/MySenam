# ADR 0078: A customer's cancellation from before money owed back was written down is recorded once, by a manager, from evidence, as a settled row of the owed list; what is handed back now is today's payout, and no day already counted changes

- **Status:** current, decided 2026-11-09 in the bounded hardening round (brief HIST). Built in migration 0348. What managers see is in
  [payments and credit](../../features/payments-and-credit.md#cancellations-from-before-the-obligation-was-written); the route is in [the HTTP API](../http-api.md).
  Builds on [ADR 0074](0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md) (decision 4 left the past cancellations to a read-only review list)
  and [ADR 0075](0075-the-till-is-compared-with-cash-received-and-cash-handed-back-and-a-credit-note-is-not-a-payout.md) (the till is compared with cash received and cash handed back).
- **Context:** before migration 0346 a customer's cancellation of a booking paid at the counter, and a person a customer (or the venue's API key) took off one, wrote only its credit
  note: no owed row, so nobody was told to hand the money back, and nothing records whether it was. `scripts/reconcile-counter-cancellations.sql` listed the candidates, read only, and
  the review checklist said plainly that no screen, route or script could record the outcome. Staff had no safe way to write down (A) a hand-back that did happen back then, or (B) one
  made now.

## What the tests found first (`tests/historical-counter-refunds.test.ts`, `tests/cash-up-refunds-across-days.test.ts`)

A legacy credit note is pointed at by no payout and no owed row, so the cash-up counts it as cash leaving the till **on its own day** (ADR 0075's rule for a note nothing points
at). An owed row of cause `customer_cancelled` for that booking, or a payout naming that note, would make every later cash-up of that past day put the note back into the till and so
silently change a past, possibly counted (`cash_up_counts`) day. A reconciliation therefore cannot be an ordinary owed row or an ordinary payout.

## Decision

1. **One list, per credit note, by the script's rules.** A whole cancellation's note (`booking:<id>`) or a customer's or API key's withdrawal note (`booking:<id>:place:<withdrawal>`),
   written before migration 0346 was applied (`schema_migrations.applied_at`), above nothing, on a booking paid at the counter (cash, QR, transfer, card, or never recorded; not an
   account's charge), not a test or demo, with no owed row for that cancellation or withdrawal, no payout naming that note (for a whole cancellation, none naming no note either: a payout
   from before payouts named their note may be it), no stored credit given by staff for it, and not logged as cancelled by staff. Two rules are wider than before, on purpose: an owed
   row or payout of a **move to a cheaper time** no longer hides the cancellation (the move's difference is a different obligation; it is shown as evidence instead), and withdrawals'
   notes are listed. The script keeps the same rules and stays read only (it gained a `what` column); a test checks both list the same notes. The evidence shown: activity-log actions,
   other credit notes on the booking, stored credit added, payouts already on the booking. No customer contact details: the booking code is the key.
2. **No new ledger: a settled, historical row of `counter_refunds_owed`.** Cause `customer_cancelled` or `place_withdrawn`, so the unique indexes of migration 0346 make it one per
   cancellation and one per withdrawal (idempotency, and two managers at once write one). Written already settled (`outcome` `back`, the manager as `admin_name`), with `owed_since` =
   `settled_at` = the recording time, **never the cancellation's date**, so no past day's "still owed" list changes. Migration 0348 adds nullable columns: the finding (`earlier`, `now`,
   `earlier_and_now`), the part handed back earlier with its actual day and method, the part handed back now, the remainder of the credit note and why it is not returned, the evidence
   reference, the reason, who verified it (admin id and name as it was) and whether a counted day was acknowledged. A CHECK (added `NOT VALID`, then validated; every comparison
   null-safe) holds a historical row to its evidence, reason, verifier, the parts its finding names, `amount` = earlier + now, a stored remainder, and a reason for a remainder above
   nothing. Legacy rows are untouched; nothing is backfilled.
3. **(A) Handed back earlier: no payout, no cash movement**, no change to today or any past day's till. The record says "handed back on <day> by <method> (recorded on <day> as a
   historical reconciliation)". The day must lie between the credit note's day and yesterday: money handed back today is recorded as handed back now, so today's till counts it.
4. **(B) Handed back now: a normal payout dated now**, by the method actually used, on the historical credit note, written by the path a customer's cancellation is settled with
   (`settleCustomerOwed`, via `payOutHistorical`), so today's cash-up counts it as handed back today. The payout carries `counter_payouts.historical_reconciliation` (default false), and
   the cash-up does **not** treat its credit note as linked on the note's day; nor does it link the note through a historical owed row. The note's day stays exactly as it was counted.
   A and B may be in one record (part each). A second credit note is never written and the existing one is never edited.
5. **A preview before saving**, and nothing written by it: what will be written, and the cash-up in words: today's (RM x by <method>) for the part now; the note's day and the earlier day
   *not changed (it counted this credit note as handed back on <note day> under the old rule)*; and for each of those days, and today, a till count already recorded, with who counted
   and when. Any counted day requires `acknowledgeCountedDays: true` to save. Insufficient evidence (no evidence reference, no reason, an incomplete part) is not saved; there is no
   "not owed" outcome: a case without enough evidence stays on the list.
6. **Managers only, venue by venue.** `MANAGER_ONLY` turns the front desk away from the route; a venue's manager lists and records only their own venues' notes (another venue's is 403,
   and 404 once recorded); the platform owner sees every venue. Every record writes `payment.historical_reconciled` in the staff activity log (and `payment.paid_out` for a payout).
   Retention: the row and the payout are kept as the counter refunds they sit with are (no deletion; the booking's names and numbers are anonymised after 730 days, money kept; the
   activity log 730 days). No new period. The free-text evidence and reason are staff's words; the form asks for no customer name or contact.
7. **Once.** The record is written in one transaction that checks the candidate again; the unique index lets one of two managers through, and the other (or a repeated submission) is
   refused "already recorded" with nothing written.

## Interactions, checked

- **Credit notes and the sales journal:** unchanged (none written or edited). **The owed list** (*Owed back at the counter*, the counts and sums of ADR 0076, the reports' liability,
  the customer's "the venue will return" line): a historical row is settled when written, so it is never owed. It shows on the manager's review section as completed, labelled
  historical. **Payouts:** only (B) writes one; it is in today's list of money handed back and today's cash-up. **Past days:** unchanged, counted or not.
- **A booking moved cheaper first:** the move's owed row and payout stand; the cancellation is listed with them as evidence, and its record cannot exceed its own credit note.

## Not decided here

- Whether a customer who comes forward after a "not enough evidence" review is paid is the owner's decision (the review checklist's question); the system only lets it be recorded once
  the evidence is there. Giving a historical refund as **stored credit** is not offered.
- Whether a counted day whose till was in fact short because the money was not handed back should be corrected: it is not (a counted day is never rewritten); the record says what
  happened, and the variance on that day stays as counted.

## Alternatives considered

- **A separate ledger table for reconciliations:** rejected; the owed list already has one row per cancellation and per withdrawal, its unique indexes, its settled-state rules and
  the screens and reports that read it.
- **An ordinary owed row (owed since the cancellation) settled now:** rejected; it would move the note on its own day into the till and change that day's figures and its "still owed".
- **A "not owed" shortcut that removes a case from the list:** rejected; insufficient evidence is not a finding.

## What the tests do not prove

The tests date rows by hand, on PGlite and Postgres; no drawer was counted and no real pilot data was reviewed. Whether money was in fact handed back at the time is the evidence the
manager brings: the system records it and the reference, and cannot check it.
