# ADR 0062: A pass is judged on the session's date and entries given back are not dead; giving days back never runs a membership into its renewal; a suspension of a renewing membership gives its days back; the concession check and the review invitation are decided once

- **Status:** current, decided 2026-11-06 on the ninth audit's findings D1, D2, D4, D5, D7, D12 and H5; built in migration 0309. What customers and venues see is in
  [pricing](../../features/pricing.md) (*Passes that end, and entries given back*, *Concession prices*, *Membership validity*, *Suspending a membership*) and
  [discovery](../../features/discovery.md) (reviews). Builds on [ADR 0054](0054-money-paid-never-above-price-and-no-silent-price.md) (paid never above the price; the
  refund and credit paths are reused, no new one) and [ADR 0058](0058-safety-and-access-after-a-booking-is-made.md) (what counts as attendance). Findings **not** decided here and
  left to the owner: D3 (a discount kept as an amount), C12/D15 (a paid booking moved cheaper), D14/C14/H6 (late cancel of a pass-paid booking rounds against the customer),
  D6 (tier edits), D8/D9 (what a pass may be spent on), D13.
- **Context:** six defects with two shapes. Three were a judgement made on the wrong day or outside the transaction that acts (a pass judged on *today* so that a pass about
  to end paid sessions weeks after it; the desk's "no proof shown" read outside any lock so a double click charged the concession back twice; an invitation to review asked a
  different question from the link it carried). Three were a second path that forgot what the first one guarded (giving days back on a membership never looked at the holder's
  next term, as a suspension's extension does; entries restored to a pass that had ended or been cancelled went to a ledger the pass could no longer spend from; an open-ended
  suspension of a membership a gateway keeps charging gave the member nothing for the charges).

## Decision 1 (D1, H5): entries given back to a pass are never dead, and a cancelled pass is never revived

- Every path that gives entries back (the customer's and the venue's cancellation, a place taken off a booking, a class cancelled) writes the ledger line as before and then
  calls one function, `giveBackToPass` (`src/lib/store.ts`). It acts only where entries actually go back (a late cancellation that keeps the whole entry changes nothing), in
  the cancelling transaction, once (the line that settles a spend is unique).
- **A pass that has ended is extended** to today plus `venues.pass_restore_grace_days`: **default 30, the recommended value**, 0 to 365, **0 turns it off and keeps today's
  behaviour**. A manager sets it (`POST /api/admin/pass-settings`, with the recommended value in the settings help) and it is in the activity log. The extension is a line of the
  pass's history (a ledger line of 0 entries) with its reason. Why extend rather than credit money: the customer cancelled in good time or the venue cancelled, and the entry
  is what they bought; money is the answer only where the pass can never be used again.
- **A pass cancelled with the unused part handed back is never revived.** `voidPass` records that it was (`passes.void_refunded`; a pass cancelled before the column, or by a
  chargeback, is read from the credit note on its sale). When a booking such a pass still paid is cancelled, the entry's value goes back through the existing refund path:
  a credit note on the pass's sale (`creditReceipt`, which never credits more than the sale took, so the notes together never exceed the price), owed back on its payment where
  it was bought online (`oweBackPass`, refunded from *Refunds owed*), a line in the activity log (`pass.restored_after_void`) because a counter-sold pass's money is handed over by
  staff, and a pair of ledger lines so the cancelled pass stays at what it was when it was cancelled. This covers a refund of nothing, where every entry was on a booking ahead.
- **A pass cancelled without a refund** keeps the sale as sold (the venue's decision, [pricing](../../features/pricing.md)): the entries go back to the ledger and its history says
  they are not handed back. Recorded as a limitation: a venue that rains out a booking paid by a pass it cancelled without a refund leaves the customer without both.
- **A manager can extend a pass's end** (`POST /api/admin/passes/:id/extend`): a day or a number of days, a reason required, never earlier than its end, never past what a pass
  may run, never a cancelled pass; a line of the pass's history and in the activity log.

## Decision 2 (D4): a pass is judged on the date of the session it pays

- `passBlocked` takes the session's date: a pass that ends before it cannot pay it, as a membership cannot cover it. `expires_on` is therefore **the last day it can be played**,
  not booked. Inside its validity nothing changes, and today's check stays (an ended pass pays nothing, whatever the session's date). A weekly series is paid week by week as
  before: the weeks inside the validity are paid and the weeks after are left unpaid with the reason, to pay another way (the series' existing per-week handling).
- A booking paid with a pass is not moved to a day after the pass ends (`FX8_MOVE_PAST_PASS`); a manager can extend the pass first. The counter's list of passes for a booking
  offers only those good on its day. There is no separate "membership allowance": a membership is already judged on the session's date (`activeMembership`).

## Decision 3 (D2): the concession check is decided once, under the booking's lock

- `checkConcession` (and the one-place form) reads the booking's check state under `FOR UPDATE` in its transaction and updates only from `due`. A double click, a second desk
  or a repeat is refused, charges nothing more and writes one counter sale at most. **A proof marked *Seen* is final:** a later *No proof* is refused with its reason (a manager
  reverses it by hand). This is a rule the code did not have; it is the audit's recommendation and the repro's, and is the one place in this ADR a behaviour was chosen rather
  than a defect closed.

## Decision 4 (D5): one function decides who may be asked to review, for the invitation and the link

- `askForReviews` asks `reviewable` about each candidate booking (paid, or free, or attendance verified as ADR 0058 defines it; not a no-show; ended; within 60 days) before it
  sends and before it spends the one invitation per venue and number. A booking the link would refuse gets no email and does not use the invitation up; the next booking that
  counts, or this one once it is paid or its arrival confirmed within the three-day window, is asked about.

## Decision 5 (D7): giving days back never runs a membership into its next term

- `extendMembership` asks the question a suspension's extension already asks (`laterTerm`, the holder's next term or one holding or covering somebody this one covers) and **refuses**,
  saying how many days fit (`FX8_EXTEND_INTO_NEXT`; `FX8_EXTEND_NEXT_FOLLOWS` where none do), changing nothing. Refusing rather than shortening or pushing the next term is what the
  existing term code does (`settleExtension` leaves the end and says why), and a pushed renewal would move a term the customer already paid and was told the dates of.

## Decision 6 (D12): an open-ended suspension of a membership that renews by itself gives the days back when it is lifted

- Nothing here can hold a gateway's charge: pausing collection is a call to the gateway that cannot be checked against the real service from here, and the renewal is charged
  before this system hears of it. So the member is made whole in time. A suspension that is open-ended on a membership with an active subscription extends its end by the days
  it took, **whatever its plan says**, once its last day is known (when it is lifted). A dated suspension, and a membership that does not renew by itself, follow the plan's setting
  as before (the documents' "its end does not move unless its plan says so" stays for them).
- Renewals charged while it is open are made and carry the suspension on, as before. The days each term lost cannot move into the next term (the existing rule), so a term followed by
  a term of the **same chain** leaves its days to the chain's last term (its note says *Carried to MB-…*) whose end takes them all with its own: no term charged for is left without
  its days. Lifted from any term of the chain; never added twice; corrected as for a plan that extends.
- **Not done, left open:** pausing collection in the gateway (the owner may prefer it; it needs a live check against the real service), and telling the member at suspension that
  charges continue. The manager is told in the activity log. A suspension that outlasts the last term charged cannot be repaid in days that fall before it is lifted.

## What was left open

- Whether a cancelled pass's entries should be handed back as money for a pass cancelled **without** a refund.
- Pausing a subscription's collection while a membership is suspended, in place of (or beside) extending the end.
- Whether a dated suspension of a renewing membership should extend by default too.
- A counter-sold pass's money handed back by a pass cancelled with a refund is a line in the activity log and a credit note, not a task on a list of cash owed.
