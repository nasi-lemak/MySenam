# ADR 0040: Court time held for ladder challenges, and ladders of persistent teams

- **Status:** current, decided 2026-11-05 at the owner's request. Built in migration 0283. What
  organisers and players see is in
  [court time held by the venue](../../features/tournaments.md#court-time-held-by-the-venue-an-optional-setting-per-ladder)
  and [team ladders](../../features/tournaments.md#team-ladders). Extends
  [ADR 0033](0033-swiss-tournaments-and-club-ladders.md) (club ladders),
  [ADR 0013](0013-competition-framework.md) (configured by data) and
  [ADR 0031](0031-ratings-from-a-ledger-of-results.md) (ratings are a consumer of results).
- **Context:** ADR 0033 and the owner's decision of 4 November 2026 (round "ladders") made a ladder challenge
  hold **no court time**: the players book as anybody does and may attach that booking. On 5 November the
  owner asked for **both**: the venue able to hold court time for accepted challenges, and **persistent teams** (lib/teams.ts) able
  to enter a ladder. The first does not replace the decision of 4 November: it stands as the default, byte for byte,
  and the owner's new request is an **option per ladder**, off until a manager turns it on. The second
  needs a team match, which a ladder never had: two entrants each made of several people, a match made of several games.

## Part 1: court time held by the venue

- **A per-ladder setting, off by default** (`ladders.court_time_on`). With it off nothing in this part runs: the
  tests of the default (`tests/ladder-court-time.test.ts`) pass unchanged, and no ladder table refers to a claim or a block.
  *Rule 9:* the text of the 4 November decision that said "ladder challenges hold no court time, ordinary booking only"
  is changed in the documentation to say "**by default** ... ; *default stands, an optional setting added at the owner's request of
  5 November*" (feature document, *Court time and booking for a challenge*, and the *What ladders do not do* list). The code's default,
  and the refusal to create a hold on a ladder that has not turned the setting on, are the decision of 4 November.
- **Follows the precedent of a team league's fixture**, not a new engine. A hold is a set of rows in `blocks` that the hold owns
  (`blocks.ladder_hold_id`, as a fixture's are owned by `team_fixture_id` and a tournament's by `tournament_id`), each with its claim under
  the exclusion constraints and the capacity trigger. So every booking path, waiting-list offer and staff block already treats it as taken, and
  `store.ts`'s carving of blocks (`carveBlocks`, `blockSlots`, `unblockSlots`) leaves it alone, which is how "a staff block over a held time
  is refused as for any claim" is true without a rule of its own. The only change to `store.ts` is the new owner column carried where the
  others are. `ladder_court_holds` keeps one row per hold ever made (the match, the held span, who made it, and when, why and by whom it
  was released), so a hold's life is a record and the caps can count it.
- **Made on acceptance at an agreed specific time** (a day alone is not a time), inside the ladder's row lock, so two challenges of one ladder are
  serialised; the database's constraints settle two ladders racing for the same court. It is **all or nothing**: the blocks are written, their
  covered minutes counted, and taken back if they do not cover the whole held span; and a refusal (`LAD2_NO_COURT`...) is returned **before**
  the challenge is changed, so a challenge is never accepted without the court it was promised.
- **Court choice is deterministic** (`lib/ladder-holds.ts`): the ladder's named courts (none: any one-place court of the venue for the
  sport), then those that sit against something already there, then the busiest that day, then the lowest id. The held span is the
  match plus the court's operational time (the booking policy's set-up and cleaning) either side.
- **No money moves.** There is no price, booking, payment or credit; the hold is a reservation. A venue that wants players to pay
  books the ordinary way and attaches the booking.
- **Released in every ending, once**, with a reason; **moved new-time-first in one savepoint** (the old hold is let go and the new one made,
  rolled back together if the new cannot be made, so a move to an overlapping time works and a refused move changes nothing); **let go in favour
  of an attached ordinary booking** (the booking is the court time: no second court); marked **lost** by the scheduler if its blocks have gone (a court
  put out of service releases the blocks on it, as it does a tournament's), with both players told once.
- **Caps are install data** (`ladder_hold_limits`, one row, seeded 8 live holds per ladder and 4 holds made per player in 7 days, released and moved
  ones counted so churn is capped; a manager's own move or release is not counted against the player). Counting made holds, not live ones, is the point.
  *Amended by [ADR 0048](0048-ladder-hold-limits-and-expiry.md): these are now the install **defaults**, which a venue and a ladder may override within
  bounds; a hold made on acceptance is tentative until both players confirm it and expires if they do not.* *Further amended by
  [ADR 0050](0050-ladder-agreement-counts-and-expired-holds-do-not.md): the per-player cap counts live holds, not holds made.*
- **Managers only** release or move a hold (`MANAGER_ONLY` on `POST /api/admin/ladders/:id`), with a reason, logged, told to both.
- Nothing about a hold is public: the public ladder page and API are unchanged (no challenge, no court, no time); a hold is seen by the two
  sides and staff.

## Part 2: ladders of persistent teams

- **A ladder is of players or of teams** (`ladders.kind`), not both. The entrant of a ladder of teams is a row of `ladder_players` whose
  `team_id` names a persistent team (and whose `user_id` is empty): the ledger, the rank rule, the replay, reach, freezes, drops, seasons and
  corrections are the ladder's own and are not touched. The account that acts for the place is **the team's captain now**, looked up each time
  (`teams.captain_user_id`), so a hand-over of the captaincy hands the place; a captain acts for one place on a ladder.
- **A team match is made of games from the sport's template and scored by the team league's own functions.** `checkRubbers` (each game's score by
  `scoreRefusal`, walkovers, draws) and `fixtureOutcome` (the side with more games wins) are exported from `lib/team-leagues.ts` and used as they are; the lineup
  rule was a block of `setLineup` and is now `lineupRefusal`, which both call; nothing on a ladder scores a match. Because a ladder challenge must have a winner, the
  games are an odd number (or one whole-team match) and a level result is refused. The match's score kept with the challenge is the games won ("2-1", the
  challenger's first); the games and lineups are `ladder_challenge_rubbers` and `ladder_challenge_lineups`, the same shape as a fixture's.
- **Forfeits are a manager's, as the owner decided for team leagues on 4 November (migration 0276).** `team_forfeit_requests` is extended (the league
  and fixture columns become optional and a ladder challenge and the places concerned are added), and `lib/team-forfeits.ts` gets the ladder's variants of ask,
  withdraw, decide and expire, sharing its constants, reasons and notes. Confirming a request is the ladder's own `decide` with a walkover. **Consequently the
  scheduler never forfeits a team**: a challenge nobody answers lapses with no effect on a ladder of teams, and declining is free. (On a ladder of players the
  forfeit of an ignored challenge is unchanged.) This is the one deliberate difference between the two kinds, and it follows the decision of 4 November.
- **Privacy** is the team leagues': a child is a team member through a guardian's account and is named in a lineup only to staff and the captain of their own side,
  and to their guardian by email; the other side's lineup is seen only once a result is reported, an adult by first name; the public sees ranks and confirmed results by team name
  only. Entering a ladder publishes the name the captain gave the team, as entering a league does. `public-names.ts` is not needed: no person is named in public.
- **Ratings** use the existing switch and ledger hook: a rated ladder of teams is read as the **teams'** results (format *team*, as a team league's fixtures); a
  forfeit is a walkover; a corrected result replays. A lineup on a ladder does **not** rate individuals (a team league does, from its lineups): the ladder's lineups are
  optional and not read by the ledger. A match kind with no two-sided result does not exist on a ladder: a forfeit is a walkover, a lapse writes nothing.
- A **team that leaves, dissolves or loses its captain** follows the league's rules: the captain withdrawing ends its open challenges with no effect and the teams below move up;
  a team on an open ladder cannot be archived; an erased captain's team is taken off its ladders; a member who leaves comes out of lineups still to be played; erased names in lineups
  are replaced.

## Consequences

- A hold is data: its life can be read from `ladder_court_holds`, and its court time is as safe as a tournament's, because it is the same table under the same
  constraints. A hold can be lost (a court out of service); the scheduler notices, and the challenge stands.
- A manager who sets a **court time cap** too low can make acceptances refuse; the numbers are install data, shown in the dashboard's text.
- A ladder of teams needs a team with enough declared-eligible members; eligibility is checked at joining and at each lineup, not continuously.
- **Not built:** games of one team match played at once on several courts (no sport template names any), a hold that comes back by itself when an attached booking is cancelled
  (the players are told and agree a time again), rating individuals from a ladder's lineups, a junior ladder of teams, and a ladder across venues.
