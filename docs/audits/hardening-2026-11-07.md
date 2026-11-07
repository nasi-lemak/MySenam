# Post-audit hardening round, 7 November 2026

A bounded round on the [business-process audit](findings-register-2026-11-06.md): verified
defects and decisions the owner authorised in writing, nothing else. It is not another
audit and not a feature round. The sections below are filled as the round proceeds; the
round is not finished until its [release record](../development/testing.md#release-records)
says so.

## 1. Baseline

| Item | Value |
| ---- | ----- |
| Branch | `claude/sports-court-booking-w99x22` |
| Commit at the start | `068b9aa` (a release-record commit; its only change over `1737cc2` is `docs/development/testing.md`) |
| Last verified source | `1737cc2`, source digest `8cb908af668344991b9caba969d31b98f6b00418e96e83f03d72370ec902be77` (`node scripts/verify.mjs check` reported VERIFIED, one record-only commit since) |
| Working tree at the start | clean |
| Last release verification | PASS on `1737cc2`, 6 November 2026, on the AI VM: PGlite 6472 passed and 13 expected skips; Postgres 16 6485 of 6485; end-to-end 12 of 12; acceptance scenarios 95 of 95; type check, lint, documentation checks and a fresh production build passed. A historical result, not a statement about any later commit. |
| Audit baseline and fix round | audit baseline `2aabdd4`; fix round ended at `126d7d0` |

The audit's 140 finding identifiers (several describe one root cause) stood, at the start,
at 77 fixed, 10 partly fixed, 20 waiting for a decision and 33 open
([known limitations](../roadmap/known-limitations.md#business-process-audit-6-november-2026-open-items)).

### Selected for this round (with the owner's authority)

Security: A13, A14, A10 (DEC-05), A15, D24, E2, A8. Payments: C19, C18 (DEC-14), G19,
G17, C2 (memo, guard and test only), G15, D16, D17, C11, D1, C10, C6, C13 (documented, not
changed). Rules: B9 = E10 (DEC-11), B12 (DEC-09), B14, B11, D6 (DEC-34), B16 = C12 = D15
(DEC-16), C5, F6 (DEC-50), E18 (DEC-45). Smaller: B15, B6, D18, D19, E16, E17, D11/G16,
G18.

### Deferred on purpose

A5 = H8 exit workflow (restricted-pilot operating policy instead), E11, E19, D8, D9, D10,
D22, DEC-23 (voucher expiry, desk redemption: a lawyer), tournament and league
conveniences that corrupt no data, new youth messaging or moderation, new markets or
providers, unstaffed smart-lock access.

### Needs the owner, a tax adviser or a lawyer (not decided in code)

C2/DEC-19 (tax adviser), DEC-23 (lawyer), DEC-39 phone number as identity (owner), DEC-02
validity pausing during suspension (owner), the venue-exit design (A5), youth messaging
(a Malaysian lawyer, `docs/operations/legal-review-youth-messaging.md`).

## 2. What the round did to each remaining finding

One row per remaining entry of the audit (the 52 of the audit's
[open items](../roadmap/known-limitations.md#business-process-audit-6-november-2026-open-items)
that were open, partly fixed or waiting for a decision at the start; the narrower items
the fix workers had noticed are in known limitations with the finding they belong to).
Entries that describe one defect (`B9 = E10`) are one row and one fix. *Status* is what is
true now; *severity* is re-judged on this round's definitions (section 3); *decision* says
who must still decide; *scope* says whether the round took it. A test file in a row
exercised the behaviour on PGlite and, where it says so, on Postgres 16 by the worker;
the frozen-source run is in section 6. Nothing in a row was checked against a real
provider.

| Finding | Status now | Severity and gate | Decision | Scope | Code and tests | Remaining risk |
| ------- | ---------- | ----------------- | -------- | ----- | -------------- | -------------- |
| A13 | Fixed | **P1** (was P3): a removed manager's key kept authority; platform-wide for venues that use keys | Authorised | In | `api-keys.ts`, `webhooks.ts`, migration 0312; `credential-owners.test.ts` | Keys older than 0312 are the venue's until rotated; calendar feed shared |
| A14 | Fixed | **P2** (was P3): 40 parallel wrong codes were all checked; platform-wide | Authorised | In | `two-factor.ts`, migration 0313; `two-factor-attempts.test.ts` (Postgres) | Limits are this round's choice |
| A10 | Fixed | P2; gate for any pilot with managers | Authorised (DEC-05) | In | `admin-auth.ts`; `staff-two-factor-default.test.ts` | `off` is refused, not an exit at start |
| A15 | Fixed | P3 | Authorised | In | draft purge; `draft-purge.test.ts` | A draft with money is kept for the owner |
| D24 | Fixed | P3 | Authorised | In | migration 0314; `customer-notes.test.ts` | None known |
| E2 | Fixed | P3 | Authorised (DEC-40) | In | `safety.ts`; `safety-and-access.test.ts` | Class register marks not blocked |
| A8 | Not a defect | P3 | None | In (verified) | `business-activity-log.test.ts` | Old entries are the platform owner's to read |
| C19 | Partly fixed; **live check pending** | **P1 for Billplz online payments only** | Sandbox needed | In (local checks) | `payment-settlement.ts`; `billplz-settlement.test.ts` (Postgres) | Fields as documented, never seen live; a callback without `paid_amount` is held |
| C18 = H7 | Fixed | P2 | Authorised (DEC-14) | In | `payment-settlement.ts`; `billplz-settlement.test.ts` | Guests' typed emails not used; Billplz refund by hand; approval bookings keep revival |
| C2 | **Open (guard, memo, test in)** | **P1 for a venue that e-invoices and sells credit or vouchers**; not platform-wide | Tax adviser | In (memo, guard, test only) | `einvoice-stored-credit-memo.md`; `einvoice-stored-credit.test.ts` | Double count remains until the adviser answers; do not enable e-invoicing at such a venue |
| G15 | Partly fixed | P3 | Adviser (LHDN timing) | In (marker) | `einvoice-stored-credit.test.ts` | What a late consolidated e-invoice means is unverified |
| G19 | Fixed | P2; feature-specific (loyalty) | Authorised | In | `loyalty.ts`, migration 0320; `loyalty-grant-once.test.ts` (Postgres) | Past duplicates listed, not reversed |
| G17 | Fixed | P3; platform-wide | Authorised | In | `webhooks.ts`, migration 0321; `webhook-failed-deliveries.test.ts` | Stand-in receiver; missed events not replayed |
| G18 | Fixed | **P2** (was P3): a hung upload delayed refunds; platform-wide | Authorised | In | `scheduler.ts`; `scheduler-units.test.ts` | A lost lease does not cancel work |
| B15 | Fixed | P3 | Authorised | In | `key-bookings.ts`; `api-lapsed-holds.test.ts` | List reads show a lapsed hold as unpaid until the tick |
| E17 | Fixed | P3 | Authorised | In | `enquiries.ts`; `enquiries-attention.test.ts` | No acknowledgement to the enquirer |
| B16 = C12 = D15 | Partly fixed | P2; platform-wide | Authorised (DEC-16), owner for the rest | In | `move-money.ts`, migrations 0324, 0325; `move-cheaper*.test.ts` (Postgres) | Keep-after-cutoff manager-only; no in-app credit choice; pass-paid returns nothing; the venue's own move keeps the price; refund legs not live-checked |
| B11 | Fixed | P2 | Authorised, DEC-60 written | In | `move-money.ts`; `move-cheaper.test.ts` | None known |
| D3 | Partly fixed | P3 | Owner (DEC-33) | In (clamp) | `move-cheaper.test.ts` | Percentage recompute undecided |
| C5 (rest) | Fixed | P2 | Authorised | In | `move-cheaper.test.ts`, `account-invoice-snapshot.test.ts` | No billing path: refused |
| D16 | Fixed | P3 | Authorised | In | `documents.ts`; `pass-paid-cancel-trail.test.ts` | Earlier notes kept |
| D17 | Fixed | P3 | Authorised | In | `customer-report.ts`; `customer-spent.test.ts` | None known |
| C11 | Fixed | P3 | Authorised (DEC-18 in part) | In | `counter-refunds.ts`; `counter-payouts-owed.test.ts` | League place fee, voucher refund, counter-sale void not on the list |
| D1 | Fixed | P3 | Authorised | In | migration 0326; `counter-payouts-owed.test.ts` | Refunds before 0326 not on the list |
| C10 | Fixed | P3 | Authorised | In | migration 0327; `hire-deposit-method-stated.test.ts` | None known |
| C6 | Partly fixed | P3 | Adviser and owner | In (invoice page) | `invoice-part-payments.test.ts` | Journal granularity unchanged |
| C13 | Left on purpose, pinned | P3 | Owner | In (test only) | `rounding-half-sen.test.ts` | 1 sen at a half sen |
| B9 = E10 | Fixed | P2; feature-specific (classes) | Authorised (DEC-11) | In | `holds.ts`; `class-pay-to-hold.test.ts` (Postgres) | Struck-out numbers not offered pay-to-hold; stranded-hold sweep skips classes |
| B6 (rest) | Fixed | P2; feature-specific | Authorised | In | `class-offers-several-places.test.ts` | None known |
| B12 | Fixed | P2; platform-wide | Authorised (DEC-09) | In | `cancel-policy.ts`, migration 0330; `booking-terms-snapshot.test.ts` (Postgres) | Earlier bookings on current terms; terms not on the email |
| B14 | Fixed | P3 | Authorised | In | `store.ts`, `dated-changes.ts`; `policy-edit-races.test.ts` (Postgres) | Hours narrowing does not list classes |
| E18 | Fixed | **P2** (was P3) | Authorised (DEC-45) | In | `cancel-policy.ts`; `cancel-after-access.test.ts` | Door code cannot be revoked per booking |
| D6 | Fixed | P2; feature-specific (memberships) | Authorised (DEC-34) | In | migrations 0337, 0338; `membership-term-benefits.test.ts` | No pre-renewal notice; Stripe renewal not live |
| D18 | Fixed | P3 | Authorised | In | `pass-rules.ts`; `pass-use-order.test.ts` | Label shows no date |
| D19 | Fixed | P3 | Authorised | In | `membership-plans-route.test.ts` | Between-rate prices allowed once confirmed |
| F6 | Fixed | P2; feature-specific (open games) | Authorised (DEC-50) | In | `no-show-marks.ts`, migration 0341; `no-show-marks.test.ts` (Postgres) | Under-18 accounts not emailed; no appeal after an owner decision |
| E16 | Fixed | P3 | Authorised | In | `coaching.ts`; `coach-untold-and-payouts.test.ts` | One-off burst of emails after deploy |
| D11, G16 (rest) | Partly fixed | P3 | Owner (DEC-38) | In (bounded) | `standing-notices.ts`; `standing-notices.test.ts` | No voucher email, second reminder, liability line |
| D13 | Open, documented | P3 | Owner (DEC-39) | In (documentation, test) | `standing-notices.test.ts` | Standing follows the phone number |
| A5 = H8 | **Deferred** | P2 for general availability; **pilot gate: the operating policy in section 5** | Owner (DEC-03) | Out | none | A venue cannot be closed in the app |
| A4 (rest) | Deferred | P2; Stripe pause is feature-specific | Owner (DEC-02) | Out | none | Validity not paused; Stripe pause unverified |
| C14 = D14 = H6 | Deferred | P2 | Owner (DEC-30) | Out | none | Venue keeps 100% on a late pass-paid cancel |
| C15, D21 | Deferred | P3 | Lawyer (DEC-23) | Out | none | Voucher expiry and desk redemption |
| D8, D9 | Deferred | P2, P3 | Owner (DEC-31, 32) | Out | none | Passes cannot be limited; pass waives the setup fee |
| D10 (rest) | Deferred | P2 | Owner | Out | none | A pass cannot be corrected at the desk |
| D22, D23 | Deferred | P3 | Owner (DEC-36, 37) | Out | none | No pro-rata void; 31st-day term documentation conflict |
| E11, E19 | Deferred | P2, P3 | Owner (DEC-46) | Out | none | No coach-absence workflow; no class instructor pay |
| E15 | Deferred | P3 | Owner (DEC-43) | Out | none | Term discount for a lone session |
| F8 (rest), F10 (rest), F11, F12, F13, F14 | Deferred | P2, P3 | Owner (DEC-48, 52, 51, 18, 54) and the WhatsApp check | Out | none | As listed in known limitations |
| H12, H13 | Deferred | P3 | Owner (DEC-15, 08) | Out | none | No undo of a staff cancel or void; desk cannot close a day |
| G20 | Deferred | P3 | Owner (DEC-58, 59) | Out | none | Phone code allowance; guest booking by email; log retention |

## 3. Severity changes and why

Severity was re-judged on the round's definitions (P0 exploitable exposure or
unrecoverable loss; P1 a release blocker; P2 important; P3 enhancement), and a P1 is
named as a gate for one feature where it is one.

- **A13 P3 to P1.** A person who stops being a manager kept an API key that could read
  and write the venue's bookings: a serious privilege bypass, for every venue using keys.
- **A14 P3 to P2.** Counting after the check let parallel guesses through; bounded by the
  per-address limit but a real weakness in the strongest login protection.
- **G18 P3 to P2.** A hung off-site upload delayed refunds, messages and the heartbeat.
- **E18 P3 to P2.** Both a full refund and continued access, repeatable by any customer.
- **C19 P1, for Billplz online payments only.** A payment settled on a callback's word
  without checking the amount. It blocks offering online payments, nothing else; a
  staffed pilot that takes payment at the counter is not blocked.
- **C2 P1, for e-invoicing at a venue that sells credit or vouchers only.** A venue that
  does not e-invoice, or sells neither, is not affected.
- **A5 = H8 P2:** a general-availability gate, not a pilot gate, under the operating
  policy in section 5.
- Unchanged where the audit's rating held: B16, B12, B9, D6, C18, F6 (P2); the rest P3.
- **No P0 is known.**

## 4. Decisions implemented

The [business decisions](business-decisions-2026-11-06.md#status-after-the-hardening-round)
record each: DEC-05, 09, 11, 14, 34, 40, 45, 50 built; DEC-16 and 38 in part; DEC-33
clamped only; DEC-19 not decided (memo, guard and test); DEC-60 written. For each, the
old and new behaviour, and the customer, venue, financial and migration impact, are in its
decision record: [0064](../architecture/decisions/0064-credentials-follow-their-owners-two-factor-by-default-and-counted-attempts.md),
[0065](../architecture/decisions/0065-a-payment-is-settled-for-the-amount-the-gateway-took-and-never-into-a-lapsed-hold.md),
[0066](../architecture/decisions/0066-operations-hardening-grants-deliveries-leases-and-the-worklist.md),
[0067](../architecture/decisions/0067-a-paid-booking-moved-cheaper-gives-the-difference-back-and-a-move-never-silently-changes-a-discount.md),
[0068](../architecture/decisions/0068-money-hardening-credit-notes-are-not-cash-spent-is-money-paid-and-the-till-lists-every-payout.md),
[0069](../architecture/decisions/0069-the-terms-a-booking-was-sold-on-govern-it-arrival-goes-to-staff-and-edits-meet-bookings-in-one-transaction.md),
[0070](../architecture/decisions/0070-class-places-held-for-payment-and-several-offers-at-once.md),
[0071](../architecture/decisions/0071-a-membership-keeps-the-benefits-it-was-sold-with.md) and
[0072](../architecture/decisions/0072-a-hosts-no-show-mark-is-told-answered-and-reviewed-and-counts-at-its-venue.md).

Behaviour changes a customer or venue will notice: an unpaid online class place now
vanishes when its hold ends; a cheaper move shows and returns the difference; a
cancellation after the customer's own check-in goes to staff; a no-show mark now tells the
player; a production marketplace asks every owner and manager to enrol in two-factor.
Migrations added: 0312 to 0314, 0316, 0320, 0321, 0324 to 0327, 0330, 0337, 0338, 0341, 0342:
new columns and tables, one `NOT VALID` then validated constraint at a time, no backfill that
invents a past term (legacy cancellation terms are left empty and read as the current
terms; legacy memberships are backfilled from the plan as it stands and marked), none
deletes data.

### Found by the round's own tests and reviews

Beyond the selected findings, two checks the round ran found real defects, fixed with tests:

- **The cross-domain suite** (`tests/cross-domain-*.test.ts`, 41 tests, six files): a
  second counter hand-back for one booking threw because of a unique constraint from before
  cheaper moves existed, leaving money owed and unsettleable (migration 0342, P1 for
  counter venues: found *because* two branches of this round met); moving a booking into
  hours the door is the way in skipped the sign-off check (P2); a league fixture or
  tournament match could be moved onto a closed day (P3); a booking racing a fixture move
  threw halfway through a postponement (P3).
- **The customer sign-up and password-reset review** (`tests/auth-review.test.ts`): a
  reset link for an erased account caused a 500; reset links could be asked for without a
  per-address cap; changing a password left earlier links alive; phone-code tries were
  counted after the check. Both journeys are *ready only with manual safeguards*
  ([pilot readiness](../operations/pilot-readiness-2026-11-07.md#customer-registration-and-password-reset)).

### Existing tests the round changed, and why

No assertion was loosened. Each of these encoded behaviour that a decision of the round changed on purpose:

- `tests/waitlist.test.ts` (one offer at a time, now one per free place: ADR 0070); `tests/entries.test.ts`
  and `tests/membership-scope.test.ts` (a term keeps the benefits it was sold with; a share above the member
  rate needs confirming: ADR 0071); `tests/benefits-paths.test.ts` and `tests/account-invoice-snapshot.test.ts`
  (a cheaper move owes the difference back; staff cannot move an invoiced booking dearer: ADR 0067);
  `tests/series-cancel.test.ts`, `tests/lesson-moves.test.ts`, `tests/reschedule.test.ts` (the terms a booking was
  sold on govern it: ADR 0069); `tests/customer-report.test.ts` ("spent" is money paid: ADR 0068);
  `tests/coaching-two.test.ts` (scheduled lessons apart from held: ADR 0072); `tests/safety-and-access.test.ts`
  (the desk refuses a blocked number); `tests/payments.test.ts`, `tests/passes-online.test.ts`,
  `tests/membership-purchase-holds.test.ts`, `tests/coach-difference-online.test.ts` (Billplz fixtures carry
  the collection and amounts the documented callback has: ADR 0065); `tests/games.test.ts` (a no-show needs a reason).
- `tests/guest-counting.test.ts` and `tests/same-policies.test.ts` made a venue's system key through a desk
  member or another venue's manager; under ADR 0064 a person's key stops with them, so the fixture now makes it
  the venue's (found by the full suite on the merged tree).
- Three browser scenarios failed the first complete release run of the round (`tests/uat/change-time.uat.ts`,
  `round6.uat.ts`, `round8.uat.ts`): a customer changing a booking's time now sees what it does to the price and
  confirms (no browser dialog), and a booking keeps the cancellation terms shown when it was made, so the venue
  turns on *give the court back after the cutoff* before the customer books, not after.

## 5. Restricted-pilot operating policy for a venue that cannot yet leave (A5 = H8)

A venue-exit workflow is not built. Until it is (a requirement for general availability,
not for a staffed pilot of one to three venues):

1. No venue is removed or closed by an automatic or unmonitored path; suspension is the
   owner's act, and it does **not** settle any liability.
2. Customer stored value (credit, passes, memberships, vouchers) at a pilot venue is kept
   small; the owner sees it in the venue's liabilities block (provisional, for the venue's
   adviser).
3. One named person at the platform operator is responsible for refunds owed, held
   payments and the closure of a venue, and checks *Refunds owed*, *Payments to check* and
   *Needs attention* daily.
4. A suspension is never described to a customer as having settled what they are owed.
5. Closing a venue is done by hand: stop selling, refund or honour what is held, export,
   then suspend. It is not equivalent to the automated feature.

## 6. Verification

Recorded in [testing](../development/testing.md#release-records) when the frozen source
has passed the whole release profile. This record says nothing about it until then.

