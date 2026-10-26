# ADR 0020: Approval is eligibility, not payment; door codes never bypass it; who may grant it, and taking it back

- **Status:** current, decided 2026-10-26 by the product owner. Amends
  [ADR 0019](0019-approval-requests-apart-from-bookings.md) where it says a
  booking made on approval is not held for payment, and where it lets a coach
  decide at their private link. How customers, staff and coaches use it is
  [registering online for approval](../../features/activities.md#registering-online-for-approval).
- **Context:** ADR 0019 made an approval application its own record that
  writes the sign-off the booking rules check. Three things it left were not
  what the owner wants. A booking made on approval was an ordinary unpaid
  booking even at a venue that asks payment online to hold one, so approval
  bypassed the venue's payment policy. Any member of staff could approve any
  application, front desk included, whatever the activity's risk. A coach
  decided by possession of a private link, stored in plain text and with no
  end. Separately, the door-code check read the rules of a resource's main
  activity, not of the activity booked, and ignored an activity the venue
  takes approvals for when its booking rules did not ask for a sign-off; and
  nothing said what happens to bookings when an approval is taken back.
- **Decision:**
  - **Approval establishes eligibility, never payment or a guaranteed
    booking.** On approval the slot asked for is rechecked through the
    ordinary booking path (`createBookingSeries`: the database decides). The
    booking it becomes follows the venue's own payment policy
    (`lib/holds.ts`): where the venue asks payment online to hold a booking,
    it is held by the existing booking hold (`bookings.hold_until`) for the
    activity's payment hours (`approval_requirements.pay_hours`, 24 unless
    set, never past the slot's start; the venue's own minutes when the
    customer books the in-person session there and then), confirmed by the
    ordinary confirmation when paid, and let go by the ordinary release when
    not; the application's slot reads `awaiting_payment`, then `booked` or
    `payment_lapsed`. Where the venue takes payment at the counter, or the
    booking is free, it stands as any booking there does. A member of staff
    may approve without the hold (`payLater`), an exception recorded in the
    application's history and the activity log; a coach may not. No path
    makes a permanently confirmed unpaid booking at a venue that requires
    prepayment.
  - **A slot gone at approval leaves the approval valid.** Nothing is
    forced or displaced: the slot reads `taken`, the customer is told, and
    books another time through the ordinary booking engine, which their new
    sign-off now lets them do.
  - **A payment never ends without a booking or an obligation.** Paid in
    time, the booking stands. Paid after the hold was let go (a Billplz page
    cannot be closed), the existing settlement records it as owed back; then,
    in one transaction under the application's row lock and the payment's
    row lock, if the approval still stands and the slot is still free, the
    booking is made again through the ordinary path, marked paid with that
    payment, linked to it, and the amount owed back reduced by what it now
    costs (never below what was already refunded); otherwise it stays owed
    back under *Refunds owed* and the customer is told. Each outcome is
    written once, keyed to the payment, so a webhook told twice, the
    redirect and callback together, or the scheduler retrying after an
    interruption change nothing more. A booking staff cancelled, or one let
    go on revocation, is never revived. A late deposit stays owed back. A
    held booking with a deposit paid is never let go as unpaid.
  - **Four permissions, kept apart.** To record or manage a booking (staff,
    and a manager past the rules); to take part in an activity (a sign-off
    in force, which an approval writes); to receive unmanned access (that
    sign-off in force on the day, for the activity booked, on top of the
    door's own conditions); and to supervise an exception (a manager's
    *staff-supervised attendance*, `bookings.staff_supervised`, on record,
    which is never a door code and signs nobody off for later). The door
    check reads the booked activity's rules on a resource offering several,
    and an activity the venue takes approval applications for needs one at
    the door whatever its booking rules say. A pending, refused, lapsed or
    revoked approval is no sign-off, so it opens nothing, however the booking
    was made: online, at the counter, past the rules, through the venue's API
    key, as a coach's lesson, or before the approval.
  - **Administrative review and safety assessment are apart, per activity**
    (`approval_requirements.review_level`): `safety` (the default) is
    approved, and its in-person step recorded, only by a manager, a coach the
    venue names for the activity, or front-desk staff a manager delegates by
    name (`approval_delegates`); `administrative` by any of the venue's
    staff. Asking for more, recording the administrative check
    (`admin_checked_at`), refusing and revoking grant nothing, and any
    reviewer may. The same rule holds in the Sign-offs tab: front desk
    cannot record a sign-off for a safety-assessed activity it is not
    delegated for. Roles are the existing manager and front desk; MySenam
    certifies nobody.
  - **A coach decides only signed in to their own account.** A manager links
    the coach record to the coach's own MySenam account by its email
    (`coaches.user_id`); the coach reviews from their account's approvals
    page (`/api/my/reviews`). Their private schedule link decides nothing.
    This is proportionate: the account is the person's own (a hashed
    password or Google sign-in), its sessions expire and are stored as
    hashes, unlinking or retiring the coach ends it at once, and no new
    token exists to leak, hash, expire or rotate. Customer accounts have no
    two-factor sign-in, so a stolen coach password decides as the coach
    until the venue unlinks it; every such decision is attributed and
    revocable. The schedule link stays what it was: read-only lessons and
    the coach's own hours and time off. Scope is read from the database
    on every decision: the coach active, at the application's venue, named
    for its activity, and linked to the account deciding. Every decision
    records the coach record and the account (`approval_events.coach_id`,
    `user_id`); a staff decision the admin; and none gives any other power
    of the venue's.
  - **Revoking.** Staff (any) or a named coach revoke an approval in force
    with a reason: the sign-off it wrote is taken back, which stops online
    booking of the activity and its door codes at once; its own booking
    still waiting for payment is let go (never confirmed); the person's
    confirmed bookings of that activity there from today on are flagged for
    staff (`approval_booking_flags`), never cancelled silently, and staff
    cancel, supervise or keep each and say which. Taking the sign-off back
    in the Sign-offs tab does the same.
- **Consequences:** a customer approved at a pay-to-hold venue has a
  deadline and a payment page, and can lose the slot (not the approval) by
  not paying. A late payment can turn into a booking hours after the
  customer was told the slot was let go; they are told again. A coach needs
  a MySenam account, and a venue that relied on the link must link one.
  Front desk at a venue whose activities are left at the `safety` default
  can no longer approve them until delegated. Supervised attendance is
  recorded on the booking, not as a certification. Revocation leaves
  bookings standing until staff act on the flags; their door codes are
  already withheld.
