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

Memberships follow the same rule online. A membership is still sold against a
phone number, and at the counter (or through the venue's API key) staff take
the number on their word, since they see or know the person. Online, its rate,
its longer booking window and entry to a members-only venue or tournament go
only to the account it is linked to (`memberships.user_id`, set when it is
bought online or when staff sell it to an account), or to the account whose
own number it is, proved with a code. A guest, or an account that only typed
the number in, books at the public price. Until October 2026 typing the number
was enough, a trade made so members need never sign in; the owner decided a
typed number is not identity, and the old rule's test now pins the new one
(`tests/impersonation.test.ts`, `tests/member-identity.test.ts`). The same goes
for an account's waiting-list places: those it joined, or on its proved
number, not every place queued on a number it typed.

## Asking a venue in person

The account page's *Download my data* (`/api/my/data`) covers what is filed
against the account: bookings, credit, passes and memberships sold to it,
games, the playing profile, people blocked, reports made and community
groups, leagues, tournaments, receipts and credit notes, waiting-list places,
gift vouchers used, and the messages still kept about its bookings or sent to
its address. Its file says what it leaves out: anything filed against a phone
number at a counter.

For that, the venue's manager has *Venues & staff → A customer's data*
(`/api/admin/data-request?venueId&phone`). After checking who is asking, the
manager downloads everything that venue holds against the number, however it
was typed: bookings with arrivals, no-shows and late cancellations, waiting
lists, passes, memberships, inductions, activity sign-offs, the venue's own list, blocks,
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
- takes it out of open games still to come, passing a freed place on, and
  deletes with the account its playing profile, blocks either way, reports
  about it, community memberships and the groups it organised; reports it
  made stay with the reporter's name removed;
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
| Withdrawn activity sign-offs | 365 days | deleted |
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

## Where personal data is kept

Four places are distinct, and none implies another: the **operating
company** (`OPERATOR_*`, who runs the install), the **venue's country**
(`MYSENAM_COUNTRY`: one install per country), the **customer's country**
(a Singaporean booking a court in Johor is still on the Malaysian install),
and the **hosting location** (where the database server, the photo bucket
and the off-site backups are). The app does not decide the hosting location;
the operator does, and the privacy notice and venue agreements must say it.

**Who is responsible for what is not settled, and needs a lawyer's view.** A
reasonable starting position, from the regulators' guidance, is that for a
venue's bookings the venue decides why the data is held and MySenam processes
it for the venue (Malaysia: controller and processor; Singapore: organisation
and data intermediary), while for customers' own accounts — one sign-in
across venues, the platform's own messages — the operator is responsible in
its own right. A backup provider is the operator's processor either way.
Neither Malaysia's PDPA nor Singapore's requires data to stay in the country;
both allow transfers abroad on conditions.

### Backups held abroad

Backblaze B2, the preferred off-site provider
([ADR 0015](decisions/0015-backblaze-b2-preferred-signed-backup-sets.md)),
has no region in Asia. Every copy, from either install, goes to the US
(recommended), Canada or the Netherlands. **Neither country forbids that.**
Both allow a transfer abroad when a lawful basis is in place, and neither makes
consent the general rule. This section is the operator's working analysis
from the regulators' guidance, **not legal advice and not legal approval**.
The open points at the end are for a lawyer.

The app's part is narrow:

- it refuses to send until the destination is declared, and checks the
  declaration against the endpoint;
- it refuses a destination abroad until `OFFSITE_TRANSFER_APPROVED` names it
  and encryption is on
  ([backups](../operations/backups.md#where-the-data-may-go)).

Setting that variable is the operator's statement that the steps below are
done and recorded.

**Encryption is a safeguard, not the basis.** Copies are encrypted on the
server with a key Backblaze never holds, so Backblaze stores ciphertext.
That reduces the risk a transfer impact assessment weighs, and supports the
security obligation. Neither regulator says encrypted data stops being
personal data, or that its storage abroad stops being a transfer. Treat it as
a transfer.

**Singapore (PDPA s26; PDP Regulations 2021, regs 9–12):** before
transferring, take appropriate steps to ensure the recipient is bound by
legally enforceable obligations giving protection at least comparable to the
PDPA. The lawful mechanism to use is a contract, which must:

- give comparable protection;
- name the countries the data may go to;
- for a data intermediary such as a storage provider, cover protection,
  retention and breach notice to the operator (PDPC Key Concepts guidelines,
  chapter 19).

The PDPC encourages the ASEAN Model Contractual Clauses. The guide on cloud
services adds two points:

- the organisation stays responsible wherever the provider is;
- certified data centres (ISO 27001) with a SOC 2 report can count as
  appropriate steps where the provider chooses locations. Here the operator
  chooses the region.

Backblaze holds no Global or APEC CBPR or PRP certification that could be
found, so the certification route is not available. Consent (reg 10(2)) is an
alternative, but the PDPC prefers the others, and it cannot be made a
condition of service; it is not the route here.

**Malaysia (PDPA s129, as amended by Act A1727; Cross Border Personal Data
Transfer Guideline, April 2025):**

- **The two routes.** The Minister's whitelist is gone. A transfer is
  allowed where the destination has a law substantially similar to the PDPA,
  or ensures an adequate level of protection, as assessed in a transfer
  impact assessment (TIA, valid up to three years), or under an exception in
  s129(3).
- **The route here is s129(3)(f).** That exception asks for "all reasonable
  precautions and all due diligence", shown by contract clauses (the ASEAN
  Model Contractual Clauses or the EU Standard Contractual Clauses are
  named), backed by a TIA of the US.
- **Records.** For each transfer, keep the recipient, the country, the kinds
  of data, the purpose and the evidence (TIA, contract, certifications).
- **Source.** The official guideline text could not be reached when this
  was written; these points come from law-firm summaries of it, and should
  be checked against the text.

**What the operator does and records, for both countries:**

1. **Due diligence on Backblaze**, filed:
   - its [DPA](https://www.backblaze.com/company/dpa.html), incorporated in
     its Terms, and the EU SCCs Module 2 inside it;
   - its sub-processor list (US data centres also hold every account's
     account data);
   - its law-enforcement policy (valid US process only, customer notified
     unless barred);
   - its SOC 2 Type 2 report (the data centres, not Backblaze, hold ISO 27001);
   - breach notice "without undue delay".
2. **A contract that binds Backblaze** to comparable protection and names
   the country. Whether the click-through DPA, written for GDPR customers,
   does that for Malaysian and Singaporean data, or an addendum with the
   ASEAN clauses is needed, is the first question for the lawyer.
3. **A TIA of the US** (Malaysia; also a sound record for Singapore). It
   covers:
   - US data-subject rights and US government access;
   - the safeguards in place: encryption with the operator's key, Object Lock,
     least-privilege keys, signed sets;
   - the residual risk;
   - a review date, at most three years on.
4. **The privacy notice and venue agreements** name the country of
   off-site backups, how long they are kept (about 15 days), and that they
   are encrypted.
5. **A transfer register entry**: what goes (database and photos archive),
   to whom (Backblaze, the region), why (disaster recovery), the mechanism and
   the evidence, and when it is next reviewed.
6. **A breach plan** that meets Malaysia's and Singapore's notification
   deadlines, covering a breach at the provider.

**Who is responsible.** Venues are the controllers (organisations) for their
bookings, with MySenam processing for them. The operator is responsible in its
own right for customers' accounts (above). The off-site transfer is the
operator's decision and its processor contract, made on venues' behalf:

- venue agreements should say backups are held abroad, and under what
  safeguards;
- venues need not each contract with Backblaze;
- venues stay answerable to their customers and should be told where their
  data goes.

A bucket in the install's own country (Amazon S3 in Malaysia or Singapore)
avoids the transfer question for that country's data, but not the processor
agreement, security or retention duties. Backups age out with the bucket's
lifecycle rule (about 15 days), so data erased or anonymised here is gone from
them within that window; the privacy notice should say so.

**For a lawyer to confirm before `OFFSITE_TRANSFER_APPROVED` is set:**

1. Whether Backblaze's GDPR-oriented DPA, accepted by click-through, is a
   legally enforceable contract meeting Singapore's reg 11 (which needs named
   countries) and Malaysia's s129(3)(f), or whether an ASEAN-clause addendum
   is needed.
2. Whether encryption with the key held only by the operator changes either
   analysis.
3. For Malaysia: whether the s129(2) route or s129(3)(f) is the right one,
   whether a TIA is required or advisable, and how US government access is
   weighed, checked against the official guideline text.
4. The commencement date of Act A1727 and the guideline's paragraph numbers.
5. Whether account data Backblaze keeps in the US (the operator's contact and
   billing details) is a separate transfer.
6. Whether a provider SOC 2 report without its own ISO 27001 is enough for
   the PDPC's appropriate steps.
7. Backblaze's actual CBPR/PRP status, in the official directories.
8. Each party's role for venue data and account data, and what that means for
   registration, a data protection officer and breach notices; the exact
   Malaysian breach-notice deadlines and thresholds.

How much data an install accumulates, and why bookings stay in plain Postgres
rather than TimescaleDB, is in
[ADR 0004](decisions/0004-plain-postgres-not-timescaledb.md).
