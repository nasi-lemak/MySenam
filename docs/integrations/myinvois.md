# E-invoicing in Malaysia (LHDN MyInvois)

Not yet verified against the MyInvois sandbox or production; see [feature status](../product/feature-status.md).

> **Not yet tried against LHDN.** This is written from LHDN's published API
> and sample documents, and tested against a pretend MyInvois
> (`tests/myinvois.test.ts`). Before a venue uses production, run it in
> LHDN's sandbox (pre-production) and check the documents there. Whether a
> venue must e-invoice at all, and from when, depends on its turnover and on
> thresholds LHDN has changed more than once: that is for the venue and its
> accountant, and the settings panel says so.

A venue turns it on under *Venues & staff → E-invoicing* (managers only;
Malaysian installs only), with its TIN, business registration number, MSIC
code, registered name, address and contact details (`einvoice_settings`,
migration 0056). It starts in sandbox; production is a separate tick, with a
warning that documents cannot be withdrawn after 72 hours.

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
  Managers can send it sooner with *Send last month now*.
- **Credit notes**, by the e-invoice that carried what they reverse: the
  month's consolidated one, or a customer's own, as consolidated credit notes
  (`CCN-2026-11-CON-2026-10`) naming it by LHDN's UUID. A credit note waits to
  be sent until what it corrects has been accepted. Reversing a sale from
  before e-invoicing was on sends nothing.
- **A customer's own.** A paid receipt shows *Need an e-invoice?* while its
  month has not been consolidated. The customer gives a name, TIN (an
  individual without one uses `EI00000000010` and their IC number), ID,
  email, phone and address, with a warning that it goes to LHDN at once in
  that name and cannot be edited. It is sent straight away
  (`POST /api/receipts/einvoice`, behind the receipt's signed link),
  classification 022, and left out of the consolidated one. The receipt then
  says where it stands and, once valid, links to LHDN's public page.
- Each document is UBL 2.1 JSON, version 1.0 (no digital signature), built
  when it is sent so it carries the venue's details as they are then, base64
  with its SHA-256. Tax category 02 (service tax) where the venue charges
  SST, else 06 (not applicable).
- **Afterwards**, every tick asks LHDN about those sent and not yet decided:
  *Valid* (with the link) or *Invalid* (with LHDN's reasons). One that LHDN
  refused or found invalid is listed with why; *Send again* sends it once the
  venue has put it right.

- **A single sale over RM10,000** may not be consolidated: at month end it
  gets its own e-invoice (`EI-<receipt number>`), made out to the general
  public unless the customer already asked for one in their name, and is
  left out of the consolidated one.

Not covered: cancelling a document within LHDN's 72 hours is done in the
portal; sales recorded outside MySenam are not included.
