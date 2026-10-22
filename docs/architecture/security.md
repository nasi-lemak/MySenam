# Security and abuse prevention

Authoritative for rate limits, phone-number limits and other abuse controls. Sign-in is in [authentication](authentication.md); tenant boundaries in [tenancy](tenancy.md).

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
