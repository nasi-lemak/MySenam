# ADR 0047: FIDE's Baku Acceleration Method, an optional pairing for chess Swiss events

- **Status:** current, decided 2026-11-05 (the owner asked for "FIDE's Baku Acceleration Method as an optional chess tournament
  pairing configuration; standard Swiss pairing stays available; validated against the official rules and deterministic test
  cases; chess-specific acceleration not applied to other sports"). Built in migration 0289. What staff and the public see is in
  [accelerated pairing](../../features/tournaments.md#accelerated-pairing). Amends part of
  [ADR 0038](0038-swiss-acceleration-tie-break-screen-and-performance-swiss.md) (the constant acceleration), extends
  [ADR 0033](0033-swiss-tournaments-and-club-ladders.md) (Swiss pairing) and follows [ADR 0013](0013-competition-framework.md)
  (a sport is a template and rules, never a branch in code).
- **Not a FIDE-certified pairing program.** The acceleration below is FIDE's; the pairing under it is this app's own published
  rules (ADR 0033), not the FIDE Dutch system (C.04.3), and nothing here has been submitted to FIDE for endorsement. An
  organiser running an event whose results are sent to a federation checks the pairings against the federation's rules.

## What the official text says, and what was verified

The rule is FIDE Handbook **C.04.7 "FIDE-approved Accelerated Systems", section 1 "Baku Acceleration Method"**, in the edition
effective from **1 February 2026** (approved by the FIDE Council on 28 October 2025; handbook.fide.com, chapter `C0407202602`).
Earlier editions number it C.04.5.1. The articles, as read from that page:

- **1.1** It applies to events in which a win is worth two draws and a loss is worth nothing (a footnote: not where game points are
  the primary score).
- **1.2** Before round 1 the sorted participant list is split into **GA**, "the first half of the participants, rounded up to the
  nearest even number", and **GB**, everyone else. (A note gives the size as 2 × ⌈n ÷ 4⌉; for 161 participants GA has 82.)
- **1.3** Late entrants are placed in the list by the general handling rules; the last GA participant stays the same participant
  as in the previous round, so after round 1 GA may have an odd number.
- **1.4.1** The **accelerated rounds** are those "in the first half (rounded up) of the tournament".
- **1.4.2** Before pairing the first half (rounded up) of the accelerated rounds, each GA participant receives **virtual points
  equal to the points for a win**. **1.4.3** Those virtual points are **halved** before the remaining accelerated rounds. GB
  participants never receive any, and nobody receives any after the last accelerated round.
- **1.4.4** Examples. Nine rounds: five accelerated, GA has 1 point in rounds 1 to 3 and 0.5 in rounds 4 and 5. Eleven rounds of a
  team event scored in matchpoints (2 for a win, 1 for a draw): six accelerated, GA has 2 in rounds 1 to 3 and 1 in rounds 4 to 6.
- **1.5** A participant's **pairing score** is the sum of their standings points and their virtual points; it makes the score
  groups, orders within them and orders the boards.

**How it was verified, and what could not be.** The text was read through the Handbook's own page by a web fetch that returns a
summary with short quotations, not the page verbatim; the sections above are those summaries, and the examples reproduce the
text's. The pre-2026 page (C.04.5.1, spp.fide.com) and the 2025 handbook page returned 503 on the day, and the third-party page
that was reachable (pappubahry.com) agrees on the schedule (1 point in rounds 1 to 3, 0.5 in rounds 4 and 5 of a nine-round event)
but is not an authority. Not confirmed from the source: the exact wording of the articles beyond the quoted fragments; that the
numbering 1.1 to 1.5 is as cited (it is as the page presented it); anything the general handling rules (C.04.2) say about how a
bye or a withdrawn participant is treated in the accelerated rounds, which the page does not say (the rule as written gives
virtual points to GA participants and says nothing of byes or leavers, and this ADR does not add anything: see below).
Before an organiser relies on the exact wording, the Handbook page is the authority.

## Decision

1. **The option is configuration.** `rules.swiss.acceleration` is `{ method: "none" | "baku" }` (default: absent, which is `none`,
   standard Swiss pairing, unchanged). A **number** is still read, and means the **legacy constant method** of ADR 0038
   (`method: "constant"`, that many rounds): events stored before this ADR read and pair exactly as before (backward compatible;
   migration 0289 marks them `constant`). `{ method: "constant", rounds }` is accepted and stored as the number. The constant method
   is not offered in the set-up screen for a new event; a template that already carries it shows it as a line and keeps it.
2. **Which methods an event may use is data on its sport's template.** `CompetitionTemplate.swissAcceleration: ["baku"]` on the
   chess template, nothing on any other. `swissRefusal(format, rules, allowed)` (the one validator, called from the creation and from
   `setRules`) refuses `baku` where the event's template does not list it ("Baku acceleration is for a chess tournament"), for
   any format but Swiss, and for a counted performance event played in Swiss rounds (which accepts no acceleration at all). It also
   refuses scoring that is not article 1.1's (below). Standard pairing and the legacy method are every sport's. There is no branch
   on the sport anywhere: another sport's template could list the method tomorrow, and nothing else would change.
3. **A chess template is data** (`chess_results`, `sports: ["chess"]`): scored as a tally with draws allowed, a win, a draw and a
   loss being 2, 1 and 0 **table points** (a table point is a whole number, so chess's 1, ½, 0 are kept doubled, which is also how
   FIDE's own matchpoint example is written), a forfeit scored 1-0, tables by points, then who beat whom, then wins; Swiss, round
   robin, groups and knockout; players one by one. `scoring.pointsInHalves: true` is a display flag (stored only where true): the
   Swiss tables and each pairing's notes show the points halved (3 as 1½, 1 as ½), including Buchholz, Sonneborn-Berger and the
   virtual points ("+ ½ accelerated"). Nothing is ranked or paired on it. A draw is entered as a level score, `1-1`
   (`recordResult(winner: null)`), each side half a point. A chess event holds court time like any event (a venue's tables or rooms
   are its resources, and the match length, 120 minutes, is the template's and changeable); no engine change was needed.
4. **The schedule is the text's, from the event's round count fixed at the draw.** For an event of *R* rounds: the accelerated
   rounds are *A* = ⌈*R* ÷ 2⌉; GA gets *W* virtual points (*W* = a win's table points) in rounds 1 to ⌈*A* ÷ 2⌉ and *W* ÷ 2 in
   the rest of the *A*; none after. *R* = 9: *A* = 5, three rounds at *W*, two at *W* ÷ 2; *R* = 11: 6, 3, 3; *R* = 2 or 1: one
   accelerated round at *W*, none at half (`bakuRounds`, `bakuVirtualPoints`). *W* ÷ 2 is a whole number because article 1.1's
   scoring (win = 2 × draw) makes *W* even. GA is the 2⌈*n* ÷ 4⌉ best of the initial order, fixed at the draw (`accelerationGroup`).
5. **Where it is stored.** Chosen before the draw (`setRules` refuses it after), stored on the event at the draw so a pairing reads
   what the event was drawn with: `swiss_events.accel_method` (`none`, `constant`, `baku`), `accel_rounds` (for Baku, *A*),
   `accel_group` (GA's size), `accel_points` (*W*). The half-value and the number of full rounds are derived, not stored.
6. **How the virtual points act: ADR 0038's mechanism, unchanged.** They are computed per call from the stored fields and a
   player's place in the initial order, handed to the pairing as `PairingPlayer.virtual`, added to the real points for the score
   groups, the order within them, the bye (the lowest pairing score without one) and the order of the boards (article 1.5), and
   dropped. `swissStandings`, which makes every table and tie-break, has no parameter that could carry them; the notes keep the
   real points and the virtual ones apart. They are in no result, table, Buchholz or other tie-break, rating, or public standing.
   A bye is a real point (the bye's points); a GA player's virtual point in the round they have it is for pairing only.
7. **Withdrawals, byes and corrections.** GA is fixed at the draw: a withdrawal moves nobody in or out (the text's "the last GA
   participant stays the same" in effect), the leaver is not paired again, and the remaining GA keep their virtual points by the
   same schedule. A bye is paired as any other player by the pairing score. Late entries do not exist after the draw (article
   1.3 is not needed). A correction that pairs again (`repairFrom`) calls the same pairing on the corrected results, so the new round
   has the virtual points its number gives (a full point in a full round, half in a half round) and equals a fresh pairing from
   those results (tested for a round of each kind). Ending the event early (`endSwiss`) keeps the schedule fixed at the draw.
   Reproducible from the recorded seed, as before.
8. **What is shown.** Each pairing says "0 + 1 accelerated" or "1 + ½ accelerated" (the real points, then the virtual ones, on the
   staff panel, the next-round preview, and the public page); both pages say in words which rounds carried a full and which half a
   point, and that none is a result (staff English, Malay, Chinese; public English, Malay, Chinese, Tamil). The set-up screen offers
   the choice (standard, the default, or Baku) only for the chess template.
9. **Authorisation and audit.** Setting the pairing is the existing rule-setting: the venue's staff through `POST
   /api/admin/tournaments` and `{ action: "rules" }`, before the draw, as for any rule; creation and each rules change are in the
   activity log with `pairing standard | baku | constant (R rounds)`. Nothing here is reachable by a customer.

## What this changes in earlier statements (Rule 9: nothing silently)

- [ADR 0038](0038-swiss-acceleration-tie-break-screen-and-performance-swiss.md) Part 1 said the set-up screen offers the constant
  acceleration "with a default of 2", and that Baku's graded version is not built. The screen no longer offers the constant method
  for a new event (it still reads, pairs and shows an event that has it, and the API still accepts it), and the graded method is
  built, for the chess template only. Its "Simplification" paragraph and the matching consequence carry a pointer here.
- `docs/features/tournaments.md` ("Accelerated pairing", "What Swiss does not do") and the roadmap's Swiss row said Baku was not
  built: updated here and, for the roadmap and the feature-status row, in the report.

## Not built

- Other FIDE-approved accelerated systems (C.04.7 lists more than Baku) and any other acceleration for any sport.
- FIDE's Dutch pairing system (C.04.3) itself, colour allocation by FIDE's rules, a FIDE-endorsed or certified pairing engine, and
  the output formats of FIDE rating submissions. Chess ratings here are the app's own ledger ([ADR 0031](0031-ratings-from-a-ledger-of-results.md)).
- Late entries after the draw (article 1.3).
- Chess in the activity catalogue (a venue adds "Chess" as its own activity; the template is offered for any activity), clocks,
  boards and notation of a game, and byes requested in advance.
- Points shown in halves outside the Swiss tables (a chess round robin or group table shows 2, 1, 0).

## Consequences

- A chess club runs a Swiss event with standard pairing by default and may choose Baku before the draw; nothing about another
  sport changes and no new step appears in the venue's onboarding.
- The virtual points remain a pure function of stored choices, so every pairing can be remade from the seed, the stored method and
  the results (tested against an independent reading of the text).
