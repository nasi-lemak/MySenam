# ADR 0044: Supervised group messaging for eligible minors, guardian controls, and a real notification digest

- **Status:** current, decided 2026-11-05 (the owner's decision, with the design choices below made in the brief; those marked
  *chosen here* are this record's). Built in migration 0286. What people see is
  [messages between players](../../features/player-messages.md#supervised-youth-groups). **Amends
  [ADR 0039](0039-messages-between-players.md)** in three places, named under *What this changes*: a declared minor's account had no
  messaging at all; nobody on staff reads an ordinary message; a leading-edge throttle told people of messages. Builds on
  [ADR 0016](0016-matchmaking-on-open-games.md) (strangers are not reached; minors only through a group both sides agreed to),
  [ADR 0022](0022-children-managed-from-an-adults-account.md) / [0023](0023-participants-apart-from-accounts.md) (a participant a
  guardian manages; the participant's own login linked by both sides agreeing).
- **Amended by [ADR 0049](0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md) (5 November 2026)** in two places, each marked where it stands below: a guardian's switch-off is no longer undone by
  another guardian's switch-on, and a report in a youth thread is no longer told to the supervisors or to the person reported.
- **Context:** the owner asked: *allow supervised group messaging for eligible minors, but prohibit unsolicited private messaging;
  include moderation, reporting, age-appropriate guardian controls and safeguarding measures; use a 6-hour notification digest by
  default, with immediate delivery for urgent safety or moderation events.* ADR 0039 had kept the conservative end of its brief: a
  declared-under-18 or unsaid account has no messaging at all, inside a group too, and said that allowing it would be one more
  eligibility rule that belongs to the owner. This is that rule, written so that the unsafe thing is impossible by construction rather
  than unlikely by moderation: nothing about a minor's messaging works unless several independent things are all true at once, and each is
  read live.
- **Decision:**
  - **An eligible minor** is an account with no declared age of 18 or over (declared under 18, or not said: `player_profiles.adult` 0 or
    none; the codebase's own split, not a legal age) that is a member of a community group marked as a **supervised youth group**, and
    has **all three**: (1) **its own opt-in** for that group, revocable; (2) a **guardian's consent** for that child and that group, from
    a live guardian (not revoked, not paused for review, not archived) of the participant whose **own login the account is** (ADR 0023's
    link, so a guardian is *recorded and linked*, never a name typed into a form); default off, explicit, revocable, per child and per
    group; (3) the group **marked**. Every call re-reads all three (`youthSeats`): nothing is copied, so a guardian's relationship being
    revoked, the child leaving, the opt-in taken back or the group ceasing to be a youth group ends the seat at once. Ages, guardianship,
    consent and roles are the people's word, recorded as declared, never verified, and no identity document is collected.
  - **Only community groups** (*chosen here*). The brief allowed "other contexts you judge safe" (a venue-run programme's team, a junior
    league or ladder). None is included: the other contexts are pairs (a match, a challenge, a fixture), where the seat is already the
    *guardian's* account and a one-to-one thread would be exactly what is prohibited, or are teams whose seats follow a different model
    (the guardian in the child's place). A group is the one context that is already a shared, many-person space people agree to join.
    A later decision could add a team of a venue-run programme as one more rule; nothing here stands in its way.
  - **Group only, never private, by construction.** A minor has a seat only in a youth group's shared thread. No other context has a
    minor's seat (their seats are adults who turned messaging on), a minor cannot start any thread (a **supervisor starts it**), there is
    no "reply privately" and no route that names a person. A conversation with a minor in it **opens only while at least three people
    who can read it are there, a supervisor among them** (`YOUTH_LIMITS.minSeats`): a supervisor and one child is a private conversation
    in all but name, and is refused for both. And **the database refuses** a message from anybody not declared 18 or over outside a
    youth group's thread (a trigger, migration 0286), so no code path, present or future, can do the one thing that is prohibited.
  - **Supervision.** The organiser (a declared adult) marks the group and is its first supervisor, declared role *organiser*. The
    organiser may let other adult members in, each **as a supervisor or an adult, with a declared role** (coach, venue staff,
    volunteer, parent, other: said by the organiser, never verified), recorded and **shown to the guardians**. **An adult who is a
    member and was not let in has no seat**: an adult is never added to the thread without supervisor action. A supervisor is a member
    of the thread, **reads everything** (a block never hides a message from a supervisor, and nobody blocks a supervisor in a youth
    thread: a space no adult can read is not supervised), and can **remove a message, pause (mute) a member and pause or close the
    thread**, each with a reason, each recorded in the group's own record (by message number, never the text). What was written in the
    group's thread before it was marked is never shown in it. Marking is an advanced setting of a group; nothing about it is part of
    anybody's setup. **Ending the youth group closes its thread for good**, and it never becomes an ordinary adults' thread: a
    conversation that held minors' messages is not shown to adults who were not in it.
  - **A venue looking after a group** (*chosen here*). Community groups have no venue, and staff are not player accounts, so a venue is
    attached by agreement of both sides: the organiser **asks** a venue; that venue's **manager accepts or declines**. Only after
    acceptance is the group the venue's for moderation: its reports go to the venue, its managers may read the thread (below), and
    the thread and its reports so far move to the venue. A venue never sees a group nobody gave it. Until then, and for a group that
    asked no venue, **the platform's owner** moderates and may read it, as ADR 0039 already had it for a group.
  - **Staff may read a youth group's thread: a deliberate exception** (the owner's brief). ADR 0039's "nobody on staff reads an ordinary
    message" holds for every adults' thread; for a supervised youth group alone, a **manager of the accepted venue, or the platform's
    owner for a group with no venue**, may read the conversation for moderation and safeguarding review. Managers only (front desk is
    turned away); **each reading is written to the staff activity log** (by group number, never any text) **and to the group's own
    record**; the first-use screen tells members a supervisor can read the group's messages and that a venue's managers may.
  - **Guardian controls** (on the guardian's existing "people I act for" page, nothing in onboarding): see, for each child with a login
    linked, which youth groups messaging is on in, who supervises and which adults were let in; switch it **on or off per group, or off
    everywhere at once** (effective at once; the group sees only that the child is no longer in the conversation); **read the child's
    thread, read-only**, labelled *as the guardian of {child}*, other children by their short names (the one public-name rule), each read
    recorded; **block people for the child** (never a supervisor); choose how often notices about the child's messages come; receive the
    child's report and moderation notices; and **export** the child's group messages. Where a child has two guardians, **any live
    guardian's switch-off ends every consent for that child and group**, and any live guardian may switch it on; the other guardians are
    told at once either way. (A guardian dispute over this is not settled in code.) **Replaced by [ADR 0049](0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md): an objection holds until every
    guardian who decides agrees, or a safeguarding administrator resolves it.**
  - **Safeguarding measures.** Text only, nothing clickable. The contact-detail refusal is **extended in a youth thread, for everybody**:
    no phone or email (as ever), and no social handle (`@name`), no chat or social service's name (WhatsApp, Telegram, Instagram,
    Snapchat, TikTok, Discord, WeChat, Kik, Facebook, Messenger), no link or web address, no "DM me" / "add me on" / "my number is": a
    speed bump, not a guarantee, and nothing understands a message. **Stricter limits for a minor's seat**: 300 characters, 12 an hour,
    40 a day (`YOUTH_LIMITS`). **Rest hours**: no message from a minor between **22:00 and 07:00** in the venue's time zone (the
    install's, for a group with no venue), default on (`YOUTH_QUIET_HOURS`); an organiser may **lengthen** the group's hours, **never
    shorten** the install's, and "off" is the install operator's to choose, not reachable from a venue, an organiser or a guardian. A
    visible **report button on every message**. **A report in a youth thread is urgent** (*chosen here*: all of them, not only those by
    or about a minor, because an adult reporting an adult in a thread full of children is the same event): told **at once** to the
    supervisors (not the person reported; **no longer: [ADR 0049](0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md)**), the live guardians of a minor who reported or was reported, and the venue's managers (the
    platform's owners where there is no venue), as the `safeguarding_notice` kind (email, never WhatsApp, never the text, not
    digested, **not held to the daily limit per recipient**, like a team decision); **a longer frozen copy** (50 messages, not 20);
    and **the reported person is muted in that thread until the report is reviewed** (a review that found nothing needed lifts it; one
    that took action keeps it until staff lift it; **for a reported adult, now a restriction with no reading and no supervisor's powers, shown as
    one neutral line: [ADR 0049](0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md)**). A guardian is also told at once when a supervisor mutes their child or removes
    their message, when a conversation they have a child in is closed, and when messaging is paused for a person (automatic
    suspensions included: for every person, not only minors). No machine learning and no content scanning beyond the pattern speed bump.
  - **Retention, export, erasure.** A youth conversation is deleted **60 days after its group ended** (`YOUTH_MESSAGE_RETENTION_DAYS`,
    shorter than an adults' 90), the **words of a message a supervisor removed 30 days after it was removed**
    (`YOUTH_REMOVED_RETENTION_DAYS`; until then staff reviewing the group see it, marked removed; the message stays as "removed"). They
    are in *Download my data* for the child and the guardian (a guardian exports the child's group messages), erased with the account as
    adults' messages are, and in the retention screen.
  - **A real digest** (replaces ADR 0039's leading-edge throttle). By default **one email per person per conversation per period**
    (`MESSAGE_DIGEST_HOURS`, 6; a whole number of hours, 1 to 24), **sent by the scheduler** (the outbox tick) **at the end of the
    period in which a message arrived, if anything is still unread**: "you have N new messages in {context}", **count only, never the
    text and never the sender**. Periods are fixed slots of the clock (UTC); a notice records the newest message it covered
    (`through_id`, unique per person and conversation), so the scheduler never tells the same person about the same messages twice,
    however often or on however many servers it runs. **Each person chooses** *at once*, *a digest* (the install's period) or *daily*;
    **a guardian's choice governs notices about their child** (including *not at all*), whatever the child chose. Messages that have been
    read, muted conversations, the writer, and people who turned the emails off are never told. The per-person limit of five notices a
    day stands. **Urgent events are never digested** (above).
- **What this changes** (Rule 9: nothing changes silently):
  - ADR 0039, *Adults' accounts only; children never message*: a **child's account** can now have a seat, in a supervised youth group
    only, under every condition above. Everywhere else, and for the guardian's seat in a team or a match, it holds as written. The same
    ADR's *How minors are handled (chosen here)*, which gave a declared-under-18 account **no messaging at all, inside a group too**, is
    **superseded** as the owner decided it be: it now has no messaging except as this record allows.
  - ADR 0039, *Moderation* and the privacy page: *nobody on staff reads an ordinary message* is **amended**: it holds for every adults'
    conversation, and a supervised youth group's conversation may be read by the staff named above, each reading recorded.
  - ADR 0039, *Notifications carry no message*: *a leading-edge digest, a trailing one would need a scheduler job* is **superseded**:
    the scheduler (the outbox tick, which already existed) sends a trailing digest. The rest of that decision stands: no text, no
    sender, no WhatsApp. The feature page's limit *one per conversation per 6 hours* is now the digest's period, a setting.
  - The feature page's statement that a player who says they are under 18 has no messaging at all, and the first-use screen's *A child never
    messages* (reworded: a child never messages anyone privately).
  - Round 10's feature-status row for messages between players said the same; the lead updates it (see the report).
- **Consequences:**
  - A group that marks itself a youth group and has no supervisor with messaging on, or fewer than three readers, simply has no open
    conversation: the refusal says what is missing.
  - A child's short name appears in a guardian's and in other children's views, as on every public surface; a child's full name never
    does.
  - Consent is per guardian and per group, and any guardian's *off* wins: simple and safe, and a second guardian can switch it back
    on. A decision about who prevails between guardians who disagree is the owner's, not code's. **Replaced by [ADR 0049](0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md): the owner decided.**
  - What awaits legal and professional review, **not settled in code**: the wording of the first-use screen and the notices; whether a
    guardian's consent recorded this way suffices in a given country; the staff-read exception and its lawful basis; the retention
    periods; the rest hours; and whether a venue may supervise minors in a group at all in a given jurisdiction. All wording is
    provisional and machine-assisted outside English.
  - An adult's declared age is their word: an account whose profile says 18 or over, but that is the linked login of a participant a
    guardian manages, is still treated as an adult for ordinary messaging. This is a pre-existing limit of declared ages, now noted.
- **Alternatives considered:**
  - *Letting a minor be in any context a group of adults is in.* Rejected: the other contexts are pairs or follow a different seat
    model; see above.
  - *A guardian reading a child's messages as a seat in the thread.* Rejected: a read-only view, recorded, labelled as the guardian's,
    never a participant.
  - *Staff reading every youth group.* Rejected: a venue reads only a group that asked it and a manager accepted.
  - *Moderation after the fact only.* Rejected: the three-consents rule, the three-reader rule, the supervisor's presence and the
    database trigger are what make a private conversation impossible rather than improbable.
  - *Scanning messages with a classifier.* Rejected, as in ADR 0039: no learned judgement, a published, deterministic speed bump only.
  - *A leading-edge throttle kept beside the digest.* Rejected: two mechanisms to explain; the digest is the one.
