# Messages between players

Authoritative for what players can write to one another inside MySenam, who may,
where, and what keeps it safe. The decision behind it is
[ADR 0039](../architecture/decisions/0039-messages-between-players.md); the
privacy wording is [privacy](../architecture/privacy.md#messages-between-players);
status is in [feature status](../product/feature-status.md) and planned work in the
[roadmap](../roadmap/roadmap.md).

Players used to have no way to write to each other here. Now they do, **only inside
something they already share, only as adults who turned it on, as text, never with
anybody's phone number or email, and never to a stranger.** The one exception is a
**supervised youth group**, where a minor may take part in the group's shared conversation
under rules of their own ([below](#supervised-youth-groups); [ADR
0044](../architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md)):
never privately, never without a guardian's consent. The rest of this page is the rules, as
built.

## What a conversation is

A conversation (a *thread*) belongs to one **context**, begins with the first message
written in it, and ends with it. The contexts are the ways two people already stand
together in MySenam (`src/lib/message-contexts.ts`):

| Context | Who is in it | It ends when |
| ------- | ------------ | ------------ |
| An **open game** | The host and the players accepted (not asked, waiting or offered) | The game has been played, or is called off |
| A **team** that persists ([teams](tournaments.md#teams)) | Its members, and a child's guardian for them | The team is archived; a member who leaves is out at once |
| A **community group** ([groups](matchmaking.md#community-groups)) | Its members; a [supervised youth group](#supervised-youth-groups) has its own seats (supervisors, adults a supervisor let in, minors with every consent on) | The group is closed (or, for a youth group, stops being one: its conversation is then closed for good); a member who leaves is out at once |
| A **tournament match** | The two entrants, as entered (a team entry: its captain) | The match is decided, or the event finished or cancelled; an entrant withdrawn is out at once |
| A **box-league match** | The two players | The match is confirmed, walked over or voided, or the season finished; a player who left is out |
| A **ladder challenge** | The challenger and the challenged | The challenge is decided, declined, cancelled, lapsed or voided, or the season ended |
| A **team-league fixture** | The two teams' captains | The fixture is confirmed, forfeited or voided |

There is **no other way to start one**: no search for a person, no lookup by name,
phone, email or account number, no new conversation "to an address", no list of people
to choose from. Who is in a context is read from the live tables every time (nothing is
copied), so a person who leaves, is removed or withdrawn stops being in it immediately.
Somebody who is not in a context gets `404` for it, the same answer as for one that does
not exist.

**What ends a conversation.** A context that is over leaves its conversation **read-only
for 14 days** (both sides can still read, nobody can write), then **closed** (not
listed, not readable). A closed or ended conversation is kept for the install's
retention period (default 90 days after the context ended, `MESSAGE_RETENTION_DAYS`) and
then deleted with its messages ([privacy](../architecture/privacy.md#messages-between-players)).

## Who can message: adults who said yes

- **Adults only.** Messaging is for a player who has declared they are 18 or over in
  their [playing profile](matchmaking.md#suggested-games-and-players) (their word, never
  verified). A player who has declared under 18, or has not said, **has no messaging of
  their own**: they cannot turn it on, are not in anybody's ordinary conversation, and are
  told why. The only seat such an account can have is in a
  [supervised youth group](#supervised-youth-groups), with every consent live. Saying
  "under 18" later switches an adult's messaging off at once.
- **Children never message privately.** Outside a supervised youth group a child is not an account that writes: where a child is
  in a team, or entered in a tournament, league or ladder, the seat in the conversation is
  **the guardian's account**, shown as *Guardian of Aina L.* (the child's short name, by
  [the one public-name rule](../architecture/privacy.md#minors-names-on-public-pages), never the full
  name, never the guardian's own name beside it). Nothing is ever written *to* a
  child. A guardian who is also a member shows once, as both (*Priya, guardian of Aina
  L.*). The guardian's account must itself be a declared adult with messaging on.
- **Opt-in, default off.** The setting is *Let people I play with message me*, global,
  with a per-context mute. **Both sides must have it on:** a conversation can be written in
  only where somebody else in the context has it on too. Joining a game, a team or
  anything else **never** turns it on. The first screen (the Messages page, until it is
  on) says what it is, that nobody can look the person up, that their phone and email are
  never shown, that they can mute, block and report at any time, and that the email never
  carries the message; it must be read and confirmed (`understood`) the first time.
- **A mute** (per context) stops the email and the unread count for that person; they can
  still read and write.
- **Who has it on** is not shown. The one thing a person learns is whether anybody else
  in a context can be written to now ("N people to write to" and *Nobody else here can
  be written to right now*), which a context's members could already tell from the
  roster.

## What a message is

- **Text only.** No attachment, no image, no file (there is no column for one). A link
  is shown as the plain text it is: not clickable, not previewed, nothing loaded.
- **Up to 1000 characters**; control characters removed, blank lines squeezed.
- **No phone number, no email address.** A message carrying an email address, or a run
  of digits that reads as a telephone number, is refused (`PM_CONTACT`) with a clear
  sentence. **This is a speed bump, not a guarantee:** somebody determined can spell a number
  out, and nothing here understands what a message means. There is no other scanning of
  content. A run of 8 or more digits (spaces, dashes, dots, brackets and `+` allowed) is
  refused when it has a group of three or more digits, or ten digits in all, so a score
  such as *21-19 21-17* or a time is allowed and *012-345 6789* is not.
- **Never more than the context shows.** A conversation shows senders as the context
  does: a first name, or *Guardian of …*, or *Team name (captain)*.

## Limits (published, deterministic)

| Limit | Value |
| ----- | ----- |
| Messages one person sends | 30 an hour, 150 a day |
| Into one conversation | 20 an hour |
| New conversations one person begins (by their first message) | 5 a day |
| Notification emails to one person | 5 a day; one digest per conversation per period (6 hours, `MESSAGE_DIGEST_HOURS`); urgent safeguarding notices are not held to it |
| A minor's seat in a youth group (`YOUTH_LIMITS`) | 300 characters; 12 messages an hour; 40 a day; none between 22:00 and 07:00 (`YOUTH_QUIET_HOURS`) |
| Reports one person makes | 10 a day |
| Frozen with a report | the last 20 messages the reporter could see (50 in a youth group's thread) |
| A conversation ended | read-only 14 days, then closed |
| Retention | 90 days after the context ended (`MESSAGE_RETENTION_DAYS`); a dealt-with report in an adults' conversation 365 days (`MESSAGE_REPORT_RETENTION_DAYS`; a report in a youth thread has **no period**: [evidence](../architecture/privacy.md#youth-messaging-evidence)); a youth group's conversation 60 days after the group ended (`YOUTH_MESSAGE_RETENTION_DAYS`) and the words of a removed message 30 days (`YOUTH_REMOVED_RETENTION_DAYS`), **operational defaults pending legal approval, never while a case is active in the group** |

The constants are in `src/lib/message-limits.ts`. A refused message is a refusal with a
code and a sentence in all four languages; none of the limits learns or changes by
itself. The routes are also held to an address-level rate limit (`messageRead`,
`messageWrite`).

## Telling people: a digest, never the message

A person who can read a new message is emailed **how many new messages they have, and where**
("You have 3 new messages in *Padel game, Sat 14 Nov, Bangsar Courts*"), with a link into the
signed-in app (`/messages?open=game:12`). **The email, and the outbox row behind it, never
contain the message** (nor the sender). It is a kind of its own in the
[outbox](../integrations/messaging.md) (`player_message`), by email only, **never
WhatsApp**, written in the person's language. It is a **digest**
(`src/lib/message-digest.ts`; [ADR 0044](../architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md)):

- **By default one email per person per conversation per period**, six hours
  (`MESSAGE_DIGEST_HOURS`, a whole number from 1 to 24), **sent by the scheduler** (the outbox
  tick) **once the period in which a message arrived is over, if it is still unread.** Periods
  are fixed slots of the clock (UTC); a notice records the newest message it covered, so the
  scheduler never tells the same person about the same messages twice, however often it runs
  and on however many servers.
- **Each person chooses** *at once* (an email as the message is written, within the daily
  limit), *a digest* (the default), or *daily*, in their messaging settings on the Messages
  page; or no emails at all. **For a minor, the guardian's choice governs** (including *not at
  all*), whatever the child chose.
- Nothing is sent for messages already read, to the writer, to somebody who muted the context
  or turned the emails off, or to somebody a block keeps the message from. At most **5 notices
  a day** a person.
- **Urgent safety and moderation events are never digested and not held to that daily limit**:
  a report in a youth group's thread, a conversation closed, messaging paused for somebody, a
  guardian's consent changed, a supervisor muting a child or removing their message. They are
  a kind of their own, `safeguarding_notice` (email only, uncapped like a team decision), and
  carry no message text either.

Nothing of a message's text is written to a log, the activity log, an error report or the
outbox.

## Blocking and reporting

- **Block.** A person blocks whoever wrote a message they can read (`POST
  /api/messages/:kind/:id/block`): the same block as everywhere in
  [matchmaking](matchmaking.md#blocking-and-reporting) (`player_blocks`), extended so it can
  be made from a conversation in any context (a teammate or an opponent as well as somebody
  from a game or group). **Nothing a blocked person writes is delivered, and nothing the
  blocker writes reaches them; neither is told.** The message is accepted and kept for its
  writer; it is simply not shown to the other. Blocking someone leaves them in the team,
  game or group (that is the organiser's to change).
- **Report.** A person reports a message they can read, not their own, with a reason
  (abuse or harassment, spam or selling, asking for or sharing contact details, "I feel
  unsafe", other) and a note. **The report freezes a copy of the thread's last 20
  messages as the reporter saw them**, the reported one marked, so staff read what was
  reported even if the thread is muted, closed or later deleted. The same message reported
  again is the same report. A report can be made by a person who has since turned
  messaging off.
- **Repeated reports.** When **3 different people** have reported the same person
  within **30 days** (a report found to need no action does not count), **their messaging
  is suspended everywhere automatically**, pending the platform owner's review (published
  rule; no learning, no scoring). The reporter is not told whether it did. What makes that
  review possible is [below](#every-report-is-told-and-an-automatic-suspension-can-be-reviewed).

## Moderation

Nobody on staff reads an ordinary message: there is no screen of threads and no route to
one (**the one exception is a [supervised youth group's](#supervised-youth-groups) thread**,
read for safeguarding, managers only, each reading recorded). Staff see **reports**, with the frozen copy (`GET /api/admin/message-moderation`,
the *Reports of messages between players* panel on the dashboard, managers and the owner;
front desk is turned away).

- **Who sees which reports.** A venue's manager sees the reports of conversations that
  **belong to the venue**: its games, its tournaments, leagues and ladders, and the
  teams that play from it (and team-league fixtures of its leagues). The **platform owner
  sees the reports of conversations with no venue** (a community group; a team with no
  venue) and the platform-wide suspensions. The venue of a conversation is fixed when it
  begins; a venue never sees another's, and the owner does not read a venue's, except the reports behind
  an automatic suspension in force ([below](#every-report-is-told-and-an-automatic-suspension-can-be-reviewed)).
- **What they may do** (each logged in the [activity log](reporting.md) by number and the
  reason given, never any message text): mark a report dealt with (nothing needed, or action
  taken); **mute a conversation** (nobody may write; a manager can open it again) or **close
  it for good**; **suspend a person's messaging**, with a reason: a venue only for its own
  conversations and only with a report in its scope about that person in hand (so an
  account number alone never acts on a stranger), the owner everywhere; **lift** a
  suspension, with a reason (a venue its own; the owner platform-wide ones); and, for the
  owner, **confirm** an automatic suspension as their own decision. A suspended person can
  still read, cannot write where the suspension applies, and is told so: on the screen, and at
  once by email (a `safeguarding_notice`, with their guardians if they are a minor), **except an
  adult suspended because of a report in a youth thread, who is told nothing by the system**
  ([a reported adult is not told](#a-reported-adult-is-not-told)).
### Every report is told, and an automatic suspension can be reviewed

*(ADR 0059; the operational design, with no legal conclusion: how long a report may wait, what must be
done about one, and any right to a review or to be told are for the operator and its legal adviser.)*

- **A report in any ordinary conversation is told when it is made** (`src/lib/message-alerts.ts`): to
  the managers of the conversation's venue, or to the platform's owners where it has none (a community
  group, a team that plays from no venue). It says that a message in a conversation they are responsible
  for was reported, how many reports are open there, and where to read it: **never any message text, never who
  reported or who was reported, never why**. It is the same alert whatever the reporter chose as the reason
  or wrote in the note (a report that says someone feels unsafe is not read from its text and not worded
  differently), once per report (keyed by it), through the outbox (a mail server that is down delays it).
  A member of staff who is the person reported is not among those told. (A report in a supervised youth
  group's thread is the urgent case it was.) The dashboard's needs-attention panel adds a line: how many
  reports are open in your scope and how long the oldest has waited (`messageModeration` on `GET
  /api/admin/attention`; managers and the owner, not front desk).
- **An automatic suspension is told when it is made**, to the owners and to the managers of the venue
  whose report completed the count, with the date it is to be reviewed by (14 days, `autoSuspendReviewDays`,
  operational and not a legal period: passing it lifts nothing by itself and turns the line red).
- **Whoever is asked to review it can read what they review.** The owner reads the reports behind an
  automatic suspension in force, a venue's included (not a youth thread's, which are cases of their own); the
  suspensions list carries the numbers of the reports behind each. Otherwise the owner still reads no venue's reports.
- **A venue's manager deals with one that rests on that venue's reports alone**: they see it, lift it with a
  reason, or answer a request for a review of it. A suspension is platform-wide, so one that rests on
  another venue's reports, or on a conversation with no venue, stays the owner's alone.
- **It does not outlive its reports.** When a report is found to need no action, the count is made again, and an
  automatic suspension is **lifted** if fewer than the rule's three different people's reports are left to count (who
  dismissed the report and why are in the activity log, `messages.suspension_lifted`). A suspension the owner
  confirmed as a decision of their own, or one staff made, is not touched.
- **The suspended person can ask for a review** (`POST /api/messages/suspension-review`; `GET` says where it
  stands), from the line that says their messages are paused: one short text, optional, once while one is open. It is the
  same neutral route as a restriction in a youth group (ADR 0052): nothing of any report is shown or asked; it
  goes to somebody who may lift it, who lifts it or answers that it stands (`keep`), with a reason, **by somebody
  who did not apply it**; the person sees only that it was received and, when decided, *lifted* or *stands* in
  neutral words. A person who is not suspended gets the answer a stranger would (not found). The people who may decide are told
  one is waiting (that and where only). **No legal right to a review or to notification is promised.**

- **A report in a youth group's thread is a case.** Its copy is not in the list: it is read one
  report at a time, each reading recorded, and the report has its own steps (confirm, extend or lift
  the protective restriction, escalate, note, notify the reported adult in the moderator's own words)
  and a third review outcome, *restriction continues*
  ([a reported adult is not told](#a-reported-adult-is-not-told)).

## Supervised youth groups

*An advanced setting of a community group, never part of anybody's setup.* The owner's
decision of 5 November 2026: allow **supervised group messaging for eligible minors, never
private messaging**, with moderation, reporting, guardian controls and safeguarding measures
([ADR 0044](../architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md)).
Ages, guardianship, consent and roles are everybody's own word: recorded as declared, never
verified, and no identity document is collected. Only **community groups** can be youth
groups (teams, matches, ladders and fixtures are not: see the ADR).

**Youth messaging is off in production** unless the install sets `YOUTH_MESSAGING_LAUNCH_APPROVED=yes` (on in development and
tests): until the owner has the legal advice and safeguarding requirements in [the legal-review
checklist](../operations/legal-review-youth-messaging.md), no group can be marked a youth group, no minor has a seat, no youth
thread is read or written, and everybody who meets it is told plainly *Youth messaging is not enabled on this install: it needs
safeguarding and legal approval first*. Adults' messaging is unaffected. See [the interim
safeguards](#interim-safeguards-pending-legal-review) ([ADR 0052](../architecture/decisions/0052-youth-messaging-interim-safeguards-pending-legal-review.md)).

**Who is an eligible minor.** An account that has not declared it is 18 or over, that is a
member of a youth group, and has **all three** of: its **own opt-in** for that group; a
**guardian's consent** for that child and that group (a live guardian of the participant
whose own login the account is: [participants](activities.md#applying-for-somebody-you-manage);
default **off**, explicit, revocable, per child and per group); and the group **marked**.
Read live on every call: revoking any of them, the guardian's relationship ending, the child
leaving, or the group ceasing to be a youth group takes effect **at once**, even for a
message being written (the consent rows are locked `FOR SHARE` while a message posts).

**Never private.**

- A minor's seat exists only in a youth group's shared thread. No one-to-one thread can
  include a minor, adult-to-minor or minor-to-minor: there is no thread any minor can start
  (a **supervisor starts** it), no "reply privately", no route that names a person.
- The conversation **opens only while at least three people who can read it are there, a
  supervisor among them**; a supervisor and one child is refused for both (`PM_YOUTH_FEW`).
- **The database refuses** a message from anybody not declared 18 or over outside a youth
  group's thread (a trigger, migration 0286).

**Supervision.**

- The **organiser** (a declared adult) marks the group (*Supervised youth group (advanced)*
  on the group's page) and is its first supervisor. They may let other adult members into the
  thread **as a supervisor or an adult, with a declared role** (organiser, coach, venue staff,
  volunteer, parent, other), recorded and **shown to the guardians**. **An adult member who was
  not let in has no seat**: an adult is never added without supervisor action. What was written
  in the group's thread before it was marked is never shown in it.
- A **supervisor** is a member of the thread, **reads everything** (a block does not hide a
  message from a supervisor; nobody blocks a supervisor here: report instead), and can
  **remove a message**, **pause (mute) a member** (they read, they cannot write), **pause
  and reopen the conversation**, and **close it for good**, each with a reason kept in the group's
  own record (by message number, never the text). Anybody else gets `403 YG_SUPERVISOR`.
- **A venue may look after a group**: the organiser *asks* a venue, its **manager accepts or
  declines** (*Supervised youth groups* on the dashboard, shown only where a group has asked,
  managers and the owner only). Until it accepts, and for a group that asks no venue, the
  **platform's owner** moderates. Only an accepted venue's reports and thread are the venue's.
- **A deliberate exception to "nobody on staff reads an ordinary message":** managers of the
  accepted venue (the owner, for a group with no venue) can **read a youth group's thread** for
  moderation and safeguarding review, and only that. **Each reading is written to the staff
  activity log and to the group's own record.** Adults' ordinary threads stay unreadable to
  staff. The first-use screen tells members a supervisor can read the group's messages and that
  a venue's managers may.
- **Ending a youth group** (the organiser, or its venue's manager, or the owner) closes its
  thread **for good**; it never becomes an ordinary conversation, and the supervisors and the
  minors' guardians are told at once.

**What a minor's messages are.** Text only and shorter (300 characters, 12 an hour, 40 a
day). **Rest hours: none between 22:00 and 07:00** in the group's venue's time zone (the
install's for a group with no venue; `YOUTH_QUIET_HOURS`, default on, read on the zone's own
clock either side of a daylight-saving change). The organiser may **lengthen** the group's hours,
**never shorten** the install's; *off* is the install operator's to choose and is not reachable
from a venue, an organiser or a guardian. In a youth thread, for **everybody**, besides a phone
number or an email address, a **social handle** (`@name`), the **name of a chat or social
service**, a **link or web address**, and **"DM me" / "add me on" / "my number is"** are
refused (`PM_CONTACT`): a speed bump, not a guarantee, and nothing understands what a message
means. A **Report** button is on every message from somebody else.

**Reports are urgent here, and a case.** Every report in a youth thread (by or about a minor, or an adult):

- is **told at once** to the live guardians of a minor who reported or was reported (that a
  report was made, never its content) and to **safeguarding personnel only**: the venue's managers
  (the platform's owners where there is no venue), as a `safeguarding_notice` (email, never the
  text). **Not the supervisors, and never the person reported** ([below](#a-reported-adult-is-not-told));
- freezes **the last 50 messages**, not 20, held as evidence;
- **restricts the reported person in that thread** at once: a minor can read and cannot write; an
  adult is paused entirely ([below](#a-reported-adult-is-not-told)). A review that found nothing
  needed lifts it; one that took action, or that says *restriction continues*, keeps it until
  safeguarding personnel lift it (a supervisor cannot lift a hold a report placed). The report
  shows as *Urgent* to staff.


**Guardian controls** (on the account page, under *People you manage*, shown only to a guardian
of a child with a login linked who is in a youth group): see which groups messaging is on in,
who supervises and which adults were let in; **switch it on or off per group, or off for the
child everywhere at once** (effective at once; see *Guardians in conflict* below); **read the child's group thread,
read-only**, labelled *as the guardian of {child}*, other children by their short names, each
read recorded; **block people for the child** (never a supervisor); **choose the notice
frequency** for the child; **receive** the child's report and moderation notices; and **export**
the child's group messages in *Download my data*.

**A child's first-use screen** is short and plain (English, Malay, Chinese, Tamil): what the
group conversation is, who can read it, the rules, how to report, and that their guardian
switches it on. A child with no linked guardian is told one is needed.

**Kept, exported, erased.** A youth group's conversation is deleted **60 days after its group
ended** (`YOUTH_MESSAGE_RETENTION_DAYS`), the words of a removed message **30 days after**
(`YOUTH_REMOVED_RETENTION_DAYS`); both are in the retention list. The child's and the guardian's
*Download my data* hold their opt-ins, consents, roles, pauses and the children's group messages;
a child's account erased turns what they wrote into *message removed*, as for adults.

**Defaults, overrides, restrictions.**

| Setting | Default | Who can change it | Never |
| ------- | ------- | ----------------- | ----- |
| A group is a youth group | No | The organiser (a declared adult) | A venue, on its own |
| A guardian's consent | **Off** | A live guardian who decides, per child and group; with no objection one is enough; any guardian's off opens an objection that all who decide must end, or an administrator resolves | The child, the organiser, a venue on its own; another guardian reversing an objection alone |
| What a guardian may do about messaging | `decides` (every existing link), status `asserted` | A recorded decision ([below](#custody-and-authority-a-recorded-decision)): a restriction takes effect only when **verified** by the owner or the manager of the venue that manages the child | A guardian for themselves; a supervisor; a member of staff who is the child's guardian |
| A reported adult's access | Restricted at once, as a **protective** hold with a date to be reviewed by | Safeguarding personnel: confirm, extend, lift, convert to a decision, escalate; no automatic notice, ever; the restricted adult may ask for a review | The reported adult or staff who is the same person seeing or lifting it; a clock lifting or converting it |
| The child's opt-in | Off | The child | A guardian, for them |
| Adults in the thread | Only the organiser | The organiser, with a declared role; staff may take one out | Letting an adult in without a supervisor |
| Rest hours | 22:00 to 07:00 | The install (`YOUTH_QUIET_HOURS`); a group may lengthen | A venue, an organiser or a guardian shortening or removing them |
| Limits for a minor, the text check | As above | Fixed constants (`YOUTH_LIMITS`) | Learned or changed by itself |
| Staff reading the thread | A managers-only exception, each reading recorded | Nobody: it needs a venue the organiser asked and a manager accepted, or the owner | Front desk; a venue that was not asked |
| Notice frequency | A digest (6 hours) | The person; for a minor, the guardian | Turning off urgent safeguarding notices |

**Awaiting legal and professional review (not settled in code):** the wording of the first-use
screen and the notices; whether a guardian's consent recorded this way suffices in a given
country; the staff-read exception and its lawful basis; the retention periods and the rest
hours; and every item of [the legal-review checklist](../operations/legal-review-youth-messaging.md).
All wording outside English is machine-assisted and awaits native review.

### Guardians in conflict

*Decided 5 November 2026; [ADR 0049](../architecture/decisions/0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md),
which amends ADR 0044 (it replaces "any live guardian's off ends consent, any can switch it back on").*

- **Authority is recorded per guardian link, not assumed equal.** What a guardian may do about the child's
  messaging is **`decides`** (every link that exists; may agree and object), **`objects_only`** (may
  switch it off, never on, and never counts towards restoring it) or **`none`** (no say at all: refused
  everywhere, shown nothing, told nothing, given none of the child's group messages in an export). **It is
  now the result of [a recorded decision](#custody-and-authority-a-recorded-decision):** a restriction takes
  effect only when an authorised operator has *verified* it; an asserted one makes the link *unclear* and
  keeps messaging for the child off. No documents and no identity numbers are kept. Never done by a member
  of staff who is a guardian of that child.
- **An objection.** A guardian at `decides` or `objects_only` switching messaging off ends every
  consent and opens an objection. **While it is open no consent counts**: another guardian switching
  it on records their consent and cannot reverse it. It ends when **every guardian who decides has
  agreed again** (the objector's own switching on is their withdrawal), or when a **safeguarding
  administrator** (the venue's manager for a venue's group, the owner for a venue-less group; never the
  child's supervisor or a guardian of the child) **resolves it with a reason**, which does not switch
  messaging on: a guardian who decides still has to consent. With no objection one guardian's consent
  is enough, as before.
- **Races.** Everything for one child and group serialises on one lock, the guardian's level and
  relationship read inside it: two guardians changing consent at the same moment end consistently,
  and **an "on" never wins over a concurrent "off"** in either order of commit.
- **Minimal disclosure.** The other guardians are told only *"messaging for {child} in {group} is off
  and needs agreement from all guardians who decide"*; the child, supervisors, the group and venue staff
  who are not safeguarding administrators see only that messaging is unavailable. Who objected, at what
  level, and each guardian's recorded level and note are shown to safeguarding administrators only
  (*Guardians and holds on messaging* on the group's row of *Supervised youth groups*, each reading
  recorded) and are in the group's record: who, what, when and the level at the time, never a narrative.

### A reported adult is not told

*Decided 5 November 2026; [ADR 0049](../architecture/decisions/0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md),
which amends ADR 0044. The restriction is **protective and is not a finding of fault**: it assumes
nothing about the person, and puts the child's safety first.*

- **No notice of a report goes to the reported adult, by any channel**: email, outbox, the thread,
  the lists, counts and unread badges, the digest, the notification, attention and activity feeds,
  the staff panels, error messages and HTTP statuses. What they see, **whatever the reason** (a
  report or a supervisor's pause, so the one cannot be used to infer the other), is one line in the
  conversation's place, `403 PM_ACCESS_PAUSED`: *Your access to this conversation is paused while
  the venue reviews it. This is not a finding.* No messages, no count, no thread number, no
  supervisors. They cannot report or block (`404 PM_NOT_FOUND`), and are in nobody's list of
  readers.
- **A reported supervisor or organiser loses those powers while the restriction stands** (they get
  the answer a stranger gets, `404 YG_NOT_FOUND`, for the group's youth settings and `403
  YG_SUPERVISOR` for a supervisor's tools), and is not shown as supervising. A conversation left with
  no supervisor waits for one (`PM_YOUTH_FEW`).
- **Who is told:** safeguarding personnel (the venue's managers, or the owner for a group with no
  venue) and the guardians of a minor who reported or was reported. **Conflict-of-interest guard:** a
  member of staff who is the same person as the one reported (the same account, or a staff login with
  the same email) is left out of every audience and the report **is not here for them** (the same `404`
  as for anything that does not exist, in the reports list, the case, every action, the group's staff
  list, reading and safeguarding screens, the thread's state, the suspensions list); their moderating powers over the group are
  suspended while it stands; the platform's owners are told instead and the report is escalated to
  them. The reporting minor's identity is shown only to safeguarding personnel; the reporter's
  guardians are told that a report was made, not its content.
- **Evidence:** the frozen copy is **not in any list**; safeguarding personnel read it one report at
  a time (`?report=<id>`), **each reading recorded** in the case's own audit
  (`youth_report_actions`, not the staff activity log, which a reported member of staff can read).
  It is **held** while the report is open or the restriction it placed is in force, or a [legal
  hold](#evidence-retention-and-legal-holds) covers it, and is not cleared by the reported person's
  erasure while held; it is never in anybody's own *Download my data* (the reported person's export
  counts no report about them in a youth thread and shows a pause with no source). Erasure is never
  refused for it. **No period is set for how long it is then kept** ([evidence](#evidence-retention-and-legal-holds)).
- **The case** (`/api/admin/message-moderation`, `action: "case"`): **confirm**, **extend** (put the
  restriction back in force and keep it past the report's review) or **lift** it, each with a reason;
  **escalate** to the platform's owner (recorded; the owner is told and sees the report); add a
  **note**; and **notify the reported adult** in the moderator's own words, **the only way they are
  ever told** (never automatic; for an adult only; refused if it names the reporter or repeats the
  reported words). The review outcomes are *nothing needed (restriction lifted)*, *restriction
  continues* and *action taken*. Every step is recorded with who, what, when and why, never a
  message's text. The staff screen says the restriction is protective and not a finding.
- **Automatic suspension** (three different people's reports in thirty days) brought about by
  youth-thread reports says *paused pending review* and is not told to a reported adult.
- **Adult-on-adult reports** in a youth thread are treated the same. **Reports in an ordinary (adults')
  thread are unchanged.**

## Interim safeguards, pending legal review

*The owner approved an interim product and safety direction, **subject to review by qualified Malaysian legal and
child-safeguarding professionals before live youth messaging is enabled** ([ADR
0052](../architecture/decisions/0052-youth-messaging-interim-safeguards-pending-legal-review.md); migration 0294).
Nothing in this section settles a legal question or claims compliance: every period is operational, every standard is
labelled pending legal review, and the questions are in [the checklist for a lawyer](../operations/legal-review-youth-messaging.md).
No custody order, identity number or other document is collected, and nothing is reported to any authority by MySenam.*

### The launch switch

`youthMessagingEnabled()` (`src/lib/youth-launch.ts`) is **false in production unless
`YOUTH_MESSAGING_LAUNCH_APPROVED=yes`**, on in development and tests. Off: a group cannot be marked (`YG_OFF`), a minor has no
seat (`youthSeats` is empty), nothing is read or written in a youth thread (a guardian's read-only view included), and the
child's first-use screen, the guardian's page, the organiser's group panel and the staff youth panel say *Youth messaging is not
enabled on this install: it needs safeguarding and legal approval first*. A guardian can still switch it **off**, never on.
**Adults' messaging is unaffected.** Stored data is kept and shown to nobody except safeguarding administrators for an **open case**
(a report open or its restriction in force, an authority review or a request for a review open, or a legal hold); the staff panel
counts the rest as *stored and shown nowhere*. Turning it on is the owner's deliberate decision after the [launch
gate](../operations/legal-review-youth-messaging.md#launch-gate) (a row of the [launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)).

### Custody and authority: a recorded decision

Per guardian link a safeguarding administrator records (*Guardians and holds on messaging*, `POST /api/admin/youth-groups`
`action: "authority"`):

| Field | Values | Meaning |
| ----- | ------ | ------- |
| **Status** | `asserted` (the default), `verified`, `disputed`, `unclear` | `asserted` is only what the guardian or the venue declared when the link was made, **not a legal determination**; `verified` is a verified decision recorded by an authorised operator |
| **Basis** | `parent`, `legal_guardian`, `other_authorised`, `not_stated` | A fixed short list: no documents, no narrative |
| **What it removes** | `none`, `may_object_only`, `no_messaging_say` | The guardian's say; it takes effect (as `decides` / `objects_only` / `none`) **only on a verified decision** |
| **Standard, who, when** | `interim: pending legal review`, the operator, the time | Stored with the decision; the note is the existing short text (a run of digits is refused) |

- **An asserted restriction does not take effect:** it sets the link to `unclear` and the guardian keeps their say.
- **`disputed` or `unclear` on any live guardian link of the child keeps youth messaging for that child off, whatever consents exist**,
  until reviewed. **A disputed or unclear guardian can still switch it off** (their objection counts). The other guardians are told only
  *off, and needs agreement*.
- **Authorised operators (interim; who may verify is pending legal review):** the platform's owner, or a venue's manager for a child
  the venue manages. A venue that only looks after a group the child is in may mark a link disputed or unclear, never verify it or clear
  it (`YG_VERIFY`). **Never a supervisor of the child's groups, a guardian of the child, or staff who are the same person as either.**
  Every decision is audited (who, status, basis, restrictions, the standard label, when) in the group's record, visible to safeguarding
  administrators only, and in the staff activity log.
- **MySenam does not interpret custody orders or make legal determinations.** It applies the operator's recorded decision; the supporting
  record, if any, is held by the venue under its own controls. The screens say so.
- **Authority review.** One open per child and group (`youth_authority_reviews`), opened when a link becomes disputed or unclear, or a
  guardian conflict stays unresolved beyond `YOUTH_REVIEW_DAYS` (7: operational, **not a legal period**), and again after that interval if a
  review ended *remains unclear*. For safeguarding administrators only (*Authority reviews* in the youth panel; the needs-attention line);
  actions: record a verified decision, **mark resolved** (refused while messaging is still held off), **remains unclear**, or **escalate to the
  platform's owner**, each with a reason where it needs one.

### A restriction on an adult is protective, or a decision

- **Protective** (the default a report places at once) is **temporary and not a finding**. A moderator may **convert it to a decision**
  (`removed from this group's conversation` or `messaging suspended`) with a recorded reason (`case` step `decide`, for a reported adult
  only). Staff screens word them differently; the restricted adult's neutral line is *paused while the venue reviews it, this is not a
  finding* for a protective hold (the same as a supervisor's pause) and *changed following a review by the venue* for a decision; neither
  says why. Nothing, anywhere, presents an allegation as proven.
- **No indefinite unreviewed restriction.** A protective restriction has a date to be reviewed by (`YOUTH_PROTECTIVE_REVIEW_DAYS`, 7:
  operational, **not a legal period**). Past it unreviewed, the platform's owners get a needs-attention line and a safeguarding email,
  repeated at that interval, and the restriction is **never lifted or converted automatically**. A moderator's review (*continue* with a reason,
  *extend*, *lift*, or *convert*) starts it again. The case shows its age and review state.
- **Ask for a review.** On the neutral line the restricted adult (for any cause: the same line) can **ask for a review** with one short text;
  nothing of any report is shown or asked (`POST /api/messages/youth/review`). It opens an item for a reviewer **other than whoever applied the
  restriction** (a different manager of the venue, else the platform's owner), who **lifts** it or **lets it continue**, with a reason, recorded in
  the case and the group's record; the adult is told only that it was received and, when decided, the outcome in neutral words (a moderator may add
  a few words, never naming the reporter or repeating what was reported). **Rights to review and notification are pending legal review**: this
  promises no legal right.
- **Escalate (safeguarding).** A case step with a fixed reason (`suspected_abuse`, `imminent_danger`, `possible_reportable_incident`, `other`):
  the platform's owner is told **at once**, who, when and why are recorded in the case, and the case shows a **static guidance panel**: *If a child
  is in immediate danger, contact the emergency services (999) now. Whether and how an incident must be reported to the authorities is pending legal
  review; follow your own safeguarding policy.* **Nothing is sent to any authority by MySenam**, and no statutory body or contact is named.
- **The reporter stays unknown**: no review item, escalation notice, owner email, needs-attention line or outcome notice shows who reported or what
  was said (tested across them).

### Evidence, retention and legal holds

Four classes, kept apart ([privacy](../architecture/privacy.md#youth-messaging-evidence) has the table): (a) ordinary message retention (the operational
defaults, **pending legal approval**, and never while a case is active in the group); (b) **safeguarding evidence** (the frozen copy, case actions,
escalations, review items) and (c) **audit records** (the group's event store, the activity entries about youth messaging): **no period is invented, and neither
is ever deleted automatically**; (d) records under a **legal hold**.

- A deletion period for **closed cases** applies only if the install sets `SAFEGUARDING_EVIDENCE_RETENTION_DAYS` (*requires legal approval before setting*);
  unset, everything is kept and the platform's owners are asked, now and then, to **decide** about what has been kept longer than
  `SAFEGUARDING_REVIEW_MONTHS` (12): a decision to keep, never a deletion.
- **Legal holds** (`youth_evidence_holds`): the platform's owner only creates, reviews and releases one, on a case or on a child and group, with a reason,
  an external reference in words (digit runs refused) and an optional review date. A hold keeps the covered evidence copy and conversation from retention and
  erasure; an erasure of the person's account is **never refused**, and the held copy stays with its access restricted to safeguarding personnel. Audited in
  the case and the group's record and in the activity log without a venue. *Legal preservation requirements are pending legal review.*
- Access is only safeguarding personnel (the conflict guard), every reading recorded, and the actions are append-only (the database refuses an edit).

## Where to find it

- **The Messages page** (`/messages`): the first screen, then conversations grouped by what
  they belong to (games, teams and fixtures, groups, matches) with unread counts in words,
  newest first; phones first; keyboard and screen-reader friendly (labelled fields, a
  polite live region announcing new messages, focus never taken); new messages arrive by
  **polling** every 15 seconds while the tab is visible (no websockets).
- **Entry points**: a link on the game card (host and accepted players), the team page,
  the group page, a ladder challenge, a box-league match, a tournament match the person
  (or the child they act for) is in, and a team-league fixture its captain is in; any
  conversation is also reached from the Messages page and from the email.
- Customer text is in English, Malay, Chinese and Tamil; staff text in English, Malay and
  Chinese. Machine-assisted wording awaits native review.

## Not here

- No messages to a stranger, to an address, or from a search; no directory; no group
  chat made by a person; no attachments, images, voice or video; no read receipts; no
  typing indicators; no WhatsApp or SMS; no push; no websockets.
- A player who says they are under 18 has no messaging **outside a supervised youth group**,
  and inside one only with all three consents ([above](#supervised-youth-groups)). No private
  messaging for a minor, by any route; no teams, matches, ladders or fixtures with a minor's own
  seat.
- No machine learning, no content scanning beyond the pattern check (phone, email, and in a youth
  thread handles, services, links), no venue reading of ordinary messages (a supervised youth
  group's thread is the one exception).
- Messages are not in the venue's API, the MCP tools, the public pages or any report or export a
  venue can download; only in the person's own *Download my data*.

## Implementation and tests

| Part | Code | Tests |
| ---- | ---- | ----- |
| Contexts and who is in each | `src/lib/message-contexts.ts` | `tests/player-messages.test.ts`, `tests/player-messages-contexts.test.ts` |
| Settings, sending, reading, limits, notices, block, report, automatic suspension | `src/lib/messages.ts`, `src/lib/message-limits.ts`, `src/lib/message-titles.ts`, `db/migrations/0280_player_messages.sql` | `tests/player-messages.test.ts`, `tests/player-messages-contexts.test.ts`, `tests/player-messages-safety.test.ts` (races on Postgres) |
| Moderation | `src/lib/message-moderation.ts`, `src/app/api/admin/message-moderation/route.ts`, `src/components/admin/MessageReportsPanel.tsx` | `tests/player-messages-safety.test.ts`, `tests/components/player-messages.test.tsx` |
| Every report told; an automatic suspension reviewed: the owner reads its reports, a venue lifts one resting on its own, it ends with its reports, the person asks for a review, the dashboard lines | `src/lib/message-alerts.ts`, `src/lib/suspension-reviews.ts`, `src/lib/message-moderation.ts`, `src/lib/messages.ts`, `src/app/api/messages/suspension-review/route.ts`, `src/app/messages/Thread.tsx`, `src/app/api/admin/attention/route.ts`, `src/components/admin/AttentionPanel.tsx`, `db/migrations/0305_message_suspension_review.sql` | `tests/message-suspension-review.test.ts` (PGlite and Postgres) |
| Export, erasure, retention | `src/lib/message-privacy.ts`, `src/lib/privacy.ts` | `tests/player-messages-safety.test.ts`, `tests/youth-messages.test.ts` |
| The player's routes and pages | `src/app/api/messages/`, `src/app/messages/`, `src/components/MessagesLink.tsx` | `tests/player-messages-safety.test.ts`, `tests/components/player-messages.test.tsx` |
| Guardians in conflict: authority per link, objections, restoring, races (ADR 0049) | `src/lib/youth-consent.ts`, `src/lib/youth-messages.ts`, `src/lib/youth-safeguarding.ts`, `src/components/GuardianMessaging.tsx`, `src/components/admin/YouthGroupsPanel.tsx`, `db/migrations/0291_guardians_in_conflict_and_reported_adults.sql` | `tests/youth-guardian-conflict.test.ts` (races, both engines) |
| A reported adult is not told: the restriction, the conflict guard, the case, the evidence (ADR 0049) | `src/lib/youth-report-cases.ts`, `src/lib/safeguarding-conflict.ts`, `src/lib/messages.ts`, `src/lib/message-moderation.ts`, `src/lib/message-privacy.ts`, `src/lib/message-digest.ts`, `src/components/admin/MessageReportsPanel.tsx` | `tests/youth-reported-adult.test.ts` |
| Supervised youth groups: eligibility, supervision, guardian controls, rest hours, limits | `src/lib/youth-messages.ts`, `src/lib/message-contexts.ts`, `src/lib/messages.ts`, `db/migrations/0286_supervised_youth_group_messaging.sql`, `src/app/api/messages/youth/`, `src/app/api/groups/[id]/youth/`, `src/app/api/my/people/messaging/`, `src/components/YouthGroupPanel.tsx`, `src/components/GuardianMessaging.tsx`, `src/app/messages/YouthFirstUse.tsx` | `tests/youth-messages.test.ts`, `tests/youth-messages-races.test.ts` (races, both engines) |
| Urgent notices, the venue's reading (audited), reports | `src/lib/youth-safeguarding.ts`, `src/lib/message-moderation.ts`, `src/app/api/admin/youth-groups/route.ts`, `src/components/admin/YouthGroupsPanel.tsx` | `tests/youth-safeguarding.test.ts` |
| Interim safeguards: the launch switch, recorded custody decisions, authority reviews (ADR 0052) | `src/lib/youth-launch.ts`, `src/lib/youth-authority.ts`, `src/lib/youth-consent.ts`, `src/lib/youth-safeguarding.ts`, `src/lib/youth-messages.ts`, `db/migrations/0294_youth_messaging_interim_safeguards.sql`, `src/components/admin/YouthSafeguardingExtras.tsx` | `tests/youth-interim-safeguards.test.ts`, `tests/components/youth-messages.test.tsx` |
| Interim safeguards: protective or decided restrictions, review dates, requests for a review, escalation (ADR 0052) | `src/lib/youth-report-cases.ts`, `src/lib/youth-restrictions.ts`, `src/lib/messages.ts`, `src/app/api/messages/youth/review/route.ts`, `src/app/messages/Thread.tsx`, `src/components/admin/MessageReportsPanel.tsx` | `tests/youth-restrictions-evidence.test.ts` (races on both engines), `tests/components/youth-messages.test.tsx` |
| Interim safeguards: evidence classes, retention, legal holds, the review prompt (ADR 0052) | `src/lib/youth-evidence.ts`, `src/lib/youth-evidence-sql.ts`, `src/lib/message-privacy.ts`, `src/lib/privacy.ts` | `tests/youth-restrictions-evidence.test.ts` |
| The digest | `src/lib/message-digest.ts`, `src/lib/notify.ts` (`tickOutbox`) | `tests/message-digest.test.ts`, `tests/player-messages-contexts.test.ts` |
