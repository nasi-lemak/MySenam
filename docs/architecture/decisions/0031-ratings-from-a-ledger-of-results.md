# ADR 0031: Ratings are a deterministic function of a ledger of results, never learned

- **Status:** current, decided 2026-11-03 (the owner approved building ratings
  from results, rankings across events, and matchmaking on earned levels). What
  people see is [ratings and rankings](../../features/tournaments.md#ratings-and-rankings)
  and [earned levels](../../features/matchmaking.md#earned-levels).
- **Context:** results already carry everything a rating needs, but each stops at
  its event's table. Players asked for a level that means something, venues for
  rankings and seeds, and matchmaking for more than a self-declared level.
  Each could have become a second scoring path (results entered again for rating),
  a stored number updated in place (which drifts the first time a result is
  corrected), or a learned model (opaque, and hard to defend to the person it
  ranks). Corrections, voids, forfeits and leagues' unanswered reports mean results
  change after they are first seen; children and strangers' privacy
  ([ADR 0016](0016-matchmaking-on-open-games.md),
  [ADR 0022](0022-children-managed-from-an-adults-account.md),
  [ADR 0023](0023-participants-apart-from-accounts.md)) bound who may be shown
  or suggested.
- **Decision:**
  - **A ledger is the source of truth.** One row per decided match of an event a
    venue marked as rated (`rated_results`), with both sides and the outcome.
    Its facts are never edited: a corrected result is a new row and the old one is
    voided with why. A rating is a pure function of the live rows in a defined
    order (when, then event, match, game), recomputed from scratch for the whole
    *pool* (one venue, one sport, one format) whenever a row is added or voided,
    under the pool's row lock. There is no incremental update, so nothing drifts, and
    a rebuilt ledger gives the same ratings (property-tested against an independent
    replay).
  - **The ledger is a consumer, never a scoring path.** Results enter only through
    `recordResult` and the league functions, as before (the rule in `AGENTS.md`
    stands). They call `ratedAfter` once committed, and a scheduled catch-up
    re-reads any rated event whose result rows differ from the last read
    (fingerprinted); both are idempotent (a unique index allows one live row per
    result) and a failure never fails the result that caused it.
  - **A published, deterministic rule: Elo-family, fixed constants as install
    data** (`rating_rules`): start 1000; chance of winning
    `1 / (1 + 10^((other − own) / 400))`; change `K × weight × margin × (result −
    chance)`; K 40, 24, 16 by results already counted; a side is the average of its
    members (doubles, a lineup); provisional until 8 counted results (a venue may choose 3 to 30:
    ADR 0035) and never ranked until then. A **walkover moves nothing** and is not counted (a
    forfeit is not play), a **win by retirement counts half**, and an event's own
    rules for a withdrawn or disqualified entrant's group results decide whether
    they are counted at all. A margin of victory counts only where the sport's
    template scores a tally (goals, points), never for sets. Ratings are rounded
    to two decimals at every step, so a replay is the same on any machine. No
    learning, no embeddings, no hidden signals.
  - **Only events a venue marks as rated count**, chosen before the event
    starts; a casual open game is never rated (nothing records its result).
  - **Ratings are per venue, sport and format.** This keeps tenants apart: a
    manager's exclusions and restarts are within their own venue's data, and no
    venue sees another's results. A business-wide board lists each branch's pool
    side by side where the branches allow it; it is not a merged rating.
  - **Who can be rated:** accounts, children a guardian manages (for the guardian
    only), persistent teams. A name typed into an entry (a doubles partner, a
    typed roster, a counter entry without an account) is not somebody the app can
    rate and is not pretended to be.
  - **Visibility is opt-in and adult-only,** and a venue's public rankings are
    published only when its manager turns them on (ADR 0035). A player sees their own rating and
    every result that moved it with the reason; others only what the player chose
    (a number to matched hosts and players; a place on a public ranking under the
    name they gave); a team once published. A child is never ranked, public or
    suggested; an opponent's rating is shown only if they chose to show it.
  - **Matchmaking uses an earned level only if the player chose it** (declared by
    default, so nothing changes for anyone who has not chosen), only when it is not
    provisional, and says so in the reason with the numbers. A rating adds a reason
    and published points to somebody already allowed; it never makes anybody
    discoverable, invitable or ranked.
  - **Managers correct, with a reason and a log:** leave a result out (it belongs
    to the result and survives its correction) or start a rating again (earlier
    results still count for the people who played them). Seeding a draw is a
    proposal a manager confirms against what they were shown, through the draw's
    own seed input.
  - **Erasure** makes a person's place in the ledger `(removed)`, standing at the
    rating they had then, so nobody else's rating moves; the pools are replayed.
  - **Not built:** an enforced level (a rating band checked at entry), a rating
    across venues, a rating from casual games, a rating from a performance event
    (a field ranked by marks or by counts has no two-sided result, and is not
    turned into pairwise ones; marking one rated is refused,
    [counted performances](../../features/tournaments.md#counted-performances)).
- **Consequences:** a result's correction, void, strike or restore puts every
  rating right with no special case for each. A pool is replayed in full on each
  change, which is linear in the pool's ledger and not measured at marketplace
  size (a pool is one venue, sport and format). Changing the published constants is
  an operator's decision (raise `rating_rules.version`; every pool is recomputed);
  no screen edits them. The ratings' correctness rests on the results'
  correctness: a result entered wrongly and not corrected is rated as entered.
