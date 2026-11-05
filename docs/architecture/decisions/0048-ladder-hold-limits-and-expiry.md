# ADR 0048: Ladder court-time holds: configurable limits, tentative holds that expire, no overlap, limits that only refuse

- **Status:** current, decided 2026-11-05 at the owner's request, **amended by [ADR 0050](0050-ladder-agreement-counts-and-expired-holds-do-not.md)** (an exact agreement counts as confirmation; the per-player "made in 7 days" cap became an active-hold limit with a separate anti-abuse cooldown). Built in migration 0290. What managers and players see is in
  [court time held by the venue](../../features/tournaments.md#court-time-held-by-the-venue-an-optional-setting-per-ladder).
  **Amends [ADR 0040](0040-ladder-court-time-and-team-ladders.md) Part 1** in three places, listed under *What this changes*. Builds on
  [ADR 0010](0010-interval-booking.md) (court time as claims under exclusion constraints) and [ADR 0002](0002-database-enforced-concurrency.md).
- **Context:** the owner's decision: "Retain the existing 8-per-ladder and 4-per-player-per-week limits as configurable defaults. Allow
  authorized venue managers to adjust them. Implement hold expiration, prevent overlapping court allocations and ensure limits cannot
  bypass actual availability." Round 10 (ADR 0040) held a court the moment a challenge was accepted at a time, kept it until the challenge
  ended, and had one install-wide pair of caps.

## Decision 1: the caps are defaults, resolved ladder, then venue, then install, inside bounds

- **Order.** The effective cap is the **ladder's own override** if it has one, else the **venue's setting** if it has one, else the **install
  default** (`ladder_hold_limits`, one row, still seeded 8 live holds per ladder and 4 holds made per player in a rolling 7 days). Each of the
  two numbers resolves on its own, so a ladder may override one and inherit the other. A blank (`null`) goes back to the default above it.
  `resolveHoldLimits` is the only place that resolves them, and `makeHold` calls it.
- **Bounds are install data** (`ladder_hold_limits.live_min/live_max/week_min/week_max`, seeded 1 to 50 live and 1 to 20 per week). A value
  outside them, or not a whole number, is refused (`LAD3_BOUNDS`, with the bounds in the answer) and nothing is changed. The install's own
  defaults are not re-checked against the bounds: the owner of the install set them.
- **Who.** A **manager** of the venue, from the ladder's court-time settings (advanced, collapsed), by `POST /api/admin/ladders/:id`
  `{ action: "hold_limits", scope: "venue" | "ladder", maxLive?, maxWeek?, reason? }`. The route is a manager's (`MANAGER_ONLY`), and a
  manager of another venue is refused as for any ladder. The desk reads the effective numbers and where each comes from in the staff view;
  players and the public are never shown them.
- **Audit.** Every change is logged (`ladder.hold_limits`) with who, the number before and after for each cap (a blank is "default"), the scope
  and the reason when one is given. A refused change is not logged.
- **A change never releases a hold.** It applies to holds made from now on. Lowering a cap below what is in use is allowed, and simply
  blocks new holds (the screen says so and shows the number in use). A move or re-hold **replaces** a hold and adds none, so it is not
  counted against the live cap (a ladder over a lowered cap can still move what it has), and a manager's release is never blocked by a limit.
  Holds that expired, or were released, still count in the player's week: counting made holds, not live ones, is what stops churn.
  *Amended by [ADR 0050](0050-ladder-agreement-counts-and-expired-holds-do-not.md): the per-player cap now counts holds that are live now, so an expired or released hold stops counting at once; churn is met by a separate anti-abuse cooldown.*

## Decision 2: a hold is tentative until confirmed, and expires

- **Tentative.** On a ladder that asks for it (`ladders.needs_confirmation`, **on unless a manager turns it off**, from the same settings;
  `court_time` `needsConfirmation`), a hold made when a challenge is accepted at a time, or when a first specific time is agreed by asking and
  agreeing, is **tentative**. The court is held all the same, under the same claims, so nobody can book it; but both players must confirm it
  (`confirm_hold`), or a manager does for both (`hold_confirm`), before its **confirm-by** moment, or it lapses. Each player's confirmation is
  their own (`confirmed_challenger_at`, `confirmed_challenged_at`); the hold is confirmed when both are in (`confirmed_at`), or when a manager
  confirmed (`confirmed_by`). The one who has not yet confirmed is told when the other does. A repeat confirmation changes nothing and tells nobody.
- **Confirm-by** is `min(made + window, start − minimum notice)`, the window being install data (`confirm_hours`, 48) and the notice install data
  (`min_notice_minutes`, 120). When that moment has already gone (a match arranged at short notice), the hold lapses **at the latest at the
  start**, never after it. A hold is never tentative past the match's start.
- **Moves.** A move the players agree **keeps the state of the hold it replaces**: a confirmed hold moved stays confirmed (both players have just
  agreed the move), a tentative one stays tentative with a fresh window. A hold a manager makes (a move, or a hold where there was none) is
  confirmed. A ladder that does not ask for confirmation makes every hold confirmed, as round 10's were.
  *Amended by [ADR 0050](0050-ladder-agreement-counts-and-expired-holds-do-not.md): a move the players agree is an exact agreement and is confirmed; a manager's hold or move is tentative again unless it changes nothing material; a hold made when both players agreed the exact time is confirmed from the start.*
- **A confirmed hold** lasts until the match's end and is then released by the rules that already existed: *played* when the result stands,
  *not played in time* when the play-by day passes, withdrawn, forfeited and the rest (ADR 0040). Nothing about those rules changes; the
  blocks cover only the match and its set-up time, so a hold whose time has passed holds nothing that matters.
- **Backward compatibility.** A hold made before migration 0290 has no confirm-by, which means **confirmed**: it is shown as confirmed, never
  expires, and is moved, released and counted exactly as before.
- **Extension.** A manager may give a tentative hold **more time, once**, with a reason of at least three characters (`hold_extend`): by the
  install's extension (`extend_hours`, 24), never past the match's start. It is logged (`ladder.hold_extended`), kept with the hold
  (`extended_at`, `extended_by`, `extend_note`) and both players are told. A hold that has already lapsed is not brought back (its court may be
  somebody else's by now): they agree a time again and it is held afresh.
- **What expiry does.** The hold is released with the reason `expired`, by `system`; its blocks and claims are deleted; both players are told
  **once** that the court is free and the challenge is back to arranging a time (the challenge stays *accepted* with the day and no time, the
  state a day-only agreement already had, so either player can ask for a time again); the freed time is offered to the waiting list. The
  telling is claimed by one caller (`expiry_told_at`), so two schedulers never tell twice.
- **Expiry is enforced three ways, because the exclusion constraint cannot see the clock.** (1) **Lazily on read:** a tentative hold's block
  claims carry its confirm-by moment as their `expires_at`, and every availability read (`occupantsOn`) already ignores a claim past its time, as
  it does a waiting-list offer's; the ladder's own views (`holdViews`) treat a lapsed hold as not live too. So a lapsed hold never keeps a court
  from anybody, even if nothing has run. (2) **Lazily on claim:** when a claim is refused for a conflict, `releaseExpiredOffers` (the existing
  precedent for offers, moves and approval holds) first lets go of every lapsed ladder hold (`sweepExpiredHolds`), then the claim is tried once
  more; `makeHold` and each court it tries sweep too, so a new hold never meets a lapsed one. (3) **The scheduler** (`ladderHousekeeping`)
  sweeps, tells and clears. `sweepExpiredHolds` depends on the database alone and is one conditional `UPDATE ... RETURNING`: a hold is released
  by whoever marks it first, so the sweep, a confirmation, a manager's release and a move race safely, and a confirmation after the confirm-by
  moment is refused (`LAD3_EXPIRED`) in the same statement that would have accepted it.

## Decision 3: no overlap, proved twice

Two holds (the same ladder's or two ladders'), a hold and a booking, class, tournament or league block, or a hold and a staff block can never
overlap on a court, because a hold **is** blocks with claims under the exclusion constraints and the capacity trigger (ADR 0040, unchanged).
New in migration 0290: the table of holds carries the held range (`held_during`) and a **second exclusion constraint** (`ladder_holds_no_overlap`)
keeps two live holds of one court from overlapping, whatever else is true. A hold of round 10 has no range and conflicts with nothing at this
level; its blocks are still under the claims constraints. A move holds the new time first and lets the old go in one savepoint (ADR 0040), so a
refused move leaves the old hold in place.

## Decision 4: a limit only ever refuses

No cap, bound, override or expiry rule creates a hold. Every hold goes through `makeHold` and the one claim path, so a cap raised as far as it
goes, or a manager's override, still gets a court only where one is free; the tests raise every cap to its maximum on a fully booked venue and
get no hold and no claim. Limits are checked before the claim and can only turn an acceptance into a refusal; they are never consulted to allow
one.

## What this changes

- ADR 0040, *Caps are install data*: the caps are now **defaults** that a venue and a ladder may override within bounds (Decision 1). The seeded numbers are unchanged.
- ADR 0040 and the feature document's round 10 text, *Made on acceptance*: a hold made on acceptance is **tentative until confirmed** on ladders that ask for it, which is **every ladder unless a manager turns it off** (Decision 2). With it off, behaviour is round 10's.
- ADR 0040, *Released in every ending*: one more ending, **expired**, and a manager may **confirm** or **extend** a hold.

## Consequences

- A match arranged now has one more step for the players (confirm), by default. Venues that do not want it turn it off per ladder; nothing in the guide's setup path asks about it.
- A hold nobody confirms is let go after the window, so a ladder cannot sit on courts it never plays on; the week's cap still counts it.
- `releaseExpiredOffers` now also runs the sweep, a small addition to a path every booking that meets a conflict already takes.
- **Not built:** confirming through the email itself (the players confirm in the ladder), a venue-level choice of the confirmation window (it is install data), a hold that comes back by itself after expiry, and the held range for holds made before the migration.
