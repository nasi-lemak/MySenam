# ADR 0057: Staff find only their own customers, secrets are never in a staff view, the owner's decisions are logged, and a draft that cannot be deleted never stops the day

- **Status:** current, decided 2026-11-06 in the ninth audit round (findings A1, A2, A3, A6, A8, A9, A12, G6 and G12 of audit 9). Built in migration 0301. What
  staff and customers see is in [tenancy](../tenancy.md#looking-a-customer-up), [privacy](../privacy.md#online-payments-messages-and-webhook-deliveries),
  [authentication](../authentication.md#staff-invitations), [the marketplace](../../product/marketplace.md#running-the-marketplace) and
  [the staff activity log](../../features/reporting.md#staff-activity-log). Builds on [ADR 0005](0005-shared-marketplace-and-own-installs.md) (a marketplace of independent venues) and on
  the rule in `AGENTS.md` that personal data is recorded as declared and kept no longer than it needs to be.
- **Context:** anybody can sign up as a venue and be given a staff account for the price of an email address. On a marketplace that account sits in front of a customer table that
  belongs to nobody in particular. The audit found: a draft's manager could read any customer's name, email and number from either (A2); the staff outbox, open to front desk, showed the
  link of a manager invitation, which the desk could use first (A3); the owner's decisions about money and about who manages what left no trace (A6, G12); a business could not see its own
  managers' changes (A8); the permission model was a deny-list with nothing to say a new route had been thought about (A9); sign-up said whether an address was a staff account (A12); one
  abandoned draft with a ladder stopped the daily retention run for good and, through the dashboard's housekeeping, took every staff dashboard down (A1); and erasure left the payer's name and
  number on online payments, and the person in messages and webhook deliveries (G6).

## Decision 1: a lookup finds the venue's own customers, and is throttled

- On the marketplace, `GET /api/admin/wallet?q=` finds only a customer with a **relationship** with the venues the member of staff works at: a booking (by account, or by the email or number the
  venue was given), credit, a pass, a membership, an access-list entry linked to the account, or a participant they are guardian of (`connectedTo` in `src/lib/customer-lookup.ts`). Anybody
  else is "not found", whatever they hold elsewhere. The platform owner, who runs the install, and an install that is one business's own are not narrowed.
- Every lookup counts against 30 an hour for one staff account and 120 an hour for one address, so a number cannot be walked.
- **Linking** a sale or a record to an account by the email a customer read out (a pass, a membership, a sign-off, a guardian, a coach, an access-list entry) cannot require a
  relationship, since linking creates one. It is throttled the same way, is **not offered from a venue that has not gone live** on the marketplace (a draft is a free sign-up: `LOOKUP_NOT_LIVE`),
  and a guardian invitation started with an email and no name no longer shows the account's name.
- **Consequence the owner should know:** a customer who has an account but has never booked, paid or held anything at a venue cannot be found by its counter to be sold credit. They top up
  online themselves (`POST /api/my/wallet`), after which the venue finds them. Top-up by `userId` (`POST /api/admin/wallet`) is unchanged: it tells nobody anything, and the id cannot be found.
  The audit's alternative (find by the email the customer reads out, show a masked name) was not taken: the brief was that staff find only customers with a relationship.
- Looked at and left alone, since they are scoped to one venue's own records: customer notes, participants by number, entries, strikes, and the public API (`/api/v1`).

## Decision 2: a secret is never in a staff view

- Whatever lists messages to staff (`listMessages`, `listPlatformMessages`, the answer to sending one again) goes through `forStaff`: a message of kind `account_email` (an invitation, a password reset, an
  address to confirm, a guest's or player's invitation) shows its subject, recipient and status and **never its text, its parameters or its calendar**; any other link with `token=` in it is shown as
  `(link hidden)`. The sending code reads the stored message itself. The mask is for **every** staff caller, the platform owner included: the person invited is the only one who needs the link.
- Sending a staff invitation again gives up an earlier email of it that had not gone (its link is not kept: the outbox's existing rule), and the old link stops working because the token is replaced.
  So an invitation that failed while the mail provider was down is mended by sending it again, with a new link, not by anybody reading the old one.

## Decision 3: the owner's decisions and an API key's bookings are in the activity log

- Marking an invoice paid and voiding one need a **reason** of 5 to 300 characters (`BILL_REASON_REQUIRED`); the dashboard asks for it. Setting a venue's fee and billing start, the plans by size, grouping venues into a
  business, making staff its managers, adding a venue, approving or refusing an application, and suspending or lifting a venue or business are written to `staff_actions` with the owner's name, the figures before and after
  and the reason where one was given. Each carries the venue it concerns (so that venue's managers read it) or, with none, the business (below).
- A booking made or cancelled through an API key (`POST /api/v1/bookings`, `.../cancel`) is `booking.created` or `booking.cancelled` under `API key "<name>"`, as a desk booking and the MCP server's are.
- `staff_actions.business_id` (migration 0301, nullable) is set for an entry that names no venue, and `listActivity` returns a business's managers `business_id = their business` beside their venues' entries. Earlier
  business-level entries cannot be attributed and stay the platform owner's to read.
- `tests/staff-log-coverage.test.ts` no longer allows the billing, businesses, venues and venue-applications routes to write nothing.

## Decision 4: every admin route is classified, in one table

- The front desk's permissions stay a deny-list (`MANAGER_ONLY`), as before: no behaviour is changed by it. `tests/admin-route-classes.test.ts` lists every handler as `manager`, `owner`, `desk` or `account`
  and fails for a handler that is not listed, one listed that no longer exists, or a class that disagrees with `MANAGER_ONLY`. A new route reaches the desk only by being written down as `desk`.
- Two routes the desk could reach were moved to manager-only on evidence: `PATCH /api/admin/outages` (closing the late hours of an outage; its siblings `POST` and `DELETE` were already the manager's, the tenancy table
  lists outages as a manager's, and the test is named "a manager's action on the dashboard") and `POST /api/admin/admins/:id/two-factor-reset` (the handler already refused the desk, so this only moves the refusal to the guard).
  Not moved, with the reasoning: `POST /api/admin/inductions` is recorded by whoever shows a person round, which the desk does; rain-outs, company-account charges and counter refunds' hand-back are documented desk tools.

## Decision 5: signing up does not say who works at a venue

- An address that already holds a staff account, or has a sign-up waiting, gets the answer a new address does (`201 { ok: true, emailSent: true }`) and an email saying it already has one and how to sign in,
  at most once an hour. Where no email can be sent the refusal is as it was: nobody could be asked to confirm either.

## Decision 6: erasure and retention reach online payments, messages and webhook deliveries; a draft that cannot be deleted is skipped

- **Erasure** (`src/lib/erasure-traces.ts`, in the erasure's transaction): the payer's name and number on a payment that is provably the account's (its bookings, top-ups, membership, pass, open-game place, tournament entry)
  become `(removed)` and nothing, **the payment (amount, refunds, gateway bill) stays**; messages to the account's email or proved number or about its bookings are scrubbed and any still queued is given up; webhook
  deliveries about its bookings are dropped if unsent and reduced to id, type and time if sent; urgent notices for its bookings lose the name, number and email. Nothing is matched by a number alone.
  A payment made by somebody else who typed the same number is left: a number is not proof.
- **Retention:** the payer's name and number on an online payment are anonymised after the bookings' 730 days, the payment kept. Messages (90 days) and deliveries (30) already had rules.
- **Export:** the account's export lists its online payments and the deliveries still held about its bookings; a venue's export by number lists payments with that number as the payer's.
- **Drafts:** the purge finds what points at a stale draft **from the database's foreign keys** (`draftDeletionPlan`), so a table added later is covered without a list to keep up; each business is deleted in a savepoint of its own and
  one that cannot be removed is skipped and reported to the owners (`retention:stale-draft-not-deleted`). `/api/admin/auth/me` catches a failing housekeeping, logs it, tells the owners (`scheduler:retention-failed`) and does not
  retry for an hour from that process. The scheduler already raised an alert for a retention run that fails.
- `tests/erasure-scan.test.ts` scans every text column of every table for an erased account's email, number and name, and holds the list of every table with a person's details and how each is treated
  (`HOLDS_PEOPLE`): a new such table fails until it is named.
- **Provisional:** the 730-day period for payers is the booking names' existing period, an operational choice and not a statement of what the law requires for payment records; the audit's alternative (keep the
  payer's name for seven years as a tax record, say so in the privacy notice and the export) was not chosen. Whether either is right for Malaysia is a question for the venue's adviser and is not settled in code.

## Alternatives considered

- *Keeping a global lookup but masking the name.* Rejected for the counter's lookup: it still confirms that an email or number has an account; the brief was a relationship.
- *Refusing every lookup from a draft.* Done only for the linking flows, where it is the point (a draft is a free sign-up); the counter's lookup needs no such rule, since a draft has no customers.
- *Storing an invitation's link as a reference and writing it into the email when it is sent.* Better still, and not done: it changes the outbox's shape; masking and the existing wipe on sent or abandoned give the same
  protection for the same readers.
- *Cascading deletes (`ON DELETE CASCADE`) on the tables that blocked a draft's deletion.* Rejected: it would also silently delete a live venue's rows if a venue were ever deleted, which nothing does today and nothing should do quietly.
- *Moving the front desk to an allow-list.* Rejected: a large change in what the desk can do for no change a venue wanted; the table and its test give the same protection against forgetting.
