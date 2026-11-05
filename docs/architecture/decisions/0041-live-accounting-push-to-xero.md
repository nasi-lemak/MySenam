# ADR 0041: Live accounting: a venue's sales pushed to Xero, optional, behind a provider interface

- **Status:** current, decided 2026-11-05 (the owner asked for live accounting integration, Xero first). Built in
  migration 0284. How it is set up and what it does is [Xero](../../integrations/xero.md); what is sent and the privacy
  position is [privacy](../privacy.md#live-accounting-push). The integration stays `INTEGRATION_VERIFICATION_REQUIRED`:
  only a stand-in has been exercised.
- **Context:** the accounting export ([reporting](../../features/reporting.md)) is a
  file an accountant imports by hand into SQL Account, AutoCount, Xero or QuickBooks. A venue on Xero wants its sales
  there as they happen. The risks are: a sale sent twice or not at all; numbers that differ from the export; a customer's
  or a child's details leaving the country by default; a stored token that leaks; a guess at which Xero account income
  belongs in; and a connection that fails quietly for weeks.
- **Decision:**
  - **Optional, per venue, off by default, and only where the install allows it.** The install sets
    `ACCOUNTING_PUSH_APPROVED` (the pattern of `OFFSITE_TRANSFER_APPROVED`: Xero keeps data outside the country, so the
    transfer is a declared and approved path, never a default) and registers its own Xero app
    (`XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`). A venue's manager connects the venue's **own**
    organisation by OAuth 2.0 authorization code with PKCE, after ticking that the venue has read what is sent and where it
    is kept; who, when and which wording are recorded (`NOTICE_VERSION`). The app does not judge whether the transfer is
    lawful.
  - **A provider interface, one adapter.** `src/lib/accounting-provider.ts` is what a package must do (sign-in, refresh,
    revoke, chart, invoice, payment, credit note, refund, lookup by number); `src/lib/xero.ts` is the only adapter.
    QuickBooks Online has the same shape and can be a second adapter; it is **not built**. SQL Account and AutoCount have
    no common cloud API and stay on the export, which stays as it is and is the fallback.
  - **The same ledger as the export, never a second one.** The push reads `salesJournal` row for row (each row now has a
    stable `ref`), so a sale's number, amount, tax and category are the export's. Test bookings and bookings paid with a
    pass are not pushed, as in the export. **Stored credit and gift vouchers are liabilities**, as the export marks them:
    they go to a liability account the manager chooses, and the mapping refuses an income account for them and a liability
    for income.
  - **Invoice and payment; credit note and refund; never an edit.** A paid sale is a sales invoice (authorised, tax inside,
    the receipt's own `TaxAmount`) and its payment; a refund or void is a credit note and its refund. Xero is only asked to
    create. A credit note waits for the sale it reverses and is set aside, not guessed, where that sale is not in this
    organisation.
  - **Nothing guessed.** Income by kind of sale, each tax rate (to a Xero tax type at that very rate) and each way of paying
    (to an account that accepts payments) are the manager's mapping, each checked against the organisation's own chart. A sale
    with a part unmapped is held and listed, and goes when it is mapped.
  - **A queue, like the outbox.** `accounting_queue`, unique by `(venue_id, source_ref)`; steps kept as they land;
    Xero's `Idempotency-Key` plus the document's number (adopted only where its reference is ours) make a replay after a
    crash harmless; a claim with a lease so two ticks never send the same sale; exponential backoff to a cap; a 429 pauses the
    venue until `Retry-After`; a 401 refreshes once and then asks for a reconnect without failing anything; a refusal fails
    the sale for a person, in Xero's words with names, addresses and tokens removed; the venue's managers are emailed when it
    has been failing for a day.
  - **Minimal personal data.** The contact is the account holder's name and email, read at the moment of sending and never
    stored; a customer with no account is one `Walk-in customers` contact; **never a child** (accounts are adults'; a child's
    sale is under the account that paid; the receipt's own customer name is not used), no phone number, and a line says what
    kind of sale and never whom it was for. The queue and connection hold amounts and numbers only.
  - **Tokens are sealed** with the key that locks the payment gateways' keys (`src/lib/secrets.ts`), refresh tokens rotate
    under a lease so one process spends each, and disconnecting gives the grant back at Xero and empties both columns.
  - **Sales before the connection are not back-filled** unless a manager picks an earlier first day and confirms a preview
    of the count and total, which the server recomputes and refuses if changed.
  - **A reconciliation says plainly when the books differ:** the ledger's totals against what Xero answered for what was
    sent, with the days that differ.
  - **No webhooks and no two-way sync.** The only things read from Xero are the chart of accounts and tax rates, for the
    mapping screen, and the organisation's name, currency and demo flag when connecting.
- **Alternatives considered:**
  - *Push from the payment gateways' events:* two sources of truth for money; numbers could differ from the export.
  - *A second ledger table:* the journal already is the sales ledger; a copy would drift.
  - *Guess the account from the category:* wrong books silently; the mapping is the venue's accountant's decision.
  - *Store the contact in the queue:* a customer's name would outlive an erasure; read at the moment of sending, nothing to
    erase.
  - *Edit a sent invoice on a void or refund:* history is rewritten in the books; a credit note is how accountants do it.
- **Consequences:** a venue that connects has its sales in Xero within minutes, or a plain statement of why not and a way to
  mend it; the export is unchanged. The adapter is written from Xero's published API and is unverified until
  `scripts/verify-xero.mjs` has passed against a demo company. Known gaps (a booking whose amount changes after it was sent
  is caught only by the reconciliation; two customers of the same name share one Xero contact) are in
  [known limitations](../../roadmap/known-limitations.md).
