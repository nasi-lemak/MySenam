# ADR 0026: The same venue policies on every booking path, with audited manager overrides

- **Status:** current, decided 2026-10-28 by the product owner (an approved
  business and architectural decision). It settles the open question "the
  counter and the venue's API are held to the house rules…" in
  [known limitations](../../roadmap/known-limitations.md). Amends
  [ADR 0025](0025-benefits-and-privileges-by-scope.md) where it let a
  manager book a members' place past the person's membership, and let staff
  at the counter book anyone at a members-only or private venue. How staff
  and customers meet it is
  [the same policies on every path](../../features/booking.md#the-same-policies-on-every-path)
  and [manager overrides](../../features/booking.md#manager-overrides).
- **Context:** the booking form, the counter, the venue's API key and the
  waiting lists asked the venue's policies through one function
  (`customerMayBook`), but with differences nobody had decided: the counter
  and the API were not asked who may book a members-only or private venue;
  the API passed a number past its no-shows, and the guest limit, wherever
  the venue took payment online (online such a booking is held until paid;
  a key's booking was not held at all); the feature document said the
  counter was not held to the house rules and strikes while the code held
  it to them, with refusals worded for customers ("call the venue"). The
  waiver was not asked on a waiting-list claim, the members' window was said
  not to be asked again at the claim, and a class's waiting list asked the
  house rules while enrolling did not. The owner decided (28 October 2026):

  > Customer, counter and API bookings must enforce the same applicable
  > venue policies by default. These include house rules, no-show
  > restrictions, guest limits, refusal lists, unpaid-booking limits,
  > membership eligibility, safety requirements, resource capacity and
  > availability. Simply using the counter or an API key must not bypass
  > these rules. Allow appropriately authorised managers to override
  > selected operational restrictions where the venue permits this. […]
  > Every override must record the manager, reason, affected booking,
  > policy and audit history. Do not automatically grant these powers to
  > front-desk staff or ordinary API keys. Do not allow overrides of
  > database integrity, physical capacity, tenant isolation, mandatory
  > safety prerequisites for unmanned access, or payment integrity. Refused
  > customers and unpaid-booking restrictions should remain enforced on
  > normal paths. Use review, debt-resolution or refusal-removal workflows
  > instead of bypassing them.
- **Decision:**
  - **One policy check, every path** (`policyCheck` in `src/lib/limits.ts`;
    `customerMayBook` and `mayBookOn` are its customer and per-path forms):
    the venue open, who may book a members-only or private venue, the house
    rules, a weekly booking's account, the guest limit, a blocked number,
    no-show strikes and the unpaid-bookings limit, in one order, for the
    booking form, the counter (court time, groups, lessons, class places and
    terms), the venue's API key and waiting lists (join, offer, claim). The
    booking engine asks the rest the same on every path as before (the
    court's rules, sign-offs, a members' place, capacity and availability in
    the database).
  - **The path decides only what the path can do.** Who may book a
    members-only or private venue is the account online; at the counter and
    through the API it is the person booked: the number, on the venue's word
    (a membership or a place on the list on every date booked), or each
    person named where only they take places; staff are never asked to sign
    in as the member (B20 stays fixed). Where online a booking is held until
    paid (strikes, the guest limit), the counter takes payment as it books
    (`paidAtCounter`), and the API, which takes no money, is refused. A
    waiting-list claim is made by the customer through its link, so it is
    paid as online whoever made the entry; a class place is never held
    until paid, so strikes refuse it online, as enrolling does.
  - **Refusals are said for their path** (`saidOn`): as the customer is told
    online; at the counter under codes of their own (`R9_DESK_…`) saying
    what staff can do; through the API under the form's code, with words for
    a system.
  - **Manager overrides**, per booking, of at most four operational
    restrictions: the house rules' limits on bookings at once, a week and a
    day; no-show strikes; the guest limit; and an assisted weekly booking for
    a customer without an account (`src/lib/policy-overrides.ts`). Each is
    off until a manager turns it on for the venue (`venue_override_permissions`,
    migration 0208, a manager's setting). The request names the policy and a
    reason (5–300 characters); the server checks that the refusal is one the
    policy answers for, that the venue permits it, and that the member of
    staff is a manager of that venue. It is written in the booking's own
    transaction (`booking_policy_overrides`, migration 0209: venue, booking,
    policy, refusal code, reason, manager by id and name, time) and in the
    activity log (`booking.policy_overridden`), and shown on the booking.
    Front desk never overrides; an API key never does, and any override
    field it sends is refused rather than ignored.
  - **Never overridable**: a blocked number (unblocking is the workflow, a
    manager's, and now records who and why); the unpaid-bookings limit
    (taking payment for one, or cancelling one); eligibility for a
    members-only or private venue and a members' place, which the court's
    rules override no longer goes past either; the venue being open and the
    booking window; the waiver, and safety prerequisites for unmanned access
    (the door code still waits for the person's own sign-off however the
    booking was made); capacity, availability and linked resources, tenant
    isolation and payment.
  - **Waiting lists ask what the booking would**: the waiver at the claim,
    where the booking is made (the offer standing while it is ticked);
    the members' window again at the claim; a class's queue, its offer and
    claim the house rules, as enrolling now does.
- **Consequences:** staff can no longer book a number past its strikes or a
  flood of guest bookings without either taking payment or a manager's
  recorded override; a venue's integration cannot book what its counter
  could not. Weekly bookings at the counter stay refused for a customer
  without an account unless a manager books them as assisted, where the
  venue allows it. A class enrolment is asked the house rules for its date
  (only court bookings are counted). A members' place can no longer be
  booked by a manager's court-rules override without the person's
  membership. The refusals staff see changed codes at the counter (the
  form's codes are unchanged online and through the API). Staff moves of a
  booking are not asked the house rules (unchanged); overrides are not in
  the bookings export (the activity log carries them).
- **Alternatives considered:** exempting staff and the API from the house
  rules, strikes and the guest limit (the owner ruled it out); a separate
  policy engine for staff (two engines drift); letting front desk override
  with a manager's PIN (a power the owner did not grant to the desk);
  overrides as a role-wide power rather than a venue's setting (the owner
  asked that the venue permit it); letting an override go past a blocked
  number or the unpaid limit (the owner named the workflows instead); asking
  the waiver at the waiting list's join (the version in force at the claim
  is what the booking needs, and the claimant is the customer whoever made
  the entry).
