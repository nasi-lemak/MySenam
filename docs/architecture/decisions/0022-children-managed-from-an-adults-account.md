# ADR 0022: Children managed from an adult's account; their eligibility is their own

- **Status:** current, decided 2026-10-26 by the product owner; amended by
  [ADR 0023](0023-participants-apart-from-accounts.md) (managed people are
  participants with guardian relationships of their own; inductions belong
  to the participant, so a child no longer rides on the adult's). Builds on
  [ADR 0019](0019-approval-requests-apart-from-bookings.md) and
  [ADR 0020](0020-approval-to-booking-payment-and-authority.md), and keeps
  [ADR 0016](0016-matchmaking-on-open-games.md)'s rule that minors are found
  or invited only through a group both sides agreed to. How customers and
  staff use it is
  [applying for somebody you manage](../../features/activities.md#applying-for-somebody-you-manage);
  what is held and for how long is in
  [privacy](../privacy.md#people-an-adult-manages).
- **Context:** an applicant under the install's guardian age applied from
  their own account and typed a guardian's name. A parent could not apply,
  book, agree to a waiver or be told for a child from the parent's own
  account without making the child an independent login, with an email and
  a phone the child may not have and should not need. The owner approved
  the parent/guardian workflow: the adult's own account; minimal child
  data; a relationship and authority declaration; registration, waivers,
  consent, activity approvals, documents, status, notifications, booking
  and attendance; children not exposed to discovery; a parent account is no
  proof of guardianship, so verification or staff review where an activity
  needs it; no universal age-threshold claims; one child's eligibility never
  another's or the parent's.
- **Decision:**
  - **A managed person is a small record under the adult, never a user**
    (`managed_people`, migration 0135; `src/lib/managed-people.ts`): a name
    the family uses, a birth year only where an activity needs an age, the
    relationship the adult declares (parent, legal guardian, or another
    person with authority) and when the adult declared their authority to
    act for them. No email, phone, photo, school or identity number: the
    code refuses those fields rather than ignoring them. Everything is the
    adult's word, recorded as declared and never as verified. The adult
    adds, changes, archives and brings back their people from `/account`;
    another account can neither see nor act on them.
  - **The adult applies for them through the same application**
    (`approval_requests.managed_person_id`, the relationship as declared then,
    `authority_declared_at`). The adult is the applicant and the guardian on
    it, filled from their account rather than typed; documents, status,
    history and email all go to the adult, the email saying which person it
    is about. One live application per person, activity and venue: the
    adult's own and each child's apart.
  - **Staff review of authority, where the activity asks it**
    (`approval_requirements.guardian_check`, default off). Then approval
    waits until a reviewer records that they reviewed the adult's authority
    (`authority_reviewed_at`, an event in its history and the activity log),
    under the same rule as granting: a manager, a coach named for the
    activity, or front desk delegated for it (any staff for an
    administrative check). Never automatic, and nothing is uploaded or kept
    for it but the reviewer's note: MySenam collects no identity documents.
  - **Eligibility belongs to the person.** The sign-off an approval writes
    carries `sign_offs.managed_person_id`: linked to the adult's account and
    reached on the adult's number, but counted only for that person.
    `signOffHolds` with a participant counts only that person's (online, one
    the adult's account holds for them); without one, never a sign-off
    written for somebody managed. So a child's approval never books or opens
    a door for the parent or a sibling, and the parent's never for the
    child. The unique index on live sign-offs and the replacement on
    renewal are per person too.
  - **Bookings record who takes part** (`bookings.participant_id`,
    `participant_name`) on the paths approvals already gate: the slot booked
    on approval, and the ordinary booking (`participantId`, one court) whose
    sign-off check then reads the participant's. Rescheduling, the door code
    (`accessCodeFor`) and revocation's flags use the participant's
    eligibility; staff see the child's name, booked by the adult. Revoking a
    child's approval flags that child's bookings only.
  - **Waivers and consent** are the adult's, on the person's behalf: the
    existing signature records the adult (name and number) as signer and
    the person (`managed_person_id`, `participant_name`) as participant, and
    counts for that person only; the adult's own agreement stays apart.
  - **Never in discovery.** Managed people have no user row, so player
    search, suggestions, profiles and invitations cannot reach them; a
    booking made for one cannot be opened as an open game.
  - **Retention follows the existing purposes.** A child's application is
    an application (ADR 0021); its minimised form drops the authority
    declaration. Archiving deletes nothing; an archived person goes 365 days
    later once no application, sign-off in force or booking to come rests on
    them. Erasing the adult erases their people, takes back any sign-off
    still in force for them first, and keeps waivers signed for them as the
    venue's record of consent.
- **Consequences:** a parent manages children from one account, and a
  child needs no login. Approvals, documents and messages are the adult's to
  see; an adult who loses the account loses the children's records with it.
  Ages remain whatever an activity's rule or the code's configured guardian
  age (`GUARDIAN_AGE` in `src/lib/tournaments.ts`) says, never a legal fact
  the code asserts. A venue that needs guardianship checked turns the review
  on and does it its own way at the counter. Inductions for unstaffed use
  are still filed against the adult's number, so a child at an unmanned
  resource rides on the adult's induction. Only the booking paths approvals
  gate know the participant: the waiting list, open games, a booking of
  several courts at once, counter bookings and the venue's API key book for
  the adult only.
- **Alternatives considered:** a child as a user without a login (a row
  every user query would have to learn to exclude, and an email column to
  leave empty); a parallel table of children's sign-offs (a second eligibility
  engine to keep in step with the first); typing the guardian's name on the
  child's own account, as before (the child needs an account, and nothing
  ties the guardian to anything).
