# ADR 0034: An advanced feed-in consolation draw, on the knockout graph

- **Status:** current, decided 2026-11-04. The owner asked for an all-loser feed-in
  consolation as an **optional advanced format, never the default**, built only if it
  can be made correct inside the existing draw architecture and, if that needs
  disproportionate complexity or cannot be integrated safely with the scheduling engine,
  documented as a deferred capability instead. This record is the specification, written
  before the code, and its answer: **it can, and it is built.** Extends
  [ADR 0032](0032-consolation-draws-and-double-elimination.md) (the graph, the two
  routes, corrections that never rewrite play), whose *N* section left it unbuilt; results
  still feed [ratings](0031-ratings-from-a-ledger-of-results.md). What organisers and
  players see is [tournaments](../../features/tournaments.md#the-advanced-feed-in-consolation-draw).
  No migration: a consolation match is already a match with `bracket = 'consolation'`
  and the setting is a value in the tournament's rules.
- **The question the owner set:** can every loser of a knockout be fed into a consolation
  bracket, with match dependencies, court resources, player availability and schedule
  feasibility correct, corrections included, *without restructuring the scheduler or the
  progression code*? ADR 0032 built every piece the answer needs: a match with a winner's
  route and a loser's route, a losers' bracket fed from every winners' round
  (`doubleElimination`), uncontested matches settled over the whole graph, corrections along
  two routes with sibling replay, placings read from the matches. A feed-in consolation is a
  *different wiring of those same nodes*: the losers' bracket of a double elimination
  without the winners' final's loser and without a grand final. So the decision is to build
  it, and to prove it with the same tests as ADR 0032 plus a count of every match. Every rule
  below has a number, and `tests/feed-in-structure.test.ts`,
  `tests/feed-in-consolation.test.ts` and `tests/components/feed-in-ui.test.tsx` name the
  rule each test proves.

## Decision

### G. One graph, no new engine

- **G1.** The format is a **mode of the consolation draw** of a straight knockout. Its
  matches are stored as `bracket = 'consolation'`, `stage = 'knockout'`, with the routes
  of ADR 0032 (G1): the main draw's match sends its loser to a consolation match by its
  loser's route. Nothing in `src/lib/tournaments.ts` asks which mode a tournament is in
  except the draw (which structure to build), the settings (what is allowed and confirmed)
  and `placings` (which stages the main draw has); results, uncontested matches,
  corrections, previews, issues, replays, leavers, court time, tournament day and ratings
  read the routes, as they do for every other structure.
- **G2.** The two invariants of ADR 0032 (G3) hold after every operation and are checked
  after every step of whole events, corrections and leavers included: nobody is in two
  matches still to play, and every side is either empty because the match feeding it is not
  decided or sent nobody, or holds the one the feeding match's result sent.

### S. Settings

- **S1.** `rules.bracket.consolationMode` is `"first_round"` or `"feed_in"`. It is **stored
  only for `"feed_in"`**: where it is absent, and for every tournament, template and
  venue template saved before this record, the mode is `"first_round"` and `consolation:
  true` means exactly what it always did (ADR 0032, C). Nothing is rewritten.
- **S2.** It is offered and accepted only with a consolation draw (`consolation: true`) on
  a straight knockout (ADR 0032, S2: not groups then a knockout, not a double elimination),
  and it is **advanced**: off unless chosen, labelled so on the form. It is refused with the
  knockout's own third-place match (`thirdPlace`): the semi-finals' losers go into the
  consolation draw (C3), so a main third-place match would take them twice. Switching the
  consolation draw off, or back to the first round, takes the mode away. It is set when
  setting up and changed until the draw (`setRules`), never after.
- **S3.** `consolationThirdPlace` keeps its meaning (a match of its own for the losers of
  the consolation draw's last drop round, C5) and is read in either mode.
- **S4.** Match length is the consolation stage's (`stageMinutes.consolation`, ADR 0032,
  S4), for every consolation match; the main draw's are the knockout's and its final's.

### M. What it costs, shown and confirmed before it is saved

- **M1. The counts** (`feedInConsequences`, from the structure the draw is built from, not
  from a formula alone). For `n` entries (5 or more, C2): the main draw has `n − 1` matches
  played; `n − 2` entrants (everybody who loses a main match but the final's loser) play in
  the consolation draw, one champion, so it has **`n − 3`** matches; with its third-place
  match, one more where both of the last drop round's matches are played. The whole event
  is **`2n − 4`** matches (`2n − 3` with the third-place match), against `n − 1` for a plain
  knockout and `n − 1 + M − 1` for the first-round consolation. The test proves this for
  every size 5 to 64 and 128, by the structure and, to 40 with byes, by playing events.
- **M2. Court time and rounds.** Each match is given the length of its stage; the extra
  court hours are the consolation matches' minutes, the total is the whole event's. The
  **rounds** are the longest chain of matches that must follow each other (every match after
  the matches that feed it, ADR 0032, P4): for a field that fills a bracket of `2^k` lines,
  `2k − 2`, against `k` for the knockout, so the event takes about twice as many rounds.
  **The most matches one entrant can play** is the longest path an entrant can take through
  the routes (a first-round loser who wins every consolation match plays `2k − 2`; the
  champion `k`); the test proves that some outcome reaches it and none exceeds it.
- **M3. Whether the held time could hold it** (`fitsHeld`): the court time held (courts ×
  hours each day × days) against the whole event's minutes. It is an *estimate shown to
  the organiser*; the authority is the draw (T2).
- **M4. Seen and confirmed.** The setup form and the tournament's panel (until the draw)
  show the numbers for the entries counted (those entered, or the most the tournament
  takes while fewer than five have), and the choice is saved only after a confirmation that
  says them: *This adds 13 matches and about 6.5 court hours.* Changing its third-place
  match asks again, as it changes the count. The server enforces it, so the screen cannot
  be the only guard: creating or changing a tournament to the feed-in mode without
  `confirmFeedIn: true` is refused (`FEED_IN_CONFIRM`) with the same numbers in the answer
  (`vars`). A change to anything else while it is on is not asked about again.
- **M5. A preview API.** `GET /api/admin/tournaments/:id/feed-in-preview` answers with the
  same numbers for the entries it has, or for `?entries=` and `?consolationThirdPlace=`, to
  any staff of the venue, changing nothing.

### D. The draw

- **D1.** Seeds, byes, the draw by lot and the recorded order are the knockout's
  (ADR 0032, D1); the consolation draw is a pure function of the bracket size and the first
  round (`feedInConsolation`, `src/lib/brackets.ts`), tested apart from the database. The
  same draw order gives the same matches.
- **D2. Sources that do not exist are compressed away** exactly as ADR 0032 (D3): the loser
  of a bye is nobody, a consolation match with one real source is not made and the real
  source is wired on to where its winner would have gone. This is what lets it take every
  size from 5 to 128 with no match that has an empty side by structure (tested for every
  size to 40, with and without the third-place match).
- **D3.** It is made by `makeDraw` beside the main draw, inside the same transaction, and the
  main draw's own routes into it are the `losersTo` the structure returns, the way the
  first-round consolation's are. A field of fewer than five entries has none (C2): the draw
  is a plain knockout, and the form says so.

### C. The structure

- **C1.** `k` is the main draw's rounds (`2^k` lines, 8 or more). The consolation draw is the
  losers' bracket of ADR 0032 (E2) for rounds `1 … k−1`: **round 1** pairs the losers of
  the main first-round matches `2i−1` and `2i`; for each main round `r = 2 … k−1` a **drop
  round** `2r−2` has the survivor of the round before play the loser of main round `r`, and
  for `r = 3 … k−1` a **consolidation round** `2r−3` first pairs the previous drop round's
  winners; the **consolation final** is round `2k−3`, between the winners of the last drop
  round (the semi-finals' losers' round). The main final's loser alone does not play on.
- **C2.** It exists from five entries (a main draw of eight lines). With three or four entries
  the first round is the semi-finals and a feed-in would be a third-place match, which the
  knockout already has.
- **C3. Every loser but the runner-up plays on.** A first-round loser plays round 1, a
  second-round loser drops into round 2, … , a semi-final's loser into the last drop
  round; so every entrant plays at least two matches (the champion and the runner-up the
  main draw's, everybody else one main match and at least one consolation match; a walkover
  is a result, not a match played). A player who lost a main match is never in a main
  match again: the consolation draw is *entered* by the loser's route and the main draw's
  places are filled by winners' routes only.
- **C4. The order losers drop in avoids early rematches**, as ADR 0032 (E3): into drop
  round `2r−2` the losers of main round `r` go reversed where `r` is even and in order where
  it is odd. What it guarantees, and the test checks over **every outcome of every field of 5
  to 8** and sampled for 9 to 32: *in consolation rounds 1 and 2 nobody meets a player they
  have already played*. Later, where the shape forces it, two who have met may meet again;
  that is not avoided and not hidden.
- **C5. Its third-place match** (`consolationThirdPlace`) is played by the losers of the last
  drop round's two matches, after both, and exists only where both are matches played.
- **C6. Not a second main draw.** The consolation draw never feeds the main draw; the only
  route between them is the main loser's.

### P. Progression

- **P1.** As ADR 0032 (P1): a decided match puts its winner into its winner's route and its
  loser into its loser's route, in the one change. The loser of a bye is nobody; a match
  nobody can win sends nobody.
- **P2.** Uncontested matches are settled over the whole graph (ADR 0032, P2): a leaver sits in
  the slot the route gave them until the other side is known, then loses there, so a player
  who left the main draw is a walkover to whoever drops in against them, in the
  consolation draw too.
- **P3.** All matches start after every match that feeds them, on either route (T1).

### R. Corrections after play has begun

ADR 0032's R1 to R7 apply unchanged, because they are written in terms of the routes. What
this record adds is what they do here, each proved in `tests/feed-in-consolation.test.ts`:

- **R1.** A result in a main match whose two routes are still to play is put right as a plain
  result and moves both competitors, the winner on in the main draw and the loser into the
  consolation draw, in one change (a first-round match, and a semi-final into the last drop
  round).
- **R2.** If a match on either route has been played, a different result is refused as plain
  (`KNOCKOUT_STARTED`) and offered as a correction: whether it is the main draw's next
  match, a first-round loser's consolation match, or a semi-final's loser's drop-round
  match.
- **R3.** A record-only correction opens **an issue for each route**, the second following
  the wrong competitor on through every consolation match they played; both are listed and
  previewed before anything changes; the tournament does not finish while one is open.
- **R4.** *Stand* lets both stand; *replay* replays **both** chains together (ADR 0032, R6),
  the right competitor in the head of each, at courts and times the organiser gives and the
  tournament holds. What was played stands: where the replayed chain's last match fed a
  match already played (a drop-round match that fed a played consolation final), the
  opponent who beat the wrong competitor stays in that played match while the replayed match
  is played again, and if it is decided otherwise that is a correction of its own — the
  consequence ADR 0032 already states, tested at the deepest place.
- **R5. Replay-from-scratch equality.** For every match of an eight-entry event, every match
  of a six-entry one (byes and compression) and every third match of an eleven-entry
  one, correcting its result while nothing it feeds has been played, then playing on, gives
  exactly the matches (by place, sides, status and winner) of the same event played from
  scratch with the corrected result.

### L. Somebody leaving

- **L1.** Before the draw the place goes to the waiting list; after it, in either draw, the
  leaver goes no further (ADR 0032, P3): their main matches are walkovers to the other side as
  soon as it is known, their consolation slot a walkover to whoever meets them, and a leaver in
  the consolation draw is out of the event. Tested before the first round, at four stages of an
  eleven-entry event and for each of withdrawn, retired and disqualified, with every
  result played standing and the event finishing with a place for everybody.
- **L2.** The out-policy concerns group tables only (ADR 0032, L2), unchanged; the stage
  recorded for a leaver is *knockout*.

### F. Placings

- **F1.** When the tournament is finished everybody who was in the draw has a place, levels
  sharing one, computed from the matches as they stand (`placings(matches, { feedIn })`),
  never stored.
- **F2.** The main draw places only its final's two: the champion and the runner-up.
  Everybody else is placed by the consolation draw: its champion **third**, its runner-up
  **fourth**, then (with the consolation third-place match) that match's two, **fifth** and
  **sixth**, then the others by the consolation round they were put out in, the last round
  first, level within a round. Places say how late somebody was put out of the consolation
  draw, never how strong they are: a first-round loser who wins two consolation matches and
  loses the third finishes above a second-round loser who loses their drop-round match at once.
  Tested for every size in the list and both settings.

### T. Court time and scheduling

- **T1.** Every consolation match is placed by the interval scheduler, with the length of its
  stage, after every match that feeds it on either route, and the main draw's matches are
  placed first, so the consolation draw takes the court time the main draw leaves and **never
  delays it**. A player cannot be in a main match and a consolation match at once: the graph
  orders them, a consolation match waits for the main match that feeds it, and where the
  entrants of a side are not known the scheduler keeps the place clear of the competition's
  other divisions (`sideBusy`/`could`, ADR 0032, T1; tested with a sibling division that
  shares the players: nobody on two courts at once, never two matches on a court).
- **T2. Refused with an explanation when it cannot fit, changing nothing.** `makeDraw` places
  every match before writing any: where the held time cannot hold them all it says *Not
  enough court time: N of M matches do not fit in the hours held. Add courts, hours or days,
  shorten the matches, or take fewer entries.* and the tournament is as it was (no matches,
  no recorded order). Tested with a field that a plain knockout fits in the same time.
- **T3.** A result is entered under the tournament's row lock (ADR 0032, T3): two first-round
  results feeding the same consolation match go in together, and a semi-final's result and a
  move of its drop-round match are one change at a time (tested on Postgres).
- **T4.** Tournament day (the board, check-in, rest, calls, no-shows, swaps), announcements,
  the live page, officials' links and players' results work on the consolation matches
  unchanged, named *Consolation round n, match m*, *Consolation final*, *Consolation
  third-place match* in the staff and customer languages.

### K. Ratings

- **K1.** As ADR 0032 (K1), nothing new: the ledger reads every decided match between two
  entrants of a rated tournament, whatever its bracket. A bye is not a match; a consolation
  match between two entrants counts as played, as a walkover (moves nothing) or as a
  retirement (half); a correction replays the ledger. Ratings are never a scoring path.
  Tested: a seven-entry event writes ten rows, a correction in either draw replaces its
  row.

### N. Not built, and why

- A feed-in after groups, and a feed-in for a double elimination (whose losers' bracket is
  already a feed-in): different wirings, not asked for.
- A feed-in with a place for the runner-up's loser's route (there is none: the final's loser
  has finished).
- Choosing the *shape* of the consolation draw (a smaller one for the later rounds only): the
  one structure is the specification.

## Consequences

- **A larger event.** It doubles the number of rounds and almost doubles the matches; that is
  why it is advanced, off by default, confirmed with its numbers, and refused at the draw if
  the held time cannot hold it.
- **Nothing new in the engine.** `tournaments.ts` gains the setting's checks, the choice of
  structure at the draw and the preview; `brackets.ts` gains one structure, the consequences
  and a flag to `placings`; there is no migration, no new table and no new route but the
  preview.
- **The replay's known edge is the double elimination's** (R4): a replay does not pull back
  players who have since beaten the replayed matches' losers.
