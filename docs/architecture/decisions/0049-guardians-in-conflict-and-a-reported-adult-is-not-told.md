# ADR 0049: Guardians in conflict, and a reported adult is not told

- **Status:** current, **amended by [ADR 0052](0052-youth-messaging-interim-safeguards-pending-legal-review.md)** (an asserted restriction no longer takes effect, only a verified
  decision by an authorised operator; a decision has its own neutral line; a youth report's evidence is no longer deleted on a timer and a legal hold can cover it); decided 2026-11-05 (the owner's decisions 1 and 2 of the five remaining questions; the design choices below
  marked *chosen here* are this record's). Built in migration 0291. What people see is
  [messages between players](../../features/player-messages.md#guardians-in-conflict) and
  [a reported adult is not told](../../features/player-messages.md#a-reported-adult-is-not-told). **Amends
  [ADR 0044](0044-supervised-group-messaging-for-minors-and-a-digest.md)** in the places named under *What this changes*; builds on
  [ADR 0022](0022-children-managed-from-an-adults-account.md) / [0023](0023-participants-apart-from-accounts.md) (guardianship, and the
  custody-dispute exception a manager records), [ADR 0039](0039-messages-between-players.md) and
  [ADR 0016](0016-matchmaking-on-open-games.md).
- **Context:** ADR 0044 made any live guardian's *off* end every consent for a child and let any guardian switch it back on, and said a
  dispute between guardians "is not settled in code". It also told the supervisors, the guardians and, indirectly, the person reported
  about a report in a youth thread, and muted the reported person (who could still read). The owner changed both:
  1. *Any guardian with appropriate legal authority may disable a minor's messaging access, but another guardian must not be able to
     unilaterally reverse that restriction ... keep it disabled until the necessary consent has been restored or a properly authorised
     guardian or safeguarding administrator resolves the issue. Where several guardians have equal authority, require agreement from all ...
     Do not assume that all linked guardians have identical legal authority ... preserve an audit trail and prevent races ... do not expose
     sensitive guardian disputes unnecessarily.*
  2. *Do not automatically disclose a youth-thread report to the adult being reported ... apply the appropriate protective messaging
     restriction at once; notify authorised safeguarding personnel; preserve evidence securely; protect the reporting minor's identity; show
     a neutral access-restriction message; let moderators manage investigation, escalation and any later notification. Do not assume
     guilt, while putting the child's immediate safety first.*
- **Decision, 1: guardians in conflict.**
  - **Authority is data per guardian link** (`participant_guardians.messaging_authority`), never assumed equal. **`decides`** (every link that
    exists today): may consent to the child's group messaging and object to it. **`objects_only`**: may switch it off, never switch it on, and
    never counts towards restoring it. **`none`**: no say in messaging at all (a restriction the venue has been shown). A venue's **manager, or the
    platform's owner**, sets the level, with a short note (200 characters, no document or identity number) of what they were shown, recorded
    with who and when, visible to managers and the owner only. **This is the venue's word, applied and recorded by the app and verified by
    nothing**; the owner asked for "verified legal custody", and the app cannot verify it (AGENTS.md: ages, guardians' agreement and
    categories are declared, never verified; no identity documents). A manager may set it for a guardian link the venue recorded, for a
    participant the venue owns, or for a child in a group that accepted their venue; never a member of staff who is a guardian of the same
    child. A guardian at `none` is refused for every control (`403 YG_NO_SAY`), shown nothing, sent no notice and given none of the child's
    group messages in an export (*chosen here*: a restriction on contact is not a restriction on switching one switch).
  - **An objection** opens when a guardian at `decides` or `objects_only` switches messaging off for the child in a group (or off
    everywhere, in each youth group the child is in). It ends every consent in force, so a consent that is live while it is open was given
    after it. **While it is open no consent counts**, whatever any guardian does, unless **every guardian who decides has a live consent**
    (the objector's own switching on is their withdrawal of it); a guardian demoted, revoked or paused stops counting. **One guardian alone
    cannot restore it**, even if the objector is the only other one. A second guardian's off while one is open is recorded and adds nothing.
  - **A safeguarding administrator** (the manager of the group's accepted venue, or the platform's owner for a group with no venue; **never
    the child's supervisor, never a guardian of the child**, even if they are staff too, by the same login email) may **resolve** it with a
    mandatory reason, logged. **Resolving does not switch messaging on** (*chosen here*): it ends the hold on consents, and a guardian who
    decides still has to consent, because a child never has a seat without a live consent.
  - **Without an objection** nothing changes: one guardian's consent is enough, as ADR 0044 had it. Consent counts only from a guardian
    at `decides` (*chosen here*; with every link at `decides`, as today, that is every guardian).
  - **An objector who may only object** is restored by the guardians who decide alone (*chosen here*): their word is not needed, which is
    what "never counts towards restoring it" says. If this is wrong for a venue it records that guardian as `decides`.
  - **Races.** Every consent change, objection, level change and resolution for one child and group takes one row lock
    (`youth_consent_locks`, `FOR UPDATE`), the guardian's level and relationship re-read inside it; a message being written takes it
    `FOR SHARE` before any other row. **A racing "on" can never win over a concurrent "off", whichever commits first**: if the on commits
    first the off ends it; if the off commits first the on is recorded and does not count.
  - **Minimal disclosure.** The other guardians are told only that messaging for the child in the group *is off and needs agreement from all
    guardians who decide* (and later, that agreement was reached, or that the venue settled it); never who objected or why. The child, the
    supervisors, the group and venue staff who are not safeguarding administrators see only that messaging is unavailable. Who objected, at
    what level, and any note appear only to safeguarding administrators (each reading recorded) and in the group's record, which keeps who,
    what, when and the level at the time and never a narrative.
- **Decision, 2: a reported adult is not told.**
  - **No notice of a report goes to the reported adult, by any channel** (email, outbox, in-app, the notification, attention and activity
    feeds, the staff panels, errors). A report in a youth thread is a **protective** measure, not a finding. What the adult sees, whatever
    the cause (a report, or a supervisor's pause: *chosen here*, so the one cannot be used to infer the other), is one line in the
    conversation's place: *Your access to this conversation is paused while the venue reviews it. This is not a finding.*, with no messages, no
    count, no thread number and no supervisors. A reported adult who is a supervisor or the organiser **loses those powers while it stands**
    and is not shown as supervising; the conversation, left with no supervisor, waits for one. A reported minor keeps the pause ADR 0044
    gave (reads, cannot write), and their guardians are told as before.
  - **Who is told:** the live guardians of a minor who reported or was reported (that a report was made, never its content), and
    **safeguarding personnel only**: the venue's managers, or the platform's owners for a group with no venue. **The supervisors are no
    longer told** (*chosen here*: they are not safeguarding personnel, and one may be the person reported). **Conflict-of-interest guard:** a
    member of staff who is the same person as the one reported (the same account, or a staff login with the same email) is left out of every
    audience and the report is not here for them in any list, route, panel or notice (the same `404` as for anything that does not exist,
    the group not listed as theirs, their moderating powers over the group suspended); the platform's owners are told instead, and the
    report is escalated to them. An automatic suspension a youth report brings about says "paused pending review" and is not told to the
    reported adult. Staff notices are a kind of their own (`safeguarding_notice`, no venue), not listed in any outbox screen.
  - **Evidence:** the frozen copy (the last 50 messages) is not in any list; safeguarding personnel read it one report at a time, **each
    reading recorded** in `youth_report_actions`, kept apart from the staff activity log (which a reported member of staff can read). It is
    never in a person's export. It is held while the report is open **or the restriction it placed is in force** (the existing "an open report
    stays" rule of the retention job, extended by that one condition: the only legal-hold records the app has belong to applications, and are
    not used), including against the erasure of the reported account, which is never refused.
  - **Moderators** confirm, extend or lift the restriction, escalate to the owner, add notes, and **may write the one notification the
    reported adult is ever sent** (never automatic; refused if it names the reporter or repeats the reported words; only for an adult).
    Outcomes: *restriction lifted, no action*; *restriction continues*; *action taken*. The screens and this record say the restriction is
    protective and not a finding of fault.
- **What this changes** (Rule 9: nothing changes silently):
  - ADR 0044, *Guardian controls*: "any live guardian's switch-off ends every consent for that child and group, and any live guardian may switch it
    on" is **replaced** by an objection that holds until every guardian who decides agrees or an administrator resolves it. Its *Consequences*
    line "any guardian's off wins: simple and safe, and a second guardian can switch it back on. A decision about who prevails ... is the owner's"
    is **replaced**: the owner decided.
  - ADR 0044, *Safeguarding measures*: a report "is told at once to the supervisors (not the person reported), the live guardians ..., and the
    venue's managers" becomes guardians and safeguarding personnel only; "the reported person is muted in that thread until the report is
    reviewed" becomes, for an adult, the restriction above (they no longer read, and lose a supervisor's powers), and for a minor stays. A
    review that "took action keeps it until staff lift it" now also has *restriction continues*.
  - ADR 0044's statement that a guardian is told "when messaging is paused for a person (automatic suspensions included)" no longer applies to
    an adult suspended because of a report in a youth thread.
  - The round-10 feature page and its first-use text said a switch-off by one guardian was undone by another's switch-on; the screens now say
    it stays off until the guardians who decide agree or the venue settles it.
- **Consequences / not built:**
  - A venue with two guardians in dispute has a way to say who decides, and the owner of a venue-less group is the administrator: both are a
    person's judgement, recorded, never the app's. A child with no guardian at `decides` has no way to have messaging switched on until a
    manager records one.
  - Settling a hold leaves the child without messaging until a guardian consents again: slower, and deliberate.
  - The reported adult's other powers as a member of the community group (they stay a member) are not touched here; ending their membership
    is the organiser's or staff's decision outside this record.
  - **Awaiting legal and professional review, not settled in code:** the wording of every notice and neutral line; whether a venue's recording
    of custody suffices; whether a protective restriction without notice is lawful in a given country, and what a reported person is owed and
    when; the evidence retention and the choice not to refuse erasure; the staff-read exception. All wording outside English is
    machine-assisted.
- **Alternatives considered:**
  - *Any guardian may switch it on, as before.* Rejected by the owner's decision.
  - *Verifying custody.* Rejected: it would mean collecting identity or court documents (AGENTS.md).
  - *Restoring needs a majority, or the objector's own word only.* Rejected: equal authority needs all.
  - *Telling the reported adult that a report exists, without its content.* Rejected by the owner's decision.
  - *Blocking erasure while evidence is held.* Rejected: a refusal would tell the reported person that a report exists.
