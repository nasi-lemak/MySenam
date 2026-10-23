# Personal data and retention

Authoritative for data export, erasure and the retention schedule.

Malaysia's PDPA gives a person the right to see what is held about them and to
have it removed, and expects data to be kept no longer than its purpose needs.
Three obligations, three functions in `src/lib/privacy.ts`: **export**, **erasure**,
**retention**.

## A phone number is not identity

This is the constraint everything else follows from. A phone number typed
into a booking form or a registration form proves nothing: anybody can type
any number. An account *can* prove its number with a code
([checking a customer's phone number](authentication.md#checking-a-customers-phone-number)),
which is recorded as `users.verified_phone`, but bookings, passes and
memberships made at a counter or as a guest carry only a typed number. Keying
"your data" on the phone number would therefore mean:

- **registering with a stranger's number dumps their booking history**, and
- **closing that account cancels the stranger's upcoming courts.**

So export and erasure follow `user_id` and nothing else, and the account
page lists passes and memberships by account, not by matching the account's
phone number against the one a pass was sold to (a pass code is bearer
money). Where a proved number is what grants something — charging a company
account, for example — the code compares `verified_phone`, never the typed
one. `tests/impersonation.test.ts` holds this rule.

That leaves a real question the counter has to answer: a pass sold across a
desk has no account on it. Staff can add one at the point of sale — there is an
"account email (optional)" field on both forms — and email is the right key
because an account is identified by it, exactly one account can hold it, and
the person is standing there to say it. A pass with no account on it simply
does not appear on anybody's page, and the page says so rather than implying
nothing was sold.

Memberships are different on purpose. A membership is held against the phone
number so that a member who books as a guest, without signing in, still gets
their price — which also means anybody who types that number gets the member
rate. That is a discount the venue chose to make easy to claim, not a hole; it
costs the difference between two rates, and it is pinned by a test so that
changing it is a decision rather than an accident.

## Asking a venue in person

The account page's *Download my data* (`/api/my/data`) covers what is filed
against the account: bookings, credit, passes and memberships sold to it,
games, leagues, tournaments, receipts and credit notes, waiting-list places,
gift vouchers used, and the messages still kept about its bookings or sent to
its address. Its file says what it leaves out: anything filed against a phone
number at a counter.

For that, the venue's manager has *Venues & staff → A customer's data*
(`/api/admin/data-request?venueId&phone`). After checking who is asking, the
manager downloads everything that venue holds against the number, however it
was typed: bookings with arrivals, no-shows and late cancellations, waiting
lists, passes, memberships, inductions, the venue's own list, blocks,
receipts, gift vouchers bought and WhatsApp messages. It reaches that venue
only. It is for managers only (front desk is refused), and each download goes
in the activity log with the last four digits of the number.

## Erasure keeps the books

A booking is also the venue's accounting record, so "forget me" cannot mean
"make the takings disappear". Closing an account:

- cancels upcoming bookings made from it, releasing the courts;
- replaces the name, phone and email on every booking it owns with `(removed)`,
  **keeping the hour and the price**;
- strips the holder from spent passes and lapsed memberships;
- takes it off every waiting list it joined, passing a place it was waiting
  for or had been offered to the next person, and deletes those entries;
- deletes the account and its sessions;
- also removes, by the account's numbers, staff notes, places on company
  accounts' booker lists, concession proofs, private hire enquiries and
  marketing consent; and keeps signed waivers, as the venue's record of
  consent ([venue operations](../features/venue-operations.md#waivers)).

It refuses while the customer is owed something — stored credit, a live pass, a
running membership — because `wallet_entries` cascades from `users`, so erasing
the account would destroy the only record of whose money the venue is holding.

## Retention

| What | Kept | Then |
| ---- | ---- | ---- |
| Door codes shown | 180 days | deleted |
| Arrivals at the desk | 365 days | deleted |
| Phone check codes and links | 1 day | deleted |
| Settled waiting-list entries | 90 days | deleted |
| WhatsApp and email messages, once sent or given up on | 90 days | deleted |
| Webhook deliveries to a venue's own systems, delivered or given up on | 30 days | deleted |
| Names and numbers on bookings | 730 days | anonymised, money kept |
| Withdrawn out-of-hours access | 365 days | deleted |
| Venue applications never confirmed by email | 7 days | deleted |
| Private hire enquiries | 365 days | deleted |
| Draft venues never live, nobody signed in | 90 days | deleted, unless they hold a customer's pass, membership, credit or payment |
| Expired sessions | — | deleted |

Door logs go first and shortest: they tie a named person to a time and a
building, which is the most sensitive thing here and the least useful once an
incident window has passed.

The scheduler applies the policy once a day; where it is turned off, it
applies itself the first time anyone opens the dashboard each day. An owner can see what is due, when it last ran, and
run it early, under *Venues & staff → Keeping nothing too long*.

**`/privacy` is not legal advice.** It describes what the software actually
does, which is the hard part, in each of the site's languages (Bahasa Malaysia,
English, Chinese and Tamil, none checked by a translator or a lawyer). PDPA
also expects a named person to write to: with `OPERATOR_NAME` and
`OPERATOR_EMAIL` set (and `OPERATOR_ADDRESS`, if there is one), the notice
names them under *Who to write to*; without them it says there is nobody yet.
Have a lawyer read it before taking a real customer's booking.

How much data an install accumulates, and why bookings stay in plain Postgres
rather than TimescaleDB, is in
[ADR 0004](decisions/0004-plain-postgres-not-timescaledb.md).
