# Classes, coaching, tournaments and leagues

Authoritative for instructor-led classes and terms, one-to-one coaching, tournaments, box leagues, open games and women-only or men-only sessions.

## Classes

A class is an instructor-led session held on a shared facility. While it runs
the resource is **reserved** (a claim on the court for the session's exact
minutes): that time disappears from general booking and
from cross-venue search, and a walk-in attempt is told to enrol instead. A class
cannot be laid over existing bookings, or over another class.

An enrolment is deliberately just a booking with a `class_id`, so it inherits
everything bookings already do — a code, a QR check-in, payment tracking,
cancellation and no-shows — instead of growing a parallel system. The only
override is price: an enrolment is charged the class's per-person rate rather
than the court's hourly one.

Classes can repeat weekly for a term (up to 12 weeks) under a shared `CL-`
series code. Cancelling a class releases every enrolment and returns the hours
to general booking. Staff see a roster per class with each attendee's check-in
state.


### Terms

A class scheduled weekly can be joined for every session left at once, from
the classes page: *Every week to the end: 8 sessions, RM216*
(`enrolInTerm` in `src/lib/store.ts`). Each session is its own enrolment, as
if joined one by one, sharing a series code so they are confirmed in one
message and paid in one bill. A session that is full, or that the customer
is already in, is skipped and named. When scheduling a weekly class, the
venue can take a share off each session (up to 50%) for joining the whole
term. A class in the diary can be joined however far ahead it is: the
booking window is for courts, while the venue's house rules on how far ahead
people may book still apply.

## One-to-one coaching

A venue lists its coaches under *Classes → Coaches* (`lib/coaching.ts`): a name,
a line about them, the sports they coach, their fee for an hour, and the days
and hours they take lessons. The venue page shows them under *🎓 Coaching*.
*Book a lesson* (`/venue/:id/coach/:coachId`) offers the times that day when
the coach is working, not already taken, and a court of the sport is free. The
customer picks a length, gives their name and number, and pays the way any
booking is paid.

- **A lesson is a booking.** It goes through `POST /api/bookings` with
  `coachId`, on any free court of the sport, so the house rules, blocked
  numbers, strikes, holds, credit, receipts, cancelling, refunds and reports
  all apply. The coach's fee is added to its price (`bookings.coach_fee`) and
  is its own line on the receipt, *Coaching with Ana Lim*. A promo code comes
  off the court, not the coach's fee. The sales journal files it under
  *Coaching*.
- **A coach is in one place at a time.** Each lesson claims the coach for
  its exact minutes (`coach_claims`, under a database constraint that
  refuses two overlapping claims for one coach). A second lesson overlapping
  it, on any court, is refused (*Ana Lim has just been booked*), and the
  court it had picked is let go as if never booked. Cancelling a lesson
  releases the coach. The fee is the coach's hourly fee for the minutes
  booked; lesson starts and lengths follow the court's
  [booking rules](booking.md#booking-rules-starts-lengths-buffers).
- **Weekly lessons**, for a signed-in customer, as with a weekly court:
  *Repeat* on the lesson form books the same time for up to 8 weeks
  (`MAX_RECUR_WEEKS`), and a week the coach or every court is already taken
  is skipped and listed (`skipConflicts`). Nobody can move a lesson to
  another time, staff included (`RESCHEDULE_COACH`): it is cancelled and
  booked again. Staff can move it to another court at the same time.
- Staff see *🎓 Lesson with Ana Lim* on the booking, and the staff calendar
  feed names the coach. *Stop* retires a coach; lessons already booked stand.

### Lesson packs

A pass sold for one coach (*Credit & passes → Multi-visit passes → For:
Lessons with Ana Lim*, `passes.coach_id`, migration 0061). It spends as any
[pass](pricing.md#multi-visit-passes) does (an entry an hour unless set
otherwise, or court time to the minute) on lessons with that coach, court and
coach fee together, and it pays nothing else. A court pass no longer pays a lesson, since the coach's fee
would go unpaid; the customer is told to use a lesson pack or pay another way.
The pack's receipt is filed under *Coaching* in the sales journal.

### A coach's own schedule (no account needed)

On each coach under *Coaches* (`lib/coach-schedule.ts`):

- **Email for lesson alerts.** The coach is emailed when a lesson is booked
  with them and when one is cancelled, once each (`notifyCoaches`, every
  scheduler tick, dedupe keys `coach-new:<id>` and `coach-cancel:<id>`).
- **Schedule link.** *Make a schedule link* gives the coach a private page,
  `/coach/<token>`, with their lessons for the next 30 days, each student's
  name and number (to call), and whether it is paid, plus a calendar feed of
  the same, `/api/coach-calendar/<token>.ics`, for their phone. The page says
  it is private and not to be shared. *Withdraw link* stops it at once; a new
  link replaces the old. Neither is listed for search engines.

### What coaches are owed

*Reports* shows *Coaches: lessons and fees* for the period: per coach, lessons
that went ahead and their hours, the coach's fees on those paid and on those
not yet paid, and no-shows apart (whether a coach is paid for those is the
venue's call). *Every lesson (CSV)* has one row per lesson for the venue's
books and the coach's records (`/api/admin/coach-payouts`, managers only).
Lessons cancelled late are listed apart, with the coach's fee times the share
the venue kept, for the venue to decide whether the coach is paid for them.
The report says what is owed; paying the coach happens outside MySenam.


### A coach's own week and time off

At their private schedule link (`/coach/<token>`), a coach can also set the
hours they take lessons each week (several stretches a day, to the minute)
and add time off, a day or a stretch of days up to a year ahead
(`setCoachHours`, `addTimeOff` in `src/lib/coaching.ts`). Nobody can book a
lesson with them in time off; lessons already booked then stand, and the
coach is told how many, to ask the venue to move them. Staff see the time
off beside the coach. The link is the coach's key: the venue replaces or
withdraws it as before, and a withdrawn link changes nothing.

## Tournaments

Venues run them from the dashboard's *Tournaments* tab; players find them at
`/tournaments`.

- **Setting one up**: sport, singles or doubles, level, entry fee, most
  entries, days (up to two weeks), daily hours to the minute, how long each
  match is given on court (60 minutes unless set), and which courts. Those
  hours are **held at once** — ordinary blocks with the tournament's name, so
  every booking path already treats them as taken. It will not hold over a
  booking already made, or a court out of service, and says which.
- **Entries**: players enter with their account (naming a partner for
  doubles) and pay the fee online to the venue, or at its counter, where
  staff tick it off. Past the limit they go on a waiting list, and move up,
  and are told, when somebody withdraws.
- **The draw**: a straight knockout, or round-robin groups (3 to 6) whose top
  one or two go through to a knockout. Seeds staff set are kept apart and get
  the byes; everybody else is drawn by lot. Each group's runner-up is put in
  the other half of the knockout from its winner. Every match gets a court and
  a time within those held, one match length each, with nobody playing twice at once and no round
  before the one feeding it — or the draw says how many matches did not fit
  and changes nothing. Everybody is emailed their first match.
- **Results**: staff enter the score as sets ("21-15, 18-21, 21-10") and who
  won — a score that says the other side won is refused — or a walkover (a
  forfeited match), or a **retirement**: the other side stopped part-way,
  the score is what was played, and it counts as a win with no sets for the
  table. Staff can also say the retired player is out of the event, which
  takes them out as below. Winners move on by themselves; the last group
  match fills the knockout from the tables (wins, then sets, then points,
  then who beat whom); the final finishes it. A knockout result can be put
  right until the match it fed has been played.
- **A group result put right after the knockout is filled** fills it again
  from the tables as they now stand, as long as no knockout match has been
  played, given as a walkover or retired. Once one has, nothing changes
  silently: a result that would change who is in the knockout, or a knockout
  result whose next match has been played, is refused and offered to a
  manager as a **correction**:
  1. *Review*: MySenam works out, without changing anything, what each way
     of making it would change, fixture by fixture ("Semi-final 2: now A v C
     (was A v B)"), and whether it can go into the knockout safely.
  2. *Choose*: **put into the knockout** — possible only when every
     knockout match whose players change is still to play and still has its
     court; anything else (a match already played, a bye whose court was let
     go) is listed as what blocks it — or **the group table only** (for a
     knockout match, **its record only**), which corrects the result and
     leaves the knockout, and who went on, as played.
  3. *Confirm with a reason* (at least a few words). It is made only against
     the tournament as it was reviewed: if anything changed since, it is
     refused and reviewed again.

  Each correction is kept in `tournament_corrections` with its reason, who
  made it, what it changed and the matches as they were before, and in the
  staff activity log; the public page says that a correction was made, not
  why. A knockout result already played is never rewritten by a correction
  of an earlier round; where that is not good enough (the wrong players
  played a semi-final), the organiser arranges a replay by hand and records
  its result. Front desk staff enter results but cannot make a correction.
  Every result, every change with the result it replaced, and every refill
  of the knockout with its lines before and after, is in the activity log; a
  result and everything that follows from it are one change.
- **Court time goes back as soon as it is not needed.** Until the draw, every
  hour is held, since nobody knows which will be used. Once it is made, each
  court keeps only the hours from its first match still to play that day to
  its last — the hours between stay held, so a match that runs over does not
  run into a booking — and a court with nothing to play that day is given
  back whole. It is worked out again after every result and walkover, so a
  court is freed the moment its last match is in, and the rest of the final
  day when the final is. Hours already gone stay on the schedule as a record.
  Anybody on the waiting list for that court and day is offered what comes
  free, as with a cancellation.
- **Somebody leaving**: staff take an entrant out as **withdrawn**,
  **retired** (injured part-way) or **disqualified** (a manager only), with
  a note; players withdraw themselves only before the draw. Before it is
  done, staff see what it would change, fixture by fixture and table by
  table, and nothing changes until they confirm. When it happens and why are
  kept on the entry (`out_reason`, `out_stage`, `out_at`, `out_note`) and in
  the activity log, and the draw and the public page show it beside their
  name. Whatever the reason:
  - before the draw, the place goes to the waiting list;
  - after it, each group match they had left is a walkover to the other
    side, and a knockout match against them is a walkover as soon as the
    other side is known (at once if it is, otherwise when that match's
    feeder is decided); a line nobody is left to fill is a bye for whoever
    is on the other side, and a match with nobody left on either side sends
    nobody through;
  - they never go through from a group: the place goes to the next eligible
    entrant in the table. If the groups are over and no knockout match has
    been played, the knockout is filled again without them; once one has,
    the knockout stands and changing it is a correction (above);
  - knockout results they already played stand; a finished tournament's
    results are not changed by taking somebody out (it is refused).

  **The tournament's rules** decide the rest, set when it is created and
  changeable until the draw (`src/lib/tournament-rules.ts`):

  | Rule | Choices | Default |
  | ---- | ------- | ------- |
  | Group results already played by somebody who withdrew or retired | stand, or void | stand |
  | Group results already played by somebody disqualified | stand, or void | void |
  | Fee paid online owed back to somebody who leaves before the draw | yes or no | yes |

  Results that *stand* stay in the table as played: the entrant keeps the
  place those results give them, flagged as out, rather than being put
  last, and everybody else's wins against them count. Results that are
  *void* are taken out of the table for everybody, as if those matches had
  not been played, and the entrant is listed after the rest, unranked.
  Nothing is owed back after the draw.
  **Calling it off** gives the courts back (offering them to the waiting
  list), tells every entrant, and owes back every fee paid online.
- The public page shows entries, then the groups, the bracket and every
  match's court and time, refreshing while it is on.

The draw's arithmetic — seeding, byes, round-robins, tables, fitting matches
into court time — is in `src/lib/brackets.ts`, apart from the database, and
tested on its own.

**What tournaments do not do** (the [roadmap](../roadmap/roadmap.md) has
what is planned):

- Only two formats: a knockout, or groups then a knockout. No double
  elimination, Swiss, plain round robin or consolation draw.
- The rules for somebody leaving are per tournament; there are no sport
  templates (a scoring system, a forfeit score, tie-breaks) to start from,
  and the table's tie-breaks are fixed.
- One event per tournament: one sport, category, level and format. No
  divisions in one tournament; run one tournament per event.
- Singles or doubles pairs only, and a doubles partner is a name, not an
  account. No teams.
- The level is shown, not enforced; there is no age limit.
- No closing date: entries close when staff close them or make the draw.
- Seeds are set by staff; there is no seeding by rating or ranking, and no
  ranking across tournaments.
- Matches are scheduled automatically; one cannot be moved to another court
  or time by hand.
- No check-in of players on the day. Only staff enter results.
- Emails go out on entering, coming off the waiting list, the draw and a
  call-off; not on results, the next match, a walkover, a refilled
  knockout or the finish. They are queued in the
  [outbox](../integrations/messaging.md), so one that fails is retried.

## Box leagues

Venues run them from the dashboard's *Leagues* tab; players find them at
`/leagues`. A league runs season after season, four weeks each by default
(two to eight), rather than as fixed weekly fixtures nobody can keep.

- **Setting one up**: sport, singles or doubles pairs, level, box size (3 to
  6, default 4), one or two up and down, season length, a fee per season, and
  when the first season starts. Nothing is held: players book courts like
  anybody else.
- **Joining**: with an account, at any time. A player joining mid-season goes
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
- **Results**: either player reports the score, their own games first, and
  who won; the other confirms it, or says it is wrong and why — staff are
  emailed and decide it. A report nobody answers stands after three days.
  Staff can also enter any result, give a walkover, strike a match, or put it
  back to be played. Tables use the tournament rules: wins, then sets, then
  points, then who beat whom.
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
partner is a name, and only the player who joins is held to a women-only or
men-only rule; there is no ranking across seasons beyond the box a player
carries into the next; players are not emailed when staff decide a disputed
result or give a walkover.

The box arithmetic — sizes, who moves, the order for next season — is in
`src/lib/boxes.ts`, apart from the database, and tested on its own.

## Open games: recruiting players

A player who has booked a court can open it to others at `/games` (*Games* in
the menu): how many players they want, at what level, and what each pays
towards the court — split evenly unless they say otherwise. Others find open
games by sport, day, area, level, who can join, or *Near me* (the next 14 days
by default; full games are not listed), and ask to join; the host accepts or
declines from the same page, or lets anybody straight in. The `/play` page
gathers games, tournaments and leagues. Everything needs an account.

- **Money goes to the venue.** A player who joins pays their share online to
  the venue's own Billplz account, towards the host's booking; staff see
  "RM12 due" instead of the full price, and the host paying online pays only
  the rest. Shares that cover the court mark it paid. Where the venue does not
  take payment online, shares are paid at the counter. The platform never
  holds anybody's money.
- **Owed back when the game does not happen to them**: a player leaving or
  being removed, or the booking being cancelled by anyone, puts their paid
  share on the venue's list of refunds to make, like any online payment for
  something that did not happen. A share that arrives after the court was paid
  for in full, or after they left, is owed back at once. The host owes a
  handed-back share again; one who had already paid the rest online owes just
  that share, and what they paid keeps its own receipt
  ([business rules](../product/business-rules.md#money)).
- **Privacy.** Players see each other's first name and level, never a phone
  number or email. Levels are self-rated per sport: beginner, intermediate,
  advanced or competitive.
- **No-shows.** After the game, the host can mark a player who did not come.
  Three in 90 days, and that player cannot join games until they age out.
- **The host's tools**: accept, decline, remove a player (who is emailed and
  owed back), close the game to new requests, and mark no-shows. There is no
  "cancel the game" of its own: cancelling the booking calls the game off.
  A booking that has had a game cannot be moved to another time by anyone
  (`RESCHEDULE_GAME`); staff can move it to another court.
- Everyone is emailed when it matters: the host when somebody asks, joins or
  leaves; the player when accepted, declined, removed, or the game is off.
  These go straight out by email, not through the message queue, and there
  are no reminders before a game.
- Closing an account takes the player out of games to come, and calls off
  games they were hosting; the personal data export includes games and levels.

**What is recruitment, and what is not.** Open games are **player
recruitment**: a host advertises places and others ask to join. Customers can
**discover games** by filtering the list. There is **no player discovery**
(searching for people rather than games), **no matchmaking** (the system never
suggests players or games from levels, availability or history; saved levels
only filter the list), no invite-only or private games, no inviting a named
player, no waiting list for a full game, no messaging between host and
players, no recurring games (one game per booking), and no team formation.
These are proposals in the [roadmap](../roadmap/roadmap.md).

## Women-only and men-only

Open games, leagues and classes can be for anyone (the default), women only
or men only; tournaments have badminton's categories — open, women's, men's,
and mixed doubles. Women-only matters most: ladies' nights, muslimah
sessions, and women who would not otherwise join strangers. Men-only exists
too, for contact sports and those who keep apart, so the rule reads the same
both ways.

- **What a player says.** *Woman*, *man* or *prefer not to say*, asked the
  first time it matters — never at sign-up — on *Women's and men's games*,
  and then straight back to what asked. It can be changed on the account
  page, is in the data export, and goes with the account. Nobody else sees it:
  a game shows only its own rule. *Prefer not to say* joins everything open
  to anyone.
- **Open games.** The host chooses *Who can join*. A women-only game must be
  opened by a woman (and a men-only game by a man), so the label cannot be
  used to draw people in. Joining checks the player. *Games* has *Women only*
  and *Men only* chips, and each such game carries a badge.
- **Tournaments.** A women's or men's event takes entrants of that gender; in
  doubles the partner is the same. Mixed doubles is doubles only, and the
  entrant says whether their partner is a woman or a man — it must be one of
  each.
- **Leagues** take the same choice as games.
- **Classes.** A signed-in customer is checked by their account. A guest
  enrolling without one ticks "I am a woman: this class is for women only" —
  the same self-declaration an account makes. The waiting list asks the same.
- **It is self-declared**, like a player's level: nothing here can prove it.
  A host can remove a player, and venue staff see who enrolled, and that is
  the backstop.
