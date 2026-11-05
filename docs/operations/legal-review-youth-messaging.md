# Legal review: youth messaging

A checklist the owner can take to a Malaysian lawyer and to a child-safeguarding professional **before live
youth messaging is enabled**. It is not legal advice and settles nothing: every item below is a question the
software **does not answer**, with what it does today as an **interim, conservative measure** so the question can
be asked about something concrete. Each item's status is **Pending legal verification**, and none is a software
defect. The decision behind the measures is [ADR
0052](../architecture/decisions/0052-youth-messaging-interim-safeguards-pending-legal-review.md) (which amends
[0049](../architecture/decisions/0049-guardians-in-conflict-and-a-reported-adult-is-not-told.md) and
[0044](../architecture/decisions/0044-supervised-group-messaging-for-minors-and-a-digest.md)); what people see is in
[messages between players](../features/player-messages.md#interim-safeguards-pending-legal-review); the data and its
retention is in [privacy](../architecture/privacy.md#youth-messaging-evidence).

**Youth messaging is off in production** unless `YOUTH_MESSAGING_LAUNCH_APPROVED=yes`; adults' messaging is
unaffected either way. Ages, guardians' agreement and self-declared categories are the person's word, recorded as
declared, never verified, and **no identity or custody document is collected or stored**.

## 1. Guardian authority and conflicting instructions

- **The question.** Which guardian's instruction governs a child's messaging when guardians disagree, and what
  does a guardian with restricted authority keep?
- **Today (interim).** Any guardian whose link lets them object can switch a child's group messaging off; another
  guardian cannot switch it back on alone; it needs every guardian who decides, or a safeguarding administrator's
  settlement with a reason, and then a guardian's own consent. A disputed or unclear authority keeps messaging off.
  `YOUTH_REVIEW_DAYS` (7, operational) opens an authority review for a conflict left unresolved.
- **Advice needed.** Whether "off unless all who decide agree" is acceptable; what authority a non-custodial parent
  or other carer has; whether a disagreement needs any record beyond who, what and when.
- **Who decides.** The owner, on a lawyer's advice. **Status: Pending legal verification.**

## 2. Custody-document verification: who may verify, and to what standard

- **The question.** Must the operator see a custody or guardianship document, who may do so, and what standard of
  verification applies?
- **Today (interim).** Each guardian link carries a recorded decision: a status (`asserted`, the default and only
  what was declared; `verified`; `disputed`; `unclear`), a basis (`parent`, `legal_guardian`, `other_authorised`,
  `not_stated`) and what it removes from the guardian's say (`none`, `may_object_only`, `no_messaging_say`). **A
  restriction takes effect only on a verified decision**; an asserted one sets the link to `unclear`. The
  interim authorised operators are a venue's manager for a child the venue manages, and the platform's owner;
  never a supervisor, a guardian of the child, or staff who are the same person as either. The standard is
  stored as the constant `interim: pending legal review`, with who and when. **MySenam does not interpret custody
  orders or make legal determinations**; it applies the operator's recorded decision and keeps no document.
- **Advice needed.** Who may lawfully verify; the exact standard; whether the venue may hold the supporting record;
  what to record and for how long.
- **Who decides.** The owner, with the venue agreement. **Status: Pending legal verification.**

## 3. Interim restrictions on adults, and notification obligations

- **The question.** What may be done to an adult reported in a youth conversation before any finding, and what are
  they owed (notice, reasons, timing)?
- **Today (interim).** A report restricts the adult's seat at once, as a **protective** restriction (temporary, **not
  a finding**); a moderator may convert it to a **decision** with a recorded reason. No notice of a report reaches
  them by any channel; they see one neutral line, the same for any cause, and a moderator alone chooses what, if
  anything, to tell them. A protective restriction has a review date (`YOUTH_PROTECTIVE_REVIEW_DAYS`, 7, operational,
  **not a legal period**); past it unreviewed it is escalated to the platform's owner and **never lifted or
  converted automatically**.
- **Advice needed.** Whether a protective restriction without notice is lawful; what the adult is owed and when;
  how long a restriction may stand.
- **Who decides.** The owner, on a lawyer's advice. **Status: Pending legal verification.**

## 4. Reporter confidentiality, and review and appeal rights

- **The question.** How far must the reporter's identity and the report be kept from the reported adult, and what
  right of review do they have?
- **Today (interim).** The reporter's identity and the words reported go only to safeguarding personnel, and appear
  in no review item, escalation notice or owner email. A restricted adult can **ask for a review** from the neutral
  line (one short text; nothing of any report is shown or asked); it goes to somebody who did not apply the
  restriction (a different manager, else the platform's owner), is decided with a reason, and the adult is told only
  that it was received and the outcome. **Rights to review and notification are pending legal review**; nothing here
  promises either.
- **Advice needed.** What review or appeal is owed; the form and timing; the limits of confidentiality.
- **Who decides.** The owner. **Status: Pending legal verification.**

## 5. Mandatory reporting and safeguarding escalation

- **The question.** Are there duties under Malaysian law to report suspected abuse or an incident, to whom, by whom,
  and by when?
- **Today (interim).** A moderator can **Escalate (safeguarding)** with a fixed reason (suspected abuse, imminent
  danger, a possibly reportable incident, other): the owner is told at once, and who, when and why are recorded.
  The case shows static guidance: *if a child is in immediate danger, contact the emergency services (999) now;
  whether and how an incident must be reported to the authorities is pending legal review; follow your own
  safeguarding policy.* **Nothing is sent to any authority by MySenam**, and no statutory body or contact is named.
- **Advice needed.** Reporting duties and who carries them (MySenam, the venue, the organiser, a supervisor); what
  must be reported and how; what the guidance should say.
- **Who decides.** The owner, with the venue agreement. **Status: Pending legal verification.**

## 6. Evidence retention, deletion, preservation and legal holds

- **The question.** How long may safeguarding evidence be kept, when must it be deleted, and what must be preserved
  for an inquiry?
- **Today (interim).** Four classes are kept apart. Ordinary message retention (`YOUTH_MESSAGE_RETENTION_DAYS` 60,
  `YOUTH_REMOVED_RETENTION_DAYS` 30) is an **operational default pending legal approval** and never deletes an active
  case. **No period is invented for safeguarding evidence or its audit records: they are kept** unless the install
  sets `SAFEGUARDING_EVIDENCE_RETENTION_DAYS` (which needs legal approval first, and then deletes only closed cases).
  Kept longer than `SAFEGUARDING_REVIEW_MONTHS` (12), the owner is asked to decide, never to delete. A **legal hold**
  (the owner only) stops retention and erasure deleting the covered evidence copy; erasing the person's account is
  never refused. *Legal preservation requirements are pending legal review.*
- **Advice needed.** Retention periods, preservation duties, the interaction with erasure rights.
- **Who decides.** The owner. **Status: Pending legal verification.**

## 7. Responsibility between MySenam and venue operators

- **The question.** Who is the controller or processor of youth messages, who sets the safeguarding policy, who
  verifies authority, who reports, and what do the terms and venue agreements say?
- **Today (interim).** The software assumes no allocation. The venue's managers (or the platform's owner for a group
  with no venue) act as safeguarding administrators; the app records who did what. The wording of every notice is
  provisional.
- **Advice needed.** The allocation, and the venue-agreement and terms wording that records it.
- **Who decides.** The owner, with a lawyer. **Status: Pending legal verification.**

## 8. Jurisdictional differences (Malaysia now, Singapore later)

| Ask | Malaysia | Singapore (future) |
| --- | -------- | ------------------ |
| Age of majority and of consent to messaging | to be asked | to be asked |
| Who has authority over a child; custody and guardianship | to be asked | to be asked |
| Mandatory reporting duties and recipients | to be asked | to be asked |
| Personal-data duties for children's data; notification and retention | to be asked | to be asked |
| Rights of a person restricted without notice | to be asked | to be asked |

*No content is invented here.* The install's country is set by the install; nothing in code branches on it for
these rules.

## Launch gate

Youth messaging stays **off in production** until the owner has: **the written advice** on items 1 to 8, **the venue
agreement terms** that record the allocation in item 7, **a safeguarding policy**, and **trained safeguarding
contacts** at each venue that looks after a group; and then sets `YOUTH_MESSAGING_LAUNCH_APPROVED=yes`
**deliberately**. The interim settings above (`YOUTH_REVIEW_DAYS`, `YOUTH_PROTECTIVE_REVIEW_DAYS`,
`SAFEGUARDING_EVIDENCE_RETENTION_DAYS`, `SAFEGUARDING_REVIEW_MONTHS`) are reviewed with the advice, not before; the
[configuration](../development/configuration.md) and the [launch checklist](deployment.md#before-going-live-what-only-a-live-account-can-prove)
carry them. English is the authoritative wording; the other languages are machine-assisted and await native review.
