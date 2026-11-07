# Public API, webhooks and Reserve with Google

The key-authenticated API and signed webhooks for a venue's own systems, and the Reserve with Google feeds.
The same keys also connect an AI assistant through the [MCP server](mcp.md), which runs this API's code for
reading, booking and cancelling, and hides customers' personal data unless the venue turns it on.

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

**Whose a key or an address is** ([ADR 0064](../architecture/decisions/0064-credentials-follow-their-owners-two-factor-by-default-and-counted-attempts.md),
migration 0312, `src/lib/credential-owners.ts`). Made by a manager, a key or a webhook
address is **that person's** unless they tick *The venue's own*. A person's works only
while its owner is the platform owner, a manager of the venue's business or a manager
(not front desk) of that branch, **read again on every request**: remove the person,
make them front desk, move them to another venue or take the venue out of their
business and it stops at that request (`401`, no secret anywhere), with the log saying
which stopped and why (`integration.changed`, and the account's removal says how many).
A **venue's** key or address does not depend on whoever made it: it keeps working
when they leave, is listed as the venue's with who made it, and a manager can *Take it
over*, *Make it the venue's* or **Rotate** it (a new key, or a new signing secret, shown
once, the old one dead at once), each on the record. A stopped one is never brought
back by handing it over, since its secret was the owner's: it is rotated. Keys and
addresses from before ownership was recorded are the venue's, so nothing in use
stopped when this was built; the removal of a person says how many the venue's keys and
addresses they made keep working, to rotate any that should not. A webhook queued
before its owner left is not sent after. While the venue (or its whole business) is
suspended, a key **reads but does not write**, through the API and the MCP server's
tools (`403` on a write); a person's key at a venue moved to another business stops.

**API** (`/api/v1`, header `Authorization: Bearer <key>`, JSON):

| Call | Scope | What |
| --- | --- | --- |
| `GET /venue` | read | The venue, its hours and courts with rates; a court taking entries with no set time also says so (`entry`: its walk-in `price`, `maxStayMinutes`, `selfCheckIn`; [entry](../features/venue-operations.md#entry-with-no-set-time)). Nobody is let in, or checked out, through the API: entries are the desk's and the customer's own |
| `GET /availability?date=&sport=` | read | Each court's day: when a booking may start and for how long (`starts`, `policy`; a start lists the `lengths` that fit where not every one up to its longest does, as when joining a session on a facility turned over whole), and the day in columns with price, free, partly held or held (`slots`, `grid`) |
| `GET /bookings?from=&to=` | read | Bookings in up to 31 days, cancelled ones too |
| `GET /bookings/<code>` | read | One booking |
| `POST /bookings` | write | `{ courtId, date, start, end, name, phone, email?, players?, participantIds?, customerTakesPart?, concessionId?, placeConcessions?, promoCode? }` (or `minutes` for `end`; or `hours`, the board's column starts, as before; on a court sold by the game, `games` for `end`, held for the venue's estimate of them and the `players`, `GAMES_NEEDED` for a time there, `GAMES_NOT_HERE` for games elsewhere: [by the game](../features/booking.md#by-the-game-and-a-lane-given-on-arrival)): books it unpaid; the booking answers `games`, and where its lane is given on arrival `laneOnArrival: true` with `laneProvisional` until it is checked in (the venue's own system sees the lane held, `courtId`; the customer is not told it); the customer gets the usual confirmation. `players` is how many places it takes on a resource with places (or how many play on a court priced per player), up to the most the venue lets one booking take (`PLAYERS_RANGE` past it). `participantIds`: for people other than the customer (see below). Discounts and the number's checks: see below |
| `POST /bookings/<code>/cancel` | write | Cancels as staff would; the customer is told |
| `GET /bookings/<code>/withdraw` | read | Who is on the booking and whether each can be taken off now, with what it would do (see below) |
| `POST /bookings/<code>/withdraw` | write | `{ placeId \| participantId \| customer: true \| unnamed: n, reason? }`: takes one person (or places nobody is named on) off, the others staying booked, as the counter does (see below) |
| `GET /waitlist?date=` | read | The venue's waiting lists that day: court time on its resources and its classes, each entry with who made it (`madeBy`); never an offer's token |
| `POST /waitlist` | write | `{ courtId, date, start, end }` or `{ classId }`, with `name, phone, email?, participantIds?, customerTakesPart?, confirmWho?, locale?`: queues somebody for taken time or a full class, as the counter does (see below) |
| `DELETE /waitlist` | write | `{ entryId }`: takes off an entry the venue made (at its counter or through its API); one its customer made online is theirs to leave (409) |

Times of day are minutes from the venue's midnight on the booking's date
(`1087` is 18:07; past `1440` is after midnight) or `"HH:MM"`. A booking must
keep to the court's booking rules (start times, lengths, notice), as on the
venue's page; the refusal says which rule. A booking reads `{ code, status,
paymentStatus, date, startMin, endMin, startsAt, endsAt, startHour, endHour,
courtId, courtName, sport, name, phone, email, totalPrice, paidByOthers,
depositPaid, coachId, noShow, createdAt, players }`: `startsAt` and `endsAt` are the
moments themselves (ISO 8601, UTC); `startHour` and `endHour` are the same
times in hours, kept for clients written before minutes. A key only ever
sees its own venue: another venue's court or booking is *not found*.

**Booking for somebody else** (added 2026-10-26; additive, nothing existing
changed, so not versioned). `participantIds` books for people other than the
customer, a child most often, and `customerTakesPart: true` gives the
customer a place too ([booking for somebody else](../features/booking.md#booking-for-somebody-else)).
Each takes a place and is checked on their own sign-offs, certifications and
approvals, as the venue's own staff would check them. What a key can do is
bounded so that it never stands in for a guardian:

- Only participants the venue already knows (added at its counter, or with a
  booking, application, sign-off, induction, waiver, concession proof,
  membership or pass there or at another branch of its business; see
  [privacy](../architecture/privacy.md)); anybody else is *not found* (404). A key creates
  no participant and reaches no other venue's.
- `phone` must be a live guardian's of every participant named (their
  account's number, or the number staff recorded with the guardian's
  declaration): the booking is made with, and told to, somebody who acts for
  them. Otherwise `PBK_NOT_GUARDIAN` (409).
- Where the venue has a waiver, the guardian's agreement to it for each
  participant must already be on record: a key cannot give it
  (`WAIVER_NEEDED`, 409). A missing sign-off or approval is refused as for
  any booking (`SIGN_OFF_NEEDED`, `CERTIFICATION_NEEDED`); eligibility is the
  participant's own, never the customer's or anybody else's. So is a
  membership: at a members-only venue, a participant taking a place on a
  shared session needs their own membership, or a family membership naming
  them, valid on the session's date (`ENT_MEMBERS_PLACE`, 409, `vars.name`;
  `MV6_ENDS_BEFORE` with `vars.until` where theirs ends before it; the
  customer's own place likewise, `MV6_OWN_ENDS_BEFORE` or
  `MV6_OWN_NOT_MEMBER`, by the number given;
  [who a venue is for](../features/booking.md#who-a-venue-is-for-public-members-only-private)).
- The booking is recorded as made by the venue's system: in each
  participant's history as the key (`API key <id>`), and on each place.

**Discounts and the number** (added 2026-10-27; additive: a request
without the new fields books as before, at the same price). A booking
through the API takes the discounts the booking form and the counter take,
through the same function, so the same request gives the same price
([discounts together](../features/pricing.md#discounts-together)):

- `concessionId`: one of the venue's concessions for the whole booking (or
  the only place on it), on the venue's word as its counter takes it: the
  booking says what proof to bring, and staff look at it when the person
  arrives.
- `placeConcessions`: `[{ participantId, concessionId }]`, one person's own
  concession on their place (`participantId: null` for the customer's), on a
  booking priced by the place.
- `promoCode`: a code, as a customer would type it.
- `expectedTotal`: the price the system was quoted, in whole cents (`400` for anything else). Where the booking now costs another price (a rate edit, a code that ran out, a lapsed membership) it is refused with `409 PRICE_CHANGED` (`vars.amount`, `vars.cents`: the price now) and nothing is kept ([ADR 0054](../architecture/decisions/0054-money-paid-never-above-price-and-no-silent-price.md)).

They go on in the one order (concessions, then the code on what is left),
with the venue's rule on discounts together, the same rounding, each place's
share of a code recorded, and the code's limits counting every path's uses.
Each is best-effort: one refused leaves the booking standing at the price
before it, and the response says why beside `booking`: `concessionError`
(`{ error, code }`), `promoError` and `promoErrorCode` (`ONE_DISCOUNT`,
`STK_NOT_COMBINABLE`, `PROMO_NOT_LAST_MINUTE`, `PROMO_YOUR_LIMIT`…), and
`discount`, what the code took off. A malformed field is refused whole (400).

The booking is held to the venue's policies as the booking form and the
counter are ([the same policies on every path](../features/booking.md#the-same-policies-on-every-path);
`policyCheck` in `src/lib/limits.ts`), each refusal 409 with nothing booked,
under the booking form's code: the venue open, who may book a members-only
or private venue (the number, on the venue's word, holding a membership or
on the list on every date booked, or each person named where only they take
places: `R9_NOT_MEMBER`, `R9_NOT_LISTED`, `ENT_MEMBERS_PLACE`), the house
rules (`LIMIT_UPCOMING`, `LIMIT_WEEK`, `LIMIT_DAY`, `LIMIT_AHEAD`), the guest
limit (`GUEST_SURGE`), a number the venue refuses (`PHONE_BLOCKED`), no-show
strikes (`STRIKES_COUNTER`), the unpaid-bookings limit (`PHONE_LIMIT_VENUE`,
`PHONE_LIMIT_ALL`), and the customer's own agreement to the venue's waiver
already on record (`WAIVER_NEEDED`), as each participant's is. A key takes no
money, so what online is held until paid and the counter takes payment for
(strikes, the guest limit) is refused; book it at the counter. A key never
overrides the venue's policies: `overridePolicies`, `overrideReason`,
`paidAtCounter` or `override` sent with a booking or a waiting-list entry is
refused (`R9_API_NO_OVERRIDE`, 400), never ignored.

`guestOf` (the host's phone number) books the person as a member's or
resident's guest at a members-only or private venue, as the counter does
([members' and residents' guests](../features/booking.md#members-and-residents-guests-at-the-counter-and-through-the-api)):
the host must be a resident or member on the venue's list for the date
(`GC8_HOST_NOT_FOUND`), and the guest goes on the list as theirs until that
date, counted against the host's guest allowance (`GC8_GUEST_ALLOWANCE`,
`GC8_GUESTS_OFF`, `GC8_GUEST_DAYS`, 409), which a key never goes past. A
number on the list in its own right is booked as itself (`GC8_GUEST_LISTED`);
a public venue has no allowance (`GC8_GUESTS_NOT_HERE`, 400). Bookings made
through a key count towards the limit on online bookings without an account
(`GUEST_SURGE`) as online ones do.

Every booking the API returns (`POST`, `GET /bookings`, `GET /bookings/<code>`)
now also carries `participants`: `[{ participantId, name, customer }]`, each
person taking a place where the booking names somebody other than its
customer (with `customer: true` for the customer taking a place alongside
them), and `[]` for a booking its customer takes alone. Webhooks carry the
booking as before.

**Waiting lists** (added 2026-10-27; additive). A write key queues somebody
who asked the venue's own system for taken court time or a full class, as
its counter does ([at the counter and through the API](../features/booking.md#at-the-counter-and-through-the-api)):
on the venue's word for the name and number, under the same rules as joining
online (a refused number, the house rules, the unpaid-bookings limit, the
court's booking rules, a members' place each participant's own, a women-only
or men-only class said for with `confirmWho: true`, nobody queued twice:
`ALREADY_WAITING`). `participantIds` are bounded as for a booking above:
known to the venue, a live guardian on `phone`, the waiver already agreed.
The entry reads `{ id, classId, courtId, date, start, end, label, name,
phone, status, places, customerTakesPart, participants, madeBy, locale, createdAt }`
with the place in the queue (`position`). When the place frees, the offer
goes to that number and email by the usual messages, in `locale` (English if
not given), and is claimed by its link; the key never sees the offer's
token. The entry is checked again at the offer and the claim as the API
checks a booking: the number's checks above (a number refused since leaves
the queue; the house rules, the unpaid-bookings limit or strikes make it
wait; see [waitlists](../features/booking.md#waitlists)); the booking
claimed from it is made as the API makes one. Each join and removal is in the staff activity log as the key
(`API key <id>`). Another venue's court, class or entry is *not found*.

**Taking one person off a booking** (added 2026-10-28; additive). A write
key does what the venue's counter does
([taking one person off a booking](../features/booking.md#taking-one-person-off-a-booking)),
through the same code: on the counter's terms (up to the end of the
booking, in full, never the customer's late-cancellation share), with the
same refusals (`ENT_WITHDRAW_LESSON`, `_CLASS`, `_GAME`, `_SHARED`,
`_DEPOSIT`, `_PAGE_OPEN`, `_SOLD_WHOLE`, `_ATTENDED`, `_LAST`, `_NOT_ON`,
`_NO_PLACES`, `KIT_STILL_OUT`, `CANCEL_PLAYED`; 409) and the same money: off
what is owed, or back the way it was paid (to credit, owed back on the
online payment and sent now, a credit note on a company or school account,
pass entries back). `GET` answers `options`, each person with `placeId`,
`participantId`, `name`, `who`, `allowed` or `refusal`, and `price`,
`refund`, `kept`, `owedLess`, `units`, `how`, `deposit`; `POST` answers
`booking` (as `GET /bookings/<code>`), `withdrawal` and `refunds`. The
customer (the guardian) is emailed who is off; the participant's history and
the staff activity log (`booking.place_withdrawn`) name the key
(`API key <id>`), and so does the withdrawal's record. Another venue's
booking is *not found*.

A `POST` may carry an `Idempotency-Key` header (1 to 255 printable
characters, a UUID for instance), the only call that takes one: sent again
with the same key (a timeout, a retry), it answers with the withdrawal it
made (`replayed: true`) and takes nobody else off, nor tells anybody again;
the same key on a different request (another booking, somebody else, another
number of places) is refused (422). Without a key, taking a named person off
twice is refused the second time (`ENT_WITHDRAW_NOT_ON`), but `unnamed`
places are taken off again by each request: send a key with those.

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
- **Given up on, not lost** ([ADR 0066](../architecture/decisions/0066-operations-hardening-grants-deliveries-leases-and-the-worklist.md)):
  a delivery that used its eight attempts stays in the delivery list, held 30 days
  like any delivery ([retention](../architecture/privacy.md)), with its last status,
  last error, when it was last tried and how many times, shown under its address in
  *Events that could not be delivered* (never the payload, which names the customer).
  A manager of the venue can *Send again* one delivery, or all of an address's (at
  most 50 a time): the **same payload, so the same event `id`**, signed afresh, attempts
  counted from nothing. A receiver can use the `id` to ignore a repeat. Pressing it
  twice, or two managers at once, sends it again once. It is refused while the
  address is turned off (turn it back on first). Each press is in the activity log.
  *Sent* means MySenam made the request and got a 2xx: it never means the receiver
  processed the event. Tested only against a stand-in receiver, never a real one.
  Events missed because the address was off, or for a booking more than two days old or
  further than 120 days ahead when first seen, are still not replayed ([known limitations](../roadmap/known-limitations.md)).
  *Turn back on* resumes it (not one stopped because its owner left: that is rotated).
  *Send a test* sends a `ping`.
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
at one venue for the length its booking rules offer first,
priced from its cheapest off-peak court; availability is how many of that
sport's courts may start such a booking at each allowed start, for 14 days. Platform
owners download them from the same panel. The field names should be checked
against Google's current specification during onboarding. **Not built:** the
Booking Server API, and uploading the feeds.
