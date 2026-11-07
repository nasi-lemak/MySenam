# ADR 0064: Credentials follow their owners, staff two-factor is on by default for managers of a production marketplace, second-factor attempts are counted before they are checked, and a refused number is admitted by nobody

- **Status:** current, decided 2026-11-07 in the post-audit hardening round (audit 9 findings A13, A14, A10 with owner decision DEC-05, A15, D24, E2 with DEC-40; A8 and DEC-06 checked and
  left as they were); built in migrations 0312, 0313 and 0314. What staff see is in [the public API](../../integrations/external-api.md#public-api-and-webhooks),
  [two-factor sign-in](../authentication.md#two-factor-sign-in), [check-in](../../features/venue-operations.md#check-in-and-live-crowd-levels) and
  [notes on a customer](../../features/venue-operations.md#notes-on-a-customer); the routes are in [the HTTP API](../http-api.md); the settings are in
  [configuration](../../development/configuration.md). Builds on [ADR 0030](0030-oauth-sign-in-for-ai-assistants.md) (a delegated sign-in re-reads its person on every use, which is the pattern
  used here), [ADR 0057](0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md) (staff lookups, secrets out of staff views, owner decisions logged), [ADR 0058](0058-safety-and-access-after-a-booking-is-made.md)
  (a refused number loses the unattended ways in) and [ADR 0063](0063-a-suspended-venue-tells-its-customers-sells-nothing-new-and-an-overdue-one-can-be-given-time.md) (a suspended venue sells nothing new).
- **Context:** an API key a manager made kept working after the manager was removed; there was no word for whose a key was, so no safe way to keep a venue's own website integration while
  letting a person's stop. Parallel guesses at a second-factor code all passed the ticket's cap of five before any was counted, and a person who knew the password could ask for new tickets
  without limit. Staff two-factor was opt-in, including for the platform owner who approves venues and marks invoices paid. The draft purge could delete the receipts and owed-back records of real
  money taken at a draft's counter. A customer note was overwritten and erased with no trace. The desk could still check in a number the venue had refused. This record keeps to what the owner
  decided or authorised; every recommended default below is marked as such where the owner has not decided it.

## Decision 1 (A13): a credential is a person's or the venue's, and authority is read on every request

- `venue_api_keys` and `webhook_endpoints` carry `ownership` (`person` or `venue`) and `owner_admin_id` (migration 0312), and who made them (`admin_id`; webhooks gain it). A manager says which
  when making one; **unsaid, it is the person's** (the safer restricted default: it ends with them). A **person's** credential works only while its owner is the platform owner, a manager of the
  venue's business, or a manager (not front desk) of that branch (`OWNER_AUTHORITY` in `src/lib/credential-owners.ts`). That is **joined into the query that authenticates every request** with a key
  (`apiCaller`), into the queries that queue and send a webhook, and into the lists, so removing, demoting or moving the person ends it **at that request**, not at the next sweep, and a path that
  forgot to sweep still cannot leave one working. The sweep (`endOwnedCredentials`, on removal and on a demotion to front desk) exists to **write down** what stopped (`integration.changed`, one
  row each, no secret in it) and to mark the row so the list says why (`revoked_reason` / `stopped_reason`: `owner_removed`, `owner_demoted`, `rotated`).
- A **venue's** credential does not depend on whoever made it. It is kept when they leave, listed as the venue's with who made it, and a manager can **take it over**, **make a person's the venue's**, or
  **rotate** it (a new key or signing secret, shown once; the old one dead at once; one transaction), each logged with who. A stopped credential is **never revived by handing it over**: its
  secret was the departed person's, so it is rotated (a `409` says so). Handing over to someone who does not manage the venue is refused.
- Removing a person returns what stopped and **how many of the venue's own keys and addresses they made** (and whether the venue's calendar feed is on), so the manager is told what to review. The
  calendar feed is one address per venue shared by its managers, not any one person's, so it is counted for review and not stopped.
- **Rows from before migration 0312 are the venue's** (the default). *Fallback for historical rows, chosen to protect the venue:* an integration already in use does not stop at the next staff change,
  the people who made them are not known to be the right owners, and nothing about their past is made up; the managers' list shows who made each, and the removal of a person says how many
  of them there are. The cost: a venue's key already seen by a person who has since left stays valid until a manager rotates it, so the review count is the remedy and the known limitation says so.
- **Every request that authenticates with a key re-reads the venue and business**, and while its venue, or its whole business, is **suspended, a key reads but does not write** (`403` on a write; the
  MCP server's write tools are hidden), as nothing new is sold at a suspended venue ([ADR 0063](0063-a-suspended-venue-tells-its-customers-sells-nothing-new-and-an-overdue-one-can-be-given-time.md)).
  *Recommended default, not an owner decision:* reading stays possible, because staff can still sign in to see and settle what is booked. The app has no path that moves a venue between
  businesses (`lib/branches.ts` refuses one already in another); were it done, a person's key made by a manager of the old business stops, and a venue's key stays the venue's.
- Delegated sign-ins from AI assistants (ADR 0030) already re-read the person, their role and the venue on every use, and end the grant (`personNow`); they were checked and not changed.
  Coaches' and officials' links are not staff authority.

## Decision 2 (A14): an attempt is counted before it is checked, per ticket, per account and address, and per account

- The ticket's attempt is taken in the **one statement** that claims the ticket (`UPDATE … SET attempts = attempts + 1 … WHERE attempts < 5 RETURNING`), so parallel requests cannot all pass the cap
  before any is counted. Then the attempt is counted against the account **from that address** (10 in 15 minutes) and the account **from anywhere** (50 in an hour) in
  `admin_two_factor_attempts` (migration 0313), by one atomic upsert each; the address is kept as a keyed hash. Past a limit the attempt is refused (`429`, `Retry-After`) and **the code is not looked at**,
  a right one included. These numbers are this record's choice, kept well above what a person mistyping makes.
- **No permanent attacker-triggered lock.** Each window is fixed and ends by itself (failing again does not extend it); a refused attempt from one address does not count against the account, so one
  address cannot lock the account for everybody; a wrong code never clears a counter, a right one clears only that address's and gives the account's attempt back. The way back: wait out the window,
  sign in from another address, or a reset of the account's two-factor sign-in by somebody with authority (`src/lib/two-factor-reset.ts`, unchanged: another person with two-factor on, a recorded reason, emails
  to the person and the owners; the console reset for the last owner), which also clears the counters. The reset does not weaken ordinary sign-in: it needs somebody who has proved themselves.
- A ticket is **used up by the first right code** (`DELETE … RETURNING`): two requests holding it, each with a right code, sign one session in. A ticket that never existed, ran out or was used is answered alike,
  and nothing says whether an account exists or which factor it has. The same count guards turning two-factor off, new recovery codes and an owner resetting another's.

## Decision 3 (A10 / DEC-05, authorised by the owner): staff two-factor is on by default for owners and managers of a production marketplace

- With `NODE_ENV=production` and `MYSENAM_MARKETPLACE=on`, the platform owner, business managers and venue managers must have two-factor sign-in whatever is set; front desk may choose
  (`staffTwoFactor` in `src/lib/two-factor.ts`). `all` stays `all`; `owners` is raised to `managers` (never weakened). **`off`, and a value that is not a rule, is refused**: enforcement carries on at
  `managers`, the start-up log says so, and the owners are alerted (`config:staff-2fa`, cleared when the setting is right). *Chosen over refusing to start:* a typo in a deploy must not take a live
  marketplace down, and the install stays safe while it is loud; the alternative, exiting at start, is the owner's to choose. The one way to run without it is `MYSENAM_SYNTHETIC_DATA=on` with it `off`, for
  staging and the acceptance server (AGENTS.md: synthetic data only); it is honoured and flagged by an alert all the same, and the marker alone changes nothing.
- Everywhere else (development, the tests, one venue's own install) it is as configured, unset meaning each account chooses: this is the override for development and tests, and nothing changes there.
- It is read on every request, so: the **first owner** enrols at first sign-in (nothing skips it); a **session made before** the rule applied is not staff until its account has enrolled; a **promotion**
  to manager is required at the next thing the account does; after a **recovery reset** the account is back to enrolling; an account is signed in to enrol **and nothing else** (`requireAdmin`,
  `getActingStaff`, `getActingStaffByToken`), and what the dashboard reads (`/api/admin/auth/me`) is told that and nothing more (no venues). Two gaps found and closed: the day's cash-up page read the session
  without the rule, and the dashboard's read gave an account that must enrol its venues.

## Decision 4 (A15): a draft is not purged while it holds the record of money taken at its counter

A booking made at a draft venue is a test, and "marking a booking a test never takes money out of the financial records" ([marketplace](../../product/marketplace.md#test-bookings-before-going-live)): a receipt is never
deleted, and what is owed back or was paid back stays where staff and the owner look. So `staleDrafts` leaves alone a business holding a **receipt or credit note, a refund owed (settled or not), a counter payout, a
counter sale, a booking marked paid or with a share or deposit paid, or a hire deposit**, as it already left one holding a pass, membership, credit, online payment, invoice or e-invoice. Nothing is detached or
deleted; the draft stays for the owner to look at, and is no longer a candidate for the 90-day purge.

## Decision 5 (D24): a customer note keeps an access-controlled history

`customer_note_history` (migration 0314) takes a row for every write, change and erase of a venue's note on a number, **in the same transaction** and under a lock on the note (so parallel edits each name the text
they replaced): action, the text before and after, who (kept as a name) and when. A save that changes nothing adds none. It is read by the venue's own staff only, by the same venue check as the note
(`GET /api/admin/customer-notes?history=1`), is never updated (a trigger refuses it), goes out with the customer's own data and is erased with their account. Notes that existed when this was built get one
`baseline` row (the note as it stood, who last wrote it, when); what was changed before is not known and is not made up.

## Decision 6 (E2 / DEC-40): a refused number is admitted by nobody

ADR 0058 refused the door code and the QR check-in and left the desk's check-in open ("a person looking at them"). The owner's decision of 28 October 2026 is that nothing overrides a refused number
([ADR 0026](0026-same-policies-on-every-path-with-manager-overrides.md)), and DEC-40 refuses the door code **and check-in**. So the desk's check-in, a lane given on arrival (checked **before** the booking is moved),
marking a person arrived, and a kit hand-over (which checks the customer in) refuse a refused number with `SEC_CHECKIN_BLOCKED` ("a manager can lift the refusal, with a reason"); there is no override. The
bookings stay listed for a manager, as ADR 0058 decided; nothing is cancelled by the system. An existing test that asserted the desk could check such a customer in (`tests/safety-and-access.test.ts`) was
changed to assert the refusal.

## Checked and not changed

- **A8:** staff-log entries from before migration 0301 have no business and are read by the platform owner only; no business manager, branch manager or front desk reads them, and none is invented
  (`tests/business-activity-log.test.ts` now says so). **DEC-06:** staff lookups by email or number find only customers connected to the caller's venues, are throttled and refused from a draft
  (ADR 0057); `tests/customer-lookup.test.ts` covers another business's venue and a sibling branch, and passed here.

## What was left open

- Whether a venue's own credentials made before this should all be rotated at once (nothing forces it; the managers see who made each).
- Whether the desk may, with a manager's reason, check in a refused number (the owner's decision says no; this builds no override).
- Whether `off` on a production marketplace should refuse to start rather than be refused and alerted.
- The calendar feed is one shared address per venue and is not rotated when a manager leaves (a rotation would stop everybody's subscription); it is counted for review.
