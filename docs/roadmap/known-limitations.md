# Known limitations and gaps

Authoritative list of what is known to be wrong, missing or unverified, kept
apart from what works ([feature status](../product/feature-status.md)) and
from ideas ([roadmap](roadmap.md)). First recorded by the
[documentation audit](../audits/documentation-2026-10-22.md) of October 2026. The numbered
defects it found (S1–S8, B1–B8, M1–M11) have since been fixed, each with a
test. So have those found since (S9–S11, B9, B10, B12–B16, M12–M15), all but
B11; every fixed one is under [fixed since the audit](#fixed-since-the-audit).
Reconciled against the code and tests on 24 October 2026.

[What the launch depends on](#what-the-launch-depends-on) sorts what is open
by whether it affects the first launch, and gives each consequential item an
action for the owner or a decision to make. The sections after it hold the
detail.

Priorities:

- **P0** — critical security, data-integrity or financial-correctness issue.
- **P1** — required for a reliable production launch.
- **P2** — important for broader adoption or operational efficiency.
- **P3** — optional enhancement.

## What the launch depends on

The first launch is taken to be one Malaysian install in marketplace mode
with a few pilot venues, whose customers pay at the counter or online through
each venue's own Billplz account, with no fee charged to venues until the owner
sets a price
([launch providers](../integrations/launch-providers.md#launch-stack-and-what-is-still-to-decide),
[pricing](../business/pricing.md#free-trials-and-pilot-offers)). A Singapore
install is a later launch of its own; for it, Stripe moves into the first
table. No P0 is open.

### Blockers for any launch

Each must be done, or its risk accepted by the owner and recorded here,
before the first real customer. The rest of the
[launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)
(secrets, the scheduler's heartbeat, monitoring, a real venue end to end)
applies too; these are the items where something is missing today.

| Blocker | Why it matters | Owner action |
| ------- | -------------- | ------------ |
| Email has never been sent through a real provider ([integrations](#integrations-awaiting-live-verification-or-a-partner)) | Booking confirmations, password resets and every game, tournament and league message go by email | Open the SMTP account, set SPF, DKIM and DMARC on the sending domain, set `SMTP_URL` and `MAIL_FROM`, and pass the email check |
| Off-site backups have never been written to a real bucket ([backup and restore](#production-readiness)) | Without an off-site copy, losing the server loses every booking and balance | Backups may be held abroad (the owner, 24 October 2026): open the Backblaze B2 bucket (US West), do and record the transfer steps in [privacy](../architecture/privacy.md#backups-held-abroad) with a lawyer's answers to its open points, then set `OFFSITE_DATA_LOCATION=US` and `OFFSITE_TRANSFER_APPROVED=US`, pass `npm run verify-offsite -- --go` and the drill on an isolated server ([backups](../operations/backups.md#verifying-a-real-bucket)) |
| `/terms` and `/privacy` are unreviewed drafts ([gaps](#gaps-in-verification-and-documentation)) | Legal exposure from the first customer | A Malaysian lawyer reviews both and their translations; set `OPERATOR_NAME` and `OPERATOR_EMAIL` |
| The breach-notification rules are not confirmed, and nobody is named to lead an incident ([gaps](#gaps-in-verification-and-documentation)) | A breach could be reported late, or to the wrong party | A lawyer confirms the Malaysian rules in [incident response](../operations/incident-response.md#a-suspected-breach-of-personal-data); the owner names the incident lead |
| Customer pages, messages and invoices in Malay, Chinese and Tamil, and the staff dashboard in Malay and Chinese, are machine-assisted, partly never reviewed by a native speaker ([languages](#languages)) | The launch promises all four languages (the owner, 24 October 2026): a wrong phrase in a booking, refund or invoice misleads the customer who relies on it | A native speaker of each reviews what [languages](#languages) lists, Tamil first; or the owner accepts the risk for a language here |
| The operating company and where the data is hosted are not decided ([launch providers](../integrations/launch-providers.md#operating-company-and-jurisdictions)) | The privacy notice, the provider contracts and the gateway accounts all name them | The owner decides the entity, its tax registration and the hosting country, and has them written into the privacy notice and venue agreement |

### Blockers only where a feature is switched on

None of these stops a launch that leaves the feature off. Each must be done
before the feature is used with real customers.

| Feature, and what switches it on | What must happen first | Owner action |
| -------------------------------- | ---------------------- | ------------ |
| Online payment at a Malaysian venue: the venue connects Billplz | The Billplz check: a sandbox bill paid by FPX and by card, a tampered callback refused, an expired hold's bill expiring. Refunds are by hand (accepted for a small launch, [launch providers](../integrations/launch-providers.md#launch-stack-and-what-is-still-to-decide)) | Pass the check before the first venue takes money online; until then venues take payment at the counter |
| Stripe: a Singapore install, membership renewals, or the platform's own invoices through Stripe | The Stripe test-mode check: checkout, webhook, refunds, a dispute, a renewal. Refund reconciliation is tested against a stand-in only ([money](#money-m)) | Pass the check before switching any of them on |
| Charging venues a fee: `MYSENAM_VENUE_FEE`, plan tiers, or a venue's own fee | The price decided. Once a fee or tiers are set, `/pricing` says "no setup fee, no contract": commercial terms nobody has decided ([pricing](../business/pricing.md#open-decisions)). The platform's invoices need a verified gateway | The owner decides the price and those two claims before setting any fee |
| Phone checks by WhatsApp or SMS: `WHATSAPP_TOKEN`, `SMS_TWILIO_ACCOUNT_SID` or `SMS_HTTP_URL` | A live send; every WhatsApp template approved by Meta word for word; in Malaysia, a registered SMS sender | Pass the phone check. Without phone checks, numbers are taken as given (a decision below) |
| Money kept from a hire deposit: a venue deducts from one | The venue's tax adviser's review recorded under *Tax*; until then every amount kept is marked provisional ([money](#money-m)) | Each venue's manager records it before the first real deduction; the owner tells pilot venues so |
| E-invoicing: `MYINVOIS_CLIENT_ID` | The MyInvois sandbox check with the venue's own TIN and certificate | Only for venues that must e-invoice, and for the platform if it must |
| Google sign-in: `GOOGLE_CLIENT_ID` | The redirect URI registered | Register it before switching on |
| Photos in a bucket: `PHOTOS_S3_BUCKET` | A photo uploaded and served from the real bucket | Needed before running more than one instance |
| More than one app instance | Not measured; shared rate limits, one secret and a photo bucket are needed ([production readiness](#production-readiness)) | Re-run the benchmark on the production set-up before scaling out |
| A tournament under a governing body's rules | Sport templates are club practice ([tournaments](#booking-and-availability-b)) | The organiser checks and sets the rules before the draw |

### Decisions the owner has to make

Consequential limitations with no fix planned for the launch. The code's
present behaviour stands until the owner decides; each row gives a
recommendation, not a decision. A decision is recorded by changing the row to
*accepted* (with the date) or by moving the work into the
[roadmap](roadmap.md).

| Limitation | What happens today | Recommendation |
| ---------- | ------------------ | -------------- |
| Email bounces are not read back ([operations and security](#operations-and-security-s)) | *Sent* means the mail server took it; a venue's own cancellations and moves stay under *Needs attention* until staff know the customer heard | Accept; the owner looks at bounces in the provider's dashboard each week |
| Giving the court back late, without a refund ([booking](../features/booking.md)) | Off for every venue until a manager turns it on | Keep it off by default and suggest it at onboarding to venues with evening drop-outs |
| Cancellations by the venue refund online payments on some paths only ([money](#money-m)) | Closing a day and a rain-out refund online payments by themselves; a court taken out of service and a cancelled class (also when a day is closed) leave them in *Refunds owed* for staff | Refund by themselves on every path where the venue cancels, as a closed day does: the customer did nothing, and the refunds owed list stays for manual venues |

### Accepted

Decided, with the reason recorded where they are described:
[deliberately unsupported](#deliberately-unsupported) (including one country
per install); no
CSRF token, by design ([security](../architecture/security.md#requests-from-another-site));
continuous integration deferred for cost (the owner, October 2026): no paid CI,
each release checked by hand and its record kept in
[release records](../development/testing.md#release-records), which is what
the commit to be launched is judged by;
Billplz refunds by hand for a small Malaysian launch
([launch providers](../integrations/launch-providers.md#launch-stack-and-what-is-still-to-decide));
negative stored credit after a chargeback, reported apart (M14);
the booking defaults put for review (the owner, 25 October 2026): minimum
separation between neighbours no longer adds up while setup and cleaning
time does ([booking time model](../architecture/booking-time-model.md)),
eight places per booking unless the venue allows more, up to every place,
and first lessons and registrations applied for online and approved remotely
([activities](../features/activities.md#registering-online-for-approval));
the launch promises customers English, Malay, simplified Chinese and Tamil
(the owner, 24 October 2026), and the staff dashboard English, Malay and
Chinese, not Tamil (the owner, 24 October 2026; [languages](#languages));
off-site backups may be held abroad (the owner, 24 October 2026), once the
transfer steps in [privacy](../architecture/privacy.md#backups-held-abroad)
are done; and the approval workflow's rules (the owner, 26 October 2026):
approval is eligibility, not payment, and a booking made on it follows the
venue's payment policy; no unmanned access without the sign-off it needs,
whoever made the booking, a manager's override and staff-supervised
attendance included; a safety approval needs a manager, a coach named for it
or front desk delegated by name; applications kept by purpose, with 90 days
for documents and 365 for closed records as provisional defaults subject to
legal review; supporting documents may be PDFs, checked and never rendered
([ADR 0020](../architecture/decisions/0020-approval-to-booking-payment-and-authority.md),
[ADR 0021](../architecture/decisions/0021-approval-retention-and-pdf-documents.md)).
The owner's decisions of 27 October 2026, after the round of functional
work: no discount stacking unless the venue and the code allow it; a paid
lesson keeps its coach when moved, another coach only by a manager's
explicit change, and customers choose a coach only where the venue offers it
([programmes](../features/programmes.md#one-to-one-coaching)); the
60-minute membership hold where the gateway fits it, and family dependants
changed by the plan's policy, not freely
([pricing](../features/pricing.md#changing-whom-a-family-membership-covers));
a child named on the receipts their guardian is sent, the guardian the
purchaser; phone checks recommended, not required, without them staff
linking accounts and codes going to recorded numbers; booking privileges
asked when booking and a members' place asked for the participation date
([membership validity](../features/pricing.md#membership-validity)); the
`mysenam_guardian_notice` template prepared but not submitted; box leagues
on their own result functions with the shared rules (`AGENTS.md`).
The owner's decisions of 28 October 2026: the counter and the venue's API
are held to the same venue policies as online bookings, a manager overriding
the house rules' limits, no-show strikes, the guest limit or an assisted
weekly booking only where the venue permits it, each override recorded, and
nothing overriding a blocked number, the unpaid limit, eligibility, safety
prerequisites, capacity or payment
([ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md));
sign-up by an emailed link, Google sign-in and passwords kept; invitations
withdrawn before they are accepted; a dearer coach's difference payable
online; memberships suspended and reactivated without automatic
cancellation, refund or extension; staff times in the staff language;
e-invoices sent to LHDN never rewritten.
The owner's further decisions of 28 October 2026 (being built in round 8):
participants' and coaches' names left out of e-invoice descriptions, the
legally required information kept; e-invoice records kept for the
statutory period, seven years where it applies, pending legal verification,
optional customer-profile data kept apart; a language of their own for staff
and coaches; and actual guests counted, those registered at the counter
included, ordinary walk-in customers told apart from guests accompanying
members.

### Not affecting the first launch

Everything else on this page is P2 or P3: an improvement, a known edge, or a
verification to add. Each names where its work is tracked (a test to write,
or the [roadmap](roadmap.md)), and none changes what the first launch can
promise. The P2 items among them:

- The marketplace benchmark is run by hand ([booking time model](#booking-and-availability-b)):
  it is re-run with the launch checklist's performance row, and could run
  on a schedule once CI does.
- Ways basic and specialised activities are commonly sold ([activities](#activities)):
  roadmap rows; operators see the note as they pick one.

## Every open limitation, by kind

Each open limitation on this page, once, with what kind of thing it is and
what would close it; the detail is in the section linked. Kinds:
**1** a defect, **2** a workflow not finished, **3** a technical limitation
that could be removed, **4** a missing test, **5** a decision, kept on
purpose, **6** waiting on an outside service, **7** a legal or commercial
decision needing approval, **8** not needed until a market or customer
that needs it. Kinds 1 to 4 are worked off; 5 stays unless the reason
changes; 6 to 8 name what they wait for. As of 28 October 2026: no defect
(kind 1) is open.

| Limitation | Kind | Who it affects | Next action, or what it waits for |
| ---------- | ---- | -------------- | --------------------------------- |
| [Email, WhatsApp, SMS, Billplz, Stripe, MyInvois, Google sign-in, off-site and photo buckets](#integrations-awaiting-live-verification-or-a-partner) never checked against the real service | 6 | Everyone, once the feature is on | Each passes its live check ([launch checklist](../operations/deployment.md#launch-integration-checklist)) |
| [Email bounces not read back](#operations-and-security-s) | 6 | Venues whose customers' mail bounces | The owner reads bounces in the provider's dashboard weekly; a bounce webhook once a provider is chosen |
| [Without WhatsApp or SMS, no number is proved](#operations-and-security-s): staff link each member's or resident's account before they book online; the screens say so and recommend phone checks | 6 | Members-only and private venues | Phone checks recommended, not required (the owner, 27 October 2026); switched on per install once the templates are approved |
| [Refunds by hand](#money-m) (every Billplz refund) depend on staff | 6 | Customers owed a refund at Billplz venues | A gateway with a refund API (HitPay is the candidate) |
| [Reserve with Google, smart locks, Stripe Connect, InvoiceNow, web push, LINE, Zalo](#integrations-awaiting-live-verification-or-a-partner) | 6 / 8 | Venues wanting them | A partner approval or contract each |
| [Remote staging](#production-readiness) never run; [load](#production-readiness) measured on one machine | 6 | The owner | An agreed spend for a droplet; re-run the benchmark on the production set-up |
| [Terms and privacy notice](#gaps-in-verification-and-documentation) unreviewed; [breach-notification rules](#gaps-in-verification-and-documentation) unconfirmed | 7 | Everyone | A Malaysian lawyer's review |
| [Operating company and data hosting](#blockers-for-any-launch) undecided | 7 | Everyone | The owner decides |
| [Off-site backups abroad](#blockers-for-any-launch): allowed by the owner; the transfer steps not yet done | 7 | Everyone | The steps in [privacy](../architecture/privacy.md#backups-held-abroad) recorded and a lawyer's answers, then `OFFSITE_TRANSFER_APPROVED` |
| [Tax on money kept from deposits](#money-m) provisional | 7 | Venues that deduct from deposits | Each venue's adviser's review, recorded |
| [Charging venues](#blockers-only-where-a-feature-is-switched-on): price and terms undecided | 7 | Venues | The owner decides |
| [Native review](#languages) of Tamil, of activity names in Malay and Chinese, and of programme emails and company-account invoices in Malay, Chinese and Tamil; the four languages are promised | 6 | Customers reading those languages | A native speaker of each reviews ([launch blocker](#blockers-for-any-launch)) |
| [The terms](#languages) in English | 7 | Customers reading other languages | Translated after the lawyer's review |
| [Staff screens](#languages): records written before migration 0120, and what people, providers and gateways wrote, stay as stored | 5 | Staff reading Malay or Chinese | Kept: data is shown as written |
| [Benchmark](#booking-and-availability-b) run by hand; CI deferred | 5 | The owner | Re-run with each release ([release records](../development/testing.md#release-records)) |
| [Ways some activities are sold](#activities): bowling by the game, gym entry without a session, day passes, launch windows, range officers, heats | 8 | Venues selling them | [Roadmap](roadmap.md) rows; built when such a venue signs |
| [Counted performances](#booking-and-availability-b) (bouldering tops and zones) | 8 | Climbing competitions | [Roadmap](roadmap.md) |
| [Exact shared separation on fungible places](#booking-and-availability-b); [gaps across a change of the clocks](#booking-and-availability-b) | 5 / 8 | Shared facilities; a future country with clock changes | Kept: venues needing it exact turn the facility over whole; checked again when such a country is added |
| [Taking one person off a booking has limits](#activities); [benefits by scope have gaps](#activities); [changing a lesson's coach has limits](#activities) | 5 / 6 | Families, clubs, coaching venues | Kept: deliberate restrictions with their reasons; the online parts wait on the gateways' live checks |
| [Guardians recorded by name and number](#activities): notices by WhatsApp only | 6 | Families | The prepared `mysenam_guardian_notice` template submitted and approved, once the WhatsApp account exists |
| [Country names for countries not sold in](#activities); [clock changes](#booking-and-availability-b) (handled, no such country) | 8 | — | When a country is added |
| [Tournament corrections](#booking-and-availability-b) never rewrite a played match; [performance ties](#booking-and-availability-b) wait for the organiser; [official's links](#booking-and-availability-b) are bearer links; [divisions](#booking-and-availability-b) keep players apart by account; [box leagues](#booking-and-availability-b) always have a winner | 5 | Organisers | Kept: each reason is in its section |
| [A proposal holds a day](#booking-and-availability-b); [a booking retried where it really collides](#booking-and-availability-b); [staffed hours whole](#booking-and-availability-b); [old tables gone](#booking-and-availability-b) | 5 | Hosts; venues | Kept |
| [An operator's own activity](#activities) named in English unless given; [catalogue changes](#activities) take a minute; [`sport` column name](#activities); [integrity check](#activities) window | 5 | Operators | Kept |
| [Sign-offs online rest on the account](#activities); [approval applications](#activities): retention periods provisional pending legal review, the off-site erasure ledger unverified against a real bucket | 5 / 7 / 3 | Climbing, archery and hire venues | A lawyer's review of the periods per activity and jurisdiction |
| [No CSRF token; inline styles](#operations-and-security-s); [refunding to credit](#money-m) by its transaction; [disputes lost in part](#money-m) settled by hand; [negative credit after a chargeback](#accepted) | 5 | — | Kept |
| [Staff moves not asked the house rules; the class page without override or pay-now buttons; overrides not in the bookings export](#booking-and-availability-b) | 3 / 5 | Venues | Kept for now: the activity log carries overrides; the class page's buttons when a venue needs them |
| [Timing tests on one machine; an invitation withdrawn while its email is being sent](#operations-and-security-s) | 5 | Everyone | Kept: equal timing in production is shown only by measuring there; the link is refused either way |
| [MyInvois: cancelling in the portal, no debit or refund notes, buyer details kept, LHDN's rules unverified](#operations-and-security-s) | 6 / 7 | Malaysian venues issuing e-invoices | A MyInvois sandbox check; the statutory period confirmed by the venue's adviser |
| [Deliberately unsupported](#deliberately-unsupported): surge pricing, referral credit, one country per install, storefronts not data separation, no turnstiles, signed sets prove origin only, off-site copies need a location | 5 | — | Kept |

Counted mechanically (each bullet, *Also* paragraph and table row in this
page's lists of open items and its launch tables; one limitation can sit in
two of them): **90 entries at commit `b9666dc`**, when this round of work
began on 24 October 2026, **86 at commit `d7098e7`** after round 6, and
**89 at commit `f4812fa`** after round 7, and **101 now**: round 8 closed the
two e-invoice decisions, the staff languages and the guest count the owner
decided, and 45 of the round 8 audit's 50 findings (the other five are
[planned](roadmap.md)), and recorded what its new workflows leave
(counter payouts, change alerts, booking links, the cash-up, leaving a waiting
list), each narrower than the gap it replaced, with two new decisions for the
owner, and two gaps in how the suites are run (the date they run on). Closures are recorded with their tests
under [fixed since the audit](#fixed-since-the-audit) (B11, B17–B62, M16–M28 and
S12–S29, found and fixed in the same work) and
[resolved without a number](#resolved-limitations-without-a-number) (114
rows). Others were narrowed rather than closed (staffed hours, phone
identity, languages, clock changes, browser coverage, separation on shared
facilities, approval applications, booking for a child). Some were added,
each narrower than what it replaced or newly found and recorded rather than
left unsaid: the native review of
newly translated text; what the owner's decisions of 25 and 26 October 2026
left when built (exact shared separation on fungible places, gaps across a
change of the clocks, the provisional retention periods); and what building
participants and scanning left (ClamAV's production set-up unverified);
and, from the owner's decisions of 27 October 2026, the limits of taking one
person off a booking, gaps in benefits by scope, guardians recorded by name
and number, the off-site erasure ledger tested against a stand-in only, staff
linking residents to a venue's list without phone checks, and what a waiting
list asks again at the offer, each narrower than what it replaced (the
language of a waiting-list offer's page and of times in Malay emails, found
by the acceptance scenarios, since resolved); and, from the owner's later
decisions of 27 October 2026, what changing a lesson's coach, family
dependants' policy, membership validity and the localised times left, the
counter's checks the owner is to decide, and what the work on account
enumeration found next to it (sign-up says an address is taken; email
invitations cannot be withdrawn, both since resolved), each recorded rather
than left unsaid; and, from the owner's decisions of 28 October 2026, the
eleven closures of round 7 (the counter's checks decided, sign-up,
invitations, the coach difference online, suspension, staff times, the API's
withdrawal, dashboard refunds, cover history, lesson credit, e-invoice
states) beside what they left, each narrower: MyInvois's own limits and
LHDN's rules unverified, two e-invoice questions for the owner (since
decided), staff
messages in the install's first language, and what the counter's policies
leave (staff moves, the class page's buttons, overrides in the export). The owner's decisions of 24 October 2026 (the launch languages,
backups abroad) moved a decision into the launch blockers rather than
closing it: native review is now required, and the transfer steps remain.
In the table above, no row is a defect; two are partly of kind 3 (staff
messages in one language; what the counter's policies leave), and the
e-invoice questions are decisions of kind 7.

## Suspected defects

A new defect gets a row here with its evidence and the test to write before
it is fixed, and moves to *fixed since the audit* with that test.

### Operations and security (S)

| ID | Defect | Evidence | Test to write first | Priority |
| -- | ------ | -------- | ------------------- | -------- |
| — | None open | | | |

Also: an email the mail server accepted is recorded as sent; that is not
proof it reached the inbox (spam folders, a full mailbox, a bounce later).
Bounces are not read back from any provider ([messaging](../integrations/messaging.md)) (P2; a [decision for the owner](#decisions-the-owner-has-to-make)).

Also: without phone checks, residents and members of a private or members-only
venue book online only once staff link their account to their entry on the
venue's list; after migration 0175 every existing entry is unlinked unless
its number is proved ([migration note](../archive/migrations/legacy-installs.md#venue-lists-from-before-migration-0175)).
Phone checks stay recommended, not required (the owner, 27 October 2026):
the access and participants screens say what they enable, what happens
without them and recommend them where a venue relies on numbers; nothing is
switched on by it ([venue operations](../features/venue-operations.md)).

Also: signing up does not say whether an address has an account: it answers
*check your email* for every address and emails either a link to finish or a
notice to sign in ([signing up](../architecture/authentication.md#signing-up)),
and Google sign-in refuses an address Google has not verified in the same
words whether or not an account has it (S25). An account made before
migration 0224 and never given a password by a reset link has no record of
its address being proved, so Google joining it clears its password (P3). An
invitation by email withdrawn at the very moment its email is being sent may
still arrive, with no notice after it; its link is refused all the same (P3).
The tests that show sign-in, password reset and sign-up take as long for an
unknown address use generous bounds on one machine: they show an unknown
address is not systematically faster, not equal timing in production (P3).

Also: an e-invoice already sent to LHDN keeps the names its lines said, as
sent, at LHDN and in its copy here, which is never changed
([MyInvois](../integrations/myinvois.md#states-and-what-never-changes)); one
not yet sent follows its receipt, and no e-invoice line names a participant, child
or coach (the owner, 28 October 2026). The details a customer gave for their
own e-invoice (name, TIN, ID number, email, phone, address) are kept with it
for the statutory period, erasure included, then cleared with the
document's contents ([privacy](../architecture/privacy.md#e-invoice-records)). Coaches' names on lesson
receipts, and receipts naming a participant whom retention deleted rather
than erased, keep those names until the receipt's own retention period;
where a name is cleared by matching it as a word, a matching word elsewhere
on that receipt is cleared too (amounts never change)
([privacy](../architecture/privacy.md)) (P3).

Also: the statutory period for e-invoice records (7 years from issue by
default) is the owner's provisional reading, not legally verified; whether
it should run from the end of the year of assessment is for the venue's
adviser (8 years covers either reading), and the period is not carried in
the erasure ledger, so after a restore the restored copy's period applies
([privacy](../architecture/privacy.md#e-invoice-records)) (P2, legal review).

Also: MyInvois cancelling is done in the portal and reaches MySenam only when
LHDN is asked; MySenam issues no debit or refund notes; staff cannot correct
a buyer's details (the customer asks again); a send interrupted after LHDN
was asked (the server stopping) is marked not sent after 15 minutes and is
never sent again by itself: staff check the portal first, since LHDN may
have it; the LHDN rules followed
(seven days, RM10,000, codes, version 1.0, the 72-hour window) are read from
published guidance and unverified
([MyInvois](../integrations/myinvois.md#what-is-assumed-and-not-verified)) (P3).

Also: a waiting-list offer and claim ask what the booking would ask on the
path the entry was made, paid as a claim is (a refused number, the venue
open, who may book a members-only or private venue, the house rules with the
members' window, the unpaid-bookings limit, no-show strikes and the guest
limit, a members' place covered on its date), and the venue's waiver at the
claim; a class's queue asks what enrolling asks. A place freed while a venue
was unlisted is offered when another place there frees; an offer to a number
refused after it was made holds its place until its claim is refused or it
runs out, and a message about it already sent stays sent (one not yet sent is
withdrawn) ([booking](../features/booking.md#waitlists)) (P3).

Also: bookings made through a venue's API key count towards the limit on
online bookings without an account, as online ones do (the counter's own do
not; recommended to leave the API's out too, the owner's decision); a
members-only venue's membership holder not on its list cannot host a guest,
there is no guest allowance per period and no guest fee, and classes and
waiting lists do not take a host
([booking](../features/booking.md#members-and-residents-guests-at-the-counter-and-through-the-api)) (P3).

Also: staff move a weekly series week by week (cancelling the weeks left is
one step); closing a day, outages, rain-outs and the venue's API key give a
counter payment back as paid without recording a counter payout; a corrected
phone number is not sent a fresh confirmation
([venue operations](../features/venue-operations.md)) (P3).

Also: staff moving a booking are not asked the house rules; class enrolments
at the counter take payment as they are made, and overrides, through the
route only (the class page has no buttons for them); overrides are not in the
bookings export (the activity log carries them); a manager's override reason
is free text kept with the booking
([booking](../features/booking.md#manager-overrides)) (P3).

Also: when a class's places go up by several, the waiting list is offered
one place at a time, as it always is, and the other new places are open to
anyone meanwhile; a change to a class's name or instructor is told by email
only, not WhatsApp, and a change to its price or places tells nobody (the
price holds for those enrolled); a tournament's new name is told to its
entries, a new deadline, fee or text is not; the venue's
alerts for online changes need the `mysenam_venue_booking_change` WhatsApp
template, prepared and not yet submitted to Meta (email works without it)
([programmes](../features/programmes.md), [tournaments](../features/tournaments.md),
[booking alerts](../features/venue-operations.md#booking-alerts)) (P3).

Also: closing an account, like a customer's own cancellation, does not tell
the venue directly (the freed court shows on the schedule and the waiting list
is offered it); a friend's payment page being opened at the gateway at the very
moment the booker re-splits keeps the old share, the money taken counted as
taken ([booking concurrency](../architecture/booking-concurrency.md)) (P3).

Also: a credit note written outside a member of staff's request (a closed
day, an outage, a rain-out) names nobody in the cash-up and shows only in a
manager's whole-day view; receipts and payments from before migration 0234 say
*At the counter* and name nobody; the front desk sells no counter pass until a
manager adds the venue's pass products
([cash-up](../features/payments-and-credit.md#cash-up)) (P3).

Also: a waiting-list offer's message does not say that online payment will be
asked (its WhatsApp template is fixed; the offer page says it); whoever holds a
booking's link can do what its code and phone allow, until it expires after the
booking; a promo code on a weekly series is checked on its first date only
before booking (the booking checks every week)
([finding your booking](../features/booking.md)) (P3).

Also: the grid's cells are named by their price only for screen readers, and
the grid's pale hint text is below the contrast asked of body text; there are
no links to a section inside *Venue details*; the staff day list is ordered
by court, then time; dates show no year; someone who
joined a waiting list by phone alone gets no message with its leave link (its
WhatsApp template would be a new one), and joins at the counter or through the
API get none ([booking](../features/booking.md)) (P3).

Also: the Tournaments and Leagues tabs still show the front desk their set-up
forms (the server refuses them), and ticking off or hiding the set-up checklist
is not refused to the desk by the server (the desk is not shown it); a new
branch starts blank; a test booking made before going live stays in the books
unless cancelled (the round 8 audit's X1-15 and X1-16, [planned](roadmap.md))
(P2). Of hours and prices only opening hours and court rates can be set from a
later date (peak windows, holidays, set-length prices, fees, concessions and
membership prices change when saved); once a change applies, earlier periods
are measured against the hours now (the reports' utilisation, as whenever hours
change); narrowing hours looks at confirmed bookings, not classes, blocks or
offers, and is not tested against a booking made at the same moment; the public
venue page shows today's hours, not announced ones
([hours from a date](../features/booking.md#hours-from-a-date)) (P3).

Also: there is no CSRF token, by design: cross-site writes are refused by
`SameSite=Lax` and an `Origin` check ([security](../architecture/security.md#requests-from-another-site)).
The content security policy still allows inline *styles* (a style cannot run
code); scripts need the response's nonce (resolved below).

### Booking and availability (B)

| ID | Defect | Evidence | Test to write first | Priority |
| -- | ------ | -------- | ------------------- | -------- |
| — | None open | | | |

Also, in [tournaments](../features/tournaments.md):

- A correction never rewrites a match already played. Where it means the
  wrong competitor went on, the tournament is held under review until a
  manager lets the results stand or replays them; a replay that changes who
  goes on again is a correction, and possibly an issue, of its own (by
  design). Replaying is refused where the right competitor has left or is
  already elsewhere in the knockout (P3).
- Sport templates are common club practice, not federation regulations:
  an event run under a governing body's rules needs its rules checked and
  set before the draw. Counts of tops and zones (bouldering) cannot be
  expressed yet ([roadmap](roadmap.md)) (P3).
- Divisions of a competition are added before any draw, and keep a player
  apart only by account: a partner named in
  doubles, or a roster name, is not known to be the same person in two
  divisions. Ages come from dates of birth entrants declare, not checked
  against a document; the level is shown, not enforced; a team's roster is
  names its captain typed, not accounts (P3).
- In a performance event, competitors level for the final's last place wait
  for the organiser's choice; a heat correction that would change who swam a
  final with results is refused, and a re-swim is arranged by hand (P3).
- An official's link is a bearer link: whoever holds it can enter that
  tournament's results until staff withdraw it or the tournament ends
  (P3, by design: officials are often volunteers without an account).
- Box leagues share the competition rules for scores and tables, but are
  still their own engine for seasons, boxes and result states; a league match
  always has a winner. They use the shared rules (`scoreRefusal`,
  `standings`) with their own result functions in `src/lib/leagues.ts`,
  since `recordResult` is bound to knockout progression and corrections; by
  the owner's decision of 27 October 2026 that is the design, and
  `AGENTS.md` says so (P3, by design).

Also, in [open games](../features/matchmaking.md#moving-a-game-to-another-time):

- A proposal waits a day at most (or until the new start, or the
  cancellation cutoff), not a time the venue sets (P3).


Known limits of the [booking time model](../architecture/booking-time-model.md)
(the owner's decisions and the defaults chosen for open questions are listed
there):

- **Measured at marketplace size by hand** ([results](../development/testing.md#results)),
  before and after B12–B14 were fixed; not in CI, so a slower query is
  noticed only when somebody runs it again. `tests/query-plans.test.ts`
  checks the indexes are used, not the timings (P2).
- **A booking is retried where it really collides.** Rows that point at a
  booking are checked at commit (migration 0206), which removed the one
  read unrelated bookings shared (see *fixed since the audit*, B30); a
  booking that still collides with another is run again, and one still in
  conflict after ten tries is refused as busy (`BUSY`, 503 with
  `Retry-After`), never half done. Concurrency is measured on one machine,
  not under production load ([booking concurrency](../architecture/booking-concurrency.md)) (P3).
- **Staffed hours are whole hours** (`staffed_from`/`staffed_to`): a desk that
  shuts at 9:30 PM is entered as 9 PM or 10 PM. Whether a booking is staffed
  is judged by its whole time, and one staffed for only part of it gets the
  door code or the counter as the venue sets (resolved below); only the
  half-hour granularity remains (P3, deliberate simplicity: a lock code is
  set for the hour, and no venue has asked for finer).
- **Where the clocks change, the hour of the change is not sold**: a
  booking touching it is refused, a manager's too, and its starts are not
  offered ([booking time model](../architecture/booking-time-model.md#time)).
  No country MySenam is sold in changes its clocks, and
  `tests/time-zones.test.ts` fails if one is added to the region table:
  adding such a country is a decision of its own (P3, by design).
- **Exact shared separation on fungible places is not modelled**: places
  are not told apart, so nothing says which booking follows which on a
  unit. A venue says how a shared facility turns over: per place, its gaps
  and cleaning added up (the default, as before) or the longer of the two
  (a fleet's own turnaround), or the whole facility, kept clear between
  sessions, where separations are shared exactly
  ([shared facilities](../architecture/booking-time-model.md#shared-facilities-how-they-are-turned-over)).
  Per place never sells closer than the rules ask, and can refuse a time a
  per-unit assignment would allow (`tests/shared-turnover.test.ts`) (P3, by
  design: an exact model needs an assignment of bookings to units, which a
  count of places cannot enforce).
- **Gaps across a change of the clocks**: the database measures separation
  in real minutes, the board in minutes on the clock; across a change a
  start could be offered and then refused (P3; no country sold in changes
  its clocks).
- **The old tables are gone** (migration 0091): rolling back the upgrade is
  restoring the backup taken before it
  ([deployment](../operations/deployment.md#upgrading)).

### Activities

What the [activity catalogue](../features/activities.md) does not yet do:

- **Basic and specialised activities lack a way they are commonly sold**:
  bowling by the game, gym entry on a membership without a booked session,
  day passes for climbing and bouldering, launch and tide windows for water
  hire, range officers per archery session, cycling heats. Each is in the
  [support matrix](../features/activities.md#support-matrix) and the
  [roadmap](roadmap.md); operators see the note as they pick one (P2).
- **An operator's own activity** is named in English unless they give the
  other languages, and is *basic* until someone reviews whether its
  workflow fits the models (P3).
- **Sign-offs online rest on the customer's account.** A sign-off counts
  online only for the account staff linked it to or one that has proved the
  number; where an install has neither WhatsApp nor SMS to prove numbers
  with, only linked sign-offs work online. At the counter and through the
  venue's API key the number is taken on the staff's or the venue's word.
  A first lesson or registration no longer needs the counter where the
  venue takes applications online ([registering online](../features/activities.md#registering-online-for-approval));
  a coach's lesson is not held with an application (court time is), and is
  booked once approved (P3). Online, every place on such an activity must be
  a named person with a sign-off of their own; unnamed extra places are booked
  at the counter, since one sign-off covers one person.
- **Approval applications are kept for provisional periods**: documents
  90 days after the decision, the review window 30, closed records 365 and
  refused or unscannable documents 7, product policy the owner accepted, not
  legal requirements; the platform owner can change them within bounds, and
  the dashboard and privacy notice say they are provisional until a legal
  review is recorded (per jurisdiction, with the reviewer's role, firm,
  periods covered and a reference to the written advice; recorded by the
  owner, not verified by MySenam), which needs a Malaysian and a Singaporean lawyer's
  answers to the questions in [privacy](../architecture/privacy.md); deleted rows
  stay in backups until those age out (about two weeks) (P3, kind 7).
- **The erasure ledger off-site is tested against a stand-in only**: entries are copied off-site in signed segments within a minute and with every set, and a restore that cannot show the ledger complete (always after losing the server) is not served until acknowledged; an erasure made after its entry last left a lost server (normally under a minute, longer while copies fail, which raises `erasure-ledger-offsite`) is redone by hand; one the restored copy blocks (credit, a pass, a hold) is raised to the owners rather than forced; retention periods an activity shortened after the backup are not in the ledger (the install's, which bound them, are) ([backups](../operations/backups.md#after-a-restore)) (P3).
- **Taking one person off a booking has limits**: shares other players paid
  (a split share or an open game's), each worked out from the whole price,
  refuse it, as does part of a booking paid online that is no deposit of the
  booker's and a payment page open (the booking's or a friend's share); a
  lesson is booked as one with its coach and an open game's players leave the
  game; a class place is withdrawn by cancelling that child's enrolment; a
  credit note on a company or school account waits for the account's next
  invoice, so a closed account with nothing more to invoice keeps it until the
  venue settles it by hand; the notice is an email only (no WhatsApp template); QR self
  check-in and door codes check a booking in as a whole, though the door asks
  for each person's own eligibility ([taking one person off](../features/booking.md#taking-one-person-off-a-booking)) (P3).
- **Benefits by scope have gaps** ([ADR 0025](../architecture/decisions/0025-benefits-and-privileges-by-scope.md)):
  memberships for a participant and family memberships bought online are
  verified only against stand-in gateways (a family membership is held by the
  buying account; a purchase holds its people for 60 minutes, a Stripe page
  closing with the hold and a Billplz bill's late money made or owed back; a
  Stripe Checkout session completed with its payment still processing
  releases the hold at once, and money landing after another purchase for the
  same people is owed back; a refund made in Stripe's own dashboard is
  recorded and raised to staff but changes no membership by itself, and one
  made in Billplz's dashboard is seen only when staff mark it, Billplz
  reporting no refunds); changes of whom a family membership covers
  made before migration 0192 were not recorded, so those terms count only
  whom they cover now; memberships can be suspended for a period and
  reactivated, but a booking at an ordinary venue priced at a member rate
  inside a suspension keeps its price and is not flagged (a booking does not
  record the membership that priced it), and a move or a waiting-list offer
  asks membership before its transaction, so a suspension saved at the same
  instant can miss it (the booking path asks again inside its transaction),
  and a members-only venue's page still invites a suspended member to sign
  in and ask to be linked, though booking tells them it is suspended; a court reserved whole while its booker was
  a member is flagged, not barred, when the membership stops (a booking
  privilege, checked when booked) (P3).
- **Changing a lesson's coach has limits** ([one-to-one coaching](../features/programmes.md#one-to-one-coaching)):
  customers cannot change the coach; lessons paid with a lesson pack, a
  deposit or shares others paid keep their coach (cancel and book again). A
  dearer coach's difference is paid at the counter or, where the venue takes
  payment online, online from the coach-change email or the booking page; it
  counts in the day's expected and outstanding figures, not yet in the month's
  report. Online payment is checked against stand-ins only (P3).
- **Guardians recorded by name and number** agree, withdraw or have their
  number checked by a code staff send to it; where no code can be sent, a
  manager records an in-person agreement, flagged for review and recorded as
  no proof of authority. Their notices go only by WhatsApp to a number a code
  has come back from (the outbox has no SMS channel, and the
  `mysenam_guardian_notice` template is prepared in four languages but not
  submitted to Meta; a notice goes in the language of the code that came back,
  or the install's first language for a guardian confirmed before migration
  0198), otherwise a task
  for the venue (also when a notice is abandoned or reported undelivered). A guardian's relationship and
  authority remain their declaration, reviewed by staff only where an activity
  asks it, never verified ([ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md)) (P3).
- **A catalogue change** made on one instance reaches the others within a
  minute (the cache), and the browser on its next page (P3).
- **Country names exist for countries the app is not yet sold in** (sepak
  takraw in Thailand and the Philippines); they take effect only once that
  country is added ([regions](../product/regions-and-tax.md)).
- **The column is still called `sport`** in the database, URLs and the public
  API, for compatibility; it holds any activity
  ([ADR 0011](../architecture/decisions/0011-activities-as-data.md)).
- **The integrity check** looks from yesterday on and lists up to 50 problems
  of each kind ([monitoring](../operations/monitoring.md)).

### Languages

The customer pages, booking messages and refusals are in English, Malay,
Chinese and Tamil ([feature status](../product/feature-status.md)). Not yet:

- **The terms** are in English whatever the customer's language, translated
  once a lawyer has reviewed them (P2). Game, tournament, league and group
  emails are in the player's language, and a company account's invoices in
  the account's; in them, round names ("Semi-final 2"), court names and what
  staff typed stay as written (P3).
- **Not reviewed by a native speaker:** the Malay, Chinese and Tamil wording
  of game, tournament, league and group emails and of company-account
  invoices, and the staff dashboard's Malay and Chinese (machine-assisted)
  (P2).
- **On the staff dashboard**, what the server composes is said in the staff
  language (`src/lib/staff-text.ts`, `srv.` phrases), and refusals by their
  code or their English sentence (`src/lib/staff-i18n/refusals-*.ts`). What
  stays as stored: what people typed, provider, gateway and LHDN errors, raw
  exception text, the activity log, records from before migration 0120
  (alerts, credit lines, receipt lines, urgent notices, tournament
  corrections), printed receipts, and holiday names (P3).
- **Not reviewed by a native speaker:** the Tamil dictionary, and the
  built-in activity names in Malay and Chinese (machine-assisted), and the
  times each language is written in (Malay's PG/PTG and Tamil's 24-hour clock,
  from the common locale data) (P2).
- **What staff alerts keep in English:** every email to staff, coaches and
  platform owners is written in the reader's own language
  ([regions](../product/regions-and-tax.md#a-language-of-their-own-for-staff-and-coaches));
  the chat webhook's message stays English, and what an alert quotes as
  stored (what people typed, an error's own text, the activity log's details,
  receipt descriptions, refusals with no translation) stays as stored, with
  the times it was written with (P3).

The launch promises English, Malay, simplified Chinese and Tamil to
customers (the owner, 24 October 2026), so these reviews are a
[launch blocker](#blockers-for-any-launch). The staff dashboard is in
English, Malay and Chinese, not Tamil (the owner, the same day), and its
review is part of the same blocker.

### Money (M)

None open.

Also: a cancellation by the venue refunds an online payment by itself after
a closed day or a rain-out, but leaves it in *Refunds owed* for staff after a
court taken out of service or a cancelled class; which is intended is with the
owner ([decisions](#decisions-the-owner-has-to-make)) (P2).

Also: a refund made by hand (every Billplz refund) depends on the venue's
staff. MySenam tracks it — the date customers are told, overdue refunds on
the dashboard and in a daily reminder, and the workload month by month
([payments](../features/payments-and-credit.md#refunds-made-by-hand)) — but
cannot make it, and does not collect the customer's bank account, which an
FPX refund needs, so staff may have to ask for it. Refunds paid by DuitNow QR
would stay manual even with HitPay.

Also: refunding to credit has no unique index of its own; it is refunded
once because it runs inside the transaction that claims the cancellation
(`refundBooking` in `src/lib/store.ts`; `tests/refund-recovery.test.ts`).

Also: a refund sent to the gateway is written down as owed first and asked
for after the cancellation commits, since the gateway cannot take part in the
transaction. Refunds are reconciled for every venue; the scheduler finishes
what a crash interrupted — an owed refund never asked for (only where the
venue refunded automatically when it was first owed), a claim with no
answer, a refund the gateway left pending — under the same key, so it is
made once, and tells a venue's staff daily what waits for them
([payments](../features/payments-and-credit.md#refunds-that-are-interrupted)).
A refund the gateway reports failed is owed again, raised by the integrity
check and listed for staff; it is not resent on its own. Verified against a
stand-in for Stripe only; Billplz has no refund API, so its refunds are
always by hand (P2).

Also: the tax treatment of money kept from hire deposits starts from
provisional country defaults that no tax adviser has reviewed. A venue
records its adviser's review in its Tax settings; until it does, every
amount kept is marked provisional in the journal and exports. Recording the
review is a launch requirement, not a software check
([launch checklist](../operations/deployment.md#launch-integration-checklist)) (P1 before
real deductions, at a venue that
[deducts from deposits](#blockers-only-where-a-feature-is-switched-on)).

Also: a dispute on what a venue paid the platform that is lost only *in
part* is reported to the owners and settled by hand; lost in full, the invoice
or pack is owed again (resolved below) (P3).

### Fixed since the audit

IDs are not reused. Each fix came with the test recommended above.

| ID | Fixed by | Test |
| -- | -------- | ---- |
| S1 | Script-loaded modules import with file extensions | `tests/backup-scripts.test.ts` |
| S2 | Erasure takes the account off waiting lists before deleting it | `tests/privacy.test.ts` |
| S3 | The lease is renewed every minute while a tick runs; each webhook delivery is claimed before it is sent | `tests/scale-out.test.ts`, `tests/public-api.test.ts` |
| S4 | Session expiry is written in `datetime()` form, so it compares to the second | `tests/auth.test.ts` |
| S5 | Wrong passwords for one account are also counted from any address | `tests/login-limits.test.ts` |
| S7 | Sessions keep the SHA-256 of their token; a migration converted those issued | `tests/auth.test.ts` |
| S8 | The retention run deletes phone check codes after a day | `tests/privacy.test.ts` |
| S6 | Documented: several instances share one `MYSENAM_SECRET` ([architecture](../architecture/overview.md#more-than-one-instance)) | — (configuration) |
| B1 | Big courts sharing a part shadow each other, and their blocks carry; migration 0087 | `tests/court-links.test.ts` |
| B2 | Search, any court, the move picker, moving and rescheduling count waiting-list offers through one function | `tests/waitlist.test.ts` |
| B3 | Choosing a place counts blocked places as well as offers | `tests/waitlist.test.ts` |
| B4 | An outage is saved in a transaction that re-checks; classes on linked courts are listed; tournament clashes are re-checked in theirs | `tests/outages.test.ts`, `tests/court-links.test.ts` |
| B5 | Court time is exact intervals under one database constraint, so bookings of any length meet correctly ([ADR 0010](../architecture/decisions/0010-interval-booking.md); first fixed by half-hour rows under ADR 0009) | `tests/intervals.test.ts` |
| B6 | Search and the waiting list take as long a booking as the court allows | `tests/booking-lengths.test.ts` |
| B7 | Moving and rescheduling check blocks, classes and offers inside their transaction | `tests/move.test.ts` (guards the outcome; the race is not forced) |
| B8 | A group booking is one transaction | `tests/group-bookings.test.ts` |
| M1 | A handed-back share leaves the booker owing it; what they paid online gets its own receipt, dated when paid | `tests/games.test.ts` |
| M2 | A lost dispute takes back only what went back, and unwinds deposits and parts paid | `tests/stripe-disputes.test.ts` |
| M4 | A lost dispute is claimed once, in the transaction that acts on it | `tests/stripe-disputes.test.ts` |
| M3 | Marking a series paid at the counter is one statement that skips weeks already paid | `tests/series-payment.test.ts` |
| M5 | The set-up text is built from the events the webhook handles | `tests/stripe-disputes.test.ts` |
| M6 | A booking that stops being paid keeps its receipt, dated when paid | `tests/stripe-disputes.test.ts` |
| M7 | A receipt covering several bookings is credited one booking's part at a time, never past its total | `tests/deposits.test.ts` |
| M8 | A refund as credit goes into the pot the credit scope names | `tests/auto-refunds.test.ts` |
| M9 | A Stripe refund is claimed before Stripe is asked, so a hand mark or second click cannot send it twice; an interrupted one is asked again under its key | `tests/stripe-refunds.test.ts` |
| M10 | Disputes on the platform's own Stripe account are recorded and put to the platform owners | `tests/stripe-disputes.test.ts` |
| M11 | A deposit charged back after the rest was paid at the counter leaves the booking owing the deposit's part | `tests/stripe-disputes.test.ts` |
| S9 | Tournament, league and open-game emails are queued in the outbox with the change that causes them, so they are retried, capped and listed like any other message. The emails to staff and applicants it also named became S11, fixed below | `tests/outbox.test.ts` |
| S10 | Photos kept on the server's disk go into an archive beside each snapshot, checked before it is kept, pruned and copied off-site with it, and put back by the restore | `tests/backup.test.ts`, `tests/backup-scripts.test.ts`, `tests/offsite.test.ts` |
| B9 | A group result put right fills the knockout again while none of it has been played; once a match in it has, a change to who is in it is refused | `tests/tournaments.test.ts` |
| B10 | A withdrawal after the draw gives walkovers for the matches left, keeps the results already played where the tournament's rules say they stand (the entrant is flagged and does not go through, not put last), refills a knockout not yet played, and settles later rounds as soon as the opponent is known | `tests/tournaments.test.ts` |
| B12 | Claims are read court by court with indexes on the court or space and the end of the claim (migration 0094), in two queries for any number of courts; at 400 venues a search near a point takes 98 ms (p50), not 2.4 s ([results](../development/testing.md#results)) | `tests/query-plans.test.ts`, `tests/contention.test.ts` |
| B13 | Independent bookings no longer read each other's claims, expired offers are let go only when a claim conflicts, and retries back off; a booking that still cannot finish is refused as busy (503), never a 500 | `tests/contention.test.ts`, `tests/db.test.ts` |
| B15 | The admin route passes who enters a tournament's results; before, one set up for the players' results from the dashboard was saved as staff's. Found and fixed in the same change | `tests/fixtures.test.ts` |
| B16 | Joining an open game, and a host accepting a player, counted the places and then wrote, with nothing between: on Postgres six people joining a one-place game at once were all let in. Every change that takes or frees a place now runs in one transaction that locks the game's row first. Found and fixed in the same change | `tests/matchmaking.test.ts` ("lets exactly one of many people joining at once") |
| B17 | *My booking* offered free times for a booking already inside the venue's change cut-off, then refused only once the customer picked one; now no time is offered and it says why (`customerChangeRefusal`, `GET /api/bookings/reschedule` answers 409). Found by the browser scenario *Change time 2* | `tests/reschedule.test.ts` ("offer a customer no times once the booking is inside the cutoff"), `tests/uat/change-time.uat.ts` |
| B14 | A booking takes advisory locks on its spaces, shared courts and coach, in one order, before claiming, so racing bookings queue rather than deadlock | `tests/contention.test.ts`, `tests/concurrency.test.ts` |
| B11 | Utilisation measures the courts' floor once: each piece sellable on its own is a unit, in use whenever any booking covers it (as the court or the pitch over it) and out where a block or outage covers it; the pitch's own space is not more floor. Each court also shows its hours in use; takings per hour of floor are given beside ([reporting](../features/reporting.md)) | `tests/reports-floor.test.ts`, `tests/court-links.test.ts` |
| M12 | A fee paid online for something already paid (a tournament entry, a WhatsApp pack, a platform invoice) is recorded as owed back, with no second receipt or revenue, and refunded once through the gateway or marked refunded | `tests/tournaments.test.ts`, `tests/billing.test.ts`, `tests/whatsapp-usage.test.ts` |
| M13 | Money kept from a hire deposit is a receipted counter sale per reason linked to the hire, taxed by its reason's nature and the venue's tax settings, under its own heading in the takings, the journal and exports ([venue operations](../features/venue-operations.md#money-kept-from-a-deposit)) | `tests/hire.test.ts` |
| M14 | Credit reports give what customers hold and what customers below nothing owe, apart and never netted; the two together equal the ledger | `tests/wallet.test.ts` |
| M15 | A cancellation and its refunds are one transaction; a refund sent to the gateway is owed first, and one unanswered or overdue is raised by the integrity check and listed for staff | `tests/refund-recovery.test.ts` |
| S11 | Emails to applicants, password reset links, alerts to the platform's owners and a venue's staff, and WhatsApp credit alerts go through the outbox: retried with backoff, listed for the platform's owners, given up unsent once a reset link has run out, and a reset link is not kept after it goes | `tests/platform-messages.test.ts`, `tests/applications.test.ts`, `tests/password-reset.test.ts` |
| S12 | An account's *My waiting lists* listed every place queued on the account's phone number, proved or only typed in, so registering with somebody's number showed where and when they were queuing. Now the places the account joined, or on its proved number. Found and fixed in the same change | `tests/member-identity.test.ts` ("a number on an account's own lists") |
| S13 | A members-only venue or tournament let in any account whose typed number matched a member's. Now only the account the membership is linked to, or whose number it is, proved. Found and fixed in the same change | `tests/member-identity.test.ts` |
| S14 | A password reset or address-confirmation email was marked sent, and its link wiped, in two statements: a server stopping between them (and, for a moment, any reader) kept a sent message with a working link in the database and its backups. Found by a full run on Postgres; now one statement | `tests/platform-messages.test.ts` |
| S15 | Saving a venue's details left the set-up checklist and the go-live banner showing what was missing until the tab changed; both now refresh on save. Found by the browser scenario *Venue 1* | `tests/components/setup-checklist.test.tsx`, `tests/uat/venue-setup.uat.ts` |
| S16 | A coach's private link was kept in the database as it was given, with no end: a copy of the database opened every coach's page and changed their hours. Now only its hash is kept, it is shown once when made and lapses after a year, links already given keep working by their hash (migration 0137), and each change made at the link is in the activity log under the coach's name. Found in the review of instructor links | `tests/coaching-two.test.ts`, `tests/coach-link-migration.test.ts`, `tests/coach-self.test.ts` |
| B18 | A competition's draw scheduled each division around the others' matches by the players already in them, so a final or third-place match still to be decided counted as nobody's: a player in two divisions could be put on court in one at the time of a final they could reach in the other. A side still to be decided now counts as everybody who could still reach it, in the draw and when a fixture is moved or replayed. Found writing the tournament browser scenarios | `tests/divisions.test.ts` |
| S17 | A child's unstaffed access rested on the adult's induction: inductions were one per venue and phone number, staff could record one only for the number's holder, and the door checked the booking's number, so a child (or a sibling) booked on a parent's number opened on the parent's induction. Inductions now belong to the person inducted, the number holder's own or a participant's; the door asks for each person taking part; older family inductions stay the number holder's, flagged where ambiguous, and are given to a participant only by a manager with a reason ([ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md)). Found investigating the owner's report | `tests/participants.test.ts`, `tests/participants-migration.test.ts`, `tests/guardian-applications.test.ts` |
| B19 | The staff bookings tab could show one day's list under another day's heading: a slower answer for an earlier date overwrote the newer one, so it read *No bookings* over a day that had them. Stale answers are now dropped. Found by the acceptance scenarios (*Participants C*, and *Change time 1* and *3* in two runs) | `tests/components/bookings-tab.test.tsx` |
| B20 | Bookings and class enrolments made by staff at the counter for a members-only venue were refused with `MEMBERS_SIGN_IN`, though staff book anyone at the counter; now the account check does not apply at the counter, and every participant is still checked for their own membership | `tests/membership-scope.test.ts` ("the counter and the venue's own system are held to it too") |
| B21 | The Reports tab could show one venue's figures under another's name: a late answer for the venue shown first overwrote the venue just chosen (also the activity log and coach payouts); stale answers are now dropped | `tests/components/reports-venue-switch.test.tsx` |
| B22 | At the counter, one person's concession proof could be marked seen but never remembered (no "until when" was sent), so every visit asked again; the dashboard now offers next visit, month end, year end or 12 months, as for a booking-wide concession | `tests/components/bookings-tab.test.tsx`, `tests/uat/round4.uat.ts` (Places L) |
| B23 | The Occupancy grid ignored places taken out of service: a partial block counted nothing, a whole block on a shared facility counted only its hours, the percentage never subtracted blocks, and it used the venue's usual hours rather than the day's, closed days counting as sellable; now blocks count by places and the percentage is of what that day could sell | `tests/partial-blocks.test.ts`, `tests/components/occupancy-tab.test.tsx` |
| B24 | The Occupancy grid's venue total added every court's line, counting a pitch's floor again for each court under it and blending shared facilities' places with the courts; each day now has two totals measured as the period report measures that day (the courts' floor once, shared facilities apart) | `tests/occupancy-totals.test.ts`, `tests/components/occupancy-tab.test.tsx` |
| B25 | The period report counted a booking on a shared facility as one place whatever its players, so shared facilities' utilisation and hours (by court, in all, by activity, by month and by hour) were under-counted; they now count each booking's places | `tests/occupancy-totals.test.ts` |
| B26 | On a new Postgres install with several servers starting at once, seeding the starter venues ran after the migration lock in a serializable transaction without retry, so one server's start failed with a serialization error; seeding now runs under the lock | `tests/migration-lock.test.ts` |
| S19 | A members-only or private venue's access list let in any account whose typed number was on it, where the install had no phone checks; an entry now counts online only for the account staff (or the inviting resident, by the guest's account email) linked it to, or an account that has proved the number; the counter is unchanged | `tests/access-accounts.test.ts` |
| B27 | A number the venue refused after it joined a waiting list was still offered a place, and the claim booked it; the refused-number rule and the venue being open are now asked again at the offer and the claim on every channel | `tests/waitlist-recheck.test.ts` |
| B28 | A league result could be overwritten or confirmed stale: report, confirm and staff decisions read the match and then wrote it by id, so a correction racing a confirmation or decision could turn a settled result back to reported, and a confirmation confirmed whatever score was there; now one transaction on the locked row against a version the database moves on every change (migration 0177), stale answers refused | `tests/league-results-race.test.ts`, `tests/competition-entrants.test.ts` |
| M16 | A person's concession and a promo code combined through the API only (the form and the counter allowed one): by the owner's decision of 27 October 2026, one rule on every path (the venue's stacking setting, one discount at a time by default, and whether the code combines), one order and rounding, each place's share of a code recorded and given back exactly on a withdrawal; a limited code's last use held by the database | `tests/discount-stacking.test.ts`, `tests/components/booking-form-discounts.test.tsx` |
| M17 | A percentage promo code was rounded half up before the documented round-down (15% of RM10.05 gave RM1.51) | `tests/discount-stacking.test.ts` |
| S20 | A participant whose only link to a venue was a concession proof, a membership or a pass sold there was not known to that venue, so its staff could not find or act on them; those links now make them known to that venue and its business's branches only | `tests/participants-known-links.test.ts` |
| B29 | Where the site could not check phone numbers, staff and guardians were still offered a code for a guardian recorded by name and number to take their relationship over, which could never succeed (the account must prove the recorded number); the code is now neither offered nor made there, and staff are told to invite the account as another guardian | `tests/guardian-contact.test.ts` |
| B30 | Independent bookings retried each other under load: a claim (and every row pointing at a booking) checked its booking as it was written, reading the page of the bookings index every new booking goes to and keeping that read, so three unrelated bookings in a row made the middle one a pivot; on a loaded machine the retries came in runs (36 for 24 bookings on different courts of one venue in a full Postgres run, every booking made). Rows pointing at a booking are now checked at commit (migration 0206) | `tests/booking-references-deferred.test.ts` (on Postgres, the old order of events cancels the middle booking every time; now all three commit), `tests/contention.test.ts` |
| B31 | A guardian relationship made by a manager's exception stayed on the managers' reminders after it was reviewed on its review date before 08:00 in Malaysia: the review's date was taken in the database's UTC, not the install's | `tests/guardian-contact.test.ts` ("a review made early on the review date…") |
| B32 | A booking made through the venue's API key was not asked what the counter asks of the number: a number the venue had refused could be booked, and the house rules, the unpaid-bookings limit and no-show strikes were not applied, although the API's own waiting-list join refused that number | `tests/benefits-paths.test.ts` |
| B33 | An offer of a waiting-list place made before the venue refused the number could still be written to the outbox and sent to that number afterwards; unsent offer messages are now withdrawn when the number is refused | `tests/benefits-paths.test.ts` |
| B34 | A customer moving a booking got the members' longer booking window from the number typed on the booking alone, so a guest or another account booking on a member's number could move into it; a move is now asked the window with the booking's account and online trust | `tests/membership-validity.test.ts` ("a member books further ahead…") |
| B35 | Withdrawing a company account's invoice while a booking on it was being changed could deadlock: the invoice's delete cascaded onto bookings another transaction held; the invoice now locks its bookings first | `tests/place-withdrawals-money.test.ts` ("a withdrawal racing the month's invoice…", Postgres) |
| B36 | A review of the retention periods dated the day they were changed was refused as "before the periods were last changed" when the change was made between midnight and 08:00 in Malaysia: the change's date was its UTC date | `tests/retention-policy.test.ts` ("judge a review's date against the day the periods changed where the install is…") |
| B37 | A receipt's and a platform invoice's paid date was printed as the UTC date of the payment, so one paid between midnight and 08:00 in Malaysia showed the day before; both now show the install's date | `tests/receipts.test.ts` (unchanged; the date is `localDateOf`, tested in `tests/time.test.ts`) |
| B38 | Two places nobody was named on, taken off one booking held by a deposit paid online, shared one deposit credit note's key: the second credit note was not written though the refund owed went up; the key is now the withdrawal | `tests/receipt-names.test.ts` ("a deposit's part credited for places nobody was named on") |
| M18 | The venue's API key booked with no discount at all, though ADR 0025 and the pricing document said every path took them; it now takes `concessionId`, `placeConcessions` and `promoCode` through the one calculation the form and the counter use | `tests/benefits-paths.test.ts` |
| S21 | A resident inviting a guest by email could learn whether an account held that address (`GUEST_ACCOUNT_UNKNOWN`, and an entry linked at once); the address is now never looked up, a single-use, hashed, expiring invitation is emailed either way, and it links only its entry to the account that accepts it signed in with that address | `tests/guest-invitations.test.ts`, `tests/components/guest-invitations.test.tsx` |
| S22 | Inviting a player to a game or a group by email revealed whether the address had an account (the host's or organiser's roster named them at once, the daily invite counter counted only real accounts, and an email was queued only for one), and sign-in and password reset answered measurably faster for an unknown address; invitations are now emailed either way and accepted signed in, every attempt counts, and sign-in and reset do the same work either way | `tests/player-invitations.test.ts`, `tests/no-enumeration-timing.test.ts` |
| S23 | Receipts and credit notes kept the names of whom their lines were for (a guardian's children, a child taken off a booking, a family membership's dependants) after the retention period and after an erasure, and a participant's erasure did not reach receipts; names are now kept apart from a line's words and cleared by retention, account erasure and participant erasure (older lines by their known shapes and the names known for the receipt), and again after a restore | `tests/receipt-names.test.ts` |
| S24 | A Postgres connection cut while a transaction held it (the server restarting, an administrator ending it) raised an error nobody listened for, which stops a Node process; such a connection now fails only its transaction and is thrown away. Found by the full Postgres suite, where a test database dropped under a background password-reset run did it | `tests/db-connection-lost.test.ts` (Postgres) |
| S18 | The platform owner's notice after having a document scanned again always said it was put back in quarantine, whatever the scan then found; it now says whether it passed, was refused or still could not be scanned | `tests/components/document-policy.test.tsx` |
| B39 | A dearer coach's difference still owed stayed owed when the lesson was given to another coach again, and the new change's terms ignored it: giving it back to the first coach refunded RM20 while RM20 was still owed; a difference still owed now ends with the next change, whose terms count from what the customer paid for | `tests/coach-difference-online.test.ts` |
| B40 | A booking checked a members-only venue's eligibility before its transaction, so a membership suspended or cancelled while it was being made could leave a confirmed members' place neither refused nor flagged; the check is asked again inside the booking's transaction. Found by the suspension race test | `tests/membership-suspensions.test.ts` ("suspending while somebody books", Postgres) |
| M19 | *Send again* on an e-invoice LHDN had found invalid set it back to a draft and sent the same record again, overwriting the stored document, its submission and document IDs and when it was sent, so the record of what LHDN held was lost; a document that reached LHDN is now never changed or deleted (a database trigger), and a correction is a replacement under its own number | `tests/einvoice-records.test.ts` |
| M20 | E-invoicing could invoice a sale twice or name the wrong document: a customer's own e-invoice that failed let its receipt into the month's consolidated one, and sending it again invoiced the sale twice; a large sale whose own e-invoice failed or was refused could go into the consolidated one; a credit note could name a document not yet valid or found invalid, or be dropped against an invalid consolidated one; LHDN's *Cancelled* answer was ignored. Each now follows what the consolidated document records it carried and what LHDN last said | `tests/einvoice-records.test.ts` |
| M21 | Credit waiting on a closed company or school account could be paid back only outside the app, with no record, and could still come off a later invoice, refunding it twice; a manager now records it paid back by hand, after which no invoice takes it, and closed accounts with credit waiting stay listed | `tests/account-credit-settled.test.ts` (with an invoice racing it, Postgres) |
| S25 | Google sign-in with an address Google had not verified answered "An account with this email already exists" only where one did, telling anybody whether an address had an account; every unverified address is now refused in the same words and nothing is made. Found by the sign-up work | `tests/sign-in.test.ts` |
| B41 | The venue's API key was not held to no-show strikes or the guest limit where the venue took payment online: the booking was made neither held nor paid, where online it would have been held until paid; the API now refuses it | `tests/same-policies.test.ts` |
| B42 | The counter, and waiting-list entries made at the counter, treated a member's number as a non-member's for the members' longer booking window, so they were always refused `LIMIT_AHEAD_MEMBERS`; the number on staff's word now gets the member's window | `tests/same-policies.test.ts` |
| B43 | A number struck out for no-shows could get a class place through a waiting-list claim (held until paid), though enrolling directly refused it; a class place cannot be held, so the claim is refused as enrolling is | `tests/same-policies.test.ts` |
| B44 | Chinese times drawn in the browser read on the 24-hour clock ("18:41") where the server wrote 下午6:41: Chromium has no data for `zh-Hans-MY` and falls back to a 24-hour default; the shared formatter now asks for the 12-hour clock for Chinese. Found by the acceptance scenarios (*Times AE*) | `tests/staff-times.test.ts`, `tests/uat/round7.uat.ts` (Times AE) |
| B45 | A member whose membership was suspended today was refused at a members-only venue as a non-member ("ask the venue how to join") rather than told it is suspended; the refusal now gives the suspension and its date. Found by the acceptance scenarios (*Suspension AD*) | `tests/membership-suspensions.test.ts`, `tests/uat/round7.uat.ts` (Suspension AD) |
| B46 | The front desk opening *Venue details* was shown "Front-desk accounts cannot change this" without doing anything: the online payments panel asked for the venue's payment account and hold policy, both a manager's; the desk now sees the payments only. Found by the acceptance scenarios | `tests/components/online-payments-desk.test.tsx` |
| B47 | Two guest invitations at once from one resident could both pass the venue's guest allowance and go one over: the running guests were counted in a transaction that locked nothing; the host's list entry is now locked first, on every path | `tests/guest-counting.test.ts` ("two guests registered for one host at once") |
| M22 | Staff cancelling a booking paid at the counter wrote a full refund in the way it was paid, with no record that the money was handed back, no choice of credit or keeping the venue's late share, and the front desk could do it for a payment taken on any earlier day; staff now choose the outcome after a preview, a counter payout is recorded with who paid it out, and a payment from an earlier day is a manager's to give back. Found by the round 8 audit | `tests/counter-refunds.test.ts` (PGlite and Postgres) |
| S26 | The install's two-factor requirement was enforced only on the dashboard's routes: the counter's booking and class enrolment, availability, previews of venues not yet open and the platform invoice page recognised a staff session without it, so a password alone could book past the rules and mark bookings paid at the counter; every path that treats a request as staff now passes the same gate, and asking for a staff power while held answers `TWO_FACTOR_REQUIRED`. Found by the round 8 audit | `tests/staff-two-factor-gate.test.ts` |
| S27 | A venue's staff calendar feed address, which lists customers' names and numbers, was stored as it was given and never expired; it is now kept as a hash (migration 0240, existing addresses working by their hash) with a copy sealed with the install's secret for staff to copy again, and lapses after a year. Found by the round 8 audit | `tests/calendar-feed-hash.test.ts` |
| B48 | Names and emails on bookings, class places, waiting lists and sign-up had no length limit (a 20,000-character name was stored); names are capped at 100 characters and emails at 254 on every path and in the store | `tests/contact-lengths.test.ts` |
| B49 | 29 route handlers answered 500 to a JSON body that was not an object (`null`, a list, a number); they now answer 400, and a test sends every writing handler such bodies | `tests/bad-bodies.test.ts` |
| B50 | The date a refund was due by, the date it was made and a customer's receipt dates were UTC dates, a day early before 08:00 in Malaysia; they are the venue's calendar dates | `tests/refund-local-date.test.ts`, `tests/manual-refunds.test.ts` |
| S28 | Closing a day, cancelling a class, a rain-out and a court taken out of service cancelled bookings and enrolments with no entry for each in the activity log, and about thirty staff write routes (class scheduling, blocks, hire deposits kept, extras, notices, inductions, go-live, tournaments, competitions, leagues and their fees, messages sent again, WhatsApp settings, photos, a venue suspended by the platform) wrote none; each now does, and a source check fails for any admin write handler that logs nothing and is not allowed with a reason. Found by the round 8 audit | `tests/staff-log-coverage.test.ts`, `tests/activity-log-coverage.test.ts` |
| S29 | The staff activity log, alerts and error reports caught every failure of their own write, a serialization failure included: on Postgres the transaction they sat in was left aborted rather than run again, so its next statement failed (a membership suspended while somebody booked a day inside it answered with an error) | `tests/aside-writes.test.ts` (also on Postgres), `tests/membership-suspensions.test.ts` |
| B51 | The schedule listed a day's neighbours' bookings that only touched it (zero-minute rows at midnight) and showed an after-midnight booking under the following day; it now lists only what overlaps the day's own window, the evening's late hours with the evening | `tests/schedule-own-day.test.ts` |
| B52 | Twelve kinds of activity-log entry (tournament rules, results and corrections, league results and joining) had no label and showed their raw names; they are labelled in every staff language, and the label test reads every way an action is chosen | `tests/activity-labels.test.ts` |
| M23 | A tournament's entry fee was read from the tournament at payment and on the counter receipt, so changing the fee would have repriced entries already made; each entry keeps its own fee (migration 0238, backfilled) | `tests/tournament-changes.test.ts` |
| M24 | Closing an account cancelled its paid upcoming bookings with no refund, credit note or waiting-list offer, and also cancelled bookings played earlier that day; each is now cancelled on the customer's own terms through the one cancellation path, online money sent back or listed as owed (never to credit, the account being gone), and the erasure refused where it would give back stored credit. Found by the round 8 audit | `tests/erasure-money.test.ts` |
| M25 | Voiding a pass, or a membership without money back, wrote a credit note for the whole sale; voiding is no longer a refund, and money back (for a pass, its unused part only) is a choice of its own | `tests/void-credit-notes.test.ts`, `tests/receipts.test.ts` |
| M26 | A company or school account's booking cancelled after its invoice stayed charged with no credit note, and the account's amount owing disagreed with its invoices; the cancellation is credited to the account against the invoice once (migration 0242), and owing is what the unpaid invoices say | `tests/account-cancellations.test.ts` |
| M27 | Late-cancellation fees kept were missing from the period report's collected figure and its tax, which drifted a cent from the journal; the report and the journal now count them with the same SQL, and a late fee's tax is worked out on the fee itself | `tests/late-cancel-report.test.ts` |
| M28 | The sales journal subtracted the credit note of a cancelled booking paid with a pass without ever having counted it as a sale (the pass was), understating takings; such credit notes are left out | `tests/void-credit-notes.test.ts` |
| B53 | Entries made at once could overfill a tournament, and a division's cap or a league join could race (two joins of one player hit a database error); entries are counted and taken under the tournament's (and competition's) lock, league joins under the league's | `tests/entry-races.test.ts` |
| B54 | Two first splits of one booking at once failed with a database error, and a re-split while a friend was paying left a paid share at the old amount; splitting runs under the booking's lock and a re-split is refused while a share is paid or being paid | `tests/split-races.test.ts` |
| B55 | The schedule kept no track of which answer it was waiting for: an answer for a day or venue left a moment before could arrive late and show under the one now chosen; a late answer is dropped | `tests/components/staff-place.test.tsx` |
| B56 | Claiming a waiting-list offer read the entry without locking it, so a claim and the entry being left or turned down at the same moment could both go through; the entry is locked by each | `tests/waitlist-leave.test.ts` |
| B57 | On a phone, *Renew or buy a membership* in the booking form opened the venue's plans under the booking sheet, which stayed open over them, so *Join* could not be tapped; following the link closes the form. Found by the acceptance scenarios (*Membership W*) | `tests/components/booking-dialogs.test.tsx`, `tests/uat/round6.uat.ts` (Membership W) |
| B58 | A court given back late with all of it kept told the customer "the rest goes back the way you paid" when nothing does; it now says nothing is refunded | `tests/components/q8a-customer-flows.test.tsx`, `tests/uat/round8.uat.ts` (Late AK) |
| B59 | Removing a member of staff who had recorded an induction, sold a membership or a pass, made a promo code or given credit at the counter (or an owner who had decided a venue application) failed with a server error: six links from the first migration had no rule for a removed account; they now keep the record and drop the link (migration 0251), the activity log keeping the name | `tests/staff-accounts.test.ts` |
| B60 | The front desk could not open the sections of *Venue details* it is shown read-only (Facilities, Photos, Extras, WhatsApp, Who it is for, House rules, Manager overrides, Waiver, Notices), so it could not read the access list, the house rules or the waiver: the buttons that open them were inside the disabled, button-hiding read-only area. Each now keeps its opening button outside and only what opens read-only. Found by the acceptance scenarios (*Invitations AA*) | `tests/components/desk-sees-what-it-may.test.tsx` (also on Postgres), `tests/uat/round7.uat.ts` (Invitations AA) |
| B61 | Booking rules that narrowed a court's (or a sport's, the venue's or the business's) hours from today saved without looking at bookings already made, leaving them outside the hours; the change is now refused while any would fall outside, every one listed, as narrowing from a date is | `tests/dated-changes.test.ts` |
| B62 | The hours-from-a-date form named its fields *Opens* and *Closes*, as the usual hours do, so a screen reader heard two of each on the same page; they are named for the date they apply from. Found by the acceptance scenarios (*Venue 1*) | `tests/uat/venue-setup.uat.ts` (Venue 1) |

### Resolved limitations without a number

Limitations recorded as prose rather than as numbered defects, and how each
was resolved. Kept so the register shows what changed, not only what is left.

| Limitation | Resolved by | Evidence |
| ---------- | ----------- | -------- |
| A booking that started while the desk was staffed and ran on after it shut got no door code, judged by its start alone | Staffing is judged over the booking's whole time, after midnight too; a booking staffed for part of it gets the code, or the counter where the venue keeps somebody on the desk until such bookings end (`partly_unstaffed`, migration 0110); the booking's page says which beforehand ([venue operations](../features/venue-operations.md)) | `tests/access.test.ts` ("a booking across the staffed boundary") |
| Cancelling a weekly series asked to confirm cancelling *all* upcoming sessions, then silently kept the weeks inside the cutoff | Each week's terms are previewed (free, late at the venue's share, or staying and why, with what is owed); the customer picks the weeks; late ones go only on terms accepted; a week whose terms changed refuses the lot (`SERIES_CHANGED`) ([booking](../features/booking.md#cancellation-and-no-shows)) | `tests/series-cancel.test.ts` |
| Two cancellations of a paid booking at once were listed as untested | Already tested; the register was out of date | `tests/refund-recovery.test.ts` |
| A waiting-list offer on a court under a pitch was listed as untested | Test added: the offer keeps the pitch from being sold over it and leaves the court beside it free | `tests/waitlist.test.ts` ("on a court under a pitch…") |
| A member of staff who lost both phone and recovery codes was locked out until the database was edited | An audited reset by a superior (an owner, or the business's manager; an owner only by another owner) with their own two-factor code and a reason; signs out, recorded, emailed to the account and every owner; the last owner from the server's console (`npm run reset-two-factor`) ([authentication](../architecture/authentication.md#two-factor-sign-in)) | `tests/two-factor-reset.test.ts` |
| The content security policy allowed inline scripts, so an injected script would run | A fresh nonce per response with `'strict-dynamic'`; Next.js puts it on its own scripts ([security](../architecture/security.md#response-headers)) | `tests/launch-security.test.ts`; `tests/e2e/launch.e2e.ts` (production build: a different nonce per page, on every script; a court booked with nothing blocked) |
| A member's rate and longer booking window went to whoever typed the member's number online (a decision of the time, reversed by the owner in October 2026) | Online, only for the account the membership is linked to or whose number it is, proved; at the counter, the number on staff's word ([privacy](../architecture/privacy.md#a-phone-number-is-not-identity)) | `tests/member-identity.test.ts`, `tests/impersonation.test.ts` |
| A deposit charged back after the rest was paid online left the booking showing paid in full | The booking owes the deposit's part again; the rest keeps its receipt under its own payment's key, so a later cancellation still owes it back ([payments](../features/payments-and-credit.md)) | `tests/stripe-disputes.test.ts` ("lost on a deposit after the rest was paid online…") |
| A lost dispute on a platform invoice or WhatsApp pack left it showing paid | Lost in full: the invoice is due again in 14 days (voidable by an owner); the pack is due again and its messages taken back, below nothing for any already sent | `tests/stripe-disputes.test.ts` ("…lost, the invoice is owed again") |
| A refund on withdrawing from a tournament before the draw, and a league fee paid after leaving, were untested | Tests added: owed back in full where the rules say so; a fee paid after leaving is owed back with no receipt and the place not marked paid | `tests/tournaments.test.ts`, `tests/leagues.test.ts` |
| Players moved into or out of a knockout filled again were not messaged | Those newly through and those no longer through are emailed; somebody who left is not ([tournaments](../features/tournaments.md#corrections-after-the-knockout-has-begun)) | `tests/tournaments.test.ts` ("tells who is newly through…", "tells the one who takes their place…") |
| Ranking by set or point ratios, and a forfeit score, could not be expressed | Rank keys `set_ratio` and `point_ratio`; a walkover's score in the rules, checked against the match as set up, used in the tables of tournaments and box leagues; the volleyball and goals templates carry one ([tournaments](../features/tournaments.md)) | `tests/brackets.test.ts` ("ratios and forfeit scores"), `tests/competitions.test.ts` |
| A player's tournament report waited for the other side with no time limit | The other side is emailed; unanswered for 24 hours it stands through the same checks, or goes to staff as disputed if it no longer can ([tournaments](../features/tournaments.md#results)) | `tests/match-reports.test.ts` ("a report nobody answers") |
| Game, tournament and league emails were in English whatever the player's language | Written in the language the account last used the site in (`users.locale`, migration 0112), greeting and all ([messaging](../integrations/messaging.md)) | `tests/outbox.test.ts` ("a programme email in the player's language"), `tests/tournaments.test.ts` ("emails in each entrant's language") |
| A host's proposal to a time overlapping the game's own, on a court sharing its floor (a pitch over its court), was refused as taken | The new time is held space by space: in full on floor the booking does not hold, and outside the booking's own time on floor it does ([matchmaking](../features/matchmaking.md#moving-a-game-to-another-time)) | `tests/game-moves.test.ts` ("a proposal onto a court sharing the game's floor") |
| Kinds of kit (single and double kayaks) could not be booked together: each kind was a booking of its own | One booking takes some of several kinds at once, a number of each, all or nothing, from the booking form ([booking](../features/booking.md#several-courts-in-one-booking)) | `tests/hire-pricing.test.ts` ("are booked together…"), `tests/components/booking-board.test.tsx` ("kinds of kit") |
| Daylight saving was not supported: a booking at a wall-clock time skipped or repeated had no defined meaning | Skipped and repeated minutes are found from the runtime's zone database; a booking touching a change is refused (`CLOCK_CHANGE`) and not offered; either side, an hour on the clock is an hour held ([booking time model](../architecture/booking-time-model.md#time)) | `tests/clock-changes.test.ts` (London, New York, Sydney, 2026) |
| No multipart uploads off-site: a backup part over about 5 GB (a photos archive) was refused | Parts over one PUT go up in 100 MiB parts, each signed and MD5-checked, by the same upload-only key; unfinished ones are dropped by a lifecycle rule ([backups](../operations/backups.md)) | `tests/offsite.test.ts` ("sends a file larger than one upload in parts…", "stops at a part that arrives damaged…"); against the B2 stand-in, not a real bucket |
| A company account's invoice email and printable invoice were in English whatever the account's language | The venue picks one of the site's languages for the account (`venue_accounts.locale`, migration 0113); the email and the invoice are written in it, whoever opens the link ([payments and credit](../features/payments-and-credit.md#company-and-school-accounts)) | `tests/accounts.test.ts` ("an account's invoices in its language") |
| The staff dashboard was English only | Every staff screen reads its text from staff dictionaries in English, Malay and Chinese (`src/lib/staff-i18n`), the dashboard's language switch offers those three, and the server's English refusals are translated; a scan fails on any staff screen text outside the dictionaries ([regions](../product/regions-and-tax.md)) | `tests/staff-i18n.test.ts`, `tests/uat/staff-language.uat.ts` (Staff 1) |
| Adjacent buffers added up: two bookings each keeping 10 minutes free on the side they meet were 20 minutes apart | Minimum separation is shared (the larger of the two facing ones counts), kept apart from setup and cleaning time, which adds up; the database enforces both (`claim_gaps_apart`, migrations 0118–0119) and the board offers exactly what it accepts ([booking time model](../architecture/booking-time-model.md)) | `tests/separation.test.ts`, `tests/separation-migration.test.ts` |
| A first lesson or registration on an activity needing a sign-off had to be done at the counter | Customers apply online (questions, declarations, documents, a video briefing, the waiver, a guardian's declaration); staff or an authorised coach approve remotely; an in-person step stays required where set; a slot asked for is held by an expiring claim and booked through the ordinary path on approval; pending grants no booking, no door code ([activities](../features/activities.md#registering-online-for-approval), [ADR 0019](../architecture/decisions/0019-approval-requests-apart-from-bookings.md)) | `tests/approvals.test.ts` |
| One booking stopped at eight places or fifty whatever the venue allowed; *any court*, the public API and open games took fewer | Eight unless the venue sets more, up to every place of the resource, on every path | `tests/places-per-booking.test.ts` |
| Kinds of kit were listed side by side, with no heading over them | A venue groups resources under one heading on its grid and booking form; kinds are still booked together, all or nothing | `tests/resource-headings.test.ts`, `tests/components/booking-board.test.tsx` |
| Outages migrated from the half-hour diary left their last night's late hours bookable | Staff close those hours from *Out of service* where they are free; bookings sold there since are listed and left alone ([legacy installs](../archive/migrations/legacy-installs.md)) | `tests/outages.test.ts` |
| Texts a venue left as built (the rain-out reason, concession presets, the enquiry reply's subject) reached customers in the staff member's language | Each customer gets them in their own language; anything staff typed stays as typed | `tests/rain-outs.test.ts`, `tests/concessions.test.ts`, `tests/enquiries.test.ts` |
| Text the server composed for the staff dashboard stayed English | Said in the staff language through `srv.` phrases; new records keep the phrase beside their English (migration 0120) | `tests/staff-server-text.test.ts`, `tests/tournaments.test.ts` |
| On Postgres, a new connection's `SET jit = off` overlapped the caller's first query (a pg deprecation warning, refused by pg 9) | JIT is turned off before the pool hands a connection out | `tests/postgres-pool.test.ts` |
| Untested paths: the two-year prune of the staff activity log, the daily venue order | Tests added: an entry past two years goes, one inside stays; the order is the same all day, another the next, never by name, each venue once across its pages | `tests/privacy.test.ts` ("keeps the staff activity log two years…"), `tests/browse.test.ts` ("is in a fair order…") |
| No browser test on a phone-sized screen; a venue's change of a game's time from the staff screen not driven in a browser | Acceptance actors on a phone (390 × 844) or tablet (820 × 1180), each page checked to fit without scrolling sideways; Phone 1 books on a phone, Tablet 1 has a manager move an open game while its player confirms on a phone ([testing](../development/testing.md#visual-acceptance-scenarios)) | `tests/uat/devices.uat.ts`, run against the production build on PGlite, 2 of 2 |
| A booking made on approval was not held for payment at a venue asking payment to hold | Approval is eligibility only: the booking follows the venue's payment policy, held by the ordinary hold for the activity's payment hours, confirmed when paid, let go when not, the approval standing; a late payment becomes the booking if the slot is free, else owed back, once ([ADR 0020](../architecture/decisions/0020-approval-to-booking-payment-and-authority.md)) | `tests/approval-workflow.test.ts` |
| Any member of staff, front desk included, could approve any application, and a coach decided at a private link | A safety assessment is approved only by a manager, a coach named for it signed in to the account a manager linked, or front desk delegated by name; the same in the Sign-offs tab; revoking takes the sign-off back and flags the person's bookings for staff | `tests/approval-workflow.test.ts` |
| The door-code check read a resource's main activity's rules, not the activity booked, and ignored an activity the venue takes approvals for | The booked activity's rules, and any activity taking approvals, need a sign-off in force on the day, however the booking was made; supervised attendance never gives a code | `tests/approval-workflow.test.ts` |
| Approval documents were images only, kept by fixed periods with no exceptions | PDFs accepted, checked by their bytes and structure, never rendered, downloaded only; documents and records kept by purpose, an activity keeping less, holds for legal, safety or dispute reasons with a review date ([ADR 0021](../architecture/decisions/0021-approval-retention-and-pdf-documents.md)) | `tests/approval-documents.test.ts`, `tests/approval-retention.test.ts` |
| A shared facility could only be turned over per place, gaps and cleaning added up | The venue says whether a shared facility turns over per place (added up, or the longer of the two) or whole, kept clear between sessions; the database enforces each | `tests/shared-turnover.test.ts`, `tests/shared-turnover-migration.test.ts` |
| Receipts and the off-peak refusal named a built-in concession in the language staff saved it in | The receipt and the refusal say it in the customer's language by its key; the line as stored, the amounts and the books are unchanged; older receipts where it can be told for certain | `tests/receipt-languages.test.ts` |
| A heading over kinds of kit showed on the grid but not in search | Search lists each kind under its heading as itself (price, places left, sign-off need), links to the venue's grid with the heading marked, with no extra queries | `tests/search-groups.test.ts`, `tests/components/search-groups.test.tsx` |
| A tournament's set-up and draw, and corrections, were not driven in a browser | Acceptance scenarios *Tournament 3–6*: set-up from a template with divisions (refused to another venue's manager), entries and draws with the public fixtures checked, results by the desk and an official through the final and third place, and a correction after the third-place match held under review until the organiser lets it stand | `tests/uat/competition.uat.ts` |
| A parent could not apply for a child from their own account: a minor applied from their own, typing a guardian's name | People an adult manages, held minimally under the adult's account; applications, sign-offs, bookings, door codes and waivers per person, the child's eligibility never the parent's or a sibling's, nor the parent's the child's ([ADR 0022](../architecture/decisions/0022-children-managed-from-an-adults-account.md)) | `tests/guardian-applications.test.ts` |
| Supporting documents were checked by their structure but not scanned for malware | Each document is quarantined and scanned by ClamAV's clamd before anybody can open it, never released unscanned, refused or unscannable files wiped; with no scanner, uploads wait in quarantine and nothing is released; there is no opt-out ([ADR 0024](../architecture/decisions/0024-documents-scanned-before-release-retention-by-purpose.md)) | `tests/document-scanning.test.ts`, `tests/document-scanning-engine.test.ts` |
| A restore brought back accounts erased since the backup, and records retention had already deleted | Erasures are kept in a ledger and re-applied, and retention re-run, before the app serves after a restore | `tests/backup-scripts.test.ts` |
| Booking for a child worked on the approval's slot and one court online only; the waiting list, the counter, the venue's API key and several courts booked for the adult | Every booking path names the people taking part, each a place and checked on their own; waiting lists keep who and how many; the counter books only for a participant the venue knows with a guardian on the number; an API key never creates a participant ([booking for somebody else](../features/booking.md#booking-for-somebody-else)) | `tests/participant-bookings.test.ts`, `tests/people-per-court.test.ts` |
| A second adult at the counter for a child the venue knew could only be handled by recording the child again | Staff start an invitation for the same participant; the adult accepts it signed in, and an existing guardian agrees or a manager records an exception, all recorded and audited | `tests/counter-guardians.test.ts` |
| Search and the venue's grid said a resource needs a sign-off whoever was looking | Each person chosen as taking part sees their own status, privately, in one batched query; nobody chosen or signed out, the requirement only | `tests/search-eligibility.test.ts`, `tests/components/who-takes-part.test.tsx` |
| Answers to the venue's grid for a signed-in account (member rates, staff-only rooms) carried no cache rule | Private and never kept by a shared cache, every answer varying by cookie | `tests/search-eligibility.test.ts` |
| A guardian's own pages (bookings on the account, *My booking*, a waiting-list offer), the booking confirmation and the waiting-list dialog did not say which child a booking was for | Each names the participant | `tests/components/participant-named.test.tsx`, `tests/components/booking-board.test.tsx` |
| A refusal for want of a sign-off did not say which of several people lacked one, and told a guardian to sign in as the child | It names the participant, on booking, a change of time and the waiting list, in four languages | `tests/participant-bookings.test.ts`, `tests/uat/participants.uat.ts` |
| Nine kinds of activity-log entry showed staff a raw name (`tournament.match_moved` and others), and the choice of who takes part was a 16-pixel tap target on a phone | Each has words in English, Malay and Chinese, a test failing on any logged action without; the choices are at least 24 pixels | `tests/activity-labels.test.ts`, `tests/components/participant-named.test.tsx` |
| A document that failed malware scanning could not be re-queued | One waiting for a scanner goes back to quarantine by itself once a scanner answers; the platform owner may have a failed one scanned again, its bytes checked against the stored hash, at most three times, each request recorded, never released by it | `tests/document-scanning.test.ts`, `tests/document-scan-migration.test.ts` |
| The erasure ledger was kept on the server only: losing the server lost erasures since the last off-site set | Entries go off-site in signed, chained segments within a minute and with every set; a restore replays them, and blocks until acknowledged where it cannot show the ledger complete | `tests/erasure-ledger.test.ts`, `tests/erasure-ledger-restore.test.ts` |
| Guardians were not told when another adult became a guardian, and staff could add one on the adult's declaration alone | Another guardian only by invitation and agreement or a manager's recorded exception; the other guardians are told through the outbox; a guardian may report a relationship for review (pause, keep, revoke) | `tests/counter-guardians.test.ts`, `tests/components/guardian-requests.test.tsx` |
| Coaches saw the participant's name on a lesson with no stated limit | The owner confirmed it: a coach sees a child's name only on lessons assigned to them while their coach record is active; no venue-wide list, guardian records or documents | `tests/coach-scope.test.ts` |
| Search showed only the signed-in account's own applications: a second guardian saw *approval required* while another's waited | Each participant's status counts their applications whoever made them; answers and documents stay with the applicant, staff and reviewers | `tests/guardian-eligibility.test.ts` |
| A booking for several people was changed as a whole: one person could not be taken off with their share refunded | Where the activity sells places separately, one person is taken off: the place released and offered to the waiting list, its price off what is owed or refunded on the venue's terms with its own credit note, passes and concessions given back; a group gives up a place; a court hired whole only un-names; anything else refused with its reason | `tests/place-withdrawals.test.ts`, `tests/components/withdraw-people.test.tsx` |
| A pass entry paid for a booking, not a person on it, and a concession was declared per booking | Passes and concessions carry a scope (booking, resource, one person's place, a number of places), redeemed once per place under a database guard; everything issued before keeps booking scope | `tests/entitlements.test.ts` |
| Members-only access, a member's longer window and house-rule limits followed whoever booked | Account privileges (booking earlier, limits) stay with the account; a members-only session needs each participant's own membership or a family membership naming them, one check on every path | `tests/membership-scope.test.ts` |
| Several passes for one booking could be spent through the API only | The booking form and the counter's payment step choose which pass pays for whom (one for the booking, or each person's own), by the plan the engine pays by | `tests/pass-allocation.test.ts`, `tests/components/pass-allocation.test.tsx` |
| Participant and family memberships were sold at the counter only | Bought online for oneself, a child the account acts for, or a family within the plan's limit; active only once paid | `tests/membership-purchases.test.ts`, `tests/components/join-membership.test.tsx` |
| A child whose only guardians were a name and number got another guardian only by a manager's exception; such a guardian could not register later; nothing reminded managers of flagged relationships or review dates; participants no venue knows had no owner screen | Staff send a code to the recorded number for agreement, withdrawal or a check; a recorded guardian takes the relationship over with a proved number and a code; managers see reviews and due dates under *Needs attention*; the owner reviews every venue's | `tests/guardian-contact.test.ts`, `tests/components/contact-guardians.test.tsx` |
| A participant's remembered concession proof, guardian requests, withdrawn places and place benefits were missing from the account's data export | Each is in the export as a structured record (who verified by role, never by name; no files) | `tests/participant-export.test.ts` |
| Tournaments and leagues took entries from an account for itself only; staff could not enter a player at the counter; members-only competitions checked the account's membership; a league partner's gender was not asked; staff league decisions and walkovers told nobody | A guardian enters a participant, staff enter a player at the counter, both through the self-entry checks; members-only follows the entrant's own or a family membership; a gendered league of pairs asks the partner's; both sides are emailed a staff decision | `tests/competition-entrants.test.ts`, `tests/components/competition-entrants.test.tsx` |
| One person's member price or concession on a receipt was in English whatever the customer's language | Said in the customer's language (built-in concessions by their key) with the person's name; the venue's own words, stored lines, amounts and older receipts unchanged | `tests/receipt-languages.test.ts` |
| The membership payment return page said "You're a member" for a child's or a family membership | It names whose membership it is and whom a family one covers | `tests/payment-return-membership.test.tsx` |
| A guardian entering somebody in a tournament or league was asked for "your" details and shown "Pay my entry"; tournament emails did not say whose entry | The forms and fee buttons name the person entered, and every tournament email about such an entry starts by saying whose it is | `tests/components/entering-for-someone.test.tsx`, `tests/tournament-entry-mails.test.ts` |
| The code sent to a guardian recorded by name and number was always in the install's first language | Staff choose the message's language, starting from their own site language | `tests/components/guardian-code-language.test.tsx` |
| Nobody, staff included, could move a one-to-one lesson: it was cancelled and booked again | The customer moves it keeping the coach; staff also to another coach while unpaid; the coach's hours and other lessons checked, the coach claimed with the court | `tests/lesson-moves.test.ts`, `tests/coaching.test.ts` |
| Only the platform owner could run the integrity check on demand | A manager runs it for their own venues, scoped in each query | `tests/integrity.test.ts`, `tests/components/owner-panels.test.tsx` |
| A waiting-list offer's link opened in the browser's language, not the email's, and Malay, Chinese and Tamil emails and pages wrote times the English 12-hour way | Links MySenam sends carry the message's language (`?lang=`), used where the visitor has chosen none; times by one formatter per language in the venue's zone ([regions](../product/regions-and-tax.md)) | `tests/link-locale.test.ts`, `tests/message-times.test.ts` |
| `AGENTS.md` said box leagues use `recordResult` | Corrected to the design the owner confirmed: the shared rules through the leagues' own result functions | `tests/leagues.test.ts`, `tests/league-results-race.test.ts` |
| A membership sold at the counter could overlap one a participant already had; the API booked without the venue's discounts | The counter refuses the same overlap as buying online; the API takes the discounts through the one calculation | `tests/benefits-paths.test.ts` |
| A waiting-list claim asked only the refused number, the venue being open and its access | It asks what the booking would ask on its path: house rules, the unpaid limit, strikes, a members' place by its date | `tests/benefits-paths.test.ts`, `tests/membership-validity.test.ts` |
| A paid lesson could not be given to another coach | A manager gives it with the money effect shown first: kept as paid, or adjusted (owed at the counter, or back to credit, online or by hand with a credit note); the venue may assign coaches instead of customers choosing | `tests/lesson-coach-changes.test.ts`, `tests/lesson-venue-assigns.test.ts` |
| Taking one person off a booking held by a deposit or charged to a company account was refused | Supported: off the balance first, then the deposit's part back; before the invoice off the charge, after it a credit note off the next invoice | `tests/place-withdrawals-money.test.ts` |
| A family membership's dependants could be swapped freely and without limit during a term | Changes follow the plan's policy: places per term, replacements, the next term's list, a manager's correction with a reason, every change kept | `tests/membership-covers.test.ts` |
| A members' place was checked against a membership active today, and the customer's own place not at the counter or through the API | Each person's cover is checked for the session's date on every path, again at check-in and the door, and a membership that stops flags bookings for staff | `tests/membership-validity.test.ts` |
| Signing up said when an address already had an account (`409`) | Sign-up takes the address only and always answers *check your email*; the account is made by the link emailed to a new address, an address with an account is told how to sign in ([signing up](../architecture/authentication.md#signing-up)) | `tests/registration.test.ts`, `tests/no-enumeration-timing.test.ts`, `tests/components/sign-up.test.tsx`, `tests/uat/emailed-links.uat.ts` (Email 4) |
| An invitation by email to a guest list, a game or a group could not be withdrawn; it lapsed | The resident (or the venue's manager, with a reason, logged), the game's host or sender, or the group's organiser withdraws one not yet accepted; one or the other against an acceptance; the link refused like one run out; the address told only if the email had gone | `tests/invitation-withdrawals.test.ts`, `tests/components/invitation-withdrawals.test.tsx` |
| A dearer coach's difference was taken at the counter only, and was not in the day's figures or on the customer's booking page | Paid online from the coach-change email or the booking page where the venue takes payment online, once, on its own receipt; the counter still takes it; counted in the day's expected, collected and outstanding figures | `tests/coach-difference-online.test.ts`, `tests/components/coach-difference.test.tsx` |
| Memberships had no suspended state | Suspended for a period by a manager with a reason and reactivated, covering nobody on its dates, bookings flagged and never cancelled or refunded, the end extended only where the plan says so | `tests/membership-suspensions.test.ts` |
| Times on staff screens and in staff calendars were written the English way, and a link's language reached only the page it opened | Every staff screen writes times by the shared formatter in the staff language and the venue's (or event's) zone; staff calendar and coach calendar in the language their address names; a link's language kept for the visit while the visitor has chosen none | `tests/staff-times.test.ts`, `tests/components/staff-times.test.tsx`, `tests/link-locale.test.ts` |
| The venue's API offered no withdrawal of one person's place | `GET`/`POST /api/v1/bookings/:code/withdraw`: the counter's terms, refusals and money, its own venue only, logged as the key, an optional `Idempotency-Key` | `tests/api-withdrawals.test.ts` |
| A refund made in Stripe's dashboard was not seen | `charge.refunded` and `charge.refund.updated` recorded once, never counting MySenam's own refunds twice; matched to a hand mark or what was owed, otherwise raised to staff and counted towards later refunds; nothing else changed by itself | `tests/stripe-gateway-refunds.test.ts` |
| Family-membership cover history was not in the account's data export | `membershipCoverChanges`, naming only people the holder is shown | `tests/membership-cover-export.test.ts` |
| The lesson form had no pay-from-credit option | The court form's credit path | `tests/lesson-credit.test.ts`, `tests/components/coach-booking-credit.test.tsx` |
| An e-invoice's states, corrections and LHDN identifiers were not all shown to staff | Each document's state, identifiers, LHDN's reasons and what can be done next, offering only what the server allows; corrections as replacements linked to what they replace | `tests/einvoice-records.test.ts` |
| The counter and the venue's API were held to the house rules, strikes and the guest limit while the documents said staff were not (a decision for the owner) | Decided 28 October 2026: one policy check on every path; the counter takes payment as it books where online would hold, the API refuses; a manager overrides selected restrictions where the venue permits, recorded per booking; blocked numbers, the unpaid limit, eligibility, the waiver, the window and capacity never overridden; unblocking says why ([ADR 0026](../architecture/decisions/0026-same-policies-on-every-path-with-manager-overrides.md)) | `tests/same-policies.test.ts`, `tests/components/counter-overrides.test.tsx` |
| Staff and coaches' messages were in the install's first language whoever read them | A language of their own per staff account, coach and venue's booking alerts, used for their emails, calendars and pages (the owner, 28 October 2026) | `tests/own-languages.test.ts`, `tests/components/own-language.test.tsx` |
| The limit on online bookings without an account counted the counter's own walk-ins, so a busy counter hour could trip it; guests registered at the counter did not count against a host's allowance | Bookings record the path they were made on; the limit counts online and API bookings only; members' and residents' guests count against one allowance on every path, a manager overriding where the venue permits (the owner, 28 October 2026) | `tests/guest-counting.test.ts`, `tests/components/guest-at-counter.test.tsx` |
| Staff could not correct a booking's name, phone or email | Corrected for one booking or its series or group, a new number asked the counter's policy check, logged | `tests/booking-corrections.test.ts` |
| Staff cancelled a weekly series booking by booking | The weeks still to be played cancelled together, each on its own terms | `tests/counter-refunds.test.ts` |
| The day list had no filters, cut its actions off on a laptop and had no print view; nothing started a booking from the dashboard, and a click on a free schedule cell blocked the court at once | Filters, an actions menu, a printable day sheet, *New booking*, and *Book this* or *Block* on a free cell | `tests/components/bookings-tab-day.test.tsx` |
| Staff could change nothing about a class or a tournament once made, short of cancelling it | A class's name, instructor, places (more offered to the waiting list, fewer never below those taken) and price for new enrolments, for one session or the rest of the series; a tournament's name, description, deadline, places and fee for new entries before its draw; a manager's, logged | `tests/class-changes.test.ts`, `tests/tournament-changes.test.ts`, `tests/components/change-editors.test.tsx` |
| The venue heard about bookings made online but not about customers' online cancellations and changes | Optional alerts for cancellations and changes, a day ahead unless widened, at the new-booking alerts' address and number, in their language | `tests/booking-change-alerts.test.ts` |
| Opening hours and prices could be changed only from today, and narrowing hours named the first booking in the way | Hours and court rates from a later date, read by the date booked; every booking in the way listed | `tests/dated-changes.test.ts` |
| The front desk was shown managers' controls everywhere and refused on use | What the desk may do answered from the server's own list; managers' editors read-only, their buttons hidden | `tests/components/desk-sees-what-it-may.test.tsx` |
| Staff were given a password by a manager, and a branch manager could not add or remove the branch's front desk | Staff invited by email to choose their own; a branch manager runs their front desk | `tests/staff-accounts.test.ts` |
| Counter top-ups, passes, memberships and entry and league fees could be taken with no record of how they were paid, and nothing added up the till | Every counter sale says how it was paid and who took it; a cash-up by method for the day, from the sales journal, the desk's own shift or a manager's whole day | `tests/cash-up.test.ts` |
| The front desk typed any price for a pass or a membership | Passes from the venue's products and memberships on its plans at their prices; another price a manager's with a reason, recorded and logged | `tests/counter-prices.test.ts` |
| A booking's price could not be changed or waived once made | A manager's price adjustment with a reason, before or after a counter payment | `tests/price-adjustments.test.ts` |
| Memberships, passes, receipts, vouchers and company invoices were long unsearchable lists | Search by code, name or number, status filters, fifty a page | `tests/counter-lists.test.ts` |
| Reports had no *last month* | A preset beside the existing from and to dates | `tests/components/counter-money.test.tsx` |
| Sign-in's next page could be sent to another site (`/\x`, `/%5C`, a tab) and its error text was taken from the address | One checked path for every sign-in route; error codes only | `tests/q8a-booking-flows.test.ts` |
| A waiting-list offer was claimed before the customer saw what it was, and a claim held until paid said *pay at the counter* | The offer shown first; after claiming, the hold and paying online | `tests/q8a-booking-flows.test.ts`, `tests/components/q8a-customer-flows.test.tsx` |
| A failed or abandoned online payment gave no code, no hold and no way to pay again | The return page shows the code, the hold or its release, and *Pay again* | `tests/q8a-payment-return.test.tsx` |
| The account page showed held bookings as payable at the counter and could not pay, split or change them | The account's bookings do what My Booking does | `tests/components/q8a-customer-flows.test.tsx` |
| A promo code was checked only when booking, the price shown not including it | Checked on the form, with its discount or its refusal | `tests/q8a-booking-flows.test.ts` |
| Messages sent people to look their booking up by code and phone again | A signed link that opens the booking, expiring after it | `tests/q8a-booking-flows.test.ts` |
| A customer past a no-late-cancel cutoff could not give the court back for others | A venue setting, off by default, to cancel late keeping it all | `tests/q8a-booking-flows.test.ts` |
| Bookings made before signing up did not show on the account | Shown and cancellable once the account's email is proved | `tests/q8a-booking-flows.test.ts` |
| A class enrolled online could not be paid online | Pay online after enrolling | `tests/q8a-booking-flows.test.ts` |
| On a phone the booking form sat under the grid, a refusal appeared far above it, and Book came before the questions it depends on | A sheet over the grid, the refusal beside Book with the venue's number, Book last with its price | `tests/components/booking-dialogs.test.tsx` |
| A proxy's error page showed as a parser error, and a list that could not be read showed as empty | One reader for every answer; *the site is busy* in the reader's language; *Try again* | `tests/read-response.test.ts`, `tests/components/staff-place.test.tsx` |
| A waiting list could not be left without the venue, nor an offer turned down | A private leave link and *No thanks*, passing the place on at once | `tests/waitlist-leave.test.ts` |
| Customers were told to call the venue without its number | The number to dial, and WhatsApp where the venue says so | `tests/venue-contact.test.ts` |
| The dashboard forgot its tab and day on a reload, and the day list went stale | Tab, day and venue in the address; the day list and schedule kept up | `tests/components/staff-place.test.tsx` |
| Dates were shown without their weekday | The weekday on every customer date and in messages | `tests/outbox.test.ts`, `tests/waitlist-leave.test.ts` |
| Dialogs did not hold focus or close on Escape, and 103 staff fields had no name for screen readers | One dialog for all; every staff field named, checked by a test | `tests/components/booking-dialogs.test.tsx`, `tests/form-labels.test.ts` |
| Alerts to platform owners and to a venue's staff, and the low WhatsApp credit email, were in English | Each written per reader in their own staff language; the English-only senders removed | `tests/staff-alert-languages.test.ts` |
| People enrolled in a class were not told of a new name or instructor | Emailed, with those holding an offer of a place, once each, in their language | `tests/class-changes.test.ts` |
| Lowering a tournament's places was thought not to be locked against an entry at the same moment | It is taken under the entry lock; tested both at once and with the entry held mid-write | `tests/entry-races.test.ts` |
| A draft e-invoice sent by the scheduler and by staff at the same moment could reach LHDN twice | Claimed before LHDN is asked (migration 0256), so it is sent once; an interrupted claim is marked not sent for a check in the portal | `tests/einvoice-sending.test.ts` |

## Production readiness

Implementation status ([feature status](../product/feature-status.md)) says
what is built and tested; this is what that does not show. Evidence is from
the code and tests as of 24 October 2026. What each row means for the launch
is under [what the launch depends on](#what-the-launch-depends-on).

| Concern | State | Evidence and what remains |
| ------- | ----- | ------------------------- |
| Load at marketplace size | Measured on one machine, not in production | At 400 venues and 918,000 bookings: a search near a point in 98 ms (p50) and 155 ms (p99), a booking in 12 ms, fifty bookings at once with no errors, and mixed traffic at 84 operations a second on four cores with no errors ([benchmark](../development/testing.md#results)). Bookings racing for one court, a shared floor, a hall or a coach end with the right number through and the rest refused within a second (`tests/contention.test.ts`). Not yet measured: more than one app instance, a managed database, real network latency |
| Double booking and capacity | Enforced by the database | An exclusion constraint on held time per space and a capacity trigger refuse overlaps whatever writes them, raw SQL included (`tests/capacity.test.ts`, "is still the database that prevents overbooking"); expired offers are let go before a claim. Truly parallel only on the Postgres run ([booking concurrency](../architecture/booking-concurrency.md)) |
| Spending credit and pass entries | Spent once | Serializable transactions with retry; `tests/concurrency.test.ts` ("spends credit once", "refunds a pass entry once") on Postgres |
| Refund races and crashes | A cancellation and its refunds are one transaction (M15); Stripe refunds are claimed before Stripe is asked (M9) and finished by the scheduler after a crash; a second payment for something paid is owed back, not kept (M12) | Two cancellations of a paid booking at once, and a class called off while a place in it is cancelled, refund once (`tests/refund-recovery.test.ts`). A crash before the request, after Stripe accepted it but before it was recorded, while recording, and during reconciliation each end in one refund; no transaction is open while Stripe is asked (`tests/refund-crash.test.ts`). Against a stand-in for Stripe only |
| Negative stored credit | Possible on purpose after a chargeback | Reported apart, as owed by customers, never netted against credit held (M14); no database guard |
| Money outside the books | None known | Money kept from hire deposits is receipted (M13); everything else that takes money is receipted |
| Linked courts in reports | The floor counted once (B11, fixed) | `tests/reports-floor.test.ts`: a hall sold as one pitch reads full; a block on the pitch comes off both courts' floor once |
| Identity | Accounts are identities; phone numbers are not, unless proved | A number is proved only where WhatsApp or SMS is configured, and those are tested against fakes. Online, membership benefits, sign-offs and an account's waiting-list places need the account's proved number or a link to the account (S12, S13); at the counter staff take the number on their word ([authentication](../architecture/authentication.md), [privacy](../architecture/privacy.md)) |
| Integrations | None checked against the live service | Every payment, message, e-invoice, sign-in and storage integration is tested against fakes ([below](#integrations-awaiting-live-verification-or-a-partner)); rows that take money or send messages name their leg in feature status |
| Backup and restore | Restored and compared on both engines, locally; off-site restore not verified against a real bucket | The scripts test backs up a venue's settings, a customer's credit, a paid booking and a photo, changes them all, restores, and compares every row of the main tables, each balance and each photo's hash (`tests/backup-scripts.test.ts`). Each snapshot is a set with a manifest of hashes; a set is fetched back from a stand-in S3 service, checked, and restored in a drill aside without touching the live data; a damaged part is caught. A `pg_dump` copy made by the app is listed, not loaded, before it is kept (the drill loads it). RPO up to 24 hours; RTO measured locally at about 2 minutes' restore for the benchmark database. Remains: the off-site drill against the real provider with a read key, on an isolated server ([backups](../operations/backups.md#restoring-from-the-off-site-copy)) |
| Continuous integration | Deferred by the owner for cost (accepted) | No CI run has passed on any commit since 16 October 2026; every check is run by hand and each release's results recorded ([release records](../development/testing.md#release-records)). CI is not evidence of anything until a run on that commit passes |
| Open games and matchmaking | The last place goes to one person; a game moves only with its players' answers; suggestions bounded | Every change that takes or frees a place locks the game's row first (B16, `tests/matchmaking.test.ts` on Postgres). Moving a game with players holds the new time as a claim until each has answered; two moves at once, and a join racing a proposal, leave one outcome (`tests/game-moves.test.ts` on Postgres). A ranking reads at most 300 candidate games, and a host's suggestions at most 500 opted-in players; neither is measured at marketplace size. Levels and ages are self-declared and never verified; a link to a private game is a bearer link until withdrawn or expired. Emails of invitations, held places and suggested games go through the outbox, so their delivery is the email integration's |
| Staging | On this machine, proven by hand; remote never run | `npm run stage -- run` builds the image, runs it on Postgres 16 with synthetic data, passes smoke, browser and acceptance suites and removes everything ([testing](../development/testing.md#staging-and-real-services)). It needs a Docker daemon. The DigitalOcean variant is tested against a stand-in API only, and no provider credential has been available to run the real-service checks |
| Operational dependencies | Documented | The scheduler runs inside a long-running `next start` (or the operator's cron with `MYSENAM_SCHEDULER=off`); more than one instance needs `MYSENAM_RATE_LIMITS=shared`, one `MYSENAM_SECRET`, a photo bucket, and accepts a minute's lag on catalogue changes ([architecture](../architecture/overview.md#more-than-one-instance)) |

## Integrations awaiting live verification or a partner

Implemented and tested against fakes only. Each needs one real check before it
is relied on ([launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)).

| Integration | State | Launch impact |
| ----------- | ----- | ------------- |
| Billplz (FPX, cards, callbacks, X-Signature) | Needs sandbox verification | Where a Malaysian venue takes payment online |
| Stripe Checkout, webhooks, refunds, disputes, renewals | Needs test-mode verification | A Singapore install; renewals; the platform's invoices through Stripe |
| WhatsApp Cloud API (templates must be approved by Meta) | Needs approval and a live send | Only where switched on: email works without it |
| Email (SMTP), including SPF/DKIM and calendar invites | Needs a live send | Any launch: confirmations go by email |
| Malware scanner (ClamAV, always-on or started on demand) | Verified in the development container with the official signatures, always-on and started on demand (start to answer 10.3–10.6 s, peak 972 MiB); not verified on a real Droplet: the kit's set-up in either mode, free memory with the app and Postgres running, clamd's load time on a shared vCPU, and the freshclam timer over days. On demand, the first document after an idle spell waits up to about a minute plus clamd's load before release | Any install taking supporting documents: without a scanner, documents wait in quarantine, unopened |
| SMS (Twilio or HTTP gateway) for phone codes | Needs a live send | Only where phone checks use SMS |
| LHDN MyInvois | Needs sandbox (preprod) verification | Only for venues (or a platform) that must e-invoice |
| Google sign-in | Needs a registered redirect URI | Only where switched on: password sign-in works |
| S3-compatible off-site backups and photo storage | Needs a real bucket. Tested against stand-ins for S3 and B2 only: B2's acceptance of a `writeFiles`-only key for uploads, its signing region, Object Lock default retention and versions listing are unverified until `npm run verify-offsite -- --go` passes against a real B2 (preferred) or S3 bucket | Off-site backups: any launch. A photos bucket: before more than one instance |
| DigitalOcean (remote staging only) | Needs a token for a separate team, scoped to droplets, tags and registry read, and an agreed spend; tested against a stand-in API | None: local staging works without it |
| Reserve with Google | Feeds only; needs Actions Center partner approval and a booking server that is **not built** | None |
| Smart locks (TTLock, Igloohome) | Not built; blocked on vendor credentials | None |
| Stripe Connect payouts, Singapore InvoiceNow, web push, LINE, Zalo | Not built; each needs a partner or contract | None |

## Deliberately unsupported

- **Demand-based ("surge") pricing.** Raising prices when busy teaches regulars
  to wait and reads as a trick where a court is a known price. Venues have
  fixed peak and off-peak bands, holidays, an opt-in last-minute discount and
  a free hour for regulars instead.
- **Referral credit** ("give RM10, get RM10"): with bookings by phone number
  and no proof two numbers are two people, it pays people to refer themselves.
- **Off-site copies need a declared location.** Nothing is copied until
  `OFFSITE_DATA_LOCATION` is set, while it disagrees with the country a B2 or
  S3 endpoint names, and nothing abroad until the transfer is approved and
  encrypted ([backups](../operations/backups.md#where-the-data-may-go)). For
  other providers the declaration is not checked. With Backblaze B2 (no Asian
  region) every copy is a transfer abroad, and the legal points in
  [privacy](../architecture/privacy.md#backups-held-abroad) are open.
- **A signed backup set proves the server made it, not that the server was
  sound.** After a server compromise, sets made since may carry altered
  data under a valid signature; a recovery point from before it is chosen by
  upload time ([backups](../operations/backups.md#threat-model-what-each-protection-proves)).
- **One country per install.** Malaysia and Singapore are separate installs
  ([regions](../product/regions-and-tax.md)).
- **Storefront domains are not data separation.** A business needing its own
  customers and database gets its own install
  ([ADR 0005](../architecture/decisions/0005-shared-marketplace-and-own-installs.md)).
- **No turnstile or per-person door credentials**: unstaffed access is one
  code per lock, and software can attribute an entry but not prevent
  tailgating ([venue operations](../features/venue-operations.md)).

## Gaps in verification and documentation

| Gap | Consequence | Priority |
| --- | ----------- | -------- |
| Browser tests drive the main journeys: twelve end-to-end checks ([testing](../development/testing.md#end-to-end-tests)) and seventy-one acceptance scenarios ([testing](../development/testing.md#visual-acceptance-scenarios)), among them a venue's set-up from sign-up to its first booking, changing a booking's time, and a tournament's whole run from set-up to corrections; emailed confirmation, waiting-list offer and password-reset links are followed from the acceptance server's log (skipped against a deployment) | Those are checked by route and unit tests, not a browser | P2 |
| The suites run on the day they are run: tests build their dates from today, and a test that depends on the weekday (a weekend is peak all day) or the hour is found only when the date reaches it; four were found and fixed this way in round 8 | A run can fail on the calendar rather than the product; the failure names its test, and the fix is to the test | P3 |
| The acceptance scenario *Accounts AG* cannot set itself up between 23:00 and 24:00 Malaysia time: it books the next whole hour and invoices up to today, and in that hour the booking falls tomorrow | A full acceptance run in that hour fails that scenario on the clock, not the product; run outside it or re-run the file | P3 |
| `/terms` and `/privacy` are drafts that describe the software; not reviewed by a lawyer, nor are their translations; the terms are English only. The privacy notice names a contact only once `OPERATOR_NAME` and `OPERATOR_EMAIL` are set | Legal exposure | P1: [blocks any launch](#blockers-for-any-launch) |
| The [incident-response procedure](../operations/incident-response.md)'s breach-notification rules for Malaysia and Singapore are summarised from the regulators' guidance, partly through law-firm summaries (Malaysia's regulator's site was unreachable when it was written), and who must notify for which data is not settled | An operator could notify late or the wrong party | P1: [blocks any launch](#blockers-for-any-launch) until a lawyer confirms it |
