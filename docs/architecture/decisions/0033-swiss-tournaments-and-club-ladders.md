# ADR 0033: Swiss tournaments and club ladders, specified before they were built

- **Status:** current, decided 2026-11-04 (the owner approved building Swiss and
  ladders; the roadmap's earlier bar was that their whole progression and
  correction behaviour be specified and tested first, and this is that
  specification). Built in migration 0272. What organisers and players see is in
  [tournaments](../../features/tournaments.md#swiss-tournaments) and
  [ladders](../../features/tournaments.md#club-ladders). Extends
  [ADR 0012](0012-competition-rules-and-corrections.md),
  [ADR 0013](0013-competition-framework.md) and
  [ADR 0031](0031-ratings-from-a-ledger-of-results.md).
- **Context:** both formats have a property the four existing ones lack: what
  happens next depends on what has happened. A Swiss round is paired from the
  standings the round before left, so a correction to round 2 can change the
  pairings of round 3, which may be played already. A ladder's ranks are moved
  by challenges, so a result corrected a month later changes every move after
  it. Either could have become an incremental engine, with ranks and pairings
  nudged in place, which drifts the first time something is corrected. The rule
  below is the opposite: **the record of results (and of the manager's actions)
  is the truth, standings and ranks are pure functions of it, and a change to the
  past is previewed, offered as what it does, and refused where it cannot be
  made safely.**

## Part 1: Swiss

- **A Swiss event is a tournament of format `swiss`**, configured by data like the
  others (no branch on the sport). Entrants are players, pairs or teams, as in a
  round robin; at least 4 entries. A fixed number of **rounds** is chosen at the
  draw: the setting (`rules.swiss.rounds`) or, by default, the smallest number of
  rounds that can leave one unbeaten entrant, ⌈log₂ n⌉ (4 to 5 entries: 2 or 3;
  8: 3; 16: 4; 32: 5). It is at most n − 1 (n entries, even) or n (odd), the most
  rounds in which nobody need meet twice; a larger setting is refused at the draw.
- **Storage reuses the group stage.** A Swiss match is a row of
  `tournament_matches` with stage `group`, group 1, its round in `round`, its
  position in `position`; a bye is a `bye` row with the player as `entry_a`, no
  `entry_b`, the player as winner and no court. Everything that handles a pair of
  sides then works unchanged: `recordResult` and its checks and draws, results
  entered by players and officials, match lengths (the *group* stage's), moving a
  fixture, the day's board and announcements, ratings, the live page.
  `tournament_entries.swiss_rank` holds each entry's place in the **initial
  order**; `swiss_events` the number of rounds, the recorded seed and the
  tie-break order; `swiss_rounds` each paired round with the reasons for its
  pairings.
- **The initial order** is the staff-set seeds (which a manager may have proposed
  from [ratings](../../features/tournaments.md#ratings-and-rankings) and
  confirmed) in seed order, then everybody else in a drawn order. The drawn order
  is the only randomness there is: it uses the draw's `random` as every draw does,
  its **seed is recorded** (`swiss_events.seed`) so the draw can be reproduced,
  and after it nothing is random. A recorded `swiss_rank` is what every later
  pairing and tie-break reads.
- **Scoring.** A win, a draw (where the template's scoring allows draws in a
  group) and a loss earn the template's table points (`scoring.tablePoints`, or
  `setPoints` where the sport scores by set score), by the same function that
  ranks a group (`standings`); a walkover is a win for the other side at the
  rules' walkover score; a retirement a win with the partial score counted as the
  rules say. A **bye** is worth the rules' points for a win unless the event sets
  its own value (`rules.swiss.byePoints`), and counts nothing in differences,
  Buchholz or head to head: it is a point, not a result.
- **Standings, and the final order**, are by Swiss points, then the event's
  **tie-breaks in order**, then the initial order: nothing is ever left to chance.
  The tie-breaks are chosen from, in this default order:
  1. **Buchholz**: the sum of the Swiss points of the opponents actually played
     (a bye has no opponent and adds nothing).
  2. **Median Buchholz**: Buchholz without the highest and the lowest opponent's
     points, for a player who has played at least three opponents (else
     Buchholz).
  3. The competition rules' own ranking keys (`wins`, `set_diff`, `set_ratio`,
     `point_diff`, `point_ratio`, `points_for`, `head_to_head`), exactly as a
     table ranks by them. The default after Buchholz is the template's own
     `rankBy` without `points`.
  Results of somebody out stand or are void by the event's rules for leavers
  (stage *groups*), as in a group; void results count for nobody, opponents'
  Buchholz included.
- **Pairing a round** (`src/lib/swiss.ts`, pure, shown to organisers and in the
  documents). Players still in, ordered by points (high first) then initial order.
  1. **No rematches**: nobody meets anybody they have already been paired with in
     a round that stands (a pairing never played because the round was closed with
     neither side coming counts as met; a pairing taken off by a re-pair, below,
     does not, since the round is paired again). **No second bye.**
  2. If the number is odd, a bye is given to the **lowest-ranked player without
     one** (lowest points, then last in the initial order), the first of those from
     the bottom for whom everybody else can still be paired.
  3. The best-ranked unpaired player is taken in turn and paired with the first
     opponent they have not met, in this order: the **lower half of their own
     score group** (the Dutch method: first with the first of the lower half),
     then the rest of their group, then the next group down, and so on down. A
     choice that leaves the others unpairable is undone and the next tried (an
     exhaustive search, bounded); a player taken from a lower group is a
     *float*, and the pairing note says so.
  4. **Sides**: of two paired players, the one who has been first-named fewer
     times is first-named (the *a* side, shown first and "home" for a tally sport);
     level, the better ranked.
  5. If no pairing without a rematch or a second bye exists (it can happen after
     withdrawals), the round is **not paired**, and says why. The manager can
     **end the event after the last round** that was paired; nothing is ever
     paired against the rules.
  Each pairing is kept with its reason (score group, float, bye) and shown.
- **When a round is paired.** Round 1 at the draw. Round r + 1 as soon as every
  match of round r is decided (a result, a walkover, a leaver's walkover), inside
  the change that decided the last one, and from standings that are the pure
  result of everything recorded; or the manager **closes the round**, giving each
  undecided match a walkover to a side they name or none (*neither came*: no
  points, no result), through `recordResult`'s walkover. Pairing never fails the
  result that triggered it: if it cannot be done (no court time, no legal
  pairing), the round stays unpaired, the organiser is told why on the page, and
  *Pair the next round* tries again. Rounds are scheduled one at a time into the
  court time the tournament already holds (`scheduleTimed`, match lengths by
  stage, courts and players never twice), starting after the previous round's last
  match ends and after now; the draw refuses an event whose rounds cannot all fit.
  The held time is kept until the last round is paired.
- **The event finishes** when its last round is paired and every match decided
  (and no progression issue is open, which Swiss never opens: it has no chain).
  Its result is the standings.
- **Somebody leaving.** Taken out as withdrawn, retired or disqualified by the
  existing preview-and-confirm: each match they have left is a walkover to the
  other side (stage *groups*), **future rounds skip them**, results already
  played stand or are void by the event's rules, and the pairings of rounds
  already made stand (the opponent has their walkover). If the walkover decides
  the last match of a round the next is paired. A bye already given to somebody
  who then leaves stands as a point.
- **Corrections: stand, or re-pair.** A result changed after a later round has
  been paired is a correction, previewed and confirmed with a reason and the
  preview's token, a manager's, exactly as a group result changed after the
  knockout has begun (`previewResult`, `applyCorrection`, kept in
  `tournament_corrections`). The preview offers:
  - **Stand** (`standings_only`): the pairings already made stay. Only the
    standings change. Always possible.
  - **Re-pair** (`replace`): the pairings of every round after the corrected
    one are voided and the next round is paired again from the corrected
    standings under the same rules. **Possible only while no match after the
    corrected round has a result** (a result, a walkover, a retirement; a bye is
    not a result), and refused, with why, once one has: a played match is never
    rewritten or deleted. What is voided is removed from the draw and kept in the
    correction's `before_state`; the players concerned are told their new
    pairing; the re-pairing must also fit the court time or the whole correction
    is refused and changes nothing.
  A change to the latest round while the next is not yet paired is an ordinary
  result. A result changed in the last round of a finished event only changes the
  standings. **Standings are always the pure function of the recorded results**,
  so a replay from scratch of the recorded results gives the corrected state
  (property-tested).
- **Ratings.** Every decided two-sided match counts as in a group (a walkover
  moves nothing, a win by retirement counts half); a bye is not a result and is
  not rated; a correction replays through the ledger as for any tournament.
- **Not built:** accelerated pairings, a Monrad or Burstein pairing, pairing by
  rating inside a score group other than through seeds, colours for sports with
  sides other than the first-named rule, and Swiss for performance events.

## Part 2: Ladders

- **A ladder** is a standing list of entrants ranked 1 to n, kept by a venue for a
  sport (`ladders`), with a challenge system. Entrants are players or pairs as in a
  box league (one account, a guardian for a participant, or staff at the counter,
  through `Entrant`); a pair is named by the player who joins. Teams that persist
  play in [team leagues](../../features/tournaments.md#team-leagues). A ladder is
  for **adults** or for **juniors**: an adult ladder takes the account holder who
  declares they are 18 or over (declared, never verified) and takes no participant;
  a junior ladder takes only participants a guardian enters, who act for them
  (challenge, answer, report), is told for them, and whose name is shown short
  everywhere.
- **The ledger.** Each ladder season's state is the pure replay
  (`src/lib/ladders.ts`, `replay`) of an ordered list of **events**
  (`ladder_events`): `join` (at the bottom), `carry` (a place carried into a
  season), `leave`, `result` (a challenger and a challenged, who won), `drop`
  (down *p* places for inactivity), `freeze` and `thaw`, `move` (a manager's
  override) and `remove` (a manager takes somebody off). Events carry the date they
  count from, never a clock reading, so the replay is deterministic. **Ranks are
  stored only as a cache written from the replay** after every change, under the
  ladder's row lock; a correction **replaces the event in its place in the order**
  (the old row voided, with who and why; the new row has the same position), and
  the replay of the ledger as it stands then gives the ranks, so nothing drifts
  (tested: the stored ranks equal a fresh replay after every operation, including
  two results recorded at once on Postgres).
- **The rank rule (published).** After a result, if the **challenger won** and was
  ranked below the challenged, the challenger takes the challenged's rank and
  everybody from there down to just above the challenger's old rank moves down one.
  If the challenged won, nothing changes. A challenge whose outcome is a forfeit by
  the challenged is a win for the challenger. A leaver closes the gap; a new
  player joins at the bottom; a drop moves one down *p* places and the players
  passed move up one. Every event is defined whatever the ranks are (a result
  whose challenger is already above the challenged moves nobody), so a replay after
  a correction is always defined.
- **Who may challenge whom (`reach`).** A player may challenge a player ranked
  **within *k* places above** them (default 3), both active and **not frozen**;
  neither is in another open challenge (one at a time); and not the **same
  opponent within *d* days** of their last played or forfeited challenge together
  (default 14). A ladder shows each player who they may challenge and, for the
  others, why not.
- **A challenge's life (`ladder_challenges`).**
  1. **Pending**, the challenged to answer within **w days** (default 3): they
     **accept** (optionally at the time proposed), **decline**, or **propose a
     time**, which hands the answer to the challenger, who accepts it or withdraws
     (a challenger who does not answer in w days lets it lapse, no effect). A
     decline is free, or counts as a forfeit, as the ladder's `declineIs` setting
     says (default free). **A challenged player who ignores a challenge forfeits
     after w days**: it is recorded as a walkover for the challenger, the scheduler
     doing it, safe to run twice (it moves only a challenge still awaiting them).
  2. **Accepted**: the two **arrange the match privately** (the time proposed is
     shown; each sees the other's contact, an adult ladder's only, for this
     challenge only) and play it **within *g* days** (default 14), or it **lapses**
     with no effect on the ranks.
  3. **Reported** by either side (their own score first, through the shared
     `scoreRefusal` and `flipScore`, as a league's result), **confirmed** by the
     other, or **disputed** for a manager to decide; one unanswered for 3 days
     stands. Only a *confirmed* result (or a forfeit or walkover) is an event and
     moves ranks. Court time for a ladder challenge is not held by the app: players
     book as anybody does.
  A manager may decide, correct, void or clear any challenge's result, with a
  reason, which replaces the event in its place as above, re-deriving every rank
  after it; both sides are told.
- **Inactivity.** A player whose last **activity** (joining, a played or forfeit-won
  challenge, a thaw, a drop) was **m days** ago (default 30; 0 turns it off) drops
  **p places** (default 1); the drop counts as activity, so the next is m days
  later. The scheduler writes the `drop` events; running it twice writes nothing
  more. Declining or ignoring does not count as activity.
- **Freezes.** A player (or a manager for them) can **freeze** their place until a
  date (at most the ladder's limit, default 60 days): nobody may challenge them,
  they may not challenge, their open challenges are cancelled without effect (the
  other side told), and they do not drop. The scheduler thaws them on the day (a
  `thaw` event); they can thaw sooner.
- **Managers' overrides**, each with a reason of at least three characters, logged
  in the activity log and kept in the event: move somebody to a rank, take somebody
  off, correct or void a result, put a frozen player back, add a player at a rank.
  Managers only (`MANAGER_ONLY`); front desk sees the ladder.
- **Seasons and the archive.** A manager **ends a season** (or the ladder, which
  closes it): open challenges are cancelled, the final order is archived
  (`ladder_seasons.final_ranks`) and shown, and a new season **carries** the order
  forward (or starts it empty when asked). The ledger of an earlier season is
  never changed.
- **Ratings.** A ladder marked rated feeds the ledger as a fourth source kind
  (`ladder`): each confirmed result is a played match, a forfeit or walkover is a
  walkover (moves nothing), nothing else is rated; a corrected or voided result
  voids its row and writes the new one, and the pool is replayed, by the existing
  ledger. The ladder's ranks are not a rating and a rating is not a rank.
- **Challenges are not public** (owner's decision, 5 November 2026). The public
  page and `GET /api/ladders/:id` show the ranks, who is on the ladder and the
  season's **confirmed results** (winner, other side, score with the winner's
  games first, day); never a challenge that is open or ended any other way
  (a walkover included: it would say who declined or did not turn up), who
  challenged whom, a proposed time, a dispute note, which places are in a
  challenge or an attached booking. A player sees their own, staff see all.
  `ladderDetail` is public by default and gives staff's fields only with
  `forStaff`.
- **Privacy and minors.** An adult ladder shows the names players gave; a junior
  ladder shows first name and the initial of the next word that is not a particle. A challenge is made, answered
  and reported by the guardian's account for a participant, and told to them; a
  stranger's challenge never reaches a child. No contact of a child is shown to
  anybody. Ages are declared, never verified; no identity documents are collected.
  A person's erasure takes them off the ladder (the gap closes, nobody else's rank
  changes otherwise) and replaces their name in its places by a placeholder.
- **Not built:** court time held by the app for a challenge (the ladder's matches
  are arranged privately), persistent teams as ladder entrants, a challenge
  between pairs of different strength, a ladder across venues.

## Consequences

- Both formats' state can be rebuilt from their record; a rebuilt state equals the
  stored one (tested). A correction is always one of: made, made as a preview showed
  it, or refused with the reason.
- Swiss pairing is exhaustive-search bounded; with many players and many rounds
  after many withdrawals the search could in principle give up on a pairing that
  exists, in which case the round is reported as unpaired and the organiser may end
  the event. The bound is far above what 128 entries need.
- A ladder replay is linear in a season's events and is run on every write; a
  season is bounded in practice (hundreds of events). Not measured at marketplace
  size.
- The Swiss event reuses the group stage's storage so the day-of-play, ratings and
  results machinery works unchanged, at the price that code that means "a group"
  must remember a Swiss round is one (`format = 'swiss'`).
