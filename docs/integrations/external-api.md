# Public API, webhooks and Reserve with Google

The key-authenticated API and signed webhooks for a venue's own systems, and the Reserve with Google feeds.

## Public API and webhooks

For a venue's own systems: a screen at the desk, its own website, a door or
accounting system (`src/lib/api-keys.ts`, `src/lib/public-api.ts`,
`src/lib/webhooks.ts`, migration 0063). Managers set them up under *Venues &
staff → API and webhooks*, which warns that a key sees customers' names and
numbers and a write key can book and cancel.

**Keys.** Each key is for one venue, *read only* or *read and write*, and is
shown once when made; only its SHA-256 is kept. Up to 10 per venue, each
revoked at once and for good. The list shows when each was last used. Calls
are limited to 120 a minute per key.

**API** (`/api/v1`, header `Authorization: Bearer <key>`, JSON):

| Call | Scope | What |
| --- | --- | --- |
| `GET /venue` | read | The venue, its hours and courts with rates |
| `GET /availability?date=&sport=` | read | Each court's slots that day: price, free or not |
| `GET /bookings?from=&to=` | read | Bookings in up to 31 days, cancelled ones too |
| `GET /bookings/<code>` | read | One booking |
| `POST /bookings` | write | `{ courtId, date, hours, name, phone, email? }`: books it unpaid; the customer gets the usual confirmation |
| `POST /bookings/<code>/cancel` | write | Cancels as staff would; the customer is told |

A booking reads `{ code, status, paymentStatus, date, startHour, endHour,
courtId, courtName, sport, name, phone, email, totalPrice, paidByOthers,
coachId, noShow, createdAt }`. A key only ever sees its own venue: another
venue's court or booking is *not found*.

**Webhooks.** Up to 5 HTTPS addresses per venue. Each gets a signing secret,
shown once. `booking.created`, `booking.paid`, `booking.changed` (date, time
or court) and `booking.cancelled` are POSTed as `{ id, type, created, data: {
booking } }`, found by a sweep each scheduler tick that compares every
booking from yesterday to four months ahead with what was last sent
(`webhook_seen`), so a change is caught however it was made. Bookings already
there when an address is added are not sent.

- **Signature:** `MySenam-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
  "<t>.<body>" with the secret>`. Check it, and that `t` is recent, before
  trusting a message; use `id` to recognise a repeat.
- **Retries:** 1, 2, 4… minutes, at most six hours apart, eight tries. An
  address failing for a day is turned off and the venue's staff are emailed;
  *Turn back on* resumes it. *Send a test* sends a `ping`.
- **Only the public internet:** the address must be HTTPS, and a host that
  resolves to a private, loopback, link-local or similar address is refused
  when sending, so a webhook cannot be pointed at the server's own network.
  The check is made by the lookup the connection itself uses, and the
  connection goes to an address that passed it (`pinnedLookup` in
  `src/lib/webhooks.ts`), so a name that answers differently a moment later
  (DNS rebinding) cannot get past it. Redirects are not followed.

## Reserve with Google (readiness only)

Google's Reserve with Google puts a *Book* button on a venue's Google listing,
for booking platforms accepted as Actions Center partners. Being listed needs
three things: partner approval, feeds uploaded on Google's schedule, and a
real-time *Booking Server* Google calls to check and make bookings.

What is here is the second, as a draft (`src/lib/google-feeds.ts`): the
merchant, service and availability feeds, shaped after the Actions Center
feed specification, for venues that ticked *Include this venue in the feeds*
(off by default) and are live and public. A service is one sport for an hour
at one venue, priced from its cheapest off-peak court; availability is how
many of that sport's courts are free at each hour, for 14 days. Platform
owners download them from the same panel. The field names should be checked
against Google's current specification during onboarding. **Not built:** the
Booking Server API, and uploading the feeds.
