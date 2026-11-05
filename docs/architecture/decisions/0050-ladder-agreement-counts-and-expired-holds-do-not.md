# ADR 0050: Ladder court time: an existing agreement counts as confirmation; expired and released holds do not count towards a player's active allowance

- **Status:** current, decided 2026-11-05 at the owner's request. Built in migration 0292. What managers and players see is in
  [court time held by the venue](../../features/tournaments.md#court-time-held-by-the-venue-an-optional-setting-per-ladder).
  **Amends [ADR 0048](0048-ladder-hold-limits-and-expiry.md)** in the places listed under *What this changes*. **Amended in turn by [ADR 0051](0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md)**: a counter-proposal
  is its maker's agreement and holds nothing (the *What does not count* and *The accepter's act* paragraphs below are replaced), and the anti-abuse limit counts a player's own cancellations, not abandonment (Decision 5's second bullet is replaced). Builds on
  [ADR 0010](0010-interval-booking.md) (court time as claims under exclusion constraints) and [ADR 0002](0002-database-enforced-concurrency.md).
- **Context:** the owner decided two things. (3) "If Player A proposes a fully specified match time and Player B explicitly accepts it, treat that as both
  players' agreement. Do not require both to repeat an identical confirmation unnecessarily. However, the acceptance interface must clearly communicate the
  relevant court, time, duration, applicable charges and booking implications. If any material details change after agreement, obtain renewed consent from
  affected participants. Agreement alone must not bypass the existing booking, payment, resource-availability, eligibility or concurrency rules. Only a
  successfully confirmed booking reserves the court." (4) "Once a hold genuinely expires or is released, it should no longer consume the player's concurrent
  active-hold allowance. Preserve historical records for auditing and abuse detection. If necessary, implement a separate reasonable rate limit or cooldown for
  repeatedly creating and abandoning holds. Keep the distinction clear between active-hold limits and anti-abuse limits. If the existing weekly cap is
  intentionally a creation quota, document that distinction and assess whether the quota remains justified." ADR 0048 had made every hold made on acceptance
  tentative until both players confirm it, a manager's hold confirmed, a moved hold keep the state of the one it replaced, and counted every hold *made* in 7 days.

## Decision 1: an exact agreement is a confirmation

- **What counts.** A **fully specified time** (a day and a start; the minutes held are the ladder's) that **one player proposed and the other explicitly accepts
  unchanged**, in the existing flow, is both players' agreement to that exact specification:
  the challenger's proposal and the challenged's `accept` (with no time of their own, or the very same one), a counter-proposal (`propose`) and the original proposer's
  `accept`, and `propose_move` with `agree_move`. `acceptedTime` (`lib/ladders.ts`) is the one place that decides it. A team ladder's captains' acts are the same acts
  of the same places, so they count the same way.
- **What it does.** The hold is made **already confirmed** (`confirmed_at`, both sides' confirmations set, no `confirm_by`, so its claims carry no lapse moment and
  nothing can expire it). It is made through the one claim path, `makeHold`, exactly as before, so everything it checks still applies; the agreement only changes the
  state the hold is made in. The other player's email says so ("you both agreed this exact time: nobody needs to confirm it again").
- **What is kept.** One row per player per hold made by agreement (`ladder_agreed_times`): the day, the start, the minutes and the court that were shown and held, the
  role (`proposed` or `accepted`) and when. The hold row says it was made that way (`agreed_exactly`). A hold's rows stay when it is moved or released; a later agreement
  has rows of its own.
- **What does not count.** *(Amended by [ADR 0051](0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md): a counter-proposal is the counter's maker's agreement and holds nothing until the other accepts it; only a manager's time is tentative.)* A **counter-proposal** the other side has not agreed (the accepter names a time of their own), a **day alone** (nothing is held at all,
  as before), and a **time a manager chose** are not agreements: the hold stays tentative on a ladder that asks for confirmation (ADR 0048), and each player confirms.
  The `needsConfirmation` setting keeps working: with it off every hold is confirmed when made, as before.
- **The accepter's act does not confirm a counter-proposal.** ADR 0048's rule that both players confirm a tentative hold is unchanged: the accepter who named a time
  still taps *Confirm the court* like the other. (A small, reversible choice that keeps ADR 0048's tests meaning what they said; the owner may decide that naming a time is
  agreeing to it.)

## Decision 2: the acceptance screen says everything first, and the court is the one shown

- **A preview** (`previewHoldFor`, `POST .../challenges/:id` `{ action: "preview_hold", for, onDate?, minute? }`) runs the real path, `holdFor` with `preview`, in a **savepoint that is
  rolled back**: the court it names is the one the deterministic choice would hold now, under the same limits, hours, closures, set-up times and the database's own claim
  constraints, and a refusal is the refusal the act would give. It reserves nothing and changes nothing (the challenge's version, the claims and the holds are untouched; a test proves it).
  It is a read in effect, but a POST, because it takes a body and runs a rolled-back write under the ladder's lock.
- **What the screen shows** (`components/HoldAgreement.tsx`, EN/MS/ZH/TA): the **court**, said to be reserved only if the hold then succeeds; the **day, start and
  duration**; the **charges**: holding a court is free and moves no money, and if they play there the venue's own court hire terms apply, so **no price is invented**, and a price is shown only
  where the booking machinery already gives one for an attached booking (the screen is before any booking is attached, so it shows none); the **implications**: what releases it
  (withdrawing, a result or the day passing, the venue releasing it and telling them), that attaching an ordinary booking replaces it, that if the court becomes unavailable both are told and
  agree a time again, and that a later change they did not both agree asks both to confirm again; what agreeing does (confirmed at once, or tentative); and the court it would replace.
  A ladder that holds nothing, and a day alone, show nothing and accept as before.
- **The court shown is held, or nothing is.** The acceptance carries `courtId`. `makeHold` then holds that court only (`expectCourtId`): not free any more, or not one the ladder
  allows, is `LAD4_COURT_CHANGED`, with nothing reserved and the challenge exactly as it was (still pending, or the move still asked). A client that sends no `courtId` gets the
  deterministic choice, as before.

## Decision 3: nothing is bypassed

Agreement is an input to `makeHold`, never an alternative to it. The exclusion constraints and the capacity trigger, the ladder's live limit and each player's
active limit, the anti-abuse cooldown, the venue's hours, closures, set-up times and the play-by day, and the roster/eligibility of the places all apply to an agreed time as to any other;
a refused agreement reserves nothing and leaves the challenge in "arrange a time" (pending, or accepted with the day and no time), as a refused acceptance always did. Only a hold that was
successfully made reserves a court. Races (two agreements at once, an agreement racing a booking, a block or a manager's move) end with one holder and nothing overlapping, on both engines.

## Decision 4: material change needs renewed consent

*Material* is the **day, start, minutes held or court**. A change the players **both agree in the move flow** is again an exact agreement for the new specification (Decision 1).
A change they did **not** both agree, a **manager's move** (`hold_move`), makes the new hold **tentative again** with a fresh confirm-by window, keeps what it replaced (`changed_from`),
tells **both** what changed (old and new court, day and time, the reason, and that each must confirm) and asks each to confirm the new specification (a manager may confirm for both). A manager's move that
changes nothing material (the same day, start and court) keeps the agreement, its confirmations and its history (`carryAgreement`); an extension, a reminder, a note and a repeated confirmation
never reset anything. There is no system re-hold after a court is lost: `reconcileHolds` marks the hold lost and the players agree a time again, which is an agreement. If a system re-hold is ever built, it is a change
nobody agreed and falls under this rule.

## Decision 5: two limits, named and kept apart

- **Active-hold limits** count holds that are **live now**: not released, not lapsed (a tentative hold past its confirm-by moment is not live to any read), and not yet past. Per ladder
  (as before) and **per player** (new, default 4): the number of live holds in all of the player's places, on any ladder: the same participant (a child's own places), the same persistent
  team, or, for an adult's own place, the same account (never a contact detail), and counting the opponent's too, so a player cannot be put over their limit by asking. They resolve ladder override, then
  venue, then install, inside install bounds, are a manager's to set (`hold_limits`, logged), and they apply to holds made from now on and release none. A hold that expires or is released **stops counting at that
  moment** (lazily, by the read, and by the scheduler's sweep).
- **The anti-abuse limit** *(replaced by [ADR 0051](0051-a-counter-proposal-is-an-agreement-and-expired-holds-are-no-ones-fault.md): only a player's own cancellations of holds that reserved capacity count, and the consequence is a temporary pause)* is only about creating and abandoning holds repeatedly. **Abandoned** means: expired unconfirmed (against the place that made it) or withdrawn by a player while still tentative
  (against the one who withdrew). Not abandoned: played, moved, forfeited, released by the venue, confirmed and then withdrawn, made by a manager, or made before migration 0292 (nobody is recorded against it). At the
  threshold (default 6 in a rolling 7 days; install data, with a venue setting and a ladder override inside bounds 2 to 50) a **cooldown** applies to creating new holds (default 24 hours since the latest abandoned one;
  install data), refused as `LAD4_COOLDOWN` with a plain message; it ends by itself. Reaching it is logged by the system (`ladder.hold_cooldown`). It never applies to a move, to a manager, or to a player who has abandoned fewer.
- **History is preserved.** An expired or released hold stays in `ladder_court_holds` with its reasons and times, and who abandoned it (`made_by_place`, `abandoned_place`, `abandoned_at`); nothing is deleted
  by this change. A manager sees each player's count and cooldown in the ladder's staff view; players and the public never do.

## Decision 6: the old creation quota is replaced

ADR 0048 kept round 10's "4 holds made per player in a rolling 7 days" as a *creation* quota on purpose: released and expired holds still counted, so that withdrawing and asking again could not churn a court.
**Assessment: it is no longer justified.** What it guarded against is now covered by two narrower things, the active limit (a player cannot hold more courts than they are playing for) and the anti-abuse
cooldown (churning is slowed once it is a pattern), neither of which penalises a normal player: the quota counted a proposal that merely expired, or was played, or was released by the venue, as a
strike, and blocked the next acceptance for it. So it is **removed**, not renamed, and the key survives only for compatibility:

- What was set under it **carries over as the same number to the per-player active limit**, because the number a manager chose is the number they thought a player should have at once, and a concurrent limit is the
  more permissive reading of it: the install default (4) and bounds (1 to 20), a venue's setting and each ladder's override. Migration 0292 copies them once, when it adds the new columns (it changes nothing on a second
  run); the old columns (`max_per_player_week`, `week_min`, `week_max`, `cap_week`, and the venue's) stay as they were, as history of what was set, and nothing reads them. The activity log's entries are history and keep
  their words. New entries say "live per player".
- `maxWeek` is still accepted by the staff route and shown in the staff view (`maxPerPlayerWeek`), meaning the active limit; `LAD2_CAP_PLAYER` is retired and its sentence removed from the dictionaries.

## What this changes

- ADR 0048, Decision 2, *Tentative*: a hold made on acceptance is tentative **unless both players agreed that exact time**, which is made confirmed (Decision 1 above).
- ADR 0048, Decision 2, *Moves*: a move **the players agree is confirmed** (an exact agreement), whatever state the hold it replaces was in; and "a hold a manager makes is confirmed" is replaced: a **manager's hold or move is
  tentative** on a ladder that asks for confirmation, with a fresh window, unless it changes nothing material (Decision 4).
- ADR 0048, Decision 1, *A change never releases a hold*: "Holds that expired, or were released, still count in the player's week" is replaced by Decision 5: they do not count towards the active allowance; abandoned ones are the anti-abuse limit's history.
- ADR 0048, Decision 1, the second cap: "per-player holds made in 7 days" becomes "live holds per player" (Decision 6), with `maxWeek` kept as the old name.
- ADR 0040, *Caps are install data*, is superseded in the same way (ADR 0048 had already made them defaults).

## Consequences

- A match arranged by agreement now has no confirm step at all, which is the common case (one proposes a time, the other accepts it). The confirm step remains for counter-proposals and for a venue's own changes.
- The acceptance screen has one more step (check the court), which is also where a refusal appears before anything is agreed.
- A player cannot be penalised for a match that merely expired; a pattern of creating and abandoning holds meets a cooldown, never a permanent block, and the venue sees it.
- `releaseExpiredOffers` and the sweep are unchanged (a small addition: the sweep records who abandoned a hold).
- **Not built, and why:** a hold re-made by the system when a court is lost (the owner did not ask; today the players agree a time again); a venue-level choice of the cooldown and window (install data, as ADR 0048's expiry windows);
  confirming through the email itself; counting abandonment for holds made before the migration (nobody is recorded against them); a payment step (a hold moves no money, as ever).
