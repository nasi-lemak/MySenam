# ADR 0032: Consolation draws and double elimination, on the knockout graph

- **Status:** current, decided 2026-11-04 (the owner approved building consolation
  draws, double elimination, Swiss, ladders and counted performances; this record
  is the first two). Built in migration 0271. Extends
  [ADR 0012](0012-competition-rules-and-corrections.md) (corrections that never
  rewrite play) and [ADR 0013](0013-competition-framework.md) (one engine,
  configured by data); results still feed
  [ratings](0031-ratings-from-a-ledger-of-results.md). What organisers and players see
  is [tournaments](../../features/tournaments.md#consolation-draws-and-double-elimination).
- **Why this was deferred, and the bar:** the roadmap's evaluation of 2026-10-24
  said double elimination needs a losers' bracket fed from every winners' round
  and a grand final that may be played twice, so that *one changed result moves
  players in both brackets* and progression issues must follow two chains; it was
  not to be built until its whole progression and correction behaviour was
  specified and tested. This record is that specification, written before the code.
  Every rule below has a number, and `tests/double-elimination.test.ts`,
  `tests/consolation.test.ts` and `tests/brackets-structure.test.ts` name the rule
  each test proves.

## Decision

### G. One graph, no new engine

- **G1.** A knockout's matches already form a graph: a match has *a winner's
  route* (`next_match_id`, `next_slot`) and *a loser's route* (`loser_next_match_id`,
  `loser_next_slot`, used so far only for the third-place match). Both new
  structures are built on exactly that and nothing else: a match is a node with
  two sides, each side filled by one source, which is an entrant (the first round),
  the winner of a match, or the loser of a match. The single-elimination knockout,
  the third-place match, a consolation draw and a double elimination differ only
  in how the nodes are wired (`src/lib/brackets.ts`). The engine
  (`src/lib/tournaments.ts`) never asks which sport or which structure it is on
  where the graph answers: results, uncontested matches, corrections, issues,
  replays, leavers, court time, tournament day and ratings all work on the routes.
- **G2.** Every match has a `bracket`: `winners`, `losers` or `grand` (double
  elimination) or `consolation`; none stored means the ordinary knockout. Its `round`
  and `position` count within its bracket. All of them are `stage = 'knockout'`, so
  everything that reads knockout matches (the day board, the live page, officials,
  results by players, ratings) reads these too.
- **G3.** Two invariants hold after every operation, and the property tests check
  them after every step of whole events, corrections and leavers included:
  - **No state in which an entrant is in two matches still to play,** and every
    entrant in a played match went there by the route its result sent them.
    The only exception is the one a manager has been shown and chose (a
    record-only correction leaves the old route as played and says so, **P6**).
  - **No side that cannot be explained:** a side is empty only because the match
    feeding it is not decided yet, or was decided and sent nobody (a bye, or a
    loser of a bye), and a side that holds an entrant holds the one the feeding
    match's result sent.

### S. Settings

- **S1.** `format` gains `double_elimination`. A consolation draw is not a format:
  it is a choice on a straight knockout, in the tournament's rules, as scoring and
  leavers are (`rules.bracket`, `src/lib/tournament-rules.ts`):
  `consolation` (default off), `consolationThirdPlace` (off), `grandFinalReset` (on).
  A sport template copies them with the rest of its rules; a venue's own template
  keeps them; they are set when setting up and changed until the draw (`setRules`),
  never after, since results depend on them.
- **S2.** A consolation draw is refused for a format other than the straight knockout
  (not groups then a knockout, not double elimination), and
  `consolationThirdPlace` without `consolation`. The existing third-place setting is
  refused for double elimination, where third place is decided by the losers' final.
  `grandFinalReset` is read only by double elimination.
- **S3.** Double elimination takes 3 entries at least (two would be a final played
  twice) and up to the tournament maximum (128); a knockout with a consolation draw
  takes the knockout's 2 and has a consolation draw where S5 says it can.
- **S4.** Match length is data, by stage (`stageMinutes`, which the form shows by
  format): the stage keys gain `losers` (every match of the losers' bracket),
  `grand_final`, `reset` and `consolation` (every match of the consolation draw,
  its final and its third-place match included). The winners' bracket takes `knockout`
  and, for its last round, `final`, as the knockout does. A match keeps the length it
  was drawn with.

### D. The draw

- **D1.** Seeds, the rest drawn by lot, byes to the top seeds, are the knockout's
  own (`firstRound`, `seedOrder`); the order used (seeds first, then the drawn)
  is recorded on the tournament (`draw_order`, entry ids) for every format, and a
  draw built again from a recorded order gives the same matches, byte for byte
  (tested). There is no other randomness.
- **D2.** The structures are built by pure functions over a bracket size
  (`singleElimination`, `consolation`, `doubleElimination` in `src/lib/brackets.ts`),
  as lists of matches with their routes, tested apart from the database.
- **D3. Sources that do not exist are compressed away.** A bye leaves no loser. Where a
  match would have a source that never exists (a loser of a bye), and the other is a
  real source, the match is not created and the real source is wired straight on to
  where the match's winner would have gone; where neither exists, neither is. This is
  how the losers' bracket and the consolation draw take any number of entrants, with
  no match that has an empty side by structure.

### C. Single elimination with a first-round consolation draw

- **C1. Who is in it.** Those who lose a first-round match that is played: a bye is not
  a match, so a player with a first-round bye who loses their second match is out of
  the draw and not in the consolation. (This is the *first-round* consolation; the
  advanced *feed-in* that takes every loser is [ADR 0034](0034-feed-in-consolation-draws.md).) Byes go to the top seeds, so for a
  straight power-of-two field every player is in it on their first loss.
- **C2. When it exists.** Only where the main draw has a size of 8 or more (with 4
  the first round is the semi-finals, whose losers have the third-place match to play)
  and at least two first-round matches are played, so from six entries. Otherwise there
  is no consolation draw and the draw is made without it, as a third-place match is made
  only where there are semi-finals to take it from.
- **C3. Its shape.** `M` is the number of first-round matches played, `C` the smallest
  power of two holding `M`. It is a knockout of `C` lines, rounds numbered from 1, its
  last round the *consolation final*. Line seeds `1…M` are the main draw's played
  first-round matches ordered by how *close* they are: the match between the closest
  seeds (the highest favourite's number) is consolation seed 1, as its loser is
  expected to be the strongest. A line is filled by the **loser of that match**
  (the loser's route of every played first-round match), and lines are placed with
  `seedOrder(C)`, so the strongest losers meet the weakest and byes (D3) go to the top
  consolation seeds. Two first-round losers have never met (they lost in different
  matches), so the consolation's first round has no rematch.
- **C4. Its third-place match** (`consolationThirdPlace`) is played by the consolation
  semi-finals' losers after both, and exists only where both semi-finals are
  matches played, as the main draw's third-place match does (at least four in the
  consolation, `C >= 8`, or `C = 4` with `M = 4`).
- **C5. Counts.** The main draw has `n - 1` matches played (and a third-place match
  if set); the consolation has `M - 1`, plus its third-place match.
- **C6.** A player is in the main draw or the consolation at any time, never both: a
  first-round loser leaves the main draw at once.

### E. Double elimination

- **E1. Winners' bracket.** The knockout of `S` lines (`S` the smallest power of two
  holding the entries, 4 or more), rounds `1…k` where `k = log2 S`, byes as
  the knockout's, each winner on to the next winners' round, the winners' final's
  winner to the grand final's first side.
- **E2. Losers' bracket.** Rounds `L1 … L(2k-2)`. `L1` pairs the losers of
  first-round matches `2i-1` and `2i`. For each `r = 2…k` there is a *drop round*
  `L(2r-2)` where the survivor of the round before it (`L1` for `r = 2`, else the
  consolidation round `L(2r-3)`) plays the loser of winners' round `r`; for `r = 3…k` a
  *consolidation round* `L(2r-3)` pairs the previous drop round's winners `2p-1` and
  `2p`. The last drop round, `L(2k-2)`, is the *losers' final*; its winner is the grand
  final's second side. A player is out of the event on a second loss.
- **E3. The order losers drop in avoids early rematches.** Into drop round `L(2r-2)`
  the losers of winners' round `r` go **reversed** where `r` is even
  (position `p` into position `m + 1 - p`, `m` the matches in the round) and **in order**
  where `r` is odd. What this guarantees, and the tests check: **in losers' rounds 1 and 2
  nobody meets a player they have already played**, wherever the byes fall (every outcome of
  a field of 5 to 8, sampled for 9 to 32). Later, where the shape of the bracket forces it (a
  winners' round's loser against the survivor of a part of the losers' bracket that holds
  somebody they beat, the winners' final's loser in the losers' final, the grand final) two
  players who have met may meet again; that is not avoided and not hidden.
- **E4. Grand final and reset.** The grand final is the winners' champion against the
  losers' champion. If `grandFinalReset` is on and the **losers' champion wins it,
  a second match, the *reset*, is played between the same two**, whose winner is
  champion; if the winners' champion wins the grand final, the event is over and the
  reset is *not needed*. With the setting off, the grand final's winner is champion
  and there is no reset match.
- **E5. Counts.** `n` entries give `n - 1` winners' matches played, `n - 2` losers'
  matches, one grand final: `2n - 2` in all, and a reset where it is needed. For `n = 3`: 4.
- **E6. The reset is a match in the graph.** It exists from the draw with the grand final's
  winner's route and loser's route into its two sides, no entrants and the status
  *scheduled*. When the grand final is decided it is either **needed** (the losers'
  champion won: it holds the two, scheduled) or **not needed** (the winners' champion
  won: status *bye*, no entrants, no winner), and it is settled again whenever the grand
  final's result changes while the reset is not yet played (**P5**). A reset not needed
  keeps the court and time it was given, which are given back as unneeded time is;
  one that is needed again keeps them if still held, else has no court and a manager
  gives it one (*Move…*).

### P. Progression

- **P1.** A decided match puts its winner into its winner's route and its loser into its
  loser's route (`decide`), as the third-place match already is fed. A bye, or a match
  with nobody to win it, sends nobody on either route.
- **P2. Uncontested matches** (`resolveUncontested`) are settled as soon as nobody can
  contest them, over the whole graph: against a leaver, a walkover to the other
  side; a side nobody will ever fill (its feeding match was decided and sent nobody),
  a bye for the other; neither side, a bye that sends nobody. A leaver sits in the slot
  the route gave them until the other side is known, then loses there: in the losers'
  bracket a player who left is a walkover to whoever drops in against them.
- **P3.** An entrant who has left goes no further and never takes a slot that sends
  somebody on; what they had played stands (knockout results always stand).
- **P4.** All matches start after every match that feeds them (both routes) has ended, as
  the scheduler already keeps a round after the one before it, and a fixture is moved
  only between the ends of what feeds it and the starts of what it feeds.
- **P5. The reset** is settled by one function after every decision of the grand final
  or a change to it: grand final decided with the losers' champion winning: reset
  scheduled with both sides; the winners' champion winning: reset not needed;
  grand final not decided (a replay reset it): reset scheduled, empty. It never acts on a
  reset already played.
- **P6.** A finished tournament whose correction leaves a match to play (a reset that is
  needed again) goes back to *drawn*; finishing is still every match decided and no open
  issue.

### R. Corrections after play has begun

A result is entered, or put right, in a match; the two routes it feeds are the winner's
and the loser's.

- **R1. Plain.** A result goes in as an ordinary result when every match on both routes
  is still to play, or holds already the competitor the result would send (a match
  replayed). It moves both competitors: the winner along the winner's route, the loser
  along the loser's, in one transaction, so that a changed winners' result changes both
  brackets together, and the reset appears or goes (**P5**). A result in a match whose
  routes are all still to play can be put right as often as is wanted.
- **R2. Refused as plain.** If a match on either route has been played (a result, a
  walkover or a retirement), a result that is not the one already recorded is refused
  (`KNOCKOUT_STARTED`) and offered to a manager as a correction, exactly as in the
  single-elimination knockout (ADR 0012), with the same reasons, token and preview. The
  *put into the bracket* way (`replace`) is for group tables only: here the preview
  says the match it fed has been played.
- **R3. Record only.** The correction puts the record right and **moves nobody on either
  route**, even where only one of the two matches fed has been played (so that nobody is
  put in two matches). Where the competitor sent along a route is now wrong it opens a
  **progression issue for each route**, at most two per corrected match, listing every match
  the wrong competitor is in or has played, in the order played, each said in a sentence,
  previewed before anything is changed (who moves where, which later matches are
  played, which a replay would reset, which court holds change). The tournament
  does not finish while one is open.
- **R4. A chain** follows a competitor from the match they are wrongly in: if they won it,
  into its winner's route; if they lost it, into its loser's route; on, while the next
  match holds them, ending at a match they are not in, or have no route from. So
  one wrong win in the winners' bracket is followed down the winners' bracket
  *and* into the losers' bracket when the wrong competitor lost there. For a corrected
  grand final that makes a reset unneeded, the one issue is the played reset, with nobody
  to replay it for.
- **R5. Stand.** Let the matches as played stand, with a reason, as before.
- **R6. Replay.** The chain's matches are played again, the first with the right
  competitor in the wrong one's place and each later one with whoever wins the match before
  it, at courts and times the organiser gives and the tournament holds (the court time
  checks are `holdMatchSlot`'s, which the database backs: a booking is never moved);
  what was played is kept in the record. The places the replayed matches *fed* that are
  still to play (by either route, whoever they sent there) are emptied so they wait for
  the replay's results, so that nobody is in two matches still to play; what has been
  played stands. Where a correction left each competitor in the other's place (the two
  issues of one winners' result), replaying either replays **both together**, one change,
  each head of chain taking the other's right competitor, so nobody is in two places at any
  moment; the main draw's third-place match keeps its own rule (below). It is **refused**, as the single-elimination knockout
  refuses, when the right competitor has left, nobody is right (the reset that is no
  longer needed), the chain has changed, or the right competitor is **already in a
  match that is neither one they came through nor one of the matches being replayed together**
  (so replaying the loser's route alone, after the winners' route was let stand, is refused:
  the right competitor is in the winners' route's played match). The main draw's third-place
  match keeps the rule it had: its issue is replayed alone, and refused while the competitor
  due the place is in the final. A replay that changes who goes on again is a correction of
  its own.
- **R7.** Every correction and resolution is confirmed with a reason against a token of the
  tournament as it was reviewed, kept in `tournament_corrections` with what changed and the
  matches before, and in the staff activity log; a manager's only.

### L. Somebody leaving

- **L1.** Before the draw the place goes to the waiting list, as ever. After it, at each
  stage, in whichever bracket: they go no further (P3), the matches they have left are
  walkovers to the other side as soon as it is known (P2), so a leaver in the winners'
  bracket sends their loser's route a leaver too, and gives each opponent a walkover in
  both brackets in turn; a leaver in the losers' bracket is out of the event; a leaver in
  the consolation draw leaves it, the main draw having nothing of theirs left.
- **L2.** The out-policy of the event (withdrawn, retired and disqualified; stand or
  void) concerns group tables only and is unchanged: a knockout result always stands.
  The stage recorded for a leaver in these brackets is *knockout*.
- **L3.** Previewed and confirmed as ever: the preview is a rolled-back run of the real
  change and says each match that changes, which are walkovers, where the reset goes.

### F. Placings

- **F1.** When the tournament is finished every entrant who was in the draw has a place,
  and levels share one (joint third, joint fifth), computed by `placings` from the
  matches as they stand, never stored.
- **F2.** Knockout: champion, runner-up, third and fourth by the third-place match where
  there is one (else joint third), then those out in each earlier round together, deepest
  first. With a consolation draw the main draw's places go to those who won a first-round
  match or had a bye, and the consolation draw's own places (its champion first, its
  third-place match, then by round) follow after them.
- **F3.** Double elimination: champion and runner-up from the reset where it was played,
  else the grand final; then by the losers' round in which they were put out, the last
  round first (third is the loser of the losers' final).
- **F4.** An entrant who left stands where the matches put them, flagged as out, as in a
  group table; none is put last for leaving.

### T. Court time and everything else that already works

- **T1.** Every new match is placed by the interval scheduler (`scheduleTimed`), with the
  length its stage gives it, after every match that feeds it on either route; a reset
  is placed with the rest and, where it does not fit, left without a court rather than
  refusing the draw.
- **T2.** Moving a fixture, the day board (check-in, rest, calls, no-shows, swaps),
  the announcements, the live page, officials' links and players' own results work on
  the new matches unchanged, with names that say what the match is (*Losers' round 2,
  match 1*, *Grand final*, *Grand final reset*, *Consolation final*). Nothing else in
  tournament day reads which bracket a match is in.
- **T3. Concurrency.** A result is entered under the tournament's row lock, as moving a
  fixture, taking somebody out and changing a tournament already are, so a result and a
  move, or two results, are one change at a time (tested on Postgres).

### K. Ratings

- **K1.** Ratings are unchanged and never a scoring path (ADR 0031): the ledger reads every
  decided match between two entrants of a rated tournament, whatever its bracket, so a
  winners', losers', grand-final, reset or consolation match is rated like any knockout
  match, counted as played, as a walkover (moves nothing) or a retirement (half). A bye is
  not a match, nor is a reset not needed (no entrants), nor is a first-round loser's
  empty consolation slot; a consolation match between two first-round losers is a match
  between two entrants and counts. A correction or a replay changes the results and the
  ledger is read again as for any knockout (tested, including a correction through two
  chains).

### N. Not built, and why

- A consolation draw after groups, or double elimination after groups: each is a different
  wiring of the same graph, not built until asked for. (A *feed-in* consolation, for every
  loser but the runner-up, was asked for later and is built as an advanced option:
  [ADR 0034](0034-feed-in-consolation-draws.md).) A losers' bracket of three, where a player may be put out
  with no second loss, is not a format here.
- A reset that is *optional* in the middle of an event: it is a setting of the tournament,
  fixed at the draw.
- Players' own rating bands, an enforced level, rematch-free losers' brackets beyond **E3**
  (the shape forces some).

## Consequences

- **One correction workflow for every structure.** Because the routes are data, a manager
  corrects a double elimination exactly as a knockout: refused as plain, previewed, record
  only, issues, stand or replay. What is new is that there are two chains, that the
  preview shows them, and that the order in which they are replayed matters (R6).
- **A replay arranges only what the wrong competitor played.** It does not pull back players
  the replayed matches' losers have since beaten in the other bracket; if a replayed match is
  decided differently from how it went, that is a correction of its own, as before.
- **One intentional change to the knockout's replay.** The places a replayed match fed that
  are still to play are now emptied whoever they hold: before, the opponent who beat the wrong
  competitor was left in the next match while their own match was replayed (in two matches still
  to play). Nothing that was played changes.
- **The reset needs a court.** It is held with the event, given back if not needed, and
  may need a manager to give it a court if it comes back after its time was given back.
- **Cost.** `tournaments.ts` grows by the routes' generalisation, `brackets.ts` by the
  structures; there is one new column on matches, one on tournaments, a widened check on
  format, and three test files.
