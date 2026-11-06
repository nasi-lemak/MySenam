# Known limitations and gaps

Authoritative list of what is known to be wrong, missing or unverified, kept
apart from what works ([feature status](../product/feature-status.md)) and
from ideas ([roadmap](roadmap.md)). First recorded by the
[documentation audit](../audits/documentation-2026-10-22.md) of October 2026. The numbered
defects it found (S1–S8, B1–B8, M1–M11) have since been fixed, each with a
test. So have those found since (S9–S11, B9, B10, B12–B16, M12–M15), all but
B11; every fixed one is under [fixed since the audit](#fixed-since-the-audit).
Reconciled against the code and tests on 24 October 2026. The
[business-process audit](../audits/findings-register-2026-11-06.md) of 6 November
2026 found 140 more; the 77 fixed are under [fixed since the audit](#fixed-since-the-audit)
(cited *audit A1* and so on, never as S, B or M numbers) and the rest, with what the fixes
left, are under [its open items](#business-process-audit-6-november-2026-open-items).

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
| Email has never been sent through a real provider ([integrations](#integrations-awaiting-live-verification-or-a-partner)) | Booking confirmations, password resets and every game, tournament and league message go by email | Verify the sending domain in SES (DKIM, SPF, DMARC), request production access, set `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_REGION` and `MAIL_FROM` (or `SMTP_URL` where ports 25, 465 and 587 are open), and pass the email check |
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
| Stripe: a Singapore install, membership renewals, or the platform's own invoices through Stripe | The Stripe test-mode check: checkout, webhook, refunds, a dispute, a renewal. Refund reconciliation is tested against a stand-in only ([money](#money-m)) | Pass the check before switching any of them on. A venue's suspension also pauses its members' subscriptions at Stripe (`pause_collection`, [audit A4](#business-process-audit-6-november-2026-open-items)); that call is tested against a stand-in only and needs the key's *Subscriptions: write* |
| Charging venues a fee: `MYSENAM_VENUE_FEE`, plan tiers, or a venue's own fee | The price decided. Once a fee or tiers are set, `/pricing` says "no setup fee, no contract": commercial terms nobody has decided ([pricing](../business/pricing.md#open-decisions)). The platform's invoices need a verified gateway | The owner decides the price and those two claims before setting any fee |
| Phone checks by WhatsApp or SMS: `WHATSAPP_TOKEN`, `SMS_TWILIO_ACCOUNT_SID` or `SMS_HTTP_URL` | A live send; every WhatsApp template approved by Meta word for word; in Malaysia, a registered SMS sender | Pass the phone check. Without phone checks, numbers are taken as given (a decision below). The `mysenam_waitlist_offer` template gained a parameter (the offer's minutes) and must be resubmitted to Meta ([audit B13](#business-process-audit-6-november-2026-open-items)) |
| Money kept from a hire deposit: a venue deducts from one | The venue's tax adviser's review recorded under *Tax*; until then every amount kept is marked provisional ([money](#money-m)) | Each venue's manager records it before the first real deduction; the owner tells pilot venues so |
| E-invoicing: `MYINVOIS_CLIENT_ID` | The MyInvois sandbox check with the venue's own TIN and certificate | Only for venues that must e-invoice, and for the platform if it must. Not for a venue that sells stored credit or vouchers until its adviser has answered what a consolidated e-invoice does with them ([audit C2](#business-process-audit-6-november-2026-open-items)) |
| Google sign-in: `GOOGLE_CLIENT_ID` | The redirect URI registered | Register it before switching on |
| Youth messaging: `YOUTH_MESSAGING_LAUNCH_APPROVED=yes` (off in production without it) | The written advice, the venue-agreement terms, a safeguarding policy and trained safeguarding contacts of the [launch gate](../operations/legal-review-youth-messaging.md#launch-gate); the questions are under [pending legal verification](#youth-messaging-pending-legal-verification) | Take [the checklist](../operations/legal-review-youth-messaging.md) to a Malaysian lawyer and a child-safeguarding professional; set the variable only afterwards, deliberately |
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
The owner's decisions of 29 October 2026, closing round 9: what the venue
cancels (a closed day, a rain-out, a court out of service, a class or
tournament called off, a staff cancellation) is refunded through the gateway
wherever it has a refund API and otherwise owed for staff to settle by hand,
once, with its credit note and reconciliation
([payments](../features/payments-and-credit.md#paying-online)); a counter
payment on what the venue cancels is owed back until a named person confirms
handing it back, a payment taken on an earlier day needing a manager, and a cash
refund never reported complete before the money is returned
([owed back](../features/payments-and-credit.md#owed-back-after-the-venue-cancels));
test bookings cleared or kept by a manager at go-live, with no real payment,
receipt, liability or tax-relevant transaction ever hidden from the financial
records by the mark
([marketplace](../product/marketplace.md#test-bookings-before-going-live));
fixture moves, late result corrections and disqualifications a manager's, the
desk keeping registration, attendance, payments, officials and results
([tenancy](../architecture/tenancy.md)); class change notices by email only,
WhatsApp optional once a provider and template exist; an e-invoice submission
interrupted with its outcome unknown shown as needing verification, never
resent blindly, reconciled against LHDN first with its history kept
([MyInvois](../integrations/myinvois.md)); and giving a court back late
without a refund off by default.

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
changes; 6 to 8 name what they wait for. As of 5 November 2026 no defect
(kind 1) was open (B76, found and fixed on 5 November, is under *fixed since the audit*).
The business-process audit of 6 November 2026 then found defects, most fixed; those still open
(kind 1), with its other open items and decisions, are in [their own section](#business-process-audit-6-november-2026-open-items)
and are not counted below.

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
| [Ways some activities are sold](#activities): cycling heats, choosing a kind within one fleet | 5 | Venues selling them | [Roadmap](roadmap.md) rows; built when such a venue signs |
| [Rosters and supervision](#rosters-and-supervision): court time that is not a booking is not asked; no end date on a pattern; no messages; a legally required qualification is the venue's declaration, never verified | 2 / 5 | Venues with supervised activities | Kept; the owner decides the open question in the section |
| [Launch and tide windows](#launch-and-tide-windows): a venue's own table, never a forecast; a manager may override an advisory window with a reason, never a hard one; no owner emergency override | 5 | Venues hiring on water | Kept; the owner decides whether the worklist should message customers |
| [Messages between players](#messages-between-players): a minor writes only in a supervised youth group of a community group, and in production only once the owner approves the launch; guardian consent is a declared word, never verified; the notice email unverified; no browser scenario | 5 / 6 | Players, guardians | Kept; the [email integration](#integrations-awaiting-live-verification-or-a-partner) is checked live |
| [Youth messaging: pending legal verification](#youth-messaging-pending-legal-verification): eight questions, each with an interim measure in force, none a defect; youth messaging stays off in production until the launch gate | 7 | Children, guardians, venues, reported adults | The owner takes [the checklist](../operations/legal-review-youth-messaging.md) to a Malaysian lawyer and a child-safeguarding professional |
| [Moving classes, lessons and registers](#moving-classes-lessons-and-registers): a manager's move, and the desk's with a manager's approval for a consequential one (the desk cannot withdraw its request); no coach pay for classes; absent does not use a pass entry | 2 / 5 | Venues running classes and lessons | Kept; [roadmap](roadmap.md) proposals for coach pay and for absent as a pass entry |
| [Live accounting push to Xero](#live-accounting-push): never run against Xero; data goes abroad | 6 / 7 | Venues using Xero | The owner's Xero demo-company check ([Xero](../integrations/xero.md#verifying-against-a-demo-company)); approval of the transfer |
| [Ladders: court time and teams](#ladders-court-time-and-teams): held time shows as unavailable; an agreement or a counter-proposal the other player accepts confirms a hold, an expired or unanswered one is no one's fault and frees the active allowance, only a manager's hold needs confirming (on the ladder screen only); a player's own repeated cancellations pause new holds for 24 hours; no simultaneous courts; lineups do not rate individuals | 5 / 2 | Clubs running ladders | Kept; [roadmap](roadmap.md) proposals |
| [Swiss: acceleration, tie-breaks and performance events](#swiss-acceleration-tie-breaks-and-performance-events): Baku acceleration for chess only, FIDE's text unconfirmed; other accelerated systems and Swiss for events of marks not built | 5 / 8 | Organisers | The owner decides on events of marks and on a flagged round once climbing has begun |
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
| [Business-process audit, 6 November 2026: open items](#business-process-audit-6-november-2026-open-items): 33 findings open, 10 partly fixed, 20 waiting for a decision, and what the fixes left | 1 / 2 / 5 / 6 / 7 | Venues, customers, the platform | The remediation order is in the [audit's roadmap](../audits/remediation-roadmap-2026-11-06.md); decisions are the owner's, in the [business decisions](../audits/business-decisions-2026-11-06.md) |

Counted mechanically (each bullet, *Also* paragraph and table row in this
page's lists of open items and its launch tables; one limitation can sit in
two of them): **90 entries at commit `b9666dc`**, when this round of work
began on 24 October 2026, **86 at commit `d7098e7`** after round 6, and
**89 at commit `f4812fa`** after round 7, **101 at commit `9123d3f`** after
round 8, and **102 now**: round 9 closed the operations audit's operator
self-service (X1-5, X1-10, X1-13 to X1-16, X2-15) and the staff alerts left in
English, each closure narrower than the gap it replaced and recorded beside
what it leaves (hours and court rates only from a later date, branches copied
without a court of the other branch's own, test bookings cleared when asked,
counter money owed until handed back), with one new decision for the owner.
Round 8 closed the
two e-invoice decisions, the staff languages and the guest count the owner
decided, and 45 of the round 8 audit's 50 findings (the other five are
[planned](roadmap.md)), and recorded what its new workflows leave
(counter payouts, change alerts, booking links, the cash-up, leaving a waiting
list), each narrower than the gap it replaced, with two new decisions for the
owner, and two gaps in how the suites are run (the date they run on). Closures are recorded with their tests
under [fixed since the audit](#fixed-since-the-audit) (B11, B17–B75, M16–M31 and
S12–S34, found and fixed in the same work) and
[resolved without a number](#resolved-limitations-without-a-number) (132
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
Round 10 (5 November 2026) added six sections of accepted restrictions (rosters, launch and tide windows, messages between players, moving classes, lessons and registers, live accounting push, and ladders) and rewrote the Swiss one and one integration row, each beside what the work leaves and none a defect; the count above is as of round 9 and has not been redone. Round 11 (5 November 2026) rewrote the sections for rosters, launch and tide windows, messages between players, moving classes, ladders and Swiss for what the owner decided, and recorded one defect found on the way (B76). Round 12 (5 November 2026) rewrote the sections for messages between players (guardians in conflict, a reported adult not told) and ladders (an agreement counts, expired holds free the allowance) for what the owner decided, and left the owner's questions about conflicting guardians, a reported adult, both players confirming and expired holds out of the open ones. The 6 November 2026 business-process audit's items are in their own section and were not added to this count. In the table above, one row is a defect (B76); two are partly of kind 3 (staff
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
a buyer's details (the customer asks again); a submission whose
outcome at LHDN is unknown (the server stopping after LHDN was asked, a
timeout, a cut connection, an unreadable or 5xx answer) is shown as needing
verification, never sent again by itself or without the manager's confirmation
that LHDN does not have it, and is reconciled by recording LHDN's identifiers;
which failures leave a document possibly held at LHDN, and the two lookups
used to reconcile it, are assumed from the published API and unchecked
against the sandbox, and a draft marked before migration 0260 has no recorded
claim time or payload (recording it stores LHDN's identifiers only); the LHDN rules followed
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

Also: a counter payment on a booking the venue cancels with others (a closed
day, an outage, a rain-out, its API key, a class called off) stays uncredited
in the sales journal until staff hand it back or give it as credit, listed as
owed on the day list meanwhile, and an older one needs a manager; a series
moved to another weekday moves within each week's own Monday-to-Sunday week
([payments and credit](../features/payments-and-credit.md),
[booking](../features/booking.md)); a corrected
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
asked (its WhatsApp template carries the offer's minutes and nothing else; the offer page says it); whoever holds a
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

Also: a branch started from another's set-up leaves out a court whose main activity
is the other branch's own (named when it is made), and its extras keep the
other branch's stock counts until changed; test bookings are cleared only
when a manager asks, and whether a receipt printed in a test needs anything
at LHDN is for the venue's adviser, and the
manager's answer when clearing a test with a counter payment (real money taken
or not) is their own word, not checked against the till
([marketplace](../product/marketplace.md#test-bookings-before-going-live),
[tenancy](../architecture/tenancy.md#starting-a-branch-from-another)) (P3). Of hours and prices only opening hours and court rates can be set from a
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
  already elsewhere in the main draw's third-place match; in a double
  elimination or a consolation draw both routes of one correction are replayed
  together instead (P3, [ADR 0032](../architecture/decisions/0032-consolation-draws-and-double-elimination.md)).
- Sport templates are common club practice, not federation regulations:
  an event run under a governing body's rules needs its rules checked and
  set before the draw. Counts of tops and zones (bouldering) are built
  ([counted performances](../features/tournaments.md#counted-performances)),
  without a semi-final round (P3).
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
  cycling heats, and choosing a kind within one fleet of boats or boards.
  (Launch and tide windows for water hire and a range officer for each archery
  session are built: [launch and tide windows](#launch-and-tide-windows),
  [rosters and supervision](#rosters-and-supervision).) Each is in the
  [support matrix](../features/activities.md#support-matrix) and the
  [roadmap](roadmap.md); operators see the note as they pick one (P2).
- **Lanes sold by the game and given on arrival** (accepted restrictions):
  a lane is reassigned only to one free for the booking's whole time, so a
  late arrival cannot take a lane free only for what is left; *Add a game*
  works only on a booking nothing is paid towards yet, priced without its
  discounts, and a booking by time cannot be extended; a waiting list for a
  time, an approval application's slot and a manager's booking outside the
  rules are not offered on such lanes; passes that count time count the
  minutes a game booking holds (untested). Bowling venues sell by the game
  from this release: one that wants to keep selling by time sets the game
  minutes to 0
  ([booking](../features/booking.md#by-the-game-and-a-lane-given-on-arrival)).
- **Entry with no set time** (accepted restrictions): self check-in admits
  only the account holder (children at the desk); its page carries no
  secret, so a signed-in customer could check in from elsewhere on their own
  membership or pass; the desk finds people by phone number, not a scanned
  code; a booking made for now is not refused for people already in on
  entry, so the floor can briefly pass its places; the occupancy grid counts
  entries as people and the report's utilisation leaves them out; a plan's
  single activity is set through the route, not the screen; the self
  check-in page shows times in the install's zone; a day pass is valid from
  its first use, not a chosen date
  ([entry](../features/venue-operations.md#entry-with-no-set-time)).
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

### The venue guide

The public guide, the setup journey, the playbook and the contextual help
([venue guide](../features/venue-guide.md)) describe only what the code and
[feature status](../product/feature-status.md) support. Their limits:

- **Not reviewed by a native speaker:** the Malay and Chinese wording of the
  staff-facing guide, playbook and help (machine-assisted), and the Malay,
  Chinese and Tamil wording of the public guide (`fit.*`, `gcap.*`, `gbt.*`).
  Part of the same [language blocker](#blockers-for-any-launch).
- **Not described, because the app has no such feature:** a staff rota, coach
  attendance registers, and procedures for waiting lists, customer notes,
  waivers, private-hire enquiries and booking alerts. The discover view lists
  what exists; it does not invent the rest.
- **Rendered per request,** never cached across requests or venues, so a
  change shows at once and a busy venue's guide costs a read of its settings.
- **"Branch copied"** is read from the staff log (the copy leaves no column
  of its own), so a log pruned by retention loses it.
- **The public guide is not in a storefront's sitemap,** and its mention of
  Stripe refunds on venue cancellation rests on the Stripe integration row,
  which is unverified against the live service.
- **Online payment in the setup journey is a link** to the payment settings,
  not a step it completes: provider keys are never entered in the guide.
- **A draft with no courts**: its launch-readiness item says there is no
  screen for it, though Courts & rates is where it is fixed, and repeats the
  *Add your courts* step listed above it. The wording is wrong, the facts are
  not.
- **Activity and business pictures** are MySenam's own line drawings, made
  to the [image standard](../development/images.md) and not yet reviewed by a
  designer; any can be replaced without code changes (`npm run glyphs:export`).
- **The illustrative examples** on the public guide use a 24-hour
  cancellation cutoff to show a policy; a venue's own default is 2 hours
  ([booking](../features/booking.md)).

### AI assistants (MCP)

The [MCP server](../integrations/mcp.md) answers through the same functions as
the pages and the venue API. Its limits:

- **Not yet tried from a real AI client** (Claude, ChatGPT, Cursor) against a
  public address; the connection examples follow each client's documentation.
- **Signing in from an assistant** (OAuth, `/api/mcp/staff`) is tested only
  against the route handlers. Only public clients with https or loopback
  redirect addresses are accepted, so clients using a custom scheme (Cursor,
  VS Code) and browser-based clients cannot sign in; connectors use the
  install's own address, not a storefront's.
- **A connection has no fixed end:** it lasts while it is refreshed at least
  every 30 days and the person keeps the venue and role. Registered clients
  that never connect are kept.
- **Through an assistant, bookings follow the venue API's limits** (no
  override, no payment) even for managers, and the platform owner acts for
  one venue at a time.
- **Previews of setting changes run the change and roll it back**, which is
  safe only because those routes write nothing outside the database; a route
  added to the tools must keep to that
  ([ADR 0030](../architecture/decisions/0030-oauth-sign-in-for-ai-assistants.md)).
- **A booking preview** cannot say whether the time is still free or allowed
  by the court's rules at that moment; only the confirmed call can.
- **Waiting lists and taking one person off a booking** are in the venue API
  but not offered as tools.
- **Every call through a key is logged,** reads included, so an assistant
  that reads availability often fills the staff log.
- **Customers' details sent to an AI provider** may be processed outside the
  country. They are off by default; a manager who turns them on records the
  venue's choice, which the app does not judge lawful
  ([privacy](../architecture/privacy.md#ai-assistants)).

### Browser scenarios and notices

Observed by the browser scenarios of 4 November 2026. Two things they showed were decided by the owner and
changed (below): team-league notices are not held to the daily cap of eight messages per person
(`MESSAGES_PER_RECIPIENT_PER_DAY`), and on a junior ladder the venue's staff and a child's own guardian see the
child's name as entered while other families see first name and initial. Two more were decided to stay as they
are: a walkover is not listed on a public ladder (it would say who declined or did not turn up; the ranks move
as for any result), and the seven days of an official's link after a climbing event run from the last save to
its rounds, so a correction a manager applies starts them again, with no finish timestamp, which keeps the official
able to see an applied correction's effect and ask for another. Smaller: the day board's error banner after a
refused action is cleared by its 15-second refresh, so it can go before it is read;
a Swiss tournament's recorded seed is shown on no screen; the acceptance server
has no scheduler and its outbox sends 25 messages a run, so what earlier scenarios
leave queued stands ahead of a later sign-up email (the full run on `89bc4b7` failed
*Booking 1* that way); the sign-up step now asks the app to work through its outbox
while it waits (`nudgeOutbox` in `tests/uat/harness.ts`), and a scenario that queues
many drains its venue's queue first (`drainOutbox` in `tests/uat/formats-support.ts`); the tournament-day scenario
moves the clock of a second server with a stand-in and proves nothing about a
deployed scheduler; the seven-day link expiry, a guardian's authorisation ending
with an event, a report that stands after three days and a forfeit request that
expires after fourteen need the clock and are tested below the browser; and
a swap during a day's first round is refused where the swapped match feeds a
next-round fixture scheduled right after it.

### Forfeits, officials and ladders

([Team league forfeits](../features/tournaments.md#team-leagues), [officials and
counted results](../features/tournaments.md#counted-performances), [ladders and
court time](../features/tournaments.md#club-ladders).) The owner's decisions of 4
November 2026. Team leagues have no officials, so only captains and staff can
request a forfeit; a forfeit request can be opened only while the fixture is
still to be played; a whole fixture entered as a walkover is treated as a forfeit
for who may enter it; an official's link works for seven days after the climbing event finishes, for
results and correction requests only (the finish day is the last save to the
event's rounds, so a manager's applied correction restarts the seven days; there
is no finish timestamp); the last line of the last group fills the final
by itself (as the dashboard save already does), while making the final from a
qualification round and a tie at the cut stay the organiser's; the messages go
through the outbox (the Email row: unverified).

### Published rankings and public names

([Ratings and rankings](../features/tournaments.md#ratings-and-rankings),
[minors' names](../architecture/privacy.md#minors-names-on-public-pages).) The
owner's decisions of 4 November 2026. Every venue that had a public rankings page
before migration 0275 has it off until its manager publishes it; the number of
counted results before a player is ranked is a venue's (3 to 30, 8 by default),
not a competition's, and earned-level matching never trusts a rating on fewer results than the install
default of 8, so a venue that lowers its number does not lower that bar and one
that raises it does; published pages are not indexed and not in the sitemap; the
provisional section is not on the business-wide board. A minor entered with no age
range and no recorded guardian is shown as the entrant typed the name (ages are
declared, never verified); authorising a child's full name needs a guardian
account that manages them, so a teenager entering alone is always shown short; a
pair with a declared minor in it is shown short whole, so it cannot be authorised;
a name with a particle ("Aina Binti Lim") shortens to "Aina B."; public ladder
challenges and results are public, with names by the rule; the authorisation's
wording and the privacy notice paragraph await the owner's lawyer.

### Consolation draws and double elimination

([Consolation draws and double elimination](../features/tournaments.md#consolation-draws-and-double-elimination),
[ADR 0032](../architecture/decisions/0032-consolation-draws-and-double-elimination.md).)
Accepted restrictions: a consolation draw is for first-round losers of a
straight knockout (a bye holder who loses in round 2 is not in it, it is not
offered after groups; the optional
[feed-in mode](../architecture/decisions/0034-feed-in-consolation-draws.md) takes every loser but the runner-up, from five entries, without the knockout's third-place match, and its places say how late somebody was put out); a
double elimination is not offered after groups; in a double elimination two
players who have met may meet again after losers' round 2 where the shape forces
it (the winners' round's loser against a survivor of a part of the losers'
bracket that holds somebody they beat, the losers' final, the grand final); a
grand-final reset needed again after its time was given back has no court until
a manager gives it one with Move.

### Swiss: acceleration, tie-breaks and performance events

([Swiss](../features/tournaments.md#swiss-tournaments),
[ADR 0038](../architecture/decisions/0038-swiss-acceleration-tie-break-screen-and-performance-swiss.md).)
Accepted restrictions: a Swiss division of a competition schedules each round
into the court time free when it is paired, so a later round can fail to fit if
another division used the time (the round is reported unpaired and the organiser
decides); the Swiss pairing search is bounded at 400,000 steps and reports
unpaired rather than looping; the constant virtual point stays for events set up
with it and is not offered for new ones; FIDE's Baku acceleration is built for chess
only ([ADR 0047](../architecture/decisions/0047-baku-acceleration-for-chess.md)): FIDE's
text was read through a fetch summariser, not verbatim, so its article numbers as cited are
unconfirmed; the pairing under it is the app's own Dutch-style engine, not a FIDE-certified
pairing program; other FIDE accelerated systems and late entries (article 1.3) are not built;
a draw in chess is entered as 1-1, chess is not in the activity catalogue, and halves show
only in Swiss tables; the tie-break
screen changes the table only, never a pairing, and a Swiss tournament's recorded
seed is shown on no screen; Swiss for counted performance events forms groups and
not pairings, has no final built from its rounds and no repeat-avoidance, is not
rated, is not offered to events of marks, has no tournament-day board, and its
refusal texts are English only; after a correction a flagged later round may stay
flagged once climbing has begun (the manager keeps it, with a reason, or regroups
only while nobody has climbed). Pairing messages go through the outbox (the Email
row: unverified). **For the owner:** whether a flagged round may stay flagged once
climbing has begun; whether events of marks need Swiss.

### Ladders: court time and teams

([Club ladders](../features/tournaments.md#club-ladders),
ADRs [0040](../architecture/decisions/0040-ladder-court-time-and-team-ladders.md),
[0048](../architecture/decisions/0048-ladder-hold-limits-and-expiry.md),
[0050](../architecture/decisions/0050-ladder-agreement-counts-and-expired-holds-do-not.md) and
[0051](../architecture/decisions/0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md).)
Accepted restrictions: court time is held for a challenge only where the venue
turns the setting on (off by default, at the owner's request of 5 November); held
time shows as unavailable on the grid, not as a ladder match; the default
limits (8 live holds a ladder, 4 live for a player) count live holds only, so a hold that
expired or was released stops counting at once, and are changed by a manager per venue and
per ladder within the install's bounds (1 to 50 and 1 to 20), and those bounds, the
confirmation window (48 hours, never later than 120 minutes before the start), the
minimum notice, the one extension, and the own-cancellation threshold, window and pause
(6 in 7 days, 24 hours) are install data with a venue setting and a ladder override inside bounds, and the bounds have no screen; a player's limit counts a person
across ladders (the same account, participant or team), never by contact details; a hold
the players' own agreement makes (an exact acceptance, or the other player's acceptance of a
counter-proposal) is confirmed when made, and a manager is the only source of a tentative
hold (a hold where the players agreed none, or a material move), which both players or a
manager confirm, on the ladder screen and API only, with no link in the email; holds made before migration 0290 have
no `held_during` (their blocks are still held by the claims constraint); a hold that
expired is not restored (the players arrange again), and is no one's fault: it counts
against nobody and is recorded in the neutral hold history; only a player's own
cancellation of a capacity-reserving hold counts towards the 24-hour pause, which stops
nothing but creating a new hold by their own act and ends by itself or by a manager's
lifting it; a hold made before migration 0292 carries no attribution (only 0292's tentative
withdrawals were carried over as cancellations); a player who leaves a ladder with a live
hold is not counted as cancelling; withdrawing a confirmed hold counts like withdrawing a
tentative one, since both reserve capacity (a choice of [ADR 0051](../architecture/decisions/0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md), not put to the owner);
a counter-proposal names no court (the court is the deterministic choice when it is
accepted, shown beforehand), a proposal has no expiry apart from the response window, and a
move request lapses by the day, not the hour; on a court-time ladder a client that sends no
proposal revision is refused (`LAD5_REV_NEEDED`, deliberate: the revision is for the API
and the screen sends it); a hold
lost to something else (a court lost to an outage included) is noticed by the scheduler, not at
once, and the system does not hold the court again (the players agree a time again);
cancelling the booking a challenge carries does not bring a released hold back, and a
held time is not held again automatically; the acceptance preview and the concurrency
tests run on PGlite and local Postgres only, with no browser scenario, and the Malay,
Chinese and Tamil wording is machine-assisted; a team match on a ladder is played on one court, game
after game (simultaneous courts are not built); lineups do not rate individuals
(individual ratings from lineups are not built); there is no junior ladder of teams;
a team's eligibility is checked when it joins and when a lineup is named; a ladder
cannot be restarted empty; forfeits on a team ladder are a manager's, confirmed
through a request and never given automatically. Pairing and challenge messages go
through the outbox (the Email row: unverified). Nothing here is open for the owner: the two
questions of [ADR 0050](../architecture/decisions/0050-ladder-agreement-counts-and-expired-holds-do-not.md) (whether a counter-proposal confirms, and whom an expired hold is
charged to) are settled by [ADR 0051](../architecture/decisions/0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md) (see the resolved table below).

### Counted performances

([Counted performances](../features/tournaments.md#counted-performances).)
Accepted restrictions: no semi-final round (the heats-then-final structure is
the stage list); no lead over two routes, speed climbing, flash or bonus scoring,
or per-boulder timing and rotation; judged from the staff dashboard only, since
official pages carry no performance events; the counts are the judge's record,
never verified; counted and marks performance events are never rated (a
ranking of a field has no two-sided result: `RT_PERFORMANCE`); counts are not in
a person's data export, and erasure anonymises the entry with its counts; only
counted events shorten a declared minor's name on the main public page; the
judge's grid has been checked in jsdom, not on a phone.

### Ratings and rankings

([Ratings and rankings](../features/tournaments.md#ratings-and-rankings),
[earned levels](../features/matchmaking.md#earned-levels).) Accepted
restrictions: ratings are per venue, sport and format, with no rating across
venues (a business-wide board lists branches side by side); a doubles partner
typed into an entry, a typed team and somebody entered at the counter without
an account are not rated, and a match with nobody rateable on a side is not
counted; team-league games count for people only when lineups were picked; an
enforced level (a rating band checked at entry) is not built; the constants are
changed in the database (raise `rating_rules.version` and every pool is
recomputed), not from a screen, and their level thresholds are rough until
there is real data; a pool is replayed in full on every change, linear in its
ledger and not measured at marketplace size; a result entered wrongly and never
corrected is rated as entered; casual open games are not rated, since nothing
records a result for them; the Malay, Chinese and Tamil text is
machine-assisted and awaits native review; run by hand on PGlite and a local
Postgres, not in CI.

### Teams and team leagues

([Teams](../features/tournaments.md#teams),
[team leagues](../features/tournaments.md#team-leagues).) Accepted restrictions,
not defects: a team league has no entry fee or payment; one season only, with
no promotion, relegation, play-offs or seeding; a fixture holds one court for
all its games in turn; ties beyond the ranking keys are settled by the order
teams entered; a minor with an account of their own cannot be on a team (a
child is on one through a guardian's account, and a guardian must be a
declared adult); a team's level is shown, not enforced; the staff Tournaments
screen does not list rosters; team retention and the three-day stand of an
unanswered report run at every scheduler tick (idempotent), not once a day;
invitations are by an address or link only, never by looking up a phone number
or account, so nobody can be found by guessing. Team invitations and notices
go through the outbox and were tested against the stand-in only (the Email row of
[integrations awaiting live verification](#integrations-awaiting-live-verification-or-a-partner)).

### Tournament day

([Tournament day](../features/tournaments.md#tournament-day).) No alert reaches
staff when a called fixture's wait ends: the board and the official's page show
it. A division's board and rest count are its own: a call that would collide
with another division's match is refused, but that match is not shown. Heats
are not called. Notices name a match in English ("Semi-final 1"). An event with
no age range cannot detect minors, so its live page shows full names unless set
to short. A declared minor is shortened on the tournament's main public page and API as on the live page
([names of minors](../features/tournaments.md#names-of-minors-on-public-pages), `src/lib/public-names.ts`; an earlier
version of this paragraph said the main page showed them in full, which the code and
the documents contradict; corrected on 6 November 2026 after the business-process audit's F13). **Open for the owner:**
an event with no age range, and an entrant with no declared age or guardian, still shows the full name of somebody who typed an age under 18 elsewhere
([audit F13](#business-process-audit-6-november-2026-open-items), DEC-54).

### Archiving past claims

Off unless `CLAIMS_ARCHIVE_AFTER_DAYS` is set
([database](../architecture/database.md#archiving-past-claims)). Accepted
restrictions: a block can be placed over court time that has been archived
without an overlap check (it affects no booking); the archive frees disk only
after `VACUUM FULL` or a dump and restore; the index build in migration 0267
locks writes to `claims` once, while it runs; the claim of a booking cancelled
as its claims are split across two batches may keep `active` set in the archive
(cosmetic: nothing reads it); measured once, on a development container, not at
production size.

### Passes sold online

Paid through stand-ins for Stripe and Billplz only, until the gateways' own
live checks pass ([pricing](../features/pricing.md#buying-a-pass-online)).

- **Passes sold online:** two payment pages opened for the same pass at the
  same instant can each be paid and each give a pass; the second is refunded
  by voiding it with money back. At a private venue they are sold only to
  people on its list; at a members-only venue a pass makes nobody a member.

### Rosters and supervision

([Who supervises a session](../features/venue-operations.md#who-supervises-a-session),
[ADR 0036](../architecture/decisions/0036-who-supervises-a-session.md).) Accepted
restrictions: court time that is not a booking (a tournament's, a block, an outage)
is not asked, so a venue that runs a tournament on a supervised range rosters for
it by its activity's rule; the weekly pattern has no end date (a change applies from
now, with what it left on the worklist); no message goes to staff or customers about
a roster; roles and rules are not copied when a branch is started from another; a
person on shift is not a capacity, so one person may be on several sessions at once
(a venue wanting one officer per lane asks for as many officers as lanes); a venue's
own role name is English in a customer's refusal (the starters are translated); a
class's instructor who is one of the venue's coaches cannot be named to supervise
another session at the same time (as a lesson's coach cannot), but a coach already
teaching a class is not offered as cover for a session then. Qualification levels ([ADR 0046](../architecture/decisions/0046-strength-of-a-requirement-advisory-windows-and-qualification-levels.md)):
an unqualified person counts for nothing only where the venue requires the qualification or the law does, and a
recommended one counts and is flagged; the level belongs to a role, not to a rule; a *legally required* qualification
is the venue's declaration, recorded with its reference and never verified by MySenam, and its wording awaits a
lawyer's review. **For the owner:** whether a
rule type of one officer for each lane is wanted.

### Launch and tide windows

([Launch and tide windows](../features/booking.md#launch-and-tide-windows-for-water-hire),
[ADR 0037](../architecture/decisions/0037-launch-and-tide-windows.md).) Accepted
restrictions: the window is the hours the venue's own data leave; it is not a
forecast and not a safety system (whether it is safe to go out is the venue's call
on the day, and the screens say so); a tide table is the venue's own, typed or
imported, with station names matched exactly, read at the whole minute with no
allowance for a station's distance from the water; where the table says nothing the
time is closed; a tournament's or league's court time is not held to a window (a
lesson is, as a booking); a venue started from another does not copy its windows;
the Tamil text is unreviewed. A window is advisory unless the venue marks it hard: a
manager of the venue (never the desk, a customer, the venue's API key, another venue's
manager or the platform owner) may book, move or schedule outside an advisory window
with a recorded reason, and nothing overrides a hard one ([ADR
0046](../architecture/decisions/0046-strength-of-a-requirement-advisory-windows-and-qualification-levels.md));
an owner's emergency override is not built (out of scope); the safety flag on a
closure, outage, block or rain-out only names it and changes nothing; the weekly
count of overrides is an alert panel line, not a message; the Malay, Chinese and
Tamil text of the override screens is unreviewed. Moving a booking to
another resource at the same time (`moveBooking`) asks the target's window and refuses
a booking outside it; there is no override on that path (B76, fixed).
**For the owner:** whether the worklist should message customers itself (today staff
decide).

### Messages between players

([Messages between players](../features/player-messages.md),
ADRs [0039](../architecture/decisions/0039-messages-between-players.md),
[0044](../architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md),
[0049](../architecture/decisions/0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md) and
[0052](../architecture/decisions/0052-youth-messaging-interim-safeguards-pending-legal-review.md).)
Accepted restrictions: youth messaging is off in production until the owner sets
`YOUTH_MESSAGING_LAUNCH_APPROVED=yes` after the launch gate (adults' messaging is
unaffected), and every legal question about it is under [pending legal verification](#youth-messaging-pending-legal-verification),
not repeated here; a player who says they are under 18, or says nothing, has no
messaging outside a supervised youth group; inside one a minor writes only with their
own opt-in, a linked guardian's consent and a supervisor in the thread. Only a
community group can be a youth group; only its organiser admits or removes adults;
staff cannot mute a single member; a guardian's consent is a declared word, never
verified; where guardians disagree, what each guardian may do about the child's messaging
(`decides`, `objects_only` or `none`) is a recorded decision whose restriction takes effect only
when an authorised operator has verified it (an asserted one makes the link unclear; the app
collects no identity or court document and interprets no custody order); an objection made by a guardian is ended only by every
guardian who decides agreeing again or by a safeguarding administrator, and an
`objects_only` guardian's objection by the deciders alone; settling an objection does not
switch messaging on (a guardian who decides still consents); a child with no guardian who
decides has no messaging until a manager records one; an account that says 18 or over but is
a managed child's linked login is treated as an adult for ordinary messaging; the
staff-read exception, the retention periods (60 days after a youth group ended, 30 for
a removed message's words) and the rest hours (22:00 to 07:00) are operational defaults.
A restricted adult can ask for a review again after each decision (one open at a time, rate-limited); an authority decision for a child in no youth group is recorded in the staff activity log only.
The phone and email check is a speed bump, not a guarantee; the notice email goes
through the outbox (the Email row: unverified) and is a trailing digest (a count only,
once per period per conversation, `MESSAGE_DIGEST_HOURS`, 6 hours by default); a guardian's label keeps the child's short name until
retention ends; a team entry's or fixture's seat is the captain's only; reports are
unseen where a venue has no manager; three accounts can between them trigger an
automatic suspension; a suspension is deleted with the account; who has messaging on
can be inferred in a two-person context; there is no browser scenario; the Malay,
Chinese and Tamil wording is machine-assisted, and the youth wording is a machine-assisted
check as well as translation. A reported adult is told nothing and is restricted at once
(a protective restriction behind a neutral line, not a finding; a recorded decision has its own line);
the report's evidence is kept, not deleted by the ordinary job, and held as the privacy document
says (the [evidence classes](../architecture/privacy.md#youth-messaging-evidence)), and erasure
is never refused; the safeguarding notices are not
listed in any outbox screen; a reported adult's other powers as a member of the community
group outside the youth module are not restricted (a group's organiser could still disband
it, say); the reporter's own `reportMessage` answer still says *suspended*. Email delivery of the
notices, including the safeguarding emails to the owners, is the unverified Email row. Nothing
here is open for the owner beyond the legal review in the next section.

### Youth messaging: pending legal verification

([The checklist for a lawyer](../operations/legal-review-youth-messaging.md), [ADR 0052](../architecture/decisions/0052-youth-messaging-interim-safeguards-pending-legal-review.md), amending ADRs
[0049](../architecture/decisions/0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md) and
[0044](../architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md).)
These are **not defects**. Each is a question of Malaysian law or of child safeguarding that the
software does not answer and that nothing in code settles; each has an **interim, conservative
measure** in force so the question can be asked about something concrete. Their status is
**pending legal verification**, and they are the one place this register records them: the
feature documents link here rather than say it again. **Youth messaging stays off in production**
(`YOUTH_MESSAGING_LAUNCH_APPROVED` unset) **until the [launch gate](../operations/legal-review-youth-messaging.md#launch-gate)**: the written
advice on all eight, the venue-agreement terms, a safeguarding policy and trained safeguarding
contacts at each venue with a group; the owner then sets the variable deliberately. Every period is
operational, every notice wording is provisional, the other languages are machine-assisted, ages
and guardians' agreement are declared words, and no identity or custody document is collected.

| # | Question for the lawyer | Interim measure in force |
| - | ----------------------- | ------------------------ |
| [1](../operations/legal-review-youth-messaging.md#1-guardian-authority-and-conflicting-instructions) | Which guardian's instruction governs when guardians disagree | Any guardian who may object switches a child off; back on only by every guardian who decides, or a safeguarding administrator's settlement and a guardian's own consent; unclear authority keeps it off |
| [2](../operations/legal-review-youth-messaging.md#2-custody-document-verification-who-may-verify-and-to-what-standard) | Who may verify custody or authority, and to what standard | A recorded decision (asserted, verified, disputed, unclear); a restriction counts only when verified by the venue's manager or the owner; standard stored as "interim: pending legal review"; no document collected |
| [3](../operations/legal-review-youth-messaging.md#3-interim-restrictions-on-adults-and-notification-obligations) | What may be done to a reported adult before a finding, and what they are owed | A protective restriction at once, not a finding, no notice of the report, a 7-day review date that escalates to the owners and never lifts or converts by itself |
| [4](../operations/legal-review-youth-messaging.md#4-reporter-confidentiality-and-review-and-appeal-rights) | How far the reporter and report are kept confidential, and what review is owed | Reporter and words reach safeguarding personnel only; a restricted adult can ask for a review from the neutral line, decided by someone who did not apply it; no right promised |
| [5](../operations/legal-review-youth-messaging.md#5-mandatory-reporting-and-safeguarding-escalation) | Whether, to whom and by when an incident must be reported | A moderator's Escalate (safeguarding) tells the owners; static guidance names 999 for immediate danger; nothing is sent to any authority |
| [6](../operations/legal-review-youth-messaging.md#6-evidence-retention-deletion-preservation-and-legal-holds) | How long evidence may or must be kept, and what must be preserved | No invented period: evidence and audit are kept unless the install sets one after advice; active cases are never deleted; owner-only legal holds; a yearly prompt to decide; erasure never refused |
| [7](../operations/legal-review-youth-messaging.md#7-responsibility-between-mysenam-and-venue-operators) | Who is controller or processor, sets policy, verifies and reports | No allocation assumed; venue managers (or the owner) act as safeguarding administrators and the app records who did what |
| [8](../operations/legal-review-youth-messaging.md#8-jurisdictional-differences-malaysia-now-singapore-later) | Differences between Malaysia and, later, Singapore | Nothing invented; nothing in code branches on the country for these rules |

### Moving classes, lessons and registers

([Moving a class](../features/programmes.md#moving-a-class),
[a lesson moved by the venue](../features/programmes.md#a-lesson-moved-by-the-venue),
[attendance registers](../features/programmes.md#attendance-registers),
ADRs [0042](../architecture/decisions/0042-attendance-registers-and-lessons-moved-by-the-venue.md)
and [0043](../architecture/decisions/0043-moving-a-class-and-a-class-coach.md).)
Accepted restrictions: moving a class is a manager's, and the front desk's at its own
venue unless the venue turns that off, a consequential move (one that prices differently,
moves a paid term, is far, long or soon, touches a waiting list or is a second move) waiting
for a manager's approval ([ADR 0045](../architecture/decisions/0045-front-desk-class-moves-with-approval.md));
the desk cannot withdraw its own request (a manager declines it, or it closes); a move onto
a closed day or out of hours is refused for everyone, as the owner decided (5 November 2026): an exceptional opening is a
reopened day or hours from a date in the venue's scheduling, then a normal move; a one-day-only special-hours exception does not
exist (two changes from a date make one), an optional capability gap ([roadmap](roadmap.md)); a
move is refused whole where a members-only venue's
membership does not cover a new date; the refund window after a move is install data
with no screen for a class (a lesson's is a number in *Lessons and registers*); a
waiting-list person's leave link cannot be resent; a class mover counts a verified check-in (a desk's, or a self check-in staff confirmed; an unconfirmed tap does not count, ADR 0058), not a register mark alone, as attendance
taken, while a lesson with a mark of present or late is not moved; what a coach is paid
for a class is not built (a lesson's hours are the class's hours); a coach's later
change to a class is made only from the worklist; a class is marked by the desk or a
manager unless its instructor is one of the venue's coaches; an open game hosted by
staff has no register; an absent mark does not use up a pass entry; guests are grouped
by name and number in reports; the 730 days a register is kept are provisional. Refunds
online are the payments integrations (against stand-ins) and notices the Email row.
**For the owner:** whether absent should use a pass
entry (as a setting), whether staff-hosted open games need a register.

### Live accounting push

([Xero](../integrations/xero.md),
[ADR 0041](../architecture/decisions/0041-live-accounting-push-to-xero.md).) Sales
reach Xero only after the install approves it (`ACCOUNTING_PUSH_APPROVED`), the Xero
developer app is registered and a venue connects and maps its accounts; the adapter has
only ever run against a stand-in, so nothing here is verified until
`scripts/verify-xero.mjs` passes against a Xero demo company. Accepted restrictions:
a booking whose amount changed after it was sent is not sent again (the reconciliation
shows it); contacts follow Xero's name rules and counter customers are one *Walk-in
customers* contact; a credit note for a sale before the start day is left out; a refund
is a payment against its credit note, and a payment from stored credit needs a
liability account that allows payments (unverified); SQL Account and AutoCount remain
exports and QuickBooks has an interface only; the default scopes are unconfirmed
(`XERO_SCOPES` overrides them). Sales data goes abroad to Xero, so it needs the owner's
and a lawyer's approval.

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

### Business-process audit, 6 November 2026: open items

What the [business-process audit](../audits/findings-register-2026-11-06.md) found and
the fix round left. Fixed items are under [fixed since the audit](#fixed-since-the-audit);
this lists every finding still open, partly fixed or waiting for a decision, and the
narrower gaps the fix workers noticed while fixing. The audit's numbers (*audit A1* to
*audit H13*) are not the S, B and M numbers of this page; a finding's evidence and
reasoning are in the [findings register](../audits/findings-register-2026-11-06.md)
([E to H](../audits/findings-register-2026-11-06-e-to-h.md)); a question for the owner is
a `DEC-nn` in the [business decisions](../audits/business-decisions-2026-11-06.md); and
what to do first is in the [remediation roadmap](../audits/remediation-roadmap-2026-11-06.md).
Nothing here is a decision. These items are not in the counts above, which were last
made in round 9. Priorities are the auditors'.

#### Open findings and decisions

| Audit finding | What is open | Priority | Kind and next step |
| ------------- | ------------ | -------- | ------------------ |
| audit C2 | A consolidated e-invoice reports a stored-credit sale and the booking it pays: RM130 for RM30 of sales. Whether prepayment is e-invoiced when received is a tax question, unverified | P1 | 7: the venue's or platform's adviser (DEC-19); do not switch e-invoicing on for a venue that sells credit or vouchers meanwhile |
| audit A5 = H8 (exit) | No way for a venue to close for good: nothing settles customers' credit, passes, memberships, tournament fees or owed refunds, and billing does not stop; a customer holding credit at a suspended venue cannot erase their account | P2 | 5 and 2: the owner (DEC-03); a large workflow with a migration |
| audit A4 (rest) | Pass and membership validity is not paused or extended for the time a venue was off; no customer-visible "renewal paused" marker; no "the venue is back" email; the Stripe subscription pause is unverified against real Stripe | P2 | 5 and 6: DEC-02; the Stripe check |
| audit A10 | Staff two-factor is off unless `MYSENAM_STAFF_2FA` is set, including for the owner | P2 | 5: DEC-05; set it by configuration for a pilot |
| audit B9 = E10 | A class place enrolled directly is not held for payment at a venue that holds courts; the same place claimed from a waiting list is | P2 | 5: DEC-11 |
| audit B11 | A rescheduled booking loses the last-minute discount a fresh booking at that time would get | P2 | 1 or 5: no `DEC-nn` written; the status file calls it a decision |
| audit B12 | Cancellation terms (cutoff, late share) are read live at cancellation; a policy edit changes what existing bookings lose | P2 | 5: DEC-09; a migration to snapshot |
| audit B6 (rest) | Class waiting lists still offer one place at a time though several are free | P2 | 2: small; or owner |
| audit B16 = C12 = D15 | A paid booking moved to a cheaper time keeps the price paid and the customer is not told first | P2 | 5: DEC-16 |
| audit C14 = D14 = H6 | A late cancellation of a pass-paid booking returns whole entries rounded down: the venue keeps 100% where it keeps 25 to 50% from other payers, and the screen states a sum | P2 | 5: DEC-30 |
| audit C15, D21 | Gift vouchers expire after 12 months (not shown as a liability once lapsed) while redeemed credit never does; a voucher cannot be redeemed at the desk | P3 | 7: a lawyer (DEC-23) |
| audit C18 = H7 | A payment that lands after a pay-to-hold booking was let go is refunded by hand even when the slot is free | P2 | 5: DEC-14; matters most while Billplz refunds are manual |
| audit C19 | `settleBill` does not compare the amount the gateway reports with the amount billed | P3 | 6: the Billplz sandbox check |
| audit C13 | A credit note and the amount owed back can differ by 1 sen at a half sen (`roundMoney` in JavaScript against SQL `ROUND`) | P3 | 1: left on purpose by ADR 0055; its own change |
| audit C5 (rest) | A dearer reschedule of an invoiced company booking is reported, not billed (a debit line on the next invoice needs its own receipt) | P2 | 5: the owner |
| audit D3 | A discount kept as an amount can make an hour free when an unpaid booking moves | P2 | 5: DEC-33 |
| audit D6 | A membership tier's benefits are read live: editing a tier changes the term members already paid for | P2 | 5: DEC-34; a migration |
| audit D8, D9 | A pass cannot be limited to off-peak, days or courts; a pass-paid booking waives the setup fee | P2, P3 | 5: DEC-31, DEC-32 |
| audit D10 (rest) | A pass or membership cannot be corrected at the desk: holder phone, account link, entries (a manager can only extend a pass) | P2 | 2: a migration |
| audit D11, G16 (rest) | No customer notice before a pass, voucher or membership expires, when a strike is recorded or a number struck out | P2 | 2 and 5: DEC-38 |
| audit D13 | Strikes, blocks, notes, concession proofs and review slots key on the phone number, which is recycled and shared | P3 | 5: DEC-39 |
| audit D16 | A credit note is written for a pass-paid booking, with no original receipt | P3 | 1: small |
| audit D17 | "Spent" in the customer report counts unpaid, no-show and pass-paid bookings at face value | P3 | 1: small |
| audit D18 | The booking form lists passes newest first, the counter oldest first, the gym desk soonest-expiry first | P3 | 1: small |
| audit D19 | A tier can price members above the plain member rate with no warning | P3 | 1: small |
| audit D22 | Voiding a membership refunds the whole receipt or nothing: nothing is prorated | P3 | 5: DEC-36 |
| audit D23 | The documentation says a term started on the 31st ends on the last day of February; the code ends it on the 27th | P3 | 5: DEC-37 (rule 9: say which is intended) |
| audit D24 | A customer note is overwritten or erased with no history | P3 | 1: small |
| audit E11 | No coach-absence workflow: no lesson worklist, no bulk reassign, a pack works only with its own coach | P2 | 2 and 5: DEC-46 |
| audit E15 | A term discount is kept for a lone session; full sessions are left out and not named | P3 | 5: DEC-43 |
| audit E16 | Coach alerts are lost for lessons older than two days when the coach had no email; payouts count future lessons as held | P3 | 1: small |
| audit E17 | Hire enquiries reach only an email address and have no nudge | P3 | 2: small |
| audit E18 | A customer who revealed the door code or checked in can still cancel on late terms | P3 | 5: DEC-45; recorded in ADR 0058 |
| audit E19 | Instructor pay for classes is not built | P3 | 2: a [roadmap](roadmap.md) row (coach pay for classes) |
| audit A13 | API keys and webhooks outlive the manager who could read them | P3 | 1: small |
| audit A14 | Second-factor ticket attempts are counted after the check (unverified, bounded by the per-address limit) | P3 | 1: small |
| audit A15 | The draft purge can still delete the counter receipts and owed-back records of real money taken in a test booking | P3 | 1: small |
| audit B14 | Hours and policy edits check then write against a concurrent booking | P3 | 1: small |
| audit B15 | The venue API's availability and booking calls do not release lapsed holds as the grid does | P3 | 1: small |
| audit F6 | A host's no-show mark is silent, irreversible and platform-wide | P2 | 5: DEC-50 |
| audit F8 (rest) | A manager cannot escalate an adult-thread report to the owner; the reporter is not told the outcome | P2 | 2 and 5: DEC-48 |
| audit F10 (rest) | A walkover a player reports still stands after 24 hours' silence | P3 | 5: DEC-52 |
| audit F11 | Leaving an open game minutes before the start returns the whole share whatever the venue's cutoff | P3 | 5: DEC-51 |
| audit F12 | A box league's fee paid online or at the counter has no refund trail on a staff removal or a league closed mid-season | P3 | 5: DEC-18 |
| audit F13 | The *Tournament day* section above says the main page names minors in full; the code, the tournaments document and privacy say a declared minor is shortened. The text is corrected; the unknown-age case (an event with no age range and an entrant with no declared age) still shows the full name | P3 | 5: DEC-54 |
| audit F14 | Competition notices are email only; none by WhatsApp for time-critical messages | P3 | 6: the WhatsApp check |
| audit H12 | A staff cancellation, a membership void and a pass void cannot be undone | P3 | 5: DEC-15 |
| audit H13 | The front desk may rain out a whole afternoon (a bulk cancel and refund, a safety closure included) but not close a day | P3 | 5: DEC-08 (documented) |
| audit G17 | Webhook events that exhausted their 8 attempts are never redelivered | P3 | 2: small |
| audit G18 | The scheduler runs a long backup and off-site upload in the same tick as the outbox and refund settling | P3 | 3: a separate lease |
| audit G19 | The loyalty grant is not idempotent: two runs at once, or a stop between issuing and recording, give the free hour twice | P3 | 1: a unique key (a migration) |
| audit G20 | The phone code allowance for a number can be burned by anyone; a guest booking is cancelled by whoever holds the typed email; the activity log is kept two years while receipts are kept seven (the WhatsApp double spend is fixed) | P3 | 5: DEC-58, DEC-59 |

#### Left by a fix, or noticed while fixing

Narrower gaps in what the fix round built, recorded rather than left unsaid. Each names
the decision record that states it.

| Audit finding | What is left | Priority |
| ------------- | ------------ | -------- |
| audit B1 | Waiting entries on a closed day stay waiting, silently (not dropped and told: DEC-13); offers withdrawn by a closure are not told; the class mover (`class-moves.ts`) does not re-ask the closure check inside its own transaction (ADR 0053) | P3 |
| audit B10 | The booking's hold is set by the scheduler's sweep, not inside the booking's own transaction (ADR 0054) | P3 |
| audit B13 | The WhatsApp template `mysenam_waitlist_offer` gained a parameter (the offer's minutes) and **must be resubmitted to Meta** before the WhatsApp offer is live-verified; no overnight pause was built; the lapse notice is email only, so a person with only a phone number is not told (ADR 0060) | P2 |
| audit G11 | A series cancellation and a class enrolment owe no recovery row for a lost notice; the sweep's venue-cancel message lacks the reason staff typed (ADR 0056) | P3 |
| audit G13 | Refund notices are email only (WhatsApp needs an approved template); a refund on a payment with no booking (a tournament fee, a share) cannot be told to the customer | P3 |
| audit D1 | A pass cancelled without a refund still forfeits restored entries; a counter-sold pass or membership's refund value is a credit note and a log line, not a task on a cash list (ADR 0062) | P3 |
| audit C6 | A part payment on a company invoice reaches the journal only as whole bookings are covered, and the customer's invoice page does not show it (ADR 0061) | P3 |
| audit C10 | Hire deposits taken before migration 0308 show "not recorded" and need the method said to keep an amount (ADR 0061) | P3 |
| audit C11 | A fee refunded at the counter is not in the till's payout list (ADR 0059) | P3 |
| audit E2 | The desk can still check in a refused (blocked) number (ADR 0058) | P3 |
| audit E3, E4 | A certification's expiry gives no warning to existing bookings; moving a booking into an unstaffed slot does not re-ask the sign-off; the induction note is not in the confirmation email (ADR 0058) | P3 |
| audit F2 | Three accounts can still suspend a person platform-wide (accepted) | P3 |
| audit F3 | Postponing a team-league night is not atomic (ADR 0059) | P3 |
| audit A2 | The email-existence oracle in the linking flows (a pass, a membership, a sign-off, a guardian) remains for live venues, throttled; a customer who has never booked cannot be found at the counter (ADR 0057) | P3 |
| audit G6 | Staff-alert messages naming a customer without a booking link keep the name for the 90-day retention; the payer's name and number on an online payment are anonymised after 730 days, an operational choice and not a statement of what the law requires for payment records (ADR 0057) | P3, 7 |
| audit A8 | Business-level staff log entries written before migration 0301 have no business and stay the platform owner's to read | P3 |
| audit C9, G16 | The liabilities block is provisional: voucher expiry, the pass value estimate and whether held deposits are a liability in the books are for the venue's adviser (ADR 0055) | P3, 7 |
| audit G15 | A consolidated e-invoice made after day 7 of the month: LHDN's timing is unverified, and what a late one means is for the adviser; the retry and catch-up are tested against the stand-in only (ADR 0055) | P3, 6 |
| audit D12 | A membership suspension does not pause collection at the gateway, tell the member at suspension that charges continue, or extend a dated suspension by default (ADR 0062) | P3 |

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
| S30 | Ticking off or hiding a venue's set-up checklist was not refused to the front desk by the server (the desk was not shown it); `POST /api/admin/setup` is a manager's | `tests/roles.test.ts` |
| S31 | Clearing a test booking that had real counter cash wrote its credit note with nobody named handing the money back, no payout and no owed record, and the cash-up omitted the receipt, so real money could vanish from the financial records; a test left standing at a live venue was left out of the consolidated e-invoice; now: the manager says whether real money was taken (declared synthetic, or owed back and settled by a named person); the cash-up shows tests in a block of its own; a payment once the venue is live makes a test real; a paid test standing at a live venue goes in the e-invoice | `tests/test-bookings-money.test.ts`, `tests/test-bookings.test.ts` |
| S32 | The email check reported a domain's DMARC and SPF records missing when its DNS lookups could not be made at all (raw DNS is refused from the cloud environment it runs in), and did not notice two DMARC records, which a receiver ignores | The records are read over DNS over HTTPS, a lookup that cannot be made is reported as such, and more than one DMARC record fails | `scripts/verify-integrations.mjs` (run against the owner's domain on 31 October 2026) |
| S33 | The suites were not hermetic: in an environment holding real test credentials (email, SES, WhatsApp), tests that sign somebody up queued, and tried to send, real messages, and two of them failed for it | Every provider credential and address is removed from the process the tests run in and from the browser suites' server; a test sets the one it needs | `tests/setup-env.ts`, `tests/applications.test.ts` and `tests/branch-copy.test.ts` with the credentials present |
| S34 | Saving only the cancellation cutoff in a venue's details ticked the setup checklist's *opening hours checked* step, so the hours were recorded as looked at when nobody had | Only a save that changes the venue's details or hours records them as checked | `tests/setup.test.ts` |
| B51 | The schedule listed a day's neighbours' bookings that only touched it (zero-minute rows at midnight) and showed an after-midnight booking under the following day; it now lists only what overlaps the day's own window, the evening's late hours with the evening | `tests/schedule-own-day.test.ts` |
| B52 | Twelve kinds of activity-log entry (tournament rules, results and corrections, league results and joining) had no label and showed their raw names; they are labelled in every staff language, and the label test reads every way an action is chosen | `tests/activity-labels.test.ts` |
| M23 | A tournament's entry fee was read from the tournament at payment and on the counter receipt, so changing the fee would have repriced entries already made; each entry keeps its own fee (migration 0238, backfilled) | `tests/tournament-changes.test.ts` |
| M24 | Closing an account cancelled its paid upcoming bookings with no refund, credit note or waiting-list offer, and also cancelled bookings played earlier that day; each is now cancelled on the customer's own terms through the one cancellation path, online money sent back or listed as owed (never to credit, the account being gone), and the erasure refused where it would give back stored credit. Found by the round 8 audit | `tests/erasure-money.test.ts` |
| M25 | Voiding a pass, or a membership without money back, wrote a credit note for the whole sale; voiding is no longer a refund, and money back (for a pass, its unused part only) is a choice of its own | `tests/void-credit-notes.test.ts`, `tests/receipts.test.ts` |
| M26 | A company or school account's booking cancelled after its invoice stayed charged with no credit note, and the account's amount owing disagreed with its invoices; the cancellation is credited to the account against the invoice once (migration 0242), and owing is what the unpaid invoices say | `tests/account-cancellations.test.ts` |
| M27 | Late-cancellation fees kept were missing from the period report's collected figure and its tax, which drifted a cent from the journal; the report and the journal now count them with the same SQL, and a late fee's tax is worked out on the fee itself | `tests/late-cancel-report.test.ts` |
| M28 | The sales journal subtracted the credit note of a cancelled booking paid with a pass without ever having counted it as a sale (the pass was), understating takings; such credit notes are left out | `tests/void-credit-notes.test.ts` |
| M29 | A counter payment on a booking the venue cancelled with others (a closed day, an outage, a rain-out, its API key, a class called off) was credited at once with nobody named, and counted in that day's cash-up as cash given back that never left the till; now owed back and settled by a named person, the credit note and the payout in the cash-up of the day it is handed back | `tests/counter-owed.test.ts` (also on Postgres) |
| M30 | Changing an operator's own activity answered 403 *not allowed* for every refusal, a name too long or a bad picture among them, so a manager was told they could not change what they could | 403 only for what is not theirs, 404 for not found, 400 for bad input | `tests/activity-pictures.test.ts` |
| M31 | A chargeback lost on a membership bought online voided the membership but left its receipt uncredited: the credit was looked for under the payment, while the receipt is the membership's own | Credited on the membership's receipt for what went back, as a pass's is | `tests/membership-purchases.test.ts` |
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
| B63 | The front desk was shown the Tournaments and Leagues tabs' set-up forms and buttons, which the server refuses it (creating, calling off, the draw, rules, seasons, a correction's knock-on), and offered moving a fixture, a correction once the knockout had moved on and disqualifying, which the routes refuse it; now hidden, or shown read-only, the desk's own entries, check-in, payments, officials and results kept | `tests/components/desk-sees-what-it-may.test.tsx`, `tests/components/tournaments-tab.test.tsx` |
| B64 | The set-up journey's cancellation card showed an unfilled `{late}` where the sentence about what happens after the cutoff belonged (English, Malay and Chinese) | The phrase names the value the card passes (`{keep}`); the card is checked for any `{name}` left in its text | `tests/guide-setup-ui.test.tsx` |
| B65 | A cancellation review's time was shown as the stored UTC timestamp, a day early or late for a venue in Kuala Lumpur | Shown on the venue's own clock like other staff moments | `tests/components/guide-tab.test.tsx` |
| B66 | Moving a tournament fixture onto a slot that straddled time just given back and time still held was refused (*not free for all of…*), because the check wanted one block spanning the whole slot | Blocks that run on into each other cover it; the check is still made under the court locks | `tests/tournament-day.test.ts` |
| B67 | In a performance event of marks, a heat correction once the final was filled looked like a change of the final's field (the ranking it compared against left out everyone already in the final): refused if the final had results, deleted and refilled otherwise, against the documented rule | The heats' own ranking is compared, so only a change of who would swim the final counts | `tests/counted-performances.test.ts` |
| B68 | Replaying a knockout match left the opponent who had beaten the wrong competitor in the next match while their own match was replayed, so they were in two matches still to play | The places a replayed match fed that are still to play are emptied whoever they hold; nothing that was played changes | `tests/double-elimination.test.ts` and `tests/consolation.test.ts` (the replay tests) |
| B69 | `recordResult` took no row lock on the tournament, so two results could interleave with a leaver or a fixture move | One change to a tournament's results and fixtures at a time, as moves and leavers already were | `tests/double-elimination.test.ts` (concurrent result and move, on Postgres) |
| B70 | Calling a fixture, sending it to another court or moving it, while a booking took the same minutes, could end in the database's overlap error instead of a refusal: the change's own transaction cannot go on after it, so the retry meant for it never ran. Found by the full Postgres run, where it failed three times in four under load | The change is refused whole (*a booking or a block took that time just now*) and undone, for a call, a swap and a move | `tests/tournament-day.test.ts` (B70, the refusal made deterministic; the race itself, which no longer ends in an error) |
| B71 | Creating a Swiss tournament with no explicit rules wrote its Swiss settings into the shared template's rules object, so every later non-Swiss tournament made from that template in the same process was refused with *Swiss settings are for a Swiss event* until restart | `createTournament` works on a copy of the parsed rules | `tests/public-names.test.ts` (creating events) |
| B72 | On the tournament page a refusal to enter (for example *this is for ages 18 to 40*) was shown in a plain block, so a screen reader would not announce it | It is an alert | `tests/components/tournament-entry.test.tsx` and the browser scenario *Teams 3* |
| B73 | The public team-league table had no cell spacing, so on a phone its columns ran together ("11 002 1") | The cells are spaced | `tests/uat/team-leagues.uat.ts` (seen in the phone screenshot; no unit test, the fault is visual) |
| B74 | A finished climbing event's dashboard page hid the officials' correction requests, so a manager could not preview, apply or decline one sent in the seven days after the finish | A finished counted event shows the requests, and only them | `tests/components/counted-grid.test.tsx` and the browser scenario *Climbing A* |
| B75 | Refusing a heat correction that would change a climbing final with results said *arrange a re-swim by hand* | It says *re-climb* for counted events | `tests/counted-performances.test.ts` |
| B76 | Moving a booking to another resource at the same time (`moveBooking`) did not ask the target resource's launch or tide window, so a booking could be moved onto a resource whose window was closed then, past a hard window too | It asks the target's window and refuses (`LAUNCH_*`); a manager's override is not offered on a move | `tests/advisory-windows.test.ts` |

#### Business-process audit, 6 November 2026

The [business-process audit](../audits/findings-register-2026-11-06.md) numbered its
findings by auditor and number (A1 to H13). Those are not the S, B and M numbers
above, which are never reused: they are cited here as *audit A1* and so on, and the
register holds each finding's evidence. Each fix has a decision record
([ADR 0053 to 0063](../architecture/decisions/)) and, where a migration was needed, a
number (0295 to 0311). The tests ran on PGlite and, for races and money, on Postgres,
by the fix workers; the lead's validation is in
[release records](../development/testing.md#release-records). A fix is not a live
check: where a row sends a message, takes money or calls a provider, its leg is still
`INTEGRATION_VERIFICATION_REQUIRED`. Rows say *in part* where something of the finding
is still open (see [the open items](#business-process-audit-6-november-2026-open-items)).

| Audit finding | Fixed by | Test |
| ------------- | -------- | ---- |
| audit A1 = H2 | One abandoned draft with a ladder stopped the daily retention run and every staff dashboard: the purge takes its deletion plan from the foreign keys, each business in its own savepoint, and skips and reports one it cannot delete; the dashboard's housekeeping is guarded (ADR 0057) | `tests/draft-purge.test.ts` |
| audit A2 | Staff found any customer on the platform by email or phone: on a marketplace they find only customers with a booking, credit, pass, membership, access-list entry or guardianship at their venues, throttled; linking is refused from a venue not yet live (ADR 0057) | `tests/customer-lookup.test.ts` |
| audit A3 | A manager invitation's link was readable by the front desk in the outbox while unsent or failed: every staff list masks account emails and any `token=` link (ADR 0057) | `tests/outbox-secrets.test.ts` |
| audit A4, in part | A suspended venue told only its staff: customers holding a booking, pass, membership or credit are told once; passes, memberships, credit and vouchers are not sold at a suspended venue; Stripe subscriptions are paused at the gateway, unverified (ADR 0063) | `tests/venue-suspension-effects.test.ts`, `tests/membership-renewal-pause.test.ts` |
| audit A6 = G12 | The owner's billing, grouping, approval and suspension actions and an API key's bookings left no log entry: they are logged, and marking an invoice paid or void needs a reason (ADR 0057) | `tests/owner-activity-log.test.ts`, `tests/staff-log-coverage.test.ts` |
| audit A7 | An overdue venue could be restored only by marking an invoice paid or void: the owner can give time with a reason, and lifting a payment hold means doing so (ADR 0063, migration 0311) | `tests/venue-suspension-effects.test.ts` |
| audit A8 | A business's managers could not see business-level staff changes: `staff_actions.business_id` (migration 0301) | `tests/business-activity-log.test.ts` |
| audit A9 | The front desk's permissions were a deny-list with nothing to classify a new route: every admin route is classified in one table that fails for an unlisted one; the outages `PATCH` and the two-factor reset moved to manager-only (ADR 0057) | `tests/admin-route-classes.test.ts` |
| audit A11 | An auto-approved branch ignored a suspended or held sibling: it needs another live, open branch and none suspended or held (ADR 0063) | `tests/venue-suspension-effects.test.ts`, `tests/branches.test.ts` |
| audit A12 | Venue sign-up said whether an email was a staff account: every address gets the same answer and an email (ADR 0057) | `tests/venue-signup-privacy.test.ts` |
| audit B1 = E9 = H3 | A closed day, rain-out and outage cancelled first and wrote the closure last: the closure is written first, nothing is offered for a closed day, a stray booking is swept (ADR 0053, migration 0295) | `tests/venue-closures-first.test.ts`, `tests/rain-out-closes-first.test.ts`, `tests/closure-races.test.ts` (Postgres) |
| audit B2 | A court could not be taken out from the afternoon after a morning booking was played: ended bookings and classes are never in the way | `tests/venue-closures-first.test.ts` |
| audit B3 | Credit or a pass could be taken for a booking cancelled a moment earlier: payment decides on the booking's status in its own transaction (ADR 0054) | `tests/payment-vs-cancellation.test.ts` (Postgres) |
| audit B4 | A weekly series was booked outside the hours in force on its later dates: each week is checked on its own date | `tests/series-dated-hours.test.ts` |
| audit B5 = E8 | A closure, rain-out or manual cancel refunded and cancelled classes that had already run; a past date was refused after everything was cancelled | `tests/venue-closures-first.test.ts`, `tests/rain-out-closes-first.test.ts` |
| audit B6, in part | One live offer per court and day blocked every other, and a claim never led to the next: court-time offers are per time and swept again (ADR 0060, migration 0306) | `tests/waitlist-offer-windows.test.ts`, `tests/waitlist-offer-races.test.ts` |
| audit B7 = E5 | An offer was made for a class that had started and ran past a session's start: capped at the start, none for a started class or under 5 minutes left | `tests/waitlist-offer-windows.test.ts` |
| audit B8 | The unpaid-bookings brake counted only the typed number: it counts the signed-in account too (ADR 0054) | `tests/unpaid-brake-account.test.ts` |
| audit B10 = C16 | A booking whose request died before its hold stayed confirmed, unpaid and unheld: the scheduler holds it or lets it go (ADR 0054, migration 0297) | `tests/booking-price-handshake.test.ts` |
| audit B13 | A waiting-list offer was a fixed 30 minutes and its lapse silent: a venue setting (default 30), told when it lapses by email (ADR 0060) | `tests/waitlist-offer-windows.test.ts` |
| audit B16 (deposit part) = C1 = H1 | A move to a cheaper time, a promo or a concession left a deposit above the price with nothing owed back: the excess is owed back on the deposit's payment with a credit note; friends' shares refuse the change (ADR 0054) | `tests/paid-within-price.test.ts` |
| audit C3, D20 | A refused promo still let credit settle at full price and no price check existed: `DISCOUNT_NOT_APPLIED` and `expectedTotal` / `PRICE_CHANGED` (ADR 0054) | `tests/booking-price-handshake.test.ts` |
| audit C4 | The booking form never showed that paying from credit failed: `walletErrorCode` and a sentence in four languages (ADR 0054); no rendering test | `tests/booking-price-handshake.test.ts` (the API half) |
| audit C5, in part | An issued company invoice drifted when a booking on it was rescheduled: the invoiced amount is kept; a cheaper move is a credit on the account (ADR 0061, migration 0307) | `tests/account-invoice-snapshot.test.ts` |
| audit C6 | Company credit notes were taken whole or not at all and an invoice could not be part-paid: credit is allocated part by part, invoices part-paid (ADR 0061) | `tests/account-credit-parts.test.ts` |
| audit C7 | An overdue company account could keep booking, unseen: shown in *Needs attention*, reminded weekly, and blocked after a venue's number of days where set (default off) (ADR 0061) | `tests/account-overdue.test.ts` |
| audit C8 = G4, G3, G5 | The report's *collected* and *outstanding* disagreed with the sales journal (adjustments, deposits, shares, pass-paid): one definition drawn from the journal's parts (ADR 0055) | `tests/report-reconciliation.test.ts` |
| audit C9 | The venue's liabilities in ringgit were not reported: stored credit, vouchers, deposits and shares held, hire deposits and refunds owed, provisional (ADR 0055) | `tests/report-venue-owes.test.ts` |
| audit C10 = E13 = H10 | Hire deposits were outside the cash-up and a kept amount defaulted to cash: the method is recorded when kit goes out, deposits and counted cash are in the cash-up (ADR 0061, migration 0308) | `tests/hire-cash-up.test.ts` |
| audit C11 = F4 = H4 | Counter fees were not owed back when a tournament was called off: `counter_fee_refunds_owed`, settled by staff with a credit note (ADR 0059, migration 0304) | `tests/competition-fixes.test.ts` |
| audit C17 = G11 | A customer's cancellation or confirmation message was lost with a request that died after the commit: owed in the same transaction and swept (ADR 0056, migration 0299) | `tests/notices-owed.test.ts` |
| audit D1 = H5 | Entries given back to an expired or voided pass were dead: an ended pass reopens for a venue-set grace (default 30 days); a pass cancelled with a refund is credited, not revived; a manager can extend a pass (ADR 0062, migration 0309) | `tests/pass-restore-and-validity.test.ts` |
| audit D2 | A double click on "no proof shown" charged the concession twice: decided once under the booking's lock; *Seen* is final | `tests/concession-check-once.test.ts` |
| audit D4 | A pass was judged on today, not the session's date: judged on the date played | `tests/pass-restore-and-validity.test.ts` |
| audit D5 | The review invitation was sent for bookings the link refused and the one invitation was spent: one predicate for both | `tests/reviews.test.ts` |
| audit D7 | Giving days back could run a membership into its next term: refused, saying how many days fit | `tests/membership-extension-and-renewing-suspension.test.ts` |
| audit D10, in part | A pass could not be extended: a manager can, with a reason | `tests/pass-restore-and-validity.test.ts` |
| audit D12 | An open-ended suspension of a renewing membership gave the member nothing for the charges: the days are given back when it is lifted; collection is not paused | `tests/membership-extension-and-renewing-suspension.test.ts` |
| audit E1 | A class called off raced an enrolment or a claim and left confirmed enrolments in a cancelled class: the roster is read under the class lock (ADR 0053) | `tests/closure-races.test.ts` (Postgres) |
| audit E2 | A number the venue refused kept its door code, check-in and bookings: the unattended ways in are refused and its bookings listed for a manager (ADR 0058, migration 0303) | `tests/safety-and-access.test.ts` |
| audit E3 | The sign-off or certification was not asked when an unstaffed slot was sold: asked at booking; an induction is told, not refused | `tests/safety-and-access.test.ts` |
| audit E4, in part | A sign-off, certification or induction taken back left the person's bookings unflagged: flagged, the customer told, the door withheld until staff decide | `tests/safety-and-access.test.ts` |
| audit E6 | Freed class places from a term cancel or a released hold were offered as court time: offered to the class's list (ADR 0060) | `tests/class-waitlist-closing.test.ts`, `tests/waitlist-offer-races.test.ts` |
| audit E7 | A customer's own check-in cleared a no-show, froze a class move and made a lesson count as held: a self or door check-in is recorded apart and is not verified attendance until staff confirm it (ADR 0058) | `tests/safety-and-access.test.ts` |
| audit E12 = H9 | A cancelled class left its waiting list waiting and told neither the list nor its coach: closed and told (ADR 0060) | `tests/class-waitlist-closing.test.ts` |
| audit E14 | A rain-out or closure skipped a booking with kit still out silently: it is named for the desk | `tests/venue-closures-first.test.ts`, `tests/rain-out-closes-first.test.ts` |
| audit F1 | Two draws at once made two brackets and a withdrawal could land inside a draw: the draw runs under the tournament's lock (ADR 0059) | `tests/tournament-draw-lock.test.ts` (Postgres) |
| audit F2 | An automatic suspension of an adult could not be reviewed as promised: the owner reads the reports, a 14-day review date, auto-lift under three reports, a review on request (ADR 0059, migration 0305); no legal right is promised | `tests/message-suspension-review.test.ts` |
| audit F3 | A lost court or closed day left drawn fixtures unannounced: shown, told once and postponable (ADR 0059) | `tests/competition-fixes.test.ts`, `tests/team-league-fixtures-lost.test.ts` |
| audit F5 | An entrant removed, disqualified or forfeited by staff was never told: told once, with the reason | `tests/competition-fixes.test.ts` |
| audit F7 | A tournament nobody drew took entries and fees after its first day: it stops, is closed by the scheduler and flagged | `tests/competition-fixes.test.ts` |
| audit F8, in part | A report of an adult message raised no alert: managers are told (no text) and the panel shows the age | `tests/message-suspension-review.test.ts` |
| audit F9 | A ladder challenge ignored for its window forfeited with no reminder: one reminder before | `tests/ladders.test.ts` |
| audit F10, in part | A walkover reported by a player stood after 24 hours' silence: the silent side is reminded 12 hours before and it is flagged for staff when it stood by silence | `tests/match-reports.test.ts` |
| audit G1 | A provider outage of 2.6 hours abandoned every waiting message: transient failures wait up to 7 days, staff resend everything that failed in a window (ADR 0056) | `tests/outbox-reliability.test.ts` |
| audit G2 | The sales-journal CSV wrote every credit note as text: numbers are written as numbers, text is still guarded (ADR 0055) | `tests/export-credit-note-numbers.test.ts` |
| audit G6 | Erasure and retention left the person in online payments, messages and webhook deliveries: reached, with a scan of every text column (ADR 0057) | `tests/erasure-scan.test.ts` |
| audit G7, G8, G9 | A reminder was keyed by code alone, a campaign queued ahead of confirmations and ignored withdrawn consent, and urgent news was written off by the daily limit: re-read as sent, campaigns last and consent-checked, one urgent list (ADR 0056) | `tests/outbox-reliability.test.ts` |
| audit G10 | One failing step before the drain stopped every message: each step is isolated | `tests/outbox-tick-isolation.test.ts` |
| audit G13 | The customer was never told a refund was made, failed or late: told once per change, by email (ADR 0056) | `tests/refund-notices.test.ts` |
| audit G14 | The platform's invoice to a venue was never sent: told on issue and before it is due (ADR 0056, migration 0300) | `tests/platform-invoice-notices.test.ts` |
| audit G15 | One venue's e-invoicing error stopped all, consolidation ran only on days 1 to 7, and a document not sent was never retried: isolated, retried with back-off, alerted; against the stand-in only (ADR 0055) | `tests/einvoice-resilience.test.ts` |
| audit G16, in part | The venue's liabilities had no ringgit and no vouchers: see audit C9 | `tests/report-venue-owes.test.ts` |
| audit H11 | A WhatsApp message sent again after a crash was charged twice: spent once per message | `tests/whatsapp-usage.test.ts` |

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
| A timed-out or interrupted MyInvois submission was shown as *Not sent* and could be sent again without checking LHDN, so LHDN could hold it twice | Shown as *Needs verification: submission outcome unknown*, sent again only after the manager confirms LHDN does not have it (kept with who and when), or recorded from LHDN's own identifiers once the document number is confirmed; every attempt kept | `tests/einvoice-sending.test.ts` |
| A new branch started blank, its courts, rates, rules and products entered again by hand | Started from another branch's set-up in one step, never its people, money, accounts or secrets | `tests/branch-copy.test.ts` |
| Bookings made to try a venue out before it went live stayed in its reports, exports and cash-up | Marked as tests by the database and left out of performance figures only: their money stays in the journal, the export, the cash-up's own test block and the period report; a manager clears them saying whether real money was taken (declared synthetic, or owed back until a named person settles it) or keeps one as real; real money arriving once live makes it real, and going live is refused with a paid test standing | `tests/test-bookings.test.ts`, `tests/test-bookings-money.test.ts`, `tests/components/test-bookings-panel.test.tsx` |
| Staff moved a weekly series one week at a time | The weeks left moved in one step, each by the single move's checks, a week that cannot move named with why; the customer and a lesson's coach told once | `tests/series-moves.test.ts` |
| The day list ran by court, not by time | In time order, then venue and court; the printed day sheet too | `tests/series-moves.test.ts` |
| Swiss accelerated pairing gave only a constant virtual point, not FIDE's graded (Baku) acceleration (ADR 0038) | FIDE's Baku method as an optional chess pairing, offered only where the template lists it ([ADR 0047](../architecture/decisions/0047-baku-acceleration-for-chess.md), migration 0289); still open for other sports | `tests/swiss-baku.test.ts` (also on Postgres), `tests/components/swiss-baku.test.tsx` |
| A declared minor had no messaging even in a group both sides agreed to, and the notice email was a leading-edge throttle (an owner decision) | A minor writes in a supervised youth group's shared thread only with their own opt-in, a live guardian's consent and a supervisor present; the notice email is a trailing digest ([ADR 0044](../architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md), migration 0286) | `tests/youth-messages.test.ts`, `tests/youth-safeguarding.test.ts`, `tests/message-digest.test.ts` |
| Moving a class was a manager's alone, so the front desk could not reschedule one | The desk moves a class at its own venue; a consequential move waits for a manager's approval ([ADR 0045](../architecture/decisions/0045-front-desk-class-moves-with-approval.md), migration 0287) | `tests/class-move-requests.test.ts` (also on Postgres), `tests/components/class-move-requests.test.tsx` |
| No override went past a launch or tide window, and an unqualified person counted for nothing whatever the qualification | An advisory window a manager may override with a recorded reason, a hard one never; a qualification is recommended, venue required or legally required ([ADR 0046](../architecture/decisions/0046-strength-of-a-requirement-advisory-windows-and-qualification-levels.md), migration 0288) | `tests/advisory-windows.test.ts`, `tests/advisory-windows-routes.test.ts`, `tests/qualification-levels.test.ts` |
| Ladder court-time holds were capped by install data with no setting, never expired and could not be confirmed | Limits a manager sets per venue and per ladder within bounds; a hold tentative until confirmed, expiring lazily with both players told ([ADR 0048](../architecture/decisions/0048-ladder-hold-limits-and-expiry.md), migration 0290) | `tests/ladder-hold-limits-and-expiry.test.ts` (also on Postgres) |
| Two guardians in disagreement over a child's messaging: any guardian's *off* ended every consent and any guardian could switch it on again (an owner decision) | Authority recorded per guardian link (`decides`, `objects_only`, `none`), since [ADR 0052](../architecture/decisions/0052-youth-messaging-interim-safeguards-pending-legal-review.md) a recorded decision whose restriction takes effect only when verified; an objection that no consent overrides until every guardian who decides agrees again or a safeguarding administrator resolves it; one lock per child and group so *on* never beats *off*; the other guardians told only that agreement is needed ([ADR 0049](../architecture/decisions/0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md), migration 0291) | `tests/youth-guardian-conflict.test.ts` (also on Postgres), `tests/youth-messages-races.test.ts` |
| A report in a youth thread told the supervisors and the guardians, and muted the reported adult (who could still read it) (an owner decision) | The reported adult told nothing by any channel and restricted at once behind a neutral line, a conflict guard for staff who are the accused, evidence read one report at a time with each reading recorded, a moderator's case as the only way they are ever told ([ADR 0049](../architecture/decisions/0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md), migration 0291) | `tests/youth-reported-adult.test.ts` (also on Postgres), `tests/youth-safeguarding.test.ts` |
| Ladder court time: both players confirmed even a time they had both already agreed (an owner decision) | An exact day and start one proposed and the other accepted unchanged makes the hold confirmed, each agreement kept; a manager's time stays tentative, and a manager's material change is tentative again ([ADR 0050](../architecture/decisions/0050-ladder-agreement-counts-and-expired-holds-do-not.md), migration 0292; a counter-proposal then stayed tentative, settled in the rows below) | `tests/ladder-agreement-and-active-holds.test.ts` (also on Postgres), `tests/ladder-hold-agreement-ui.test.tsx` |
| An expired or released ladder hold still counted to a player's weekly cap (an owner decision) | Only live holds count towards the active limit; a separate limit on abandoned holds was added ([ADR 0050](../architecture/decisions/0050-ladder-agreement-counts-and-expired-holds-do-not.md), migration 0292) and then replaced by one on a player's own cancellations only (the rows below) | `tests/ladder-agreement-and-active-holds.test.ts` (also on Postgres), `tests/ladder-hold-limits-and-expiry.test.ts` |
| Cancellations by the venue refunded online payments on some paths only (a court taken out of service and a class called off left them to staff, a tournament called off and shares paid by other players the same) | One policy: back through the gateway wherever it has a refund API, whatever the venue chose for customers' own cancellations, else owed for staff with its due date | `tests/venue-cancel-refunds.test.ts` (also on Postgres) |
| Ladder court time: a time the accepter named was a counter-proposal the proposer had not agreed, so the hold was tentative and both confirmed it (the first open question of [ADR 0050](../architecture/decisions/0050-ladder-agreement-counts-and-expired-holds-do-not.md)) | A counter-proposal is its maker's recorded agreement, makes no hold and reserves nothing; the other player's explicit acceptance of exactly it makes the confirmed hold and the maker is not asked again; proposals carry a revision, so a superseded one is refused, and a material change supersedes earlier agreements ([ADR 0051](../architecture/decisions/0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md), migration 0293) | `tests/ladder-counter-proposals.test.ts` (also on Postgres), `tests/ladder-hold-agreement-ui.test.tsx` |
| Ladder court time: an abandoned hold was charged to the player who made it, so an unresponsive opponent could run up the creator's count (the second open question of [ADR 0050](../architecture/decisions/0050-ladder-agreement-counts-and-expired-holds-do-not.md)) | Nobody is charged for an expired or unanswered hold; only a player's own cancellation of a capacity-reserving hold counts, 6 in 7 days pause new holds for 24 hours (never proposing, countering, accepting or playing), lifted by a manager; a neutral history records who proposed, countered, accepted, cancelled or did not respond ([ADR 0051](../architecture/decisions/0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md), migration 0293) | `tests/ladder-counter-proposals.test.ts` (also on Postgres), `tests/ladder-agreement-and-active-holds.test.ts` (also on Postgres) |

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
| Continuous integration | Not used, by the owner's decision for cost (accepted, 6 November 2026): GitHub Actions workflows start only by hand | Release verification is `node scripts/verify.mjs release --pg docker` on the AI development VM, with its report in `artifacts/verify/` and its record in [testing](../development/testing.md#release-records). No GitHub Actions run is evidence of anything; a release PASS is of one source digest, and `node scripts/verify.mjs check` says whether it still is |
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
| Email (SMTP or Amazon SES), including SPF/DKIM and calendar invites | Needs a live send | Any launch: confirmations go by email |
| Malware scanner (ClamAV, always-on or started on demand) | Verified in the development container with the official signatures, always-on and started on demand (start to answer 10.3–10.6 s, peak 972 MiB); not verified on a real Droplet: the kit's set-up in either mode, free memory with the app and Postgres running, clamd's load time on a shared vCPU, and the freshclam timer over days. On demand, the first document after an idle spell waits up to about a minute plus clamd's load before release | Any install taking supporting documents: without a scanner, documents wait in quarantine, unopened |
| SMS (Twilio or HTTP gateway) for phone codes | Needs a live send | Only where phone checks use SMS |
| LHDN MyInvois | Needs sandbox (preprod) verification | Only for venues (or a platform) that must e-invoice |
| Google sign-in | Needs a registered redirect URI | Only where switched on: password sign-in works |
| S3-compatible off-site backups and photo storage | Needs a real bucket. Tested against stand-ins for S3 and B2 only: B2's acceptance of a `writeFiles`-only key for uploads, its signing region, Object Lock default retention and versions listing are unverified until `npm run verify-offsite -- --go` passes against a real B2 (preferred) or S3 bucket | Off-site backups: any launch. A photos bucket: before more than one instance |
| DigitalOcean (remote staging only) | Needs a token for a separate team, scoped to droplets, tags and registry read, and an agreed spend; tested against a stand-in API | None: local staging works without it |
| Xero (live accounting push) | Tested against a stand-in only; needs the owner's Xero developer app and a demo company, then `node scripts/verify-xero.mjs`; data abroad needs approval ([Xero](../integrations/xero.md#verifying-against-a-demo-company)) | Only a venue that switches the push on: the export works without it |
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
