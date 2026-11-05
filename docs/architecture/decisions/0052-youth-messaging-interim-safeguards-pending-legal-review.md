# ADR 0052: Youth messaging: interim safeguards, prepared for legal review

- **Status:** current, decided 2026-11-05 (the owner's decisions on the three remaining issues). Built in migration 0294. What people see
  is [messages between players](../../features/player-messages.md#interim-safeguards-pending-legal-review); the data and its retention is
  [youth messaging evidence](../privacy.md#youth-messaging-evidence); the questions for a lawyer are
  [the legal-review checklist](../../operations/legal-review-youth-messaging.md). **Amends
  [ADR 0049](0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md) and
  [ADR 0044](0044-supervised-group-messaging-for-minors-and-a-digest.md)** where named under *What this changes*; builds on
  [ADR 0022](0022-children-managed-from-an-adults-account.md) / [0023](0023-participants-apart-from-accounts.md) and
  [ADR 0039](0039-messages-between-players.md).
- **Context:** the owner approved an **interim product and safety direction, subject to review by qualified Malaysian legal and
  child-safeguarding professionals before live youth messaging is enabled**. ADR 0049 had recorded a venue's word about a guardian's
  authority and given reports in a youth thread a retention period that was an invented default. The owner's direction: keep every protection
  already built; correct clear security flaws; prepare the legally sensitive areas for later approval; **do not treat any legal question as
  resolved, do not claim compliance, do not invent legal periods, tests or determinations, and add no speculative legal workflows** (no document
  storage, no reporting to any authority, no case types beyond those listed).
- **Decision, 1: youth messaging stays off in production until the launch requirements are met.** `youthMessagingEnabled()`
  (`lib/youth-launch.ts`, the one function) is **false in production unless `YOUTH_MESSAGING_LAUNCH_APPROVED=yes`**, true in development and
  tests. Off: no group can be marked a youth group (`YG_OFF`), a minor has no seat anywhere (`youthSeats` is empty), no youth thread is read or
  written (a guardian's read-only view included), guardians, children, organisers and staff are told plainly *"Youth messaging is not enabled on
  this install: it needs safeguarding and legal approval first"*, **adults' messaging is unaffected**, a guardian can still switch it **off**
  (never on), and what is stored is kept and shown nowhere except to safeguarding administrators for an **open case** (a report open or its
  restriction in force, an authority review or a request for a review open, a legal hold). Listed in `.env.example`, the configuration reference and
  the [launch checklist](../../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove).
- **Decision, 2: custody and authority as a recorded decision, not "the venue's word".** Per guardian link (`participant_guardians`):
  **`authority_status`** (`asserted`, the default: what was declared when the link was made, **not a legal determination**; `verified`: an authorised
  operator recorded a verified decision; `disputed`; `unclear`), **`authority_basis`** (`parent`, `legal_guardian`, `other_authorised`, `not_stated`:
  a short fixed list, no documents, no narrative), **`authority_restrictions`** (`none`, `may_object_only`, `no_messaging_say`), with
  **`authority_standard`**, the constant **`interim: pending legal review`**, next to who and when (and the existing short note, a run of digits
  refused). `messaging_authority` (`decides`, `objects_only`, `none`) stays the one place every rule reads and is now **derived**:
  - **A venue's assertion does not itself establish authority.** A restriction that removes a guardian's say takes effect **only on a `verified`
    decision**; an *asserted* restriction instead sets the link to `unclear` and the guardian keeps their say.
  - **`disputed` or `unclear` on any live guardian link of the child keeps youth messaging for that child off**, whatever consents exist
    (`authorityHoldSql` in `consentInForceSql`), until reviewed; the other guardians are told only the neutral "off and needs agreement" (ADR 0049's
    disclosure rules, unchanged). **A disputed or unclear guardian's objection still counts**: a guardian can always switch it off.
  - **Authorised operators (interim; who may verify is a pending legal question):** the platform's owner, or a venue's manager for a participant
    the venue manages (the link's venue or the participant's venue). A venue that only looks after a group the child is in may mark a link disputed
    or unclear and record an assertion, never verify it, and never clear a disputed or unclear link. **Never a supervisor of a group the child is in,
    never a guardian of the child, never staff who are the same person as either** (the conflict guard). Every decision is written to the safeguarding
    event store (who, status, basis, restrictions, the standard label, when) for each youth group the child is in, and to the staff activity log
    (the older `level` words still work and mean the restriction that says the same).
  - **Minimal collection.** No custody order or identity number is collected or stored. The decision records *that* an authorised operator verified
    something and on what basis; **MySenam does not interpret custody orders or make legal determinations**; it applies the operator's recorded
    decision. Where the supporting record is kept is the venue's own, under its own controls.
  - **An authority review** (`youth_authority_reviews`, one open per child and group) opens when a link becomes `disputed` or `unclear`, or a guardian
    conflict stays unresolved beyond `YOUTH_REVIEW_DAYS` (7, **operational, not a legal period**), and again after that interval if a review ended "remains
    unclear". Visible only to safeguarding administrators; actions: record a verified decision, mark resolved (refused while messaging is still held
    off) or remains unclear, **escalate to the platform's owner**. Never visible to unrelated users or other guardians.
- **Decision, 3: reports concerning adults.** ADR 0049's behaviour is preserved (a neutral protective restriction, the conflict guard, notices only to
  safeguarding personnel, held evidence, the adult told only by a moderator). Added:
  - **Protective or a decision.** A restriction a report places is `protective` (temporary, **not a finding**) or, converted by a moderator with a
    recorded reason and outcome (`removed_from_group`, `messaging_suspended`), a `decision`. The staff screens word them differently; the restricted
    adult's neutral line is *"paused while the venue reviews it. This is not a finding"* for a protective hold (and a supervisor's pause: the same line,
    so the one cannot be told from the other) and *"changed following a review by the venue"* for a decision; neither says why. Nothing presents an
    allegation as proven. Either outcome keeps the seat restricted in the same way: *"removed from this group's conversation"* is a recorded outcome, not
    a removal from the community group (ADR 0049: that is the organiser's or staff's decision outside this record).
  - **No indefinite unreviewed restriction.** Every protective restriction has `review_by` (`YOUTH_PROTECTIVE_REVIEW_DAYS`, 7, operational). Past it
    unreviewed it is **escalated to the platform's owners** (a needs-attention line and a safeguarding email, repeated at the interval) and **never lifted
    or converted automatically**; a moderator's review (continue with a reason, lift with a reason, or convert to a decision) resets it.
  - **A request for a review that does not reveal why** (`youth_restriction_appeals`): on the neutral line, for any cause, the restricted adult can
    **ask for a review** with one short text. It goes to a reviewer **other than whoever applied the restriction** (a different manager of the venue, else
    the platform's owner), is decided (lift or continue) with a reason, recorded in the case's own record and the group's, and the adult is told only that it
    was received and, when decided, the outcome in neutral words (a moderator may add a few words, never naming the reporter or repeating what was reported).
    **It promises no legal right: rights to review and notification are pending legal review.**
  - **Escalate (safeguarding)** (a case step): a fixed reason (`suspected_abuse`, `imminent_danger`, `possible_reportable_incident`, `other`) that tells the
    platform's owners **at once** (the safeguarding notice kind, never naming who reported or what), records who, when and why in the case, brings the owner
    into the case, and shows a **static guidance panel**: *"If a child is in immediate danger, contact the emergency services (999) now. Whether and how an
    incident must be reported to the authorities is pending legal review; follow your own safeguarding policy."* **Nothing is sent to any authority by
    MySenam** and no statutory body or contact is named.
  - **Reporter confidentiality** (ADR 0049) holds on every new surface: the review items, the escalation notice, the owner emails, the needs-attention
    lines and the outcome notice show neither the reporter nor the report's words (tested across them).
- **Decision, 4: evidence retention, in four classes, with no invented period.** (a) Ordinary message retention (the existing operational defaults,
  *pending legal approval*); (b) safeguarding evidence (the frozen copy, case actions, escalations, review items); (c) audit records (the safeguarding event
  store, the activity entries about youth messaging); (d) records under a legal hold.
  - **`MESSAGE_REPORT_RETENTION_DAYS` (365) applies to adults' threads only, unchanged.** A report in a youth thread is **no longer deleted by the ordinary
    job**; the generic report rule now stops at `urgent = 0` and the orphan clean-up of case actions is gone. (b) and (c) are **never deleted
    automatically**. A deletion period for **closed cases** applies **only if the install sets `SAFEGUARDING_EVIDENCE_RETENTION_DAYS`** (documented as
    requiring legal approval; at least 30; a smaller or invalid value is no period), never for a case open, with a restriction in force, or under a hold, and
    never for audit records (a setting does not reach (c): *chosen here*). The activity-log prune (two years) leaves `messages.youth_*` entries alone.
  - **An ordinary-retention timer never deletes active-case evidence:** while a case is active in the group (a report open, a restriction in force, an authority
    review or a request for one open, a hold), the retention job skips the group's thread **and** what a supervisor removed from it; the case copy is not on the
    timer at all. The ADR 0049 rule "an open report stays" is extended from the report to the thread and the case.
  - **Unset, a periodic prompt** (`SAFEGUARDING_REVIEW_MONTHS`, 12, operational) asks the platform's owners, by a safeguarding email (monthly while something is
    due, counts only) and a needs-attention line, to decide about closed cases and holds kept longer: **a decision to keep, never a deletion**.
  - **Legal holds, controlled** (`youth_evidence_holds`): the platform's owner only creates, reviews and releases one, on a case or on a child and group (every youth
    report of the group: *chosen here*, conservative), with a reason, an external reference in words (digit runs refused) and an optional review date. A hold blocks
    deletion and anonymisation of the covered evidence copy and the conversation by retention and by erasure (the held copy keeps its labels and words); **erasure of
    the person's account is never refused** (ADR 0049). Audited in the case's record and the group's, and in the activity log **with no venue**, so a venue's staff
    cannot read it. The review prompt covers holds too. *Legal preservation requirements are pending legal review.*
  - **Append-only:** the database refuses an edit of a case action or an event (a foreign key's own `SET NULL`, when an account is erased, is let through).
- **Decision, 5: a focused security review**, clear flaws only. Findings are in *Consequences*.
- **What this changes** (Rule 9: nothing changes silently):
  - ADR 0049, *Decision 1*: "This is the venue's word, applied and recorded by the app and verified by nothing" and the three-level setting set by a manager or the
    owner **are replaced** by the recorded decision above: an asserted restriction no longer takes effect (it makes the link `unclear`); a verified decision does,
    and only an authorised operator records one. `none` and `objects_only` are now results of a verified decision.
  - ADR 0049, *Decision 2*: "the same line whatever the cause" stays for a protective restriction and a supervisor's pause, and **a decision has its own neutral
    line**; "Evidence ... is held while the report is open or the restriction ... in force, ... then the ordinary rules apply" **is replaced**: after that the evidence is
    kept (class (b)) unless the install sets a period; a hold (class (d)) is also held.
  - ADR 0044, *Safeguarding measures* and *Retention*: a report in a youth thread is **no longer kept 365 days then deleted**; a youth group's conversation is not
    deleted while a case is active in the group.
- **Consequences / not built:**
  - **Awaiting legal and professional review, not settled in code:** every item of [the checklist](../../operations/legal-review-youth-messaging.md): guardian
    authority, who may verify and to what standard, what an adult restricted without notice is owed, reporter confidentiality and review rights, mandatory reporting,
    retention and preservation, the allocation between MySenam and venues, and the Malaysian and (future) Singapore differences. Every period here is operational, every
    notice wording is provisional, and every language other than English is machine-assisted.
  - **Not built (by direction):** no custody or identity document storage, no reporting to any authority, no new case types, no statutory period, no appeal "right".
  - A child in no youth group has no event store to record an authority decision in: it is in the staff activity log only.
  - The `removed_from_group` outcome restricts the seat for good; it does not remove the person from the community group.
  - Existing links the venue had restricted before this (migration 0294) are converted to asserted restrictions: they no longer take effect and make the link `unclear`,
    so a child's messaging there stays off until an authorised operator records a decision. Youth messaging was never enabled in production, so no live child is affected.
  - **Security review of the youth module (clear flaws only).** *Fixed:* a member of staff named by a report in a youth thread could **lift the suspension that report brought
    about** by its number (`liftSuspension` had no conflict guard); it is not there for them now (404), tested. *Not a flaw:* every staff write route is manager-only and
    scoped (a stranger and a missing record answer alike); the writes are behind the same-origin check and, for customers, an address-level rate limit (the new request-a-review
    route has one, and allows one open request); guardian and child reads are keyed to the account; output is escaped (no raw HTML). *Left, not clear:* a restricted adult can
    ask again after each decision (an operational nuisance for a reviewer, bounded by the address limit and one open request at a time); the staff screens show the account number
    of the person a case names (by design, to act on it).
- **Alternatives considered:**
  - *Letting a venue's assertion take effect, as before.* Rejected by the owner's direction.
  - *Collecting custody orders to verify them.* Rejected: documents are out of scope, and the app cannot judge them.
  - *Deleting youth reports on the adult-thread timer, or an invented longer one.* Rejected: no period is invented without advice.
  - *Lifting or converting an overdue restriction automatically.* Rejected: a restriction is never lifted or turned into a decision by a clock.
  - *Reporting an incident to an authority from the app.* Rejected: a legal duty is not settled in code.
