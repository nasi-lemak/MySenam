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

- **Each month, consolidated.** In each venue's first seven days of a month,
  the scheduler writes last month's sales down as one e-invoice to the
  general public (`CON-2026-10`, buyer TIN `EI00000000010`, classification
  004): a line for each kind of sale (court hire, classes, coaching, passes,
  memberships, credit…) and tax rate, saying how many receipts and which.
  Which receipts it carried is stored with it when it is sent (`covers`).
  Managers can send it sooner with *Send last month now*.
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
| Not sent (`failed`) | The venue's details were incomplete, nothing was left to send, or MyInvois could not be reached | Nothing | *Send*: the same draft, once put right |
| Refused by LHDN (`rejected`) | LHDN refused it when it was sent | Submission ID, LHDN's reasons as given | *Send a replacement* |
| Sent, being validated (`submitted`) | LHDN accepted it for validation | Submission ID, UUID | *Check with LHDN*, *Ask LHDN again* |
| Valid (`valid`) | LHDN validated it | Submission ID, UUID, long ID (the public link) | *Ask LHDN again* (records a cancellation made in the portal); a sale reversed after this goes in a credit note against it |
| Invalid (`invalid`) | LHDN validated it and found it invalid | Submission ID, UUID, LHDN's reasons as given | *Send a replacement* |
| Cancelled at LHDN (`cancelled`) | LHDN reported it cancelled (done in the portal) | As it had | *Send a replacement* |

How a state changes: a draft is sent (to `submitted` or `rejected`) or fails
(`failed`, sent again as it is); LHDN's verdict moves `submitted` to
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
  (`runEInvoicing`), made out to the general public (TIN `EI00000000010`,
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
