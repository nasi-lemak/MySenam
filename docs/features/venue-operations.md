# Running a venue day to day

Authoritative for the desk's tools: check-in and crowd levels, unstaffed hours and door codes, equipment hire, notes on customers, waivers, private hire enquiries and booking alerts.
Status: [feature status](../product/feature-status.md#venue-operations).

## Check-in and live crowd levels

Places booked and people present are different numbers, so arrivals are tracked
separately. Staff check a customer in from the Bookings tab (the Attendance
column), and optionally out again.

`GET /api/venues/:id/live` — public, no session — answers *how busy is it right
now*: someone counts as present once they have checked in, have not checked
out, and their booking has not ended, and so does everybody in on an
[entry with no set time](#entry-with-no-set-time) until they check out or
their longest stay passes. Most people leave without telling the
desk, so the booking's end time is the backstop that keeps the number honest.
The venue page renders this as a **Here right now** panel that refreshes every
30 seconds.

Check-in and no-show are mutually exclusive and self-correcting: a customer who
checked in cannot be flagged a no-show, and checking someone in clears a
no-show the desk had already recorded when they turn up late.

**Person by person.** Where a booking names the people taking part (two
children booked by a parent; [booking for somebody else](booking.md#booking-for-somebody-else)),
the Attendance column also lists each of them, and staff mark who arrived,
who did not, or clear it (`POST /api/admin/check-in` with `placeId` and
`mark`; `markPlace` in `src/lib/store.ts`; `place_attendance`, migration
0147). An arrival checks the booking in, within the same window; a no-show
only once the booking has started, and never for somebody seen to arrive.
The booking is a no-show (a strike against its customer's number) only when
everybody it names was one and nobody checked it in. Who recorded each is
kept and logged. A class roster is already one person per enrolment. An
arrival goes with the booking's check-in when check-ins are pruned
([privacy](../architecture/privacy.md)).

**A membership asked again on the day.** On a members-only session, checking
a booking in (or marking one person arrived) asks whether each person's
membership still covers the session's date
([before taking part](pricing.md#before-taking-part)). Where one was
cancelled, voided, has ended or is [suspended](pricing.md#suspending-a-membership)
on that day since it was booked, nobody is checked in
silently: staff see a warning naming each person and why
(`MV6_DESK_WARNING`, with `warnings`), and decide. *Admit them all the same*
(`admit: true`, with a note) checks them in and keeps the decision with the
booking (`membership_admissions`) and in the activity log
(`checkin.membership_admitted`); declining leaves the booking as it was, for
staff to cancel on the venue's terms or keep.

## Booking at the counter

Staff book on the venue's own booking page while signed in to the dashboard
(the counter): the customer is whoever stands in front of them, by name and
number, and sign-offs are checked as the venue's staff see them
([sign-offs](activities.md#sign-offs)). *New booking* on the Bookings tab
opens that page in a new tab on the day being shown (for staff of several
venues, a choice of venue). On *Court schedule*, a click on a free cell asks
first: *Book this* opens the venue's page at that court, day and time
(`/venue/:id?court=&date=&start=&sport=`, which the page already reads),
and *Block* takes it off sale as a click did before; a blocked cell is
released and a booked one queued for, as before. For a child or anybody else taking
part other than that person ([booking for somebody else](booking.md#booking-for-somebody-else)):

- Staff type the guardian's number and choose *for somebody on this number*:
  the participants the venue knows whose guardian is on that number are
  offered as candidates (`GET /api/admin/participants`), each ticked takes a
  place, and *the number holder takes part too* adds theirs. The number finds
  candidates; it never decides who anybody is.
- Somebody new is added there with the guardian's name, number, declared
  relationship and the declaration of authority made to the member of staff
  (`POST /api/admin/participants`), recorded as declared, never verified.
  A number with no guardian of that participant on it is refused
  (`PBK_NOT_GUARDIAN`): typing a number never makes anybody a guardian.
  An adult bringing a child the venue already knows, but not on record as
  their guardian, is invited to become a guardian of that same participant
  ([below](#another-guardian-by-invitation)), never made one on the spot and
  never a second record.
- The booking is the guardian's (told and paying as any customer); the child
  stays the participant, and their own eligibility is what the booking and
  the door check. The member of staff is recorded on each place
  (`booking_participants.added_by_admin_id`), in the participant's history
  and in the activity log (`booking.for_participant`). Classes enrolled at
  the counter the same way are logged as `class.enrol_participant`.
- **Corrections.** Under *Venues → Participants: guardians and own logins*, a
  manager finds the people the venue knows by a guardian's number (or what
  waits for review), ends, pauses or keeps a guardian's relationship, decides
  requests to become a guardian, or links a participant's own login by its
  email, each with a reason kept in the participant's history and the
  activity log (`PATCH /api/admin/participants/[id]`; front desk cannot).
  Front desk sees the same panel by a guardian's number, without those
  corrections, for what it may do: invite another adult, and act for a
  guardian recorded by name and number ([below](#guardians-without-an-account)).
- **A members-only or private venue's list.** At the counter staff book
  anybody on their word, list or not. Online the list counts only for an
  account linked to the entry or one that has proved its number, so a
  resident standing at the desk is the moment to link theirs: *Venues & staff
  → Who it is for*, *Link account* on their row, by the email they sign in
  with (or the number on their account), checked against the name and email
  shown; *Unlink* undoes it, and both are in the activity log. On a site
  without phone checks this is the only way residents book online
  ([who a venue is for](booking.md#who-a-venue-is-for-public-members-only-private)).

### Another guardian by invitation

A child the venue knows (their mother registered them, say) is brought by an
adult who is not on record as their guardian (their father). Staff never make
him a guardian from a name and a number: a phone number proves control of a
number, not authority over a child. Another guardian is a request
(`src/lib/guardian-requests.ts`; [ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md)),
on the existing participant, never a second record of the same child:

1. **Started.** In the counter's *for somebody on this number*, staff choose
   *An adult not on record asks to become a guardian of a child we know?*,
   type the number of a guardian on record and choose the child among the
   participants the venue knows on that number (no browsing, no match on
   names). Or a manager, under *Participants: guardians and own logins*,
   chooses *Invite another adult as a guardian*. Staff give the adult's
   name, and optionally the email of their MySenam account, so that only
   that account may accept (`POST /api/admin/participants/[id]/guardians`;
   front desk or a manager, for a participant their venue knows; another
   venue's staff get *not found*). A guardian of the child can start one
   too, from their own people page (*Share with another guardian*).
2. **Invited.** The request comes with a single-use code (hashed, a week,
   `participant_invites`), shown to staff once, for the adult to accept
   signed in to their own MySenam account (making one if need be), with
   their own declared relationship and authority. The relationship is bound
   to that authenticated account, never to a typed number.
3. **Agreed.** A guardian's own code needs nothing more: giving it was their
   agreement. A request staff started waits (*pending*) until an existing
   guardian with an account agrees on their people page
   (`POST /api/my/people/requests`), or an existing guardian the venue
   recorded by name and number agrees through its staff, by a code sent to
   their number ([below](#guardians-without-an-account)), or a manager
   records an exception (below). An existing guardian may refuse, with a
   reason; the request is then closed and its code dead. The guardians who
   could agree are emailed that there is a request to answer, and those
   recorded by name and number are told as [below](#guardians-without-an-account)
   ([messaging](../integrations/messaging.md#guardian-notices)).
4. **Active.** Only then is the relationship made (`participant_guardians`,
   provenance `online`: the adult's own declaration, signed in), and the
   adult books, applies and sees the child as any guardian does. Their
   number then books for the child at the counter.
5. **Told.** The participant's other guardians with an account are emailed
   that a guardian was added and when, with a link to report a mistake
   ([messaging](../integrations/messaging.md#guardian-notices)).
6. **Corrected.** A guardian who reports it as a mistake (*Report a
   mistake* beside the change on their people page,
   `POST /api/my/people/report`) flags it for a manager, who keeps it,
   pauses it, or revokes it, each with a reason (below).

**A request grants nothing.** Until it is active the adult cannot book for
the child (online `GUARD_NOT_FOUND`, at the counter `PBK_NOT_GUARDIAN`),
apply for them, see their approval status or record, or give out codes; the
child is not among the people they manage; their people page and their data
export say only that a request is pending.

**The exception, narrowly.** A manager (or the platform owner), never front
desk, may complete a request without an existing guardian's agreement:
under *Participants*, *Record an exception* on the request, with a category
(a custody dispute; an existing guardian who cannot agree, because they
cannot be reached, have no MySenam account and no number a code reaches;
another safeguarding reason), a
reason in words, and a date within a year to look at it again
(`PATCH /api/admin/participants/[id]`, `exception`). It may also say the
other guardians are not to be told, only where safeguarding requires it.
It is recorded as an exception, never as proof of legal guardianship: the
relationship it makes is flagged for review, and an activity that asks for
a guardian's authority to be reviewed (`guardianCheck`,
[sign-offs](activities.md#sign-offs)) still asks. Recorded before the adult
accepts, it takes effect when they do. A manager may also close a request
still open, with a reason (`closeRequest`).

**Review.** *Show what needs review* lists the participants the venue knows
with a relationship flagged (reported as a mistake, made by an exception, or
made by the earlier counter shortcut, below) or paused
(`GET /api/admin/participants?review=1`, managers only). A manager pauses a
relationship (`suspendGuardian`: it acts for nobody, online or at the
counter, until kept or revoked; nothing it made is undone), keeps it
(`confirmGuardian`: the flag closed, a pause lifted) or revokes it
(`revokeGuardian`), each with a reason, in the participant's history and the
activity log. A participant no venue knows (a family's own record) is
reviewed by the platform owner.

**On record.** Who started the request (staff by name and venue, or the
guardian), which account accepted and its declaration, who agreed or who
made the exception and why, who refused or closed it, who paused, kept or
revoked: on the request (`guardian_requests`), the relationship, the
participant's history (`guardian.requested`, `guardian.request_accepted`,
`guardian.request_agreed`, `guardian.exception`, `guardian.added`,
`guardian.notified`, `guardian.reported`, `guardian.suspended`,
`guardian.confirmed`) and, for staff, the activity log
(`participant.guardian_requested`, `participant.guardian_exception`,
`participant.guardian_request_closed`, `participant.guardian_suspended`,
`participant.guardian_confirmed`, `participant.guardian_revoked`).

**Earlier relationships.** Until 27 October 2026 the counter could make an
adult a guardian at once, by name and number (front desk) or by account (a
manager), on a declaration typed by staff. That shortcut is gone. Migration
0152 keeps every relationship it made (nobody loses one they hold) but flags
each for a manager's review (`review_reason = 'counter-shortcut'`). The
branch had not been launched, so none is expected in production; the flag
covers any test or pilot install.

Tests: `tests/counter-guardians.test.ts` (a request started by front desk;
pending grants nothing, online, at the counter, in status, in the export;
the existing guardians asked, then told; agreement; refusal; a code bound
to one account; the exception a manager's only, before or after
acceptance, with the notice suppressed; delivery failing and the queue
down undo nothing; a reported mistake paused, kept and revoked; another
venue; no second participant; guardians sharing one number; races on
Postgres; the migration's flag), `tests/components/counter-guardian-picker.test.tsx`
and `tests/components/guardian-requests.test.tsx` (the screens).

### Guardians without an account

A walk-in family's child is often recorded with one parent by name and
number only (`createAtVenue`, above). That parent has no account, so they
can neither agree online, nor be emailed, nor sign in. A name and a number
grant nothing on their own: a number proves at most that whoever holds the
phone can read a message sent to it. So everything such a guardian does goes
through the venue's staff (front desk or a manager, for a participant their
venue knows; another venue's staff get *not found*), and is proved
(`src/lib/contact-guardians.ts`; `POST /api/admin/participants/[id]/contact-guardians`;
on screen under *Venues → Participants*, found by a guardian's number, front
desk included):

- **A code to the number recorded for them.** Staff send a one-time code
  (six digits, ten minutes, five tries) through the install's own
  phone-check delivery (SMS, or WhatsApp's authentication template), under
  the same limits as a customer's own codes (five a day to one number, the
  site's daily ceiling) and three an hour for one guardian. The message
  carries the code and the venue's name, never the child's name or anything
  about them, in the customer language staff choose for it on the screen
  (one the install offers, starting from the language the member of staff
  reads the site in, as the waiting-list counter form does; sent without
  one, through the API, it is in the install's first). The guardian reads it back, present or on the phone, and staff
  enter it. It is then, as asked: their **agreement** to a request for
  another adult to become a guardian (recorded on the request as
  `staff_assisted_phone_code`, with the member of staff who entered it and
  when; the relationship is made now if the adult has accepted, or when they
  do, provided that guardian still acts for the child then); their own
  **withdrawal** (their relationship ended for good, by them, history
  kept; the other guardians told); or a **check** that the number reaches
  them. Whichever, the number is then known to reach them
  (`contact_verified_at`). A code wrong, run out, used, or replaced by a
  newer one is refused, and nothing is done.
- **No phone messaging on this install.** No code can be sent; a manager
  (never front desk) may record that guardian's agreement given in person,
  with a reason (`staff_in_person`). It is recorded as such, never as proof
  of authority, and the relationship it makes is flagged for review
  (`in-person-agreement`) like an exception's. Where a code can be sent it
  is refused: the code is the way.
- **Registering later.** The guardian makes an account and proves on it the
  number the venue recorded (the ordinary phone check). That alone shows
  them nothing and grants nothing. With it, a single-use code (a week)
  staff give them in person (*Code to take it over with an account*), or
  one another guardian with an account gives from their people page (*Code
  for a guardian a venue recorded*), entered under *Have a code?* with their
  declaration of authority again, binds the account to the existing
  relationship: the same row (`claimed_at`, how, whose code), the name and
  number staff recorded kept as how it began; no new participant and no new
  relationship. The other guardians are told. A code from a guardian who
  has since stopped acting, or for a relationship since ended or paused, is
  void. Where the site cannot check phone numbers (no SMS or WhatsApp),
  nobody can prove the number, so neither code is offered or made
  (`GW5_NO_PHONE_CHECKS`) and the panel says why: staff invite the
  guardian's account as another guardian instead.
- **Told of changes.** When a guardian is added or ends, a request waits for
  agreement, or a guardian takes theirs over with an account, a guardian
  recorded by name and number is sent a WhatsApp notice only at a number a
  code has come back from, in the language of that code (kept when it comes
  back, `contact_locale`, migration 0198): the venue's name, what changed,
  and the venue's page to find its number, to ask at the counter or call;
  never the child's name or anything else about them
  ([guardian notices](../integrations/messaging.md#guardian-notices); its
  template is prepared but not yet submitted to Meta).
  Otherwise nothing is sent, and the venue that recorded them gets a task
  under *Needs attention* (front desk too): tell them, then *I have told
  them*, recorded with who.
- **Disputes.** Such a guardian may report another guardian's relationship
  as a mistake through staff, with their note; it is flagged for a manager
  exactly as a report from a guardian with an account. A manager pauses,
  keeps or revokes it.
- **Authority, on every path.** A guardian paused for a review, or whose
  relationship ended, acts for nobody: not online, not in a group booking,
  not at the counter or through the venue's API key on their number, and a
  waiting-list entry they made for the child is offered to nobody and
  dropped ([booking for somebody else](booking.md#booking-for-somebody-else)).
  A paused guardian agrees to nothing.

**A manager's reminders.** *Needs attention* tells a venue's managers each
day how many participants the venue knows have a relationship waiting for a
review (flagged, paused, or made by an exception whose date to look at it
again has come) and how many such dates have come; *Show what needs review*
lists them, and *Keep* records the review (it clears the date). The platform
owner sees the same across every venue, and *Everything waiting for review,
at every venue* lists the participants no venue knows as well (a family's
own records), acted on as the owner.

On record: each code sent (who, for what, never the code), each agreement,
withdrawal, check, claim, report and task closed, in the participant's
history (`guardian.code_sent`, `guardian.request_agreed`, `guardian.ended`,
`guardian.contact_verified`, `guardian.claimed`, `guardian.reported`,
`guardian.notified_contact`, `guardian.contact_told`,
`guardian.consent_lapsed`) and, for staff, the activity log
(`participant.guardian_code_sent`, `participant.guardian_agreed_by_code`,
`participant.guardian_agreed_in_person`, `participant.guardian_withdrawn`,
`participant.guardian_number_checked`, `participant.guardian_claim_code`,
`participant.guardian_reported`, `participant.guardian_told`).

Tests: `tests/guardian-contact.test.ts` (agreement by a code, the text
carrying nothing about the child; codes wrong, run out, replaced and over
the hourly limit; agreement before acceptance, and lapsing when that
guardian withdraws; the in-person agreement a manager's only and only
without phone messaging; a paused guardian; another venue; claiming with a
proved number and a staff code, or another guardian's code, neither alone;
notices and tasks; a report through staff; authority lost online, in a
group booking, at the counter, through the API key and on a waiting-list
offer; reminders; the platform owner's review; races on Postgres) and
`tests/components/contact-guardians.test.tsx` (the screens).

### Phone checks: recommended, not required

Checking a customer's phone number by a one-time code
([authentication](../architecture/authentication.md)) is what lets a number
count by itself: a resident or member on a members-only or private venue's
list books online from their own account
([who a venue is for](booking.md#who-a-venue-is-for-public-members-only-private)),
a resident's guest proves their number, and a guardian recorded by name and
number takes the relationship over with an account (above). An install
without them (no WhatsApp or SMS provider set up) still works, through
staff: they link each resident's or member's account to their entry, a guest
counts once invited with their account email or linked, anyone not linked is
booked at the counter on staff's word, a code still goes to a guardian's
recorded number where SMS or WhatsApp can send one, and otherwise a manager
records an agreement given in person, flagged for review. Nothing is
bypassed: a typed number still lets nobody in.

Where a venue relies on numbers, its staff are told so plainly
(`src/components/admin/PhoneCheckAdvice.tsx`, staff phrases `lo6.pc.*`):

- *Venues & staff → Who it is for*, once *Members only* or *Private* is
  chosen: without phone checks, what they would enable, what happens without
  them, and the recommendation to ask whoever runs the site to switch them
  on (WhatsApp or an SMS provider set up); with them, one line saying they
  are on. A public venue is told nothing.
- *Venues → Participants*, after a look-up, where phone checks are off: that
  a guardian recorded by name and number cannot take the relationship over
  with an account (invite their account instead), what staff do without
  codes, and the same recommendation.

This is advice, not a setting: nothing is switched on, no paid provider is
chosen, and the rules above (an entry counts only for a linked account or a
proved number; a claim needs a proved number and a code) are unchanged.
Tests: `tests/components/phone-check-advice.test.tsx` (the notice by access
mode and phone-check setting, in the staff language).

### The day list

The Bookings tab lists the day's bookings in time order (at the same time,
by venue and court), as a table on a wide screen and as cards on a narrow
one, with the day's expected, collected and outstanding money. Filters narrow it to bookings still unpaid, those not yet checked in,
one court, or (for staff of several venues) one venue, saying how many of
the day's are shown. The venue column appears only when more than one venue
is shown. On the table each booking's actions (move, change time, correct
details, cancel, cancel or move the weeks of its series, block the number) are in one
*Actions* menu, so nothing is cut off at laptop width; the cards keep them
as buttons. *Print day sheet* prints the list alone, as a table without its
actions or the dashboard around it. Money handed back at the counter that
day for cancelled bookings is listed above it for the till
([cancelling a booking paid at the counter](payments-and-credit.md#cancelling-a-booking-paid-at-the-counter)),
and above that every counter payment still owed back on a booking the venue
cancelled, each with a button to hand it back or give it as credit
([owed back after the venue cancels](payments-and-credit.md#owed-back-after-the-venue-cancels)).
A weekly series is moved as a whole with *Move the series*
([moving a weekly series](booking.md#moving-a-weekly-series)).
Tests: `tests/components/bookings-tab-day.test.tsx`,
`tests/components/owed-series-move.test.tsx`, and the order in
`tests/series-moves.test.ts`.

### Correcting a booking's details

Staff (front desk too) put right a booking's name, phone number or email
with *Correct details* (`PATCH /api/admin/bookings`,
`src/lib/booking-corrections.ts`): a name spelt wrong, a mistyped number
that confirmations, reminders and offers would otherwise go to. On a weekly
series or a group booking they may correct every week or court of it that
still carries the details being corrected; a week since put in somebody
else's details keeps them. Bookings are chosen by the series or group, never
because another booking's details match.

- **A new number is asked what booking on it at the counter would be**
  ([the same policies on every path](booking.md#the-same-policies-on-every-path),
  `policyCheck` on the counter's path, for the dates still to come): who may
  book a members-only or private venue, the house rules, the guest limit, a
  blocked number, no-show strikes and the unpaid-bookings limit, a booking
  already paid counting as paid at the counter. A refusal is said as the
  counter says it (`R9_DESK_…`), and a manager may override what the venue
  lets its managers override, with a reason, recorded with the booking as
  any override is ([manager overrides](booking.md#manager-overrides)). A
  name or email alone asks nothing.
- **A correction, not a change of customer.** The account it was made from,
  its payments and the receipts and credit notes already issued stay as they
  are; what is drawn from the booking afresh (its receipt, reminders, the
  door) uses the corrected details.
- **Erasure and the log.** A booking whose customer asked to be forgotten is
  not given details back. The activity log keeps who corrected what
  (`booking.details_corrected`): the name before and after, as it already
  names customers; a number only by its last four digits; an email by its
  first letter and domain.

Tests: `tests/booking-corrections.test.ts`.

### Self-service check-in

Every booking carries a random 128-bit `check_in_token`, separate from the short
booking code (codes are printed on receipts and are far easier to guess). The
booking confirmation, `/account` and the `/my-booking` lookup each show a QR
code encoding `/checkin/<token>`; scanning it checks that booking in and shows
a confirmation, so arrivals do not depend on a staff member pressing a button.

Check-in — by QR or at the desk — is only open from
`CHECK_IN_OPENS_MINUTES_BEFORE` (60) minutes before the slot until it ends.
Without that window an early scan would count toward the live headcount for the
rest of the day.

Scanning the code never admits somebody to a members-only session whose
membership no longer covers its date: it is refused with the reason, and they
check in at the desk, where staff decide (above;
`MV6_CHECKIN_ENDED`, `MV6_CHECKIN_CANCELLED`, `MV6_CHECKIN_NONE`).

## Entry with no set time

A climbing wall, a bouldering room or a gym floor can let people in as they
come, with no booked time, while it has room (`src/lib/entries.ts`, migration
0266). It is a booking rule like the rest
([booking rules](booking.md#booking-rules-starts-lengths-buffers)), set at any
level (the venue, an activity there, one resource), and acts only on a
resource with places that is not run as classes only. It is **off on every
resource** until the venue turns it on: the catalogue marks climbing,
bouldering and a gym as usually sold this way (`entrySuited`), and the
booking-rules editor and the setup journey offer it for them, but nothing is
switched on for a venue by itself.

The settings, under *Courts* → booking rules → *Entry with no set time*:

| Setting | Means |
| ------- | ----- |
| Entry without booking | On: the resource admits people with no set time. Off (the default): by booking only |
| Walk-in price at the desk | What one entry costs at the counter. Blank: no walk-in is sold, only members and pass holders come in |
| Longest stay | Minutes an entry counts for (30 to 1440; 240 unless set). After it the entry stops counting by itself |
| Customers check themselves in | Somebody whose membership, pass or day pass admits them may let themself in by the resource's check-in page; otherwise only the desk admits |

**Booked sessions keep their places.** Bookings, classes, blocks and outages
on the resource are made and claimed as ever, and the database still refuses
an overbooking of them ([ADR 0010](../architecture/decisions/0010-interval-booking.md)).
An entry is not a claim: it is a row per person (`entries`), open from
admission until checked out or until its longest stay passes. Somebody is let
in only while the open entries and the places held now by claims overlapping
this moment are fewer than the resource's places, so an entry never takes a
place a booking holds. That is decided under the resource's lock (the
advisory lock claims on it take, then its row), so two admissions at once
never both take the last place (`tests/entries.test.ts`, also on Postgres). A
booking made for now is not refused for people already in on entry: the
venue's sessions keep their places, and the floor can briefly hold more than
its places until somebody leaves.

**What lets somebody in.**

- A **membership** whose plan admits with no booking (*Credit* → membership
  plans → *Members come in without a booking*; anywhere in the business, or,
  through the plan's `admitsEntrySport`, only where a resource offers one
  activity). It covers whom the membership covers on the day: the holder by
  their number, a participant on their own or a family membership naming
  them; never suspended, ended or cancelled
  ([what a benefit applies to](pricing.md#what-a-benefit-applies-to)).
- A **pass**: each admission spends one entry, by the pass's scope. One
  person's pass admits only its person; a pass for a booking or for each
  place admits anybody its holder's number brings, one entry each; a pass for
  a resource hired whole, a lesson pack or a time pass admits nobody.
- A **day pass**: one entry for one person that, once used, admits them again
  all that day (the venue's date of its first use) and on no other
  ([day passes](pricing.md#day-passes)).
- At the desk only, a **walk-in** at the resource's price: sold as a counter
  sale with its receipt ([selling at the counter](pricing.md#selling-at-the-counter)),
  how it was paid asked as any counter sale asks. A price of nothing admits
  for free, with no sale.

**What every admission asks**, as a booking asks it of that person: the venue
open; the number not on the venue's refused list; who the venue is for
(members only, or its private list); the venue's waiver, agreed for
themself or, for a child, by the guardian (at the desk *Agreed to the
waiver on paper just now* records it, as a booking's agreement is); the
activity's sign-off or certification (a belay check on a climbing wall); and
a participant only as themself, under a live guardian's number
([booking for somebody else](booking.md#booking-for-somebody-else)). Ages and
guardians' agreement are as declared, never verified. The same person is not
let in twice at once on one resource.

**At the desk.** The Bookings tab shows *Entry without booking* at a venue
with a resource taking entries: each resource's places taken (on entry, and
held by bookings now), a search by phone number that lists what lets that
person in (and each participant the venue knows on the number, each with
their own), *Admit*, and everybody in now with *Check out*. Admitting and
checking out are logged (`entry.admitted`, `entry.checked_out`).

**Letting yourself in.** Where the resource allows it, its page
`/checkin/entry/<court>` (linked from the venue's page; staff can print it as
a QR code like any link) lets a signed-in customer check themself in on their
own membership (on their proved number), pass or day pass. Nothing is paid
there, and only the account holder is let in that way: a child is let in at
the desk. Where the resource does not allow it, the page says to go to the
desk (`NBK_SELF_OFF`).

**Customers see**, on the venue's page, *No booking needed* for each such
resource: the walk-in price (or that entry is with a membership or pass), the
plans that admit and the passes and day passes the venue sells for it, and
how full it is now as a level (quiet, filling up, busy, full), never who is
there. The live crowd level above and the occupancy grid
([reporting](reporting.md)) count entries.

**Leaving.** Most people leave without telling the desk, so the longest stay is
the backstop: an entry past it no longer counts, whether or not anybody
closes it. The scheduler later closes such entries as having ended then
(`closeEndedEntries`); nothing depends on it running.

**Money.** A walk-in is a counter sale, receipted, in the day's takings, the
cash-up, the sales journal and MyInvois consolidation as counter sales are.
Day passes and passes are sold, refunded and accounted as passes are. An
entry on a membership or a pass moves no money.

**Not through the API or MCP.** `GET /api/v1/venue` and the MCP server's
`my_venue` say which courts take entries (read only); nobody is let in or
checked out through them.

Entries are kept as long as arrivals at the desk
([privacy](../architecture/privacy.md)), included in a venue's export of a
customer's data, and an erased account's entries lose its name and number.

Tested: `tests/entries.test.ts` (off by default and unchanged where off;
membership, pass, day pass and walk-in; capacity with a booking holding
places now; concurrent admissions for the last places, also on Postgres; the
longest stay; check-out; waiver, sign-off, refused number, members only,
guardian; a child as themself; self check-in only where allowed and only on
the account's own; a day pass bought online and then used; the venue page's
level without names; live occupancy and the grid; the activity log; the
venue API; the guide).

## Resources nobody is standing next to

Unstaffed gyms are a proven model — Anytime Fitness, Snap, Jetts, chocoZAP —
and what makes them work is not an absence of staff but a specific stack:
staffed hours daily, an induction in person before out-of-hours access, a
credential tied to one identity, cameras, a duress button, and equipment chosen
for use with nobody watching. MySenam models the parts of that stack that are
software.

**Two dials, not one.** A **venue** says when somebody is behind the counter
(`staffed_from`/`staffed_to`; both `NULL` means always, equal values mean
never). A **resource** says whether it may be used outside that window
(`unmanned`). The same gym floor is staffed at 10 AM and unstaffed at midnight,
which is how these places really run, and a centre can leave its courts
unattended overnight while the kayak counter keeps someone on it.

Two combinations are refused outright, whatever a venue asks for:

- **Any activity the catalogue marks as supervised** (`supervised`, see
  [activities](activities.md#the-catalogue)): swimming, water polo and
  everything on the water. Drowning is silent and fast, which is why the
  24-hour chains sell gym floors and not lap pools. A court offering several
  activities is refused if any of them is supervised.
- **Anything hired out against a deposit.** There is nobody to hold the money
  and nobody to look at the hull when it comes back.

**MySenam does not open the door.** It relays a code that staff have programmed
into the lock, and the lock stays the source of truth. Generating or rotating a
code here would be worse than useless: the lock would not know about it, and
the court would be unopenable by the one person entitled to be inside. Staff
type in what they set; MySenam stamps when it changed and nags after
`ACCESS_CODE_STALE_DAYS`.

Who gets the code, and when:

| Condition | Why |
| --------- | --- |
| The resource is unmanned and has a code | Otherwise there is nothing to give, and the customer is told someone will let them in |
| Some of the booking is **unstaffed**, judged by its whole time, past midnight too | During staffed hours the counter does this, and a code handed out then is a code in circulation for no reason. A booking staffed for only part of its time (it starts before the counter shuts and runs on after) gets the code, so nobody is shut in or out at the end, unless the venue says somebody stays on the desk until such bookings end (`partly_unstaffed`: `code`, the default, or `counter`) |
| Everybody taking part has been **inducted** at that venue, each on their own ([inductions](#inductions)) | Nobody is there to show a stranger where the emergency button is, so it has to have happened already, in person. An induction is not an activity [sign-off](activities.md#sign-offs), which clears somebody to book one activity at any hour |
| Where the booked activity's rules ask for a [sign-off](activities.md#sign-offs) or certification, or the venue takes [approval applications](activities.md#registering-online-for-approval) for it, one is in force that day for everybody taking part: the customer's own (for the number booked), and each participant's own | Nobody is there to check. The rules are the activity booked, on a resource that offers several. Eligibility is never bypassed, whoever made the booking: one made past the rules by a manager, at the counter, through the venue's API key, as a coach's lesson, a session booked for an approval's in-person step, or one whose application is pending, refused, lapsed or revoked gets no code (`approval-needed`) ([ADR 0020](../architecture/decisions/0020-approval-to-booking-payment-and-authority.md); `tests/approval-workflow.test.ts`, "door codes never bypass eligibility") |
| The booking is not **staff-supervised** | A manager can arrange staff-supervised attendance for somebody not signed off, where the venue's safety procedures allow (*Courts & rates → Staff-supervised attendance*, saying who supervises under which procedure; recorded in the activity log). Staff meet them and let them in (`supervised`); it is never a door code and signs nobody off for later |
| On a members-only session, **everybody taking a place is still a member on its date**: their own membership, or a family one naming them (the customer's own place: theirs, or the venue's list) | A membership cancelled, voided on a chargeback, ended or suspended on the day since the booking was made is for staff to decide at the desk, never the door (`membership`, `MV6_DOOR_*`, `MS7_DOOR_SUSPENDED`; [before taking part](pricing.md#before-taking-part)). A court reserved whole is the booker's privilege, checked when it was booked, and is not asked again |
| The booking is not cancelled | — |
| **The booking is paid** | Nobody is on site to take payment, so the door is the till. An unpaid booking still holds its slot; the code appears the moment staff or a payment marks it paid |
| Inside the check-in window | The same hour before the slot that check-in already uses |
| Before the slot ends | — |

Each refusal carries its own `reason`, so the customer is told what to do about
it rather than getting a flat no. The booking's own page says beforehand which
it will be: the door code, the code because the desk shuts during the booking,
or the counter for all of it (`tests/access.test.ts`, "a booking across the
staffed boundary").

**Inductions** are recorded by a named operator, never self-declared, and
belong to the person shown round, each on their own ([below](#inductions)).

Four consequences worth stating plainly:

- **Every reveal is written down**, one row per look, with the booking, name and
  phone behind it. When a court is found in a state on Tuesday night, "who had
  the code" is the whole investigation — so the log is append-only and the
  venue's staff can read it from the Courts tab.
- **Opening the door is the arrival.** The reveal checks the customer in, so
  *Here right now* stays honest and no-shows stay meaningful with nobody at a
  desk to press a button.
- **The entry screen carries the emergency details.** The venue's out-of-hours
  number and whatever it wants people to know — where the AED is, the nearest
  clinic — plus how many people are checked in right now, so somebody letting
  themselves into an empty building at 2 AM knows they are on their own. It is
  the one screen you know they are looking at while standing inside.
- **The code never travels with the court.** `Court` is served by the public
  `/api/venues` and availability routes, so it carries `unmanned` but never the
  code itself; the code is only ever read through an admin route or handed to
  one authenticated customer, with `Cache-Control: no-store`. Asking for it is
  a `POST` for the same reason — it writes a log line, and has no business in a
  browser history or a proxy log.

The customer-facing reveal is rate limited to 10 per 10 minutes per IP, tighter
than an ordinary booking lookup, because a booking code plus a phone number is
now a door.

### Inductions

Inductions are the part that turns unstaffed hours from reckless into
insurable, so they are recorded by a named operator and can never be
self-declared: `POST /api/admin/inductions` takes the admin from the session,
not the body (*Courts & rates → Cleared for unstaffed hours*). An induction
belongs to the person shown round
([ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md)):

- **The number holder's own**: the person whose number it is, matched on a
  normalised phone number so `+60 12-345 6789` and `012-345 6789` are the
  same person. One per number per venue.
- **A participant's**: a child (or anybody else) on a guardian's number.
  Staff type the guardian's number, choose *for somebody on this number*, and
  pick the participant among those the venue knows whose guardian is on it,
  or add somebody new with the guardian's declaration made to them
  (`/api/admin/participants`). The number is kept to reach the guardian, never
  as the participant's identity: it counts for that participant alone, never
  for the number holder or a sibling, and the number holder's never for
  them. One per participant per venue.

Either is revived rather than duplicated if access is withdrawn and later
restored. Withdrawing access shuts the door on the next request. The door
asks for the induction of everybody taking part in the booking: the
customer's own where they take a place (or where the booking names nobody
else), and each participant's own. A participant linked to their own login
counts that account's own induction too, and the account theirs.

**Older inductions on a family's number.** Until migration 0140 an induction
could only be filed against a number, so a child shown round on a parent's
number was filed as the parent's. Those stay the number holder's: nothing is
moved on matching contact details. Where the number is that of an account
managing a participant and the name filed is not the account holder's, the
row is flagged *Check whose this is*. A manager decides (*Whose is this?*,
`PATCH /api/admin/inductions/[id]`): gives it to the participant it was for,
chosen among those the venue knows whose guardian is on that number, keeping
the name it was filed under; or confirms it is the number holder's own. A
reason is required either way, and who decided, when and why is kept on the
induction, in the participant's history and in the activity log. Front desk
cannot do it.

## Equipment hire and deposits

Most resources stay where they are: you cannot walk off with a badminton court.
A kayak is different. It goes out on the water, it can come back damaged, and
the venue holds something against that — usually cash or a card imprint at the
desk, handed straight back when the hull is.

A court carries a `deposit`. `0`, the default and the only sensible value for
anything fixed, means the resource is not handed over at all and no hire
appears anywhere in the flow. Above zero turns on the counter workflow:

- **Handing over** records the deposit held against that booking and checks the
  customer in, since those are one action at the desk. On a booking for
  somebody else (a child's kayak), the customer (the guardian) holds the
  deposit and is told about it, and the hire record names who has the kit
  (`participantName`, from the booking). The check-in window
  applies unchanged, so kit cannot leave an hour before the slot it belongs to.
  Staff may override the amount, including waiving it — the record is worth
  keeping either way, because the kayak is out.
- **Taking it back** records the condition (fine, damaged, not returned),
  anything kept back out of the hold, and a note. Nothing can be kept back that
  was not held, and anything short of a clean return needs a note: the customer
  is about to be told why they are not getting all of their money, and
  "damaged" on its own is not a reason that stands up a week later.
- **While kit is out** the booking cannot be cancelled or moved, by staff or by
  the customer, and the venue cannot switch the deposit off on that resource.
  All three would quietly destroy the only record of what is out and what is
  being held against it.

The deposit is deliberately *not* a wallet movement. Stored credit is money the
venue owes the customer against future bookings; a deposit is a hold at the
counter that mostly ends up handed back untouched. Modelling it as credit would
put both in the same balance and make a refund look like a top-up. `hire_records`
therefore tracks the state of the hold — taken, returned, how much was kept and
why — and leaves the ledger alone.

### Money kept from a deposit

**What is kept is a sale, one per reason.** Staff do not decide tax at the
desk. On return they say *why* money is kept, as one or more lines, each a
reason and an amount (`src/lib/deposit-deductions.ts`):

| Reason | What kind of money it is | Heading in the books |
| ------ | ------------------------ | -------------------- |
| Damage to the equipment | Compensation | Hire: damage and loss |
| Lost or not returned | Replacement | Hire: damage and loss |
| Kept past the time booked | More hire (a service) | Hire: extra charges |
| Cleaning | A service | Hire: extra charges |
| Administration fee | A fee | Hire: extra charges |
| Penalty under the hire terms | A penalty | Hire: penalties |
| Other (said in the note) | Other | Hire deposits kept |

Each line is rung up, in the same change as the return, as a counter sale
linked to the hire, with a receipt: in the day's takings, the reports, the
sales journal under its heading, and the exports. Staff say how it was taken
(the way the deposit was paid). A reason is used at most once per return; the
lines must be positive and together no more than the deposit held. The
deposit, the amounts kept and the amount handed back always add up, and two
returns of the same kit at once keep it once (the second is refused). An
older client that sends one amount kept gets the reason from the condition:
damaged is damage, not returned is loss, anything else is other.

**Whether a reason carries the venue's tax** comes from the venue's tax
settings, not from the person at the desk. It starts from a provisional default
in the install's country ([regions and tax](../product/regions-and-tax.md)):
in Malaysia and Singapore a charge for something the venue supplies (more
hire, cleaning, a fee) carries the venue's SST or GST if it is registered;
compensation, replacement, a penalty and *other* do not. A manager can set any
reason to taxed or not taxed under *Tax*, or back to the usual. Whether money
kept is consideration for a supply, and so taxable, is a question of fact
under each country's rules, and MySenam does not decide it. A receipt for compensation,
replacement or a penalty says what it is for, so it is not read as a sale of
a service.

**Provisional until reviewed.** The country defaults have not been reviewed
by a tax adviser and are not tax advice. Until the venue records a review,
the *Tax* settings say *Provisional*, the return form says each reason's
treatment is a provisional default, and every amount kept is marked so.
A manager records the review with the adviser's name and firm, once the
adviser has checked (and the venue has changed) each reason's treatment;
the treatment is then *reviewed* until any reason changes, which lapses the
review. Every change and review, with who made it, is kept in a record that
is never pruned (`deduction_tax_changes`). Each amount kept carries the
footing it was taxed on (provisional default, the venue's unreviewed choice,
or reviewed), shown in the sales journal and its export
([reporting](reporting.md)). Professional review is also needed of whether a
penalty clause is enforceable and how the headings map to the venue's own
chart of accounts. Recording the review is in the
[launch checklist](../operations/deployment.md#launch-integration-checklist).

Customers see the deposit before they commit: on the grid row, on the booking
panel and on the confirmation, phrased as what it is rather than as a charge.

## Notes on a customer

Staff remember things about regulars: prefers Court 3, pays by transfer, bring
the ramp out, the coach's son. 📝 beside a customer on the day's bookings
writes a note against their phone number, one per number per venue (however
the number is typed), and it shows on every booking of theirs from then on
(`src/lib/customer-notes.ts`). Anyone at the desk can write, change or clear
it; each change is in the activity log, and the note says who last wrote it.

A note is personal data, so staff are told as they write it to keep it
factual: it goes out with what the venue holds against the number and with
the customer's own data when they ask for it, and it is erased with their
account, by the number on the account and the one they proved.

## Waivers

A climbing wall, a gym floor, kayaks on a lake, or any court that wants one:
*Venues & staff → Waiver* holds the venue's words (`src/lib/waivers.ts`). With
a waiver in force, the booking form and the class enrolment form show *I have
read and agree to the venue's waiver*, with the waiver a click away at
`/venue/{id}/waiver`, and a booking or enrolment is refused until it is ticked.
What is kept is the agreement: which version, by which number (however it is
typed), in whose name, on which booking, and when. A number is asked once,
until the venue changes the words: new words are a new version that everybody
agrees to afresh, and the editor says how many have agreed to the one in
force. The box is shown to everyone, since whether a number has agreed is not
something to tell a stranger.

The day's bookings flag anybody who has not agreed (a walk-in booked at the
desk, say) with *No waiver yet: signed on paper?*, which records a paper
signature in the name of the member of staff. Managers write the waiver; the
desk records paper ones, which go in the activity log.

An adult booking or applying for somebody they manage agrees on that
person's behalf: the signature records the adult as signer and the person as
participant, and counts for that person only, apart from the adult's own
([applying for somebody you manage](activities.md#applying-for-somebody-you-manage)).
A booking naming several participants is flagged until each has one. Once a
participant is linked to their own login, that account's own agreement counts
for them too.

A signature is the venue's record of consent, so like the money on a booking
it is kept when a customer erases their account; it goes out with what the
venue holds against the number and with the customer's own data.

## Private hire enquiries

A tournament, a company sports day, a birthday party, a school's sports day:
not a slot on the grid but a conversation, where the date may move, it may
want every court, and the price is the venue's to quote. Every venue page ends
with *Private hire and events*: name, phone, an email if they like, what it is
for, the date if they know it, roughly how many people, and what they have in
mind (`src/lib/enquiries.ts`).

It lands on the *Bookings* tab under *Private hire enquiries*, open ones first,
with buttons to call, WhatsApp or email the person, and to mark it replied,
booked or declined (and by whom). Where the venue gave an address for new
bookings, it is emailed there too. Staff then book the courts themselves,
blocking them or booking them in the customer's name.

The email button fills in a subject in the customer's language where the
platform knows it: the language of an account with the enquiry's email
address, else the language the venue page was in when they asked
(`hire_enquiries.locale`, migration 0122), as long as the site still offers
it; otherwise the staff member's own. Enquiries made before the language was
kept have none, so their subject is in the staff member's language. Only the
subject is filled in: what staff write is their own.

A number can send three a day to one venue, the form has a field only scripts
fill in, and the route is rate-limited. An enquiry goes out with what the venue
holds against the number and with the customer's own data, is erased with
their account, and is deleted after a year.

## Booking alerts

Under *Venue details → New-booking alerts* a manager gives the desk's email
address, a WhatsApp number, both or neither (`/api/admin/booking-alerts`;
`src/lib/notify.ts`). Each booking a customer makes online then goes there
too; bookings staff make are not announced back to the desk. How the
messages are sent, retried and counted is in
[messaging](../integrations/messaging.md#new-booking-alerts-to-the-venue).

The venue may also hear when a customer, online, **cancels** a booking, or
**changes** one: its date, time or court (themself, or by moving an open game
they host), or takes somebody off it. Each is ticked separately and both are
off until ticked (migration 0237). Only bookings starting soon enough to
matter are announced: within a day of the change unless the venue widens it
to two days, a week, or any time ahead; for a change, the old start or the
new one within that time is enough. The message says what happened
(*cancelled*, *changed (it was Fri 7 Nov, 8:00–9:00 PM)*, *changed (somebody
taken off it)*), who, their number, where, when and the code; a weekly series
cancelled at once is one message for its first week in the window, with how
many. It goes to the same address and number as new-booking alerts, through
the outbox, in the language chosen for those alerts (else the install's first
staff language); on WhatsApp it counts against
the venue's messages and needs the `mysenam_venue_booking_change` template
approved ([templates](../integrations/whatsapp-templates.md)), which is
prepared and not yet submitted to Meta. What staff do at the desk is never
announced back to the desk. The setting is a manager's and is in the activity
log.

## The venue's number

Wherever a customer may be told to call the venue (a change inside the
cutoff, a refund to be made by hand, a refused number, a booking refused for
any reason), the venue's number is there with it, as a link to dial
(`components/VenueContact.tsx`, `lib/venue-contact.ts`): on My Booking under
the booking's details and under any refusal, on each of an account's
upcoming bookings, and in the booking form under a refusal. Where the venue
says its number takes WhatsApp (*Customers may WhatsApp this number* under
*Venue details*; `venues.phone_whatsapp`, migration 0249, off until a manager
ticks it, in the activity log as a change to the venue's details), a *Chat on
WhatsApp* link opens a chat with that number, the booking's code written in
(`tests/venue-contact.test.ts`).

## The staff dashboard: its place, keeping up, its fields

- **Its place is in its address.** The tab is `?tab=` (Bookings, Schedule,
  Reports…), and on the day list and the schedule the day (`&date=`) and, on
  the schedule, the venue (`&venue=`), so a reload, the Back button or a link
  somebody was sent lands where they were. Each tab is a step in the
  browser's history; changing the day or venue is not. A tab this account
  does not have (a front desk's link to Reports) opens on Bookings; a venue
  it does not run is ignored. The current tab is marked for screen readers
  (`aria-current`) as well as by colour (`components/admin/place.tsx`).
- **The set-up checklist at the top of the dashboard has a longer form.** Its
  three steps are the first three of the *Guide → Set up* journey, read from the
  same answers; the journey adds the questions, the plan and *Try it*
  ([the setup journey](venue-guide.md#the-setup-journey)).
- **A small "?" beside some controls explains them.** On the screens for booking
  rules, shared and linked courts, peak and dated prices, discounts, passes and
  memberships, guardians, cancellation terms, the cancel panel, a lesson's coach,
  unattended hours, test bookings and a refusal at the counter, it opens what the
  guide says of that subject for this venue and the reader's role, read only
  when opened ([contextual help](venue-guide.md#contextual-help-and-discovery)).
- **The day list and the schedule keep up by themselves.** While on screen
  they read the day again every minute, and at once on coming back to a tab
  hidden for a while; not while hidden. Only their data is read: what is
  being typed stays. *Updated 6:31 PM* says when, on the venue's clock. An
  answer for a day left since is dropped.
- **A list that could not be read says so**, with *Try again*, rather than
  its *None yet* (tournaments, leagues); any answer that is not the app's is
  said as such in the staff language, never as a parser error
  ([HTTP routes](../architecture/http-api.md#how-every-route-behaves)).
- **Every field has a name** a screen reader says and a person can still read
  once they have typed: a visible label (the class form) or, where a row has
  no room for one, an `aria-label`; a placeholder is never the name.
  `tests/form-labels.test.ts` reads every staff component and fails on a
  field without one (`tests/components/staff-place.test.tsx` for the rest).
