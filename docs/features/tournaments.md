# Tournaments and leagues

Authoritative for tournaments (one event, or several divisions of a
competition, knockouts, groups, round robins, [Swiss events](#swiss-tournaments)
and performance events), the competition rules they are scored by, box leagues,
[club ladders](#club-ladders), teams that persist across events and the leagues
of teams they play in, and the ratings and rankings built from their results.
Status: [feature status](../product/feature-status.md#tournaments-and-leagues).
Design: [ADR 0012](../architecture/decisions/0012-competition-rules-and-corrections.md)
(rules and corrections), [ADR 0013](../architecture/decisions/0013-competition-framework.md)
(one engine configured by data) and
[ADR 0032](../architecture/decisions/0032-consolation-draws-and-double-elimination.md)
(consolation draws and double elimination, specified rule by rule) and
[ADR 0033](../architecture/decisions/0033-swiss-tournaments-and-club-ladders.md)
(Swiss and ladders).

## Scope and roles

- **In scope:** setting up a tournament or a competition with divisions, who
  may enter, entries and fees, the draw and schedule, results by staff,
  officials or players, corrections and progression issues, people leaving,
  the court time held; box leagues, season after season; [teams](#teams) that
  persist across events and enter tournaments and leagues by name;
  [leagues of teams](#team-leagues) with fixture lists; and
  [ratings and rankings](#ratings-and-rankings) built from the results of the
  events a venue marks as rated.
- **Not here:** booking courts ([booking](booking.md)); paying fees online
  ([payments and credit](payments-and-credit.md)); women's, men's and mixed
  events ([programmes](programmes.md#women-only-and-men-only)); open games,
  suggestions and community groups ([open games and matchmaking](matchmaking.md)).
- **Who does what:** a venue's managers set up, correct, disqualify and
  resolve; front-desk staff enter results, check entrants in, and enter
  players at the counter, and the dashboard shows them the rest read-only or
  not at all ([what the front desk is shown](../architecture/tenancy.md#what-the-front-desk-is-shown));
  an official enters results through a link;
  players enter (themselves, or somebody they act for), withdraw before the
  draw, report and confirm their own results where the tournament allows it,
  and run their league matches themselves.

## Tournaments

Venues run them from the dashboard's *Tournaments* tab; players find them at
`/tournaments`. One engine runs every sport, configured by the tournament's
rules, which start from the sport's template
([ADR 0013](../architecture/decisions/0013-competition-framework.md)).

### Setting one up

- **Sport and template.** Each sport starts from a template: how its matches
  are scored and its tables ranked, or how its performances are measured, the
  usual match length, and who enters (`src/lib/competition-templates.ts`).
  Templates are common club practice, not a governing body's regulations,
  and the set-up screen says so; the organiser can change any of it until
  the draw, under *Scoring and ranking*. A venue can save any tournament's
  settings as its own template and start the next from it.

  | Template | For | Scores and tables |
  | -------- | --- | ----------------- |
  | Best of three games | badminton, pickleball, sepak takraw | Games ("21-15, 18-21, 21-10"); wins, then game and point difference, then who beat whom |
  | Best of five games | table tennis, squash | As above, best of five |
  | Best of three sets | tennis, padel | Sets of games ("6-4, 3-6, 7-5") |
  | Volleyball sets | volleyball (teams) | Sets; wins, set and point difference |
  | Volleyball, points by set score | volleyball (teams or pairs) | Best of five; 3 table points for a 3-0 or 3-1 win, 2 for a 3-2 win, 1 for a 2-3 loss, 0 for a clear loss (a walkover or retirement counts as clear, a walkover as 25-0 in three sets); points, wins, set and point difference (ratios can be chosen instead) |
  | Goals, with draws | futsal, football, floorball, water polo, netball (teams) | Goals ("3-2"); group matches may be drawn; 3 points a win, 1 a draw; goal difference, goals scored, who beat whom; a walkover counts as 3-0; a level knockout match needs its winner and how ("2-2 (penalties 4-3)") |
  | Points, no draws | basketball (teams) | Points ("78-71"); 2 a win, 1 a loss; who beat whom, point difference, points scored |
  | Timed heats and a final | swimming | One swim each, eight to a heat, the eight fastest in the final |
  | Timed heats | cycling | One timed run each, no final |
  | Ranking round by ends | archery | Six ends each, added up |
  | Series of games | bowling | Three games each, added up |
  | Best of several attempts | distance or score events | Three attempts, the best counts, the next best breaks a tie, a foul is X |
  | Bouldering: tops, zones and attempts; club format; climbing by height | bouldering, climbing | A result is a set of counts, ranked by the rules ([counted performances](#counted-performances)) |
  | Your own | anything else | The general rules (as every tournament had before templates) |

- **Format:** a straight knockout (with a **consolation draw** for its
  first-round losers if chosen, or the advanced
  [feed-in consolation draw](#the-advanced-feed-in-consolation-draw) for every
  loser but the runner-up); round-robin groups (3 to 6) whose top one
  or two go through to a knockout; a **round robin** of everybody (up to 16),
  whose table is the result; a **double elimination** (a winners' bracket, a
  losers' bracket and a grand final; see
  [below](#consolation-draws-and-double-elimination)); a
  **[Swiss event](#swiss-tournaments)**, a fixed number of rounds each paired
  from the standings; or a **performance event**: heats, then a final, ranked by
  a mark or, for bouldering and climbing, by [counts](#counted-performances). A
  knockout may also have a consolation draw.
- **Who enters:** singles, doubles (a partner named), or **teams**: a team
  name and a roster of names, within the template's sizes (a futsal roster is
  5 to 14), or a [persistent team](#teams) the captain names, with the roster
  picked from its members and each checked against the event's rules
  ([entering as a team](#entering-a-tournament-as-a-team)). The one entering is
  the captain. The public sees the team's name; the roster only its staff and
  the captain.
- Level, entry fee, most entries, days (up to two weeks), daily hours to the
  minute, how long each match or heat is given on court (below), and which
  courts.
  Those hours are **held at once**: ordinary blocks with the tournament's
  name, so every booking path already treats them as taken. It will not hold
  over a booking already made, or a court out of service, and says which.
- **Entries:** players enter with their account, a guardian enters somebody
  they act for, or staff enter somebody at the counter
  ([who enters and how](#who-enters-and-how)); the fee is paid online to the
  venue, or at its counter, where staff tick it off. Past the limit they go on
  a waiting list, and move up, and are told, when somebody withdraws. Places
  are counted and taken in one transaction under the tournament's row lock
  (and a division's competition's, for its cap on divisions per player), as a
  withdrawal that frees one is: of people entering at once for the last
  place, one is in and the rest wait, and the same person entering twice at
  once is in once (`tests/entry-races.test.ts`, on Postgres too). In a
  performance event they can give an entry time or mark to be seeded by.
- **Who may enter**, each optional, shown on the public page:
  - **Entries close** after a given day (before the first day), in the
    venue's time: entering is refused after it, and the scheduler closes the
    tournament for the draw.
  - **Ages** on the first day, from and to: the entrant declares a date of
    birth, and a partner's in doubles; a team's captain declares that the
    roster is within the ages. Nothing is checked against a document: the
    venue checks on the day if it matters. A declared date of birth is in the
    player's data export and erased with their account. A declared age is
    the entrant's word, not verified eligibility.
  - **Under 18, with a guardian's agreement.** Where an age range asks for
    dates of birth and one makes the entrant or their partner under 18 on
    the first day, or the event is a team event for under-18s, the entry
    needs a parent or guardian's name and a tick that they agree. Both are
    recorded as the entrant declared them: the app does not verify them, and
    the organiser's screen says so. The threshold (`GUARDIAN_AGE`, 18) is an
    operator policy, not a legal determination. Whether a venue needs a signed
    form as well is for the operator and organiser to settle. No identity
    document is asked for or stored. The guardian's name is in the
    entrant's export and erased with their account. An event with no age
    range asks for no dates of birth, so minors in it are not detected.
  - **Members only:** the entrant's own active membership at the venue (or
    its business), on the day of entry, or a family membership naming them;
    never somebody else's: a guardian's membership does not make a child it
    does not name a member ([ADR 0025](../architecture/decisions/0025-benefits-and-privileges-by-scope.md)).
    At the counter, the number given counts on staff's word.
  - Points by set score, where wanted, under *Scoring and ranking*: four
    numbers for a clear win, a deciding-set win, a deciding-set loss and a
    clear loss, in place of points per win.
  - The ranking order may use **set or point ratios** (won over lost, as
    volleyball's quotients) as well as differences: a side that lost
    nothing ranks above any ratio, one with nothing either way at the foot.
  - **A walkover's score**, where wanted: the score a forfeited match
    counts as in the table, winner first ("3-0", or "25-0, 25-0, 25-0" for a
    best of five). It must be a winning score of the match as set up, so
    changing the number of sets asks for it again. Without one, a walkover
    counts the win and nothing in the differences.

### Changing a tournament

Until the draw, a manager changes a tournament's details from *Change
details* on its page (`PATCH /api/admin/tournaments/:id`; `changeTournament`
in `src/lib/tournaments.ts`), under the tournament's row lock:

- its **name** and **description**;
- the **last day for entries**: before the first day, and not in the past;
  empty for none. A new last day, today or later, opens entries again when
  they had closed (by hand or on the old last day);
- **how many entries** it takes: more take entries off the waiting list in
  the order they came, each told as when somebody withdraws; fewer never
  below those already entered, counted under the same row lock every entry
  takes (`enterAs`), so a cut and an entry at the same moment never leave
  more entered than places (`tests/entry-races.test.ts`, on Postgres too);
- the **entry fee for new entries**. Each entry keeps the fee it was made at
  (`tournament_entries.fee`, migration 0238; entries made before took their
  tournament's fee then): what it owes and pays online
  (`startEntryPayment`), what the counter's receipt says when it is marked
  paid, and what players see to pay. Nothing already entered, paid or not,
  is repriced.

Who is told: a **new name** is emailed once to every entry entered or
waiting that an account holds (*A new name: …*, saying what it was), so the
next email under it is no surprise; those just taken off the waiting list
hear it in the email saying they are in. Nothing else is told, as nothing
else changes what an entrant signed up for: the last day for entries
matters to people not yet entered, the fee is for new entries, more places
reach those waiting through their own email, and the description is the
venue's text, which players read on the page.

Its days, hours, courts, format and who may enter are not changed here
(the rules, until the draw, under *Scoring and ranking*). After the draw it
is refused. Each change is in the activity log (`tournament.changed`, with
what it was and what it is); front desk is refused (`MANAGER_ONLY`), as for
setting one up. Setting one up is logged too (`tournament.created`,
`competition.created`, `league.created`).

### Competitions with divisions

A **competition** is one event — a club championship, a junior open —
holding its courts for its days and hours once (*Set up a competition with
divisions*). Each **division** is a tournament set up as *Part of* it: men's
singles, girls under 12, mixed doubles, each with its own format, rules,
who may enter, fee, entries and draw (`src/lib/competitions.ts`).

- A division takes the competition's days, hours and courts, and holds
  nothing of its own. Its matches are the competition's length unless the
  division gives its own (*This division's matches*): a 30-minute junior
  draw and a 45-minute open draw share the same courts.
- Each division's draw is scheduled into the competition's time around the
  matches the other divisions already have, whatever their lengths: never two
  matches on one court, and a player (by account) in two divisions never on
  court in both at once — counting a match still to be decided (a final, a
  third-place match, a knockout filled from the groups) as one for everybody
  who could still reach it. Divisions are added before any draw.
- The competition can limit how many divisions one player enters.
- Held time no division will use goes back on sale once every division still
  running has made its draw, and more as results come in. Calling off one
  division gives back what it no longer needs once the rest are drawn;
  calling off the competition calls off every division (entrants told, fees
  paid online owed back) and gives the courts back.

### Match lengths

How long a match is given on court comes from the most specific of:

1. **the fixture**, once an organiser moves it or gives it longer (below);
2. **its stage**, under *Match lengths by stage*: group matches, knockout
   rounds, the final (the knockout's last round and its third-place match,
   and a double elimination's winners' final), heats, a double elimination's
   losers' bracket, grand final and reset, and a consolation draw;
3. **the tournament**, or the division of a competition;
4. **the competition**.

Each match keeps the length it was drawn with (`tournament_matches.minutes`).
A length is the time held on court, not how long play takes: a match that
finishes early leaves its court free, and one that runs over runs into the
next time held, never into a booking.

### The third-place match

A knockout, or the knockout after groups, can have a **third-place match**
(*Third-place match*, under *Match lengths by stage*). It is made at the draw
only when there are at least four in the knockout, and is played by the two
semi-finals' losers, scheduled after both semi-finals. It goes through the
same progression as every match:

- **Byes.** A semi-final decided as a bye sends nobody, and the third-place
  match is then a bye.
- **Walkovers and withdrawals.** A semi-final lost by walkover sends its
  loser, who is out, so the third-place match is a walkover to the other.
  If both losers are out, nobody plays it.
- **Corrections.** A semi-final result can be put right while neither the
  final nor the third-place match has been played. After either has, it is
  refused as a plain result. A record-only correction then opens a
  progression issue for each match the wrong competitor played or is due to
  play, the third-place match included. The tournament does not finish until
  it is resolved. Replaying is refused while the competitor due the place
  is in the other of the two matches, so the organiser lets the results
  stand or arranges it by hand. A played match is never rewritten.
- **Finishing.** The tournament finishes once the final and the third-place
  match are both decided.

### Consolation draws and double elimination

Two structures built on the same matches, results and corrections as the
knockout ([ADR 0032](../architecture/decisions/0032-consolation-draws-and-double-elimination.md)
numbers every rule below and names the tests that prove it). In both, a match
has a *winner's route* and a *loser's route* to a place in another match; the
knockout's third-place match already used the second. Seeds, byes and the draw
by lot are the knockout's: byes go to the top seeds, the order the draw was
made in (seeds first, then those drawn by lot) is recorded on the tournament,
and a draw made again from it is the same draw.

**A knockout with a consolation draw** (*Brackets* under the stage lengths,
a rule of a straight knockout, off unless chosen; not for groups then a
knockout, nor for a double elimination):

- Those who lose a **first-round match that is played** go on to a smaller
  knockout of their own. A bye is not a match: a player with a first-round bye
  who loses their second match is out of the main draw and **not** in the
  consolation draw (this is the first-round consolation; the advanced
  [feed-in](#the-advanced-feed-in-consolation-draw) takes every loser).
- It is made where the main draw has eight lines or more and at least two
  first-round matches are played (from six entries); otherwise there is none
  and the draw says nothing about it. With four lines the first round is the
  semi-finals, whose losers have the third-place match.
- Its lines are seeded by how close the first-round matches were: the loser
  of the match between the closest seeds, expected to be the strongest, is
  the top seed, and byes go to the top seeds as the knockout's do. Nobody
  meets anybody they have played.
- Its own **final**, and optionally a **consolation third-place match** (the
  consolation semi-finals' losers, where there are two). The main draw keeps
  its own third-place match.
- Places: the main draw's first (champion, runner-up, third and fourth by the
  third-place match or joint third, then each earlier round's losers
  together), those who won a first-round match or had a bye above everybody who
  lost one; then the consolation draw's own order after them.

**A double elimination** (a format; three entries at least):

- A **winners' bracket**, the knockout of everybody, and a **losers' bracket**
  that every loser of the winners' bracket drops into: first-round losers
  meet each other; each later winners' round's losers play the survivors of the
  losers' bracket. Out of the event on a second loss. `n` entries give `n-1`
  winners' matches, `n-2` losers' matches and the grand final: `2n-2`.
- Losers drop in reversed into the first drop round and in order into the
  next, alternating, so that nobody meets, in their first two losers' matches,
  a player they have already played, wherever the byes fall. Later, where the
  shape forces it, two players who have met may meet again.
- The **grand final** is the winners' champion against the losers' champion.
  With the **reset** on (the default), if the losers' champion wins it a
  second match is played between the same two and its winner is champion; if
  the winners' champion wins, the event is over and the reset is not needed
  (a bye, nobody in it). With the reset off, the grand final decides.
- Third place is the loser of the losers' final: the knockout's third-place
  setting is not for it.

**Progression** is the same for both: a result puts its winner and its loser
into their routes in one change, a bye or a match nobody can win sends
nobody, and a match nobody can contest is settled at once (a walkover to the
other side against somebody who left, a bye against a place nobody will fill).
Every new match is scheduled like the rest, after every match that feeds it on
either route, for the length its stage gives it (*Match lengths by stage*
gains the losers' bracket, the grand final, the reset and the consolation
draw); the reset is placed with the rest and, where there is no room, left
without a court rather than refusing the draw. A match is named by its
bracket (*Losers' round 2, match 1*, *Grand final*, *Grand final reset*,
*Consolation final*) on the board, the live page, the notices and the public
page, which shows each bracket in a section of its own that scrolls across a
phone.

**When the tournament is over** the public page and the organiser's page list
*Final places*: everybody who was in the draw has one, and level entrants
share it (joint third, joint fifth). A double elimination's champion and
runner-up come from the reset where it was played, else the grand final, then
the losers' bracket's last round first. An entrant who left stands where the
matches put them, flagged as out.

**Corrections and leavers** work as for the knockout, with two routes and two
chains: see [below](#corrections-after-the-knockout-has-begun) and
[somebody leaving](#somebody-leaving). **Ratings** count every decided match
between two entrants in any bracket
([ratings](#ratings-and-rankings)); a bye, and a reset that is not needed, are
not matches.

### The advanced feed-in consolation draw

An **optional, advanced** way to run a knockout's consolation draw, off unless
chosen and never the default ([ADR 0034](../architecture/decisions/0034-feed-in-consolation-draws.md)
numbers every rule and names the tests). The ordinary consolation draw takes the
first round's losers only; this one takes **every loser of the main draw but the
runner-up**, so every entrant plays at least two matches.

- **Setting it up.** *Brackets* under the stage lengths: tick the consolation draw
  and then *Advanced: feed-in consolation*. It is for a straight knockout only,
  refused with the knockout's own third-place match (the semi-finals' losers play on
  in the consolation draw instead), and a rule of the tournament
  (`rules.bracket.consolationMode: "feed_in"`; `"first_round"`, or nothing, is what
  `consolation` has always meant). It is changed until the draw, never after.
- **What it costs is shown first.** Choosing it shows, for the entries the
  tournament has (or the most it takes while fewer than five have entered): the main
  draw's matches (`n - 1`), the consolation draw's (`n - 3`, one more with its
  third-place match), the whole (`2n - 4`), the court hours it adds at the
  tournament's match lengths, how many rounds one after the other it needs (about
  twice the knockout's), the most matches one entrant can play, and whether the court
  time held would hold them. The choice is saved only after *Confirm: this adds 13
  matches and about 6.5 court hours* (a checkbox on the setup form, a button on the
  tournament's page); changing its third-place match asks again. The server asks too:
  a request without `confirmFeedIn: true` is refused with the same numbers.
  `GET /api/admin/tournaments/:id/feed-in-preview` gives them to a client.
- **The shape.** The consolation draw is a losers' bracket fed from each main round:
  the first round's losers play each other; each later main round's losers drop in
  against the survivors of the round before (reversed on every second round, so
  nobody meets a player they have played in the consolation's first two rounds,
  wherever the byes fall); the **consolation final** is between the winners of the
  semi-finals' losers' round. A bye is no loser, so a field that is not a power of two
  has no match with an empty side. From five entries; with fewer it is a plain
  knockout, and the form says so.
- **Places.** The main draw places its champion and runner-up; the consolation
  draw's champion is **third**, its runner-up **fourth**, then (with its third-place
  match, between the last drop round's two losers) **fifth** and **sixth**, then the
  rest by the consolation round they were put out in, level within a round. A place
  says how late somebody was put out, not how strong they are.
- **Court time.** Every match is placed by the same scheduler, after every match that
  feeds it, the main draw first, so the consolation draw takes only the time the main
  draw leaves. **If the held time cannot hold every match, the draw is refused with an
  explanation and nothing is changed**, as for every format. A player is never in a
  main match and a consolation match at once, and in a competition nobody is on court
  in two divisions at once.
- **Everything else is as for any consolation draw**: results, walkovers against a
  leaver, corrections with an issue for each route, stand or replay both together,
  tournament day, the live page, ratings (every decided match between two entrants),
  names (*Consolation round 2, match 3*, *Consolation final*), and the public page's
  *Consolation draw* section, which says everybody who lost in the main draw but the
  final plays on there.

### Moving a fixture

A manager moves a match still to play, or gives it a different length, from
*Move…* on its row (`moveMatch`). The new time has to satisfy everything a
replay's does:

- the court is the venue's for the sport, open, in the future, and not used
  by another match of the tournament or of another division;
- neither side plays elsewhere then (for a side still to be decided,
  nobody who could reach it plays in another division then);
- the time is held already or free to hold, and a booking is never moved;
- the match starts after every match feeding it ends, and ends before every
  match it feeds begins.

Either it moves and its time is held, or nothing changes. Both sides are
emailed the new time, the move is in the activity log with the old time, and
held time no longer needed goes back on sale. A decided match is corrected,
not moved. Front desk staff cannot move fixtures.

### On the day

- **Check-in:** staff mark each entrant arrived (*check in*), and can take it
  back. Calling a match needs both sides checked in ([tournament day](#tournament-day)).
- **Eligibility checked:** for an event with an age range, staff can record
  that they saw proof of age at the venue (*age checked*): who checked and
  when, never the document or its number.

### Tournament day

From the draw to the last result, a manager runs the day from the *Now and
next* board on the tournament's page (`src/lib/tournament-day.ts`; not for a
performance event, whose heats have lanes rather than two sides). Nothing in
it is a second scheduler or a second way to score: a fixture keeps the court
and time the draw gave it, which the tournament holds already through its
blocks (so the database refuses a booking over it), and a result goes in only
through `recordResult`.

- **The board.** Each court shows the fixture on it now (*called*, or
  *playing* once marked started), the next fixture there, and a suggestion of
  the ready fixture to put on it where it is free. Below, every fixture
  between two known sides not yet called, ready or not, with what stops it:
  somebody not checked in, resting, on court in another match, or out. Recent
  results follow, and the day's settings. It refreshes every 15 seconds. Front
  desk reads it, and checks entrants in and enters results as ever; the
  buttons below are a manager's (`MANAGER_ONLY`, the `tournamentDay` action),
  and an official's where said.
- **The next match announced.** After every result or somebody leaving, and
  every minute from the scheduler, the sides of each court's next fixture
  (today's, between two known sides, starting within the hour or late already,
  not yet called) are told once: *your match is next*, with the opponent, court
  and time. By email always, and on WhatsApp where the venue has everything on
  WhatsApp and the account has a number it proved (kind `tournament_day`, not
  urgent news, so the venue pays as for other WhatsApp messages; the template
  is prepared and not yet submitted to Meta). In the language of the account,
  to the account that holds the entry (a guardian's, opening with whose it is,
  for a participant); never to somebody who left or was disqualified, and to
  nobody where no account holds the entry (entered at the counter). A declared
  minor is named to others by first name and initial. Once per fixture and
  side, however often it runs (`tournament_notices`, claimed before sending,
  and the outbox's own dedupe key as a second guard); not held to the daily
  limit of messages per recipient, since a day's matches would reach it.
  Switchable per tournament (*Tell entrants…*); a tournament on another day,
  or an hour or more away, announces nothing.
- **Calling a fixture.** *Call* says the players are wanted at the court now.
  Both sides must be checked in, not on court in another called match, and
  rested (below), and the court must have nothing else called on it.
  Where the fixture's held slot covers this minute, that is all it does.
  Otherwise (a court freed early, a match the players are ready for ahead of
  time) a manager brings it to its own court, or to another, from the next
  minute: the same checks and hold as moving a fixture (`placeMatch`, which
  *Move…* uses too), refused where a booking, a block or another match of the
  tournament or its competition is in the way, or a side plays then; time the
  court gave back is held again for it. A booking made at the same moment as
  such a call and the call are never both: the database refuses the second.
  An official calls only where the fixture is held and its time has come, and
  can mark it started or take the call back; bringing one forward or sending
  it to another court is a fixture move, which stays a manager's. Both sides
  are told they are called, saying how long the court waits. A fixture that is
  called cannot be moved by hand until its call is taken back.
- **Rest.** *Rest between a player's matches* is a setting of each division
  (a division is a tournament), in minutes from the result of a player's last
  match played (a walkover is not played). Zero is none.
- **When nobody comes.** A called fixture waits *how long a called match
  waits* (default 10 minutes, a setting of the tournament) for its players;
  marking it started ends the wait. After it, a manager decides: **wait**
  another interval; **forfeit**, saying which side did not come (only once the
  wait is over), an ordinary walkover recorded through `recordResult`, so the
  tournament's rules for walkovers decide the table and the progression, and
  optionally taking the absent side out of the event as withdrawn, under the
  rules for somebody who leaves; or **swap**, which puts the next ready
  fixture on the court (in this fixture's slot, held already) and this one in
  its place or after it, refusing where nothing else is ready or the exchange
  would overlap another match, and telling the sides moved. There is no alarm
  when the wait ends: the board shows it, and an official's page says so.
- **The public live page** at `/tournaments/:id/live` needs no sign-in and
  refreshes every 15 seconds: each court's fixture now and next, and recent
  results. A declared minor (a guardian's agreement, a participant a guardian
  manages, a date of birth under 18 on the first day, the entrant's word) is
  shown by first name and the initial of the next name; a tournament can
  show everybody that way (*Names on the public live page*); a team by its
  name. It carries nothing about check-in, calls, staff, guardians or
  contacts. An event with no age range cannot detect a minor who entered
  with no guardian recorded, so it shows that entrant in full unless set to
  short names, as its main public page does: both by the one rule
  ([names of minors on public pages](#names-of-minors-on-public-pages)).
- **Roles.** A manager calls, starts, releases, decides and sets the day up; an
  official calls where it is held, starts and releases; front desk checks
  players in and enters results and sees the board. Fixture moves, late
  corrections and disqualification stay a manager's. Each is in the activity
  log (`tournament.match_called`, `match_started`, `call_released`,
  `no_show_decided`, `day_settings`), an official's under their name.
- **Not here.** A division's board shows its own tournament's fixtures: a
  match of another division on a shared court is refused where a call would
  collide with it, but is not shown, and rest is counted within the division.
  Heats are not called one by one. There is no push to staff when a wait ends.
  The notice names a match in English where it names it by its position
  (*Semi-final 1*); the rest is in the account's language.

### The draw and the schedule

Seeds staff set are kept apart and get the byes; everybody else is drawn by
lot, and the order used is kept on the tournament. Each group's runner-up is
put in the other half of the knockout from its winner. A performance event's heats are seeded by entry mark: the best
in the last heat, laned from the middle out, those with no mark drawn by lot
into the earlier heats, and no heat left with one competitor where that can
be avoided. Every match or heat gets a court and a time within those held,
each for its own length, with nobody in two places at once, no round
starting before the matches feeding it have ended, and the final after every
heat. Starts fall on a grid of the lengths' greatest common divisor from
the first minute of the day, so a tournament whose matches are all one
length keeps the slots it always had. Otherwise the draw says how many did
not fit and changes nothing. Everybody is emailed their first match, or their heat and
lane.

### Results

**Who enters them** is the tournament's choice when it is set up: its staff
(and officials), or **the players** (`src/lib/match-reports.ts`):

- **Players** report their own match from the tournament's page: who won (or
  a draw, where the rules allow one) and the score, their own points first,
  or a walkover. The other side is emailed and confirms it — only then is it
  the result, recorded through the same checks as staff's — or says it is
  wrong, with a note: the venue's staff are emailed, see it under *Results
  from the players and officials*, and enter the result themselves. A report
  the other side leaves unanswered for 24 hours stands, recorded the same
  way (the scheduler checks every minute); one that can no longer be recorded by
  then (the match settled or changed meanwhile) goes to staff as disputed,
  never dropped. A result staff or an
  official enter at any time settles a report waiting on the match. Each
  result says who entered it (staff, the players, or the official by name).
- **Officials** — a referee, a table official — are given a link of their
  own for one tournament from *Give an official a link*, shown once; no
  account is needed. Whoever holds it enters results as staff would (not
  taking anybody out of the event), each recorded with the official's name
  on the match and in the activity log.
  - **Scope.** A link enters results only for this tournament's matches
    still to be decided. A result already in is corrected by the organiser,
    who sees what a correction changes.
  - **Expiry.** It works until the tournament's last day, or an earlier day
    the organiser gives, and when the tournament ends (a climbing event's link
    carries on for seven days after it finishes, for the results and correction
    requests only: [officials and counted results](#officials-and-counted-results)).
  - **Revocation.** Staff withdraw a link at any time, and it stops at once.
  - **Strength.** The link carries 192 random bits; only their SHA-256 is
    kept, so it is shown once. Its page is rate-limited.
  - **What it shows.** Entrants' names and matches, as the public page does.
  - **Why a link.** Officials are often volunteers without an account, and
    their one-tournament, results-only access does not justify one. A venue
    that wants named accounts can make them staff with the front-desk role.
  - **A climbing event.** The same link, for a counted performance event, enters its
    counts instead of match results: see
    [officials and counted results](#officials-and-counted-results). An event of marks
    (swimming, athletics) has no official's link: its marks are staff's.

- **Matches:** staff enter the score in the sport's form and who won; a
  score that says the other side won, or has more sets than the match is the
  best of, is refused. A tally sport's group match may be **drawn** where its
  rules allow. A walkover is a forfeited match. A **retirement** (the other
  side stopped part-way) is a win recorded with the score as it stood —
  never one made up — and shown as a retirement, not a completed match; the
  rules say whether its partial score counts in set and point differences
  (*counts the win only*, the default, or *as played*). Staff can also say
  the retired player is out of the event, which takes them out as below.
- Winners move on by themselves; the last group match fills the knockout from
  the tables (by the rules' ranking order); a round robin and a knockout
  finish on their last match. A knockout result can be put right until the
  match it fed has been played.
- **Performances:** staff enter each competitor's attempts lane by lane, as
  the event measures them (1:02.35, 7.42, 312; X for a foul), or that they
  did not start, did not finish, or were disqualified. A best-of event takes
  the best attempt, and the next best breaks a tie; a total needs every
  attempt. Level results share a place. When every heat is in, the final is
  filled with the best from the heats, the best in the middle lanes — unless
  competitors are level for its last place, when the organiser decides it as
  their rules say (a swim-off) and chooses who goes through. A heat
  corrected after the final is filled refills it if the final has no results
  yet, and is refused if it would change who swam a final that has; one that
  leaves its field as it was is made. The
  overall placings are the final's order, then everybody else by their heats.
  A bouldering or climbing event enters counts instead of marks, and is ranked
  by them ([counted performances](#counted-performances)).

### Corrections after the knockout has begun

A group result put right after the knockout is filled fills it again from
the tables, as long as no knockout match has been played, given as a
walkover or retired. Once one has, nothing changes silently: a result that
would change who is in the knockout, or a knockout result whose next match
has been played, is refused and offered to a manager as a **correction**:

1. *Review*: what each way of making it would change, fixture by fixture
   ("Semi-final 2: now A v C (was A v B)"), whether it can go into the
   knockout safely, and any inconsistency it would leave.
2. *Choose*: **put into the knockout** — only where every knockout match
   whose players change is still to play and still has its court; anything
   else is listed as what blocks it — or **the group table only** (for a
   knockout match, **its record only**), which corrects the result and
   leaves the knockout as played.
3. *Confirm with a reason*, against the tournament as it was reviewed: if
   anything changed since, it is refused and reviewed again.

**A record-only correction never hides a wrong bracket.** If it means the
wrong competitor went on — the corrected match's old winner played the next
round, or the tables now send somebody other than who is in the knockout —
it opens a **progression issue**: every fixture the wrong competitor played
or is due to play is listed, played ones first, the tournament is under
review on its public page, and it **does not finish** (one already finished
goes back to under way) until a manager resolves it, with a reason, against
what they reviewed:

- **Let the results stand:** the matches as played stand, the wrong
  advancement accepted (the other side agreed, say), and it is recorded so.
- **Replay:** the matches the wrong competitor played from where they went
  wrong are played again — the first with the right competitor in their
  place, each later one with whoever wins the replay before — each at a court
  and time the organiser gives. The tournament holds that time like the rest:
  the court must be the venue's for the sport, open, in the future, not used
  by another of its matches, with neither side playing elsewhere, and a
  booking there is never moved (the replay is refused instead). What was
  played is kept in the record, never deleted, and everybody in the replays
  is emailed when they play. Nothing that was played after the replays is
  touched, and the places they fed that are still to play wait empty for their
  results; if a replay changes who goes on again, that is a correction of its own.
- Replaying is refused where it cannot be safe — the right competitor has
  left, or is already elsewhere in the knockout — and the organiser lets the
  results stand or arranges it by hand.

**A result in a double elimination or a consolation draw feeds two matches**
(its winner's route and its loser's), so it is put right while *neither* has been
played, and then it moves both competitors in one change (and the grand-final
reset appears, or goes, with it; a finished tournament is under way again when a
reset is needed again). Once either has been played it is refused as a plain
result and offered as a record-only correction, with the same preview, reason
and token. A record-only correction moves nobody, even where only one of the two
matches fed has been played, and opens **an issue for each route** the wrong
competitor is on (the winner's, and the loser's, which follows the competitor by
the route their result sent them: a winner on, a loser to the loser's route),
each listing every match they are in or have played. One grand final corrected so
that the winners' champion won it, after the reset was played, opens one issue,
the reset, with nobody to replay it for: it can be let stand. Replaying one
issue replays **both** (in a double elimination or a consolation draw, where each
competitor is in the other's place), each match at a court and time given, with
the right competitor in each head of chain; replaying one alone is refused
while the other route is let stand, since the right competitor would be in two
matches. What the replayed matches fed that is still to play waits empty for
their results (in the knockout too: a competitor who beat the wrong one is not
left in the next match while their own match is replayed).

Each correction and resolution is kept in `tournament_corrections` (with
what it changed, in English and as phrases the staff screen says in the
staff language, and the matches as they were) and `tournament_issues`, and
in the staff activity log (in English); the public page says that a correction was made,
not why. Front desk staff enter results but cannot correct, disqualify or
resolve. A result and everything that follows from it are one change.

### Court time

Until the draw, every hour is held, since nobody knows which will be used.
Once it is made, each court keeps only the hours from its first match or heat
still to play that day to its last — the hours between stay held, so one
that runs over does not run into a booking — and a court with nothing to
play that day is given back whole. It is worked out again after every result,
so a court is freed the moment its last match is in. Hours already gone stay
on the schedule as a record. Anybody on the waiting list for that court and
day is offered what comes free, as with a cancellation.

### Somebody leaving

Staff take an entrant out as **withdrawn**, **retired** (injured part-way) or
**disqualified** (a manager only, and only with the reason, which is kept);
players withdraw themselves only before the draw. Staff first see what it
would change, fixture by fixture and table by table; after the draw it is
made only as confirmed against that preview, and refused if the tournament
changed in between. When it happened and why are kept on the entry
(`out_reason`, `out_stage`, `out_at`, `out_note`) and in the activity log,
and the draw and the public page show it beside their name. Whatever the
reason:

- before the draw, the place goes to the waiting list;
- after it, each group match they had left is a walkover to the other side,
  and a knockout match against them is a walkover as soon as the other side
  is known; a line nobody is left to fill is a bye, and a match with nobody
  left on either side sends nobody through; in a performance event their
  heats and final still to come are *did not start*;
- in a double elimination or a consolation draw the same holds in each
  bracket: a leaver sits in the place their route gave them until the other
  side is known, then loses there by walkover, so each opponent gets a walkover
  in turn (in both brackets for a leaver in the winners' bracket), and a leaver
  in the losers' bracket or the consolation draw is out of the event; their
  stage is recorded as *knockout*;
- they never go through: the place goes to the next eligible entrant. If the
  groups are over and no knockout match has been played, the knockout is
  filled again without them; once one has, the knockout stands;
- results they already played are kept as played; a finished tournament's
  results are not changed by taking somebody out (it is refused).

**The tournament's rules** decide the rest, set up from its template and
changeable until the draw (`src/lib/tournament-rules.ts`):

| Rule | Choices | Default |
| ---- | ------- | ------- |
| Group results already played by somebody who withdrew or retired | stand, or void | stand |
| Group results already played by somebody disqualified | stand, or void | void |
| Fee paid online owed back to somebody who leaves before the draw | yes or no | yes |

Results that *stand* stay in the table as played: the entrant keeps the
place those results give them, flagged as out, never put last, and
everybody else's results against them count. Results that are *void* are
left out of the table for everybody, as if those matches had not been
played, though they stay in the record; the entrant is listed after the
rest, unranked. In a performance event, void results are shown as
disqualified, unranked, with the marks kept. Nothing is owed back after the
draw. Governing bodies treat these differently: the rules are the
organiser's to set to the regulations they play under.

**Calling it off** gives the courts back (offering them to the waiting
list), tells every entrant, and owes back every fee paid online.

The public page shows entries, then the groups (with points and draws where
the sport has them), the bracket, the heats and placings of a performance
event, and every match's court and time, refreshing while it is on. The
draw's arithmetic is in `src/lib/brackets.ts` and
`src/lib/performance-math.ts`, apart from the database, and tested on its
own.

### Counted performances

A **counted performance** is a performance event whose result is a set of
counts instead of one mark: **bouldering** (for each boulder, whether the zone
hold and the top were reached, and on which attempt) or **climbing by height**
(the highest hold reached). It is a template and rules, data the one engine
reads, never a branch on the sport
([ADR 0013](../architecture/decisions/0013-competition-framework.md);
`src/lib/counted-performances.ts`, `src/lib/tournament-rules.ts`). The groups
and final are the performance event's heats and final, and the results go in
through the same path as any performance result (`recordPerformances`), not a
second one.

| Template | Offered for | What it is |
| -------- | ----------- | ---------- |
| Bouldering: tops, zones and attempts | bouldering | Qualification groups, then a final of the best six; four boulders a round; ranked by tops, zones, fewer attempts to top, fewer attempts to zone |
| Bouldering, club format: tops, then zones | bouldering | One round of up to 40 climbers, five boulders; ranked by tops, then zones; no final unless set |
| Climbing by height (a route) | climbing | One route; a final of the best eight; ranked by the higher hold, then fewer attempts; countback on |

They are common competition practice, not any federation's regulations: an
organiser running an event under one checks the template against its rules
(the set-up screen says so), and changes what differs until the draw.

**Rules** (a template's, each changeable until the draw, checked): the kind
(`boulders`, or a `height`, which is one route); boulders in a round (1 to 40);
**ranked by** (an ordered list from `tops`, `zones`, `attempts_top`,
`attempts_zone` for boulders, or `height`, `attempts_height`; the set-up screen
offers the full list and *tops then zones only*); climbers in each group (2 to
40) and into the final (0: none); whether **countback** is on; whether the
final **starts** with the worst placed (`reverse`, the default: the best
climbs last) or the best; and what happens when climbers are level for the
final's last place (`cutTies`, below).

**The draw.** Everybody is drawn by lot into groups (there is no entry mark:
an entry that gives one is refused), each group given a court and a time as a
heat is, and each climber an order of start, 1, 2, 3 and so on, where a
marks event has lanes. A group is the qualification: everybody climbs every
boulder in the group's time. The final is filled by itself once every group is
in.

**What a judge enters.** For each competitor and each boulder they climbed:
the attempts made, the attempt on which the **zone** was reached and the one on
which the **top** was (each absent if not reached). Checked against how a climb
goes: a boulder topped ends at the attempt that topped it; the zone is reached
no later than the top, and a top with no zone marked reached it on the same
attempt; nothing is reached on an attempt not made; no boulder is given twice;
a boulder not entered was not climbed and counts for nothing. A competitor
with no boulder at all did not start (or did not finish, or was disqualified:
the same statuses as any performance event). A height is one record: the
highest hold (0 to 200), a **+** for a partial hold, and the attempts. A save
is all of it or none: one wrong line leaves the rest as they were. On a phone
the staff screen shows a row for each competitor and, for each boulder, **+**
for each attempt, **Z** at the attempt that reached the zone and **T** at the
one that topped it, one boulder at a time if the screen is narrow. Front desk
and managers enter, as for any performance event, and so does an official
assigned to the event ([below](#officials-and-counted-results)); every save is in
the activity log with each line's counts and what they replaced. The counts are the judge's record as entered, never a
verified measure.

**What a round is ranked by.** From the counts, each time: *tops* (boulders
topped), *zones* (boulders where the zone was reached, a top included),
*attempts to top* (added up over the boulders topped) and *attempts to zone*
(added up over the boulders where the zone was reached). Attempts on a boulder
that reached nothing count for nothing. A height's *height* is the hold, half
a hold more for a +, and its *attempts* are the attempts made. The round is
ranked by the event's keys in order, more tops, zones and height first and
fewer attempts first. Level on every key, climbers **share a place and the next
is skipped** (1, 2, 2, 4), as performance events show ties; those with no
result (not started, not finished, disqualified) follow, unranked.

*Worked example.* Four boulders. A tops boulders 1 (attempt 2, zone on 1) and 2
(attempt 1), reaches the zone on 3 (attempt 3), and tries 4 for three
attempts for nothing: 2 tops, 3 zones, 3 attempts to top (2 + 1), 5 to zone
(1 + 1 + 3), written **2T 3Z 3 5**. B has 2T 3Z 4 4 and C also 2T 3Z 4 4: A is
ahead of both on attempts to top, B and C share the next place. In the club
format (tops, then zones only) A, B and C all share one place.

**Countback.** Off by default. Where on, climbers still level in the **final**
on every key are split by their placing among all the groups together, the
better first; level there too, they share. A count is never overridden: a
better earlier placing does not lift somebody with fewer tops. The groups, which
have nothing before them, have no countback: level climbers there share a place.
(Federations' countback rules differ; the published rule here is the one
above.)

**Who goes through, and a tie at the cut.** The best `finalSize` by their
placing in the groups together, those out or disqualified not counted. If more
are level for the last place than there are places left, then by the rules'
`cutTies`: **`choose`** (the default) leaves the final empty and the organiser
chooses exactly as many of those level as there are places (a manager's, as in
any performance event), or **`all`** takes all of those level, so the final is
a little larger than set. The final's order of start is by the rules (`reverse`
or best first), ties in placing by entry number.

**Corrections.** A corrected count replaces the line, and everything
derived from it (every tally, placing and who goes through) is worked out
again from the counts in the same change, so the same counts give the same
placings in whatever order they were entered (property-tested, and a corrected
event is tested to equal the same results entered straight). A group
correction that changes who is in a final already filled shows what it
would change first (the line, the placings among the groups and the final's
new field, in the staff language) and is made only as confirmed against that
preview, refused if anything moved in between. If it leaves climbers level for
the last place, the final is emptied for the organiser to choose again, an
earlier choice standing while it is still a way through. A correction that
would change who swam a final which already has results is refused, nothing
changed (correct the final's own results, which re-rank it at once, or arrange a
re-climb by hand). One that leaves the final's field as it was is made at once,
for a marks event as for a counted one. A climber who leaves is *did not start*
for what is left; their results stand or are void by the event's rules, a
disqualified climber's void by default: kept on the record, unranked, and not
put through.

**Who sees what.** A staff member sees a round's lines with their counts and
places, and for each boulder how many of the field topped it and reached its
zone. The public page, which refreshes while the event is on, shows the
placings with a column for each key, each group's and the final's climbers in
their order of start with their counts, and how many topped each boulder
(counts are not personal data beyond what performance events hold). A declared
minor (a guardian's agreement, a participant a guardian manages, or a date of
birth under 18 on the first day: the entrant's word) is named there by first
name and the initial of the next, and everybody so where the tournament shows
short names (`src/lib/public-names.ts`), as every public page of every format does; the public API says the same. Juniors
enter through a guardian's account as for any event. Counts belong to the
entry: erasing a person anonymises the entry, the counts stay with it as any
result does, and a person's export lists their entry. A winner is named only
where first place is not shared.

### Officials and counted results

An **official assigned to a climbing event** (a link made from *Give an official a link* on the
event, for a counted performance event only: `addOfficial`, `src/lib/match-reports.ts`; the same
assignment, expiry and withdrawal as a match official's) can enter that event's counts from their
own page, `/officials/:link`, built for a phone held at the foot of the wall
(`CountedGridCore`, the judge's grid the dashboard uses: **+** for each attempt, **Z** at the
attempt that reached the zone, **T** at the one that topped it, one boulder at a time, or the hold
and attempts of a height). Its words are the customer dictionaries' (English, Malay, Chinese, Tamil).
The permission is **event-scoped, not a manager's**: the link enters counts of *this* event's
rounds and asks for corrections, and nothing else (`src/lib/official-performances.ts`).

- **Entering.** Through the same `recordPerformances` as the dashboard's save: the same validation (a
  boulder topped ends at the top, no zone after the top, boulders numbered 1 to *n*, marks refused for a
  counted event), the same all-or-nothing save, the same ranking, and `preview: true` for what a save
  would change. The whole route is one transaction on the round's locked row.
- **Open and finalised.** A round is **open** while any climber in it has no line. Once every line is in
  it is **finalised** (the event's ranking, and the final's field once every group is in, follow from it,
  exactly as for a staff save), and a group is also **advanced** once the final has results. While a
  round is open the official may enter and **re-enter** any line; each overwrite is kept with what it
  replaced. Entering a finalised or advanced round is refused (`OFC_ROUND_FINAL`) and nothing is
  written. The last line of the last group fills the final by itself, as it does for a staff save: that
  is a consequence of the counts, not an organiser's act.
- **Correction requests.** For a finalised or advanced round the official sends a **correction request**:
  a reason (3 to 300 characters) and the counts the round should have, checked as a save of them would be
  now (a request that could not be made is refused). It changes nothing. The league's managers are
  emailed in their language; one request is open per round and official, and the official may withdraw it.
  A manager reviews it under the event's *Results from the players and officials*: **preview** what it
  would change (each line, the placings, and whether it changes who is in the final), then **apply** it
  only against that preview's token (`CHANGED` if anything moved since; `OFC_NEEDS_PREVIEW` without one),
  or **decline** it with a reason the official sees. All of that is a manager's (`MANAGER_ONLY`); the desk
  may read the list.
- **What stays the organiser's.** Making the final from a tie at the cut (`makeFinal`, `cutTies:
  choose`), drawing, changing rules or entries, taking a climber out, ending or calling off the event,
  prices and payments, and every correction to a finalised round through the manager's flow above. A link
  has no other action: any other `action` is `400`, a match result or a call, start or release is refused
  (`OFC_PERF_ONLY`), another event's round or climber is `OFC_NOT_HERE`, and a link sent to any dashboard
  route is refused as no session (a test sends it to every staff route in each way it could travel).
- **Audit.** Each save is in the staff activity log as *Official: {name}* with each line's new and
  previous counts (`tournament.performances`), and as one row per line in `tournament_official_marks`
  (the counts as entered and as they were); the official's page lists their own recent entries and their
  requests. A request, its application and its decline are logged (`tournament.correction_*`).
- **Expiry.** As any official's link while the event runs: until the event's last day or an earlier day
  the organiser gave, and withdrawn at once on request. **When the event finishes** (finishing the final
  finishes it) the link of a climbing event does not end: for **7 days** (`OFFICIAL_AFTER_FINISH_DAYS`
  in `src/lib/match-reports.ts`, an install constant) it still works for **two things only**: seeing the
  event's results, and sending or withdrawing a **correction request** (the reason and the intended counts,
  checked by the dry-run preview as before; `requestCorrection`, `withdrawCorrection`). It enters and
  overwrites no count (`OFC_EVENT_FINISHED`, a preview included), enters no match result, calls, starts
  or releases nothing, has no other action and sees no other event; the page says so and until which day.
  A cancelled event ends the link at once, a withdrawn link stays withdrawn, and a link that had run out
  before the event finished does not come back. The manager reviews a request after the finish exactly
  as before, from the finished event's page on the dashboard, which then shows only the requests (preview, then apply against its token, or decline); applying it is a privileged correction
  as the dashboard's own save is (`recordPerformances`: the ranking and placings follow, the event stays
  finished, and nothing is rated, because a counted event has no two-sided result). A match official's
  link (not climbing) ends with the tournament, as before. The event keeps no finish stamp: the day it
  finished is the day of the last save to its rounds, in the venue's time, so a correction a manager
  applies starts the seven days again (the official can then see its effect and ask for another).

**Not rated.** A rating comes from decided matches with two sides
([ADR 0031](../architecture/decisions/0031-ratings-from-a-ledger-of-results.md));
a ranking of a field by counts has none, and is not turned into pairwise
results. Marking a performance event rated is refused (`RT_PERFORMANCE`) and
nothing in one reaches the ledger.

**Not built.** A semi-final round (a counted event, like any performance event,
has one final after its groups; a venue runs a semi-final as an event of its
own); lead qualification over two routes, or a score by several measures
combined; boulder bonus scoring where only the last attempt counts; speed
climbing; per-boulder timing and rotation of the groups through the boulders
(the group's time is one block of court time).

### Names of minors on public pages

A child is shown on every public page, public API payload and notice to another family by **first name and the initial of the next
name** ("Aina L."), by one rule (`src/lib/public-names.ts`; the authoritative statement, with the surfaces it covers, is
[privacy](../architecture/privacy.md#minors-names-on-public-pages)). It covers a tournament's page and API in every format, the live
page, the draw and Swiss-round notices to opponents, a box league's page, box-mates' contacts and start notice, and a junior ladder;
a team is shown by its team name; rankings never list a child. A declared minor is a guardian's agreement recorded at entry, a
participant a guardian manages, or a date of birth under 18 on the first day: the entrant's word, never verified. A pair with a
declared minor in it is shown short whole. Staff, the official's page, check-in and the guardian's own pages keep the full name.

The one exception is the guardian's: from the page for each child they manage (*Names on public pages*, in English, Malay, Chinese
and Tamil) they may allow the full name for **one event** (a tournament, or a league's or ladder's season) or for **all the child's
entries at one venue for 12 months**, by ticking a box and pressing a button. It is recorded as declared with the wording seen, can be
withdrawn at once (the next request shows the short name), ends with the event or season, and is logged in the child's history and
the venue's activity log. A manager or a venue cannot give it. An organiser's *short names for everybody* setting wins over it. The
wording awaits the owner's lawyer's review.

### What tournaments do not do

The [roadmap](../roadmap/roadmap.md) has what is planned or proposed.

- Formats beyond these: a consolation draw is for a straight knockout only
  (first-round losers, or the advanced feed-in for every loser; not after
  groups), and a double elimination is not after groups either; a performance
  event has one final, with no semi-finals or rounds of heats.
  [Swiss events](#swiss-tournaments) and [club ladders](#club-ladders) are built.
- A tournament is one event: one sport, category, level and format. Several
  events sharing courts are the divisions of a competition (above).
- The level is shown, not enforced. Ages, a guardian's agreement and a
  team's roster are what the entrant declares; a doubles partner and a
  typed roster are names, not accounts (a named [team](#teams)'s members are
  accounts, or children on a guardian's, each declaring their own age and
  category).
- Seeds are set by staff, or by entry mark in a performance event; a manager
  can ask for seeds proposed from [ratings](#ratings-and-rankings) and confirm
  them. A table is an event's own; what carries from one event to the next is
  the rating, not the table.
- A fixture is moved one at a time, not a whole round. Check-in is a mark:
  it changes nothing in the draw by itself.
- Emails go out on entering, coming off the waiting list, the draw, a moved
  fixture, a replay, a call-off, a knockout filled again (to those moved in
  or out, not to somebody who left), a report waiting for its answer, and to
  the venue's staff on a disputed report; on the day, when a match is next and
  when it is called ([tournament day](#tournament-day)); not on results or
  the finish. They are queued in the [outbox](../integrations/messaging.md),
  so one that fails is retried.

## Who enters and how

One set of checks for every way in (`src/lib/competition-entrants.ts`;
`enterAs` for a tournament, `joinAs` for a league):

- **The account holder, for themself**, as always: their account's gender
  for a women's, men's or mixed event, their own membership, the venue's
  rule on who it is for (`src/lib/access.ts`).
- **A guardian, for somebody they act for** (a participant,
  [ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md)),
  from the same page, choosing who is entering; the form then asks about
  that person by name (*Aina's date of birth*, *Aina's partner's name*, their
  entry mark), and the fee of an entry or league place held for them says
  whose it is (*Pay Aina's RM10.00 entry*). The participant is the
  entrant: the age range, the category and a members-only rule are theirs.
  The guardian declares the participant's date of birth and, in a women's,
  men's or mixed event, their gender (recorded as said, never verified);
  for a declared minor the guardian gives the agreement, under their own
  name. Never somebody another adult manages. At a members-only venue the
  participant needs their own membership or a family membership naming them
  (the guardian need not be a member, as for a members' session); at a
  private venue the guardian's account must be on the list. The guardian's
  account acts for the entry: it pays, withdraws before the draw, reports
  and answers results, is emailed, and its number is what league box-mates
  are given. Every email about the entry or place opens by naming whose it
  is (*This entry is for Aina.*): a tournament's entry, waiting-list place,
  draw, match moved or replayed, knockout place gained or lost, result to
  confirm and calling off (`tellEntry` in `src/lib/tournaments.ts`); a
  league's joining, season-start and end-of-season emails (*This place is
  for Aina.*). A league's result emails name both sides of the match. The entry is in the
  participant's history. An account on both sides of a match (two children
  of one guardian) reports for neither: staff enter that result.
- **Staff at the counter** (front desk or a manager, as a counter booking):
  *Enter somebody at the counter* in a tournament, *Add a player at the
  counter* in a league. The number and name given are taken on staff's word;
  or staff type a guardian's number and choose a participant the venue knows
  with a live guardian on it (a number never makes anybody a guardian).
  Everything the event asks is asked as online (a gender for a women's,
  men's or mixed event, dates of birth, a guardian's agreement); a
  participant at a members-only venue needs their own membership. There is
  no account: the entry keeps the number to reach them (a contact, not proof
  of who they are) and who entered it, shown to staff and in the activity
  log; nobody is emailed. A league's box-mates are given that number, which
  staff say to the player.

Each person enters once: an account for itself, and each participant however
many guardians act for them (unique indexes, migration 0178). A
competition's cap on divisions counts per person: the participant, not the
guardian's account; the scheduler keeps one person off two courts at once the
same way. A guardian closing their account leaves the participant's entry in
place, without the account; a participant's record erased takes them out of
what is still to come and their name off every draw and box.

## Box leagues

Venues run them from the dashboard's *Leagues* tab; players find them at
`/leagues`. A league runs season after season, four weeks each by default
(two to eight), rather than as fixed weekly fixtures nobody can keep.

- **Setting one up**: sport, singles or doubles pairs, level, box size (3 to
  6, default 4), one or two up and down, season length, a fee per season, and
  when the first season starts. Nothing is held: players book courts like
  anybody else.
- **Joining**: with an account, at any time, for themself or for somebody
  they act for, or added by staff at the counter
  ([who enters and how](#who-enters-and-how)). In a women's or men's league
  of pairs the partner's gender is declared too, and checked as a
  tournament's is. A league has no limit on players; joining is checked and
  written under the league's row lock, so the same player joining twice at
  once is in once and told so. A player joining mid-season goes
  into a box at the next one. Joining says plainly that box-mates will see
  your name and phone number — that is how matches get arranged — and only
  box-mates in the season being played see them, with a WhatsApp link.
- **Boxes**: everybody who has joined goes into one. Those who played last
  season go where their move takes them; a newcomer goes into the bottom box,
  best self-rated level first, unless staff give them a box to start in. Box
  sizes keep to the size asked and spread the odd ones over from the top
  (nine players in boxes of four make 5 and 4, not 3, 3 and 3), so one more
  or one fewer player does not reshuffle the ladder. Everybody plays
  everybody in their box once.
- **Scoring**: a league is scored and ranked by the competition rules
  (`src/lib/tournament-rules.ts`), from its sport's template unless another
  is chosen when it is set up: games best of three or five, tennis sets, a
  tally of goals, table points per result or by set score (volleyball's
  3-2-1-0), and the ranking order. A league match always has a winner, so a
  level tally is refused. Leagues set up before this read as the defaults
  they were ranked by.
- **Results**: either player reports the score, their own games first, and
  who won; the other confirms it, or says it is wrong and why — staff are
  emailed and decide it. A report nobody answers stands after three days.
  Staff can also enter any result, give a walkover, strike a match, or put it
  back to be played; both sides are then emailed what the venue decided, in
  their own language, and it is in the activity log. Tables use the league's
  rules, as a tournament group's.
- **A result changes only as it was seen.** Every change to a match is one
  transaction on its locked row, made only if its status and version are
  still those read (migration 0177): a correction never lands on a result
  confirmed, disputed or decided meanwhile, and a confirmation or a dispute
  names the version the player saw, so one of a result corrected since is
  refused (*the result changed*: look again). Staff decide on the version
  they were shown, refused the same way if a player reported or answered
  since. The version moves with every change, by whatever path (a walkover
  on leaving, a report standing, the end of a season).
- **Seasons start and end by themselves.** A season starts on its date if
  three or more have joined, and ends three days after its last day, for late
  results; staff can do either sooner, or move the start. At the end,
  unanswered reports stand, disputes nobody settled do not count, and the best
  one (or two) of every box but the top go up and the worst of every box but
  the bottom go down — never more than half a box. Everybody is emailed where
  they finished and where they go; the next season starts the day after.
- **Leaving** mid-season makes every match not yet played a walkover to the
  other side; what was played still counts for the opponents.
- **The fee** is paid online to the venue from the league page once the
  boxes are made, or at the counter, where staff tick it off. A fee that
  arrives after the player left, or paid at the counter meanwhile, is owed
  back.
- Closing an account takes the player out of their leagues and their name
  off every box; the personal data export includes leagues and seasons.
- Staff can stop a league (`close`) or remove a player.

**What leagues do not do**: they are box leagues of singles or doubles pairs
only (teams play in [leagues of teams](#team-leagues), with fixed fixture dates;
in a box league players arrange their matches and book courts themselves); the
level is shown, not enforced; a doubles
partner is a name, whose gender is declared, not checked; there is no
table across seasons beyond the box a player carries into the next (a league
a venue marks as rated feeds [ratings](#ratings-and-rankings), which do carry);
and somebody added at the counter is not emailed (they have no account).

The box arithmetic — sizes, who moves, the order for next season — is in
`src/lib/boxes.ts`, apart from the database, and tested on its own.

## Teams

A **team** (`src/lib/teams.ts`, `/teams`; migration 0269) is a name your
players share from event to event: a sport, a captain, and members who joined
with their own accounts. It holds no court and no money. A tournament entry or
a team league can **name a team**, and the roster for that event is picked from
its members and checked member by member. Teams are not community groups
([open games and matchmaking](matchmaking.md#community-groups)): a group is
people who invite each other to games, a team is who plays for what name in an
event. A team may carry a group's name and a venue as labels (`group_id`,
`venue_id`); neither adds members.

- **Who runs one.** A **captain**, who has to be a declared adult (a player who
  said in their profile that they are 18 or over, the same self-declaration as
  matchmaking: never verified). A captain runs at most five active teams, and a
  team holds at most 40 people. The captain invites, takes members off, hands
  the team to another member, enters events, picks lineups, publishes the team,
  archives it.
- **Joining is agreed on both sides.** Nobody is added. A captain invites by
  **email** (a single-use link, valid 14 days, sent through the
  [outbox](../integrations/messaging.md) in the captain's language; the address
  is never looked up, so the reply and the work are the same whether or not an
  account holds it, as for [groups](matchmaking.md#community-groups): only the
  keyed hashes of the link and the address are kept) or by a **link** the
  captain shares themselves (a message, WhatsApp: `Share on WhatsApp` opens a
  message with the link, no number is looked up), shown once. Invitations count
  toward the same thirty a day as invitations to games and groups. The invitee
  signs in and accepts; only a declared adult, and nobody across a block, can
  (ADR 0016): every invitation that cannot be used, for any reason, is refused in
  the same words (`TM_INVITE_INVALID`). A captain may withdraw one not yet used.
- **Children** never have an account here and are never invited. A child is a
  [participant](../architecture/decisions/0023-participants-apart-from-accounts.md)
  their guardian manages ([ADR 0022](../architecture/decisions/0022-children-managed-from-an-adults-account.md)):
  a captain puts a child they manage themselves on the team (their own
  agreement, as guardian), and anybody else's child is put on only by that
  guardian accepting an invitation *for the child* (`participantId`), which
  records the guardian's agreement (`agreed_at`) as the guardian declared it,
  never verified. The guardian's account acts for the child on the team (leaves
  for them, declares for them, is emailed with *This is about Aina.*). A
  child's name is shown to the captain and their own guardian; to other members
  and to anybody outside the team they are *a junior player*.
- **What a member declares.** A date of birth and woman or man, only so an
  event's age range and category can be checked; their word (a guardian's for a
  child), never verified, shown to nobody (the roster shows only whether it was
  given). No identity document is asked for or kept.
- **What people see.** Members see the team and its roster (first names for
  adults). Anybody else sees **only the name and sport, and only if the captain
  publishes it**; a team not published is not found for anybody who is not on
  it, and an archived team is no longer shown. An event a team is entered in
  shows the name the captain entered it as on that event's page (the captain's
  own act, as a typed team always did); its members are never on a public page.
- **Leaving.** A member leaves (a guardian for a child) and the captain is
  told. A member who leaves, or is taken off, comes off the rosters of events
  not yet drawn and of leagues not over and out of lineups still to be played;
  the captain is emailed if a roster is then too short. What was played stays
  in the event's record under the name it carried. The captain does not leave:
  they hand the team to a member with an account who has said they are an adult
  (at once; the new captain is told), or archive it.
- **Archiving** deletes nothing: nobody can join or be entered. It is refused
  while the team is entered in a tournament or league still to be played
  (`TM_ARCHIVE_ENTERED`: withdraw it first), and a captain can bring it back
  while they have room for another.
- **History.** A member (and the guardian of a child on it) reads what the team
  entered and how each match went, tournaments and league fixtures, and nothing
  about who else was in them but the opposing teams' names.

### Entering a tournament as a team

A team event takes either of two entries. The **typed team** is as it always
was: the captain's team name and a roster of names, no accounts, unchanged. A
**named team** is entered by its captain from their own account with `teamId`
and `rosterMemberIds` (the team's members picked for this event; the entry form
offers it to anybody who captains a team of the event's sport). It is checked
by `enterAs` like any entry, plus, **for every person picked** (`rosterRefusal`):

- the roster size the event asks, and only members of this team;
- **age range:** the member's own declared date of birth must be given and put
  them in the range on the first day (`TM_MEMBER_BIRTH`, `TM_MEMBER_AGE`); a
  member who is under 18 on the first day must be a child on a guardian's
  account (their agreement recorded when they joined; an account that says it is
  under 18 is refused, `TM_MEMBER_MINOR_ACCOUNT`); the entry then needs no
  guardian typed by the captain: the roster rows record that each young player
  was declared under 18 and when their guardian agreed (`tournament_entry_members`);
- **women's or men's:** the member's own account gender, or for a child the
  guardian's declaration (`TM_MEMBER_GENDER`, `TM_MEMBER_WOMEN`, `TM_MEMBER_MEN`);
- **members only:** each member's own membership, never the captain's or a
  guardian's ([ADR 0025](../architecture/decisions/0025-benefits-and-privileges-by-scope.md));
  and **a private or members' venue** the same as for any entry;
- the **level is shown, not enforced**, as for every event.

One person is on one roster of an event, by who they are and not by the team's
row for them (`TM_MEMBER_ENTERED`), and a team enters once. Only a captain
enters a team (`TM_ENTRY_CAPTAIN`), and a counter or a guardian's entry names no
team. Everybody on the roster is emailed (a child's guardian, naming the child),
so nobody learns from the captain alone. Withdrawing the entry, the draw,
results and fees are the tournament's own ([tournaments](#tournaments)).

### Teams and personal data

The data export lists an account's places on teams (its role, status, dates,
what it declared, and for a child it acts for whom and when it agreed), nothing
about others on the team; a participant's own record lists theirs. Erasing an
account takes it off every team: a captain's team goes to the longest-standing
member with an account of their own who is a declared adult, or, with nobody to
hand it to, is archived and withdrawn from the events it is entered in; the
children the account acted for come off, and their names, and the account's, on
rosters and lineups kept for events are replaced by `(removed)`. Erasing a
participant's record does the same for them. A member who left or was taken off
is forgotten from the team after 365 days, invitations 2 days after they run
out (the scheduler, `teamHousekeeping`). Nothing leaves the country
([privacy](../architecture/privacy.md#teams)).

### What teams do not do

- A team is a name and a roster, not an entry: no fee, no booking, no money.
- Nobody is invited by looking up a phone number or an email: only the link or
  address the captain types, answered the same whoever holds it. A group's
  members are not added to a team by being in the group.
- A minor with an account of their own cannot be on a team; a child is on one
  through a guardian's account.
- A member's declaration is their word: an age range and a category are checked
  against it, not against a document, and the venue checks on the day if it
  matters.
- The level is not enforced. A team has one captain; there is no vice-captain
  and no separate team-wide chat.

## Team leagues

A **league of teams** (`src/lib/team-leagues.ts`, `src/lib/fixtures.ts`,
`/team-leagues`; migration 0269) is run by a venue for one season: teams enter,
the manager sets the **match nights**, a **fixture generator** makes a single or
double round robin on them, and each fixture is a **team match** made of
games. It is a different league from a [box league](#box-leagues): there are no
boxes and no season after season, and players do not arrange their own matches.
Box leagues stay as they are.

### Setting one up

A manager (the front desk may not, `MANAGER_ONLY`) sets up, from *Leagues* in the
dashboard (*Leagues of teams*): the sport, the template that scores it, the
venue's courts it plays on, the season's first and last day, whether every team
meets every other once or home and away, and who may enter (women's or men's,
an age range counted on the first day, members only, level shown), the most
teams and roster sizes, the minutes held on court for one game, and how many
matches a court holds a night.

- **A team match is made of games, from the sport's template, as data**
  (`rubbers` on `src/lib/competition-templates.ts`; never a branch on the sport,
  [ADR 0013](../architecture/decisions/0013-competition-framework.md)): badminton
  singles, doubles, singles; table tennis and squash four singles and a doubles;
  tennis and padel two singles and a doubles; a sport whose match is the whole
  team (football, futsal, volleyball, basketball, anything else) has **one
  match of the whole team**, scored as that template scores a match. A manager
  may give other games (1 to 9, singles, doubles, or the one team match).
- **Scoring** is the sport's template, with the competition rules' scoring laid
  over it (`parseRules`): how a game is written ("21-15, 18-21, 21-10", "3-2"),
  best of how many, whether a level tally is a draw. A match of several games
  earns table points by the league's own table rules (3 for a win, 1 for a draw,
  0 for a loss unless the manager sets others), ranked by points, then the
  difference between games won and lost, then games won, then who beat whom (any
  of the competition rules' ranking keys, in the order set); a one-match league
  is ranked by the template's own points and keys, with the real scores
  (goal difference and so on). Anything still level is settled by the order the
  teams entered, and the page says so. No fee: nothing is sold.

### Teams enter

A captain enters a team (`enterTeam`) from the league's page with the roster
picked from the team's members, a home court (one of the league's courts) if
wanted and the dates the team cannot play. It is counted and written under the
league's row lock: of captains entering for the last place at once, one is in.
Each rostered member is held to the league's age range (by their own declared
date of birth on the first day), category and members-only rule as in
[a tournament entry](#entering-a-tournament-as-a-team); one person is on one
team's roster of a league, and a captain captains one team of a league. The
roster can be changed, and blackout dates given, until the league is over
(blackouts given after the fixtures are made are shown to staff as clashes, for
a manager to move). A team can withdraw; a manager can take one out.

### The fixture list

A manager gives the match nights (a date in the season, from today, with a start
time; a weekday and a count fill them in) and makes the list (`generateFixtures`;
`POST /api/admin/team-leagues/:id` `generate`). `src/lib/fixtures.ts` decides, apart
from the database and tested on its own (`tests/fixture-plan.test.ts`):

- **Who meets whom:** the circle method, every pair once (or home and away in
  the return half), nobody twice in a round; with an odd number of teams one has a
  bye each round, and the nights page names who is not playing.
- **Home and away** alternate as the pairings allow: for a single round robin no
  team is home more than once more than it is away, with the least breaks in
  alternation a round robin can have (n − 2 over the season); a double one is
  exactly even.
- **Match nights:** each team plays at most once a night and never on a date it
  gave as impossible; earlier rounds go on earlier nights (round *n* on night *n*
  when there is room), a night holds at most as many matches as the league's
  courts times the times a court is used; where blackouts leave some over, other
  orders are tried deterministically before giving up. If the nights are too few
  (`TL_NIGHTS_FEW`, with the number needed) or cannot be used given the dates
  teams cannot play (`TL_NO_PLACEMENT`, naming a fixture), **nothing changes**.
- **Courts:** the home team's own court where it is free then, else the first
  free one, the night's first time first.

Each fixture's court time is **held as blocks the league owns**
(`blocks.team_league_id`, `team_fixture_id`; the same
[claims](../architecture/booking-time-model.md) every booking path respects, so
the database refuses a double booking): the games' minutes from the fixture's
start, on its court. A fixture whose planned court or time is taken (a booking, a
staff block, an outage) is tried on the night's other courts and times first; if
nothing on the night is free the whole list is refused (`TL_NO_COURT`) and what was
there before is as it was. A staff block or unblock over a fixture leaves the
league's hold alone: a manager moves the fixture. The list can be made again
until a lineup or a result is in (`TL_RESULTS_IN`); everybody on every roster is
emailed their team's fixtures in their own language, a child's guardian naming the
child.

### Lineups

For each fixture the captain of each side picks who plays each game from their
**league roster** (`setLineup`): one player for a singles game, two different
players for doubles, the squad for a whole-team match; nobody in more games of one
match than the league allows (two); each player's eligibility is checked again
(a member who left is out). Until a result is in; the people picked are emailed.
A lineup is shown to the people on that side, to staff, and, once a result is
reported, to the people on both sides; never publicly. A child is named in it only
to staff, their own side's captain and their own guardian.

### Results

A result goes in one way: through the league's own functions
(`reportFixture`, `confirmFixture`, `disputeFixture`, `decideFixture`), the same
checks and rankings as a tournament's and a box league's (`scoreRefusal` and
`standings` in `src/lib/brackets.ts`; [box leagues](#box-leagues) and
[ADR 0013](../architecture/decisions/0013-competition-framework.md) are the
model, and `AGENTS.md` names this module with them), never a parallel path.

- **A captain reports** (from the fixture's date), each game's winner and
  score, home side first, or a walkover; every score is checked by the sport's
  rules and refused with the game's number (`TL_RUBBER_SCORE`). The other
  captain is emailed and **confirms**, or **disputes** with a note, whereupon
  the venue's staff are emailed (each in their own staff language) and decide.
  A report nobody answers **stands after three days** (the scheduler,
  `teamLeagueHousekeeping`), told to both. Only a captain of the fixture can
  report; the reporting side can correct its report until the other answers.
- **Every change to a fixture is made on its locked row and only as it was
  seen:** it has a `version` that moves with every change by whatever path, and an
  answer or a staff decision on a stale version is refused (`TL_CHANGED`: look
  again).
- **Staff decide:** the front desk and managers enter the games' results (taken as
  confirmed), **strike** a fixture (it does not count), or **put it back to be
  played** (its court time is held again, or refused if the court is no longer
  free). **Giving a forfeit is a manager's act** (below): the other side is
  awarded every game, the forfeiting team named, counted in the table as every
  game to the other side at the rules' walkover. Both captains are told what was
  decided. All are in the activity log.
- **The table** counts confirmed results and forfeits; a team that withdrew keeps
  what it played (for the others' tables too) and is listed last; every
  unplayed fixture of a team that withdraws becomes a forfeit to the other side
  (their court time goes back, the opposing captains are told).
- A league is **finished** when every fixture is decided; **closing** it (a
  manager) strikes what was still to play and gives all its court time back.

### Forfeits are a manager's, and asked for by captains

A forfeit changes the table, the points and who goes where, so **only a manager gives one**
(`MANAGER_ONLY`: `POST .../fixtures/:fixtureId/forfeit`, and a decision on a request below; the
front desk is refused with the usual *Ask a manager* answer and its screens hide the button, as
for any manager-only act). The front desk's other powers are as they were. The same rule
covers a **whole fixture entered as a walkover** (every game given to one side by walkover): the
desk is refused it as a forfeit, and a captain's report of it is refused (`TL_FR_USE_REQUEST`);
one game by walkover is an ordinary result. A team that **withdraws** still forfeits what it had
left, by its captain's or a manager's act, as before.

**Asking for one** (`src/lib/team-forfeits.ts`, migration 0276). Leagues of teams have no
officials, so the people who may ask are **the captain of either team in the fixture** and **staff
(the front desk too)**. A request names the fixture, **which of its two teams is asked to
forfeit**, a **reason** from a short list (*did not turn up*, *cannot field enough players*,
*said they will not play*, *another reason*, which needs a note) and up to **300 characters** of
text, and **changes nothing else**: no result, no table, no points, no advancement, no
scheduling, and the fixture's court time and the next fixture are untouched (tested). It is
refused unless the fixture is still to be played (`TL_FIXTURE_DECIDED`).

- **Told:** the league's managers (each in their own staff language; not the front desk) and, for a
  captain's request, the other captain; the request shows on the manager's fixture screen as
  *Forfeit requested by {team or staff name}: {team} to forfeit*, with the reason and note. A
  captain sees the state of the requests on their own fixtures (a request is never shown to the
  public or to other teams).
- **One open request per fixture and requester** (`TL_FR_OPEN`); the other captain may have their
  own. The **requester may withdraw** it (the other captain is told); nobody else's.
- **It ends** when withdrawn, **after 14 days** (it is no longer answerable even before the
  scheduler marks it expired, and the captain who asked is told), or **as soon as the fixture is
  decided any other way**: played and confirmed (or its report left to stand), struck, or given
  as a forfeit by another route or by a withdrawal. A fixture merely put back to be played keeps
  its request. This closing happens inside every change that settles a league's fixtures
  (`settleLeague`), on the league's lock, so a request racing a result is either refused or closed by it.
- **A manager confirms** it (`POST .../forfeit-requests/:id` with `{ confirm: true, version? }`):
  the existing forfeit (`decideFixture` with `forfeitBy`), whole, in the same transaction as the
  request being marked confirmed: the other side awarded every game by the sport template's
  forfeit scoring, the table recomputed through `standings`, a rated league's ratings read again (a
  forfeit is a walkover and moves no rating), the fixture's court time let go and offered to the
  waiting list, both captains told. **Or declines** it (`{ decline: true, reason }`, 3 to 300
  characters), both captains told the reason, nothing else changed. Two managers acting at
  once decide it once.
- **Audit:** the request keeps who asked (a captain's team name, never the person's name; or the
  staff member), the team asked, reason and note, who confirmed or declined, when, the reason for
  declining, and the **table before and after** a confirmation. The staff activity log has a line for
  each step (*asked*, *withdrawn*, *confirmed* with the two teams' places and points before and after,
  *declined*), a captain's under *Captain of {team}*.
- Customer text is in English, Malay, Chinese and Tamil; staff text in English, Malay and Chinese.

### Moving a fixture

Only a manager moves a fixture (the owner's decision; `PATCH
/api/admin/team-leagues/:id/fixtures/:fixtureId`), one still to play: the new time
is held (never over a booking) or nothing changes; it must not be in the past, on
a date either team gave as impossible, nor with either team in another fixture
then; the court is one of the league's. The old hold goes, both captains and the
lineup are told, the move is logged with the old and new time, and held time
no longer needed goes back to the waiting list. A decided fixture is corrected,
not moved.

### What people see

Anybody sees the league, its teams **by name**, the fixtures (per night; per team
with a filter), the results and the table: no player, no roster, no lineup and no
dates a team cannot play. A member of an entered team also sees its roster and
lineups; a captain also the dates the team gave; staff see everything, a child
named as for any entry (to anybody else, never: no public team-league payload carries a player's name). A league at a venue the viewer may not see is not found.

### What team leagues do not do

- No entry fee or payments: nothing is sold or refunded.
- One season: no promotion and relegation, no table across seasons, no
  play-offs or knockout stage after the table, no seeding. A league a venue
  marks as rated feeds [ratings](#ratings-and-rankings) across events.
- Games are recorded with their scores and winners; the only per-player
  statistics across leagues are the [ratings](#ratings-and-rankings) a rated
  league feeds.
- A fixture holds one court for all its games in turn (the games' minutes added
  up), not a court per game; a manager moves a fixture's court or time one at
  a time, not a whole night.
- Not verified: ages, categories and a guardian's agreement are what the
  member declared. The level is shown, not enforced.

## Ratings and rankings

A **rating** (`src/lib/ratings.ts`, `src/lib/rating-math.ts`,
`src/lib/rating-eligibility.ts`; migrations 0270 and 0275;
[ADR 0031](../architecture/decisions/0031-ratings-from-a-ledger-of-results.md),
amended by [ADR 0035](../architecture/decisions/0035-rating-policy-published-rankings-and-counted-results.md))
is built from the results of events a venue marks as rated, by one published
rule. It carries a result from one event to the next, which a table never did.
Nothing is learned and nothing is hidden: a player is shown, for every result,
what the rating expected, what happened and how far it moved.

**A rating is an estimate from the results counted.** With few results it can
move a lot, and the number of results that makes a player *ranked* (8 unless
the venue chooses otherwise) is a convention, not a measure: **eight results do
not make a rating exact.** Every public and player screen says so, and nothing
calls a rating a true level or a skill.

### What counts

- **Only events a manager marks as rated** (*Ratings and rankings* under the
  dashboard's *Leagues* tab; `rated` on a tournament, a box league or a league
  of teams, off by default). The choice is made before the event starts and is
  fixed after: a tournament before its draw, a box league before its first
  season starts, a league of teams while it is forming (`RT_STARTED`). The
  event's page says its results count towards ratings, to anybody thinking of
  entering. A casual open game is never rated: nothing records a result for it.
- **Per venue, per sport and per format.** A *pool* is one venue, one sport and
  one format: singles (a player entry), doubles (a pair), team (a persistent
  [team](#teams), for a team entry in a tournament or the result of a team-league
  fixture). A rating at one venue does not touch another's.
- **Who is rated.** An account, a child a guardian manages (kept for the child
  and their guardian only), a persistent team. A name typed into an entry is not
  somebody the app can rate: a doubles partner is a name, so a pair counts as the
  entrant alone; a typed team and somebody entered at the counter without an
  account have nobody to rate, and a match with nobody to rate on a side is not
  counted. In a league of teams each singles or doubles game counts for the
  people the captains picked to play it, so a game with no lineup counts only
  for the teams.
- **Which results.** Decided and confirmed ones, by the table in
  [which results count](#which-results-count): a tournament's group and knockout
  matches (every bracket of a double elimination or consolation draw: winners',
  losers', grand final and reset, consolation; Swiss rounds; a bye and a reset
  that is not needed are not matches), a box league's confirmed matches and
  walkovers, a league of teams' confirmed fixtures and forfeits (the teams'
  result, and each singles or doubles game), a ladder's confirmed challenges and
  forfeits. Not a performance event's heats or counts
  ([not rated](#counted-performances)).

### The rule

Published constants (`DEFAULT_RATING_RULES`, kept as install data in
`rating_rules`; no screen edits them):

| | |
| - | - |
| Start | 1000 |
| Chance of winning | `1 / (1 + 10^((other − own) / 400))`; a side's rating is the average of its members' |
| Change | `K × weight × margin factor × (result − chance)`; result 1 for a win, ½ for a draw, 0 for a loss; each member moves by their own K |
| K by results already counted | 40 for the first 10, 24 up to 30, then 16: newcomers settle faster |
| Weight | 1 for a match played; **½ for a win by retirement** (the other side stopped part-way); **0 for a walkover**: a forfeit is not play, so it moves nothing and is not counted (the row stays in the ledger, to explain) |
| Margin | Only where the sport's scoring is a tally of goals or points: nothing extra for a margin of one, then 10% more for each further goal, up to 40%. Never for sets |
| Provisional | Until the venue's number of counted results (8 by default; a venue chooses 3 to 30, [below](#a-venues-ranking-policy)): shown as *provisional* and never ranked. A classification only: it changes no rating |
| Level a rating earns | beginner below 950, intermediate from 950, advanced from 1100, competitive from 1250 (used by [matchmaking](matchmaking.md#earned-levels)) |

Ratings are rounded to two decimals after every update, so a replay gives the
same numbers on any machine. A walkover or a retirement is treated as the
event's own rules treat it: the event decides whether a withdrawn or retired
entrant's group results stand or are void, and a void one is not counted here.

### Which results count

A result is **counted** when it is **decided and confirmed**, in an event a
manager marked as rated. `src/lib/rating-eligibility.ts` holds the table in code
(`TREATMENT`, `DECIDED_STATUS`, `UNDECIDED_STATUS`) and
`tests/rating-eligibility.test.ts` runs every row of it against a real event, so
this table, the code and the ledger cannot disagree. *Ledger row* is whether the
result is written down (a row that moves nothing still explains itself);
*counted* is whether it moves ratings and counts towards the number that ranks a
player.

| Situation | Ledger row | Moves ratings | Counted as a result |
| --------- | ---------- | ------------- | ------------------- |
| Played to a result, a win or a loss | yes | fully (weight 1) | yes |
| A draw, where the sport's rules allow one (a group match scored in goals; a game or fixture of a league of teams) | yes | fully, a result of one half | yes |
| A win by **retirement** (one side stopped part-way) | yes (*retired*) | half (weight ½) | yes |
| A **walkover** or no-show given to the other side | yes (*walkover*) | no (weight 0) | no |
| A **forfeit** (a league of teams' fixture; a ladder challenge nobody answered) | yes, as a walkover | no | no |
| **Abandoned, unplayed or incomplete**: nothing was decided | no | | |
| A **bye** | no | | |
| **Unconfirmed**: a player reported it and the other side has not answered | no: it is not a result yet; it is recorded when the other side confirms, or when it stands after 24 hours | | |
| **Disputed**: staff are deciding | no: recorded when they decide | | |
| **Voided or struck** by staff, or the event called off | no: its row is voided and the pool replayed | | |
| A disqualified or withdrawn entrant's **group results the event's own rules void** (a disqualified entrant's, by default) | no | | |
| **Invalid**: a score the sport's own scoring rules refuse (it says the other side won, or is not a score), no score on a match played, a level score where the rules allow no draw, a side against itself | no | | |
| **Nobody to rate** on a side: a name typed into an entry, somebody entered at the counter with no account | no | | |
| **Left out by a manager**, with a reason | the row stays | no | no |

The same table holds in every format; what differs is only which results there
are:

| Format | Results read |
| ------ | ------------ |
| Singles, doubles (a pair is the entrant alone: a typed partner is not rated) | each decided match |
| Team entries and the games of a team match | a named team's match; in a league of teams each singles and doubles game for the people picked, and the teams' result |
| Knockout, double elimination, consolation, third place | each decided match of every bracket; a bye and an unneeded reset are none; a knockout always has a winner, so a level score is invalid; a leaver's matches are walkovers to the other side |
| Round robin and group stages | each decided match; a draw only where the rules allow it; a leaver's or a disqualified entrant's group results as the event's own rules say |
| Swiss | each decided match of each round (they are group matches); a bye is none |
| Ladders | a confirmed challenge is played; an unanswered one or a walkover is a walkover; declined, cancelled, lapsed and voided are none; a rank is not a rating |
| Box leagues | confirmed matches and walkovers; reported, disputed and voided are none; no draws, no retirements |

Every status a result row can have in the four result tables is classified as
decided or not in one place, and a test fails on a status nobody classified. There
is no cross-source duplicate guard because none can arise: a result row belongs to
one event of one kind, and the ledger's unique index is on that row (event, match,
game). Counter entries and typed names are never rated, as built.

### The ledger is the source of truth

- `rated_results` holds **one row per decided match** (a tournament match, a
  box-league match, a team-league game, a team-league fixture), with both sides
  (`rated_result_subjects`), the outcome, its kind (played, walkover, retired),
  the margin where there is one, and the result row it records. Its facts are
  never changed: a corrected result is a new row and the old one is **voided**
  (`voided_at`, with why), so what was counted when is kept.
- A rating is **a pure function of the ledger's live rows in a defined order**
  (when it was played, then event, match and game: `orderKey`). Whenever a row
  is added or voided, the whole pool is **replayed from the ledger** under the
  pool's row lock (`recomputePool`), never updated from a previous rating, so
  nothing drifts. A rating at any moment equals a replay from scratch, and a
  ledger rebuilt from the results gives the same ratings (tested).
- **Results still enter only through `recordResult` and the league functions.**
  The ledger is a consumer: each of them calls `ratedAfter` once it has
  committed (a result recorded, corrected, a progression issue resolved,
  somebody taken out, a tournament called off; a box-league result confirmed,
  decided, a season ended, a player leaving; a league-of-teams fixture
  confirmed, decided, a team withdrawn, the league closed), and the scheduler's
  catch-up (`ratingsCatchUp`) reads again any rated event whose results differ
  from when it was last read. A correction, a void, a strike, a forfeit or a
  restore therefore removes or replaces the affected rows and puts every rating
  right. Reading is idempotent and race-safe: one live row per result (a unique
  index), an event read one at a time, each pool recomputed under its own lock
  in a fixed order; two deliveries, two servers or a missed call give the same
  ledger.
- **A manager can leave a result out** (with a reason, logged; the exclusion
  belongs to the result and survives its correction; lifting it is logged too)
  and **start a rating again** (with a reason, logged): the subject's earlier
  results stay in the ledger and still count for the people who played them,
  but their own rating and record begin again at the start.

### Rankings

- **A venue's ranking, once its manager has published it,** per sport and format
  (`/venue/:id/rankings`, `GET /api/venues/:id/rankings`; [policy](#a-venues-ranking-policy)):
  rating, results counted, record, recent
  form, for one **season** (a calendar year: the rating after the year's last
  result, the record in it) or all time. Where a venue allows it
  (*List this venue's rankings beside the other branches of its business*), a
  business-wide view lists each branch's pool side by side, not a merged rating.
- **Public pages show only people who opted in** (off by default, declared
  adults only, under the name they gave) **and teams their captain published**,
  and only once the rating is no longer provisional. A child is never listed,
  whatever they have done. Nobody is named because of a rating. Where the venue
  chose it, people who opted in but are not ranked yet appear in a separate
  section, never in the ranking.
- **A player sees their own** at `/ratings`: each rating by venue, sport and
  format, whether it is provisional and what level it earns, the record, and for
  each result what it was against (as the event showed them; a child is *a junior
  player*), the chance the rating gave it, what happened and how far it moved
  (K and any margin or retirement weight), and whether the venue left it out or
  restarted the rating. An opponent's rating is shown only if they chose to show
  it; otherwise the chance is given to the nearest ten per cent. A guardian sees a child's, and
  a team's members its team's.
- **Managers** see the venue's ratings, provisional ones too, the results in
  the ledger and whether each counts, and the exclusions and restarts made,
  whether or not the venue's rankings are public.
- **Seeding** a draw from ratings is a **proposal**: the entries with a
  non-provisional rating, best first (a quarter of the field, two to eight),
  confirmed by a manager against what they were shown, through the draw's own
  seed input (`setEntry`); never over seeds staff already set, and refused once
  drawn.

### A venue's ranking policy

Under *Ratings and rankings* in the dashboard's *Leagues* tab, a manager sets
(migration 0275, `venue_rating_settings`; [ADR 0035](../architecture/decisions/0035-rating-policy-published-rankings-and-counted-results.md)):

- **Publish this venue's rankings** (`public_rankings`, **off by default**). A
  ranking is never published because one rated result exists. Off, the rankings
  page and `GET /api/venues/:id/rankings` answer **404** (not an empty page), the
  venue page does not link to them, the MCP tool `venue_rankings` says the venue
  has not published rankings, and the sitemap never lists them (a published page
  is not indexed either: the people on it chose to be on a ranking, not to be found
  by a search engine). **Every venue that existed before this setting has it off:
  its public ranking page and API stop answering until its manager publishes them.**
  A manager whose venue has rated results and has not published is told so in the
  panel. On a business-wide board a branch is listed only if it allows the
  business board *and* has published its own.
- **Show players who are not ranked yet, in a separate section**
  (`show_provisional`, off by default, needs the above). Titled "Provisional:
  fewer than N rated results; these ratings may move a lot", in a block of its
  own: no rank numbers, no medals, not in order of rating (listed by name). The same
  people the ranking may name; never a child. Not on a business-wide board.
- **Counted results before a player is ranked** (`rank_after`, 3 to 30; empty is
  the install's default, 8). **It changes who is shown as ranked and who as
  provisional, here and in public, and nothing else: no rating and no ledger row is
  touched** (tested against a replay from scratch, with the number changing between
  corrections). It is a venue's number, not an event's: a rating belongs to a pool
  that many events feed. A player's own page, the manager's panel, seeding
  proposals use that number for that venue. **Matching is the exception, upward
  only:** the level [matchmaking](matchmaking.md#earned-levels) may use needs
  `max(this number, 8)` counted results (`matchingThreshold`), so a venue that raises
  it raises it for matching too, and one that lowers it to 3 ranks players on three
  results while matching still trusts no rating on fewer than the install's default.
  The page says what a rating is.

The private views (a player's own ratings, a guardian's, a team's members', the
manager's panel and ledger) never depend on any of these. Turning public rankings
off turns the provisional section off with it. The rating maths constants (the
start, K, weights, margin) stay install data in `rating_rules`.

### Auditing ratings

- **Every rating change is explainable from the ledger:** each result carries the
  ratings before and after, K, the chance given and the weight, and a rating equals
  a replay of the live ledger from scratch after any correction, strike, restore or
  change of the number that ranks players; the same ledger gives the same ratings in
  any order of its rows (both tested).
- **Who changed what:** every change to the policy, every event marked rated or
  not, and the business-wide listing is a line in `rating_policy_log` (who, when,
  from, to) and in the activity log (`ratings.public_rankings`,
  `ratings.show_provisional`, `ratings.rank_after`, `ratings.event_rated`,
  `ratings.event_unrated`), shown in the panel.
- **A manager can download the ledger** (*Download the ledger (CSV)*,
  `GET /api/admin/ratings?venueId=&export=ledger`, one pool with `&sport=&format=`;
  logged as `ratings.ledger_exported`): every result, a line for each person or
  team on it, in replay order, with the rating before and after, what it moved,
  whether it counted and why not, and rows later replaced or struck marked as such
  without ratings. A child is *(junior player)*, as in the panel.

### Roles, privacy, languages

- Setting an event as rated, publishing rankings and the policy, leaving a result
  out, starting a rating again, seeding, the business board and the ledger download
  are a manager's (`MANAGER_ONLY`) and each is in the activity log (`ratings.*`).
  Front desk sees none of it.
- A player's export lists their ratings and each result that moved them
  (children's in the guardian's export of the child's record); erasing an
  account makes its place in the ledger *(removed)*, standing at the rating it
  had then, so nobody else's rating moves, and every pool it was in is replayed
  ([privacy](../architecture/privacy.md#ratings)). The ledger is kept as long as
  the competition results it records are.
- Staff text is in the staff dictionaries (English, Malay, Chinese), customer
  text in the customer dictionaries (English, Malay, Chinese, Tamil); the other
  languages await native review.

### What ratings do not do

- **Not an enforced level.** A rating band checked at entry is not built
  (declared levels and the event's level stay as they were: shown, not enforced).
- Ratings are per venue: there is no rating across venues, and a business-wide
  board lists pools side by side. A player's earned level for a game at a venue
  uses their rating at that venue.
- A doubles partner typed into an entry, a typed team and somebody entered at
  the counter are not rated; the people picked in a league of teams' lineups are.
- Not a performance event's heats or counts (a field ranked by marks or counts has no two-sided result; marking one rated is refused), and no rating from a casual open game.
- The constants are the install's, not the venue's, and are changed in the
  database (raising the version recomputes every pool); there is no screen.
- Provisional ratings are not ranked, and a venue has no ranking until its manager
  has published it and somebody who opted in has played enough results.
- The number that ranks a player is a venue's, not a competition's or a format's.
- A rating is an estimate: the number of results that ranks a player does not make
  it exact, and no screen says it does.

## Swiss tournaments

A **Swiss** event (`src/lib/swiss.ts`; migration 0272;
[ADR 0033](../architecture/decisions/0033-swiss-tournaments-and-club-ladders.md))
plays a fixed number of rounds against opponents of about the same standing: each
round is paired from the standings the round before left, nobody meets twice, and
the table at the end ranks everybody, with no knockout. It suits a field too big
for a round robin and too uneven for a draw by lot. It is a tournament like the
others: configured by the sport's template, entered the same ways, scored by the
same rules, with results entered only through `recordResult`.

### Setting one up and the draw

- **Format: Swiss** under *Set up a tournament* (staff; the template's scoring and
  tables are the event's). It takes at least 4 entries. Its settings are in the
  rules (`rules.swiss`): the **rounds** (blank: the default, below), the **points
  for a bye** (blank: what a win is worth) and the order of **tie-breaks** (blank:
  the default, below; set by the API, shown on the pages). The match length is the
  group stage's.
- **Rounds.** The default is ⌈log₂ n⌉ for n entries at the draw (4 entries 2, 8 → 3,
  16 → 4, 32 → 5), at least 1. At most n − 1 for an even number, n for an odd one:
  more could not be played without somebody meeting twice, and the draw says so.
- **The draw** makes the *initial order*: staff seeds first in seed order (seeds
  may be proposed from [ratings](#ratings-and-rankings) and confirmed), then
  everybody else in an order drawn from a **recorded seed** (`swiss_events.seed`),
  so the draw can be reproduced; nothing after it is random. It then pairs round 1
  and gives each match a court and time. **All the rounds must be able to fit**
  the time held (a round after the last one ends, with the same number of
  matches): if they cannot, the draw is refused and changes nothing, saying how
  many matches did not fit.
- The **time held** stays held until the last round is paired, since nobody knows
  yet which hours the later rounds need; each round then takes its court time from
  what the tournament (or its competition) holds, after the previous round's last
  match ends and after now, around other bookings and other divisions' matches.

### How a round is paired

Published, deterministic and shown on the page, with the reason for every pairing:

1. Players still in are ordered by **points** (high first), then by the **initial
   order**. A player who left is not paired.
2. **Nobody meets the same opponent twice** (a pairing in a round that stands counts as
   met even if it was never played, as when a round was closed with neither side coming;
   a pairing taken off by a re-pair, below, does not), and **nobody has a second bye**.
3. With an odd number, the **bye goes to the lowest-ranked player without one**
   (the lowest points, then the last in the initial order), the first from the
   bottom for whom everybody else can still be paired. A bye counts as a win's
   points (or the event's value) and nothing else: no opponent, no difference.
4. The best-ranked player not yet paired is paired with the first opponent they
   have not met: the **lower half of their own score group** (the first of the
   group with the first of its lower half, the Dutch method), then the rest of the
   group, then the next group down, best first. A choice that leaves the others
   with nobody to meet is undone and the next is tried; a player taken from a lower
   group is a *float*, and the page says so.
5. The player who has been first-named fewer times is first-named in each pair
   (the *a* side, shown first), the better ranked where level.
6. If no pairing exists without breaking rule 2 (it can happen after players leave),
   the round is **not paired** and the page says why; nothing is ever paired
   against the rules. The organiser can take out whoever cannot be paired, or **end
   the event after the last round paired**.

A round is paired **as soon as every match of the one before is decided** (a result,
a walkover, a leaver's walkover), inside the change that decided the last one, and
never twice: results of one event go in one at a time (the event's row is locked), so
two completing a round at once pair the next once. Pairing never fails the result
that caused it: if it cannot be done (no legal pairing, or the round does not fit),
the round stays unpaired, the organiser sees why, and *Pair round n* tries again.
Players with an account are emailed their pairing (or their bye) as soon as it is made.

### Standings and tie-breaks

The table is a pure function of the recorded results (`swissStandings`): **Swiss
points**, then the event's **tie-breaks in order**, then the initial order, so
nothing is left to chance and a table rebuilt from the results is the same.

| Tie-break | Meaning |
| --------- | ------- |
| Buchholz | the sum of the Swiss points of the opponents actually played (a bye adds nothing) |
| Median Buchholz | Buchholz without the highest and the lowest opponent's points, for a player with three opponents or more (else Buchholz) |
| Wins, set difference, set ratio, point difference, point ratio, points scored, who beat whom | exactly as a table ranks by them ([results](#results)) |

The default is Buchholz, median Buchholz, then the template's own ranking keys without
the points (`defaultTiebreaks`). Table points are the template's (3-1-0 for goals, set
points for volleyball, and so on), a walkover counts at the rules' walkover score, a
drawn match (where the sport has them) is a point for each. Results of somebody out stand or
are void by the event's [rules for leavers](#somebody-leaving) (the stage is *groups*),
void results counting for nobody, opponents' Buchholz included.

### Results, closing a round, ending early

- Results are entered as for any match (staff, officials, players where the tournament
  allows it); each is a normal group-stage result with the same checks.
- **Closing a round** (a manager's, *Close round n* on the Swiss panel): when players did
  not come, each match still to play is given a **walkover to the side that came**
  (through `recordResult`, so the rules for walkovers decide the table) or marked **played
  by neither** (no points and no result; the two count as having met). Every undecided
  match must be answered; the next round is then paired.
- **Ending early** (a manager's): the event ends after the last round paired, matches
  still to play are played, and it finishes. It is also what happens by itself when fewer
  than two players are left.

### Somebody leaving

Taken out as withdrawn, retired or disqualified by the usual preview and confirmation
([somebody leaving](#somebody-leaving)): each match they have left is a walkover to the
other side, **later rounds skip them**, what they played stands or is void by the event's
rules, and the pairings already made stand. If the walkover decides the last match of a
round, the next is paired, and the preview says so. A bye already given to somebody who
then leaves stands.

### Corrections: keep the pairings, or pair again

A result changed **once a later round has been paired** is never made as a plain result: it
is a *correction*, reviewed first and confirmed with a reason, a manager's, as a group
result changed after a knockout has begun is
([corrections](#corrections-after-the-knockout-has-begun)). The review offers:

| | What it does | When |
| - | ------------ | ---- |
| **Keep the pairings** | The pairings made stay; only the standings change | Always |
| **Pair the next round again** | The pairings of every later round are taken off the draw (kept in the correction's record) and the next round is paired again from the corrected standings under the same rules, its players told | Only while **no match of a later round has a result** (a result, a walkover or a retirement; a bye is not one), and only if the new pairing fits the court time: otherwise it is refused, with why, and nothing changes |

A played match is never rewritten or deleted. A result changed while the next round is not
paired yet, or in the last round, is an ordinary result: the table is always what the recorded
results give. Each correction is kept in `tournament_corrections` and shown to the organiser
and, as "a correction was made", to the public.

### What people see, and the day

- **The public page** shows the table with the tie-breaks that rank it, and every round
  with its pairings, why each was made (the two's points, a float), results and byes, by the
  names the page shows (a declared minor by first name and initial; a round's notice to the other family names them so too).
- **Tournament day** works as for any group stage: the board, announcements, calls, rest,
  the live page and officials' links show Swiss fixtures labelled *Round n*; a round's
  fixtures appear as it is paired.
- **Ratings:** every decided two-sided match counts as in a group (a walkover moves nothing, a
  win by retirement half); a **bye is not a result and is not rated**; a correction replays
  ([ratings](#ratings-and-rankings)).

### What Swiss does not do

- No accelerated pairings, no other pairing method, and the colours of a sport with sides are
  only the first-named rule above.
- The tie-break order is set through the API (`rules.swiss.tiebreaks`), not a screen.
- Swiss for a performance event is not built; a Swiss division of a competition schedules
  each round into the time free when it is paired, so a later round may not fit if another
  division has taken the time meanwhile (it says so and the organiser decides).
- The pairing search is bounded: with very many players after very many withdrawals it
  could give up on a pairing that exists, and then reports the round as unpaired.

## Club ladders

A **ladder** (`src/lib/ladders.ts`; migration 0272;
[ADR 0033](../architecture/decisions/0033-swiss-tournaments-and-club-ladders.md)) keeps a
venue's players ranked 1 to n for a sport, season after season. A player challenges
somebody a few places above, they arrange the match between them, one reports the score and
the other confirms it, and the winner moves up by a published rule. Venues set it up from
the *Leagues* tab (*Club ladders*); players find ladders at `/ladders`.

### Who it is for

- A ladder is **for adults** or **for juniors**. An adult ladder takes the account holder,
  who ticks that they are 18 or over (declared, never verified), or somebody staff add at the
  counter on the player's word; it takes **no participant** (no child). A junior ladder takes
  **only participants a guardian enters**, who act for them: challenge, answer, report and are
  told for them, and whose name is shown short everywhere (first name and initial); a stranger's
  challenge never reaches a child, and no contact of a child is shown to anybody.
- Entrants are **players or pairs** (a pair named by the player who joins), through the same
  checks as a box league: the venue's rule on who it is for, and in a women's or men's ladder the
  player and a pair's partner as declared. Persistent teams are not ladder entrants (they play in
  [leagues of teams](#team-leagues)).
- New players join **at the bottom**; staff may add somebody at the counter. A player rejoining
  after leaving joins at the bottom.

### Challenging

A player may challenge a player ranked **within *k* places above** (*reach*), both on the ladder
and not frozen, neither in another open challenge (one at a time, either side), and not the
**same opponent within *d* days** of their last played or forfeited challenge together.
The ladder shows each player who they may challenge and, for the others, why not. All the
numbers are the ladder's settings, shown on its page and changed by a manager from now on:

| Setting | Default | Range |
| ------- | ------- | ----- |
| Challenge up to this many places above | 3 | 1 to 10 |
| Days the challenged has to answer | 3 | 1 to 14 |
| Days to play an accepted challenge | 14 | 3 to 60 |
| Days before the same two play again | 14 | 0 to 90 |
| Days idle before dropping (0: never) | 30 | 0 to 365 |
| Places dropped | 1 | 1 to 10 |
| Longest freeze, days | 60 | 1 to 180 |
| Declining a challenge | free | free, or a forfeit |

**A challenge's life:** *pending*, the challenged to answer within the days given: they **accept**
(optionally agreeing a day), **decline**, or **suggest a time**, which hands the answer to the
challenger, who accepts it or withdraws; a challenger who does not answer lets it lapse, with no
effect. **A challenged player who ignores a challenge forfeits** when the days are up: the scheduler
records a walkover for the challenger, once, however often it runs. *Accepted:* the two **arrange the
match privately** (the day suggested is shown; on an adult ladder each sees the other's number and
WhatsApp link for this challenge only, never on a junior ladder) and play it within the days given, or
it **lapses** with no effect on the ranks. **No court time is held for a challenge** (see
[court time and booking](#court-time-and-booking-for-a-challenge)). *Reported:* either side says who won and the score, their own
games first (checked by the ladder's scoring rules, `scoreRefusal`, and kept with the challenger's
first); the other side **confirms** it, or **says it is wrong** and a manager decides; a result nobody
answers in **3 days** stands. Only a **confirmed** result, a forfeit or a walkover moves ranks.
An answer names the version of the challenge it saw: one that changed since is refused (code
`LD_CHANGED`), so nobody answers a result they did not see. Everybody concerned is emailed in their
language at each step (a guardian, for a child, opening with whose place it is).

### Court time and booking for a challenge

**Creating, accepting, proposing a time, withdrawing, reporting, confirming or deciding a challenge
reserves no court time**: no claim, block, hold or booking is written by any ladder function
(`tests/ladder-court-time.test.ts` counts them across a whole challenge's life, and no ladder table has a
column that refers to one). A day and time suggested or agreed is a note. Another customer may book that
court at that time, and the challenger then meets the booking path's ordinary refusal. Nothing is held
open for an unresolved challenge, so nothing can be held indefinitely; the lapse rules above (accepted
but not played within *g* days) stand.

Once the two have agreed a time they **book through the venue's ordinary booking page** (a link on the
challenge, *Book a court*, goes to `/venue/:id?sport=…`), with every availability, pricing, payment and
eligibility check of any booking. Only a confirmed booking reserves the court. Either player may then
**add that booking's code to the challenge** (`attachBooking`, `{ action: "attach_booking", code }`; migration
0276) so both see *Court booked: Court 2, 2026-11-20 19:00* on it. The code is checked, and a failure is
a refusal and nothing else:

| Rule | Refusal |
| ---- | ------- |
| the challenge is accepted | `LD_BK_NOT_OPEN` |
| the booking is made through the account of one of the two players (a code that is nobody's of the two is answered as not found, whatever else is true of it, so a code cannot be probed) | `LD_BK_NOT_FOUND` |
| confirmed (not cancelled), dated today or later | `LD_BK_STATE` |
| at the ladder's venue; for the ladder's sport and not a class place | `LD_BK_VENUE`, `LD_BK_SPORT` |
| not on another challenge (a live attachment) | `LD_BK_TAKEN` |
| the challenge has no booking attached already | `LD_BK_HAVE` |

Attaching **changes nothing about the booking**: no hold, no price, no payment, no new booking path;
the booking's own row is locked while it is read, so a cancellation cannot slip in between. Either
player may take it off (`detach_booking`; the booking is untouched). If the booking is **cancelled**
(by any route: the customer, the venue, a hold let go) the attachment is dropped, once, and both
players are told that the challenge stands and a court is to be booked again; `ladderBookingCancelled`
runs where bookings are cancelled and the scheduler sweeps any that a path missed, so running it again
changes and tells nobody. A booking moved to another time shows its new time; nothing else follows.

### The rank rule

If the **challenger wins** and was ranked below the challenged, the challenger **takes the challenged's
rank** and everybody from there down to just above the challenger's old rank **moves down one**. If the
challenged wins, nothing changes. A forfeit by the challenged is a win for the challenger. A leaver
closes the gap. An idle player **drops** *p* places and the players passed move up one.

### Idle players, freezes

- **Inactivity:** a player whose last *activity* (joining, a played or forfeit-won challenge, a thaw, a
  drop) was the given number of days ago drops *p* places; the drop counts as activity, so the next is that
  many days later. Not while frozen or in an open challenge. Declining or ignoring is not activity.
- **Freezes** (a player's, or a manager's for them): until a day, at most the ladder's limit. A frozen
  place cannot be challenged or challenge and does not drop; its open challenges are cancelled with no
  effect and the other side told. The scheduler thaws it after its last day; it can be ended sooner.

### The ledger, corrections and managers' overrides

Every change to a rank is an **event** in an ordered ledger (`ladder_events`): a join, a carry into a
season, a leave, a result, a drop, a freeze or thaw, a manager's move or removal. The ranks are the **pure
replay** of the season's live events; the stored ranks (`ladder_ranks`) are a cache rewritten whole from
the replay after every change, under the ladder's lock, and never updated from themselves. **A correction
replaces the event in its place** (the old one voided with who and why, the new one in the same position),
so every rank after it is the replay of the corrected ledger. A manager, with a reason of at least three
characters that is kept and logged:

- **decides or corrects a challenge's result** (winner and score, or a walkover; a dispute, or a mistake
  found later), **strikes** it (it never counts) or **puts it back to be played**;
- **moves** a player to a rank, or **takes** a player off the ladder;
- **freezes or thaws** a place, changes the **settings**, marks the ladder **rated** (until its first
  result), **ends the season** or **closes** the ladder.

All of these are a manager's (`MANAGER_ONLY`); the front desk reads, and adds players at the counter.
Each is in the activity log.

### Seasons and the archive

Ending a season cancels open challenges (with no effect, the sides told), **archives the final order** with
the names as the ladder shows them, and starts the next season with everybody **carried over in that
order**. Earlier seasons are read from the ladder's page; their ledgers are never changed.

### Ratings

A ladder marked rated feeds the [ratings ledger](#ratings-and-rankings) as a fourth source: a confirmed
result is a played match, a forfeit or a walkover a walkover (it moves nothing); a result corrected or struck
voids its row and writes the new one; nothing else is rated. A rank is not a rating and a rating is not a
rank.

### Privacy

**Challenges are not public.** The public (`/ladders/[id]`, `GET /api/ladders/:id` signed out or in) is shown the
ranks, who is on the ladder (frozen places with the day they thaw) and the season's **confirmed results**
(`results`: the day it was decided, the winner, the other side and the score with the winner's games first, newest
first). It is never shown a challenge that is pending, accepted, reported, disputed, declined, cancelled, lapsed,
struck or decided as a walkover, who challenged whom while it was open, a proposed or agreed time, a dispute note, which
places are in a challenge, or a booking attached to a challenge; a result does not say which side challenged. The
`/ladders` list shows no count of challenges and the sitemap lists no ladder. A player sees their own challenges
(`mine`: those of their places and of the people they act for, with the other side's number on an adult ladder once
accepted), and a venue's managers and front desk see every challenge, dispute note and the ledger in the dashboard
(`ladderDetail` with `forStaff`); the public view is the default of `ladderDetail`, never a field removed afterwards.
A walkover moves the ranks like any result but is not listed as a public result, because it would say who declined or did
not turn up.

An adult ladder shows the names players gave; a junior ladder shows first name and initial, unless a guardian has
[authorised the full name](#names-of-minors-on-public-pages) for the season. A season's final order is stored short and never
keeps an authorised full name. The data
export lists the ladders a person joined; erasing an account takes the person off every ladder and replaces
their name in its places, without moving anybody else beyond the gap closing. Ages and guardianship are
declared, never verified, and no identity document is asked for.

### What ladders do not do

- No court time held for a challenge, and no tournament-style scheduling: players arrange it and book it through the ordinary booking page ([above](#court-time-and-booking-for-a-challenge)); a booking attached to a challenge is only shown on it.
- No persistent teams, no ladder across venues, and no empty restart of a season (the next season always
  carries the order over).
- A ladder's rank is the venue's own list; it is not shown on a player's profile and is not used to suggest
  games.

## Related capabilities

- **Court time** is held as ordinary blocks, so every booking path treats it
  as taken, and time given back is offered to the
  [waiting list](booking.md) like a cancellation.
- **Fees** are paid online to the venue's own account or marked paid at the
  counter, and fees owed back join the venue's refunds
  ([payments and credit](payments-and-credit.md)).
- **Women's, men's and mixed** events and leagues use the shared
  self-declared rule ([programmes](programmes.md#women-only-and-men-only)).
- **Players' data**: declared dates of birth, guardians' names, entries and
  league places are in the data export and go with the account (a
  participant's are in their own record, in their guardian's export, and go
  with that record)
  ([privacy](../architecture/privacy.md)).
- **Results** entered by officials or confirmed by players go through the
  same `recordResult` as staff's; box leagues score and rank by the same
  competition rules. A new sport is a template, never a branch on the sport
  (`src/lib/competition-templates.ts`, `src/lib/tournament-rules.ts`).

## Implementation and tests

| Part | Code | Tests |
| ---- | ---- | ----- |
| Tournaments, the draw, results, corrections, leaving | `src/lib/tournaments.ts`, `src/lib/brackets.ts` | `tests/tournaments.test.ts`, `tests/brackets.test.ts`, `tests/fixtures.test.ts` |
| Templates and rules | `src/lib/competition-templates.ts`, `src/lib/tournament-rules.ts` | `tests/competitions.test.ts` |
| Competitions with divisions, who may enter | `src/lib/competitions.ts` | `tests/divisions.test.ts`, `tests/components/tournament-entry.test.tsx` |
| Performance events | `src/lib/performance-math.ts` | `tests/competitions.test.ts` |
| Counted performances: bouldering tops and zones, climbing by height | `src/lib/counted-performances.ts`, `src/lib/public-names.ts`, `src/lib/tournaments.ts` (`recordPerformances`, `previewPerformances`), `src/components/admin/CountedGrid.tsx`, `db/migrations/0273_counted_performances.sql` | `tests/counted-performances.test.ts` |
| Names of minors on public pages: the one rule, a guardian's authorisation of the full name, the guardian's page | `src/lib/public-names.ts`, `src/lib/public-name-consents.ts`, `src/app/api/my/people/public-name/route.ts`, `src/components/PublicNames.tsx`, `db/migrations/0274_public_name_consents.sql` | `tests/public-names.test.ts` (PGlite and Postgres), `tests/components/public-names.test.tsx` |
| Results by players and officials | `src/lib/match-reports.ts` | `tests/match-reports.test.ts`, `tests/components/official-page.test.tsx` |
| Box leagues | `src/lib/leagues.ts`, `src/lib/boxes.ts` | `tests/leagues.test.ts`, `tests/boxes.test.ts`, `tests/league-results-race.test.ts` (also against Postgres) |
| Teams that persist: invitations, children through a guardian, what a captain and members may do, history, privacy | `src/lib/teams.ts`, `db/migrations/0269_teams_and_team_leagues.sql`, `src/app/teams`, `src/app/team-invitation` | `tests/teams.test.ts` (PGlite and Postgres), `tests/components/teams-ui.test.tsx` |
| Entering a tournament as a team, a roster checked per member | `src/lib/teams.ts` (`rosterRefusal`), `src/lib/tournaments.ts` (`enterLocked`), `src/components/TeamEntry.tsx` | `tests/teams.test.ts`, `tests/tournaments.test.ts` (the typed team as before) |
| Leagues of teams: setting up, entering, results, forfeits, moves, what the public sees | `src/lib/team-leagues.ts`, `src/app/team-leagues`, `src/components/admin/TeamLeaguesPanel.tsx` | `tests/team-leagues.test.ts` (PGlite and Postgres), `tests/components/teams-ui.test.tsx` |
| Forfeits are a manager's; a captain's or staff's forfeit request, its confirmation or decline, expiry, withdrawal and audit | `src/lib/team-forfeits.ts`, `src/lib/roles.ts`, `src/app/api/admin/team-leagues/[id]/fixtures/[fixtureId]/forfeit`, `.../forfeit-requests`, `src/app/api/admin/team-leagues/[id]/forfeit-requests`, `src/components/admin/TeamLeaguesPanel.tsx`, `src/app/team-leagues/[id]/page.tsx` | `tests/team-forfeit-requests.test.ts` (PGlite and Postgres) |
| The fixture generator: round robin, home and away, byes, match nights, blackouts, courts | `src/lib/fixtures.ts` | `tests/fixture-plan.test.ts` |
| Who enters: a guardian for a participant, staff at the counter, members only by the entrant's own membership | `src/lib/competition-entrants.ts`, `src/components/admin/CounterEntry.tsx` | `tests/competition-entrants.test.ts`, `tests/components/competition-entrants.test.tsx` |
| Staff screens | `src/components/admin/TournamentsTab.tsx`, `src/components/admin/LeaguesTab.tsx` | `tests/components/tournaments-tab.test.tsx` |
| Officials of a climbing event: event-scoped entry of counts, open and finalised rounds, correction requests and their review, audit, what a link cannot do | `src/lib/official-performances.ts`, `src/lib/match-reports.ts`, `src/app/api/officials/[token]/route.ts`, `src/app/api/admin/tournaments/[id]/correction-requests/[requestId]/route.ts`, `src/app/officials/[token]/page.tsx`, `src/components/admin/CountedGrid.tsx`, `src/components/admin/CorrectionRequests.tsx`, `db/migrations/0276_forfeit_requests_official_marks_ladder_bookings.sql` | `tests/official-climbing.test.ts` |
| Changing a tournament before its draw; each entry's own fee | `src/lib/tournaments.ts` (`changeTournament`), `src/components/admin/TournamentDetailsEditor.tsx` | `tests/tournament-changes.test.ts`, `tests/components/change-editors.test.tsx` |
| Tournament day: the next match announced, a court called, the wait, the live page | `src/lib/tournament-day.ts`, `src/app/api/admin/tournaments/[id]/day/route.ts`, `src/app/api/tournaments/[id]/live/route.ts`, `src/components/admin/TournamentDay.tsx`, `src/app/tournaments/[id]/live/page.tsx`, `db/migrations/0268_tournament_day.sql` | `tests/tournament-day.test.ts` (also against Postgres), `tests/components/tournament-day.test.tsx` |
| Consolation draws and double elimination: the structures, progression through a whole event, the grand-final reset, corrections along two routes, leavers in each bracket, placings, court time, names | `src/lib/brackets.ts`, `src/lib/tournaments.ts`, `src/lib/tournament-rules.ts`, `src/lib/tournament-day.ts`, `src/app/tournaments/[id]/page.tsx`, `src/components/admin/TournamentsTab.tsx`, `db/migrations/0271_consolation_and_double_elimination.sql` | `tests/brackets-structure.test.ts`, `tests/double-elimination.test.ts` and `tests/consolation.test.ts` (PGlite and Postgres) |
| The advanced feed-in consolation draw: the structure by size, the counts, the consequences shown and confirmed, the draw and its refusal when the time cannot hold it, progression through whole events, leavers, corrections and replay equality, places, ratings, tournament day, the setup screens | `src/lib/brackets.ts` (`feedInConsolation`, `feedInConsequences`, `feedInPreview`, `placings`), `src/lib/tournaments.ts` (`makeDraw`, `setRules`, `feedInPreview`), `src/lib/tournament-rules.ts` (`consolationMode`), `src/app/api/admin/tournaments/[id]/feed-in-preview/route.ts`, `src/components/admin/TournamentsTab.tsx` | `tests/feed-in-structure.test.ts`, `tests/feed-in-consolation.test.ts` (PGlite and Postgres), `tests/components/feed-in-ui.test.tsx` |
| Ratings from results: the rule, the ledger, replay, corrections, voids, walkovers, exclusions and restarts, rankings, seeding proposal, privacy | `src/lib/rating-math.ts`, `src/lib/ratings.ts`, `db/migrations/0270_ratings_from_results.sql`, `src/app/api/admin/ratings/route.ts`, `src/app/api/my/ratings/route.ts`, `src/app/api/venues/[id]/rankings/route.ts`, `src/app/ratings/page.tsx`, `src/app/venue/[id]/rankings/page.tsx`, `src/components/admin/RatingsPanel.tsx` | `tests/rating-math.test.ts`, `tests/ratings.test.ts` (PGlite and Postgres) |
| Rating policy: rankings published by choice (404 while off, on the page, API, MCP tool, venue link and sitemap), a venue's number of counted results before a player is ranked, the separate provisional section, which results count (the treatment table, run row by row), replay equality after amendments and policy changes, determinism, pool separation, the audit log and the ledger CSV | `src/lib/rating-eligibility.ts`, `src/lib/ratings.ts` (`rankingPolicy`, `setRankingPolicy`, `ledgerCsv`), `db/migrations/0275_ranking_policy.sql`, `src/app/venue/[id]/rankings/layout.tsx`, `src/components/admin/RatingsPanel.tsx` | `tests/ranking-policy.test.ts`, `tests/rating-eligibility.test.ts` (PGlite), `tests/components/ranking-policy-ui.test.tsx`, `tests/mcp.test.ts` (the tool) |
| Swiss events: the pairing rules, standings and tie-breaks, the draw and recorded seed, rounds, byes, leavers, closing a round, corrections (keep the pairings or pair again), replay equality, ratings, the day | `src/lib/swiss.ts`, `src/lib/tournaments.ts` (hooks), `src/lib/tournament-rules.ts` (`rules.swiss`), `db/migrations/0272_swiss_and_ladders.sql`, `src/components/SwissStandings.tsx`, `src/components/admin/SwissPanel.tsx` | `tests/swiss-math.test.ts`, `tests/swiss.test.ts` (PGlite and Postgres), `tests/components/swiss-panel.test.tsx`, `tests/ladder-routes.test.ts` (the rounds' route) |
| Club ladders: the replay and rank rule, who may challenge, the life of a challenge, the scheduler's forfeits, lapses, thaws and drops, freezes, overrides and corrections, seasons, minors, ratings, privacy | `src/lib/ladders.ts`, `src/lib/ladder-access.ts`, `src/lib/ladders-constants.ts`, `src/app/api/ladders`, `src/app/api/admin/ladders`, `src/app/ladders`, `src/components/admin/LaddersPanel.tsx`, `src/lib/ratings.ts` (the `ladder` source) | `tests/ladder-math.test.ts`, `tests/ladders.test.ts` (PGlite and Postgres), `tests/ladder-routes.test.ts`, `tests/ladder-public.test.ts` (what the public is and is not shown) |
| A ladder challenge holds no court time; the ordinary booking it may carry (attach, drop on cancellation) | `src/lib/ladders.ts` (`attachBooking`, `detachBooking`, `ladderBookingCancelled`), `src/lib/store.ts` (the hook), `src/app/api/ladders/[id]/challenges/[challengeId]/route.ts`, `src/app/ladders/[id]/page.tsx`, `db/migrations/0276_forfeit_requests_official_marks_ladder_bookings.sql` | `tests/ladder-court-time.test.ts` |
| Visual acceptance | | `tests/uat/tournament.uat.ts`, `tests/uat/competition.uat.ts` |

Which parts are verified, and how, is in
[feature status](../product/feature-status.md#tournaments-and-leagues).

## Open decisions and known issues

- Known issues (players moved by a refill not messaged, corrections that
  cannot replay) are in
  [known limitations](../roadmap/known-limitations.md#booking-and-availability-b).
- More ranking rules and an enforced level are roadmap rows, not commitments
  ([roadmap](../roadmap/roadmap.md)). Ratings and rankings across events are
  built ([below](#ratings-and-rankings)); a level that is enforced (a rating
  band checked at entry) is not.
- Box-league results are checked and ranked by the same rules as a
  tournament's (`scoreRefusal`, `standings`), and recorded by their own
  functions in `src/lib/leagues.ts` (`reportResult`, `confirmResult`,
  `disputeResult`, `decideResult`), not by `recordResult`, which carries a
  tournament's progression, corrections and issues that have no league
  counterpart. This is the intended design (the owner, 27 October 2026), and
  `AGENTS.md` says so.
