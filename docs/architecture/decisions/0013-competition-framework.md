# ADR 0013: One competition engine, configured by sport templates

- **Status:** current. Built in migrations 0100
  (`0100_competition_framework.sql`), 0104 (`0104_competition_divisions.sql`)
  and 0105 (`0105_results_by_players_and_officials.sql`). Extends
  [ADR 0012](0012-competition-rules-and-corrections.md). What organisers and
  players see is [programmes](../../features/programmes.md#tournaments).
- **Context:** tournaments were knockouts or groups then a knockout, scored
  in sets, for singles or doubles. Venues sell futsal, basketball and
  volleyball (teams, goals or points, draws), table tennis (best of five),
  and swimming, archery and bowling, which are not head-to-head at all. An
  engine per sport would multiply code and tests; forcing a swimming gala
  into a bracket would misrepresent it.
- **Decision:**
  - **A competition is configured by data.** A tournament's `rules` hold its
    scoring (sets or a tally, best of, whether draws are allowed, table
    points, the ranking order, how a retirement's partial score counts),
    how it treats somebody who leaves, and, for a performance event, what is
    measured and how (`src/lib/tournament-rules.ts`). The engine
    (`src/lib/tournaments.ts`, the arithmetic in `src/lib/brackets.ts` and
    `src/lib/performance-math.ts`) reads them and never branches on a sport.
  - **Sport templates are starting points**, also data
    (`src/lib/competition-templates.ts`): a template's rules are copied into
    the tournament when it is set up, and the organiser can change them until
    the draw. A venue can save a tournament's settings as its own template.
    They describe common club practice, not a governing body's regulations,
    and the set-up screen says so.
  - **Formats are few and reusable:** knockout; groups then a knockout; a
    round robin (one group, the table is the result); and a performance
    event (seeded heats, then a final, ranked by a time, distance or score,
    with attempts counted as the best or the total). Heats and finals reuse
    the matches table and scheduler, so court time is held and released as
    for any match.
  - **Who enters** is a player, a pair or a team (a name and a roster of
    names, within the template's sizes).
  - **Nothing already stored changes meaning.** A tournament stored without
    scoring reads as the defaults, which are exactly how tables were ranked
    before; templates apply to tournaments set up from now on.
  - **Consequential changes are confirmed against what was reviewed.**
    Taking somebody out after the draw, a correction after the knockout has
    begun, and resolving a progression issue each need the token of the
    preview the organiser saw. A correction that leaves the wrong competitor
    in played matches opens an issue that holds the finish until a manager
    lets the results stand or replays them at a court and time the
    tournament holds; played results are kept in the record, never deleted.
  - **Divisions are tournaments under a competition**, not a new kind of
    draw (migration 0104): the competition holds the courts once; each
    division keeps its own rules, entries and draw, and is scheduled into the
    shared time around its siblings, on court and by player. One match
    length for the whole competition keeps every division on the same slots.
  - **Who may enter is data on the tournament**: a closing day, an age range
    on the first day (dates of birth declared at entry, kept with the entry
    rather than on accounts), members only, and a competition's cap on
    divisions per player.
  - **Table points may depend on the set score** (`setPoints`), the rule
    kind volleyball's 3-2-1-0 needed.
  - **Results from the people on court go through the same door as
    staff's** (migration 0105): a player's report becomes a result only when
    the other side confirms it, and an official's link enters results as
    staff would; both through `recordResult`, so every check, progression
    and correction is the one staff results have.
  - **Box leagues use the same rules** for scores and tables, from a
    template, rather than rules of their own.
- **Consequences:** a new sport is a template, not code, wherever its
  competition fits these formats and scoring. More formats (a third-place
  match, consolation draws) are not built yet
  ([roadmap](../../roadmap/roadmap.md)). Ranking by
  set or point ratios and a bouldering count of tops and zones still need a
  rule kind of their own when wanted.
