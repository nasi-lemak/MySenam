# ADR 0063: A suspended venue tells its customers and sells nothing new; an overdue one can be given time; a branch is not approved on its own under a business that is not in good standing

- **Status:** current, decided 2026-11-06 on an audit's findings (audit 9, auditor A: A4, A7, A11; auditor H: H8, the suspension part only); built in migration 0311. What
  staff and the owner see is in [the marketplace](../../product/marketplace.md#running-the-marketplace); the notice is in [messaging](../../integrations/messaging.md#a-venue-taken-off-the-marketplace);
  the routes are in [the HTTP API](../http-api.md). Builds on [ADR 0005](0005-shared-marketplace-and-own-installs.md) (a marketplace of independent venues),
  [ADR 0056](0056-outbox-reliability-messages-survive-outages-and-stops.md) (the outbox, and urgent news that is not capped) and [ADR 0057](0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md)
  (the owner's decisions are logged with a reason). Every default below is the audit's recommended one; what is left to the owner is under *What was left open*.
- **Context:** a venue suspended by the owner, or held for an invoice more than 14 days overdue, was modelled as a listing flag. Its staff were emailed; its customers were not, so
  somebody with a booking, a pass, a membership or credit there learned it by failing to use it. The counter could still sell credit and passes while the venue was dark. A membership that
  renews itself is charged by the gateway, not by this code, so it kept being charged. The owner had no way to give a struggling venue time: an invoice could be marked paid when it was not,
  or voided (forgiving it, with no trace), and the owner's "lift" on a venue held for payment answered "That venue is not suspended", which was untrue. And a business whose only live branch
  was suspended could add a branch that went live on its own.

## Decision 1: customers with something at the venue are told once

- When a venue goes off the marketplace, whether by the owner (a venue or a whole business) or for an overdue invoice, every customer who holds one of these there is emailed once: a
  confirmed booking, class or lesson that has not been played, an active pass with entries left, an active membership, or stored credit (the pot the venue belongs to, a business's branches
  sharing one). Test and demonstration bookings are left out.
- The notice (`venue_suspension_notice`, email only, written in the account's language or, for a guest, the language the booking was made in; English, Malay, Chinese and Tamil) says that the
  venue is not available for now and that this is not the customer's doing; what they hold there; that **bookings stand** and can be cancelled and refunded as usual (with a link to their account
  or to *My booking*); that passes, memberships and credit cannot be used until the venue is back and are not lost; and the venue's telephone number to ask. It promises nothing that is not built.
- It is **urgent news** (`URGENT_NEWS_KINDS`): not held to the day's limit of eight messages per recipient, only to the high ceiling urgent notices have.
- **Once per suspension.** Each email is queued under a key of the venue, the stamp of the suspension and the address; the venue records the stamp it has told for
  (`venues.suspension_told_for`); and the scheduler's check (the same one that applies payment holds) tells any suspension not yet told for, so a stop between the suspension and the emails is
  mended. A venue lifted and suspended again is a new suspension and is told again. An owner suspending a venue already held for an invoice keeps the original stamp (one suspension, told once).
  Suspensions already in force when migration 0311 ran are marked as told: a deploy is no reason for a burst of old news.
- An account that said it is under 18 is not written to, as in the venue's other notices to account holders. A pass or membership sold at the counter to nobody with an account has no address
  here: its venue tells them (the venue's own staff can see who holds what).

## Decision 2: nothing new is sold at a suspended venue, and renewals wait

- Counter sales of **passes, memberships, credit and gift vouchers** are refused while the venue is suspended or held (`409`, `FX11_SALES_SUSPENDED`), as are the same online
  (`FX11_SUSPENDED`, which says why, where before a customer was told the venue "does not take payment online" or to "buy one at the counter"). A venue that has not gone live is a draft and not
  suspended, so its staff may still try their counter. Something paid for before the venue went off is settled as ever (the money is taken, so the pass is made).
- **Memberships that renew themselves** (Stripe subscriptions: the gateway charges, not this code) are paused at the gateway while their venue is suspended and carried on when it is back
  (`reconcileRenewalPauses`, `pauseSubscription` on the gateway, Stripe's `pause_collection` with behaviour `void`). While paused nothing is charged and nothing is billed afterwards for the time
  paused; the member's membership runs to its own end, and the next charge, once the venue is back, runs on from it as every renewal does. `membership_subscriptions.paused_at` records what the gateway
  accepted; a refusal leaves the subscription as it was and raises an alert to the owner, and the next check tries again (so it also heals after a stop). The existing **membership suspension**
  machinery (a manager suspending one membership) was not used: it is per membership, it still charges the renewal by design, and it does not stop a gateway.
  **Not verified against the real Stripe** (`INTEGRATION_VERIFICATION_REQUIRED`); the restricted key needs *Subscriptions: write*, as stopping a renewal already does.
- **Bookings stand**, and can be cancelled and refunded as usual: verified, and kept. The venue's public page and booking pages already refuse new bookings; nothing there changed.

## Decision 3: the owner can give an overdue invoice time without falsifying the books

- `POST /api/admin/billing { action: "giveTime", invoiceId, until, reason }` (the owner): `venue_invoices.billing_grace_until` (migration 0311) with the reason, who gave it and when. The venue is not
  held for that invoice until **after** that date (a date after today, at most 90 days ahead). The invoice itself is untouched: its due date, amount and status stay as issued, it is **not marked paid**
  (`paid_via` stays empty) and nothing is voided, so the books say what happened. If it is still unpaid when the time ends, the venue is held at the next check, as before. `until: null` takes the time
  back.
- A venue already held for it comes back at once; its managers are emailed the date and the day it would be held from. The overdue warning is not sent for an invoice given time (it would name a date
  that no longer holds). The reason is the owner's to read: a venue's managers see the date, not the reason.
- **`liftVenue` works for a hold for payment.** Lifting it is giving the overdue invoices time (`graceUntil` and a `reason` are required, `FX11_GRACE_NEEDED` and `BILL_REASON_REQUIRED` otherwise); the answer
  "That venue is not suspended" is now said only when it is not. A lift of an owner's suspension takes an optional reason. Giving time on a business's invoice brings back every branch held for it.
- Written to the staff activity log (ADR 0057): `invoice.grace_given` on the invoice, and `venue.suspension_lifted` with the invoices, the date and the reason when a hold was lifted that way.
  The dashboard offers *Give time* beside *Mark paid* on an unpaid invoice and on a venue held for payment.

## Decision 4: a branch is not approved on its own under a business not in good standing

- With `MYSENAM_AUTO_APPROVE_BRANCHES=on`, a branch whose location checks pass was approved on its own when any other branch had ever been published. It now needs another branch that is **live and
  open**, and **no other branch suspended or held for an invoice**. Otherwise its request is sent to the owner like any other, whose email says why it was not approved automatically. A suspended
  business is still refused outright (`businessSuspension`), as before. The owner can approve such a request by hand.

## What was left open (owner decisions)

- **Pass and membership validity is not paused or extended for the time a venue was off.** The notice says they wait and to ask the venue; a manager can extend a membership by hand (*extend*,
  `POST /api/admin/memberships/:id/extend`). Whether the platform should extend automatically by the suspension's length (the audit's option, for suspensions that end in a lift) is the owner's.
- **Closing or leaving a venue is not built** (audit finding A5, and the exit part of H8): there is no way to close a venue for good, list what customers hold and refund it, or release a customer's
  account from the credit that blocks erasure. This ADR changes only what a suspension does. Credit at a suspended venue still cannot be spent.
- A "the venue is back" email to customers is not sent; the venue is simply visible again.
