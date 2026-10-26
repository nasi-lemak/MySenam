# ADR 0023: Participants apart from accounts; eligibility owned by the participant

- **Status:** current, decided 2026-10-26 by the product owner (an approved
  architectural decision). Amends
  [ADR 0022](0022-children-managed-from-an-adults-account.md): its managed
  people become participants, and its consequence that a child rides on the
  adult's induction no longer holds. How customers and staff use it is
  [applying for somebody you manage](../../features/activities.md#applying-for-somebody-you-manage),
  [sign-offs](../../features/activities.md#sign-offs) and
  [inductions](../../features/venue-operations.md#inductions); what is held,
  who sees it and for how long is [privacy](../privacy.md#participants).
- **Context:** a reported defect: inductions stayed with the adult's phone
  number. The cause was in the model, the staff workflow and the lookup
  together. `inductions` was `UNIQUE (venue_id, phone)` (migration 0001), so a
  child shown round on a parent's number could only be filed as the parent
  (or refused as a duplicate); `/api/admin/inductions` had no way to name
  anybody but the number holder; and the door check (`accessCodeFor`) asked
  `isInducted(venue, booking.phone)`, so a booking for a child opened on the
  parent's induction, and a sibling's on either. More widely the code
  assumed the signed-in account, the booker, the payer and the person taking
  part were one person: `managed_people` (0135) belonged to one adult, a
  booking named at most one person (`bookings.participant_id`), and a child
  could have neither a second guardian nor, later, a login of their own
  without losing their history. The owner decided that participants are
  first-class identities, independent of login accounts; that eligibility
  (inductions, sign-offs, certifications, waivers) belongs to the
  participant; that contact details are never identity; and that nothing is
  merged or moved between people on matching contact details.
- **Decision:**
  - **A participant is a record of its own, by id** (`participants`, migration
    0138, renamed from `managed_people` so every reference follows;
    `src/lib/participants.ts`). It holds what the family or the venue gives:
    a name, a birth year only where an activity needs an age, where it came
    from (an account online, or a venue's counter: which venue and which
    staff member), and the participant's own login once linked. A name, a
    phone number or an email address is never its identity.
  - **The account holder taking part as themself has no participant row.**
    Their account, its number and its own records are them, exactly as
    before; nothing about an adult's own bookings, sign-offs, inductions or
    waivers changed. Materialising a "self" participant for every account
    would have meant rewriting every account-keyed and number-keyed record
    and every booking path for no gain in what is known. "Who took part" has
    one answer: a booking's rows in `booking_participants`, or, where it
    names nobody, its customer.
  - **Who may act for a participant is a relationship**
    (`participant_guardians`): a guardian's account, or a guardian a venue's
    staff recorded by name and number only; the relationship and authority
    as declared and when; how it was established (`online` by the account
    holder, `counter` to named staff, `staff_review`), who recorded it; and,
    once ended, when, by whom and why. A child can have two guardians. A
    changed relationship is a correction: the old row ended (`Corrected`), a
    new one made. Archiving is per guardian. Ending (by the guardian) or
    revoking (by a venue's manager, with a reason) stops that guardian
    acting: no new booking, application or code for the participant, their
    applications still waiting withdrawn, their unused codes cancelled;
    nothing they made is deleted. Every existing managed person's adult
    became their `online` guardian with the original declaration and times.
  - **A second guardian, and the participant's own login, only by agreement
    of both sides.** A guardian gives a code (`participant_invites`: hashed,
    one use, a week): another adult accepting it declares their own
    relationship and authority and becomes a guardian; the participant's
    own account accepting a `link` code becomes their login (one participant
    per account, unique). A venue's manager may link a participant it knows
    to an account named by email, with a reason. A code from somebody who no
    longer acts for the participant is void. After linking, the account's
    eligibility includes the participant's and the participant's includes the
    account's own (the same person): sign-offs, inductions (by the number the
    account proved) and waivers; their bookings stay theirs; the guardians
    carry on until they stop. Who may end a guardian's relationship over a
    linked adult participant is left to staff for now (see consequences).
  - **Bookings name everybody taking part** (`booking_participants`, 0139):
    one row per participant taking a place, and one for the customer only
    when they take a place alongside others. A booking with no rows is taken
    by its customer alone, as every booking always was. Every existing
    `bookings.participant_id` became a row, added by the booking's account;
    a name left where the person had gone was kept with no participant. The
    booking rows, their money and their customer were not touched.
    `bookings.participant_id` and `participant_name` remain, as a summary a
    trigger keeps from the table (the first participant; everybody's
    names), the same pattern as `courts.activities` (0092), because eighteen
    read paths show one line per booking; no code writes them, and every
    eligibility check reads the table. `createBookingSeries` takes
    `participants`, `customerTakesPart` and `addedBy`: each participant takes
    a place and is checked on their own sign-off; the customer's own is
    checked only when they take part. The existing single-child paths (the
    online booking route, an approval's slot) go through it unchanged.
  - **Inductions belong to the person inducted** (0140). An induction is the
    number holder's own (every existing row, as before; one per number and
    venue) or a participant's (`participant_id`, `for_participant`; one per
    participant and venue), the number being a guardian's, to reach them.
    The door asks for the induction of everybody taking part. A participant's
    induction stays a participant's when their record goes (it then counts
    for nobody), so it can never turn into the number holder's.
  - **Older ambiguity is flagged, never resolved by guessing.** Migration
    0140 flags (`review_reason = 'shared-number'`) a number-keyed induction
    in force whose number is that of an account managing a participant and
    whose name is not the account holder's. It stays the number holder's.
    A manager decides with the audited tool (`PATCH
    /api/admin/inductions/[id]`): give it to a participant the venue knows
    whose guardian is on that number (keeping the name it was filed under),
    or confirm it is the holder's own; a reason is required; who, when and
    why are kept on the row, in the participant's history and in the
    activity log. One induction at a time, one venue, never automatic.
  - **Sign-offs, certifications and waivers were audited the same way.** A
    participant's counts for them alone, at the counter and online (online
    only for an account that acts for them); the number holder's (by number
    or account) never counts for a participant on that number, nor theirs
    for the holder. Staff can now record one for a participant
    (`participantId` on `/api/admin/sign-offs`) instead of under the
    guardian's number; recording again replaces that participant's only. An
    approval for a participant still writes their sign-off, and only one
    application per participant, activity and venue may be live, whichever
    guardian made it (a unique index). Waivers already kept the participant
    apart; a linked login's own agreement now counts for them.
  - **Recognition stays the venue's policy.** A sign-off counts at the branch
    that gave it, or every branch of its business where given for all of
    them; an induction at its venue; nothing from one venue is accepted by
    another. The application (and its documents and review), the guardian's
    declaration, the issued sign-off or certification (participant,
    activity, issuing branch or business, start, expiry, revocation, who and
    why) and a booking stay separate records.
  - **Venues' own participants** (for the counter and the venue's API key,
    whose booking paths come next): `createAtVenue` records a participant
    with a guardian named by contact details only, the staff member who
    recorded the declaration, and the venue. A participant is visible to a
    venue that added them or has a booking, application, sign-off,
    induction or waiver for them (the business's other branches too, as
    sign-offs are shared), to their guardians and to their own login; never
    to other venues. Staff find participants only by a guardian's number,
    as candidates to choose from (`participantsForVenue`), never by
    browsing, and never as a match that decides anything.
  - **Who did what.** `participant_events` records each change to a
    participant (created, edited, a guardian added, corrected, ended or
    revoked, codes given, linked, an induction assigned): who, on whose
    behalf, at which venue. Staff actions also go to the activity log.
    The roles are kept apart: the account holder (`users`), the
    participant (`participants`), the booker (`bookings.user_id`, name and
    number; `booking_participants.added_by_*`), the payer (the booking's
    payments, as before), the guardian (`participant_guardians`), the
    instructor or assessor (`sign_offs.admin_id`, approval reviewers), and
    the staff member acting (the activity log). No separate emergency
    contact is collected: nothing in the product uses one.
  - **Privacy.** A participant is never discoverable (no user record: not in
    player search, suggestions, profiles or invitations; a booking naming
    one is never an open game) and is shown to nobody but their guardians,
    their own login and the venues they have dealings with. An account's
    export holds the participants it manages with their record, the
    relationships it ended, and, for a linked login, the participant's own
    record. Erasing a guardian removes their relationships; a participant
    another guardian (an account or one a venue recorded) acts for, or whose
    own login is linked, stays with everything that is theirs; one left with
    nobody, and no application, is erased, what was in force for them taken
    back and the venue's records unlinked. A participant nobody acts for, or
    one a venue added that nobody uses, goes a year on once nothing rests on
    them. Nothing extra is collected to complete the model.
  - **Names kept.** The columns that point at a participant on
    `approval_requests`, `sign_offs` and `waiver_signatures` keep their
    0135 name, `managed_person_id`, so that the code and queries of other
    work in flight did not have to change with them.
- **Consequences:** a child's induction, sign-off, certification and waiver
  are theirs, whichever parent's number they were recorded on; two children
  sharing a parent's phone, email and surname stay distinct; a child can
  have two guardians and later their own login without losing anything. A
  phone number at the counter finds candidates and never decides. Older
  family inductions stay the number holder's until a manager decides. Still
  assuming the signed-in account (or number) is the person, outside this
  decision's scope and listed for later: the waiting list, open games
  (bookings naming a participant are refused), tournaments and leagues
  (account entries with a declared guardian), memberships and passes (held
  by number or account, so a child's membership priced on a parent's
  number), class enrolment and coaching from the customer's page,
  equipment hire, check-in and no-shows (one per booking, not per person
  taking part), booking emails (they do not name the participant), and the
  counter and the venue's API key, which still book for the customer only
  (the library they need is in place). Another guardian does not see an
  application the first one made. Whether a linked adult participant may end
  a guardian's relationship over them themself is not decided: staff can.
- **Alternatives considered:** a second table of participants beside
  `managed_people` (two identity systems to keep in step); a participant
  row for every account, the adult included (every account-keyed and
  number-keyed record rewritten, and a second identity for the same
  person); keeping `bookings.participant_id` as the record (one person per
  booking); giving existing family inductions to children by matching names
  or numbers (exactly the inference the owner ruled out); dropping the
  summary columns on `bookings` (every booking read rewritten for no change
  in what is known).
