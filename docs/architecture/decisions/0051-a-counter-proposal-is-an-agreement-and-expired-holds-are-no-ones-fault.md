# ADR 0051: Ladder court time: a counter-proposal is its maker's agreement and holds nothing; an expired or unanswered hold is no one's fault

- **Status:** current, decided 2026-11-05 at the owner's request. Built in migration 0293. What managers and players see is in
  [court time held by the venue](../../features/tournaments.md#court-time-held-by-the-venue-an-optional-setting-per-ladder).
  **Amends [ADR 0050](0050-ladder-agreement-counts-and-expired-holds-do-not.md)** (and through it [ADR 0048](0048-ladder-hold-limits-and-expiry.md)) in the places listed
  under *What this changes*. Builds on [ADR 0010](0010-interval-booking.md) (court time as claims under exclusion constraints) and
  [ADR 0002](0002-database-enforced-concurrency.md).
- **Context:** the owner decided two things. (1) "If Player A proposes a match time and Player B suggests a fully specified alternative, B's counter-proposal counts as B's
  agreement to that alternative. Player A must explicitly accept the new proposal before both parties are considered to have agreed. Do not require B to confirm their own
  unchanged counter-proposal again. However: present the court, date, time, duration and applicable financial obligations clearly; any material modification invalidates
  previous agreement to the superseded proposal; do not accept stale or superseded proposals; use appropriate concurrency and version checks; booking rules, eligibility,
  payment and availability remain authoritative; agreement does not itself guarantee a court reservation; only a successful booking or authorised booking hold reserves
  capacity." (2) "Do not automatically blame the creator of a hold or whichever player failed to confirm. An expired agreement or hold is not necessarily misconduct. Record who
  proposed, accepted, counter-proposed, cancelled or failed to respond, where that is genuinely useful; release expired holds promptly; do not count expired holds against
  concurrent active-hold limits; avoid punitive labels or restrictions for isolated timeouts; detect repeated abusive behaviour separately, such as repeatedly creating holds
  to block resources without completing bookings; apply reasonable, proportionate rate limits or temporary restrictions only when supported by an objective pattern; do not
  penalise a non-responsive player merely for declining or ignoring an invitation; distinguish actual court-capacity reservation from a proposed match that never reserved
  capacity." ADR 0050 had made a time the accepter named a counter-proposal that the proposer had not agreed, so the hold was made tentative and **both** confirmed it, and had
  counted holds that expired unconfirmed against the player who made them.

## Decision 1: a counter-proposal is a proposal

- **What it is.** On a ladder that holds court time, a player naming a **different, fully specified time** (a day and a start; the minutes are the ladder's) in answer to a
  proposal, by `propose` or by `accept` carrying a time of their own, or by `propose_move` over the other's request, makes a **counter-proposal**. It is **that player's recorded
  agreement to that exact specification** (`ladder_agreed_times`, role `countered`, written when it is made, with the revision it was made at), it **creates no hold and
  reserves no capacity**, it **replaces** the proposal before it, and it waits for the **other player's explicit acceptance of exactly it**. A time named where there was no
  proposal at all (the challenger asked for a day alone, or nothing) is the same: a proposal for the other to accept. A hold is never made on one player's say-so.
- **What accepting does.** The other player's `accept` (or `agree_move`) of exactly it is both players' agreement: the hold is made **confirmed**, once, through the one claim path
  (`makeHold`), taking up the counter's agreement row and adding the accepter's; the counter's maker is **not asked to confirm again**. If the claim is refused, nothing is reserved
  and the challenge is left as it was ("arrange a time": still pending, the counter still there to be answered, nobody's agreement lost).
- **What stays as ADR 0050 said.** A day alone, a time a manager chose and a hold a manager made: a day alone holds nothing; a manager's time is **tentative** where
  confirmation is on, and both players confirm it. So **a tentative hold can now only come from a manager**; a player's act never makes one.
- **Ladders that hold no court time** are untouched: a time named in answer is accepted as before (nothing is held, so nothing needs guarding).

## Decision 2: every proposal has a revision; a superseded proposal can never be accepted

- `ladder_challenges.proposal_rev` (1 for every challenge already in flow when the migration runs, so each keeps its current proposal) goes up whenever the proposal changes or
  ends: a counter, a move asked, agreed, declined or taken back, a challenge accepted, a manager's time, an expiry that clears the time. The challenge's own `version` stays as it
  was (it goes up on *any* change); the revision is the **proposal's**, so an unrelated change (a confirmation, an extension) does not make a proposal stale.
- Every act that answers a proposal carries the revision it saw (`rev`): `accept`, `propose`, `withdraw`, `propose_move`, `agree_move`, `decline_move`, `withdraw_move`, and
  the preview. Under the ladder's lock, one for a revision that is no longer current is refused **`LAD5_STALE`** (409) with the **current challenge returned** (`challenge`, so the
  page shows it again); nothing is agreed, merged or held.
- **A missing revision is refused** (`LAD5_REV_NEEDED`, 400) **by the API on a ladder that holds court time**, never taken as "current", because that could be a stale acceptance. (A
  stranger is still told nothing about the challenge: 404.) The functions in `lib/ladders.ts` check a revision when they are given one, as they check `version`; the route is the one
  caller that requires it. On a ladder that holds no court time the optional `version` stays the only check, as before.
- A **material modification** (the day, the start, the minutes held) creates a new revision that **ends every agreement recorded for the earlier specification**: the rows stay as
  history, flagged `superseded_at` with the reason, and never count toward a hold. This includes a manager's change (`hold_move`), and a change of the ladder's match length: a
  counter proposed at the old length is ended when it is accepted at the new one (`LAD5_TERMS`; nothing agreed or held).
- Players do not name courts, so the court is not part of a counter; an acceptance carries the court the player was shown and **that court is held or nothing is**
  (`LAD4_COURT_CHANGED`, ADR 0050), so the court held is the court on the screen. A manager who names a court makes a change of court, which is material.

## Decision 3: simultaneous counters

Two players countering at once each carry the revision they saw. The acts run under the ladder's row lock, so one runs first; the second finds the revision moved and is refused as
stale **with the first's proposal returned**. Nothing is merged, nobody's earlier agreement is reused, there is no tie and no hidden winner (the lock's order is the database's, as for
two bookings of one court). An acceptance racing a counter, a booking or a block ends the same way: one holds the court or none does, and the database's constraints decide.

## Decision 4: expiry

A proposal has no expiry of its own: it follows the challenge's response window (`respond_by`, the ladder's *days to respond*), and a request to move an accepted challenge's time follows
the same number of days, never past the play-by day (`move_respond_by`). An expired proposal cannot be accepted or countered (**`LAD5_EXPIRED`**, 409, with its last day); the act changes
nothing. What happens to an unanswered challenge is **unchanged** (it lapses, or is forfeited by an ignoring challenged player on a ladder of players: ladder rules, not holds'). A move
request nobody answered is ended by the scheduler, once: nothing changes, both are told it ended and that either can ask again, and the neutral record says **no response**. Nobody
is penalised for either.

## Decision 5: what the screen shows

Before a counter is sent, and before one is accepted, the screen shows the **court that would be held** (reserved only if the hold then succeeds), the **date, time and duration**, the **financial
obligations** (holding a court is free and moves no money; the venue's own court hire terms apply if they play there; **no price is invented**), and the **implications** (what releases it, that
a booking replaces it, what happens if the court becomes unavailable, what a later change they did not both agree does). The counter-proposer sees **"this is your proposal; it is not a
reservation"**, and every screen says **agreeing a time does not by itself reserve a court**. The counter's look is the existing non-binding preview (`preview_hold`, `for: "counter"`, rolled
back; `effect: "proposal"`). English, Malay, Chinese and Tamil.

## Decision 6: nothing is bypassed or guaranteed

An agreement only feeds `makeHold`, which is still the one path to court time, under the exclusion constraints and the capacity trigger, the venue's hours, closures and set-up times, the play-by
day, the ladder's live limit, each player's active limit, the places' roster and eligibility, and concurrency. A counter reserves nothing; only a hold that was successfully made does.
**Ladders of teams** are the same: the captains' acts are the same acts.

## Decision 7: a neutral record, and no blame

- **What is kept.** `ladder_hold_events` is one small table: per challenge, in order, **proposed, countered, accepted, held, moved, withdrawn, cancelled, released, declined, superseded,
  no_response** (and a manager's **pause_lifted**), with the player who acted (none for the venue or the system), the day and start, the revision, and **`reserved_capacity`**: whether
  a court was ever really reserved by it (a proposal or a counter never; a hold, always). With `ladder_agreed_times` and `ladder_court_holds` (and the activity log) this is the history. Staff
  see it on each challenge in the ladder's dashboard ("a proposal that never reserved a court is visibly not a hold"); players and the public never do.
- **An expiry names no one.** A hold nobody confirmed, a request nobody answered and a challenge nobody answered are recorded as **no response**: no fault, no counter, no label. The hold
  is released promptly and stops counting towards the active limits at once (ADR 0050, unchanged). The abandonment columns of migration 0292 (`abandoned_place`, `abandoned_at`) stay as
  history and **nothing reads them for a limit**; the sweep no longer writes them; the staff view says "released unplayed" and "no response", never "abandoned".
- **The only anti-abuse signal** is an objective pattern of **capacity blocking**: a player's **own cancellations of holds that really reserved court capacity** (a hold row exists only when
  its claims did), whatever state the hold was in: `ladder_court_holds.cancelled_place` and `cancelled_at`, set when the player themself withdraws a challenge that has a live hold (the one act
  a player has that releases a hold). **Never counted:** an expiry, a non-response, a decline, a release by the venue or the system, a move, a hold lost to an outage, a booking replacing it, a
  player leaving or freezing, and any proposal or counter that never reserved capacity. The count is per **person** (the same person across ladders, keyed as ADR 0050 keyed it: the same
  participant, team or account, never a contact detail) in a rolling window.
- **Its consequence is a temporary pause**, not a label or a standing: at **6 such cancellations in 7 days** (the defaults, install data with a venue setting and a ladder override inside bounds
  2 to 50, ADR 0048 and 0050's mechanism, unchanged; judged proportionate: a player who withdraws more than once a day for a week is blocking courts), **creating new capacity-reserving holds** is paused
  for **24 hours after the latest** (`LAD5_PAUSED`, install data). It restricts **only** the creation of a hold by that player's own act. It **never** stops proposing, countering, accepting an invitation
  to play (the acceptance goes ahead, the match is agreed, **no court is held**, the other is told "no court is held for this match" without a reason, and the screen tells the player first), moving
  an existing hold, playing, or a manager's hold. It ends by itself; it is logged by the system with the objective facts (how many, in how many days, the latest, until when:
  `ladder.hold_pause`); it is shown to the player in plain, neutral words (and says it is not a penalty); and **a manager can lift it with a reason** (`hold_pause_lift`, logged
  `ladder.hold_pause_lifted`, kept as a `pause_lifted` event; the count then starts again after the lift).
- **Distinguishing capacity.** Managers see, per player, neutral numbers ("5 released unplayed, of which 2 cancelled by the player"), the pause if any, and for each challenge whether a court was
  ever reserved. Players and the public never see them.
- **Unchanged:** the per-ladder live limit and each player's active limit (ADR 0048, 0050), the install bounds, and how limits resolve. Migration 0293 carries each 0292 withdrawal-while-tentative
  over as the player's own cancellation (it was exactly that), leaves expiries where they were, unread, and deletes nothing.

## What this changes

- ADR 0050, Decision 1, *What does not count*: "a **counter-proposal** the other side has not agreed (the accepter names a time of their own)" is no longer a tentative hold. It is a counter-proposal (Decision 1 above), which holds
  nothing until the other accepts it, and then the hold is confirmed. The paragraph *The accepter's act does not confirm a counter-proposal* is **replaced**: naming a time **is** agreeing it, and the owner's reading is now the rule.
- ADR 0050, Decision 5, *The anti-abuse limit*: "abandoned" (expired unconfirmed, or withdrawn while tentative) and the cooldown on it are **replaced** by a player's own cancellations of capacity-reserving holds and a temporary pause
  (Decision 7). `LAD4_COOLDOWN` is replaced by `LAD5_PAUSED` and its wording; `maxAbandoned` is kept as an alias of `maxCancelled`; the "History is preserved" sentence still holds, with `cancelled_*` as the history the count reads.
- ADR 0050, Decision 5 and *Consequences*: "who abandoned it" (`made_by_place`, `abandoned_place`) no longer attributes an expiry; `made_by_place` stays as history of whose act made a hold.
- Tests that assumed a player's counter makes a tentative hold, or an expiry counts, are changed to the manager's tentative hold and the new rule (listed in the report; no check weakened).

## Consequences

- A match arranged by a counter-proposal has one explicit acceptance (the other player's) and no confirm step; a tentative hold, and therefore expiry by the confirm-by window, now arises only from a manager's act.
- An old client that sends no `rev` is refused on a ladder that holds court time (400, `LAD5_REV_NEEDED`) until it sends one: a deliberate choice, since the alternative is a stale acceptance.
- A player in a pause can still agree to play; the venue is told nothing about why.
- **Not built, and why:** a proposal with its own expiry separate from the challenge's response window (the window already exists and is the ladder's own rule); counting a player *leaving* a ladder with a hold as a cancellation (leaving ends their
  participation, which is not capacity blocking); naming a court in a counter (players do not name courts; the court shown is held or nothing is); a per-person view of this for players (nothing is shown to players but their own pause, when it applies).
