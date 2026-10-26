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

## Rate limiting

Password endpoints and anything addressable by a short code are rate limited
per client IP (`src/lib/rate-limit.ts`), returning `429` with `Retry-After`:

| Endpoint | Budget |
| -------- | ------ |
| Admin & customer sign-in | 10 per 10 min, per pair of IP and email; and 20 wrong passwords per 30 min for one account from any address (a right password is never counted; somebody failing on purpose can hold an account at this for the window) |
| Forgot / reset / change password | Same budget as signing in |
| Registration | 5 per hour |
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
series counts once. Staff booking at the counter are not limited.

**Blocked numbers.** A venue can stop a number booking or queueing with it
online: *Block number* on any booking, or under *Venue details → Blocked
numbers*. That person can still ring the venue.

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
`src/lib/approval-documents.ts`; [ADR 0021](decisions/0021-approval-retention-and-pdf-documents.md)).
Such a document may hold sensitive personal information, so:

| Control | What it does |
| ------- | ------------ |
| Asking only for what is needed | The venue names the document and says why; never an identity document (a label or reason naming one is refused) |
| Size and number | Up to three per application, 10 MB each, refused before the upload is read whole where its size is declared |
| Type by content | What a file is comes from its first bytes (`%PDF-`, or a JPEG, PNG or WebP signature), never its name or declared type; a name or type that disagrees is refused, so a renamed program, or HTML or SVG called `.pdf`, is refused |
| Images | Redrawn as WebP, as venue photos are: nothing of the upload survives but its pixels |
| PDFs | Never rendered or run on the server. Refused if encrypted; if its dictionaries, or its object streams (decompressed, within 40 MB), name JavaScript, an action on opening other than a page to open at, additional actions, Launch, GoToR, GoToE, SubmitForm, ImportData, media, attached files, rich media or XFA, however the name is escaped; if it has more than 20 pages or none; or if it cannot be checked (no end marker, an object stream with another filter or a predictor). Otherwise kept as sent |
| Storage | In the database (`approval_documents`), never in the public photo store or any public URL; deleted by the retention rules ([privacy](privacy.md#applications-to-be-approved-for-an-activity)); no temporary files |
| Who may open one | The applicant; the venue's staff; a coach the venue authorised for that activity there, signed in to the MySenam account the venue linked to them. Another venue's staff, another customer, another coach or nobody signed in gets nothing |
| Handing it out | Through the app only: `Content-Disposition: attachment` for a PDF (a redrawn image inline), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, and a content security policy of its own (`default-src 'none'; sandbox`, set by the middleware for these paths instead of the pages' policy) |
| Record | Every opening: who (customer, staff member or coach), which document, when (`approval_document_access`), kept 730 days and given to the customer with their data |

These checks stand in for malware scanning, which the platform does not buy:
they keep out the PDF features attacks use, not every flaw a PDF reader might
have. Reviewers open a PDF in their own reader, outside the app's origin; no
preview is made.
