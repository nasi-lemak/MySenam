# E-invoicing in Malaysia (LHDN MyInvois)

Not yet verified against the MyInvois sandbox or production; see [feature status](../product/feature-status.md).

> **Not yet tried against LHDN.** This is written from LHDN's published API
> and sample documents, and tested against a pretend MyInvois
> (`tests/myinvois.test.ts`, `tests/einvoice-records.test.ts`). Before a
> venue uses production, run it in LHDN's sandbox (pre-production) and check
> the documents there. Whether a venue must e-invoice at all, and from when,
> depends on its turnover and on thresholds LHDN has changed more than once:
> that is for the venue and its accountant, and the settings panel says so.
> The LHDN rules MySenam follows are listed under
> [what is assumed and not verified](#what-is-assumed-and-not-verified).

A venue turns it on under *Venues & staff → E-invoicing* (managers only;
Malaysian installs only), with its TIN, business registration number, MSIC
code, registered name, address and contact details (`einvoice_settings`,
migration 0056). It starts in sandbox; production is a separate tick, with a
warning that MySenam never changes a document once sent and that
cancelling is done in the MyInvois portal within LHDN's window. E-invoice
lines never name people ([below](#names-in-what-is-sent)), and e-invoice
records are kept for the statutory period
([privacy](../architecture/privacy.md#e-invoice-records)).

How MySenam reaches MyInvois (`src/lib/myinvois/client.ts`):

- **With the venue's own ERP client**, registered in the MyInvois portal: its
  client ID and secret, the secret sealed like a payment key and never shown
  again; or
- **as the venue's intermediary**, with the platform's own client
  (`MYINVOIS_CLIENT_ID`, `MYINVOIS_CLIENT_SECRET`) and the venue's TIN in the
  `onbehalfof` header, once the venue has named the platform as an
  intermediary in the portal. Offered only when those are set.

*Test connection* signs in with them. What is sent (`src/lib/myinvois.ts`,
`src/lib/myinvois/ubl.ts`):

- **Each month, consolidated.** From the first day of a month the scheduler
  (`runEInvoicing`) writes last month's sales down as one e-invoice to the
  general public (`CON-2026-10`, buyer TIN `EI00000000010`, classification
  004): a line for each kind of sale (court hire, classes, coaching, passes,
  memberships, credit…) and tax rate, saying how many receipts and which.
  Which receipts it carried is stored with it when it is sent (`covers`).
  Managers can send it sooner with *Send last month now*. It is not a single
  attempt in the first seven days: until the month's own end any run that finds
  last month not yet consolidated makes it (every run in the first seven days;
  after that once an hour, and only for a venue that was already e-invoicing
  before the month began, so a venue that has just switched e-invoicing on is
  not sent last month's earlier sales unasked), idempotently by its number
  (`CON-2026-10`), so an outage of the scheduler or of MyInvois in the first week
  no longer loses the month. A month more than one back is never made by
  itself. One venue's failing step (a fault in its journal) is recorded as an
  alert for the platform's owner and told to that venue's staff, and every
  other venue carries on in the same run
  ([ADR 0055](../architecture/decisions/0055-reports-reconcile-with-the-journal-and-einvoicing-keeps-going.md);
  `tests/einvoice-resilience.test.ts`).
- **A late one is marked.** A consolidated e-invoice (or its credit notes) sent, or still to be sent,
  after the seventh day of the month following its period shows *Late: after <date>* beside its status
  (`late`, `lateAfter` on each e-invoice in the list). Only a marker, for staff and the adviser: nothing
  is done differently for it, and LHDN's sources say what the seven days are but not what follows a late one
  (audit G15).
- **Credit and gift vouchers are an open tax question** (audit C2, DEC-19). The consolidated one
  carries a credit top-up or a voucher's sale *and* the bookings paid from it, so it can report more
  than was sold; whether and when prepaid value is e-invoiced is for the venue's adviser
  ([memo](../operations/einvoice-stored-credit-memo.md)). Meanwhile switching e-invoicing on at a venue
  that has sold stored credit or a gift voucher is refused unless its manager ticks that they understand
  (`acknowledgeStoredValue` on `POST /api/admin/einvoicing`; the settings screen explains); that is
  written to the activity log. A venue already on is not switched off, and nothing is excluded from
  the e-invoice on a guess.
- **Credit notes**, by the e-invoice that carried what they reverse: the
  month's consolidated one, or a customer's own, as consolidated credit notes
  (`CCN-2026-11-CON-2026-10`) naming it by LHDN's UUID. A credit note waits
  to be sent until what it corrects is valid at LHDN, and names the
  replacement where one was sent in its place. Reversing a sale from before
  e-invoicing was on sends nothing.
- **A customer's own.** A paid receipt shows *Need an e-invoice?* while its
  month has not been consolidated. The customer gives a name, TIN (an
  individual without one uses `EI00000000010` and their IC number), ID,
  email, phone and address, with a warning that it goes to LHDN at once in
  that name and cannot be edited. It is sent straight away
  (`POST /api/receipts/einvoice`, behind the receipt's signed link),
  classification 022, and left out of the consolidated one. The receipt then
  says where it stands and, once valid, links to LHDN's public page. Where
  LHDN refused it or found it invalid (or it was cancelled), and nothing was
  sent in its place, the receipt offers the form again while the month is
  open, so a customer whose details were wrong can give the right ones.
- **A single sale over RM10,000** is not consolidated: at month end it gets
  its own e-invoice (`EI-<receipt number>`), made out to the general public
  unless the customer already asked for one in their name, and is left out
  of the consolidated one whatever LHDN makes of it.
- **Test bookings** made before the venue went live
  ([marketplace](../product/marketplace.md#test-bookings-before-going-live)):
  their receipts and the credit notes reversing them are left out of the
  consolidated e-invoice and the consolidated credit notes alike (no sale was
  made), though the sales journal lists them, marked. A test with a payment on
  it cannot stand when the venue goes live (cleared with the manager's
  answer, or kept as real first), and a payment arriving once the venue is
  live makes it a real sale at once (migration 0259), so what is taken is
  never left out of what goes to LHDN: at a venue that is live a test still
  standing with a payment on it (one made before that trigger existed) goes in
  too, as any sale does. One kept as a real
  booking before its month is consolidated goes in it as any sale; once the
  month has gone, it stays a test. Whether a receipt printed in a test needs
  anything at LHDN is the venue's adviser's question, not settled here.
- Each document is UBL 2.1 JSON, version 1.0 (no digital signature), built
  when it is sent so it carries the venue's details and the receipts as they
  are then, base64 with its SHA-256. Tax category 02 (service tax) where the
  venue charges SST, else 06 (not applicable).
- **Afterwards**, every tick asks LHDN about those sent and not yet decided:
  *Valid* (with the link), *Invalid* (with LHDN's reasons) or *Cancelled*.

## States and what never changes

Each document is a row of `e_invoices`. Its state, and what staff can do
with it on the screen, which offers only what the server allows (the list
says each one's `actions`; `POST /api/admin/einvoicing` refuses anything
else):

| State | What it means | What it holds from LHDN | What staff can do next |
| --- | --- | --- | --- |
| Waiting to send (`pending`) | Written down, not sent: a draft | Nothing | Nothing: the scheduler sends it. A credit note says which document it waits for |
| Not sent (`failed`) | It certainly did not reach LHDN: the venue's details were incomplete, nothing was left to send, MyInvois refused the sign-in, could not be connected to, or answered that it took nothing (a 4xx, or 503) | Nothing | Nothing needed: MySenam tries it again by itself (15 minutes after the first failure, then 30, 60, 120, 240 and every 6 hours, `retryNotSent`), each try on its history, and sends it once the cause is gone. Each failure alerts the platform's owner and tells the venue's staff (again only when the owner is told again, every 6 hours). *Send* sends it at once, once put right |
| Needs verification: submission outcome unknown (`failed`, `outcomeUnknown`, state `unknown`) | MySenam asked LHDN and never recorded its answer, so LHDN may hold the document: the claim went stale (a sender stopped), or the request timed out, was cut after it went out, or was answered with something unreadable or a gateway or server error ([sending once](#sending-once)) | Nothing recorded; the attempt's payload is kept with the claim | *LHDN has it* (record its identifiers: LHDN is asked and must confirm the document is this one), or, once the manager has checked the portal, *LHDN does not have it, send again*. Never sent again by itself |
| Refused by LHDN (`rejected`) | LHDN refused it when it was sent | Submission ID, LHDN's reasons as given | *Send a replacement* |
| Sent, being validated (`submitted`) | LHDN accepted it for validation | Submission ID, UUID | *Check with LHDN*, *Ask LHDN again* |
| Valid (`valid`) | LHDN validated it | Submission ID, UUID, long ID (the public link) | *Ask LHDN again* (records a cancellation made in the portal); a sale reversed after this goes in a credit note against it |
| Invalid (`invalid`) | LHDN validated it and found it invalid | Submission ID, UUID, LHDN's reasons as given | *Send a replacement* |
| Cancelled at LHDN (`cancelled`) | LHDN reported it cancelled (done in the portal) | As it had | *Send a replacement* |

How a state changes: a draft is sent (to `submitted` or `rejected`) or fails
(`failed`, sent again as it is; or `failed` with its outcome unknown, which
staff settle first); LHDN's verdict moves `submitted` to
`valid`, `invalid` or `cancelled`, and `valid` to `cancelled`. Nothing else
moves a document that reached LHDN.

**What never changes.** Once a document has reached LHDN (it holds a
document, a submission ID or a UUID: `rejected`, `submitted` and after), its
stored payload, lines, buyer, total, the receipts it covered, its number,
LHDN's submission ID, UUID and long ID, what it corrects and when it was
sent stay as they are, and it is never deleted. The database refuses
anything else (trigger `e_invoices_sent_frozen`, migrations 0220 and 0226),
whichever path tries: clearing names from a receipt, the receipts' retention
rule, an erasure, a refund, a withdrawal or coach change (they make receipts
and credit notes, never touch `e_invoices`), a retry or a check. Only LHDN's
verdict, its reasons, the long ID (set once) and when LHDN was last asked
move on. The one exception is the end of the statutory period: the
retention run then clears the stored payload, the buyer's details and
LHDN's reasons, once, and keeps the rest as a tombstone for the books
([privacy](../architecture/privacy.md#e-invoice-records)); a tombstone is
shown as such and nothing more is done with it. A draft
venue holding an e-invoice is not deleted by the stale-draft clean-up
(`src/lib/drafts.ts`). Shown by `tests/einvoice-records.test.ts`.

**A correction is a new document**, linked to what it corrects:

- **A replacement**, for one LHDN refused, found invalid or reported
  cancelled: *Send a replacement* makes a new document under its own number
  (`CON-2026-10-R2`, then `-R3`), linked to the one it replaces
  (`replaces_id`), its lines drawn afresh from the receipts. The one replaced
  stays as it was sent, with LHDN's identifiers and reasons, and says what
  replaced it; each is replaced once. Lookups by the first number (the
  month's consolidated one, what a credit note corrects) follow the series
  to the latest. A customer's own is not replaced once its sale has gone to
  LHDN in the month's consolidated e-invoice since (it would be invoiced
  twice; a consolidated one sent before migration 0220 did not record its
  receipts, so its month counts as carrying the sale), nor once the
  customer has asked for another; a replacement carries the buyer details
  the customer gave, so wrong ones are put right by the customer asking
  again.
- **A credit note**, for a sale reversed after its e-invoice was sent (a
  refund, a late cancellation's share, a place taken off): see above. A
  credit note is a document like any other and is replaced the same way.
- **Cancelling** is not done through MySenam: the venue cancels in the
  MyInvois portal within LHDN's window, then *Ask LHDN again* records it
  as cancelled. MySenam does not issue debit notes (an amount under-invoiced)
  or refund notes.

**A draft follows its receipt.** A document is built when it is sent, from
the receipts as they are then: *Send* on one that failed sends the receipt
as it now is.

### Sending once

A draft reaches LHDN once, however many senders take it at the same moment:
the scheduler sending what waits, staff pressing *Send*, a customer's own
request sending it at once, or the same run on two servers. Just before
LHDN is asked, the sender claims the draft (`sending_at`, migration 0256)
in one statement that only succeeds on a waiting draft nobody has claimed;
the one that claims it sends it, and any other leaves it and shows it as it
stands. The claim is cleared when LHDN's answer, or the failure, is written,
as a refund is claimed before the gateway is asked (`submitOne` in
`src/lib/myinvois.ts`; `tests/einvoice-sending.test.ts`, against a pretend
MyInvois that holds the first submission while the second sender tries, on
PGlite and Postgres).

### An unknown outcome is not "not sent"

The owner's decision of 29 October 2026: "Interrupted MyInvois submissions:
Keep the no-blind-resubmission policy. However, where the outcome is unknown,
display 'Needs verification' or 'Submission outcome unknown', not a
definitive 'Not sent'. Staff should reconcile against LHDN before retrying,
using available provider identifiers and status information. Preserve the
history of the attempt."

A claim still set 15 minutes later (`SENDING_CLAIM_MINUTES`; LHDN is given
30 seconds to answer) means the sender stopped between asking LHDN and
writing its answer down, so LHDN may have the document. So does a submission
that was sent and then timed out, was cut off, or was answered with
something MySenam cannot read or with a gateway or server error that does
not say what was done (`mayHaveReachedLhdn` in `src/lib/myinvois/client.ts`).
None is *Not sent*: each is **Needs verification: submission outcome
unknown**. A failure that certainly did not reach LHDN stays *Not sent*:
incomplete details, nothing to send, a sign-in LHDN refused (MySenam signs in
before it claims the draft), no connection (refused, no such host, no
route), or LHDN answering that it took nothing (a 4xx, or 503). A document
LHDN answered with identifiers is never relabelled.

The row keeps `status = 'failed'`, so every reader that treats a failed
draft as a draft still does, and adds (migration 0260) `outcome_unknown_at`
(when it was found), `last_attempt_at` (the claim's own start, kept when the
claim is cleared) and `attempt_payload` (the document, total, covered receipts
and what it corrects, as built when the attempt was claimed). A row marked
under migration 0256's wording (error `SENDING_INTERRUPTED`) is migrated and
also derived as unknown; its claim time was not kept, and nor was its payload.
The list says `state` and `outcome` are `unknown`, with `outcomeUnknown`,
`outcomeUnknownAt`, `lastAttemptAt` and the `history`; the staff screen shows
the badge *Needs verification*, the document number to look for in the
portal, when the attempt began, and the two choices below; the customer's
receipt says the venue is checking with LHDN whether it arrived. The venue's
managers and staff are told once, each in their own language
(`tellVenueStaffEach`), when a document becomes unknown. The retention run
never deletes one as a draft LHDN never had
([privacy](../architecture/privacy.md#e-invoice-records)).

Never sent blindly, enforced by the server:

- **The scheduler never sends it**, as before.
- **`POST /api/admin/einvoicing` `retry` on one is refused (`409`) unless the
  body carries `notAtLhdn: true`**: the manager's word that they checked the
  MyInvois portal and LHDN does not hold it. The word is kept with who gave it
  in the document's history (`confirmed_not_at_lhdn`) and the staff activity
  log (*Confirmed in the MyInvois portal that LHDN does not hold an
  e-invoice, and sent it again*), the unknown mark is cleared, and the draft
  is sent once, as for any other. The screen asks for a confirmation first.
- **`record`: LHDN has it.** Staff give the submission ID and/or the document
  UUID the portal shows. MySenam asks LHDN for the submission (the documents it
  holds under it) or the document (its details) with the venue's own
  credentials, read-only, and records the identifiers only when LHDN says the
  document under them carries this document's number (its internal ID) and,
  where both were given, that they belong together, and no other e-invoice
  here holds the UUID. It then stands as sent (`submitted`, with the payload,
  total, covers and what it corrects as kept at the claim, and the claim's
  start as its sent time), moves on as *Ask LHDN again* does (valid, invalid or
  cancelled), and the sent-frozen trigger holds it. A mismatch, a number LHDN
  does not hold, a lookup that fails or something that is no identifier
  changes nothing and says why. A row marked before migration 0260 kept no
  payload: it then holds LHDN's identifiers only. MySenam does not look a
  document up by its own number alone: LHDN's published API has no such lookup
  that was relied on here.

Both are manager-only, as the whole route is (`MANAGER_ONLY`).

**History.** Every attempt is a row of `e_invoice_attempts` (migration 0260,
append-only: a trigger refuses any edit or delete, but for the cascade when a
draft that never reached LHDN, and was never in doubt, is deleted by the
retention run): `claimed`, `sent`, `rejected`, `not_sent`, `outcome_unknown`,
`confirmed_not_at_lhdn` and `recorded_from_portal`, each with when and, for a
staff step, who. The document's detail shows it.

Shown by `tests/einvoice-sending.test.ts` and
`tests/einvoice-records.test.ts` (a stand-in MyInvois, PGlite and Postgres);
none of this has been checked against the real service.

### Names in what is sent

The owner's decision of 28 October 2026: "Omit unnecessary participant and
coach names from e-invoice descriptions, while retaining legally required
information." No line of a document sent names anybody: a consolidated
one's say the kind of sale, the month and the receipt numbers; a
customer's own, and a large sale's, say the receipt's number and the kind of
sale as the books class it (`Receipt R-000012: memberships`,
`Receipt BK-7Q2M: coaching`), whatever the receipt's own lines say about
whom it was for (a child's place, a family membership's children) or who
coached. This holds on every path: court hire, lessons, classes,
memberships, passes, counter sales, credit notes.

The **buyer's own details** on a customer's own e-invoice (name, TIN, ID
number, SST number, email, phone, address) are what LHDN requires of a
buyer, and stay, in the document and in `e_invoices`; the venue's own
details stay as the supplier's. The *Leave people's names out* setting of
migration 0220 is retired (migration 0225 keeps its column, unread): there
is no case for naming a participant or a coach in a line, as the receipt
number links the e-invoice to the receipt that says more. A document sent
before keeps what it said, at LHDN and in its copy here, until the
statutory period ends. Shown by `tests/einvoice-retention.test.ts` and
`tests/einvoice-records.test.ts`.

## What is assumed and not verified

Each of these is read from LHDN's published guidance, API documentation or
samples as they stood when the code was written, marked `UNVERIFIED` in the
code where it is used, and has not been checked against the MyInvois
sandbox or LHDN's current guidance. None is presented to staff as settled:

- the consolidated e-invoice sent in the first seven days after the month
  (`runEInvoicing`; LHDN's FAQ, question 38, and Specific Guideline v4.9, section 3.6.2,
  both read on 7 November 2026, say "within seven (7) calendar days after the month
  end", and say nothing on what follows a late one; made late, after the seventh day,
  where an outage or a failure stopped it, it is marked *Late* and otherwise treated
  as any other, which LHDN may treat differently: for the venue's
  adviser), made out to the general public (TIN `EI00000000010`,
  state 17) with classification 004, and consolidated credit notes made the
  same way;
- a single sale over RM10,000 kept out of the consolidated one
  (`CONSOLIDATION_LIMIT`);
- an individual without a TIN using `EI00000000010` with their IC number;
- document version 1.0 without a digital signature, the UBL JSON shape,
  classification 022, tax types 02 and 06, the state codes
  (`src/lib/myinvois/ubl.ts`);
- the API's paths, fields and statuses, including how a refusal at
  submission and a cancellation are reported (`src/lib/myinvois/client.ts`);
- the two read-only lookups behind *LHDN has it*: get document details
  (`GET /api/v1.0/documents/{uuid}/details`, whose `internalId` and
  `submissionUid` are matched to our number) and get submission
  (`GET /api/v1.0/documentsubmissions/{submissionUid}`, whose
  `documentSummary` lists each document's `uuid` and `internalId`); that a
  found document can be matched by `internalId` alone; and which failures
  leave LHDN possibly holding a document (a timeout, a cut connection, an
  unreadable answer, a 5xx other than 503) as against certainly not (no
  connection, a 4xx, 503): all written from the published API and tested
  against a stand-in only;
- whether LHDN accepts a document's number again after it refused it or
  found it invalid: MySenam does not rely on it either way, as a
  replacement always has its own number;
- the 72-hour cancellation window, which the screens attribute to LHDN and
  mark as not verified;
- how long e-invoice records must be kept (7 years from issue by default,
  provisional pending legal verification:
  [privacy](../architecture/privacy.md#e-invoice-records)), and that a
  tombstone of number, dates, total, covered receipts and LHDN's identifiers
  is enough after it.

A credit note waiting until what it corrects is valid is MySenam's own order
of things, not an LHDN rule.

Not covered: cancelling or rejecting a document through MySenam; debit and
refund notes; editing a buyer's details once given; sales recorded outside
MySenam.
