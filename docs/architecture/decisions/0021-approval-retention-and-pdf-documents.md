# ADR 0021: Approval applications are kept by purpose; PDFs are checked, never rendered, and only downloaded

- **Status:** current, decided 2026-10-26 by the product owner. Builds on
  [ADR 0019](0019-approval-requests-apart-from-bookings.md). Amended by
  [ADR 0024](0024-documents-scanned-before-release-retention-by-purpose.md):
  documents are now also scanned for malware before release, and the install
  may set its own periods; everything else here stands. The rules people
  meet are in [privacy](../privacy.md#applications-to-be-approved-for-an-activity),
  [registering online for approval](../../features/activities.md#registering-online-for-approval)
  and [security](../security.md#supporting-documents).
- **Context:** an application to be approved for an activity holds answers,
  declarations, a minor's guardian's name and, often, a certificate: personal
  data, some of it sensitive. Until now its documents went 90 days after the
  decision and the rest 365 days after a refusal or the approval's end, with
  no exceptions and no distinction between what proves somebody may do the
  activity today and the history of how that was decided. Customers also
  wanted to send certificates as PDFs, which the image-only upload refused.
  The owner accepted 90 days for documents and 365 for closed records as
  provisional defaults, not statutory periods, subject to legal review, and
  asked for a purpose-based model with earlier deletion, lawful exceptions and
  secure PDF handling without paid services.
- **Decision:**
  - **The eligibility and the history are separate records, kept for
    separate purposes.** The sign-off or certification an approval writes
    (`sign_offs`) is the credential the booking rules check: who, the venue
    and activity, sign-off or certification with its number and issuer, its
    end, and who gave it. It lives as long as it is valid, under the
    sign-offs' own rule, and never goes because the application does. The
    application (`approval_requests`, its events and documents) is the
    history: documents only while a decision, review or appeal needs them
    (the review window, 30 days by default, after a refusal, withdrawal,
    lapse or the approval ending; never more than 90 days after the
    decision); answers, declarations and history 365 days after the
    application closed. On an approval still standing the same period runs
    from the decision and *minimises* the record (answers, declarations,
    slot, the reasons written in its history and names go; status, dates and
    the approval's link stay, so the customer still sees it and is reminded
    to renew).
  - **When an application closes is stored** (`closed_at`, migration 0129):
    decided other than approved, or its approval lapsed, was taken back or
    replaced. It is noted once by the daily run, before the sign-offs' own
    rule could delete the sign-off it rests on.
  - **An activity may keep less, never more** (`review_days`,
    `document_days`, `record_days` on `approval_requirements`, checked in the
    code and by the database). Only a **hold** keeps anything longer
    (`approval_holds`): for a stated legal, safety, dispute or incident
    reason, by the platform owner (a year at a time) or a manager of the
    venue (90 days at a time, 180 in all for one application, after which
    only the owner); never front desk or a coach. Each hold has a review
    date and stops protecting anything after it unless renewed by a new,
    recorded hold. Erasure waits while one is in force.
  - **What is left is the bare facts** (`approval_audit`): that an
    application existed, at which venue, for what, how it ended, when, and
    who decided; no answers, declarations, documents, name or number; the
    account only while it exists. It and the record of who opened which
    document (`approval_document_access`) are kept 730 days, as the staff
    activity log is.
  - **Documents stay in the database**, never in the public photo store, and
    are only ever handed out by the app to the applicant, the venue's staff
    or a coach authorised for that activity there; there are no files or
    storage objects to orphan, and no temporary files (uploads are read and
    checked in memory). The daily run still deletes any document left
    without an application holding its details.
  - **A PDF is checked, not rendered.** Its type comes from its bytes, and a
    name or declared type that disagrees is refused. It is refused if
    encrypted, or if its dictionaries or (decompressed, within a bound)
    object streams name scripts, actions on opening other than a page to open
    at, actions that launch, submit, import or play media, attached files,
    rich media or XFA; or if it has more than 20 pages or cannot be checked.
    It is kept as sent and served only as an attachment, under a content
    security policy that sandboxes it and lets nothing load or run, never
    cached; every opening is recorded. No preview is made. Images are still
    redrawn as WebP.
- **Consequences:**
  - A valid approval survives its application record; a booking never
    depends on the application.
  - Deleting a row does not reach copies already in backups: those age out
    with the backups (about two weeks locally and off-site). The privacy
    notice says so.
  - The structural checks are a mitigation, not malware scanning: they keep
    out the PDF features attacks use, not every flaw a reader might have.
    Reviewers open PDFs in their own reader, outside the app's origin.
  - Office suites write a page to open at (`/OpenAction [page /Fit]`) into
    every PDF; that view is allowed, while every other opening action is
    refused. This narrows the owner's "reject OpenAction" to what can act.
  - A venue that asked for a document before this change must say why
    before it can take one again.
- **Alternatives considered:** deleting the whole application at 365 days
  from the decision (would leave an approval the customer cannot see or
  renew, though the sign-off would stand); keeping documents in object
  storage (adds orphans and a second place to secure and delete, for no
  gain at these sizes); rendering PDFs to images server-side (runs a PDF
  engine on untrusted input, the risk being avoided); a paid scanning
  service (not wanted).
