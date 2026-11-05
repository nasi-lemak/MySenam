# Messages between players

Authoritative for what players can write to one another inside MySenam, who may,
where, and what keeps it safe. The decision behind it is
[ADR 0039](../architecture/decisions/0039-messages-between-players.md); the
privacy wording is [privacy](../architecture/privacy.md#messages-between-players);
status is in [feature status](../product/feature-status.md) and planned work in the
[roadmap](../roadmap/roadmap.md).

Players used to have no way to write to each other here. Now they do, **only inside
something they already share, only as adults who turned it on, as text, never with
anybody's phone number or email, and never to a stranger.** The rest of this page is
the rules, as built.

## What a conversation is

A conversation (a *thread*) belongs to one **context**, begins with the first message
written in it, and ends with it. The contexts are the ways two people already stand
together in MySenam (`src/lib/message-contexts.ts`):

| Context | Who is in it | It ends when |
| ------- | ------------ | ------------ |
| An **open game** | The host and the players accepted (not asked, waiting or offered) | The game has been played, or is called off |
| A **team** that persists ([teams](tournaments.md#teams)) | Its members, and a child's guardian for them | The team is archived; a member who leaves is out at once |
| A **community group** ([groups](matchmaking.md#community-groups)) | Its members | The group is closed; a member who leaves is out at once |
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
  verified). A player who has declared under 18, or has not said, **has no messaging**:
  they cannot turn it on, are not in anybody's conversation, and are told why. Saying
  "under 18" later switches it off at once.
- **Children never message.** A child is not an account that writes: where a child is
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
| Notification emails to one person | 5 a day; one per conversation per 6 hours |
| Reports one person makes | 10 a day |
| Frozen with a report | the last 20 messages the reporter could see |
| A conversation ended | read-only 14 days, then closed |
| Retention | 90 days after the context ended (`MESSAGE_RETENTION_DAYS`); a dealt-with report 365 days (`MESSAGE_REPORT_RETENTION_DAYS`) |

The constants are in `src/lib/message-limits.ts`. A refused message is a refusal with a
code and a sentence in all four languages; none of the limits learns or changes by
itself. The routes are also held to an address-level rate limit (`messageRead`,
`messageWrite`).

## Telling people: one email, never the message

A person who can read a new message is emailed **that they have one, and where**
("You have a new message in *Padel game, Sat 14 Nov, Bangsar Courts*"), with a link into the
signed-in app (`/messages?open=game:12`). **The email, and the outbox row behind it, never
contain the message** (nor the sender). It is a kind of its own in the
[outbox](../integrations/messaging.md) (`player_message`), by email only, **never
WhatsApp**, written in the person's language, held to **one per conversation per 6
hours** (a leading-edge digest: the first message after a quiet period tells them; the
ones that follow within the period do not) and **5 a day**. Nothing is sent to the writer,
to somebody who muted the context or turned the emails off, or to somebody a block keeps the
message from. Nothing of a message's text is written to a log, the activity log, an error
report or the outbox.

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
one. Staff see **reports**, with the frozen copy (`GET /api/admin/message-moderation`,
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
  still read, cannot write where the suspension applies, and is told so.

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
- A player who says they are under 18 has no messaging at all, **not even inside a group
  both sides agreed to** (ADR 0039 explains why, and how a decision to allow it would be
  built).
- No machine learning, no content scanning beyond the phone and email check, no venue
  reading of ordinary messages.
- Messages are not in the venue's API, the MCP tools, the public pages or any report or export a
  venue can download; only in the person's own *Download my data*.

## Implementation and tests

| Part | Code | Tests |
| ---- | ---- | ----- |
| Contexts and who is in each | `src/lib/message-contexts.ts` | `tests/player-messages.test.ts`, `tests/player-messages-contexts.test.ts` |
| Settings, sending, reading, limits, notices, block, report, automatic suspension | `src/lib/messages.ts`, `src/lib/message-limits.ts`, `src/lib/message-titles.ts`, `db/migrations/0280_player_messages.sql` | `tests/player-messages.test.ts`, `tests/player-messages-contexts.test.ts`, `tests/player-messages-safety.test.ts` (races on Postgres) |
| Moderation | `src/lib/message-moderation.ts`, `src/app/api/admin/message-moderation/route.ts`, `src/components/admin/MessageReportsPanel.tsx` | `tests/player-messages-safety.test.ts`, `tests/components/player-messages.test.tsx` |
| Export, erasure, retention | `src/lib/message-privacy.ts`, `src/lib/privacy.ts` | `tests/player-messages-safety.test.ts` |
| The player's routes and pages | `src/app/api/messages/`, `src/app/messages/`, `src/components/MessagesLink.tsx` | `tests/player-messages-safety.test.ts`, `tests/components/player-messages.test.tsx` |
