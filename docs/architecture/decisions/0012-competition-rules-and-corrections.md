# ADR 0012: Competition rules as data, and corrections that never rewrite play

- **Status:** current, extended by [ADR 0013](0013-competition-framework.md)
  (scoring as rules too, and progression issues resolved by letting results
  stand or replaying). Built in migration 0099. What organisers see is
  [tournaments and leagues](../../features/tournaments.md).
- **Context:** a withdrawal after the draw put the entrant last in their
  group, whatever they had played, which misstates the competition; and once
  a knockout match had been played, a group result that would change who was
  in the knockout was refused outright, leaving a known mistake with no way
  to record it. Competitions differ between sports and organisers (whether a
  disqualified player's results count, whether a fee comes back), and more
  sports are coming; an engine per sport would not scale.
- **Decision:**
  - **How a tournament treats somebody who leaves is data** on the
    tournament (`tournaments.rules`, `src/lib/tournament-rules.ts`): whether
    their group results stand or are void, apart for withdrawal or
    retirement and for disqualification, and whether a fee is owed back
    before the draw. The engine applies them; it never branches on a sport.
    Whatever the rules, somebody out goes no further and their matches left
    are walkovers. The reason, stage, time and note are kept on the entry.
  - **Knockout results already played stand.** A correction after the
    knockout has begun is previewed (made in a transaction that is rolled
    back), confirmed with a reason against a fingerprint of the state it was
    previewed from, and made either into the knockout, only where every
    match it changes is still to play with its court, or in the group table
    (or the corrected match's record) alone. Each is kept in
    `tournament_corrections` with what it changed and the matches before.
    Anything else (replaying a played match) is the organiser's, by hand.
  - Disqualifying and correcting are a manager's; front desk staff enter
    results and withdrawals.
- **Consequences:** the defaults (results stand on withdrawal or
  retirement, are void on disqualification, fee owed back before the draw)
  keep what organisers had before except the last-place rule, which is gone.
  The rules are the first piece of the sport templates in the
  [roadmap](../../roadmap/roadmap.md); a template would supply them, and
  scoring and tie-breaks, as data in the same way. Players moved by a
  correction are not yet messaged
  ([known limitations](../../roadmap/known-limitations.md)).
