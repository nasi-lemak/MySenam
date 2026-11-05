# Live accounting: sending a venue's sales to Xero

Not yet verified against Xero; see [feature status](../product/feature-status.md). Decision: [ADR 0041](../architecture/decisions/0041-live-accounting-push-to-xero.md).

> **Not yet tried against Xero.** This is written from Xero's published API and
> tested against a stand-in Xero (`tests/helpers/xero-standin.ts`, used by
> `tests/accounting-push.test.ts`, `tests/accounting-push-routes.test.ts`,
> `tests/xero-adapter.test.ts` and `tests/verify-xero.test.ts`). A stand-in shows what
> MySenam does against an API of that shape, not that Xero answers so. Until
> `scripts/verify-xero.mjs` has passed against a Xero **demo company**
> ([below](#verifying-against-a-demo-company)) and the result is recorded in feature
> status, the integration stays `INTEGRATION_VERIFICATION_REQUIRED`, and no venue's real
> books should be connected to it.

Until now a venue's accountant imported the sales journal by hand
([reporting](../features/reporting.md)). A venue may now
also send its sales to its own Xero organisation as they happen. It is optional, off by
default, per venue, and the export stays exactly as it was: it is still the fallback, and
the way for **SQL Account and AutoCount**, which have no common cloud API and are not
connected. The code speaks to Xero through a provider interface
(`src/lib/accounting-provider.ts`; the Xero adapter is `src/lib/xero.ts`), so QuickBooks
Online can be a second adapter later; **it is not built**. Xero's webhooks are not used
(MySenam only sends), and nothing is read back from Xero but its chart of accounts and tax
rates.

Managers use it under *Reports → Accounting* (`src/components/admin/AccountingPanel.tsx`);
the logic is `src/lib/accounting-push.ts`.

## The install switch and the Xero app

Two things are the install owner's, and neither is done by the app or in a chat:

1. **Approve the transfer.** Xero keeps what is sent in the data-centre region it assigns
   to each organisation, normally outside the country. Like off-site backups abroad
   (`OFFSITE_TRANSFER_APPROVED`), nothing is offered until the install has said the
   transfer is approved: `ACCOUNTING_PUSH_APPROVED=yes`
   ([privacy](../architecture/privacy.md#live-accounting-push) says what is sent and what
   the app does and does not judge). Until it is set no venue sees a connect button and
   the scheduler sends nothing, whatever else is configured.
2. **Register the install's own Xero app** at developer.xero.com: a web app using the
   authorization code flow; its redirect address `<site>/api/admin/accounting/xero/callback`
   (the same value as `XERO_REDIRECT_URI`); the scopes in
   [configuration](../development/configuration.md) (`XERO_SCOPES` names them if the app
   was made with others); then `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` and
   `XERO_REDIRECT_URI` in the host's environment or secret store, never in the repository.
   A Xero **demo company** (free, from the Xero developer area) is what the check below
   runs against.

Each venue then connects **its own** Xero organisation through that one app.

## Connecting

A manager opens *Reports → Accounting*. Before anything else the panel says what is
sent, where Xero keeps it, and asks the venue to agree. The tick is required (the
connect button stays off without it), and the acknowledgement is recorded with the
connection: who, when, and which wording (`NOTICE_VERSION`; changing what is sent changes
the version, and a page loaded under the old wording is refused until it is read again).
The app does not judge whether sending the data is lawful for a venue: it records that
the venue read the notice and agreed.

The manager is then sent to Xero (authorization code with PKCE; the state is used once and
can be finished only by the signed-in manager who began it, for that venue), chooses
**exactly one organisation** (the venue's own; several are refused and given back at
once), and returns. The organisation's books must be in this site's currency, or the
connection is refused and given back. Connecting again replaces the old grant at Xero.

Both tokens are **sealed** with the key that already locks the payment gateways' keys
(`src/lib/secrets.ts`: `MYSENAM_SECRET`, else `secret.key` in the data folder), so a
backup carries them without what opens them; an install restored elsewhere cannot open
them and asks for the connection again. A token is only ever put in a request's header or
body: never in a log, an error, an answer of any route, the activity log, or the queue.
Xero's refresh token rotates (each refresh spends the old one): one process refreshes at a
time (a short lease in the connection's row), another that finds it held waits for what
the first stored, and a second concurrent 401 does not mistake that for a lost grant.

**Disconnect** gives the grant back at Xero (the organisation's connection, then the
refresh token), empties both token columns, and leaves what was already sent in Xero.
What was not yet sent is set aside (*left out*), not lost. If Xero cannot be reached to
take the access back, the panel says so and tells the manager to remove the app in Xero
under *Settings → Connected apps*.

## What is sent

For each paid sale or refund, and nothing else:

| Sent | Not sent, ever |
| ---- | -------------- |
| The account holder's **name and email** as Xero's contact, read at the moment of sending and never stored by MySenam. A customer without an account is one contact, `Walk-in customers`, with no email | A **phone number**; a **child's name** (accounts are adults': a child's sale is under the account that paid for it, and a sale with no account is the walk-in contact; the receipt's own customer name is never used); whom a place was for; booking notes; any other detail |
| The amount, the tax inside it (as the receipt computed it), the date (the venue's own calendar) | A gateway fee (the export has none either) |
| A line saying the kind of sale (a booking's: the court and the day), our document number prefixed with the venue's (`V3-R-000012`) and a reference (`MySenam V3 receipt:12`) so a person in Xero can find the sale | |
| How it was paid, as the bank or clearing account the manager mapped it to | |

The queue and the connection hold none of the contact's details: only amounts, the
document's number and kind, and the codes of what it was mapped to.

## What is pushed, and from what

From the **same ledger the export uses** (`salesJournal` in `src/lib/accounting.ts`; each
row carries a stable `ref`), so the numbers cannot differ from the export:

- each paid sale or receipt becomes a **sales invoice** (`ACCREC`, authorised, tax inside
  its line: `LineAmountTypes Inclusive`, the receipt's own tax as `TaxAmount`) **and its
  payment** against the account the way of paying was mapped to;
- each refund or void becomes a **credit note** (`ACCRECCREDIT`, authorised) **and its
  refund** against the same kind of account. A credit note is pushed only once the sale it
  reverses is in Xero; it waits while that sale is still on its way, and is *left out*, not
  guessed, where that sale never will be (from before the start day, or sent to another
  organisation). An invoice already sent is **never edited**: Xero is only ever asked to
  create (`PUT`);
- **stored credit and gift vouchers** are money held for customers, not income, as the
  export says: they are pushed as invoices to a **liability** account the manager chooses
  for them (the mapping refuses an income account for them, and a liability for income), and a
  booking paid from stored credit settles against the account chosen for that way of paying;
- a booking paid with a pass is not pushed (the pass was the sale), as in the export;
  test bookings made before going live are not pushed;
- money is in **cents**, never floats; a document of nothing is not sent.

## The mapping is never guessed

*Mapping* has three lists, filled from the organisation's own accounts and tax rates (read
from Xero on connecting and on *Read accounts and tax rates from Xero*):

- **income by kind of sale** (the journal's categories: court hire, classes, coaching,
  memberships, passes, tournament entries, league fees, game shares, counter sales, hire
  deposits kept and deductions, other) to an account whose class is income; the two held for
  customers to a liability account;
- **tax**: each rate the venue's sales carry (and *no tax*) to a Xero tax type **at that very
  rate** (a 6% sale cannot be mapped to an 8% type; *no tax* needs a 0% type);
- **how it was paid**: cash, QR or e-wallet, bank transfer, card terminal, online, stored
  credit, counter, and *not recorded*, each to a bank account or one Xero accepts payments
  against.

A sale with a part unmapped is **held**: it is listed under *Not sent: needs mapping* with
what it lacks, in words, and sent as soon as it is mapped.

## Reliability

`accounting_queue` (migration 0284) is the outbound queue, like the outbox: one row for
each journal row, unique by `(venue_id, source_ref)` so a sale is queued once whatever
happens. The scheduler (every minute, under the scheduler lease) reads the journal for new
sales (from the connection's start day, re-reading a couple of days back; at most every
five minutes) and sends what is due; *Send now* does the same on request.

- **Steps are kept as they land.** An invoice and then its payment (a credit note, then
  its refund): the invoice's result is stored the moment Xero answers, so a retry resumes
  after it.
- **Idempotent after a crash.** Each step carries Xero's `Idempotency-Key` (a hash of the
  venue, the sale and the step), so a replay of a call whose answer was lost returns the same
  document. If Xero no longer remembers the key, its refusal of a duplicate document number
  is met by looking the document up: it is **adopted only if its reference is ours**; a
  document of the same number that is somebody else's fails the sale for a person. A payment
  Xero refuses because nothing is owing is taken as already recorded.
- **Taken by one process.** A sale is claimed with a short lease before it is sent; two
  ticks at once each take different sales, and one whose taker died is taken again when the
  lease has run out (tested on PGlite and on Postgres).
- **Retries.** A call that could not reach Xero (or a 5xx) is tried again after 2, 4, 8
  … 128 minutes, and after eight tries the sale is *failed* for a person; three in
  a row stop the run (Xero is down). Xero's **refusal** of what was sent (a validation
  error, in Xero's own words with names, addresses and tokens taken out) fails the sale at
  once: sending it again unchanged would not help. A manager sends it again, one or all.
- **Rate limits.** A 429 pauses the venue until the `Retry-After` Xero gave (counted as no
  failure, nothing lost); the panel says when sending resumes.
- **A 401** refreshes the token once and retries; a second refusal, or a refresh token
  that no longer works, marks the connection *needs reconnecting*: nothing is sent, nothing
  is failed, and every sale waits.
- **Told in a day.** If sending has been failing for a day (nothing gets through, the
  connection needs renewing, or a sale has been left failed that long) the venue's managers
  are emailed, in their own language, once a day while it lasts. The export is always
  complete meanwhile.

Statuses: *queued* (waiting, or trying again), *sent*, *failed*, *held for mapping*, *left
out* (a credit note whose sale Xero does not have; what was set aside when disconnected; a
document of nothing). Before the start day nothing is queued at all.

## Earlier sales

Sales before the connection are **not** sent. A manager may choose an earlier first day: the
panel previews **how many documents and what total** (sales less credit notes) would be
queued, and sends nothing until that count and total are confirmed; the server recomputes
them and refuses a confirmation that no longer matches. The same action gives back to the
queue what was set aside when the venue was disconnected. The first day can only move
earlier (at most 800 days back).

## The reconciliation

*Check against Xero* compares, for the days of the report above it, the venue's own totals
(the journal, from the start day, test bookings left out) with what **Xero answered** for
what was sent to the connected organisation: documents, gross and tax, and the days on which
they disagree, with what is waiting, held or failed. It says plainly when they differ and by
how much. A sale that is queued but not yet sent shows as a difference until it is sent.

## Assumed and not verified

These are what the adapter does on Xero's published word and the stand-in cannot show
(`scripts/verify-xero.mjs` checks most of them against a demo company):

- the narrow scopes the install asks for (`accounting.invoices`, `accounting.payments`,
  `accounting.contacts`, `accounting.settings.read`) cover creating invoices, credit notes and
  payments and reading accounts and tax rates, and the contact is matched or made by name when
  sent inline;
- `PUT` creates and `Idempotency-Key` replays an answer, and a duplicate `InvoiceNumber` is
  refused with a validation message that says so;
- Xero uses the `TaxAmount` sent on an inclusive line rather than rounding again, so the
  tax booked is the receipt's;
- a payment can be recorded against a liability account the organisation allows payments to
  (needed for stored credit as a way of paying), and an income-class account is what a
  sales invoice may be coded to;
- a refund is a payment against the credit note;
- `GET /connections?authEventId=` lists only the organisation(s) chosen in this sign-in, each
  sign-in having its own connection;
- the 60-calls-a-minute and 5,000-a-day limits are met by the pause on `Retry-After`.

Known gaps are in [known limitations](../roadmap/known-limitations.md): a booking whose
amount changes after it was sent (its share paid later) is only caught by the reconciliation;
a customer's name is matched to one contact by Xero's own rules, so two customers of the same
name share one; a change of a customer's name is not sent back.

## Verifying against a demo company

What the owner does (nobody else can, and none of it goes in a chat or the repository):

1. Create a Xero developer app (web app, authorization code flow) and add the redirect
   address you will use for the check (any address you can read the `?code=` from, for example
   the install's own callback address).
2. Create a Xero **demo company** (it can be reset; Xero labels it a demo company) and no
   other organisation for this check.
3. Put `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` and `XERO_REDIRECT_URI` in the execution
   environment's secret store, and a file path in `XERO_VERIFY_TOKEN_FILE` (a file in the
   store, mode 0600; the refresh token rotates on every use and is kept there).
4. The one manual step: `node scripts/verify-xero.mjs consent` prints the address to approve the
   app at. Open it signed in to Xero, choose **the demo company only**, allow access; Xero sends
   the browser to the redirect address with `?code=…`; then
   `node scripts/verify-xero.mjs consent --code <the code>` keeps the refresh token in the token
   file. (The code works once, for a few minutes.)
5. `node scripts/verify-xero.mjs` (or `check`) now runs without a person.

`check` refuses, before it creates anything, an organisation Xero says is not a demo company,
and one Xero does not label unless `XERO_VERIFY_DEMO_COMPANY_ONLY=yes` is set. It then
runs the adapter (the code the push uses, not a copy) through: the refresh and its rotation,
the scopes granted, exactly one organisation reached, reading the lists, an invoice with the tax
inside (Xero's total and tax compared with what was sent, to the cent), the same invoice sent
again under the same key, a second of the same number refused, finding it by number, its payment
and its settling, a credit note and its refund. Each step is recorded as passed or failed on its
own evidence in `artifacts/integrations/xero-<time>.json`; nothing is recorded as passed unless it
passed, and the result is `BLOCKED` (naming what is missing), `FAIL`, `PARTIAL` or `PASS`. It
leaves the documents in the demo company (Xero does not let a paid document be deleted). It does
not and cannot prove 429 handling under real load, a 401 in the middle of a run, or Xero's daily
limit: those stay proven only against the stand-in.

A `PASS` is what moves the integration's row in feature status from stand-in tests to a recorded
live check on a demo company, with the date. It is not a check of any real venue's books.
