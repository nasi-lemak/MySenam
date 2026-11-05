# ADR 0039: Messages between players: only inside a context they share, adults who opted in, text with no contact details, reported and moderated by the venue that owns the context

- **Status:** current, **amended by [ADR 0044](0044-supervised-group-messaging-for-minors-and-a-digest.md)** (three places, each
  marked below: minors in a supervised youth group, staff reading such a group's thread, a digest instead of a throttle), decided 2026-11-05 (the owner asked for messages between
  players, safe by design; the choices below are the owner's, made in the brief, and
  the three marked *chosen here* are this record's). Built in migration 0280. What
  people see is [messages between players](../../features/player-messages.md).
  Builds on [ADR 0016](0016-matchmaking-on-open-games.md) (strangers are not
  reached; opt-in; adults only; minors only through a group both sides agreed to)
  and [ADR 0022](0022-children-managed-from-an-adults-account.md) /
  [0023](0023-participants-apart-from-accounts.md) (a child is a participant an adult manages, never
  an account that acts).
- **Context:** players could invite, join, block and report each other, and had no way
  to write. Two rules in [AGENTS.md](../../../AGENTS.md) bind any message feature:
  *being found or invited by strangers is opt-in and for declared adults only; minors
  are invited only through a group both sides agreed to*, and *a child's name is never
  public*. A message is also the one feature where personal data (what somebody says,
  and to whom) is the whole content, so the privacy and moderation design had to come
  with it, not after it (the roadmap said so).
- **Decision:**
  - **A thread belongs to a context and ends with it.** The contexts are an open game
    (host and accepted players), a persistent team, a community group, and the fixtures
    a person is in: a tournament match, a box-league match, a ladder challenge, a team-league
    fixture (the two captains). A thread begins with the first message written by a person
    who is in the context; nothing else starts one. There is no search, directory, lookup
    by name, phone, email or account number, and no conversation "to an address".
    Membership is read live from the context's own tables (`lib/message-contexts.ts`):
    nothing is copied, so leaving, removal and withdrawal take effect at once. A person
    not in a context gets `404`, the same as for one that does not exist. An ended context
    leaves a thread read-only for 14 days and then closed; the thread is deleted
    `MESSAGE_RETENTION_DAYS` (90) after the context ended.
  - **Adults' accounts only; children never message.** *(Amended by [ADR 0044](0044-supervised-group-messaging-for-minors-and-a-digest.md):
    a child's own account can have a seat in a supervised youth group's thread only, under that record's conditions; the guardian's
    seat below is unchanged.)* A seat is an account that has
    declared it is 18 or over, re-read on every call, and has turned messaging on.
    Where a context holds a child (a team member who is a participant, a tournament,
    league or ladder entry for one), the seat is the **guardian's account**
    (`team_members.acting_user_id`; the entry's account), labelled *Guardian of Aina L.*
    with the child's short name from the one rule behind every public page
    (`shortName`, `isDeclaredMinor` in `lib/public-names.ts`), never the full name and never the
    guardian's own name beside it. A team entry's seat is its captain, by the team name; a
    team's other members have none. A message to a child does not exist.
  - **How minors are handled, and what was found (*chosen here*).** *(Superseded by
    [ADR 0044](0044-supervised-group-messaging-for-minors-and-a-digest.md), which allows a declared minor's seat in a supervised youth
    group, as the owner decided; the text below is what stood until then.)* A *minor's account* does
    exist in the code: a registered user whose profile says `adult = false` (declared under
    18), or who has not said (`NULL`). They may hold a game place, be in a community group
    (groups are the one way a declared minor is invited to a game, ADR 0016) and enter
    events with a guardian's agreement. The brief says such an account "cannot message adults
    outside a group both sides agreed to". **This record keeps the safe end of that:
    a declared-under-18 or unsaid account has no messaging at all, inside a group too.**
    A group is open to adults and minors who each agreed to join, but *a message
    is not an invitation*: a group's agreement covers "invite me to games", and a private
    channel between an adult and a child is a different thing that no earlier decision
    approved. The conservative behaviour is also reversible: allowing minors inside a
    group would be one more eligibility rule (the group, both sides' agreement recorded as
    declared, no minor-to-adult thread outside it, a guardian's account copied), and
    belongs to the owner. **An unresolved product decision**, listed in the report.
  - **Opt-in, default off, both sides.** `player_message_settings.enabled` (default 0) is
    the person's *Let people I play with message me*, with a per-context mute
    (`player_message_mutes`). A conversation can be written in only when somebody else in
    the context is eligible; the sender is told only that nobody else can be written to
    (`PM_NOBODY`), which the roster already implies. The first screen must be read and
    confirmed once (`explained_at`). Joining anything never turns it on.
  - **Text only, no contact details.** No attachment column exists; a link is plain text;
    1000 characters; control characters removed. An email address, or a run of eight or
    more digits that has a group of three or more digits or ten digits in all, is refused
    (`PM_CONTACT`). **This is a speed bump, not a guarantee**, and the docs say so: no
    other content scanning, no machine learning. Rate limits per person (30 an hour,
    150 a day), per conversation (20 an hour), new conversations (5 a day), notification
    emails (5 a day, one per conversation per 6 hours), reports (10 a day).
  - **Notifications carry no message.** *(The leading-edge digest below is superseded by
    [ADR 0044](0044-supervised-group-messaging-for-minors-and-a-digest.md): the scheduler sends a real digest at the end of the period; no
    text, no sender and no WhatsApp stand.)* An email through the outbox as a kind of its own
    (`player_message`): *you have a message in {place}*, with a link into the signed-in app;
    never the text, never the sender, never WhatsApp. A leading-edge digest: the first
    message after a quiet period tells a person, the ones within the period do not
    (a trailing digest would need a scheduler job and would hold the first notice back).
  - **Blocking is the existing block, extended.** `player_blocks` is respected and may now
    be made from any context a person can read (a teammate or opponent, not only somebody
    from a game or group): `blockPlayer` takes `opts.related` for a caller that has already
    shown the two share a context (default behaviour byte-for-byte unchanged). **A blocked
    person's messages are not delivered and they are not told:** the message is accepted
    and kept for its writer; every reader filters out a writer who has blocked or been blocked
    by them, at read time, in the one SQL fragment all reads use.
  - **Reports freeze a copy; the venue that owns the context moderates.** A report of one
    message keeps a copy of the thread's last 20 messages as the reporter saw them
    (`player_message_report_lines`) with the report. A venue's managers see the reports of
    their venue's contexts only, the platform owner those of contexts with no venue
    (`venue_id` is the context's, fixed when the thread begins; a group has none; a team has
    its own `venue_id` if set). Staff may mute (reversible) or close (for good) a thread,
    and suspend a person's messaging with a reason: a venue's suspension is scoped to its
    own contexts and needs a report in its scope about that person; the owner's is
    platform-wide. Everything is logged by number and reason, never with message text.
    There is no staff screen of ordinary messages *(except a supervised youth group's thread, [ADR 0044](0044-supervised-group-messaging-for-minors-and-a-digest.md))*. The routes are manager-only
    (`MANAGER_ONLY`).
  - **Repeated reports suspend automatically (published rule).** Three different people's
    reports about one person within 30 days, none yet found to need no action, suspend their
    messaging platform-wide, pending the owner's review (lift, or confirm as their own
    decision). Deterministic, no learned score.
  - **Privacy.** Personal data of both sides: in *Download my data* (`playerMessages`),
    erased with the account (what a person wrote becomes *message removed*, their label
    and the words of their reports cleared; the other side's messages stay for them),
    deleted `MESSAGE_RETENTION_DAYS` after the context ended, a dealt-with report and its
    frozen copy `MESSAGE_REPORT_RETENTION_DAYS` (365) after review. In the retention
    screen. Not public, not in the venue API, not in the MCP tools, not in any export a
    venue can download. Legal questions (lawful basis, retention periods) are written in
    [privacy](../privacy.md#messages-between-players) as the product's choice, subject to
    professional review, and never settled in code.
  - **Polling, not sockets.** An open conversation asks for what is new every 15 seconds
    while its tab is visible; a polite live region announces new messages.
- **Consequences:**
  - A person with messaging off, or a minor's account, is never in anybody's list, and
    a conversation with nobody else on is not listed at all.
  - Moderation is by report, so a conversation nobody reports is read by nobody. That is the
    point of the design and its limit: harm nobody reports is not seen.
  - Labels (`sender_label`) are kept as the context showed the sender when they wrote: a
    first name or a child's short name, cleared when the sender's account is erased. A
    child's short name stays in a guardian's messages until the thread is deleted by
    retention, and is not cleared by the *participant's* erasure alone (a gap, in
    [known limitations](../../roadmap/known-limitations.md)).
  - A team's other members are not seated in a fixture their team plays; only the captain.
    A conversation among a whole team about a fixture is the team's own thread.
- **Alternatives considered:**
  - *Direct messages between any two players who have played together.* Rejected: it
    makes "have played together" a way to be found, and ADR 0016's rule is that strangers
    are not reached.
  - *Letting a declared minor message inside a group.* Rejected for now (above).
  - *Showing a child's full name to the guardians of the other side.* Rejected: a child's
    name is never public, and a conversation's other side is not a guardian of the child.
  - *Content scanning, a classifier, auto-moderation.* Rejected: the rule is no learned
    ranking and no hidden judgment; a published, deterministic count of reports is the
    only automatic step.
  - *Emailing the text.* Rejected: a message's content never leaves the app.
  - *Real-time sockets.* Rejected for this round: polling is enough, and nothing in the
    deployment needs a long-lived connection.
