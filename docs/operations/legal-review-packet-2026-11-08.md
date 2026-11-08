# Legal and tax review packet for the restricted pilot, 8 November 2026

A packet the owner can hand to a Malaysian lawyer and, for the last part, to the venue's tax adviser **before the
restricted pilot takes a real customer**. It is **not legal or tax advice** and settles nothing. Every item says what the
product does today (with the code or document it comes from), the question the software does **not** answer, which
documents hold the detail, what each plausible answer would mean for the business, and whether the affected feature can
simply stay off for the pilot. It states no legal conclusion; where a document gives a view, that view is the operator's
working analysis, not an answer. Facts are as of the baseline commit `8899dc0`; nothing here was checked against a real
provider, a lawyer or an adviser.

The pilot is one to three staffed venues in Malaysia, counter payments first, online payment only after Billplz's sandbox
check passes, email as the only customer channel ([pilot readiness](pilot-readiness-2026-11-07.md)). The pilot's own
verdict there is *not yet*; the rows marked *Blocked pending verification* for "Privacy and legal documents" and
"Backups and restore" are what this packet is for.

**Status of every item below: NOT REVIEWED.** No lawyer or tax adviser has reviewed any of it. Nothing in this packet is
recorded as resolved, and the code treats no legal question as settled.

## How to read an item

Each item gives, in this order: **(1)** what the product does today; **(2)** the question needing review;
**(3)** the documents; **(4)** what each plausible answer would mean for the business (a consequence for the product or
operation, never a legal view); **(5)** whether the feature can simply stay disabled for the pilot. Where the repository
holds no alternative to describe, item 4 says so rather than inventing one.

## The items

| ID | Subject | Status | Can it simply stay off for the pilot? |
| -- | ------- | ------ | ------------------------------------- |
| L1 | Terms of service | NOT REVIEWED | No: a launch blocker |
| L2 | Privacy notice | NOT REVIEWED | No: a launch blocker |
| L3 | Venue and customer responsibilities; who is controller and processor | NOT REVIEWED | No |
| L4 | Payment and refund handling | NOT REVIEWED | Online payment: yes. Counter handling: no |
| L5 | Stored credit, passes, memberships, vouchers | NOT REVIEWED | Not by a switch; by the venue not selling them |
| L6 | Manual venue closure and suspension | NOT REVIEWED | No (a suspension is the owner's act; closure is by hand) |
| L7 | Data retention periods | NOT REVIEWED | No |
| L8 | Account erasure | NOT REVIEWED | No |
| L9 | Backups held abroad (Backblaze B2, US) | NOT REVIEWED | Yes, but then real customer data must not be held |
| L10 | Data-breach notification | NOT REVIEWED | No |
| L11 | Processors and provider relationships | NOT REVIEWED | Per provider: see the table |
| L12 | Cancellation terms and their historical snapshots | NOT REVIEWED | No |
| L13 | Liability for unavailable venues | NOT REVIEWED | No |
| L14 | Youth functionality | NOT REVIEWED | Yes: disabled |
| L15 | MyInvois treatment of stored value (audit C2) | NOT REVIEWED, **UNRESOLVED**, for the tax adviser | Yes: e-invoicing is disabled |
| L16 | The venue's other tax treatments the app suggests | NOT REVIEWED, for the tax adviser | No: provisional markers stay on |

---

## L1. Terms of service

1. **Today.** `/terms` (`src/app/terms/page.tsx`) is a draft "written to match what the software actually does", not
   legal advice. It is English only; Malay, Chinese and Tamil readers get a line saying the terms are in English. The
   operator's name, registration, address and email come from `OPERATOR_NAME`, `OPERATOR_REG_NO`, `OPERATOR_ADDRESS` and
   `OPERATOR_EMAIL`; until `OPERATOR_NAME` is set the page says it has not been completed. It covers: who runs the
   service; booking (free cancellation up to the time each venue sets, after which the venue may keep any payment and
   record a no-show against the phone number; a venue may cancel and then owes back what was paid); paying (at the
   counter, or online "directly into the venue's own account; we do not receive or hold them"; refunds of online payments
   by the venue; credit is not a bank deposit and earns no interest); the venue's own rules; who is responsible if
   something goes wrong (the venue for its premises, the operator for the booking service; rights that cannot be taken
   away are kept); for venues (joining, monthly listing fee once the owner sets one, customers' money, customer details,
   30 days' notice to leave, a copy of bookings on leaving); governing law, read from the install's country
   (`src/lib/region.ts`: "the laws of Malaysia", the Consumer Protection Act 1999, the Personal Data Protection Act
   2010). I found no place where a customer is asked to accept `/terms` or `/privacy` when registering or booking: the
   links are in the footer and the sitemap, and a venue applicant is told that applying means agreeing to the venue
   section (`src/app/list-your-venue/ApplyForm.tsx`). What a customer *is* shown at booking is the venue's cancellation
   terms (`src/components/BookingTermsNotice.tsx`), and for a signed-in customer the version they dismissed is recorded.
2. **Question.** Whether these terms are adequate and enforceable for the pilot, including: the English-only wording for
   Malay, Chinese and Tamil readers; whether and how a customer must be shown or made to accept them; the wording on
   keeping payments after late cancellation and on recording no-shows against a phone number; the venue section
   (fees, 14-day invoices, hiding an overdue venue, 30 days' notice); and who the contracting company is.
3. **Documents.** [Marketplace](../product/marketplace.md#running-the-marketplace) (terms), [known limitations](../roadmap/known-limitations.md#blockers-for-any-launch)
   (a blocker for any launch), [launch providers](../integrations/launch-providers.md#operating-company-and-jurisdictions)
   (the operating company is not decided).
4. **Consequences.** *Acceptable as drafted:* only the operator details need setting. *Needs changes:* the page is
   configuration and text, so wording changes are cheap; a requirement to **record each customer's acceptance** would
   need new product work (none exists today); translations would need native review as well (known limitations,
   *Languages*). If the operating company is not yet decided, the terms cannot name it and the pilot cannot honestly open.
5. **Can it stay off?** No. The page is public and linked; the launch gate is a reviewed text with the operator named.

## L2. Privacy notice

1. **Today.** `/privacy` (`src/app/privacy/page.tsx`, text in the four customer dictionaries) lists what is held and why
   (name and phone, email, payments, arrivals, door codes, inductions, stored credit and passes, messages sent), how long
   (the figures come from `RETENTION` in `src/lib/privacy.ts` so they cannot drift from what is pruned), who can see it
   (the venue; other players where a customer takes part; nobody else, no advertising or analytics service), and what
   a person can do (download a copy from the account page, ask the venue to correct, close the account, book as a guest).
   It says copies can stay in backups until they expire and are erased again after a restore. It names a contact only
   when `OPERATOR_NAME` and `OPERATOR_EMAIL` are set, and it says on the page that no lawyer has checked it or its
   translations. It **does not name** the country the off-site backups are held in, that they are encrypted, or the
   providers that process data (the privacy document says the notice and venue agreements *should* name the country, the
   retention of about 15 days and the encryption: [backups held abroad](../architecture/privacy.md#backups-held-abroad),
   step 4).
2. **Question.** Whether the notice meets the Personal Data Protection Act 2010 as amended for the pilot's actual data
   flows; what it must add (the backup transfer, processors, the controller's identity and contact, a data protection
   officer if any, children's data, how a complaint is made); and whether the translations are adequate.
3. **Documents.** [Privacy](../architecture/privacy.md) (what is kept, erasure, retention, [where data is kept](../architecture/privacy.md#where-personal-data-is-kept),
   [open questions](../architecture/privacy.md#open-questions-for-professional-review-retention-and-documents)),
   [known limitations](../roadmap/known-limitations.md#gaps-in-verification-and-documentation) (P1: blocks any launch).
4. **Consequences.** *Adequate:* set the operator contact. *Needs additions:* text changes in four languages plus review
   of the three non-English dictionaries; if the notice must name the backup country, it can only be completed once the
   hosting and backup decisions (L9) are taken, because it must describe what is true.
5. **Can it stay off?** No.

## L3. Venue and customer responsibilities; controller and processor

1. **Today.** The software assumes no allocation. The privacy document's *starting position, not settled and needing a
   lawyer's view* is: for a venue's bookings the venue decides why the data is held and MySenam processes it for the
   venue; for customers' own accounts (one sign-in across venues, the platform's own messages) the operator is
   responsible in its own right; a backup provider is the operator's processor either way. In the product: a venue's staff see
   only their own customers (staff lookups are scoped and throttled, [ADR 0057](../architecture/decisions/0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md));
   secrets never appear in a staff view; the owner's decisions and an API key's bookings are in the activity log. Terms
   section 6 tells a venue to use customer details "only to run their bookings with you" and that "you and we each handle
   personal data in line with" the Act. I found **no separate venue agreement** in the repository: the venue section of
   `/terms` is the only text.
2. **Question.** Who is controller and who is processor (or neither) for each kind of data; whether a written venue
   agreement is needed and what it must say (processing instructions, security, breach notice to the operator,
   sub-processors, the backup transfer); whether registration or a data protection officer applies.
3. **Documents.** [Privacy: where personal data is kept](../architecture/privacy.md#where-personal-data-is-kept),
   [incident response](incident-response.md#a-suspected-breach-of-personal-data) (the split is flagged for a lawyer),
   [tenancy](../architecture/tenancy.md).
4. **Consequences.** *Operator is processor for venue data:* a written agreement with each pilot venue before go-live and
   venue-side duties to its customers. *Operator is responsible in its own right for accounts:* the operator carries
   the notification and access duties for those. *Mixed (the starting position):* both, and the breach procedure (L10)
   must tell each affected venue promptly. The repository holds no template agreement, so each answer implies new text.
5. **Can it stay off?** No: any customer booking holds personal data.

## L4. Payment and refund handling

1. **Today.**
   - **Counter payments** (cash, DuitNow QR, transfer, card terminal): recorded with the method; the cash-up sums every
     receipt and credit note by method and the till is counted against it ([payments: cash-up](../features/payments-and-credit.md#cash-up)).
   - **A customer cancelling a booking paid at the counter** writes a credit note (the tax and till record) **and an
     obligation to hand the money back**, on the *Owed back at the counter* list, settled once by a named staff member
     (a payout record with amount, method, note; an alternative method the customer agrees is recorded). The customer is
     told the venue will return the money at the counter and that it has not been returned yet. **A credit note is not
     the refund** ([ADR 0074](../architecture/decisions/0074-a-customers-cancellation-of-a-counter-payment-is-an-obligation-to-hand-it-back.md),
     [ADR 0068](../architecture/decisions/0068-money-hardening-credit-notes-are-not-cash-spent-is-money-paid-and-the-till-lists-every-payout.md),
     [owed back after a customer cancels](../features/payments-and-credit.md#owed-back-after-a-customer-cancels)).
     Earlier customer cancellations are **not** turned into tasks; a read-only script lists candidates for manual review
     before the pilot.
   - **Online payment** goes into each venue's own gateway account (Billplz in Malaysia); the operator does not receive
     or hold it. **Billplz has no refund API: every Billplz refund is made by hand** in Billplz's dashboard and marked
     done, from *Refunds owed*; the venue states how long it takes (1 to 30 days, 7 by default), told to the customer as
     a date; the code says it is a promise, never a limit on what is owed. The customer "may be contacted for bank
     details" because MySenam collects no account numbers ([refunds made by hand](../features/payments-and-credit.md#refunds-made-by-hand)).
   - A payment that arrives for less than asked, for another bill, or after a hold lapsed is **held, owed back in full
     and listed under *Payments to check***; it never confirms the booking ([ADR 0065](../architecture/decisions/0065-a-payment-is-settled-for-the-amount-the-gateway-took-and-never-into-a-lapsed-hold.md)).
     This is tested against Billplz's documented payloads on a stand-in, not the real service.
2. **Question.** Whether the venue's promise period for a manual refund, the by-hand route, collecting bank details
   outside MySenam, a refund by credit instead of money, and keeping a late-cancellation share are consistent with the
   consumer-protection law and the payment provider's rules; whether anything about how money flows (the venue's gateway
   account, with the operator never holding customer money) needs a licence or registration; and what the customer-facing
   wording on refunds must say.
3. **Documents.** [Payments and credit](../features/payments-and-credit.md), [payment gateways](../integrations/payment-gateways.md),
   [pilot readiness](pilot-readiness-2026-11-07.md) (the Billplz row), [provider verification](pilot-provider-verification.md),
   [business decisions](../audits/business-decisions-2026-11-06.md) (DEC-24, the refund route for Billplz money).
4. **Consequences.** *The by-hand route and the venue's stated period are acceptable:* the pilot proceeds with a named
   person clearing the lists daily ([daily operations](pilot-daily-operations.md)). *Not acceptable:* the only product
   alternative named in the repository is a different refund route (DEC-24: a credit-by-default option, or a secure
   refund-details link), which is **not built**; the safe fallback is to keep online payment off and take payment at the
   counter only. For a licensing question, the repository records only a lawyer's check for credit where the install holds
   customers' money (L5).
5. **Can it stay off?** *Online payment:* yes, and it must until the Billplz sandbox check passes. *Counter payment and its
   refunds:* no; it is the pilot's payment method.

## L5. Stored credit, passes, memberships and gift vouchers

1. **Today.** Stored credit is an append-only ledger; it never expires; no path pays unspent credit out; a booking paid
   from credit and cancelled goes back to credit. `MYSENAM_CREDIT_SCOPE` is `venue` on a marketplace (bought and spent at
   that venue only, owed by that venue); the payments document says a platform holding strangers' money for other
   businesses "in Malaysia may need a licence" and tells the reader to ask a lawyer. A gift voucher is good once and **for a year**; after that it
   cannot be redeemed, nothing is recorded at expiry, and lapsed vouchers are shown apart and left out of the venue's
   liabilities total; the credit a redeemed voucher becomes never expires; a voucher cannot be redeemed at the desk, only
   from an account. Passes: entries not used by the end date lapse with nothing recorded; a manager may hand back the
   unused part. Memberships: a manager may refund the whole fee, nothing pro rata. **Validity is not paused or extended
   while a venue is suspended** (DEC-02: the owner's decision, not made); gateway auto-renewal (Stripe) is disabled for the
   pilot. The terms say credit "is not a bank deposit" and to "ask whoever sold it about refunding what you have not used".
   The pilot keeps customers' stored value "small" by an operating condition, not by a limit in code. The report shows what
   the venue holds for customers in ringgit and marks it provisional.
2. **Question.** Whether and when a voucher or credit may lawfully expire and how lapsed value is treated; whether stored
   credit may be refundable on request (and what the terms must say); whether holding credit for a venue's customers
   needs any licence or approval; whether a suspended venue must extend validity; what the customer-facing terms must say.
3. **Documents.** [Payments: stored credit](../features/payments-and-credit.md#stored-credit), [gift vouchers](../features/payments-and-credit.md#gift-vouchers),
   [whose credit it is](../features/payments-and-credit.md#whose-credit-it-is), [business decisions](../audits/business-decisions-2026-11-06.md)
   (DEC-02, DEC-23), [hardening record, section 5](../audits/hardening-2026-11-07.md#5-restricted-pilot-operating-policy-for-a-venue-that-cannot-yet-leave-a5--h8),
   [the e-invoice memo](einvoice-stored-credit-memo.md) (what each product is in the code).
4. **Consequences.** *Expiry allowed:* the 12-month voucher rule stands; the owner still decides how lapsed value is
   shown (DEC-23). *Expiry not allowed or restricted:* the expiry rule in `src/lib/vouchers.ts` would change (a code
   change with its own decision record), and liabilities would then carry vouchers permanently. *Refundable on request:* no
   in-app path exists, so a venue would refund by hand outside the app with no record in it (the memo says so); a
   refund path would be new work. *Licence needed for credit:* the per-venue scope is already the product's conservative
   setting; a venue that cannot meet it would have to stop selling credit.
5. **Can it stay off?** There is **no per-venue switch** that I found for selling credit, vouchers, passes or memberships
   at the counter (a suspended venue is refused). The pilot's restriction is the venue not selling them and keeping the
   exposure small (operating condition 4): an instruction to pilot venues, not a technical control. Online sales depend on
   online payment, which is off. This is an open question for the owner (below).

## L6. Manual venue closure and suspension

1. **Today.** A venue-exit workflow is **not built**. The owner can *suspend* a venue or a whole business with a reason:
   customers stop seeing it, bookings already made **stand** and can be cancelled and refunded as usual, nothing new is
   sold (passes, memberships, credit, vouchers are refused at the counter and online), customers with something there
   (upcoming booking, pass, membership or credit) are emailed once, and a membership that renews at Stripe is paused
   there (not verified against real Stripe). A suspension "does **not** settle any liability". Closing a venue is done by
   hand: stop selling, refund or honour what is held, export, then suspend; **a suspension is never described to a
   customer as having settled what they are owed**. A venue held for an invoice more than 14 days overdue is hidden the
   same way and can be given time. A day's closure is a separate act that cancels and refunds its bookings
   ([ADR 0063](../architecture/decisions/0063-a-suspended-venue-tells-its-customers-sells-nothing-new-and-an-overdue-one-can-be-given-time.md),
   [ADR 0053](../architecture/decisions/0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md),
   [hardening record, section 5](../audits/hardening-2026-11-07.md#5-restricted-pilot-operating-policy-for-a-venue-that-cannot-yet-leave-a5--h8)).
   While a customer holds credit, an account closure (erasure) is refused (L8).
2. **Question.** What the operator owes customers if a venue is suspended or walks away (credit, passes, memberships,
   vouchers, tournament fees, refunds owed); what the terms must say about it; whether suspending an overdue venue is
   permitted as written in the terms (hide after 14 days overdue, end on 14 days' notice after reminders); who answers to
   a customer when the venue cannot.
3. **Documents.** [Marketplace](../product/marketplace.md#running-the-marketplace), [hardening record](../audits/hardening-2026-11-07.md)
   (A5 = H8, deferred), [business decisions](../audits/business-decisions-2026-11-06.md) (DEC-02, DEC-03).
4. **Consequences.** *The operator is not answerable for a venue's stored value:* the manual procedure plus small exposure
   stays enough for a pilot. *The operator is answerable:* the venue-exit workflow (DEC-03, "large" effort, a state
   column) becomes a precondition, and the pilot would have to avoid venues that sell stored value until it exists.
5. **Can it stay off?** No: suspension is the owner's act and exists. The restriction is operational (small stored-value
   exposure; one named person; no automatic or unmonitored closure).

## L7. Data retention periods

1. **Today.** The privacy document's [retention table](../architecture/privacy.md#retention) is authoritative; the daily
   scheduler applies it. The periods a reviewer will most need, all of them the operator's choices and **none
   legally verified**:

   | What | Kept |
   | ---- | ---- |
   | Names, numbers and emails on bookings; the payer's name and number on online payments; names and numbers on receipts and credit notes | 730 days, then anonymised; the hour, the price, the amounts and the tax stay |
   | Receipts and credit notes themselves | Never deleted (the venue's accounting record) |
   | E-invoice records (a document sent to LHDN, its buyer details) | 7 years from issue by default, **provisional pending legal verification**; the owner may set 5 to 20, under 7 only with a recorded review; then cleared to a tombstone |
   | Messages sent (email, WhatsApp) once sent or given up | 90 days |
   | Arrivals at the desk | 365 days |
   | Door codes shown | 180 days |
   | Phone check codes and links | 1 day |
   | Staff activity log | 730 days |
   | Server errors | 90 days after the last occurrence |
   | Settled waiting-list entries | 90 days |
   | Private hire enquiries | 365 days |
   | Conversations between players | 90 days after the game, team, group or fixture ended |
   | Supporting documents for an approval | 90 days after the decision at most (30-day review window after a refusal or withdrawal); closed application records 365 days; the application periods are **provisional until a review is recorded** |
   | Youth safeguarding evidence | **No period set**: kept unless the install sets one, which needs legal approval first |
   | The erasure ledger (an erased account's number and creation moment) | 400 days |
   | Backups | 14 snapshots on the server (`MYSENAM_BACKUP_KEEP`); off-site about 15 days, by the bucket's lifecycle rule once one exists |

2. **Question.** Whether each period is proportionate and lawful in Malaysia (the privacy document asks about the PDPA's
   retention principle, s10), including: the 730 days for bookings and payments; 90 days for supporting documents and the
   quarantine period for an unscannable document; 730 days for the bare facts of deleted applications; the 400-day
   erasure ledger; the 7-year e-invoice period and whether it runs from issue or the end of the year of assessment; and
   the legal-hold and incident bases.
3. **Documents.** [Privacy: retention](../architecture/privacy.md#retention) and its [open questions](../architecture/privacy.md#open-questions-for-professional-review-retention-and-documents)
   (nine, written for a lawyer), [e-invoice records](../architecture/privacy.md#e-invoice-records).
4. **Consequences.** A shorter required period: the periods are install settings or constants and can be changed (some by
   the owner in *Keeping nothing too long*, with a recorded review); longer required periods for tax records mean the
   receipts-never-deleted rule already holds. Whether the e-invoice period can go below 7 years depends on the adviser.
   The repository gives no alternative periods beyond those ranges.
5. **Can it stay off?** No; retention runs daily.

## L8. Account erasure

1. **Today.** *Close my account* (the account page) cancels upcoming bookings on the customer's own terms, replaces the
   name, phone and email on the account's bookings with `(removed)` **keeping the hour and the price**, removes the
   account, sessions, waiting-list entries, profile, messages' contents and similar, and keeps receipts and credit notes
   with the name taken off, e-invoices (with the buyer details the customer gave) for the statutory period, signed waivers
   as the venue's record, and the financial record of payments. **It is refused while the customer is owed something**
   (stored credit, a live pass, a running membership) and when cancelling would put credit back into the account; the
   customer cancels first, spends it, or asks the venue to refund it. A booking made as a guest is not linked to an
   account: the customer asks the venue. Copies stay in backups until they expire; after a restore, erasures are applied
   again from the erasure ledger kept off-site, and an erasure from the last moments before a loss may be redone by hand.
2. **Question.** Whether refusing erasure while credit is held, keeping anonymised booking and payment records and
   e-invoice records, leaving copies in backups until they expire, and keeping an erasure ledger meet the customer's
   rights; what the notice must say; the timing to respond to a request.
3. **Documents.** [Privacy: erasure keeps the books](../architecture/privacy.md#erasure-keeps-the-books), its open
   question 3 and 8, [backups: after a restore](backups.md#after-a-restore).
4. **Consequences.** *Acceptable:* no change. *A customer with credit must be able to erase:* no product path exists to
   refund credit (L5), so a refund-or-forfeit route would need to be designed; the exit workflow (L6) is the repository's
   noted route for releasing the block.
5. **Can it stay off?** No.

## L9. Backups held abroad (Backblaze B2, United States)

1. **Today.** Backblaze B2 is the preferred off-site provider and has **no Asian region**; every copy goes to the US
   (recommended), Canada or the Netherlands. The owner decided on 24 October 2026 that off-site backups **may** be held
   abroad; the document says that chooses the destination and "does not by itself make a transfer lawful". The app
   sends nothing until `OFFSITE_DATA_LOCATION` names the country of the bucket's region; it checks the declaration
   against the endpoint (a B2 or S3 address names its region); a destination outside the install's country is **paused**
   until `OFFSITE_TRANSFER_APPROVED` names the same country **and** encryption is on. Copies are encrypted on the server
   with a key Backblaze never holds, signed, and uploaded with a key that can write but not delete (never with retention
   powers); the private key stays off the server. Nothing has been written to a real bucket and neither variable is
   recorded as set. The working analysis the repository holds (not legal advice): the Malaysian route is s129(3)(f)
   with contract clauses and a transfer impact assessment of the US; the Singapore route needs a contract naming the
   countries; encryption is a safeguard, not the basis. The operator's six steps (due diligence on Backblaze, a binding
   contract, a US assessment, the notice and venue agreements naming the country, a transfer register, a breach plan) are
   listed there and are **not recorded as done**.
2. **Question.** The eight points the privacy document leaves "for a lawyer to confirm before `OFFSITE_TRANSFER_APPROVED`
   is set": whether Backblaze's click-through, GDPR-oriented data processing agreement is a sufficient contract or an
   addendum with ASEAN model clauses is needed; whether encryption with the operator-held key changes the analysis;
   whether the Malaysian route is s129(2) or s129(3)(f), whether a transfer impact assessment is required, and how US
   government access is weighed; the commencement date of the amending Act and the guideline's paragraph numbers;
   whether the operator's contact and billing details that Backblaze keeps are a separate transfer; whether a SOC 2
   report without ISO 27001 is enough; Backblaze's actual certification status; and each party's role and what that means
   for registration, a data protection officer and breach notices.
3. **Documents.** [Privacy: backups held abroad](../architecture/privacy.md#backups-held-abroad), [backups: where the data may go](backups.md#where-the-data-may-go),
   [ADR 0014](../architecture/decisions/0014-off-site-backups-encrypted-and-located.md),
   [ADR 0015](../architecture/decisions/0015-backblaze-b2-preferred-signed-backup-sets.md),
   [launch providers](../integrations/launch-providers.md#off-site-backups), [provider verification](pilot-provider-verification.md).
4. **Consequences.** *Backblaze's agreement suffices, route confirmed:* the operator completes the six steps, sets the two
   variables, and passes the real-bucket check and an isolated restore drill. *An addendum or further clauses are needed:*
   those must be signed before the variables are set. *The US is not acceptable:* the repository's own alternative is a
   bucket in the install's own country (Amazon S3 in Malaysia or Singapore), which avoids the transfer question for that
   country's data but not the processor, security and retention duties, and costs more per gigabyte
   ([launch providers](../integrations/launch-providers.md#off-site-backups)); no other fallback is documented.
5. **Can it stay off?** The transfer can stay unapproved (the app then pauses off-site copies), **but** pilot readiness
   requires a real bucket, the transfer approval and an isolated restore drill "before any real customer data is held". Off
   means no real customers, not a pilot without backups.

## L10. Data-breach notification

1. **Today.** [Incident response](incident-response.md#a-suspected-breach-of-personal-data) holds a procedure and
   summaries of Malaysia's rules (the PDPA s.12B notification duty, a 72-hour deadline per the Commissioner's guideline,
   significant-harm and scale thresholds, 30 days for further information, affected people within 7 days, a breach
   register, penalties) and Singapore's, "as read on 24 October 2026", **partly through law-firm summaries because the
   regulator's site was unreachable**, with what could not be confirmed marked. It flags: whether the 72 hours run from the
   breach or from awareness (the document says to assume the earlier); whether the Act's "reason to believe" test is wider
   than the portal's significant-harm filter; and whether a data protection officer must be appointed. It states that who
   notifies for which data is **not settled** and needs a lawyer's confirmation. A processor tells each affected venue
   without delay. The app has no breach-notification function: it detects and records; people notify. **Nobody is named as
   incident lead** (a known-limitations blocker).
2. **Question.** Confirm the Malaysian rules against the official text; who notifies whom for venue data and for account
   data; the clock; the thresholds; whether an operator must register or appoint an officer; how a breach at a provider
   (Backblaze, SES) is handled.
3. **Documents.** [Incident response](incident-response.md), [privacy](../architecture/privacy.md#where-personal-data-is-kept),
   [known limitations](../roadmap/known-limitations.md#blockers-for-any-launch).
4. **Consequences.** *Rules confirmed as summarised:* name the incident lead and keep the procedure. *Different clock
   or thresholds:* text changes in the procedure and the escalation table in the daily operations document; the
   fixed 72-hour planning assumption would change. The repository holds no alternative rules to describe.
5. **Can it stay off?** No.

## L11. Processors and provider relationships

Which providers the pilot uses, and what is verified. "Used" means the pilot intends to enable it; **nothing has been
exercised against a real service** ([pilot readiness](pilot-readiness-2026-11-07.md#integrations), [provider verification](pilot-provider-verification.md),
results of 7 November 2026).

| Provider | Role | In the pilot? | State today | Contract and data-location points for review |
| -------- | ---- | ------------- | ----------- | -------------------------------------------- |
| Amazon SES | Sends every customer email, including sign-up and password-reset links | **Required** | Not delivery-verified: DMARC and SPF records found; the account and identity could not be read; no message sent. Region recommended: Singapore (`ap-southeast-1`) | Processor agreement; the region (Singapore) is outside Malaysia: whether that is a transfer; bounces and complaints are not read back by the app |
| Backblaze B2 | Off-site backup copies (encrypted) | **Required before real data** | No credentials in the environment; blocked | L9 |
| Billplz | Each venue's own online payment account and refunds by hand | Only after the sandbox check; **off until then** | Blocked: no sandbox credentials | Card numbers stay with the gateway (incident response); the operator does not receive or hold the money; the venue holds its own Billplz account |
| WhatsApp Cloud API | Optional customer messages and phone checks | **No** (email only) | Not run; templates need Meta approval and one must be resubmitted | Not applicable while off |
| Stripe | Singapore, membership auto-renewal, the platform's own invoices | **No** (auto-renewal disabled) | Not run | Not applicable while off |
| MyInvois (LHDN) | E-invoicing | **No**: disabled | Not run | L15 |
| Xero | Optional live accounting push; data goes abroad | **No** | Not run | Needs approval for data abroad if ever enabled ([Xero](../integrations/xero.md)) |
| Hosting (database host, the server) | Holds the database | Required | Location and operating company **not decided** (known limitations) | The notice and venue agreement must name it |
| Photo storage (Cloudflare R2 recommended) | Venue photos | Optional (`PHOTOS_S3_*`); local disk otherwise | Not verified | Only if a bucket is used |
| Error tracker (`SENTRY_DSN`) and alert channel (`MYSENAM_ALERT_WEBHOOK`) | Receive server error and alert text | Only if set; neither recorded as set | Not configured as far as the repository shows | Error text is stripped of email addresses and long digit runs before it is kept; whether a chat channel or tracker is a processor of personal data is for the lawyer |
| Google sign-in, SMS, AI assistants (MCP) | Optional | **No** | Off by default; assistants see no personal data unless a venue manager turns it on | Not applicable while off |

1. **Today.** As the table. The privacy notice names none of them (L2).
2. **Question.** For each provider used: the contract (or accepted terms) in place, the data and country, whether a
   written processor agreement is needed, and what the privacy notice and venue agreement must name.
3. **Documents.** [Launch providers](../integrations/launch-providers.md), [privacy](../architecture/privacy.md#where-personal-data-is-kept),
   [messaging](../integrations/messaging.md), [pilot provider verification](pilot-provider-verification.md).
4. **Consequences.** If SES in Singapore needs transfer safeguards, they must be in place before the first customer
   email, which the pilot cannot run without (sign-up and reset are refused on a production marketplace when email cannot
   deliver, [ADR 0073](../architecture/decisions/0073-security-mail-is-its-own-class-and-a-production-marketplace-needs-email-that-can-deliver.md)).
   The repository documents no email alternative that avoids a foreign provider other than SMTP through another provider,
   which would raise the same question for that provider.
5. **Can it stay off?** WhatsApp, Stripe, MyInvois, Xero, Google, SMS and assistants: yes, and they are off. SES and the
   backup provider: no, they are required.

## L12. Cancellation terms and their historical snapshots

1. **Today.** Every booking carries the terms in force when it was made (`bookings.cancel_terms`, migration 0330): the
   free-cancellation cutoff, the share the venue keeps of a late cancellation (or none), the give-back flag, and, as
   evidence, a digest of what the customer was shown, when, and the strike and hold terms. That snapshot governs the
   customer's cancelling, a series' weeks, taking a person off, the change deadline, an account closure and the counter's
   late-share option; a later policy edit changes only **later** bookings, in **both** directions. A reschedule keeps the
   original terms. Staff may still cancel in full past the cutoff, which waives the late share and is logged. **Bookings
   made before 0330 carry none and are read on the venue's current terms; nothing is backfilled**, because stamping today's
   terms would invent past terms. How money paid online goes back (card, credit, by hand) and the strike rules are the
   venue's setting of the day. The confirmation email and the receipt **do not repeat the terms**. A customer who has
   checked in (a desk check-in, or their own QR check-in) cannot cancel online and is sent to staff: a route to a
   person, not a forfeit; having merely viewed a door code changes nothing. Strikes are recorded against the phone number
   as the customer's identity (owner decision DEC-39 open).
2. **Question.** Whether the terms shown at booking, kept as a snapshot and a digest, are adequate evidence of what the
   customer agreed; whether the email and receipt must state them; whether the old bookings on current terms are a
   problem; whether keeping a share of a late cancellation or the whole payment after the cutoff, and recording no-shows
   and strikes against a phone number, is lawful; whether sending an arrived customer to staff is acceptable.
3. **Documents.** [Booking: the terms a booking was sold on](../features/booking.md#the-terms-a-booking-was-sold-on-govern-it),
   [ADR 0069](../architecture/decisions/0069-the-terms-a-booking-was-sold-on-govern-it-arrival-goes-to-staff-and-edits-meet-bookings-in-one-transaction.md),
   [ADR 0058](../architecture/decisions/0058-safety-and-access-after-a-booking-is-made.md).
4. **Consequences.** *Adequate:* none. *The email and receipt must carry the terms:* a text and template change; the
   evidence is already stored. *Old bookings must be on better terms:* the ADR lists a choice the owner could make (stamp
   today's terms on upcoming bookings, "knowing it is an assumption"); pilot bookings all start after the migration, so for
   a new install the question fades. *Late shares or strikes not acceptable:* the venue sets them (the share, or no late
   cancelling online, or a venue that keeps none), so the pilot venues could be set to keep none.
5. **Can it stay off?** No: cancellation terms apply to every booking. The venue's late-keep settings are the lever.

## L13. Liability for unavailable venues

1. **Today.** The terms say a venue may cancel a booking it cannot honour (a closure, a fault, bad weather) and the
   customer is "then owed back anything you paid for it". In the product a closed day, an outage, a rain-out, a class
   called off or a staff cancellation cancels and refunds what was paid (online through the gateway where it can refund,
   else owed on the payment for staff to settle by hand; a counter payment is owed back until a named person confirms
   handing it back) and tells the customer; a booking whose kit is still out stays and is named for the desk. A
   suspension: bookings stand, the customer is told the venue is "not available for now" and that it is not their doing. The terms
   allocate responsibility: the venue for its premises and what happens there, the operator for the booking service,
   with rights that cannot be taken away preserved. They say nothing on loss beyond the refund (travel, a missed event)
   and nothing on the operator's liability if a venue disappears.
2. **Question.** Whether the allocation of responsibility and the refund-only remedy are acceptable, what limits on
   liability the terms may state, and what an operator may say about a venue that is unavailable.
3. **Documents.** [Terms](../product/marketplace.md#running-the-marketplace), [booking](../features/booking.md) (closures and
   outages), [payments: owed back after the venue cancels](../features/payments-and-credit.md#owed-back-after-the-venue-cancels),
   ADR 0063 (L6).
4. **Consequences.** The terms are text: either answer changes wording. A requirement to compensate beyond a refund
   would be a business decision with no mechanism in the product. No other alternative is in the repository.
5. **Can it stay off?** No.

## L14. Youth functionality

1. **Today.** **Youth messaging is disabled for the pilot**: off in production unless `YOUTH_MESSAGING_LAUNCH_APPROVED=yes`,
   which stays unset. Pilot readiness lists "Youth functionality" as *Disabled for pilot*. The questions, the interim
   measure and the launch gate are in the existing checklist, **not repeated here**:
   [legal review: youth messaging](legal-review-youth-messaging.md).
2. **Question.** As in that checklist (eight items and the launch gate).
3. **Documents.** [The checklist](legal-review-youth-messaging.md), [ADR 0052](../architecture/decisions/0052-youth-messaging-interim-safeguards-pending-legal-review.md),
   [player messages](../features/player-messages.md#interim-safeguards-pending-legal-review).
4. **Consequences.** See the checklist's launch gate.
5. **Can it stay off?** Yes: it is off, and the pilot stays one to three staffed venues without it. **Not covered by that
   switch and not stated disabled in pilot readiness** (open question below): adults managing children from their account,
   declared dates of birth and guardians' names for some tournament entrants, and a guardian's authorisation of a child's
   full name on public pages. The privacy document asks the lawyer about them in its open questions 5 and 6.

## L15. MyInvois treatment of stored value (audit C2): UNRESOLVED

For the venue's tax adviser. **No treatment has been chosen, by the code or by the memo.** This stays **unresolved** until a
qualified Malaysian tax adviser answers in writing.

1. **Today.** The consolidated e-invoice carries a stored-credit or gift-voucher receipt **and** the booking later paid
   from that credit, so RM100 of credit and the RM30 booking paid from it appear as RM130 of sales
   (`consolidate` in `src/lib/myinvois.ts`; the journal's revenue flag is not consulted). The sales journal itself treats the
   credit as a liability and the booking as the sale (RM30). A pass sale is the sale and the booking it pays is not a
   row. The code refuses to switch e-invoicing on at a venue that has sold credit or vouchers unless a manager ticks that
   they understand (written to the activity log); a venue already on is not switched off; a venue that starts selling
   credit after switching on is not warned. A regression test pins RM130 as *pending policy*. A late consolidated
   e-invoice (after the seventh day of the next month) is only marked *Late*. **E-invoicing (MyInvois) is disabled
   for the pilot**, and in any case must not be enabled at a venue that sells credit or vouchers (pilot readiness: a P1 for
   that case).
2. **Question.** The ten questions in the memo: is stored credit "refundable in nature" under LHDN's FAQ (and does a
   gift voucher differ); when is an e-invoice due (sale, redemption, expiry) and how is that shown in a consolidated
   e-invoice; is SST due at the sale or when spent; which document and date for a booking paid from credit; how reversals
   and credit notes are treated; whether passes and memberships should follow the same rule; whether booking and hire
   deposits are "refundable" for this purpose; what a late consolidated e-invoice requires; who is the supplier where
   credit is install-wide.
3. **Documents.** [The memo for the tax adviser](einvoice-stored-credit-memo.md#the-questions-for-a-qualified-malaysian-tax-adviser),
   [ADR 0065](../architecture/decisions/0065-a-payment-is-settled-for-the-amount-the-gateway-took-and-never-into-a-lapsed-hold.md)
   (decision 3), [MyInvois](../integrations/myinvois.md), [business decisions](../audits/business-decisions-2026-11-06.md) (DEC-19).
4. **Consequences.** The memo's *conditional* implementations (nothing is built until the adviser answers in writing, and each
   change needs a decision record): *refundable in nature:* credit and voucher receipts and their credit notes are left out
   of consolidated e-invoices, the credit-paid booking stays in, and an e-invoice on expiry is needed for a voucher that
   lapses; *non-refundable:* the receipt stays in at the sale and a booking paid from it must not add its price again;
   *different by product:* a rule per journal category. Earlier consolidated e-invoices that carried both are the
   adviser's matter (a credit note and a replacement), not a migration.
5. **Can it stay off?** Yes: e-invoicing is disabled for the pilot, and the guard refuses an accidental enable. The pilot's
   stored-value exposure is kept small meanwhile.

## L16. The venue's other tax treatments the app suggests

For the venue's tax adviser. Tax treatments in the app are **provisional starting points, never verified**; a venue's
adviser's review is recorded, not assumed.

1. **Today.** Receipts carry no tax at the sale of credit or a voucher ("taxed when spent"); passes and memberships carry
   it at the sale; booking deposits at the deposit; a hire deposit is not a sale while held and only what is kept is
   (marked provisional until the venue's manager records its adviser's review before a first real deduction). Tax
   settings and rounding are as configured and a half-sen rounding is pinned in a test; the venue report's liabilities
   total says it is provisional. The credit note for a customer's counter cancellation is written at cancellation and is dated that
   day; the money may be handed back on another day or by another method, so the cash-up and the payout list agree only
   when both fall on the same day and method. The tax document's date would move if the note were written at settlement,
   which is "the owner's and the adviser's choice" (final hardening record, section 2). E-invoice retention is 7 years by
   default, provisional (L7).
2. **Question.** The treatment, timing and documents for each product above; the date of a credit note for a counter
   cancellation; whether the cash-up's two-day split is acceptable; the rounding; how each held amount (credit, deposits,
   vouchers, owed refunds) is shown in a venue's books.
3. **Documents.** [Regions and tax](../product/regions-and-tax.md), [payments and credit](../features/payments-and-credit.md),
   [reporting](../features/reporting.md) (*What the venue owes*), [the memo](einvoice-stored-credit-memo.md),
   [final operational hardening record](../audits/final-operational-hardening-2026-11-07.md) (section 2, remaining risk).
4. **Consequences.** A different treatment is a code and decision-record change for each (the memo's implementation
   notes cover only L15); until the adviser answers, the provisional markers stay on screens and in reports.
5. **Can it stay off?** No: receipts are written for every sale. The mitigation is that nothing is presented as verified.

---

## Questions for the owner, not for the lawyer

These come out of writing this packet and are not answered by any repository document:

1. Is there, or will there be, a written venue agreement beyond the venue section of `/terms`?
2. Who is the contracting company, in which country is the data hosted, and who is named incident lead? (All three are
   recorded as undecided or unnamed.)
3. Is there a way to stop a pilot venue selling credit, vouchers, passes and memberships other than asking it not to?
   (No switch was found.)
4. Are the other minors' features (guardian-managed participants, declared dates of birth and guardians' names, public
   names of children) on or off in the pilot? Pilot readiness names only youth messaging.
5. Should a customer be made to accept `/terms` and `/privacy` when registering or booking? (None is asked today.)
