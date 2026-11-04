# ADR 0035: Rating policy: rankings published by choice, a venue's number to be ranked, and which results count

- **Status:** current, decided 2026-11-04 (the owner approved the rating defaults
  with conditions, and public rankings as an opt-in a venue's manager turns on).
  Built in migration 0275. What people see is
  [ratings and rankings](../../features/tournaments.md#ratings-and-rankings).
  Amends [ADR 0031](0031-ratings-from-a-ledger-of-results.md), which stands for
  everything it does not say here.
- **Context:** [ADR 0031](0031-ratings-from-a-ledger-of-results.md) built ratings
  from a ledger and published a venue's ranking page as soon as one rated result
  existed. Three things the owner asked to be different: a venue should choose to
  publish (a ranking names people, even if they opted in, and a venue may not want a
  page because one match was rated); eight results before a player is ranked is a
  sensible default, not a fact about anybody's skill, and a venue may reasonably want
  fewer or more; and "which results count" had to be one stated rule that forfeits,
  walkovers, retirements, unconfirmed reports and incomplete matches follow in every
  format, with the code held to it. None of this changes how a rating is computed.
- **Decision:**
  - **Public rankings are off until a manager turns them on**
    (`venue_rating_settings.public_rankings`, default false). A venue that existed
    before this change has them off: **its public rankings page and API stop
    answering until its manager publishes them** (the owner's decision: nobody's page
    changes silently, and nothing is published because one result exists). Off
    answers 404 on the page (a layout `notFound()`), the API
    (`GET /api/venues/:id/rankings`) and so the MCP tool `venue_rankings`; the venue
    page does not link to it; the sitemap never lists it and the page is not indexed.
    On a business-wide board a branch is listed only if it allows the business board
    and has published its own rankings: one manager never publishes another venue's
    players. **Private views never depend on it:** a player's own `/ratings`, a
    guardian's, a team's members', and the manager's Ratings panel and ledger (with
    provisional players) are as they were.
  - **The number of counted results before a player is ranked is the venue's**
    (`rank_after`, 3 to 30, null for the install's default of 8 in `rating_rules`).
    It is a classification, applied to the same counted results: changing it moves
    people between *ranked* and *provisional* and **touches no ledger row and no
    rating** (tested against a replay from scratch). It is per venue, not per
    competition or per format, because a rating belongs to a pool (venue, sport,
    format) that many events feed: a threshold per event would give one player two
    classes in one pool. It applies equally to the player's own page, the manager's
    panel and seeding proposals ("not provisional" has one meaning at a venue). **Matching on an earned level
    uses `max(rank_after, install default)`** (owner's decision, 5 November 2026; `matchingThreshold` in
    `src/lib/ratings.ts`): the venue's number can raise the bar for matching but never lower it below 8, so a
    rating on three results is never trusted to place a stranger in a game. The rating maths constants stay install data.
  - **A separate section for the not-yet-ranked, if the venue chooses it**
    (`show_provisional`, needs public rankings on, default off): "Provisional: fewer
    than N rated results; these ratings may move a lot". A different block, no rank,
    no order of merit (listed by name), no medals; the same people as the ranking (a
    declared adult who chose to be listed, a published team); never a child. No
    provisional section on a business-wide board.
  - **Wording says what a rating is:** an estimate from the results counted; N
    results do not make it exact. It is on the public and player pages and in the
    manager's panel, in every language, and nothing says "true level", "skill" or
    "accurate".
  - **One table says which results count** (the table in
    [which results count](../../features/tournaments.md#which-results-count), held in
    code by `lib/rating-eligibility.ts`): a result is counted when it is **decided and
    confirmed**, in an event marked as rated. Not counted: a result still waiting for
    the other side (or the 24-hour stand rule, after which it is recorded like any
    other), a disputed one, a voided or struck one, a called-off event's, an entrant's
    group results that the event's own rules void, a match never played to a result
    (abandoned, a bye), and a result that cannot be one. **Today's behaviour differed
    in one place, now fixed:** the ledger trusted a stored result as valid; it now
    re-checks what every result passed when it was entered (the sport's own scoring
    rules, `scoreRefusal`: a score that says the other side won, no score on a
    played match, a level score where the rules allow none) and a side against
    itself, and counts none of those. The statuses of the four result tables are
    classified decided or not in one place, and a test fails on a status nobody
    classified.
  - **No cross-source duplicate guard is needed, and none is built.** Every result row
    belongs to one event of one kind, and the ledger's unique index is on that row
    (source, event, match, game); two sources cannot hold the same fixture. A guard
    keyed on "the same pair on the same day" would silently drop real results (a
    double round robin, two friendly games), which is worse than the thing it
    prevents.
  - **Auditable:** who changed the policy, who marked an event rated, and the
    business-wide listing are in an append-only `rating_policy_log` (and the activity
    log, `ratings.*`); a manager downloads the ledger as a CSV (every result, each
    person's rating before and after, why a result counted or did not, rows later
    replaced or struck marked); a rating after any correction, void, restore or change
    of the number is equal to a replay from scratch, and the replay is the same in any
    order of rows.
- **Consequences:** a venue that wants public rankings does one deliberate thing and
  can undo it. Venues that had a ranking page lose it until they publish (a visible
  change, stated in the documentation). Lowering the
  number to 3 ranks players on three results; matching on an earned level still needs the install's 8
  (the floor above), so the manager's choice cannot thin what matching trusts.
  A replay is still linear in a pool's ledger. A result that stays wrong in its own
  event stays wrong in the ratings: correct it there. A per-competition threshold and
  an enforced level remain unbuilt.
