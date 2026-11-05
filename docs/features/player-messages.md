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
| Retention | 90 days after the context ended (`MESSAGE_RETENTION_DAYS`); a dealt-with report 365 days (`MESSAGE_REPORT_RETENTION_DAYS`); a youth group's conversation 60 days after the group ended (`YOUTH_MESSAGE_RETENTION_DAYS`) and the words of a removed message 30 days (`YOUTH_REMOVED_RETENTION_DAYS`) |

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
  rule; no learning, no scoring). The reporter is not told whether it did.

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
  begins; a venue never sees another's, and the owner does not read a venue's.
- **What they may do** (each logged in the [activity log](reporting.md) by number and the
  reason given, never any message text): mark a report dealt with (nothing needed, or action
  taken); **mute a conversation** (nobody may write; a manager can open it again) or **close
  it for good**; **suspend a person's messaging**, with a reason: a venue only for its own
  conversations and only with a report in its scope about that person in hand (so an
  account number alone never acts on a stranger), the owner everywhere; **lift** a
  suspension, with a reason (a venue its own; the owner platform-wide ones); and, for the
  owner, **confirm** an automatic suspension as their own decision. A suspended person can
  still read, cannot write where the suspension applies, and is told so: on the screen, and at
  once by email (a `safeguarding_notice`, with their guardians if they are a minor).

## Supervised youth groups

*An advanced setting of a community group, never part of anybody's setup.* The owner's
decision of 5 November 2026: allow **supervised group messaging for eligible minors, never
private messaging**, with moderation, reporting, guardian controls and safeguarding measures
([ADR 0044](../architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md)).
Ages, guardianship, consent and roles are everybody's own word: recorded as declared, never
verified, and no identity document is collected. Only **community groups** can be youth
groups (teams, matches, ladders and fixtures are not: see the ADR).

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

**Reports are urgent here.** Every report in a youth thread (by or about a minor, or an adult):

- is **told at once** to the supervisors (not the person reported), the live guardians of a
  minor who reported or was reported, and the venue's managers (the platform's owners where
  there is no venue), as a `safeguarding_notice` (email, never the text);
- freezes **the last 50 messages**, not 20;
- **mutes the reported person in that thread until the report is reviewed**: a review that
  found nothing needed lifts it; one that took action keeps it until staff lift it (a
  supervisor cannot lift a pause a report placed). The report shows as *Urgent* to staff.

**Guardian controls** (on the account page, under *People you manage*, shown only to a guardian
of a child with a login linked who is in a youth group): see which groups messaging is on in,
who supervises and which adults were let in; **switch it on or off per group, or off for the
child everywhere at once** (effective at once; any live guardian's *off* ends every consent for
that child and group, and the other guardians are told); **read the child's group thread,
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
| A guardian's consent | **Off** | A live guardian, per child and group; any live guardian's off wins | The child, the organiser, a venue |
| The child's opt-in | Off | The child | A guardian, for them |
| Adults in the thread | Only the organiser | The organiser, with a declared role; staff may take one out | Letting an adult in without a supervisor |
| Rest hours | 22:00 to 07:00 | The install (`YOUTH_QUIET_HOURS`); a group may lengthen | A venue, an organiser or a guardian shortening or removing them |
| Limits for a minor, the text check | As above | Fixed constants (`YOUTH_LIMITS`) | Learned or changed by itself |
| Staff reading the thread | A managers-only exception, each reading recorded | Nobody: it needs a venue the organiser asked and a manager accepted, or the owner | Front desk; a venue that was not asked |
| Notice frequency | A digest (6 hours) | The person; for a minor, the guardian | Turning off urgent safeguarding notices |

**Awaiting legal and professional review (not settled in code):** the wording of the first-use
screen and the notices; whether a guardian's consent recorded this way suffices in a given
country; the staff-read exception and its lawful basis; the retention periods and the rest
hours. All wording outside English is machine-assisted and awaits native review.

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
| Export, erasure, retention | `src/lib/message-privacy.ts`, `src/lib/privacy.ts` | `tests/player-messages-safety.test.ts`, `tests/youth-messages.test.ts` |
| The player's routes and pages | `src/app/api/messages/`, `src/app/messages/`, `src/components/MessagesLink.tsx` | `tests/player-messages-safety.test.ts`, `tests/components/player-messages.test.tsx` |
| Supervised youth groups: eligibility, supervision, guardian controls, rest hours, limits | `src/lib/youth-messages.ts`, `src/lib/message-contexts.ts`, `src/lib/messages.ts`, `db/migrations/0286_supervised_youth_group_messaging.sql`, `src/app/api/messages/youth/`, `src/app/api/groups/[id]/youth/`, `src/app/api/my/people/messaging/`, `src/components/YouthGroupPanel.tsx`, `src/components/GuardianMessaging.tsx`, `src/app/messages/YouthFirstUse.tsx` | `tests/youth-messages.test.ts`, `tests/youth-messages-races.test.ts` (races, both engines) |
| Urgent notices, the venue's reading (audited), reports | `src/lib/youth-safeguarding.ts`, `src/lib/message-moderation.ts`, `src/app/api/admin/youth-groups/route.ts`, `src/components/admin/YouthGroupsPanel.tsx` | `tests/youth-safeguarding.test.ts` |
| The digest | `src/lib/message-digest.ts`, `src/lib/notify.ts` (`tickOutbox`) | `tests/message-digest.test.ts`, `tests/player-messages-contexts.test.ts` |
