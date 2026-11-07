# ADR 0072: A host's no-show mark is told, answered and reviewed, and counts at its own venue; coaches are told of every lesson; what ends and what is struck is seen

- **Status:** current, decided 2026-11-07 for the post-audit hardening round on audit 9's findings F6 (owner's decision DEC-50, authorised: the notice, the answer, the review, the audit trail and the
  venue-scoped effect), E16, D11 and G16 (staff visibility and email, the small part), and D13 (documented only, DEC-39 is open); built in migration 0341. What players and hosts see is in
  [open games and matchmaking](../../features/matchmaking.md#no-show-marks); staff see it in [the venue's needs-attention list and its No-show marks panel](../../features/venue-operations.md#people-needing-attention);
  the coach part is in [programmes](../../features/programmes.md#a-coachs-own-schedule-no-account-needed); the emails are in [messaging](../../integrations/messaging.md#no-show-marks-and-what-ends-soon);
  the routes are in [the HTTP API](../http-api.md). Builds on [ADR 0016](0016-matchmaking-on-open-games.md) (open games, one row per person per game), [ADR 0056](0056-outbox-reliability-messages-survive-outages-and-stops.md)
  (the outbox) and [ADR 0057](0057-staff-lookups-masked-secrets-and-an-audit-trail-for-owner-decisions.md) (decisions are logged). Every number below is a constant in `src/lib/no-show-marks.ts` and is open to
  the owner to change.
- **Context:** a host could mark any accepted player a no-show once the game had started. It told the player nothing, recorded no reason and no reviewer, could not be cleared by anyone, counted at every
  venue on the platform, and three in 90 days refused the player every open game. A host's misclick, a game the venue had moved, or a rival host could drive a person off the platform, and only the
  database could undo it. Separately, a coach with no email address, or one whose address was set late, never heard of the lessons booked more than two days earlier, and the coach report counted a lesson
  next month as one that had gone ahead. And a customer learned that a pass or membership was about to lapse, or that a no-show had been recorded against their number, only when the next booking was
  refused or held.

## Decision 1: a mark is a record on the player's row of the game, with a reason, a venue and a status

- No new table: `open_game_players` gains `no_show_status` (`in_force`, `disputed`, `upheld`, `reversed`, `withdrawn`), `no_show_scope` (`venue`, `platform`, `legacy_platform`), `no_show_venue_id`, the host's
  reason and the time it was made, the player's answer and its time, and who reviewed it, when and why (`no_show_platform_note` is the owner's justification for a mark that counts everywhere). `no_show`
  stays 1 while a mark exists and is not taken back, so every older reader of the flag still reads it as one, and is set to 0 when it is reversed or withdrawn. The row, the reason and the history stay.
- The host must give a reason (3 to 300 characters; refused otherwise, `NS_REASON`). The player is shown it. A mark can be made only within 7 days after the game (`NS_TOO_LATE`), by the game's host, for a player
  who was in it; making it twice is a no-op and tells nobody twice. A host can make at most 12 in 7 days (`NS_HOST_LIMIT`, 429).

## Decision 2: a mark counts at its venue, and everywhere only by the platform owner's reviewed decision

- Three marks in 90 days that **count where the game is** refuse a player the games at that venue. A mark counts when it is `in_force` or `upheld`; one the player has answered (`disputed`) does not
  count until it is decided; a reversed or withdrawn one never counts. Suggestions and the host's suggested players use the same rule (`NO_SHOW_COUNTS`, `NO_SHOW_HERE` in `src/lib/games.ts`): a player is left out of a
  venue's games, not of every venue's.
- A mark counts at every venue (`scope = platform`) only when the platform owner decides so, with a written justification kept on the row and in the staff activity log (`no-show.reviewed`). A venue's
  manager cannot. Nobody else's decision widens a mark.
- **Marks that existed when the migration ran** stay in force and are scoped to the venue of their game; their host, time and reason are not known and are left empty, never made up (a reviewer reads "recorded
  before reasons were kept"). `legacy_platform` is for a mark whose venue cannot be found, which the foreign keys make impossible for a game that still has its booking; it counts everywhere as before and only the owner can
  review it. A mark written by a server still on the old code after the migration has run (no status) is read the same way. The effect of the owner's decision on those who had marks at several venues is
  that three marks spread over three venues no longer stop anyone anywhere.

## Decision 3: the player is told and can answer; the venue's manager reviews; the host can take back their own

- **Told:** on a mark, on its reversal, on its being let stand and on its being made to count everywhere, by email (`no_show_notice`, in the account's language, English, Malay, Chinese and Tamil), with the host's
  first name, the game, the reason, where it counts, and how to answer. Not held to the day's limit per recipient. **A minor:** an account that said it is under 18 is not emailed (as the venue's other notices to account
  holders), and nothing new is said to anybody about a child: the marks are on that account's own *My games* page, and the venue's manager sees them. No guardian link exists for such an account, so no guardian is
  written to here: recorded as a limitation.
- **Answered:** the player says what happened (3 to 500 characters), once per mark, from *My games*. From then until it is decided it does not count. A player can have 3 answers waiting at once (`NS_OPEN_LIMIT`)
  and, after 3 answers in 180 days that a reviewer let stand, cannot answer new marks in the app (`NS_DISPUTE_CAP`): the refusal says to ask the venue. An answer to a mark already decided is refused.
- **Reviewed:** by a manager of the game's venue (front desk cannot) for a mark that counts at that venue only, by the platform owner for any. Decisions are *reverse*, *uphold*, and for the owner *platform* (count
  everywhere, with the justification). A note is required and kept; a reversal of a mark a reviewer had let stand is still possible. Every decision is in the staff activity log and the player is told. Two decisions at
  once, or an answer and a decision, or a mark and the host's own reversal, are serialised under the player's row (serializable transactions and a row lock): one wins and the other is refused or finds the state it
  produces; a mark taken back cannot be made again.
- **The host can take back** a mark they made that no reviewer has yet decided (a misclick): it becomes `withdrawn`, the player is told, and it is not counted against the host. A mark a reviewer let stand is the
  reviewer's to undo.
- **Hosts with many reversed marks** (3 or more reversed by reviewers in 180 days) are listed to the venue's staff, for their own venue's marks, and to the owner. Nothing is done to them automatically: it is a
  prompt for a person, not a ban.

## Decision 4: coaches are told of every lesson to come, and the coach report keeps what is owed apart from what is booked

- `notifyCoaches` tells a coach of every confirmed lesson still to come that they have not been told of, however long ago it was booked (it looked only at the last two days, so a coach whose address was added later never
  heard of the rest). `coach_lesson` emails are no longer held to the day's limit of 8 per recipient: the address is one a manager gave, and a limit would have written a backlog off for good (a written-off message
  had its key and counted as told).
- Coaches with lessons to come and **no email address** are on the needs-attention list with how many lessons, from when, and whether they have a schedule link; adding the address tells them of all.
- The coach report counts as owed only lessons that **have ended**, on the venue's own clock. Lessons in the period still to come are `scheduled…` columns, and the lessons file says *Scheduled*. Existing tests
  that expected a lesson next week to have gone ahead were changed. The register's absent marks still feed nothing, by design ([attendance](../../features/venue-operations.md)).

## Decision 5: what ends and what is struck is on staff's list, and customers with an account are written to once

- Staff see, in needs-attention: passes with entries left, memberships that will not renew themselves, and gift vouchers that end within 14 days; passes down to their last 2 entries; numbers with a strike in the last 7 days or at the
  venue's limit. Nothing is built that is not listed: no second reminder, no campaign, no WhatsApp (no template exists), no voucher email (a voucher has only the buyer's address).
- An adult's account is emailed once (`customer_notice`) for each pass or membership that ends within 14 days, keyed by the item and its end date (an extension is a new date and a new notice); not for an item under 7
  days old, a membership that renews itself, has a later term, or is suspended, or a pass used up. A customer whose booking staff mark a no-show, at a venue that counts strikes, is emailed once with which strike it is, what
  happens at the limit and whom to ask (the account's own address, or a guest's on the booking). Held to the day's limit like any other, so it cannot be used to flood somebody's inbox.

## Decision 6: strikes by phone number are described, not changed (D13)

- The number as a customer's identity for strikes (`strikesFor`, `struckOut`) is unchanged: DEC-39 is open. The behaviour is documented and tested (`tests/standing-notices.test.ts`): three no-shows by an earlier
  owner of a number strike out the next person on it, at that venue only. The audit's options (account-owned standing, per-strike provenance for the desk) are not built.

## What was left open

- Whether a mark's consequences should also be seen by the guardian of an under-18 account (there is no guardian link on such an account); whether the 7-day mark window, the limit of 12 a week, 3 open answers and 3 lost
  answers are right; whether three reversed marks should do more than show a host to staff.
- A strike by late cancellation is the customer's own act and is not emailed; there is no email for a gift voucher; a pass's second reminder close to the end.
- Real delivery of every email here is unverified (`INTEGRATION_VERIFICATION_REQUIRED`: email); the tests read the outbox.
