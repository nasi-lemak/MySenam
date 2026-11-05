# ADR 0038: Swiss: accelerated pairing, a tie-break screen, and Swiss for performance events

- **Status:** current, decided 2026-11-05 (the owner asked for these three Swiss
  items to be built; each rule below is the one the code follows). Built in
  migration 0279. What organisers and players see is in
  [tournaments](../../features/tournaments.md#accelerated-pairing),
  [the tie-break screen](../../features/tournaments.md#the-tie-break-screen) and
  [Swiss for performance events](../../features/tournaments.md#swiss-for-performance-events).
  Extends [ADR 0033](0033-swiss-tournaments-and-club-ladders.md), which stands for
  everything it does not say here; uses
  [ADR 0035](0035-rating-policy-published-rankings-and-counted-results.md)'s ruling
  that counted results are never rated, and
  [ADR 0013](0013-competition-framework.md): each of the three is data (rules and
  stored fields) read by the one engine, never a branch on the sport.
- **Context:** ADR 0033 listed three things as not built: accelerated pairings, a
  tie-break order that is more than an API setting, and Swiss for performance
  events. All three share the property that decided Swiss in the first place: what
  happens next depends on what has happened. So the same discipline holds. **The
  record of results is the truth; a pairing, a grouping or a table is a pure
  function of it plus a few stored choices; a change to the past is previewed,
  offered as what it does, and never silently reshuffles anybody who has been told
  where to be.**

## Part 1: Accelerated pairing

- **What it is.** For the first *R* rounds, the top half of the initial order is
  paired as if each had one more win than they have, so the strongest meet early
  and the field sorts itself in fewer rounds. The extra is a **virtual point**: it
  decides who meets whom and nothing else.
- **The option** is `rules.swiss.acceleration` (a number of rounds, *R*, 1 or more;
  absent or null: off, the default), chosen **before the draw** like every rule
  (`setRules` refuses a change once the draw is made). It needs at least one round
  paired as usual: *R* must be less than the rounds the event plays (the creation
  refuses it where the rounds are set, the draw where they are the default), and it
  is for a Swiss event only. The set-up screen offers it with a default of 2.
- **The accelerated group** is the top half of the initial order rounded up to an
  even number: the best 2⌈n/4⌉ of the *n* entries drawn (4 → 2, 5 or 6 → 4, 8 → 4,
  9 or 10 → 6, 16 → 8). Even, so that round 1 pairs it within itself. It is fixed
  **at the draw**: a withdrawal later does not move anybody in or out, and the
  group's members are those with `swiss_rank` at most the stored size. The group, *R*
  and the virtual value are stored on the event (`swiss_events.accel_group`,
  `accel_rounds`, `accel_points`), so a pairing reads what the event was drawn with
  even if the rules were later edited.
- **The virtual point's value** is what a win is worth in the template's table
  points (`scoring.tablePoints.win`, normally 1), stored as `accel_points`. Each
  member of the group carries it into the pairing of rounds 1 to *R*, and into none
  after: from round *R* + 1 the pairing reads real points alone.
- **The pairing is otherwise ADR 0033's, unchanged.** Players are ordered by their
  **pairing score** (real points plus the virtual point) then by the initial order;
  the Dutch halves are taken within a *score group* of pairing score; nobody meets
  twice; sides are balanced as before. A pairing that crosses pairing-score groups is
  a float, as before. Nothing about the search changes, so it stays bounded and
  deterministic.
- **Virtual-point bookkeeping.** A virtual point is **never stored for a player and
  never written anywhere a result goes.** It is computed on each call of the pairing
  (`virtualPointsFor(round, R, group, rank, points)`) from the stored fields and the
  player's place in the initial order, handed to the pairing as `PairingPlayer.virtual`,
  and dropped when the call returns. `swissStandings`, the function that makes every
  table, final order and tie-break, has no parameter that could carry it. It is in no
  match row, no table, no Buchholz or other tie-break (an opponent's *real* points
  are what Buchholz sums), no rating (the ledger reads decided matches only) and no
  public standing. What is kept is the **reason for each pairing**: the note of a pair
  keeps the two real points (`aPoints`, `bPoints`) and, only where there were any, the
  virtual ones (`aVirtual`, `bVirtual`), and staff and the public pages show them as
  "0 + 1 accelerated" beside the real points, so a pairing is explained and a point is
  never mistaken for a result.
- **Byes.** The bye still goes to the lowest-ranked player without one, by pairing
  score then initial order. In round 1 that is the last of the second half, a player with no
  virtual point (the group is the top half, and with an odd field the second half is the
  odd one). Later it can be anybody the rules reach. A bye is worth the event's bye points
  in the table (real) and the player's virtual point, if they have one, is for pairing only.
- **Withdrawals and odd fields.** A leaver is not paired again; their opponent has the
  walkover and the real point; the group does not change size, so a group that has lost
  a member pairs with a float or a bye as an odd group does. Odd fields work as above.
  Pairing that cannot be done without a rematch is reported unpaired, as before.
- **Corrections and replay.** The pairing of round *r* is a pure function of the
  recorded results of rounds before it, the stored initial order and the stored
  acceleration. A correction that pairs again (ADR 0033, `replace`) calls the same
  function on the corrected results, so the new round carries the virtual points again
  and equals a fresh pairing from those results (tested). A correction that keeps the
  pairings (`standings_only`) changes the table only, which never held a virtual point.
- **Reproducible.** The initial order is drawn from the recorded seed
  (`swiss_events.seed`); with that seed, the stored acceleration and the results, every
  pairing can be made again. Nothing is random but the draw's order, as before.
- **Preview.** Staff can see the next round as it would be paired now, with each
  pairing's reason, the bye, and whether the court time held takes it, before it is made
  (`previewNextRound`; `{ action: "swiss_preview" }`). It changes nothing. A round pairs
  by itself the moment the one before is decided, so the preview is for the round that
  could not be paired (no court time, a manager asked to pair it again); round 1 is paired
  at the draw and its reasons, virtual points included, are on the page at once.
- **Simplification, said plainly.** FIDE's Baku acceleration lowers the virtual point in
  the later accelerated rounds (a point, then half a point). This is the constant version:
  the same virtual point in every accelerated round, then none. A venue that wants the
  graded one asks for it; it would be a rule on the same stored fields.

## Part 2: The tie-break screen

- **Every published tie-break is a column.** Buchholz, median Buchholz, **Buchholz
  without the lowest opponent (Cut-1)**, **Sonneborn-Berger** (the real points of the
  opponents beaten, half those of the opponents drawn with), wins, set difference, set
  ratio, point difference, point ratio, points scored, and who beat whom (direct
  encounter). Cut-1 and Sonneborn-Berger are new keys of the same list
  (`SWISS_TIEBREAKS`) and are computed from the same results as the others; the default
  sequence is unchanged, so no existing event's table changes.
- **Which tie-break separated two entries, and by how much.** For each entry level on
  points with the one ranked just above it, the table says the first tie-break, in the
  event's order, on which they differ and both values (`SwissTie`); for direct encounter,
  that the one above won their match; and **where no tie-break separates them, that only
  the initial order (the stored seed) does**, flagged and said in words as well as marked.
  The explanation and the order come from one comparison (`swissStandings`), so what is
  said is what ranked them. Entries whose results are void are listed apart and have none.
- **Choosing the sequence.** Before the draw it is a rule like the others
  (`rules.swiss.tiebreaks`, through `setRules`). The screen, for a manager, lets the
  sequence be reordered, added to and removed from, and shows the table it would make
  **as it is built** (`previewTiebreaks`: who moves, the separations, who only the seed
  orders), without saving anything.
- **Locked from round 1's pairing.** Round 1 is paired at the draw, so from the draw the
  sequence is locked: a change is made only by a manager, with **a reason (at least 3
  characters) and the token of the preview they looked at**, under the event's row lock,
  against the table they saw (`CHANGED` if a result arrived since; `TIEBREAKS_LOCKED`
  without a token or reason). The same sequence is refused. It is saved in
  `swiss_events.tiebreaks` (what the table reads) and in the rules (so what the rules say
  is what is used), also for a finished event.
- **What a recompute changes.** The table, and nothing else. A round is paired on points
  and the initial order and never reads a tie-break, so no pairing moves, no result or
  rating changes, and no round is paired again; there is nothing to refuse beyond the stale
  preview. (A tie-break order that decided pairings would be the "recompute with a preview"
  of the brief in a stronger sense; this one never does.)
- **Audit.** The change is in the activity log (`tournament.swiss_tiebreaks`) with the
  sequence before and after and the reason.
- **Public.** The public standings show the event's own tie-breaks, in order, as columns
  (short names, the long name on hover or read out), beside the points; the names rule for
  minors is unchanged, and no screen shows a tie-break value that is not a number from the
  results.

## Part 3: Swiss for performance events

A performance event ranks competitors by what they did, not by whom they met. There is
nothing to pair. What carries over is the idea that each round is organised from the
standings the rounds before left. This is built for **counted events** (bouldering tops
and zones, climbing by height: ADR 0035 says counted results have no two-sided result and
are never rated), and said plainly: **it forms groups, not pairings.**

- **The format is a counted performance event with `rules.swiss`** set (`format`
  `performance`; `rules.swiss: { rounds, cumulative, bestN? }` beside
  `rules.performance.counted`), chosen before the draw, **with no final** (the final size
  must be 0: the ranking is the rounds together). It is refused for an event of marks, for
  a final, for fewer than 2 rounds, and for acceleration, bye points or tie-breaks, which are
  head-to-head settings (`swissRefusal`). Rounds default to the larger of 2 and ⌈log₂ n⌉.
- **Every round is the same boulders (or route) for everybody and is ranked across all its
  groups together**, by the event's own counted ranking (`rankCounted`, the keys and
  tie-breaks of the event). A group is how the field is spread over the wall in time, not a
  separate competition. Round placings share where level (1, 2, 2, 4), as the event ranks.
- **Forming the groups.** Round 1 takes the **initial order** (staff seeds first, then an order
  drawn from the recorded seed, the only randomness; `drawInitialOrder`, shared with head-to-head
  Swiss). Round *r* + 1 is formed, **as soon as every group of round *r* is in**, from the
  standing the rounds so far leave: **adjacent places form a group**. Group sizes are as even as
  they can be, the larger first, **never a group of one**, nobody sits out (so there is no bye): the
  number of groups is the fewer of ⌈n / size⌉ and ⌊n / 2⌋ (3 climbers with a size of 2 are one group of
  3). The best group climbs last, and in each group the worst-placed starts first and the best
  last (the event's `finalStart` "reverse", as a final starts; "ranking" puts the best first
  throughout), the same convention as the rest of counted events. Each group is a `heat` match with
  the round in `round`, so the day's board, officials' links, the live page, court time and match
  lengths (the heat stage's) work unchanged; the competitor's order of start is their lane.
  Everybody still in is told their group, number to start and time.
- **"Avoid repeat groups" is not a rule here, and why.** Two climbers in a group do not compete
  with each other any more than with anybody else on the wall: every competitor is ranked against
  the whole round, so who shares a group changes nobody's placing. A repeat has no fairness
  effect to avoid. Grouping by standing is what the Swiss idea gives a climbing event (climbers of
  alike form together); nothing else about who stands next to whom is claimed.
- **The standing across the rounds** is one of two **cumulative rules**, data in
  `rules.swiss.cumulative` and stored at the draw (`swiss_events.cumulative`, `best_n`):
  `sum_of_placings` (the sum of the placings in every round) or `best_n` (the sum of the best
  *N* placings). **The fewest points wins.** Only rounds with every group in count (the standing
  never changes under a round half climbed). A competitor with no result in a round (did not start,
  did not finish, disqualified, left, or not grouped) is placed **one behind the last who has one**.
  **Level on the total**, the better placings decide (the best placing, then the next, over every
  round, including those a best-*N* rule leaves out of the total), then the initial order; **a place is
  shared only where nothing but the initial order separates two**, and the table says which tie-break
  separated two and by how much, as Part 2 does. The order the next round is grouped by is total and
  deterministic (the seed breaks what is still level).
- **Results enter only through `recordPerformances`** (staff, officials, as today); a grouping is a
  consumer. Results go in under the event's row lock, so two groups completing a round at once group
  the next once. Counted lines are the judge's record; every placing and total is worked out from
  them on every reading, so a corrected count re-ranks with nothing to drift (property-tested against
  an independent working).
- **Corrections: flagged, never reshuffled.** A count put right is made at once (nothing is refused: it
  can only change a derived standing). **No later round's groups ever move because of it.** Where the
  corrected standing would form a later round's groups differently, that round is **flagged for review**:
  the page lists each competitor who would change group, the correction's preview says so, and the
  flag is derived (the groups as stored against the groups the corrected standing would give), so
  nothing is stored that could drift. A flag looks only at the order, with each group keeping the size it
  has among those still ranked, so somebody leaving or being disqualified after the round was grouped
  raises none. Then a manager chooses:
  - **Keep the groups** (with a reason): the flag is cleared for exactly that expected grouping
    (`swiss_rounds.kept_for`), and returns if a later correction changes it. Nobody moves.
  - **Group the round again**, previewed and confirmed with a reason and the preview's token
    (`previewRegroup`, `regroupFrom`): the round's groups and those of every later round are removed
    and the round is formed afresh from the corrected standing and placed in the court time held, the
    competitors told. **Possible only while nobody has climbed that round or a later one** (`CLIMBED`
    otherwise: a round climbed is never rewritten), and whole or not at all (a round that does not fit the
    time held refuses the lot, and nothing changes). Later rounds are formed again when this one is in.
  An official's lock follows the same fact: a round is *advanced* (an official sends a correction request,
  not an overwrite) once a later round has any climb.
- **Somebody leaving.** A competitor out is not grouped in a round not yet formed; in a round already
  formed their lines did not start; what they climbed stands or is void by the event's rules (a
  disqualification voids it, and they are listed last with no place); the rounds they miss count as above.
  If fewer than two are left, the event ends with the rounds it has.
- **Not rated.** There is no two-sided result, so nothing reaches the ledger and a counted event cannot be
  marked rated (ADR 0035 stands). Bye, repeat and consolation kinds do not arise.
- **Names.** The page, the standing and each round's groups show a declared minor by first name and
  initial (`namedForThePublic`); the grouping data carries entry ids only.
- **Storage.** The groups are `tournament_matches` rows (stage `heat`, the round in `round`) with their
  `tournament_performances` lines; the event is a `swiss_events` row (rounds, the recorded seed, the
  cumulative rule) and a `swiss_rounds` row per round (the reason each group was formed: each member's
  place and total in the standing it was formed from). The tie-break columns of head-to-head Swiss are
  empty for it.
- **Not built:** a final from the rounds (an event of rounds and a final is the existing qualification
  format with one round); a geometric-mean or other combined-ranking rule (the cumulative rule is data, so one
  could be added); grouping that avoids repeats; Swiss for events of marks (times, distances), whose heats
  are seeded by entry mark.

## Consequences

- All three are pure functions of stored results plus stored choices, so a table, a pairing or a grouping
  rebuilt from the record equals the stored one (tested); nothing is nudged in place.
- Accelerated pairing is the constant virtual point of Part 1, not Baku's graded one; a venue wanting
  FIDE's exact scheme needs a further rule on the same fields.
- A tie-break change after the draw moves the table only, so the screen's "confirm a recompute" is a
  confirmation of the table, not of pairings.
- A counted event in Swiss rounds is a different shape from a qualification and a final: the court time of
  all its rounds must fit at the draw, and the held time is kept until the last round is grouped, as for head-to-head
  Swiss.
