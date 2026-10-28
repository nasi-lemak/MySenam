# Security and abuse prevention

Authoritative for rate limits, phone-number limits and other abuse controls. Sign-in is in [authentication](authentication.md); tenant boundaries in [tenancy](tenancy.md).

## Response headers

Every response carries (`src/lib/security-headers.ts`; the policy from `src/middleware.ts`, the rest from `next.config.ts`):

| Header | Value and why |
| ------ | ------------- |
| `Content-Security-Policy` | Scripts only those carrying this response's nonce, and what they load (`'strict-dynamic'`); styles and requests from this site only; images from here or any HTTPS address (photo buckets, OpenStreetMap tiles); no plugins; forms post only here; `frame-ancestors 'none'` so no other site can frame a booking or payment screen |
| `X-Frame-Options` | `DENY`, for browsers that do not read `frame-ancestors` |
| `Strict-Transport-Security` | A year, not preloaded, and not for sub-domains (a storefront may be a venue's own domain, whose other sites are not ours to bind); ignored over plain HTTP |
| `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` | `nosniff`; `strict-origin-when-cross-origin`; only geolocation, for *near me* |

The middleware makes a fresh nonce for every request and names it in the
policy, on the request (so Next.js puts it on its own scripts) and on the
response. Every page already renders on request, as the root layout reads the
language cookie, so this costs nothing in caching. A script injected into a
page has no nonce, and the browser will not run it; `'unsafe-inline'` and
`https:` remain only for browsers too old for nonces, which newer ones ignore
when a nonce is present. Inline styles are still allowed. The production build
is checked in a browser: each page names a different nonce, its scripts carry
it, and booking a court works with nothing blocked (`tests/e2e/launch.e2e.ts`,
`tests/launch-security.test.ts`).

## Requests from another site

`src/middleware.ts` refuses, with `403`, a request to `/api/` that changes
something (not `GET`, `HEAD` or `OPTIONS`), carries a sign-in cookie
(`ms_session` or `ms_admin`) and comes from another site: an `Origin` whose
host is not the request's `Host`, `X-Forwarded-Host` or `MYSENAM_URL`, or
`Sec-Fetch-Site: cross-site` (`src/lib/same-origin.ts`). Requests without our
cookies (gateway callbacks, WhatsApp's webhook) and the key-authorised public
API under `/api/v1/` are not checked. A proxy that rewrites `Host` must pass
the original in `X-Forwarded-Host`, or `MYSENAM_URL` must name the site.

## Private links and who decides approvals

A private link (a coach's schedule, `/coach/<token>`; a tournament official's)
grants only what its page shows, never a venue-management power. Both are 24
random bytes, kept only as a SHA-256 hash, shown once when made, and lapse
(a coach's a year after it is made, an official's on the tournament's last day or an earlier one the organiser gives);
the venue withdraws or replaces either at once, and what is done at a coach's
link is in the activity log under the coach's name
([coaching](../features/programmes.md#one-to-one-coaching)). Deciding an
application to be approved for an activity, where identity matters, needs an
account: the venue's staff signed in to the dashboard, or a coach signed in to
their own account that a manager linked to the coach record. Each decision is
checked against the database (the coach active, at that venue, named for that
activity, linked to the account deciding; a safety-assessed activity granted
only by a manager, a named coach or delegated front desk) and recorded with
the person ([ADR 0020](decisions/0020-approval-to-booking-payment-and-authority.md)).
Door codes follow eligibility, not the booking's author
([door codes](../features/venue-operations.md#resources-nobody-is-standing-next-to)).

A venue's staff calendar feed (`/api/calendar/<token>.ics`) is the same kind
of key to its customers' names and numbers, shared by its staff: 24 random
bytes, found by their SHA-256 hash, lapsing a year after the address is made,
replaced or withdrawn by a manager, each change in the activity log. So that
staff can copy it again to subscribe another calendar, the copy they are shown
is sealed with the install's secret as payment keys are (`src/lib/secrets.ts`),
which a database copy or backup does not carry
([staff calendars](../integrations/messaging.md#bookings-in-staffs-own-calendar)).

## No account enumeration

A customer who types somebody else's email address must not learn from the
answer whether an account holds it, whose it is or what it has done (the
owner's decision of 27 October 2026). Rate limits slow such probing; they do
not stop it, so the answer itself must say nothing:

- **A resident's guest invited by email** (`src/lib/guest-invites.ts`): the
  address is never looked up. The reply, its status and its keys are the
  same whether or not an account holds it; the entry goes on the list the same
  way; the same email is queued through the outbox either way, in the
  resident's language, held like a password reset's (no venue's, its text not
  kept once sent, never readdressed). The address gets a single-use link
  (24 random bytes, kept as a keyed hash, with a keyed hash of the address),
  which links that one guest entry to the account that accepts it signed in
  with that address, and lapses with the entry. Every link that cannot be
  used gets one answer, `404 GUEST_INVITATION_INVALID`. The resident sees
  *invitation sent* until the guest accepts; accepting is the guest's own act
  ([residents inviting their own guests](../features/booking.md#residents-inviting-their-own-guests);
  `tests/guest-invitations.test.ts`).
- **A forgotten password** answers the same whether or not the address has an
  account, and the reply waits on the same work either way: the request is
  queued and worked through afterwards
  ([forgotten passwords](authentication.md#forgotten-passwords)).
- **Signing in** with an address no account has, or one whose account has no
  password, hashes the password given all the same, so it takes about as long
  as a wrong password (`verifyPassword` in `src/lib/auth.ts`, for customers
  and staff).
- **Signing up** takes the address only and answers `202` *check your email*
  whether it is new, has an account, has a link out or has had its fill of
  emails, with the same body and headers and after the same awaited work
  (the request queued, as a reset's); an address with an account is told so
  by email, with how to sign in and no link that changes anything, and only
  the link emailed to an address can make an account for it
  ([signing up](authentication.md#signing-up);
  `tests/registration.test.ts`).
- **Inviting a player to an open game or a group by email**
  (`src/lib/player-invitations.ts`): the address is never looked up. The
  reply, its status and its keys are the same whether or not an account holds
  it and whether or not whoever does may be invited; the same statements run;
  the invitation counts against the inviter's daily limit either way; and the
  same email is queued through the outbox, in the inviter's language, held
  like a password reset's. Its single-use link (24 random bytes, kept as a
  keyed hash, with a keyed hash of the address) is bound to that one game or
  group and to the account signed in with that address, and runs out (48
  hours or the game's start; 7 days for a group). The host or organiser sees
  *invited by email* until it is accepted, never a name, an account or
  whether they opted in. The rules on who may be invited
  ([ADR 0016](decisions/0016-matchmaking-on-open-games.md)) are applied on
  acceptance, and a link they do not allow gets the same answer as one that
  cannot be used, `404 PLAYER_INVITATION_INVALID`
  ([invitations](../features/matchmaking.md#invitations-links-and-private-games);
  `tests/player-invitations.test.ts`). Inviting somebody the inviter already
  knows here, picked from their lists, names an account they have seen and is
  unchanged.
- **Withdrawing an emailed invitation** (a guest's, a game's or a group's)
  takes no address: it names the invitation, and answers and works the same
  whether or not an account holds the address it went to. The address is
  told only if the invitation's email had gone, by a notice found through
  the outbox, never by looking an account up
  (`tellInvitationWithdrawn` in `src/lib/player-invitations.ts`;
  `tests/invitation-withdrawals.test.ts`).

The timing of signing in, of asking for a reset and of asking to sign up is
measured in `tests/no-enumeration-timing.test.ts`, with bounds generous
enough for a busy machine: they show the unknown address is not
systematically faster (for signing up, nor slower), not that the two take
exactly the same time.

Guardians invite another guardian with a code they pass on, not an address.
Staff tools that find an account by email (linking a list entry, selling a
pass or membership to an account, a sign-off, a coach's login, a guardian
proposed by account email) say when none has it: they are used by a venue's
own staff for the person in front of them, not by customers. Where the rule
does not yet hold for customers is in
[known limitations](../roadmap/known-limitations.md).

## What a request may send

- **Bodies.** A handler reads a JSON body only when it is an object: `null`,
  a list, a number, a string or text that is not JSON is refused with `400`,
  never read into a `500` (`jsonObject` and `readJsonObject` in
  `src/lib/api.ts`; `tests/bad-bodies.test.ts` calls every route handler with
  each).
- **Names and emails** a booking, a class place, a waiting list or a new
  account keeps are bounded for every path that keeps them, the booking form,
  the counter, the venue's API and sign-up, and in the store beneath them
  (`src/lib/contact-fields.ts`): a name is trimmed and at most 100 characters
  (`NAME_TOO_LONG`), an email at most 254. They travel on to receipts, staff
  lists, exports, calendar feeds and message templates, whose providers cap
  each value (`tests/contact-lengths.test.ts`).
- **Other free text** reachable without an account is cut to a bound where it
  is kept: an enquiry's name, email and message, a gift voucher's names, email
  and message, an application to list a venue, the e-invoice details a
  customer gives, a browser error report, a review, a coach's note on their
  days off. A score is read only in the form a result takes.

## Rate limiting

Password endpoints and anything addressable by a short code are rate limited
per client IP (`src/lib/rate-limit.ts`), returning `429` with `Retry-After`:

| Endpoint | Budget |
| -------- | ------ |
| Admin & customer sign-in | 10 per 10 min, per pair of IP and email; and 20 wrong passwords per 30 min for one account from any address (a right password is never counted; somebody failing on purpose can hold an account at this for the window) |
| Forgot / reset / change password | Same budget as signing in |
| Registration (asking for the emailed link) | 5 per hour; and at most 3 emails an hour and 5 a day to one address, with the same answer past them ([signing up](authentication.md#signing-up)) |
| Checking or using a sign-up link | Same budget as signing in |
| Booking lookup / cancel by code | 20 per 10 min |
| Booking creation | 20 per hour |

Counters live in process memory by default, which is right for one instance.
Behind several, set `MYSENAM_RATE_LIMITS=shared` and they live in Postgres
instead (`rate_limits`). That is one atomic upsert per limited request, so
every instance counts against the same window; passed windows are cleared with
the daily retention run. Client identity comes from `x-forwarded-for`, which is
only trustworthy behind a proxy that sets it.

## Limits that follow the phone number

A phone on mobile data gets a new IP address whenever it likes, so the limits
that matter most follow the number instead (`src/lib/limits.ts`). Numbers are
compared as digits, so `+60 12-345 6789` and `0123456789` are the same.

| Limit | Value |
| ----- | ----- |
| Unpaid bookings coming up, one number, one venue | 3 |
| Unpaid bookings coming up, one number, every venue | 6 |
| The same slot every week | needs a signed-in account |
| Messages to one number or email address | 8 a day; any more are kept, marked not sent |

Paying for a booking, playing it or cancelling it frees its place, and a weekly
series counts once. The counter and the venue's API key are held to the same
limits; no override goes past the unpaid-bookings limit
([the same policies on every path](../features/booking.md#the-same-policies-on-every-path)).

**Blocked numbers.** A venue can stop a number booking or queueing with it,
online, at its counter and through its API key: *Block number* on any
booking, or under *Venue details → Blocked numbers*. No override books a
blocked number; unblocking it is a manager's, says why, and is in the
activity log with who did it.

**Order and names.** Venues are listed in an order shuffled once a day, not
alphabetically, so an "AAA" name gains nothing. When a venue operator renames
their venue, every platform owner gets an email.

**Forms.** The venue application and sign-up forms have a field no person
sees; a submission that fills it in is dropped.

**One venue cannot crowd out the rest.** Search shows each venue once per
start time, with its cheapest court, and counts its other free courts rather
than listing them, so adding courts gains a venue no ground. The classes page
shows two weeks ahead and at most six of one venue's sessions a day (a venue's
own page shows all of them). A venue's own staff can add up to 50 courts and
keep up to 300 class sessions in the diary; the platform owner can add more,
and is emailed each time a venue passes another 10 courts or 50 sessions.

## Supporting documents

A customer applying to be approved for an activity may send the document the
venue names, a certificate, as a PDF or a photo or scan
([registering online for approval](../features/activities.md#registering-online-for-approval);
`src/lib/approval-documents.ts`; [ADR 0021](decisions/0021-approval-retention-and-pdf-documents.md);
scanning in `src/lib/document-scanning.ts`, [ADR 0024](decisions/0024-documents-scanned-before-release-retention-by-purpose.md)).
Such a document may hold sensitive personal information, so:

| Control | What it does |
| ------- | ------------ |
| Asking only for what is needed | The venue names the document and says why; never an identity document (a label or reason naming one is refused) |
| Size and number | Up to three per application, 10 MB each, refused before the upload is read whole where its size is declared, and never read past the limit (about 30 MB) where it is not |
| Type by content | What a file is comes from its first bytes (`%PDF-`, or a JPEG, PNG or WebP signature), never its name or declared type; a name or type that disagrees is refused, so a renamed program, or HTML or SVG called `.pdf`, is refused |
| Images | Redrawn as WebP, as venue photos are: nothing of the upload survives but its pixels |
| PDFs | Never rendered or run on the server. Refused if encrypted; if its dictionaries, or its object streams (decompressed, within 40 MB), name JavaScript, an action on opening other than a page to open at, additional actions, Launch, GoToR, GoToE, SubmitForm, ImportData, media, attached files, rich media or XFA, however the name is escaped; if it has more than 20 pages or none; or if it cannot be checked (no end marker, an object stream with another filter or a predictor). Otherwise kept as sent |
| Storage | In the database (`approval_documents`), never in the public photo store or any public URL; deleted by the retention rules ([privacy](privacy.md#applications-to-be-approved-for-an-activity)); no temporary files (uploads are read, checked and scanned in memory, and streamed to the scanner from memory) |
| Malware scan | Every stored document waits in quarantine (`pending`) until the server's own call to the scanner (clamd, [below](#malware-scanning)) passes it (`clean`); until then nobody can open it, and an application whose activity asks for a document cannot be approved or have its in-person step recorded unless at least one of its documents is released and none is still waiting. Found something: `rejected`, its bytes wiped at once. No answer after seven tries over about 20 hours: `failed`, never released (kept and waiting when no scanner answered; see [below](#malware-scanning)) |
| Who may open one | The applicant; the venue's staff; a coach the venue authorised for that activity there, signed in to the MySenam account the venue linked to them, and only once released. Another venue's staff, another customer, another coach or nobody signed in gets nothing, in every state: the same `404` as a document that does not exist, so numbers cannot be probed; one of the people entitled gets `409 SCAN_NOT_RELEASED` for a document not released |
| Handing it out | Through the app only: `Content-Disposition: attachment` for a PDF (a redrawn image inline), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, and a content security policy of its own (`default-src 'none'; sandbox`, set by the middleware for these paths instead of the pages' policy) |
| Record | Every opening: who (customer, staff member or coach), which document, when (`approval_document_access`), kept 730 days and given to the customer with their data |

The structural checks keep out the PDF features attacks use, not every flaw a
PDF reader might have; the malware scan supplements them and replaces none.
Neither makes a file harmless: a clean scan means no signature the scanner
has matched. Reviewers open a PDF in their own reader, outside the app's
origin; no preview is made, and nothing is rendered on the server.

### Malware scanning

Chosen and compared in [ADR 0024](decisions/0024-documents-scanned-before-release-retention-by-purpose.md);
run as in [deployment](../operations/deployment.md#the-malware-scanner).

- **The engine** is ClamAV's daemon, clamd, reached over TCP (`MYSENAM_CLAMD`,
  e.g. `127.0.0.1:3310`) with its `INSTREAM` protocol: the bytes are streamed
  from memory in chunks, nothing is written to disk on the app's side, and no
  paid or remote service sees a document. The scanner sits behind one small
  interface (`src/lib/document-scanner.ts`), so another engine can replace it.
- **What is scanned** is what would be handed out: the PDF as sent, or the
  redrawn image.
- **Lifecycle.** Received → size and count limits → format checked from its
  bytes → stored in quarantine → scanned once the application or answer has
  committed (the customer waits at most 20 seconds for it; a scan still
  running then records its result by itself) → result recorded (status, engine and signature version, the
  signature's name if found, the SHA-256 of the bytes scanned) → released or
  not. A scan claims the document for two minutes, so concurrent or repeated
  scans scan it once; a result is recorded only while the document is still
  pending, so a late or repeated result changes nothing.
- **When the scanner is away, slow or unsure** (`unavailable`, `timeout`,
  `inconclusive`), the try is recorded and the scheduler tries again after 1,
  5, 30, 120, 360 and 720 minutes; after the seventh try the document is
  `failed`, for one of two reasons (`scan_failure`, migration 0159):
  - **`scanner_unavailable`**: the last try found no scanner (none
    configured, no connection, or a timeout or unreadable answer from a
    scanner that then did not answer at all). The document is kept, never
    released, never removed for that, and put back in quarantine by the
    scheduler within a minute of a scanner answering again, then scanned.
    Reviewers and the applicant see it as *waiting for the malware scanner*.
  - **`unscannable`**: a working scanner could not scan it (over clamd's size
    limit, which fails at once, or no usable answer for this document), or its
    bytes no longer match the hash taken when they were checked. Terminal:
    it goes after the quarantine period.

  Never clean by default.
- **Fail closed, no opt-out.** Supporting documents are safety and guardian
  application documents: none is released without a scan that passed. There
  is no setting to take or release documents unscanned (the former
  `MYSENAM_DOCUMENT_SCAN=off` was withdrawn on 27 October 2026 and is
  ignored, with a start-up warning). Exempting a lower-risk class of document
  would be a separate, documented platform-level policy, never a venue
  setting; there is none today.
- **Without a scanner** documents are still taken, into quarantine
  (`pending`), so nothing a customer sent is lost: they wait there, never
  openable, and an application that needs one cannot be approved until a
  scanner is configured and passes it. Applications without documents, and
  in-person steps on them, carry on as before.
- **Scanning again.** Besides the automatic return to quarantine above, the
  platform owner may have a `failed` document scanned again from the
  *Supporting documents* panel (`POST /api/admin/document-policy`, `retry`),
  with a reason; a venue's staff cannot (the document is theirs to review,
  the scanner is the platform's; they ask the applicant for a new file). It
  is allowed only while the bytes are there and their SHA-256 matches the one
  recorded when they were checked, at most three times per document;
  otherwise a new upload is needed, and a document whose bytes are gone or
  changed becomes `unscannable`. A retry puts the same bytes back in
  quarantine for a new round of tries: it never changes them and never
  releases the document; asking again while it waits does nothing more. Every
  request, refused or not, is recorded with the document (who, when, why, and
  once the scan settles its outcome) and in the staff activity log; the
  history goes with the document.
- **Only the server releases a document.** No route takes a scan status; the
  database refuses `clean` without a recorded scan of exactly the stored bytes,
  refuses any change to a settled status but a failed document's return to
  quarantine with its bytes intact (migration 0159), refuses any change to a
  stored document's bytes but the wipe of a rejected one, and any change to
  its recorded hash.
- **Afterwards.** What is left of a rejected or `unscannable` document goes
  after the install's quarantine period (7 days by default), unless a hold
  keeps its application ([privacy](privacy.md#applications-to-be-approved-for-an-activity)).
  The application's history keeps that a document was refused, could not be
  checked, or was put back to be scanned again. Each document removed is
  recorded with the rule that removed it (retention, quarantine or erasure),
  never "no scanner".
- **Health.** The platform owner's *Supporting documents* panel shows whether
  the scanner answers, its engine and signature date and age, documents
  waiting for a scan, waiting for a scanner, refused or unscannable, and
  where documents stored before scanning existed stand; every hour the
  scheduler tells the owners (alert `document-scanner`) when the scanner does
  not answer, none is configured while documents wait, its signatures are
  over 48 hours old or of unknown age, a document has waited over an hour,
  documents wait for a scanner, or one was unscannable
  ([monitoring](../operations/monitoring.md)). `/api/health` stays as thin as
  before: a scanner that is down does not take the site down.
- **Logs** name a document by its number and the signature found, never its
  contents, file name or applicant.
