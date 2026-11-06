# Findings register, 6 November 2026

The register of the business-process audit of MySenam at commit
`2aabdd406626c9f1bdbd32e65addf599d0751c6f` (6 November 2026): every finding of
the eight auditors, once, with its evidence, its cause, what was recommended,
and where it stands after the fix round that followed. It is read with the four
records the audit produced
([inventory](business-process-inventory-2026-11-06.md),
[cross-domain consistency](cross-domain-consistency-2026-11-06.md),
[state transitions and recovery](state-transitions-and-recovery-2026-11-06.md),
[business decisions](business-decisions-2026-11-06.md)) and with the
[remediation roadmap](remediation-roadmap-2026-11-06.md), which orders what is
still open.

This is a dated record. The finding text (scenario, observed, evidence, root
cause, recommendation) is the audit's, condensed, and describes the baseline
commit; code references (`file:function`) are to that commit and may have moved.
Only the **Status** line of each finding says what has changed since. Status
comes from the lead's fix-round status file and was checked against the tests
and decision records it names (see [how status was checked](#how-status-was-checked)).

## Contents

This file holds the summary and sections A to D; sections E to H are in
[the second half](findings-register-2026-11-06-e-to-h.md).

- [Summary](#summary): counts by severity, status and domain; definitions
- [A: marketplace lifecycle, tenancy and permissions](#a-marketplace-lifecycle-tenancy-and-permissions)
- [B: court reservations](#b-court-reservations)
- [C: money](#c-money)
- [D: memberships, passes, prices and standing](#d-memberships-passes-prices-and-standing)
- [E: classes, coaching, venue operations and safety](findings-register-2026-11-06-e-to-h.md#e-classes-coaching-venue-operations-and-safety)
- [F: competitions, matchmaking and messaging](findings-register-2026-11-06-e-to-h.md#f-competitions-matchmaking-and-messaging)
- [G: communications, reports, privacy and the scheduler](findings-register-2026-11-06-e-to-h.md#g-communications-reports-privacy-and-the-scheduler)
- [H: adversarial sequences across modules](findings-register-2026-11-06-e-to-h.md#h-adversarial-sequences-across-modules)

## Summary

140 findings were listed by the eight auditors (A1 to A15, B1 to B16, C1 to
C19, D1 to D24, E1 to E19, F1 to F14, G1 to G20, H1 to H13). Where two or more
auditors found one defect they are one block here, headed with every identifier
(`B1 = E9 = H3`); the [equivalences](cross-domain-consistency-2026-11-06.md#the-same-defect-found-more-than-once)
are explained once, there, and a block here says "same as" only to name its
partners. H11 is the first point of G20, and H8 spans A4 and A5. That leaves
117 blocks. Counts below are by identifier (140), so a
block of three is counted three times, as the auditors did.

**These identifiers are the audit's own.** A1 to H13 are not the S, B and M defect
numbers of [known limitations](../roadmap/known-limitations.md), which are never reused:
the register's B1 to B16 are not that page's B1 to B16. Known limitations cites an
audit finding as *audit B1*.

### Severity

| Severity | Meaning |
| -------- | ------- |
| P0 critical | Money loss or leak, a security breach, data corruption, or unambiguous intended behaviour broken. None was found |
| P1 launch blocker | A verified correctness, financial, security or reliability defect that a launch should not carry |
| P2 important | A real defect, missing workflow or questionable policy that matters for broader adoption or daily operation |
| P3 optional | A small defect, an edge, an operational risk or an improvement |

Severities are the auditors' own and are not changed by the fix round: a fixed
P1 is still a P1 finding. The project's priorities in
[known limitations](../roadmap/known-limitations.md) use the same four words.

### Status

| Status | Meaning |
| ------ | ------- |
| FIXED | Changed in the fix round, with the regression test and the decision record named in its block. The tests ran on PGlite, and where the finding is a race or concerns money also on Postgres, run by the fix workers; the lead's full validation of the integration branch is recorded in [testing](../development/testing.md#release-records) (linked, not repeated here). A fix is not a live check: where it sends a message, takes money or calls a provider, its integration row in [feature status](../product/feature-status.md#integrations) is still `INTEGRATION_VERIFICATION_REQUIRED` |
| PARTLY | Part of what was found is fixed; the block says what remains |
| OPEN | Not changed in this round. No owner decision is needed to start, or none was written down |
| OPEN decision | Not changed: the answer is the owner's (business, legal or tax). The question is a `DEC-nn` in the [business decisions](business-decisions-2026-11-06.md) where one was written |

### Totals

| | P1 | P2 | P3 | All |
| - | -- | -- | -- | --- |
| FIXED | 18 | 48 | 11 | 77 |
| PARTLY | 0 | 8 | 2 | 10 |
| OPEN decision | 1 | 12 | 7 | 20 |
| OPEN | 0 | 3 | 30 | 33 |
| **All** | **19** | **71** | **50** | **140** |

The one P1 not fixed is C2 (what the consolidated e-invoice does with
stored-credit sales and the bookings they pay), which is a tax adviser's
question and is left as it was. No P1 is open for want of work. Every P2 and P3
that is open is listed with its reason in the
[remediation roadmap](remediation-roadmap-2026-11-06.md).

### By domain

| | Domain | Findings | P1 | P2 | P3 | FIXED | PARTLY | OPEN decision | OPEN |
| - | ------ | -------- | -- | -- | -- | ----- | ------ | ------------- | ---- |
| A | Marketplace lifecycle, tenancy and permissions | 15 | 3 | 7 | 5 | 9 | 1 | 2 | 3 |
| B | Court reservations | 16 | 5 | 7 | 4 | 9 | 2 | 2 | 3 |
| C | Money | 19 | 2 | 10 | 7 | 11 | 1 | 5 | 2 |
| D | Memberships, passes, prices and standing | 24 | 0 | 11 | 13 | 7 | 1 | 6 | 10 |
| E | Classes, coaching, venue operations and safety | 19 | 2 | 11 | 6 | 11 | 1 | 1 | 6 |
| F | Competitions, matchmaking and messaging | 14 | 1 | 7 | 6 | 7 | 2 | 1 | 4 |
| G | Communications, reports, privacy and the scheduler | 20 | 4 | 12 | 4 | 15 | 1 | 0 | 4 |
| H | Adversarial sequences across modules | 13 | 2 | 6 | 5 | 8 | 1 | 3 | 1 |
| | **All** | **140** | **19** | **71** | **50** | **77** | **10** | **20** | **33** |

Partly fixed: A4, B6, B16, C5, D10, E4, F8, F10, G16, H8. Open for a decision
(owner, adviser or lawyer): A5, A10, B9, B11, C2, C12, C14, C15, C18, D3, D6,
D8, D9, D14, D15, E10, F6, H6, H7, H13. Open: A13, A14, A15, B12, B14, B15, C13,
C19, D11, D13, D16 to D19, D21 to D24, E11, E15 to E19, F11 to F14, G17 to G20,
H12.

### The fix round

Eleven fix workers each wrote a decision record (and a migration where one was
needed). Every record is `current` and describes what was built, what it chose
and what it left.

| Worker | Decision record | Migration | Findings it closed |
| ------ | --------------- | --------- | ------------------ |
| FX1 closures, class-cancel race, series hours | [ADR 0053](../architecture/decisions/0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md) | 0295 | B1, B2, B4, B5, E1, E8, E9, E14, H3 |
| FX3 payment path | [ADR 0054](../architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md) | 0297 | B3, B8, B10, B16 (deposit part), C1, C3, C4, C16, D20, H1 |
| FX5 reports and exports | [ADR 0055](../architecture/decisions/0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md) | none | C8, C9, G2 to G5, G15, G16 (liabilities) |
| FX6 outbox reliability | [ADR 0056](../architecture/decisions/0056-outbox-reliability-messages-survive-outages-and-stops.md) | 0299, 0300 | C17, G1, G7 to G11, G13, G14, H11 |
| FX7 security, privacy, audit log | [ADR 0057](../architecture/decisions/0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md) | 0301 | A1, A2, A3, A6, A8, A9, A12, G6, G12, H2 |
| FX9 safety and access | [ADR 0058](../architecture/decisions/0058-safety-and-access-after-a-booking-is-made.md) | 0303 | E2, E3, E4 (part), E7 |
| FX10 competitions and moderation | [ADR 0059](../architecture/decisions/0059-competition-notices-fees-owed-fixtures-lost-and-message-review.md) | 0304, 0305 | C11 = F4 = H4, F1, F2, F3, F5, F7, F8 (part), F9, F10 (part) |
| FX2 waiting-list offers | [ADR 0060](../architecture/decisions/0060-waiting-list-offers-windows-starts-and-closing.md) | 0306 | B6 (court slots), B7, B13, E5, E6, E12, H9 |
| FX4 company accounts and cash-up | [ADR 0061](../architecture/decisions/0061-company-accounts-and-the-cash-up.md) | 0307, 0308 | C5 (part), C6, C7, C10, E13, H10 |
| FX8 passes, memberships, concessions | [ADR 0062](../architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md) | 0309 | D1, D2, D4, D5, D7, D12, H5 |
| FX11 suspension and billing grace | [ADR 0063](../architecture/decisions/0063-a-suspended-venue-tells-its-customers-sells-nothing-new-and-an-overdue-one-can-be-given-time.md) | 0311 | A4 (part), A7, A11, H8 (part) |

Migrations 0298, 0302 and 0310 are unused. The fixes were verified by new tests
written by the fix workers, run on PGlite and, for races and money, on Postgres;
the lead's full validation of the integration branch is recorded in
[testing](../development/testing.md#release-records). Nothing in this register
records a CI run (none is running, see testing) or a check against a real
provider.

### How status was checked

Each FIXED block names a test file; all named files exist under `tests/` and
every decision record 0053 to 0063 exists. Three points where the status file and
the records differ are resolved here, each noted in its block:

- **D20** (no quoted-price check) is listed as open in the status file but is
  built: ADR 0054 decision 3 (`expectedTotal`, `PRICE_CHANGED`) with
  `tests/booking-price-handshake.test.ts`. It is FIXED here.
- **B11** is marked an open decision in the status file but no `DEC-nn` was
  written for it; the auditor classed it a verified defect with one owner
  question (see its block).
- **C4** is fixed without a component test: the API half (`walletErrorCode`) is
  tested; the booking form's sentence is not covered by a rendering test.

### Reading a block

Each block is: identifiers and severity; scenario; observed against expected;
who it matters to; evidence (`file:function` at the baseline); classification
(verified defect, questionable policy, missing workflow, operational risk or
unverified assumption); reproduction; root cause; the recommended resolution;
status. The auditors' repro tests (`audit9-<letter>-<n>.test.ts`) were scratch
files in each auditor's worktree, written to fail at the baseline; **they were not
kept in the repository**. For a fixed finding the regression test that now exists
is named; for an open one the repro, if there was one, was a scratch test and
nothing replaces it yet. Findings found "by reading only" were not exercised.

## A: marketplace lifecycle, tenancy and permissions

Auditor A. How a venue joins, stays on and leaves the marketplace, what the
platform bills, and who may do what.

### A1 = H2 · P1 · FIXED

- **Domain and scenario.** Marketplace lifecycle, retention. A business signs up, makes a ladder (or another unlisted child row), never goes live, and is 90 days inactive.
- **Observed and expected.** `deleteStaleDrafts` deleted a hand-kept list of tables, then `DELETE FROM venues`; `ladders`, `attendance_sessions`, `attendance_marks`, `lesson_moves`, `urgent_notices`, `whatsapp_credit`, `whatsapp_packs`, `invoice_lines` and `tournament_matches.court_id` were in neither the list nor the "leave it alone" exclusions, so the delete raised a foreign-key error inside the one retention transaction. Every retention rule rolled back, every day, and `GET /api/admin/auth/me` (which runs `pruneIfDue()` unguarded) answered 500 for every staff account. Expected: a draft that cannot be deleted is skipped and reported, and neither retention nor the dashboard stops.
- **Matters to.** Platform and customers: personal-data retention silently stops for the whole install (a stated obligation); venues: staff cannot open the dashboard. A free sign-up is enough to cause it 90 days later.
- **Evidence.** `src/lib/drafts.ts` `steps`; `src/lib/privacy.ts` `pruneOldData` (`await deleteStaleDrafts(photoKeys)` inside `db.transaction`); `src/app/api/admin/auth/me/route.ts:19`. The foreign keys were read from `pg_constraint`.
- **Classification.** Verified defect.
- **Reproduction.** Auditors' `audit9-A-1.test.ts` and `audit9-H-4.test.ts` (draft with one ladder, admin last seen 91 days ago; `pruneOldData` rejects; `me` answers 500), PGlite and Postgres, scratch, not kept. Regression: `tests/draft-purge.test.ts`.
- **Root cause.** Purge by an enumerated table list inside a single transaction; housekeeping run unguarded on a request path.
- **Recommended resolution.** A savepoint per business that skips and reports a failure; the missing children covered (or the foreign keys changed); a catalogue-driven test; `me` catches housekeeping errors.
- **Status.** FIXED. `tests/draft-purge.test.ts`; [ADR 0057](../architecture/decisions/0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md) decision 6: the plan to delete is taken from the database's own foreign keys (`draftDeletionPlan`), each business is deleted in its own savepoint, one that cannot be removed is skipped and reported to the owners, and `me` catches, logs and alerts. No migration for this part. See A15 for what the purge still deletes.

### A2 · P1 · FIXED

- **Domain and scenario.** Tenancy. Open venue sign-up gives a staff account for the price of an email address.
- **Observed and expected.** `GET /api/admin/wallet?q=` (`findUserForWallet`) matched `users` by email or phone across the whole platform and returned name, email, phone and balance, with no rate limit; the same oracle sat in `findAccountToLink` and in the "No account has that email address" answers of the pass and membership routes. Expected: staff find only customers connected to their venue, and lookups are throttled.
- **Matters to.** Customers: names and emails by phone number, a PDPA exposure for anyone with a sign-up; platform: account enumeration closed on the customer side (S21, S22) reopened on the staff side.
- **Evidence.** `src/lib/store.ts` `findUserForWallet`; `src/app/api/admin/wallet/route.ts` GET (no `rateLimit`); the repro returned `{"customer":{"id":1,"name":"Siti Strangerwoman","email":"siti@elsewhere.my",...}}` to a draft's manager.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-A-2.test.ts` (scratch). Regression: `tests/customer-lookup.test.ts`.
- **Root cause.** A platform-wide `users` table queried by any staff account with no venue relationship check.
- **Recommended resolution.** Scope lookups to customers with a row at the caller's venues; throttle per staff account; refuse linking from a venue that has never gone live (DEC-06).
- **Status.** FIXED. `tests/customer-lookup.test.ts`; ADR 0057 decision 1: on the marketplace a lookup finds only a customer with a booking, credit, pass, membership, access-list entry or guardianship at the staff member's venues; 30 an hour per staff account and 120 per address; linking flows (which create the relationship) are throttled and refused from a venue not yet live. Residual, open: the email-existence oracle remains in the linking flows for live venues, throttled. A customer who has never booked cannot be found at the counter for a top-up (they top up themselves). No migration.

### A3 · P1 · FIXED

- **Domain and scenario.** Staff invitations. A manager invitation is emailed; the mail provider is down.
- **Observed and expected.** `sendInvitation` filed the email under the venue with the one-time link in its body; `listMessages(venueId)` (open to front desk) returned it unmasked while the message was queued or failed, and the desk could accept it with a password of its own and become a manager. Expected: account links are never returned by a staff-facing list.
- **Matters to.** Venue and platform: privilege escalation desk to manager (refunds, voids, prices, exports, API keys), and the invitee loses the seat, exactly during an email outage when managers re-send.
- **Evidence.** `src/lib/outbox.ts` `listMessages` (no masking) against `listPlatformMessages` (masks `account_email`); `src/lib/staff-accounts.ts` `sendInvitation`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-A-3.test.ts` (scratch: the desk extracts the token and becomes manager). Regression: `tests/outbox-secrets.test.ts`.
- **Root cause.** The mask was applied in one list function only.
- **Recommended resolution.** Mask `account_email` in every staff list; do not store the token in the body.
- **Status.** FIXED. `tests/outbox-secrets.test.ts`; ADR 0057 decision 2: every staff list goes through `forStaff`, which never shows the text, parameters or calendar of an `account_email` message (the owner included) and hides any other `token=` link; resending an invitation gives up the earlier email and replaces the token. Storing a reference and rendering at send time was not done (the mask and the existing wipe give the same protection for the same readers). No migration.

### A4 (H8 in part) · P2 · PARTLY

- **Domain and scenario.** Suspension (by the owner, or held for an overdue invoice) and its effect on existing customers.
- **Observed and expected.** Only the venue's staff were told. Customers with a held unpaid booking could not pay and it lapsed; passes and memberships kept ticking down; stored credit could not be spent; recurring Stripe membership charges continued; the counter could still sell credit and passes; a venue held for an overdue invoice could stay dark indefinitely. Expected: one factual notice to affected customers, the counter not selling new credit or passes, and an owner tool to pause or extend validity and stop renewals.
- **Matters to.** Customers pay or lose days for something they cannot use and learn by failing; the venue takes fresh money while delisted.
- **Evidence.** `src/lib/suspensions.ts` (only `tellVenueStaffEach`), `src/lib/payment-holds.ts`, `src/lib/payments.ts` `stopRenewalOf` (called only on membership void).
- **Classification.** Missing workflow. "Bookings already made stand" is deliberate (marketplace); the silence was not a stated decision.
- **Reproduction.** `audit9-A-4.test.ts` (scratch: a customer with a booking and a pass gets no message after `suspendVenue`). Regression: `tests/venue-suspension-effects.test.ts`, `tests/membership-renewal-pause.test.ts`.
- **Root cause.** Suspension modelled as a listing flag only.
- **Recommended resolution.** A notice to customers with upcoming bookings; owner counts; an owner action to extend validity by the suspension's length; no counter sale of credit or passes while suspended (DEC-01, DEC-02).
- **Status.** PARTLY. ADR 0063 decisions 1 and 2, migration 0311. Fixed: customers holding a booking, class, lesson, active pass, active membership or credit are emailed once per suspension (an urgent notice, in four languages); counter and online sales of passes, memberships, credit and gift vouchers are refused while suspended or held; Stripe subscriptions are paused at the gateway with `pause_collection` and carried on when the venue is back. Open: pass and membership validity is not paused or extended for the time the venue was off (DEC-02, the owner decides; a manager can extend a membership by hand); the gateway pause is **not verified against real Stripe** (`INTEGRATION_VERIFICATION_REQUIRED`: Stripe membership renewals) and the key needs *Subscriptions: write*; there is no customer-visible "renewal paused" marker; a "the venue is back" email is not built; credit at a suspended venue still cannot be spent.

### A5 = H8 (exit half) · P2 · OPEN decision (DEC-03)

- **Domain and scenario.** Venue closure for good, leaving the marketplace, deleting a live venue.
- **Observed and expected.** No closing state exists: venues are draft, live, or suspended. Nothing settles what a venue owes (upcoming bookings and classes, tournament and league fees, lesson packs, passes, memberships and their renewals, stored credit, gift vouchers, owed counter refunds), nothing stops its monthly invoices, and a customer holding credit at a suspended venue cannot erase their account (`eraseCustomer` refuses while credit is held). Expected: an owner-run (and venue-requested) close-down that lists every liability by type with counts and amounts, cancels, refunds or converts them as chosen, stops renewals and billing, tells customers, keeps records for the retention period, and archives.
- **Matters to.** Customers lose money when a venue disappears; the platform bears reputational and regulatory risk; invoices accrue on a dead venue.
- **Evidence.** `rg "wind.?down|closing the venue|offboard"` finds nothing; `src/lib/suspensions.ts`, `src/lib/drafts.ts`; `venues.billing_starts_on` has only `setVenuePlan(null)` to stop it.
- **Classification.** Missing workflow.
- **Reproduction.** By reading and by search; no test.
- **Root cause.** Lifecycle modelled as draft, live, unlisted; no closed state.
- **Recommended resolution.** A `closed_at` state and an owner/manager closing checklist that reuses the cancel, void and refund primitives; billing stops at `closed_at`; credit refunded in cash through the owner or honoured at sister branches (DEC-03).
- **Status.** OPEN decision, DEC-03. Not built; ADR 0063 records it as left to the owner. Size L, migration needed. Until it is built, suspension is the only tool and it strands credit.

### A6 = G12 · P2 · FIXED

- **Domain and scenario.** Platform administrator powers; API-key bookings.
- **Observed and expected.** `POST /api/admin/billing` `markPaid`, `void`, `setPlan`, `setTiers` wrote nothing to `staff_actions` and stored no actor (`markInvoicePaid` set `paid_via='manual'` only); `businesses POST` (grouping venues, promoting staff to business manager), `venues POST` and `venue-applications` were allow-listed as "the owner's own records". `POST /api/v1/bookings` and `/cancel` (a write key that issues credit notes and refunds) also wrote no log row, although the docs say the log answers "who cancelled my booking?". Expected: every owner action that changes money owed, a venue's listing or who manages what, and every key booking, is logged with actor, target, before and after, and a reason where it forgives money.
- **Matters to.** Platform: a stolen or misused owner session can mark invoices paid or change fees with no trace (with 2FA optional, A10); venues: no dispute evidence.
- **Evidence.** `src/app/api/admin/billing/route.ts` (no `logAction`), `src/lib/billing.ts` `markInvoicePaid`/`voidInvoice`, `src/lib/key-bookings.ts`; `tests/staff-log-coverage.test.ts` `NEEDS_NO_ENTRY`.
- **Classification.** Verified defect (audit trail); operational risk.
- **Reproduction.** `audit9-G-7.test.ts` (API-key part: entries `[]`, scratch); the billing part by reading. Regression: `tests/owner-activity-log.test.ts`, `tests/staff-log-coverage.test.ts` (changed: the billing, businesses, venues and venue-applications routes may no longer write nothing).
- **Root cause.** Owner routes exempted from the log rule as "records".
- **Recommended resolution.** Log them; require a reason to forgive; store who did it.
- **Status.** FIXED. `tests/owner-activity-log.test.ts`; ADR 0057 decision 3: marking an invoice paid or void needs a reason (5 to 300 characters, `BILL_REASON_REQUIRED`); fee, billing start, plans by size, grouping, promotion to manager, adding a venue, approving or refusing an application, suspending and lifting are logged with the owner's name, before and after figures and the reason; a booking made or cancelled through an API key is `booking.created`/`booking.cancelled` under `API key "<name>"`. Migration 0301 (see A8).

### A7 · P2 · FIXED

- **Domain and scenario.** Overdue billing, hold, reactivation.
- **Observed and expected.** An invoice had no way to extend its due date or pause the hold, so to restore a held venue the owner had to mark it paid (recorded as manual payment that did not happen) or void it (forgive it, with no reason), and `liftVenue` on a payment hold answered "That venue is not suspended" (untrue). Expected: "give time until a date" with a reason, honoured by the overdue query, and an accurate message.
- **Matters to.** Venue relations and the books: invoices recorded paid that were not.
- **Evidence.** `src/lib/suspensions.ts` `liftVenue`; `src/lib/billing.ts` (no due-date change).
- **Classification.** Missing workflow.
- **Reproduction.** By reading only. Regression: `tests/venue-suspension-effects.test.ts`.
- **Root cause.** The hold is derived purely from invoice state (a deliberate "cannot drift" design), so the only inputs were mark-paid and void.
- **Recommended resolution.** A logged `grace_until` per invoice (DEC-04).
- **Status.** FIXED. `tests/venue-suspension-effects.test.ts`; ADR 0063 decision 3, migration 0311 (`venue_invoices.billing_grace_until`): `POST /api/admin/billing {action: "giveTime", invoiceId, until, reason}` (owner; up to 90 days ahead); the invoice stays as issued and unpaid, a held venue comes back and its managers are told; `liftVenue` on a payment hold means giving the overdue invoices time and requires a date and reason; logged as `invoice.grace_given`. The venue's managers see the date, not the reason.

### A8 · P2 · FIXED

- **Domain and scenario.** Staff audit scope.
- **Observed and expected.** `inviteStaff`, `removeStaff`, `correctStaff` and `resendInvitation` logged with `venueId: target.venueId`, null for a business manager, and `listActivity(venueIds)` filtered by venue for everyone but the owner, so a business manager removed by a co-manager left the remaining manager nothing to read. Expected: the business's managers see changes to the business's managers.
- **Matters to.** A business cannot investigate a rogue or compromised manager.
- **Evidence.** `src/lib/staff-accounts.ts` `removeStaff`, `src/lib/activity.ts` `listActivity`; `staff_actions` had no business column.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-A-5.test.ts` (scratch). Regression: `tests/business-activity-log.test.ts`.
- **Root cause.** Log keyed by venue only.
- **Recommended resolution.** A nullable `business_id` on `staff_actions`, read by the business's managers.
- **Status.** FIXED. `tests/business-activity-log.test.ts`; ADR 0057 decision 3, migration 0301. Entries written before the migration have no business and stay the platform owner's to read.

### A9 · P2 · FIXED

- **Domain and scenario.** Permission defaults.
- **Observed and expected.** Front-desk permissions are a deny-list (`MANAGER_ONLY`): any new admin route is open to the desk until someone lists it, and no test classified the routes not listed. The sweep found no route contradicting the documented table; `POST /api/admin/inductions` (out-of-hours door access) was to be confirmed. Expected: default deny, or a test that fails for any route in neither list.
- **Matters to.** A future route can leak refunds or configuration to every desk account with no failing test.
- **Evidence.** `src/lib/roles.ts`, `tests/roles.test.ts`, `src/lib/admin-auth.ts` `requireAdmin`.
- **Classification.** Operational risk (design).
- **Reproduction.** By reading (sweep list `deskmatrix.txt`). Regression: `tests/admin-route-classes.test.ts`.
- **Root cause.** A deny-list plus a test that only validated the list.
- **Recommended resolution.** An explicit `DESK_OK` classification test, no behaviour change (DEC-07).
- **Status.** FIXED. `tests/admin-route-classes.test.ts`; ADR 0057 decision 4: every handler is `manager`, `owner`, `desk` or `account` in one table, and a handler not listed, a stale listing or a class disagreeing with `MANAGER_ONLY` fails. The deny-list stays. On evidence two routes moved to manager-only: `PATCH /api/admin/outages` and `POST /api/admin/admins/:id/two-factor-reset`. `POST /api/admin/inductions`, rain-outs, company-account charges and counter refund hand-back stay desk tools.

### A10 · P2 · OPEN decision (DEC-05)

- **Domain and scenario.** Staff two-factor.
- **Observed and expected.** `twoFactorRequired` is false unless `MYSENAM_STAFF_2FA` is set, with no start-up or dashboard warning on a production marketplace; the owner approves venues, marks invoices paid and suspends. Expected: default `owners` when the marketplace is on in production, or a persistent warning.
- **Matters to.** Platform: one phished owner password moves money and listings (A6 now logs it, but does not prevent it).
- **Evidence.** `src/lib/two-factor.ts` `twoFactorRequired`; `docs/development/configuration.md` (`MYSENAM_STAFF_2FA`: "Unset, each account chooses").
- **Classification.** Questionable policy.
- **Reproduction.** By reading only.
- **Root cause.** An opt-in setting.
- **Recommended resolution.** Default `owners` on a production marketplace (DEC-05); managers' requirement is the owner's.
- **Status.** OPEN decision, DEC-05. Not changed. The pilot recommendation in the [roadmap](remediation-roadmap-2026-11-06.md#f-controlled-pilot-recommendation) is to set `MYSENAM_STAFF_2FA=owners` (at least) by configuration, which needs no code.

### A11 · P3 · FIXED

- **Domain and scenario.** Branches under `MYSENAM_AUTO_APPROVE_BRANCHES=on`.
- **Observed and expected.** `businessIsLive` asked only that some other branch had ever been published, so a business whose only live branch was owner-suspended could add a branch with a clean pin and have it live at once. Expected: count only branches that are open, and refuse when any is owner-suspended or held.
- **Matters to.** Platform: a business not in good standing expands unreviewed.
- **Evidence.** `src/lib/applications.ts` `businessIsLive`, `requestGoLive`.
- **Classification.** Verified defect (by reading).
- **Reproduction.** By reading only. Regression: `tests/venue-suspension-effects.test.ts`, `tests/branches.test.ts`.
- **Root cause.** A published-ever test in place of a standing test.
- **Recommended resolution.** As above.
- **Status.** FIXED. ADR 0063 decision 4: auto-approval needs another branch that is live and open and none suspended or held; otherwise the request goes to the owner with the reason. A suspended business is still refused outright. No migration beyond 0311's.

### A12 · P3 · FIXED

- **Domain and scenario.** Venue sign-up.
- **Observed and expected.** `submitApplication` said "That email already has an account. Sign in at /admin." and "There is already an application waiting for that email.", reachable by anyone at 5 an hour per IP, while the customer side answers uniformly (S21, S22). Expected: a neutral answer plus an email to the address.
- **Matters to.** Platform and staff: an enumeration oracle for staff addresses.
- **Evidence.** `src/lib/applications.ts` `submitApplication`.
- **Classification.** Verified defect (by reading).
- **Reproduction.** By reading only. Regression: `tests/venue-signup-privacy.test.ts`.
- **Root cause.** The customer-side uniform answer was not applied to the venue side.
- **Recommended resolution.** As above.
- **Status.** FIXED. `tests/venue-signup-privacy.test.ts`; ADR 0057 decision 5: an address with a staff account or a waiting sign-up gets the same `201 { ok: true, emailSent: true }` and an email saying it already has one, at most once an hour. Where no email can be sent the refusal is as it was.

### A13 · P3 · OPEN

- **Domain and scenario.** Staff removal.
- **Observed and expected.** Removing a manager deletes their sessions and OAuth grants but `venue_api_keys.created_by` is set null and the key keeps working (`apiCaller` checks only `revoked_at`); nothing prompts rotation of keys or webhook secrets the person could read. Expected: on removal, list the keys and endpoints the person could see and offer revocation.
- **Matters to.** Venue and platform: a departed manager's integration credentials remain live.
- **Evidence.** `src/lib/staff-accounts.ts` `removeStaff`; `apiCaller`.
- **Classification.** Operational risk (by reading).
- **Reproduction.** By reading only; no scratch test.
- **Root cause.** Keys are venue-owned, not person-owned.
- **Recommended resolution.** On `removeStaff` list and offer to revoke. Size S.
- **Status.** OPEN. Not changed.

### A14 · P3 · OPEN

- **Domain and scenario.** Second-factor sign-in.
- **Observed and expected.** `redeemLoginTicket` reads `attempts`, checks the code, then increments, so parallel requests on one ticket each pass the cap before any increment lands. Bounded by `rateLimit(req, "login", ticket)` per IP. Expected: increment first (`UPDATE ... SET attempts = attempts + 1 ... RETURNING`).
- **Matters to.** Staff accounts: the code's attempt cap is softer than stated. Unverified: not exercised in parallel.
- **Evidence.** `src/lib/two-factor.ts` `redeemLoginTicket`.
- **Classification.** Unverified assumption.
- **Reproduction.** Not run.
- **Root cause.** Count after the check.
- **Recommended resolution.** Count first. Size S.
- **Status.** OPEN. Not changed.

### A15 · P3 · OPEN

- **Domain and scenario.** Draft purge and real money taken in "test" bookings.
- **Observed and expected.** `staleDrafts` excludes drafts holding passes, memberships, credit, online payments, invoices and e-invoices, but not `receipts`, `counter_payouts` or `counter_refunds_owed` (cascaded with bookings and the venue), so a draft whose test booking took real counter money and was answered "real money taken" can lose its receipt and owed-back record 90 days after the last sign-in. Expected: those are excluded, consistent with "a receipt is never deleted".
- **Matters to.** Platform and venue: low (the venue never went live), but it contradicts a stated rule.
- **Evidence.** `src/lib/drafts.ts` `staleDrafts`.
- **Classification.** Verified defect (by reading); the fix to A1 (foreign-key-derived deletion plan) did not change the exclusion list.
- **Reproduction.** By reading only.
- **Root cause.** The exclusion list names the money tables that existed when it was written.
- **Recommended resolution.** Add those three to the exclusions. Size S.
- **Status.** OPEN. Not changed in this round (`src/lib/drafts.ts` still has no receipt exclusion).

## B: court reservations

Auditor B. Booking, holds, payment on a booking, waiting lists, rescheduling,
cancelling, closures, outages, hours and time.

### B1 = E9 = H3 · P1 (B1), P2 (E9, H3) · FIXED

- **Domain and scenario.** Venue-initiated mass cancellation: closing a day, a rain-out, taking a court out of service, while a waiting list exists or customers keep booking.
- **Observed and expected.** All three cancelled first (each cancellation offered the freed slot to the waiting list) and wrote the closure, block or outage last. A waiter was offered, and could claim, a rained-off hour (a CONFIRMED booking on a storm hour); a closed day's waiting entry was offered by email for a day closed in the same request; an outage failed with "Bookings keep arriving" after every booking had been cancelled, refunded and told, and the court was not out of service; a booking made between the cancel loop and `closeVenueDay` stayed confirmed on the closed day (on Postgres 9 of 10 racing rounds left at least one). Closure and rain-out had no re-check loop (the outage had). Expected: the closure is the decision, taken first or in one transaction; nothing in the time is offered, claimed or booked after it.
- **Matters to.** Customer: told a slot is theirs on a storm or closed day, charged for it, or arrives at a closed venue with a valid confirmation (a safety issue for a safety closure); staff: a misleading "try again" after money moved.
- **Evidence.** `src/app/api/admin/venues/[id]/closures/route.ts:99` (`venueCancel` loop) then `:111 closeVenueDay`; `src/lib/rain-outs.ts:113` loop then `:126 blockSlots(...).ok` counted not enforced; `src/lib/outages.ts:234,249,279`; `src/lib/store.ts:3516 await offerSlotPlace(...)` in `adminCancelBookingOnce`; `offerSlotPlace` never checked `day.closed`.
- **Classification.** Verified defect.
- **Reproduction.** Auditors' `audit9-B-3`, `-B-6`, `-B-9`, `audit9-H-5/6/7`, `audit9-E-6` (scratch; E-6 on Postgres). Regression: `tests/venue-closures-first.test.ts`, `tests/rain-out-closes-first.test.ts`, `tests/closure-races.test.ts` (Postgres races).
- **Root cause.** `adminCancelBookingOnce` always offers the freed slot; three operations ordered "cancel, then close"; an offer is a real claim on court time, so it collides with a later block; closure is not a claim.
- **Recommended resolution.** Write the closure, block or outage first; no offer for a closed or blocked time; sweep again for stragglers; waiting entries for the closed time dropped with a message or kept (DEC-13).
- **Status.** FIXED. The tests above; [ADR 0053](../architecture/decisions/0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md) decision 1, migration 0295 (`court_outages.claimed_from`): a closed day writes `venue_closures` first in a transaction that also reads the day's bookings, then cancels, refunds and tells, offering nothing, and goes round again; live offers for the day go back to waiting and their court hold is released; `offerSlotPlace` and `offerClassPlace` refuse a closed day; a rain-out blocks first; an outage is one transaction (cancel, let go offers, write, claim). Left open by the ADR and by the status file (not fixed): waiting entries on a closed day are left waiting, silently, not dropped and told (DEC-13, owner); offers withdrawn by a closure are not told; `class-moves.ts` does not re-ask the closure check inside its own transaction.

### B2 · P1 · FIXED

- **Domain and scenario.** Court out of service from this afternoon, after a booking earlier today was played.
- **Observed and expected.** `affectedBy` listed every confirmed booking from today including the 09:00 one already finished; `venueCancel` refused it (`CANCEL_PLAYED`) and the loop skipped it; the transaction then saw it still "in the way" and returned null; after three rounds: "Bookings keep arriving". The 19:00 booking was already cancelled, refunded and told; the court never went out. Expected: finished bookings are history; the outage is created and upcoming bookings cancelled.
- **Matters to.** Customers and staff in the exact emergency the feature exists for; partial failure after money moved.
- **Evidence.** `src/lib/outages.ts:94-112 affectedBy` (`from = today`, no end-time filter), `:234-236`, `:249`, `:279`; rain-out filters finished bookings (`rain-outs.ts:98`), the outage did not.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-B-11.test.ts` (scratch). Regression: `tests/venue-closures-first.test.ts` ("from this afternoon is not refused because a booking this morning was played").
- **Root cause.** No played filter in `affectedBy`; cancel-then-close order.
- **Recommended resolution.** Filter to bookings and classes not yet ended; name a booking that cannot be cancelled before cancelling anything.
- **Status.** FIXED. ADR 0053 decisions 1 and 2, migration 0295: an outage "from now" claims from the moment it was taken out, ended bookings are never listed, and a booking that cannot be cancelled (kit out) refuses the outage naming it, with nothing changed. Hours already played inside an outage that began before the change are unchanged.

### B3 · P1 · FIXED

- **Domain and scenario.** Paying from credit or a pass while the booking is cancelled (by staff, the hold sweep, a closure or the customer elsewhere).
- **Observed and expected.** `payBookingFromWallet` and `payBookingWithPasses` read `status` outside their transaction and `claimPayment` was `UPDATE ... WHERE payment_status = 'unpaid'` with no status guard, so a cancellation committing in between left credit or entries debited on a cancelled booking that the cancel's refund had already run past. On Postgres 1, 5 and 4 of 30 attempts left credit taken. Expected: payment only on a confirmed booking, decided in the paying transaction.
- **Matters to.** Customer: credit lost silently ("cancelled, paid"); the hold sweep is one of the cancellers, so "pay from credit at minute 15 of the hold" is the realistic trigger.
- **Evidence.** `src/lib/store.ts:7099` (the UPDATE), `:7116`, `:8589`; counter payment `setPaymentStatus` (`:4861`) read inside its transaction and was sound.
- **Classification.** Verified defect (race).
- **Reproduction.** `audit9-B-8.test.ts` (deterministic and stress; Postgres shows it reliably). Regression: `tests/payment-vs-cancellation.test.ts` (Postgres).
- **Root cause.** Precondition checked outside the transaction; the guarded UPDATE guarded only `payment_status`.
- **Recommended resolution.** `AND status = 'confirmed'` in `claimPayment`; refuse `BOOKING_WAS_CANCELLED`.
- **Status.** FIXED. `tests/payment-vs-cancellation.test.ts`; [ADR 0054](../architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md) decision 1: both paths read the booking under its row lock inside the transaction (`lockPayable`) and refuse a cancelled or already-paid booking before debiting; the price debited is the one read there. No new refund path; no migration.

### B4 · P1 · FIXED

- **Domain and scenario.** A weekly series booked across a change of hours or a closed weekday set from a date.
- **Observed and expected.** `createBookingSeries` resolved the day and policy once, for week 0, so the later weeks were created outside the hours in force on their dates (only closures and launch windows were re-checked, and rates were per week). Expected: each week checked against its own date's hours, closed weekday, court rules and dated hours, and skipped or refused.
- **Matters to.** Customer holds, and may pay for, a slot the venue is not open for; the venue is in the very state the dated-hours feature promises cannot happen.
- **Evidence.** `src/lib/store.ts:2330 courtDay(court, date)` and `:2341-2352` (first date only); loop `:2491-2492`; price per week `:2511`.
- **Classification.** Verified defect (ADR 0027 states the date asked about decides).
- **Reproduction.** `audit9-B-5.test.ts` (scratch). Regression: `tests/series-dated-hours.test.ts`.
- **Root cause.** Policy and day resolved once for week 0.
- **Recommended resolution.** For weeks after the first call `courtDay(court, weekDate)` and `policyBreaches`; a breach is a skipped week with a reason.
- **Status.** FIXED. `tests/series-dated-hours.test.ts`; ADR 0053 decision 4: each later week is checked against its own date's hours and rules; a week that does not fit is skipped with its reason where the customer chose to skip unavailable weeks, and refuses the series otherwise; staff past the rules book it as a recorded override.

### B5 = E8 · P1 (B5), P2 (E8) · FIXED

- **Domain and scenario.** Closing a day, a rain-out, an outage or a manual cancel over classes that already ran.
- **Observed and expected.** The closure route selected every `scheduled` class of the date with no time filter and `cancelClassSession` had no played or past check, so a 09:00 class that was held was cancelled, its enrolments refunded and each attendee told "your class was cancelled" (bookings correctly refuse played hours with `CANCEL_PLAYED`); a request with a past date did all this and then `closeVenueDay` answered CLOSURE_PAST. Expected: ended classes are left alone; a past date is refused first.
- **Matters to.** Venue pays out for a class it delivered; customers get a false cancellation; the register of a held class is closed.
- **Evidence.** `src/app/api/admin/venues/[id]/closures/route.ts:75-96`; `src/lib/store.ts:6864-6905 cancelClassSession`; `src/lib/rain-outs.ts` (classes selected without an end test); `src/lib/notify.ts:1085-1105`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-B-3.test.ts`, `audit9-E-2.test.ts` (scratch). Regression: `tests/venue-closures-first.test.ts`, `tests/rain-out-closes-first.test.ts`.
- **Root cause.** The "finished is left alone" rule lived in the booking path only.
- **Recommended resolution.** Refuse past dates up front; `cancelClassSession` refuses an ended class; filter finished classes out of closure, outage and rain-out selections and previews.
- **Status.** FIXED. ADR 0053 decision 2: a booking or class that has ended is never listed, cancelled, refunded or messaged by a closed day, rain-out, outage or manual cancel (`CANCEL_PLAYED`; a class says so too); one under way may still be called off; a past date is refused before anything is cancelled.

### B6 · P2 · PARTLY

- **Domain and scenario.** Waiting lists on a busy court: 10:00 and 15:00 freed, different waiters.
- **Observed and expected.** `offerSlotPlace` returned at once if any entry for that court and date was `offered`, so an unrelated waiter for 15:00 was not offered while Alice's 10:00 offer was live, and a claimed offer never re-ran the offer, so the slot could go unsold. Class queues offered one place at a time though several might be free. Expected: serialise only overlapping windows (the claim row already guarantees that), offer the others after a claim, and offer up to the free places of a class.
- **Matters to.** Venue utilisation; a waiter who would have booked is never told.
- **Evidence.** `src/lib/store.ts:9638 if (queue.some((row) => row.status === "offered")) return null;`; `claimWaitlistOfferOnce` ends without `offerSlotPlace`.
- **Classification.** Verified defect (utilisation).
- **Reproduction.** `audit9-B-1.test.ts` (scratch). Regression: `tests/waitlist-offer-windows.test.ts`, `tests/waitlist-offer-races.test.ts`.
- **Root cause.** Coarse serialisation and no sweep after a claim.
- **Recommended resolution.** Drop the blanket early return; offer again after a claim and a hold release; offer several class places.
- **Status.** PARTLY. [ADR 0060](../architecture/decisions/0060-waiting-list-offers-windows-starts-and-closing.md) decision 1, migration 0306: court-time offers are fixed (every waiting entry whose own time is free is offered; one person holds one place at a time; a taken-up offer sweeps the day again; the scheduler offers again the places of offers lapsed in the last hour). **Open:** a class still has one live offer at a time (several freed places are offered one after the other); offering several class places at once is left as an option for the owner and is a roadmap row.

### B7 = E5 · P2 · FIXED

- **Domain and scenario.** Offers made after a class has started, or running past a session's start.
- **Observed and expected.** `offerClassPlace` never checked the class had started, so a place freed at 18:10 for an 18:00 class was offered ("30 minutes") and the claim refused `CLASS_STARTED`; the offer was then passed down the queue one person per 30 minutes for a class that was over, and a live offer counted as capacity so a walk-in at the desk was refused `CLASS_FULL`. A slot offer made 10 minutes before the start held the court 20 minutes into the session and the claim then failed. Waiting entries for past sessions stayed `waiting` until retention. Expected: no offer for a started class, lifetime capped at the start, past entries closed, the desk able to fill a lapsing offer's place.
- **Matters to.** Customer: told a place is theirs when it cannot be taken; venue: court or capacity held during the session; the desk turns away a walk-in.
- **Evidence.** `src/lib/store.ts:9197 offerClassPlace` (no start check; `joinClassWaitlist` has one at `:9150`), `:9684`, `expireStaleOffers`; `classOfferHolds`.
- **Classification.** Verified defect (offer path); questionable policy (fixed 30 minutes).
- **Reproduction.** `audit9-B-2.test.ts`, `audit9-E-1.test.ts` (E1) (scratch). Regression: `tests/waitlist-offer-windows.test.ts`.
- **Root cause.** The offer path never copied the start check the join and claim paths have.
- **Recommended resolution.** No offer for a started class; offer lifetime `min(window, time to start)`; scheduler closes entries for sessions that began.
- **Status.** FIXED. ADR 0060 decision 2: an offer is given the venue's window or the time left to the start, whichever is less (kept on the entry), nothing is offered for something that has begun or with fewer than 5 minutes left (the place stays open for the desk), and the scheduler quietly closes entries still waiting for a session that has begun.

### B8 · P2 · FIXED

- **Domain and scenario.** The unpaid-bookings brake.
- **Observed and expected.** `UNPAID_AHEAD` counted by `b.phone_key` only, so one signed-in account with a verified number could hold 8 courts by typing 8 different numbers (all 201); the house rules count "the number and the account". Venues without pay-to-hold had no other protection.
- **Matters to.** Venue: one griefing or careless account can occupy prime evenings with bookings nobody pays.
- **Evidence.** `src/lib/limits.ts:74-80`, `:253` (`!signedIn`); the booking route used the typed phone.
- **Classification.** Verified defect against the documented brake; missing control.
- **Reproduction.** `audit9-B-4.test.ts` (scratch). Regression: `tests/unpaid-brake-account.test.ts`.
- **Root cause.** The brake knew only the typed number.
- **Recommended resolution.** Count unpaid bookings by account as well as number (DEC-12).
- **Status.** FIXED. `tests/unpaid-brake-account.test.ts`; ADR 0054 decision 4: unpaid bookings coming up (3 at a venue, 6 anywhere) are counted by the typed number or the signed-in account (`bookings.user_id`); staff and the venue's API key book by number.

### B9 = E10 · P2 · OPEN decision (DEC-11)

- **Domain and scenario.** Pay-to-hold and class places.
- **Observed and expected.** `POST /api/classes/enrol` calls `policyCheck(... canPayOnline: false)` and never `holdNewBookings`, so an unpaid online enrolment keeps its place until the class starts whatever the venue's `pay_to_hold` says; the same place claimed from a waiting list *is* held; a struck-out number is refused outright for a class. No deadline, reminder or release exists for unpaid enrolments. Expected (questionable policy): the venue's pay-to-hold applies to online class enrolments, or a configurable release before the class.
- **Matters to.** Venue: classes are the scarcest capacity; phantom places block paying customers and the waiting list; the only mitigation is the strike rule.
- **Evidence.** `src/app/api/classes/enrol/route.ts` (no hold; comment "An enrolment online is not held until paid"); `src/app/api/waitlist/claim/route.ts:70`; `docs/features/booking.md#waitlists`.
- **Classification.** Questionable policy (documented as deliberate) with an inconsistency between two paths to one place.
- **Reproduction.** By reading only.
- **Root cause.** Classes were modelled as bookings without the payment hold.
- **Recommended resolution.** Apply pay-to-hold to online enrolments, or release unpaid places N hours before the start with a reminder, or align the waitlist claim (DEC-11).
- **Status.** OPEN decision, DEC-11. Not changed.

### B10 = C16 · P2 (B10), P3 (C16) · FIXED

- **Domain and scenario.** A booking request that dies after the booking commits, at a pay-to-hold venue.
- **Observed and expected.** `POST /api/bookings` commits the booking, then attaches coach, add-ons, account charge, wallet or pass payment, counter payment, waivers, participants, and only then `holdNewBookings` and the confirmation. A stop in between left a confirmed, unpaid, unheld booking and no message, that nothing swept (`releaseExpiredHolds` selects `hold_until IS NOT NULL`). `releaseExpiredHolds` also offered a released class enrolment as court time (see E6). Expected: the hold is part of creation, or a sweeper treats "unpaid, no hold, venue holds, created more than N minutes ago" as stranded.
- **Matters to.** Venue: the thing its setting exists to prevent; customer: retries and may be refused by their own slot.
- **Evidence.** `src/app/api/bookings/route.ts:606,633`; `src/lib/holds.ts:123`.
- **Classification.** Operational risk (by reading).
- **Reproduction.** By reading only. Regression: `tests/booking-price-handshake.test.ts` (`holdStrandedBookings`).
- **Root cause.** The booking is a chain of separate commits with the hold last.
- **Recommended resolution.** A `holdMinutes` option in the creating transaction, and a sweep.
- **Status.** FIXED by a sweep. `tests/booking-price-handshake.test.ts`; ADR 0054 decision 5, migration 0297 (`venues.pay_to_hold_since`): the scheduler's `holdStrandedBookings` puts the hold such a booking would have had, counted from when it was made, with one idempotent guarded UPDATE, only for online, customer-made, unpaid, not-on-account, non-class bookings at venues whose holds are in force and were on when it was made, made 5 minutes to 3 hours ago. **Not done:** setting the hold inside the booking's own transaction, and sweeping a booking whose confirmation message was lost with the request (that is G11, fixed separately by the owed-notice sweep); a swept release lets go an unheld booking the customer was never told about, as a lapsed hold would.

### B11 · P2 · OPEN decision (no DEC written)

- **Domain and scenario.** Rescheduling a last-minute-priced booking.
- **Observed and expected.** The new price is quoted with no `bookedAt`, so the last-minute discount can never apply at the new time while the old price keeps it: a booking made at RM16 (20% off) moved an hour later to a time that also qualifies costs RM20 (`priceChange +4`); if paid, the customer is refused `RESCHEDULE_DEARER` for a move that costs nothing extra on a fresh booking. Expected: the new time priced as the booking would be now if it qualifies; "the price stays with the time it was given for" right only for a move to a time that does not qualify.
- **Matters to.** Customer: pays more for a move than a new booking would cost.
- **Evidence.** `src/lib/store.ts:3856` (`quoteBooking(..., undefined /*bookedAt*/ ...)`); comment at `:3803` states the old-price half only.
- **Classification.** Verified defect (pricing consistency); the status file calls it an owner decision, and no `DEC-nn` was written.
- **Reproduction.** `audit9-B-10.test.ts` (`priceChange: 4`, expects 0; scratch, not kept).
- **Root cause.** The last-minute rule is evaluated at creation only.
- **Recommended resolution.** Price the new time as a fresh booking if it qualifies. Size S.
- **Status.** OPEN decision. Not changed. Flagged: a `DEC-nn` should be written, or the auditor's size-S fix scheduled.

### B12 · P2 · OPEN (gated by DEC-09)

- **Domain and scenario.** Cancellation terms and disputes.
- **Observed and expected.** The cutoff, late-keep share and give-back are read live at cancellation time; the booking stores no terms or version (only `late_kept_percent` afterwards; `bookingTerms().version` is a digest never stored). A manager raising the cutoff from 2 hours to 48 makes every existing booking uncancellable; changing "keep 50%" to 100% changes what existing customers lose. A series cancel detects changed terms (`SERIES_CHANGED`); a single booking does not. Expected: terms snapshotted at booking and honoured.
- **Matters to.** Customer: can lose money from a policy edit made after booking; venue: dispute with no evidence.
- **Evidence.** `cancelCutoffForBooking` (`src/lib/store.ts:2847`); no terms column on `bookings`.
- **Classification.** Missing workflow; questionable policy.
- **Reproduction.** By reading only.
- **Root cause.** Policy read live.
- **Recommended resolution.** Snapshot `cutoff_hours`, `late_keep_percent`, `give_back` and the terms version on the booking (migration); alternative: the more customer-favourable of snapshot and live (DEC-09). Size M.
- **Status.** OPEN. Not changed. The status file lists it as open (the owner's DEC-09 answer decides the shape).

### B13 · P3 · FIXED

- **Domain and scenario.** Waitlist offer window.
- **Observed and expected.** `WAITLIST_OFFER_MINUTES = 30` at any hour for any venue; an offer that lapsed vanished with no message (only offers were notified); several freed places went one by one. Expected: a venue setting, shortening near the start, and a "your place on the list ended" message; an overnight pause was suggested.
- **Matters to.** Customer: a 23:50 offer lapses at 00:20; waiter not told.
- **Evidence.** `src/lib/types.ts:748`.
- **Classification.** Questionable policy.
- **Reproduction.** By reading. Regression: `tests/waitlist-offer-windows.test.ts`.
- **Root cause.** A constant.
- **Recommended resolution.** A venue setting, paused or extended overnight, and an ending message (DEC-10).
- **Status.** FIXED, narrower than the recommendation. `tests/waitlist-offer-windows.test.ts`; ADR 0060 decision 3, migration 0306: `venues.waitlist_offer_minutes` (5 to 120, default 30, copied with a branch), minutes granted kept on the entry and in the offer text, and a lapsed offer told once (`waitlist_ended`, by email only: there is no WhatsApp template for it, so a person with only a phone number is not told). **Not built:** the overnight pause or extension (a roadmap row). The WhatsApp template `mysenam_waitlist_offer` gained a parameter and **must be resubmitted to Meta** before the WhatsApp offer is live-verified.

### B14 · P3 · OPEN

- **Domain and scenario.** Hours and policy edits against concurrent bookings.
- **Observed and expected.** `updateVenue` computes `strandedByHours` then updates the venue in separate statements outside a transaction or lock; a booking created in the gap is outside the new hours (same for `setHoursChange` and court rules). Narrow window, no repro. Expected: lock the venue row in both the edit and booking creation, or re-check in the transaction.
- **Matters to.** Venue: a booking stranded outside new hours.
- **Evidence.** `src/lib/store.ts:4577-4640`.
- **Classification.** Operational risk.
- **Reproduction.** None written.
- **Root cause.** Check-then-write.
- **Recommended resolution.** `FOR UPDATE` on the venue row in both. Size S.
- **Status.** OPEN. Not changed.

### B15 · P3 · OPEN

- **Domain and scenario.** The venue API and lapsed holds.
- **Observed and expected.** `releaseExpiredHolds()` runs in `/api/availability`, `/api/search`, `POST /api/bookings` and the scheduler's one-minute tick, but not in `v1/availability` or `v1/bookings`, so for up to a minute after a hold lapses the venue's own system sees the slot taken while the public grid shows it free.
- **Matters to.** Venue integrations: a minute of inconsistent availability.
- **Evidence.** `src/app/api/v1/availability/route.ts`, `src/app/api/v1/bookings/route.ts` (no call).
- **Classification.** Verified inconsistency (minor).
- **Reproduction.** By reading only.
- **Root cause.** The call was added to the public routes only.
- **Recommended resolution.** Call it in the two routes. Size S.
- **Status.** OPEN. Not changed (the two routes still do not call it).

### B16 = C12 = D15 · P3, P2, P3 · B16 PARTLY, C12 and D15 OPEN decision (DEC-16)

- **Domain and scenario.** A paid booking moved to a cheaper time; an unpaid booking with a deposit repriced below the deposit.
- **Observed and expected.** `priceChange = paid ? 0 : ...`: a paid peak booking moved to an off-peak slot keeps the price paid (customers cannot move to a dearer one, so the rule is one-sided); `RESCHEDULE_DEARER` stops only dearer moves; the preview reports `priceChange` as 0 and the "not given back" sentence exists only for lessons. A peak RM60 booking moved to a RM25 slot loses RM35 with no warning and no refund route, while an online page whose price came down while open is owed the difference. Separately, a deposit-paid unpaid booking repriced downward could end with the deposit above the new total (C1 = H1 below). Expected: the difference given back as stored credit when a customer moves to a cheaper band, or at least said before confirming.
- **Matters to.** Customer: silent loss of the difference; venue: documented, deliberate, but typical Malaysian venues would expect either no cross-band move or the difference as credit.
- **Evidence.** `src/lib/store.ts:3866`; `src/components/ChangeTime.tsx:122-123`; `clsb.move.keepsPriceLess` (lessons only); `unchargedDifference` computed and dropped.
- **Classification.** Questionable policy (documented: "a paid week keeps what was paid").
- **Reproduction.** By reading only.
- **Root cause.** A paid booking's price is never re-derived on a move.
- **Recommended resolution.** Credit the difference to stored credit on a customer's cheaper move before the cutoff, with the message in every case (DEC-16).
- **Status.** B16: PARTLY (the deposit-above-price part is fixed with C1; ADR 0054). C12 and D15: OPEN decision, DEC-16. ADR 0054 says a booking paid in full is left alone: what it keeps when moved cheaper is a separate, deliberate rule that awaits the owner.

## C: money

Auditor C. Online payment, refunds, credit, pricing at the point of payment,
tax, documents, company accounts, hire deposits, cash-up and e-invoice
consolidation. C12 is in the block of B16 (with D15), and C16 is in the block of
B10, both in section B above; C17 and G11 share a fix and are two blocks.

### C1 = H1 (and B16, deposit part) · P1 · FIXED

- **Domain and scenario.** A deposit paid online (or friends' shares), then the price falls: a move to a cheaper court or time (customer or staff), or a promo or concession.
- **Observed and expected.** With a RM35 booking and RM10.50 deposit, a move to a RM5 slot left `total_price` 5.00, `deposit_paid` 10.50 and `refund_due` 0: a balance of minus 5.50, no refund owed, no credit note, nothing in *Refunds owed*, and marking it paid at the counter still succeeded (`{"total":5,"dep":10.5,"shares":10.5,"owed":{"due":0}}`). A 60% promo did the same. Three writers of `total_price` (reschedule, promo, concession) forgot the rule that a manager's price adjustment enforces (`P8B_ADJUST_BELOW_PAID`). Expected: never below what deposits and shares paid: refuse, or owe the excess back on the deposit's payment.
- **Matters to.** Customer: loses money silently (a Billplz venue refunds by hand, but nothing tells anyone to); venue: books and tax overstated; the same money is later refunded in full if the customer cancels, so the amount depends on a path nobody sees.
- **Evidence.** `src/lib/store.ts:3866 priceChange = paid ? 0 : Math.max(-booking.totalPrice, chargeDelta)` and `:4014`; the customer guard is `friendsPaid` which subtracts the deposit; `src/lib/discounts.ts:195`; `applyPromo` refuses only `payment_status = 'paid'`; contrast `src/lib/price-adjustments.ts:136`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-C-7.test.ts`, `audit9-H-1.test.ts` (PGlite and Postgres; scratch). Regression: `tests/paid-within-price.test.ts`.
- **Root cause.** Three writers of `bookings.total_price`; no shared guard.
- **Recommended resolution.** One helper used by every writer: refuse for a customer, or reduce the deposit and owe the excess back on the deposit's payment in the same transaction; refuse where friends' shares are above the new price (DEC-17).
- **Status.** FIXED. `tests/paid-within-price.test.ts`; [ADR 0054](../architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md) decision 2: `keepPaidWithinPrice` runs under the booking's lock after a cheaper reschedule, promo, concession or place's concession; a deposit paid online above the new price comes off the booking and is owed back on the deposit's payment (`refund_due`) with a credit note on its receipt; friends' shares (or an unidentifiable deposit) refuse the change (`PAID_ABOVE_PRICE`) and undo it; the reschedule answer carries `owedBack`. A booking paid in full is untouched (see B16). On Billplz the owed refund is by hand and the customer is told only by the venue. No migration.

### C2 · P1 · OPEN decision (DEC-19, tax adviser)

- **Domain and scenario.** MyInvois consolidation of stored-credit and voucher sales.
- **Observed and expected.** RM100 of credit topped up at the counter and a RM30 booking paid from it gave a consolidated e-invoice total of 130 (RM130 reported for RM30 of sales): `consolidate` ignores the journal's own `revenue: false` flag on the credit row ("owed to customers until spent") and also takes the booking. For passes the design says the pass is the sale and a pass-paid booking is not a row. Expected: one of them, consistently.
- **Matters to.** Venue and tax: sales over-reported to LHDN by every prepaid ringgit; no matching correction when credit is refunded or vouchers expire; e-invoice disagrees with the journal's revenue summary.
- **Evidence.** `src/lib/myinvois.ts:721` and `:1074` (`journal.filter((r) => r.type === "Receipt" && ... && r.gross > 0)`, no `r.revenue` test); `src/lib/accounting.ts:43 OWED`; `docs/integrations/myinvois.md:41-42`.
- **Classification.** Verified defect against the journal's own definition. The tax treatment of prepayment under MyInvois is **unverified** and is not settled here.
- **Reproduction.** `audit9-C-8.test.ts` (`expected 130 to be 30`; scratch).
- **Root cause.** `consolidate` is built from all journal receipts, not the revenue ones.
- **Recommended resolution.** Default: exclude non-revenue rows (and their credit notes) from consolidated e-invoices, subject to the adviser; alternative: e-invoice on receipt and exclude credit-paid bookings.
- **Status.** OPEN decision, DEC-19. ADR 0055 left it as it was ("a tax adviser's question"). The only P1 not closed.

### C3 · P2 · FIXED

- **Domain and scenario.** A promo code or concession refused at booking time, with `payFromWallet` or `payWithPass`.
- **Observed and expected.** If the code's last use went between the customer's quote and the booking, the response was 201 with `promoError`, the booking stood at RM30 and RM30 was taken from credit (balance 100 to 70) though the customer accepted RM20. No `expectedTotal` existed on any route. Expected: nothing charged at a price the customer did not accept.
- **Matters to.** Customer: charged more than they saw; the UI blocks its own refused code, so this needs a race or an API client.
- **Evidence.** `src/lib/booking-discounts.ts` ("Best-effort ... a discount refused leaves the booking standing at the price before it"); `src/app/api/bookings/route.ts:484,543`.
- **Classification.** Verified defect (race, API).
- **Reproduction.** `audit9-C-3.test.ts` (PGlite and Postgres; scratch). Regression: `tests/booking-price-handshake.test.ts`.
- **Root cause.** Discounts and payment are independent best-effort steps; no price handshake.
- **Recommended resolution.** Skip settling when a requested discount failed; add `expectedTotal` (DEC-26).
- **Status.** FIXED. `tests/booking-price-handshake.test.ts`; ADR 0054 decision 3: a booking request may carry `expectedTotal` (whole cents), on the form's route and the venue API's; a different price refuses with `PRICE_CHANGED` before anything is settled; an asked-for promo or concession that is refused, on a request that settles at once, refuses with `DISCOUNT_NOT_APPLIED` (both 409, new to API clients). This also closes D20.

### C4 · P2 · FIXED

- **Domain and scenario.** The booking confirmation when paying from credit or a pass fails.
- **Observed and expected.** `POST /api/bookings` returns `walletError` and leaves the booking confirmed and unpaid; only `CoachBooking.tsx` rendered it, so `BookingBoard.tsx` showed a normal confirmation and "pay at the counter". Expected: "your credit was not used; RM30 is still to pay".
- **Matters to.** Customer: believes it is paid.
- **Evidence.** `grep -rn walletError src` found only `CoachBooking.tsx` and the route; `BookingBoard.tsx:1641` checkbox.
- **Classification.** Verified defect (UI, by reading).
- **Reproduction.** By reading only. The API half is in `tests/lesson-credit.test.ts`; regression: `tests/booking-price-handshake.test.ts` (`walletErrorCode`).
- **Root cause.** The form never read the field.
- **Recommended resolution.** Say it. Size S.
- **Status.** FIXED, **without a component test**. ADR 0054 decision 3: the answer carries `walletErrorCode` and the booking form's confirmation says in four languages that the credit or pass was not used and what is still to pay. The wording is covered by the dictionaries' tests, not by a rendering test.

### C5 · P2 · PARTLY

- **Domain and scenario.** Company-account invoices and rescheduling.
- **Observed and expected.** An issued invoice was said never to change, but `invoiceLines` read the live price (`OWED`), a reschedule re-priced an invoiced booking (price adjustments were refused on invoiced bookings; reschedule was not), and a later cancellation credited the live price: an invoice for RM20 became lines of RM10 and a RM10 credit.
- **Matters to.** Company accounts and the venue: an issued invoice drifts; credit notes disagree with what was charged.
- **Evidence.** `src/lib/accounts.ts:110` (`OWED = "(b.total_price - b.shares_paid)"` used in `invoiceLines` `:559` and `creditAccountForCancellation`); `src/lib/price-adjustments.ts:129`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-C-2.test.ts` test 3 (scratch). Regression: `tests/account-invoice-snapshot.test.ts`.
- **Root cause.** Lines derived from live prices.
- **Recommended resolution.** Store the invoiced amount per booking; refuse or credit-note price changes after issue.
- **Status.** PARTLY. `tests/account-invoice-snapshot.test.ts`; [ADR 0061](../architecture/decisions/0061-company-accounts-and-the-cash-up.md) decision 2, migration 0307 (`bookings.invoiced_amount`): lines and cancellation credits read the invoiced price; a cheaper reschedule of an invoiced booking is a credit note on the account for the difference; a customer's dearer move is refused. **Open:** a dearer reschedule of an invoiced booking by staff is reported (`unchargedDifference`), not billed: a debit adjustment line on the next invoice would need its own receipt in the journal; an owner decision, a roadmap row.

### C6 · P2 · FIXED

- **Domain and scenario.** Company credit notes and part payment.
- **Observed and expected.** Credit notes were applied whole or not at all and the loop stopped at the first one that did not fit (credits [60, 20], invoice 20: nothing applied, the exact-fit 20 starved); `markInvoicePaid` took no amount, so a company paying part of an invoice could only be recorded as paid in full or unpaid. Expected: partial allocation, skip non-fitting credits, record amounts received.
- **Matters to.** Company accounts: credit stranded; the venue's books: part payments cannot be recorded.
- **Evidence.** `src/lib/accounts.ts:469 if (Number(c.amount) > room + 1e-9) break;`.
- **Classification.** Verified defect plus missing workflow.
- **Reproduction.** `audit9-C-2.test.ts` tests 1, 2 (scratch). Regression: `tests/account-credit-parts.test.ts`.
- **Root cause.** Whole-credit allocation.
- **Recommended resolution.** Allocate partially; add an amount to mark-paid (DEC-21).
- **Status.** FIXED. `tests/account-credit-parts.test.ts`; ADR 0061 decision 1, migration 0307: `account_credit_allocations` records each part (credit, invoice, amount, who issued, when), oldest credit first as far as the invoice goes, a credit bigger than the room is taken as far as it goes; "paid back by hand" settles what still waits; an invoice can be part-paid (`account_invoice_payments`) and its bookings are marked paid in the order played as the money covers them. Left open: the part of a payment not yet covering a whole booking is on the invoice but not in the journal until it does, and the customer's invoice page does not show part payments.

### C7 · P2 · FIXED

- **Domain and scenario.** A company account with overdue invoices.
- **Observed and expected.** With no credit limit (the default) `chargeToAccount` checked only the limit, so an account 90 days overdue could keep booking; no scheduler reminder or *Needs attention* entry existed. Expected: a configurable block, a reminder to the account, a row in *Needs attention*.
- **Matters to.** Venue: unbounded exposure to an account that does not pay.
- **Evidence.** `src/lib/accounts.ts:359`; `src/lib/scheduler.ts:143`; `src/app/api/admin/attention/route.ts` (no account reference).
- **Classification.** Verified defect.
- **Reproduction.** `audit9-C-2.test.ts` test 4 (scratch). Regression: `tests/account-overdue.test.ts`.
- **Root cause.** No overdue concept for accounts.
- **Recommended resolution.** Warn on by default, block as a per-account setting (DEC-20).
- **Status.** FIXED, per venue rather than per account. `tests/account-overdue.test.ts`; ADR 0061 decision 3, migration 0307: one definition of an overdue invoice feeds *Needs attention* (`accountsOverdue`), a weekly reminder to the account (first day overdue, then weekly, six at most) and a block, `venues.company_overdue_block_days` (null = never, the default; the settings help recommends 30): `chargeToAccount` refuses with `ACCOUNT_OVERDUE`, staff may charge anyway with a reason (recorded), a customer booking online cannot. The block is a manager's, per venue, default off.

### C8 = G4 · P2 · FIXED

- **Domain and scenario.** The revenue report with a deposit or friends' shares paid.
- **Observed and expected.** A RM35 booking with a RM10.50 deposit showed expected 35, collected 0, outstanding 35 (the customer owes 24.50); `collected` was understated and `outstanding` overstated, for deposits and for shares, while the sales journal and cash-up count the deposit receipts. Expected: outstanding = price minus deposit minus shares; collected counts them.
- **Matters to.** Venue: the number it chases is overstated by money already in its bank.
- **Evidence.** `src/lib/reports.ts:725 outstanding: expected - paidConfirmed` (`paidConfirmed` = `SUM(total_price)` of fully paid only), `:459-462, 498`; `docs/features/reporting.md:35-37`.
- **Classification.** Verified defect for `outstanding`; "deposits not in collected" was documented.
- **Reproduction.** `audit9-C-1.test.ts`, `audit9-G-4.test.ts` (scratch). Regression: `tests/report-reconciliation.test.ts`.
- **Root cause.** The report sums the booking row; the journal sums receipts.
- **Recommended resolution.** Add deposits and shares to collected and out of outstanding (DEC-25).
- **Status.** FIXED. `tests/report-reconciliation.test.ts`; [ADR 0055](../architecture/decisions/0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md) decision 1: `bookingMoney` reads the journal's own parts for every booking played in the period (the booking receipt when paid and not by pass, the deposit and shares on their own receipts, less credit notes) and everything the report says about booking money is summed from that one list; *Still owed* is the price less the deposit and shares paid. No migration. A receipt for a share paid at the counter does not exist, so it is in neither the report nor the journal.

### C9 · P2 · FIXED

- **Domain and scenario.** What the venue owes, in ringgit.
- **Observed and expected.** `venueReport.liabilities` held pass entries (hours), live passes and a membership count; unredeemed gift vouchers, online refunds owed, counter payments owed back, account credit notes waiting, hire deposits held and pass value unspent were in no report or total.
- **Matters to.** Venue and platform: liabilities not visible to the manager or the owner.
- **Evidence.** `src/lib/reports.ts:133-141, 741-746`.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only. Regression: `tests/report-venue-owes.test.ts`.
- **Root cause.** The liabilities block was written for hours and counts.
- **Recommended resolution.** One "what the venue owes" block in RM.
- **Status.** FIXED, provisional. `tests/report-venue-owes.test.ts`; ADR 0055 decision 4: `liabilities.owed` adds stored credit, unredeemed unexpired vouchers (lapsed ones shown apart and not in the total), deposits and shares held on bookings still to be played, hire deposits held, and refunds owed (online and counter); prepaid passes are an *estimate* outside the total; memberships stay a count. Every label says provisional: it is not a statement of how any of it is treated in the venue's books. Voucher expiry (C15) and the pass value estimate stay open.

### C10 = E13 = H10 · P2 (C10, E13), P3 (H10) · FIXED

- **Domain and scenario.** Hire deposits and the cash-up.
- **Observed and expected.** The cash-up is the sales journal, which holds only what a hire venue *keeps* of a deposit. A deposit is a number in `hire_records` with no method (`takeHire` takes no `via`), no cash-up line, no "held for customers" figure and no hand-back record; with 20 kayaks out the drawer holds RM1,000 the sheet never mentions. `returnHire` defaulted the method of an amount kept to cash (`via = input.via ?? "cash"`), against the documentation, so a card-held deposit kept in part was reported as cash. The sheet stored no counted cash or variance. Expected: deposits held and returned appear on the cash-up by method; the method recorded when kit goes out; counted cash and variance stored.
- **Matters to.** Venue and staff: shift reconciliation never matches for a hire venue; disputes without evidence; cash and card takings misstated.
- **Evidence.** `src/lib/store.ts` `takeHire`, `returnHire:5727`; `src/lib/cash-up.ts` header; `docs/features/venue-operations.md` ("deliberately not a wallet movement").
- **Classification.** Missing workflow; verified defect (the default).
- **Reproduction.** By reading only. Regression: `tests/hire-cash-up.test.ts`.
- **Root cause.** A deposit modelled as a record, not as money in the drawer.
- **Recommended resolution.** Record `via` at take; a deposits block in the cash-up (memo, not takings); store counted cash and variance; refuse a kept amount with no stated method (DEC-22).
- **Status.** FIXED. `tests/hire-cash-up.test.ts`; ADR 0061 decision 4, migration 0308: `hire_records.deposit_via` required at take (with who took and who gave back); one definition of a deposit held (`src/lib/hire-deposits.ts`) feeds the reports' `venueOwes.hireDeposits` and the cash-up; the cash-up has a *deposits* block (taken, given back, kept by method, held), an expected amount per till, and `cash_up_counts` (what was counted, the expected and the variance; a recount is another row, nothing edited); nothing defaults to cash. Left open: deposits taken before migration 0308 show "not recorded" and need the method said to keep an amount; whether held deposits are a liability in the books is the venue's adviser's question.

### C11 = F4 = H4 · P2 · FIXED

- **Domain and scenario.** Tournament and league fees paid at the counter when the venue calls the event off (or a rule refunds before the draw).
- **Observed and expected.** `cancelTournament` and `takeOutOnce` (rule `refundBeforeDraw`) set `online_payments.refund_due` only. A counter-paid entry (receipted `entry:<id>@...`) produced no credit note, no owed-back row (`counter_refunds_owed` was bookings-only, `booking_id NOT NULL UNIQUE`) and no list entry, and the called-off email said "Any entry fee you paid online will be refunded". The owner's decision of 29 October says a counter payment on what the venue cancels is owed back until a named person confirms; it was implemented for bookings and classes only. Expected: the same owed-back list for fees.
- **Matters to.** Customer: paid cash for an event that did not happen, with no claim record; venue: books keep revenue for a service not delivered.
- **Evidence.** `src/lib/tournaments.ts:1176-1200, 1687-1690`; `src/lib/counter-refunds.ts`; `mail.tour.calledOff.b` in `src/lib/i18n.ts`.
- **Classification.** Missing workflow; the call-off case contradicts a recorded owner decision; the withdrawal case was deliberate as worded for online money.
- **Reproduction.** `audit9-C-6.test.ts`, `audit9-F-4.test.ts`, `audit9-H-3.test.ts` (scratch). Regression: `tests/competition-fixes.test.ts`.
- **Root cause.** Counter refunds were built around bookings; fees were left on the online-only path.
- **Recommended resolution.** Generalise the owed row to fees, or write the credit note at cancellation and list it (DEC-18).
- **Status.** FIXED. `tests/competition-fixes.test.ts`; [ADR 0059](../architecture/decisions/0059-competition-notices-fees-owed-fixtures-lost-and-message-review.md) decision 2, migration 0304: a tournament called off, and an entrant taken out before the draw where the rules refund before the draw, write a row in `counter_fee_refunds_owed` (a sibling of the bookings' table, not a generalisation, so no money path the cash-up reads was touched); staff settle it once (handed back the way it was paid, who and when, a credit note on the entry's receipt then, an activity entry; the desk only for a fee taken today). Open: a fee refunded at the counter is not in the till's payout list; a box league's place fee on a staff removal or a league closed mid-season is not covered (F12, owner decision); the counter-sold pass or membership void still gives a credit note and a log line only.

### C13 · P3 · OPEN

- **Domain and scenario.** Half-sen rounding.
- **Observed and expected.** `roundMoney(x) = Math.round(x * 100) / 100` mis-rounds about 4.6% of half-sen inputs while SQL `ROUND` is exact, so on a RM10.10 booking with 25% kept on a late cancel paid online the credit note was RM7.57 (JS) and the amount owed back RM7.58 (SQL). Shares in `splits.ts:102` lose a sen in about 2% of cases (harmless direction). Expected: compute the refundable amount once, in integer sen, and pass it to credit note, wallet, pass and `refund_due`.
- **Matters to.** Venue and accountant: a 1 sen disagreement between a credit note and the refund.
- **Evidence.** `src/lib/documents.ts:658` against `src/lib/store.ts:7377`.
- **Classification.** Verified defect (tiny).
- **Reproduction.** `audit9-C-5.test.ts` (`expected 7.57 to be 7.58`; scratch).
- **Root cause.** Two rounding engines.
- **Recommended resolution.** One computation in integer sen; a bias or sen arithmetic in `roundMoney`. Size S to M.
- **Status.** OPEN. Left on purpose by ADR 0055: `roundMoney` is used by every money path and changing it is a decision for its own change.

### C14 = D14 = H6 · P3 (C14, D14), P2 (H6) · OPEN decision (DEC-30)

- **Domain and scenario.** Late cancellation of a pass-paid booking.
- **Observed and expected.** `back = Math.floor(-charge.delta * share)` returns whole entries rounded down, so a 1-entry booking with any kept percentage returns 0 and a 2-entry booking at 25% kept returns 1 (50% lost): the venue keeps 100% where it keeps 25 to 50% from other payers. H adds that with a venue keeping 10% a one-entry booking cancelled late left the pass at 9 entries and the screen said `kept: 2.5`, a sum, while the whole entry (value 12) was forfeited.
- **Matters to.** Customer: loses more than the rule says, and is told otherwise; documented only as "rounded down".
- **Evidence.** `src/lib/store.ts:8716`.
- **Classification.** Questionable policy; misleading confirmation.
- **Reproduction.** `audit9-H-8.test.ts` (`expected 9 to be greater than 9`; scratch).
- **Root cause.** Entries are whole; the share is a percentage.
- **Recommended resolution.** Round the venue's share to the nearest entry or return the remainder as stored credit; say what was kept (DEC-30).
- **Status.** OPEN decision, DEC-30. Not changed; ADR 0062 lists it among findings left to the owner.

### C15 · P3 · OPEN decision (DEC-23, lawyer)

- **Domain and scenario.** Gift voucher expiry.
- **Observed and expected.** Gift vouchers expire after 12 months while redeemed credit never does, and expiry is recognised nowhere (no breakage entry; expired money is a liability the report could not see). Consumer-law treatment of expiry of prepaid vouchers is for the owner's lawyer.
- **Matters to.** Customer: a voucher lapses unreminded; venue and accountant: an unrecorded liability.
- **Evidence.** `src/lib/vouchers.ts:306` (expiry check only); no breakage entry in `src/lib/accounting.ts`.
- **Classification.** Questionable policy needing legal advice.
- **Reproduction.** By reading only.
- **Root cause.** A time limit with no accounting or notice behind it.
- **Recommended resolution.** None until a lawyer advises; meanwhile a desk redemption action and a pre-expiry reminder carry no legal risk (DEC-23).
- **Status.** OPEN decision, DEC-23. Not changed: ADR 0055 shows lapsed vouchers apart and out of the liabilities total, "until the venue's adviser says how they are treated".

### C17 (G11 in part) · P3 · FIXED

- **Domain and scenario.** A customer's cancellation message lost on a crash after the refund is written.
- **Observed and expected.** `src/app/api/bookings/cancel/route.ts:28-30` runs `refundCancelled` then `notifyBookingCancelled` after the cancellation committed, with no outbox row in the transaction: the refund is crash-safe (the reconciler), the customer's "refund due by <date>" message is not. Expected: the message written with the fact, or a sweep (see G11).
- **Matters to.** Customer: sees the state on `/my-booking` but is never told.
- **Evidence.** `api/bookings/cancel/route.ts:28-30`.
- **Classification.** Operational risk (by reading).
- **Reproduction.** By reading only. Regression: `tests/notices-owed.test.ts`.
- **Root cause.** The notification is a separate step after the commit.
- **Recommended resolution.** A recovery sweep.
- **Status.** FIXED with G11. `tests/notices-owed.test.ts`; [ADR 0056](../architecture/decisions/0056-outbox-reliability-messages-survive-outages-and-stops.md) decision 6, migration 0299: a message owed to a customer is recorded as owed in the same transaction as the fact (`notices_owed`) and a sweep writes it if the request never did; the customer's own cancel path owes the row. Limit recorded: a message recovered by the sweep says the fee kept as a share of the price, not to the sen.

### C18 = H7 · P3 (C18), P2 (H7) · OPEN decision (DEC-14)

- **Domain and scenario.** A payment that lands after a pay-to-hold booking was released.
- **Observed and expected.** Approval bookings turn a late payment back into the booking where the slot is still free; an ordinary held booking does not: the money goes to *Refunds owed* and, on Billplz, is refunded by hand (the customer told only on the return page, staff in the next-day digest). Billplz pages cannot be closed, so the case is routine. Expected: revive if the slot is free and the customer is the same, else owe back.
- **Matters to.** Customer: paid, sees a cancelled booking and waits for a manual refund; venue: a booking it could have kept. The money itself is never lost.
- **Evidence.** `settleBill` main branch (`b.status === "confirmed"` else `owed += billed`); `docs/features/payments-and-credit.md` ("A booking made on approval"); `approvalPaymentSettled`.
- **Classification.** Questionable policy (documented as deliberate).
- **Reproduction.** By reading only.
- **Root cause.** Two payment-settlement behaviours for the same situation.
- **Recommended resolution.** Reuse the approval path for ordinary holds, within the day (DEC-14).
- **Status.** OPEN decision, DEC-14. Not changed. Matters most while every Billplz refund is manual.

### C19 · P3 · OPEN (unverified assumption)

- **Domain and scenario.** The amount a gateway reports.
- **Observed and expected.** `PaymentResult` carries no amount and `paid` is the gateway's state, so if a collection allows a short or over payment the booking is marked paid at the billed amount.
- **Matters to.** Venue: a short payment treated as paid. Unverified: whether Billplz's `paid_amount` can differ from `amount` on a fixed bill needs the sandbox.
- **Evidence.** `src/lib/gateways/types.ts:90`, `settleBill`.
- **Classification.** Unverified assumption.
- **Reproduction.** Not possible without the Billplz sandbox.
- **Root cause.** The gateway interface has no amount.
- **Recommended resolution.** Check with the Billplz sandbox; if it can differ, add the amount to `PaymentResult` and treat a short payment as owed back.
- **Status.** OPEN. Waits on the Billplz check (`INTEGRATION_VERIFICATION_REQUIRED`, [Billplz callback verification](../product/feature-status.md#integrations)).

## D: memberships, passes, prices and standing

Auditor D. Memberships, passes, entitlements, pricing rules, discounts, loyalty,
customer standing and reviews. D14 is in the block of C14, and D15 in the block
of B16.

### D1 = H5 · P2 · FIXED

- **Domain and scenario.** Passes. A pass-paid booking is cancelled (by the customer in good time, or by the venue after a rain-out, outage or closure) after the pass expired or was voided.
- **Observed and expected.** `refundBookingToPass` wrote the entries back to the ledger ("an expired pass is still credited") but `passBlocked` refused any spend on an expired or void pass and no tool could extend, reopen or credit one; a pass voided with the unused part handed back while a pass-paid booking stood, then that booking cancelled, got entries back on a dead pass: RM80 of RM100 refunded in all, RM20 of value gone (H5: pass of 2 entries for 100, void with refund 50, then the booking cancelled free: credit notes total 50). Expected: entries usable for a grace period, or credited in money, or void refused or warned while pass-paid bookings stand.
- **Matters to.** Customer loses prepaid value through no act of theirs, worst when the venue cancelled; venue: a dispute and no tool but "void with refund".
- **Evidence.** `src/lib/store.ts:8225 passBlocked`, `:8689 refundBookingToPass`, `:8502 voidPass` (computes the refund from `pass.remaining`, never looks at bookings the pass paid); `docs/features/pricing.md` ("an expired pass is still credited").
- **Classification.** Verified defect (restoration) plus missing workflow (no extension); the ledger-honesty sentence is deliberate, the stranded value was not stated as accepted.
- **Reproduction.** `audit9-D-1.test.ts`, `audit9-H-1.test.ts` (`expected 80 to be 100`, `expected 50 to be 100`; scratch). Regression: `tests/pass-restore-and-validity.test.ts`.
- **Root cause.** Restoration appends to a ledger of a pass whose usability is judged only by today's date and status.
- **Recommended resolution.** Extend `expires_on` on restoration (default 14 days, venue setting) or credit the money share if void; list or refuse voiding while pass-paid bookings stand (DEC-29).
- **Status.** FIXED. `tests/pass-restore-and-validity.test.ts`; [ADR 0062](../architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md) decision 1, migration 0309: every give-back goes through one `giveBackToPass`; an ended pass is extended to today plus `venues.pass_restore_grace_days` (default 30, 0 to 365, 0 turns it off; a manager's setting, logged); a pass cancelled with the unused part handed back is never revived and its entry's value goes back as a credit note on the sale, owed back on its payment if bought online, with an activity-log line; a manager can extend a pass (`POST /api/admin/passes/:id/extend`, reason required). The refusal on voiding was not built (the value goes back after the fact instead). Open: a pass cancelled **without** a refund keeps the sale as sold and the restored entries stay on it, so a rain-out of a booking paid by such a pass leaves the customer without both; the counter-sold pass's hand-back is a credit note and log line, not a task on a cash list.

### D2 · P2 · FIXED

- **Domain and scenario.** Concessions at the counter (`checkConcession`, outcome `refused`).
- **Observed and expected.** Two simultaneous "no proof shown" requests added the concession amount to `total_price` twice (RM20 booking, 50% concession: RM30 instead of RM20), and on a paid booking wrote two counter sales; a booking already `seen` could later be flipped to `refused` and charged. Expected: decided once under the booking's lock.
- **Matters to.** Customer: overcharged at the desk; cash-up and journal show an extra sale staff must void.
- **Evidence.** `src/lib/concessions.ts:351` (read outside any transaction), `:371` (no `AND concession_check <> 'refused'`), `:378`; same pattern in `checkPlaceConcession` (`:451`).
- **Classification.** Verified defect (race plus missing state guard).
- **Reproduction.** `audit9-D-2.test.ts` (both engines; scratch). Regression: `tests/concession-check-once.test.ts`.
- **Root cause.** Check-then-act with the check outside the transaction.
- **Recommended resolution.** Read under `FOR UPDATE`, update only from `due`; decide that `seen` is final.
- **Status.** FIXED. `tests/concession-check-once.test.ts`; ADR 0062 decision 3: `checkConcession` (and the one-place form) read the state under `FOR UPDATE` and update only from `due`; a repeat is refused and charges nothing more. A proof marked *Seen* is now final (a manager reverses it by hand): a rule the code did not have, chosen on the audit's recommendation.

### D3 · P2 · OPEN decision (DEC-33)

- **Domain and scenario.** A customer moves an unpaid booking that carries a discount.
- **Observed and expected.** RM60 peak with a 50% concession (RM30 off, total RM30) moved to the RM20 off-peak hour: total RM0 (`Math.max(-booking.totalPrice, delta)`) with the RM30 discount kept; a 20% code does the same. The other way, the customer pays more than the percentage promised. Expected: the percentage follows the move on an unpaid booking, or the kept discount is capped at the new court time.
- **Matters to.** Venue: a revenue leak by self-service; inconsistent effective discount both ways.
- **Evidence.** `src/lib/store.ts:3784, :3866`; `docs/features/pricing.md` "A move keeps what was charged" (decided 27 October 2026).
- **Classification.** Questionable policy (the keep-amount rule is decided; the RM0 outcome is a consequence the decision does not mention).
- **Reproduction.** `audit9-D-5.test.ts` (`expected 0 to be greater than or equal to 10`; scratch).
- **Root cause.** Percentage discounts stored and kept as amounts.
- **Recommended resolution.** Recompute a percentage discount on an unpaid move (DEC-33).
- **Status.** OPEN decision, DEC-33. Not changed; ADR 0062 lists it among the findings left to the owner.

### D4 · P2 · FIXED

- **Domain and scenario.** Passes judged on the wrong date.
- **Observed and expected.** `passBlocked` compared expiry to today, not the session's date (memberships use the session's date): a pass expiring in 2 days paid a booking 10 days later, a weekly series was paid for every week at once, and a booking could be moved past expiry. Expected: "valid to play until" (judge the date played), or a documented "valid to book until".
- **Matters to.** Venue: validity stretched by the booking window; customers book the day before expiry; multiplies D1.
- **Evidence.** `src/lib/store.ts:8228`, `payBookingWithPasses`.
- **Classification.** Questionable policy (not stated anywhere).
- **Reproduction.** `audit9-D-1.test.ts` D2 (scratch). Regression: `tests/pass-restore-and-validity.test.ts`.
- **Root cause.** One `todayISO()` check.
- **Recommended resolution.** Judge on the booking date (DEC-28).
- **Status.** FIXED. ADR 0062 decision 2: `passBlocked` takes the session's date, so `expires_on` is the last day it can be *played*; today's check stays; a weekly series is paid week by week (weeks after expiry left unpaid with the reason); a pass-paid booking is not moved past the pass's end (`FX8_MOVE_PAST_PASS`, a manager can extend first); the counter lists only passes good on the booking's day.

### D5 · P2 · FIXED

- **Domain and scenario.** Review invitations.
- **Observed and expected.** `askForReviews` invited after any confirmed, not-no-show booking with an email, but `reviewable` refused an unpaid, never-checked-in one (`REVIEW_NOT_PLAYED`) and the invitation was deduped once per venue and number, so a customer whose first booking was left unpaid in the system got a dead link and was never invited again. Many desks never mark cash bookings paid. Expected: the two ask the same question.
- **Matters to.** Customer: a dead link; venue: lost reviews (a marketplace ranking input).
- **Evidence.** `src/lib/reviews.ts:139` against `:315-320`, `:330`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-D-3.test.ts` (scratch). Regression: `tests/reviews.test.ts` (changed).
- **Root cause.** Two predicates.
- **Recommended resolution.** One shared predicate; ask for the first reviewable booking.
- **Status.** FIXED. `tests/reviews.test.ts`; ADR 0062 decision 4: `askForReviews` asks `reviewable` (paid, or free, or attendance verified as ADR 0058 defines; not a no-show; ended; within 60 days) before sending and before spending the one invitation; a booking the link would refuse gets no email and does not use the invitation up.

### D6 · P2 · OPEN decision (DEC-34)

- **Domain and scenario.** Membership tiers.
- **Observed and expected.** A tier's benefits are read live: the venue edits Gold from 70% to 95% and every existing Gold member's price changes on the next booking, while family cover limit and the suspension-extension flag are snapshotted per term. Expected: terms already sold keep the benefits they were sold with.
- **Matters to.** Customer: unilateral variation of a paid contract; consumer-protection exposure; member not told.
- **Evidence.** `src/lib/store.ts:7444` (live join to `membership_plans`); `src/lib/membership-plans.ts:232`; `docs/features/pricing.md` "Changing a tier's benefits applies to its members from then on".
- **Classification.** Questionable policy (stated; the owner may not have weighed the downward edit).
- **Reproduction.** `audit9-D-8.test.ts` test 1 (`expected 95 to be 70`; scratch).
- **Root cause.** Benefits are not copied onto `memberships`.
- **Recommended resolution.** Snapshot rate, window, scope and entry at sale (a migration with backfill) (DEC-34).
- **Status.** OPEN decision, DEC-34. Not changed; ADR 0062 lists it among findings left to the owner.

### D7 · P2 · FIXED

- **Domain and scenario.** Memberships: "give days back" after the next term is sold.
- **Observed and expected.** `extendMembership` moved `expires_on` with no look at the holder's later term, breaking "terms may not overlap at one venue"; `activeMembership` then picked the first row of an unordered query, so which tier priced a booking in the overlap was arbitrary. The suspension path avoids exactly this (`laterTerm`). Expected: refuse, or push the later term.
- **Matters to.** Customer and venue: wrong tier price or window; two receipts for the same days.
- **Evidence.** `src/lib/store.ts:7788-7797` (single `UPDATE`), `:7525`, `:7518` (no `ORDER BY`); `src/lib/membership-suspensions.ts laterTerm`.
- **Classification.** Verified defect.
- **Reproduction.** `audit9-D-4.test.ts` (scratch). Regression: `tests/membership-extension-and-renewing-suspension.test.ts`.
- **Root cause.** Two code paths for one operation, only one guarded.
- **Recommended resolution.** Reuse `laterTerm`; add `ORDER BY` to `activeMembership`.
- **Status.** FIXED. ADR 0062 decision 5: `extendMembership` asks `laterTerm` and refuses, saying how many days fit (`FX8_EXTEND_INTO_NEXT`; `FX8_EXTEND_NEXT_FOLLOWS` where none do), changing nothing; it refuses rather than shortening or pushing a term the customer already paid for.

### D8 · P2 · OPEN decision (DEC-31)

- **Domain and scenario.** Pass products and loyalty rewards.
- **Observed and expected.** A product carries sport, coach, kind, entries, entry minutes, max length, scope, validity, price and day-pass flag only; one entry pays RM20 off-peak or RM60 peak, so customers spend entries at peak; the loyalty free hour pays any hour or court. The common "off-peak 10-hour pass" cannot be sold.
- **Matters to.** Venue: revenue per pass hour is unpredictable and adverse-selected; venues will not sell passes or price them at peak.
- **Evidence.** `src/lib/pass-products.ts` columns; `src/lib/store.ts:8528 passScopeError`; `src/lib/pass-rules.ts passCost`.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only.
- **Root cause.** Passes were modelled on length, not value.
- **Recommended resolution.** `off_peak_only` and a court list on product and pass, checked in `passScopeError` (DEC-31). Size M, migration.
- **Status.** OPEN decision, DEC-31. Not changed.

### D9 · P3 · OPEN decision (DEC-32)

- **Domain and scenario.** Setup and cleanup fees on a pass-paid booking.
- **Observed and expected.** `total_price` includes the fee and the pass settles the whole booking, so the fee is waived; pricing.md says fees are never discounted.
- **Matters to.** Venue: an undocumented interaction.
- **Evidence.** `payBookingWithPasses`; `docs/features/pricing.md:26-37`.
- **Classification.** Questionable policy.
- **Reproduction.** `audit9-D-6.test.ts` (`expected 0 to be greater than 0`; scratch).
- **Root cause.** Pass cost is by length only.
- **Recommended resolution.** State it, or charge fees beside the pass (DEC-32). Size S to M.
- **Status.** OPEN decision, DEC-32. Not changed.

### D10 · P2 · PARTLY

- **Domain and scenario.** Correcting a pass or a membership after sale.
- **Observed and expected.** The only writes after sale were void, membership extension and erasure: the holder's phone (the only key a pass or membership is spent by) could not be corrected at the desk, a pass could not be linked to an account afterwards, extended, topped up, or have a wrongly spent entry given back; the desk could not void; a wrong phone typed equal to a real customer's gives that stranger the entries. Expected: manager-only, reasoned, logged corrections of holder, expiry and entries.
- **Matters to.** Staff and customers: the commonest desk error (a phone typo) has no clean fix.
- **Evidence.** grep of `UPDATE passes|UPDATE memberships` in `src` (`store.ts:7796`, `membership-suspensions.ts:225`, `entries.ts:518`, `privacy.ts`); `src/app/api/admin/passes`; `roles.ts:91`.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only.
- **Root cause.** No correction primitives.
- **Recommended resolution.** Three manager actions (correct holder, extend pass, adjust entries) each logged. Size M, migration.
- **Status.** PARTLY. A manager can now extend a pass (`POST /api/admin/passes/:id/extend`, reason required, logged; ADR 0062, `tests/pass-restore-and-validity.test.ts`). Open: correcting the holder's phone, name or account link, and giving back or taking away an entry, are not built.

### D11 · P2 · OPEN

- **Domain and scenario.** Customer notices for expiry, renewal, strikes and low balance.
- **Observed and expected.** `MessageKind` has nothing for a pass or membership expiring, a membership renewal reminder, a pass nearly used, a no-show or late-cancel strike being recorded, or a number being struck out; a customer learns of a strike when the next booking is held or refused and a pass quietly lapses.
- **Matters to.** Customer: loses value or standing without notice; venue: lost renewals and disputes without evidence of notice.
- **Evidence.** `src/lib/outbox.ts:31-110` (the kind list); `src/lib/store.ts:5843 setNoShow`.
- **Classification.** Missing workflow.
- **Reproduction.** By reading only.
- **Root cause.** No scheduled expiry or standing notices were ever designed.
- **Recommended resolution.** One scheduled email at 14 and 3 days before pass or membership expiry with unused value; a message when a strike is recorded and when the limit is reached (DEC-38). Size M.
- **Status.** OPEN. Not changed. (G16 is the same gap for vouchers and the accountant's figure, partly fixed.)

### D12 · P2 · FIXED

- **Domain and scenario.** An open-ended suspension of a membership that renews by itself.
- **Observed and expected.** Suspending "until reactivated" on a plan that does not extend on suspension (the default) left the Stripe subscription charging each period ("Nothing pauses a subscription's charges"), terms carried suspended, no reminder, and an email that did not say charges continue. Expected: the manager is told and the member made whole (extend by default, or pause collection).
- **Matters to.** Customer pays for months of nothing; venue: chargeback exposure; easy to forget an open suspension.
- **Evidence.** `src/lib/membership-suspensions.ts` header; `suspendMembership`; `docs/features/pricing.md`.
- **Classification.** Operational risk; questionable policy.
- **Reproduction.** By reading only; the carry behaviour is in `tests/membership-suspensions.test.ts`. Regression: `tests/membership-extension-and-renewing-suspension.test.ts`.
- **Root cause.** No renewal check on suspension.
- **Recommended resolution.** Extend by default and show the next charge date; or pause collection (DEC-35).
- **Status.** FIXED by giving the days back; Stripe collection is **not** paused for a membership suspension. ADR 0062 decision 6: a suspension open-ended on a membership with an active subscription extends its end by the days it took, whatever its plan says, once its last day is known (when it is lifted); renewals charged meanwhile are made and carry the suspension on; a chain's last term takes all the days, never added twice. Not done: pausing collection at the gateway for a membership suspension (needs a live check), telling the member at suspension that charges continue, a periodic reminder to the manager, and the extension by default for a dated suspension. (A venue-level suspension does pause collection, see A4.)

### D13 · P3 · OPEN

- **Domain and scenario.** The phone number as standing.
- **Observed and expected.** Strikes, blocklist, customer note, remembered concession proof and one-review-per-number all key on `phone_key`: numbers are recycled and families share a phone, so three no-shows by an earlier owner strike out the next person, a proof seen for one person is "seen" for any later booking, and a guest can type a victim's number and no-show to strike it. Expected: number-keyed kept, but with strike provenance and an account-owned standing for verified numbers.
- **Matters to.** Customer: an unfair strike with no recourse.
- **Evidence.** `src/lib/cancel-policy.ts:115-130`, `src/lib/limits.ts:362`, `src/lib/concessions.ts proofOnFile`, `src/lib/reviews.ts`.
- **Classification.** Questionable policy (the number as identity is a stated principle; the consequences are not).
- **Reproduction.** `audit9-D-9.test.ts` D12 (`expected 3 to be +0`; scratch).
- **Root cause.** Identity by number.
- **Recommended resolution.** Keep, add provenance, an account-owned standing, proof by phone only when `remember` was chosen by a manager (DEC-39). Size M.
- **Status.** OPEN. Not changed (listed in ADR 0062 as left to the owner).

### D16 · P3 · OPEN

- **Domain and scenario.** Credit note on a pass-paid booking.
- **Observed and expected.** `CN-000001` with `paid_via = Pass` and no original receipt appears on the customer's documents; the journal hides it, leaving gaps in the number sequence.
- **Matters to.** Customer and accountant: document hygiene.
- **Evidence.** `src/lib/documents.ts:643 creditBooking`; `src/lib/accounting.ts:293`.
- **Classification.** Verified defect (cosmetic).
- **Reproduction.** `audit9-D-7.test.ts` (scratch).
- **Root cause.** `creditBooking` does not exclude `paid_via = pass`.
- **Recommended resolution.** Do not write it. Size S.
- **Status.** OPEN. Not changed.

### D17 · P3 · OPEN

- **Domain and scenario.** "Spent" in the customer report.
- **Observed and expected.** `SUM(b.total_price) AS spent` over `status = 'confirmed'` counts unpaid, no-show and pass-paid bookings at face value.
- **Matters to.** Venue: a misleading customer figure.
- **Evidence.** `src/lib/customer-report.ts:96`.
- **Classification.** Verified defect (misleading figure).
- **Reproduction.** `audit9-D-9.test.ts` D11 (`expected 40 to be 20`; scratch).
- **Root cause.** No payment filter.
- **Recommended resolution.** Filter to paid and exclude pass-paid (or show separately). Size S.
- **Status.** OPEN. Not changed. (The revenue report was reconciled in ADR 0055; this per-customer figure was not.)

### D18 · P3 · OPEN

- **Domain and scenario.** Which pass is offered first.
- **Observed and expected.** The booking form lists passes newest first without expiry, the counter oldest first, the gym entry desk soonest-expiry first, so a customer with two passes of one name will likely spend the later and let the older lapse.
- **Matters to.** Customer: a lapsed pass.
- **Evidence.** `src/lib/store.ts:8261/8273`, `PassAllocation.tsx`, `BookingBoard.tsx:1703`, `src/lib/entries.ts admittingPasses`.
- **Classification.** Operational risk.
- **Reproduction.** By reading only.
- **Root cause.** Three orderings.
- **Recommended resolution.** Soonest-expiry first everywhere, show "until DD Mon", default-select the first. Size S.
- **Status.** OPEN. Not changed.

### D19 · P3 · OPEN

- **Domain and scenario.** A tier priced above the member rate.
- **Observed and expected.** The tier percent applies to the public rate and ignores the court's member rate (Silver 90% of RM20 = RM18 against a member rate of RM15), with no warning.
- **Matters to.** Venue: a misconfiguration the system does not warn about.
- **Evidence.** `src/lib/pricing.ts:113`.
- **Classification.** Operational risk.
- **Reproduction.** `audit9-D-8.test.ts` test 2 (scratch).
- **Root cause.** Two price rules combined by precedence.
- **Recommended resolution.** Price at `min(tier %, member rate)` or warn when saving. Size S.
- **Status.** OPEN. Not changed.

### D20 · P3 · FIXED

- **Domain and scenario.** No quoted-price check.
- **Observed and expected.** `/api/bookings` took no expected total, so a rate edit, tier edit, expired code or lapsed membership between quote and Book changed the charge silently. Expected: send the quoted total; on mismatch 409 with the new quote.
- **Matters to.** Customer: charged a price they did not see.
- **Evidence.** `src/app/api/bookings/route.ts:75`.
- **Classification.** Unverified assumption (no repro).
- **Reproduction.** None. Regression: `tests/booking-price-handshake.test.ts` (`expectedTotal`).
- **Root cause.** No price handshake.
- **Recommended resolution.** `quotedTotal` with a 409 (DEC-26).
- **Status.** FIXED, although the status file lists it open: built by [ADR 0054](../architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md) decision 3 (C3), which names D20 among its findings (`expectedTotal`, `PRICE_CHANGED`, on the form's route and the venue API's). The form sends the total it showed, not for a weekly booking, a court picked for the customer or a concession.

### D21 · P3 · OPEN decision (DEC-23)

- **Domain and scenario.** Gift voucher redemption.
- **Observed and expected.** `redeemVoucher(userId, code)` is the only path, so a printed voucher given to somebody without an account cannot be used at the desk; expired vouchers are simply gone while the credit they become never expires.
- **Matters to.** Customer: a gift that cannot be used at the counter.
- **Evidence.** `src/lib/vouchers.ts`.
- **Classification.** Missing workflow (a venue choice may be deliberate).
- **Reproduction.** By reading only.
- **Root cause.** Account-only redemption.
- **Recommended resolution.** A desk "redeem against this number's account" action and a pre-expiry email to the buyer (DEC-23). Size M.
- **Status.** OPEN decision, DEC-23.

### D22 · P3 · OPEN decision (DEC-36)

- **Domain and scenario.** Voiding a membership.
- **Observed and expected.** `refund: true` credits the whole receipt ("nothing is prorated") while passes support the unused share; member-price bookings already made keep it.
- **Matters to.** Customer and venue: all or nothing.
- **Evidence.** `docs/features/pricing.md` (documented).
- **Classification.** Questionable policy.
- **Reproduction.** By reading only.
- **Root cause.** No pro-rata option.
- **Recommended resolution.** Offer a pro-rata refund by days left, venue setting (DEC-36). Size M.
- **Status.** OPEN decision, DEC-36.

### D23 · P3 · OPEN decision (DEC-37)

- **Domain and scenario.** A term started on the 31st.
- **Observed and expected.** `pricing.md` says 31 January plus one month ends on the last day of February; `addDays(addMonths(start, 1), -1)` gives 27 February (28 days) and the anchor then drifts to the 28th. `tests/membership-join.test.ts` pins only `addMonths`.
- **Matters to.** Customer: a term a day short; documentation and code disagree.
- **Evidence.** `docs/features/pricing.md`; `src/lib/store.ts`.
- **Classification.** Unverified assumption (AGENTS.md rule 9: say which is intended).
- **Reproduction.** By reading.
- **Root cause.** Two statements of one rule.
- **Recommended resolution.** Decide which is intended (DEC-37: the audit recommends the document). Size S.
- **Status.** OPEN decision, DEC-37. Not changed; the disagreement stands.

### D24 · P3 · OPEN

- **Domain and scenario.** Customer notes.
- **Observed and expected.** `setCustomerNote` upserts or deletes; the activity log records "Note on a number ending xxxx" without the text; any desk member can erase a note about a bad customer. Expected: keep prior text in the log row (personal data already within erasure).
- **Matters to.** Venue: an unaccountable record.
- **Evidence.** `src/lib/customer-notes.ts`, `src/app/api/admin/customer-notes/route.ts`.
- **Classification.** Operational risk.
- **Reproduction.** By reading only.
- **Root cause.** Overwrite semantics.
- **Recommended resolution.** Keep prior text in the log row. Size S.
- **Status.** OPEN. Not changed.
