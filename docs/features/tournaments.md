# Tournaments and leagues

Authoritative for tournaments (one event, or several divisions of a
competition), the competition rules they are scored by, and box leagues.
Status: [feature status](../product/feature-status.md#tournaments-and-leagues).
Design: [ADR 0012](../architecture/decisions/0012-competition-rules-and-corrections.md)
(rules and corrections) and [ADR 0013](../architecture/decisions/0013-competition-framework.md)
(one engine configured by data).

## Scope and roles

- **In scope:** setting up a tournament or a competition with divisions, who
  may enter, entries and fees, the draw and schedule, results by staff,
  officials or players, corrections and progression issues, people leaving,
  the court time held; and box leagues, season after season.
- **Not here:** booking courts ([booking](booking.md)); paying fees online
  ([payments and credit](payments-and-credit.md)); women's, men's and mixed
  events ([programmes](programmes.md#women-only-and-men-only)); persistent
  teams and matchmaking ([open games and matchmaking](matchmaking.md)).
- **Who does what:** a venue's managers set up, correct, disqualify and
  resolve; front-desk staff enter results, check entrants in, and enter
  players at the counter; an official enters results through a link;
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
  | Your own | anything else | The general rules (as every tournament had before templates) |

- **Format:** a straight knockout; round-robin groups (3 to 6) whose top one
  or two go through to a knockout; a **round robin** of everybody (up to 16),
  whose table is the result; or a **performance event**: heats, then a final.
- **Who enters:** singles, doubles (a partner named), or **teams**: a team
  name and a roster of names, within the template's sizes (a futsal roster is
  5 to 14). The one entering is the captain. The public sees the team's name;
  the roster only its staff and the captain.
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
  a waiting list, and move up, and are told, when somebody withdraws. In a
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
  below those already entered;
- the **entry fee for new entries**. Each entry keeps the fee it was made at
  (`tournament_entries.fee`, migration 0238; entries made before took their
  tournament's fee then): what it owes and pays online
  (`startEntryPayment`), what the counter's receipt says when it is marked
  paid, and what players see to pay. Nothing already entered, paid or not,
  is repriced.

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
   rounds, the final (the knockout's last round and its third-place match),
   heats;
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
  back.
- **Eligibility checked:** for an event with an age range, staff can record
  that they saw proof of age at the venue (*age checked*): who checked and
  when, never the document or its number.

### The draw and the schedule

Seeds staff set are kept apart and get the byes; everybody else is drawn by
lot. Each group's runner-up is put in the other half of the knockout from
its winner. A performance event's heats are seeded by entry mark: the best
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
    the organiser gives, and when the tournament ends.
  - **Revocation.** Staff withdraw a link at any time, and it stops at once.
  - **Strength.** The link carries 192 random bits; only their SHA-256 is
    kept, so it is shown once. Its page is rate-limited.
  - **What it shows.** Entrants' names and matches, as the public page does.
  - **Why a link.** Officials are often volunteers without an account, and
    their one-tournament, results-only access does not justify one. A venue
    that wants named accounts can make them staff with the front-desk role.

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
  yet, and is refused if it would change who swam a final that has. The
  overall placings are the final's order, then everybody else by their heats.

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
  is emailed when they play. Nothing after the replays is touched; if a
  replay changes who goes on again, that is a correction of its own.
- Replaying is refused where it cannot be safe — the right competitor has
  left, or is already elsewhere in the knockout — and the organiser lets the
  results stand or arranges it by hand.

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

### What tournaments do not do

The [roadmap](../roadmap/roadmap.md) has what is planned or proposed.

- Formats beyond the four: no double elimination, Swiss, ladders or
  consolation draws; a performance event has one final, with no semi-finals
  or rounds of heats.
- A tournament is one event: one sport, category, level and format. Several
  events sharing courts are the divisions of a competition (above).
- The level is shown, not enforced. Ages, a guardian's agreement and a
  team's roster are what the entrant declares; a doubles partner and a
  roster are names, not accounts.
- Rules a template cannot express: counts of tops and zones (bouldering).
- Seeds are set by staff, or by entry mark in a performance event; there is
  no seeding by rating or ranking, and no ranking across tournaments.
- A fixture is moved one at a time, not a whole round. Check-in is a mark:
  it changes nothing in the draw by itself.
- Emails go out on entering, coming off the waiting list, the draw, a moved
  fixture, a replay, a call-off, a knockout filled again (to those moved in
  or out, not to somebody who left), a report waiting for its answer, and to
  the venue's staff on a disputed report; not on results, the next match, a
  walkover or the finish. They are queued in the [outbox](../integrations/messaging.md),
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
  tournament's is. A player joining mid-season goes
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
only (no team leagues, no fixed fixture dates: players arrange their matches
and book courts themselves); the level is shown, not enforced; a doubles
partner is a name, whose gender is declared, not checked; there is no
ranking across seasons beyond the box a player carries into the next; and
somebody added at the counter is not emailed (they have no account).

The box arithmetic — sizes, who moves, the order for next season — is in
`src/lib/boxes.ts`, apart from the database, and tested on its own.

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
| Results by players and officials | `src/lib/match-reports.ts` | `tests/match-reports.test.ts`, `tests/components/official-page.test.tsx` |
| Box leagues | `src/lib/leagues.ts`, `src/lib/boxes.ts` | `tests/leagues.test.ts`, `tests/boxes.test.ts`, `tests/league-results-race.test.ts` (also against Postgres) |
| Who enters: a guardian for a participant, staff at the counter, members only by the entrant's own membership | `src/lib/competition-entrants.ts`, `src/components/admin/CounterEntry.tsx` | `tests/competition-entrants.test.ts`, `tests/components/competition-entrants.test.tsx` |
| Staff screens | `src/components/admin/TournamentsTab.tsx`, `src/components/admin/LeaguesTab.tsx` | `tests/components/tournaments-tab.test.tsx` |
| Changing a tournament before its draw; each entry's own fee | `src/lib/tournaments.ts` (`changeTournament`), `src/components/admin/TournamentDetailsEditor.tsx` | `tests/tournament-changes.test.ts`, `tests/components/change-editors.test.tsx` |
| Visual acceptance | | `tests/uat/tournament.uat.ts`, `tests/uat/competition.uat.ts` |

Which parts are verified, and how, is in
[feature status](../product/feature-status.md#tournaments-and-leagues).

## Open decisions and known issues

- Known issues (players moved by a refill not messaged, corrections that
  cannot replay) are in
  [known limitations](../roadmap/known-limitations.md#booking-and-availability-b).
- More formats, ranking rules, ratings and an enforced level, and tournament
  day announcements, are roadmap rows, not commitments
  ([roadmap](../roadmap/roadmap.md)).
- Box-league results are checked and ranked by the same rules as a
  tournament's (`scoreRefusal`, `standings`), and recorded by their own
  functions in `src/lib/leagues.ts` (`reportResult`, `confirmResult`,
  `disputeResult`, `decideResult`), not by `recordResult`, which carries a
  tournament's progression, corrections and issues that have no league
  counterpart. This is the intended design (the owner, 27 October 2026), and
  `AGENTS.md` says so.
