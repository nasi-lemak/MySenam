# Open games and matchmaking

Authoritative for open games (players recruiting others to a court one of
them has booked), suggested games and players, invitations and private games,
waiting lists in a game, weekly games, community groups, emails of suggested
games, and blocking and reporting players.
Status: [feature status](../product/feature-status.md#open-games-and-matchmaking).
Design: [ADR 0016](../architecture/decisions/0016-matchmaking-on-open-games.md),
and for moving a game, [ADR 0018](../architecture/decisions/0018-moving-open-games-by-consent.md).

## Scope and roles

- **In scope:** everything a player does to find others to play with, on a
  court somebody has already booked.
- **Not here:** booking the court ([booking](booking.md)); paying a share
  ([payments and credit](payments-and-credit.md)); tournament entries and
  teams, and box leagues ([tournaments and leagues](tournaments.md));
  women-only and men-only games, which use the shared rule
  ([programmes](programmes.md#women-only-and-men-only)).
- **Who does what:** the **host** is the player whose booking it is; other
  **players** need an account to join, be invited or be suggested; the
  venue's **staff** see shares due on the booking and can move it to another
  court; the **platform owner** receives reports of players.

## Hosting and joining

A player who has booked a court can open it to others at `/games` (*Games* in
the menu): how many players they want (up to ten, or as many as the venue
lets one booking on that court take, less the host: `mostSpots` in
`src/lib/court-activities.ts`), at what level, casual or competitive,
what each pays towards the court (split evenly unless they say otherwise),
whether a full game keeps a waiting list, whether it is adults only, and
whether it is public or private. Others find public games by sport, day,
area, level, who can join, or *Near me* (the next 14 days by default; a full
game is listed only if it keeps a waiting list), and ask to join; the host
accepts or declines from the same page, or lets anybody straight in. The
`/play` page gathers games, tournaments and leagues. Everything needs an
account. Joining a game never books a court: the game is the host's booking
and only that (`src/lib/games.ts`).

- **Money goes to the venue.** A player who joins pays their share online to
  the venue's own Billplz account, towards the host's booking; staff see
  "RM12 due" instead of the full price, and the host paying online pays only
  the rest. Shares that cover the court mark it paid. Where the venue does not
  take payment online, shares are paid at the counter. The platform never
  holds anybody's money, nothing is charged because players match, and
  nothing moves between players.
- **Owed back when the game does not happen to them**: a player leaving or
  being removed, the host calling the game off, or the booking being
  cancelled by anyone, puts their paid share on the venue's list of refunds to
  make, like any online payment for something that did not happen. A share
  that arrives after the court was paid for in full, or after they left, is
  owed back at once. The host owes a handed-back share again; one who had
  already paid the rest online owes just that share, and what they paid keeps
  its own receipt ([business rules](../product/business-rules.md#money)).
- **No-shows.** After the game, the host can mark a player who did not come.
  Three in 90 days, and that player cannot join games until they age out.
- **The host's tools**: accept, decline, remove a player (who is emailed and
  owed back), invite players, share a link, close the game to new requests,
  call it off while keeping the court, and mark no-shows. Moving the game to
  another time is [below](#moving-a-game-to-another-time); staff can also
  move its booking to another court.
- Everyone is emailed through the message queue when it matters: the host
  when somebody asks, joins or leaves; the player when accepted, declined,
  removed, invited, offered a freed place, or the game is off.
- **The day before**, each player in a game is emailed a reminder: where and
  when, whether their share is paid, and to leave the game if they cannot
  come, so the place goes to somebody else (`remindPlayers`). The host has the
  booking's own reminder. Nobody who joined within the day before is
  reminded, nor anybody in a game called off; a game that moves is reminded
  of again at its new time, once per player.
- Closing an account takes the player out of games to come (a place freed
  goes to the next in line), calls off games they were hosting, and deletes
  the groups they organised; the
  personal data export includes games, levels, the playing profile, blocks,
  reports they made and groups.

## Moving a game to another time

A game is its host's booking, so moving the game is moving the booking, by
the same rules on what is free, how long it may be, what it costs and who may
go past the court's rules ([booking](booking.md#changing-the-date-or-time)).
Where it goes depends on who is in it (`src/lib/game-moves.ts`):

| The game | Moving its booking |
| -------- | ------------------ |
| Called off | Moves as any booking does. The game's record keeps where and when it was (`open_games.was_*`), not where the booking went |
| Nobody in it yet | Moves with its booking, by its host from *Change the time* under *My games* (the customer's rules) or by staff. Whoever asked, was invited, is waiting or holds a place is emailed the new time; an invitation or held place lasts no later than the new start |
| Players in it | Never moved behind their backs: proposed by its host, or changed by a venue manager with a reason (below). Changing it as a plain booking, from *My booking* or the staff screen without the game's own flow, is refused (`RESCHEDULE_GAME`) |
| Begun or over | Its time stays as it was played (`RESCHEDULE_GAME_STARTED`); a finished booking cannot be moved at all |

**Before anything changes**, the host (and staff) see what a move would do:
the old and new time and court, what the court time's price changes by,
who is in the game, how many who asked, were invited or are waiting would
hear, how many players have another game or booking of theirs then (how
many, never who or what), the shares paid online that would be owed back to
a player who leaves, and what happens next. Nothing is held or changed by
looking.

**A host's proposal.** With players in the game, the host proposes the new
time. It is held on the court for the game (a claim of its own, as a
waiting-list offer is held), while the booking keeps its own time; where the
two overlap on floor the booking already holds (the same court, a pitch over
it or a court under it), the booking's own time covers that part there, and
the rest of the new court's floor is held for all of it. Each
player is emailed and answers under *My games*: *Keep my place*, or *Leave
the game*, which owes back any share they paid online, as leaving always
does. When the last player has answered, the booking moves onto the time
held, in one transaction, and everybody is told. Silence is not a yes: a
proposal not every player has answered runs out, the hold goes, and the game
stays where it was. It holds for a day at most, never past the new start or
the point after which the host could no longer change the booking (the
venue's cancellation cutoff); one that cannot give the players half an hour
to answer is refused, and the host asks the venue. While it waits nobody can
join or be accepted (their places are passed on once it ends), the booking
cannot be moved again, and the host can withdraw it. Each answer is kept
(`game_move_answers`), as is the proposal and how it ended (`game_moves`).

**The venue's change.** A venue manager can move a game with players at
once, when the venue has to, giving a reason (front desk staff cannot). The
players are emailed the reason and asked to confirm under *My games* that
they are still coming, or to leave (any share paid online is owed back);
until they do, the host sees who has not confirmed. A host's proposal still
waiting is withdrawn by it: the players hear the venue's change instead. The
change and its reason are in the staff activity log.

## Where somebody stands in a game

Each person has one row per game, and nobody gets a place twice:

| Status | Meaning |
| ------ | ------- |
| `invited` | Asked in by the host or a player, until the invitation expires (48 hours, or the game's start) |
| `requested` | Asked to join; waiting for the host |
| `accepted` | In the game |
| `declined` | The host said no |
| `left` | Dropped out, withdrew, or turned down an invitation or a freed place |
| `removed` | Taken out by the host, or an invitation withdrawn |
| `waitlisted` | Asked when the game was full; in line |
| `offered` | A freed place held for them until it expires (2 hours, or the game's start) |
| `expired` | An invitation or a held place that ran out |

A place is taken by somebody `accepted` or holding an `offered` place. Every
change that takes or frees a place (joining, the host accepting or removing,
leaving, an offer running out, an account closing) runs in one transaction
that first locks the game's row, so two people answering at once cannot both
have the last place (B16, fixed). A freed place goes to whoever has waited
longest: where the host lets everybody in it is held for them and they are
emailed to take it or let it go; where the host decides, they become an
ordinary request. Nobody is ever moved into a game without saying yes. The
scheduler expires invitations and held places and passes each freed place on;
each such notice carries a key, so a job run twice sends it once.

## Invitations, links and private games

The host can invite a player suggested to them, or anybody by email address;
a player in a public game can invite somebody too, but where the host decides
that is still a request for the host. The host's own invitation is their yes.
Who may be invited: a declared adult the inviter has come across here (played
with, been invited by, or in a community group with), or one who has opted in
to being found or invited; somebody under 18, or who has not said, only by a
fellow member of a community group, never out of the blue; nobody across a
block. One person sends at most 30 invitations a day, to games and groups
together, and a game holds at most three outstanding per place.

**Inviting by email** cannot be used to find out who uses MySenam
(`src/lib/player-invitations.ts`;
[no account enumeration](../architecture/security.md#no-account-enumeration)).
The address is never looked up: the answer is the same, and the same work is
done, whether or not an account holds it and whether or not whoever does may
be invited. Every one counts against the daily limit and the game's
outstanding invitations, and the address is emailed a link to the game,
written in the inviter's language. The link works once, for the account
signed in with that address (made then, if there is none), at
`/player-invitation`; it lasts as an invitation does (48 hours, or the
game's start), and inviting the same address again replaces it. Until it is
accepted, the host sees *invited by email, not yet accepted*: no name, no
account, nothing about opting in. Accepting is taking up the invitation, as
with one by name: in, if the host invited (or lets everybody in) and there is
room; a request where another player invited and the host decides; the
waiting list if the game is full and has one. A game full without a waiting
list leaves the link to use if a place frees. Who may be invited is checked on
acceptance, by the rules above, and a link they do not allow gets the same
answer as one that is used, replaced, run out or another address's.

**Withdrawing an invitation by email.** Until it is accepted, the host, or
the player who sent it, can withdraw it (*Withdraw invitation* beside
*invited by email*, after a confirm; `src/lib/player-invitations.ts`
`withdrawPlayerInvitation`). It is withdrawn under the game's row lock, as
accepting takes it, and only while open, so a withdrawal racing an
acceptance is one or the other; it held no place, and it stops counting
among the game's outstanding invitations. Its link then gets the same answer
as one run out (`PLAYER_INVITATION_INVALID`), and the host sees *invited by
email: withdrawn* until it would have run out. Withdrawing again gives the
same answer; one already accepted is refused (`409 INVITATION_ACCEPTED_GAME`:
remove the player from the game instead), as is one run out or replaced
(`409 INVITATION_NOT_PENDING`), changing nothing; anybody else, or another
game's invitation, gets `404 INVITATION_NOT_FOUND`. If its email had not gone
it never goes; if it had, the address it went to is sent a short notice, in
the language the invitation was written in, that it was withdrawn, never by
whom or why: the same work whether or not an account holds it. The
invitation keeps who withdrew it and when. An invitation by name is withdrawn
by removing the player, as before (`tests/invitation-withdrawals.test.ts`,
`tests/components/invitation-withdrawals.test.tsx`).

Inviting somebody the inviter already knows here (a suggested player, last
week's players, a group's members) picks the account from those lists and
invites it by name, as before.

A **private** game is never listed or suggested. Only its host's invitations
and links lead to it: a link lasts what the host chooses (at most 14 days,
never past the game), only the SHA-256 of its secret is kept, and the host
can withdraw every link at once. A link is a way in, not the host's yes.

## Suggested games and players

`/games` also suggests games to a signed-in player (`src/lib/matchmaking.ts`,
`/api/games/recommended`), each with the reasons beside it, by fixed rules
with no learning:

1. **Hard constraints** decide whether a game can be suggested at all: a
   public, open game in the next 14 days, not their own and not one they are
   already part of or were turned down from; one they could join (the game's
   rule on who plays, adults only, fewer than three recent no-shows, the venue
   taking their number and letting them in, no block with the host or anyone
   in it); and within what they asked (distance from their point, the most per
   share, a level no more than one step from theirs, and a place free or a
   waiting list). The page shows how many were left out and why, with blocks
   and venue refusals counted together so neither can be told apart.
2. **Preferences** rank the rest, by published points (`WEIGHTS`): a sport
   they gave a level for 20; the same level 25, one step away 10, open to all
   levels 12; up to 20 for distance, falling to none at the edge of how far
   they go (or 12 for the area they named); 10 each for a day and a part of the
   day that suit them and for the same intensity; 5 within their price or
   free; −15 when only the waiting list is left. Ties go to the sooner game,
   then the nearer, then the older game. The last place and a host who decides
   are shown without points.

Levels and ages are what players say about themselves, and reasons say no
more ("the level you gave"). Nothing ranks by gender, age, race or religion:
the only rules on who plays are the host's own, and joining enforces the same
ones.

**Profiles** (`/games/preferences`, `src/lib/player-profiles.ts`) hold only
what matching needs: an area and a point rounded to about a kilometre (never
an address, never shown to anyone else), how far, days, parts of the day,
casual or competitive, the most per share, and whether to hear of suggested
games. Being **discoverable** (suggested to hosts) and **invitable** by
anybody are opt-in, off by default, and only for somebody who declares they
are 18 or over; the declaration is recorded as said, never verified.

**For hosts**, the players suggested for a game (`/api/games/:id/candidates`)
are only discoverable adults who play the sport, at a level one step or less
from the game's, for whom the game is within their distance and price, who
could join it, with no block either way. The host sees a first name, a level,
a distance band ("within 5 km") and the reasons; never a point, a phone
number, an email or anything about their calendar. Inviting goes through
MySenam.

## Blocking and reporting

A player can block, or report to the platform's owners, somebody they have
come across here (`src/lib/player-safety.ts`). A block works both ways and
says nothing: neither is suggested to the other, neither can invite the
other, and neither can join a game the other hosts or plays in, refused in the
same words as a closed game. Blocking withdraws invitations between them and
quietly turns down anything the blocked player asked of the blocker's games;
somebody already in stays until the host removes them, because a paid share
may hang on it. Reports (no-show, abuse, spam, safety, other) go to the
owner's list (`/api/admin/player-reports`), one open report per person, at
most ten a day from one player. The platform owner reads them on the
dashboard under *Reports about players* (`src/components/admin/PlayerReportsPanel.tsx`):
open, reviewed or all, fifty at a time and older on request, each with its
reason, the note, who made it, whom it is about with how many reports there
are about them, and the game; *Mark reviewed* is all it does. Acting on a
report (talking to the player, closing an account) happens outside the
screen; a report blocks nobody.

## Weekly games

A host with a weekly booking (a booking series) can make it a **weekly game**
(`src/lib/game-series.ts`): a game, with the same settings, on each of its
upcoming dates. Nothing in it holds a court: a date the host has booked gets a
game, a date without a booking has none, and the series never books anything
itself. When the host extends their weekly booking, the scheduler opens the
new dates' games within the hour. Cancelling one date's booking calls off
that date's game only. Players are never carried from one week to the next
without being asked: the host invites last week's players (those who came) to
this week's game, and each says yes or no as to any invitation. Ending a
weekly game stops new dates; the host can call off the games still to come at
the same time, and keeps the court bookings either way.

## Community groups

A **group** (`src/lib/groups.ts`, `/games/groups`) is people who play
together again and again: a doubles four, a futsal side, a Wednesday crowd.
It holds no court and no money, and it is not a tournament entry: a team in a
tournament is still entered as a tournament entry. What it does is let a
member who hosts a game invite the whole group in one go, through the
ordinary invitations, each member still saying yes or no; and being in a
group with somebody is what lets you invite them to games.

Membership is always agreed by both sides: somebody asks and the organiser
says yes, or the organiser invites and they say yes; nobody joins by
themselves, because a group is the only way a player under 18 can be invited
to a game, so it must not be a door anybody can walk through. The organiser
invites by email, as a host does: the same answer and work whatever the
address, a single-use link that lasts seven days, and *invited by email* on
the organiser's roster until it is accepted; the organiser can withdraw one
not yet accepted as a host does (above), under the group's row lock, an
accepted one being refused with `INVITATION_ACCEPTED_GROUP` (remove the
member instead). Accepting makes a member, if
there is room, of a declared adult the organiser has come across or who opted
in to being invited; anybody else's link is refused like one that cannot be
used, and a player under 18 asks to join themselves. A public group is
listed; a private one is seen only by its members, not by somebody invited
by email until they accept. Members see each other's
first names only. A group holds 2 to 60 people, an organiser runs at most
five, and a closed group no longer counts for invitations.

## Emails of suggested games

A player chooses in their preferences whether to hear of games suggested for
them: never, a daily digest (up to five games), or as they open (at most an
hourly email, up to three). Each game is told once ever (`match_notices`), and
the scheduler works through players in the order they were last looked at,
25 at a time. Each email carries a key, so a run on two servers sends one.

## What is not here

There is no messaging between players, and no
persistent team that enters tournaments: a tournament entry stays a
tournament entry. Levels are self-declared; none is earned from results.
These are proposals in the [roadmap](../roadmap/roadmap.md), not commitments.

## Related capabilities

- **The court** is the host's ordinary booking, under its venue's
  [booking rules](booking.md); joining never books anything.
- **Shares** are paid online to the venue's own account, or at the counter,
  and shares owed back join the venue's refunds
  ([payments and credit](payments-and-credit.md),
  [business rules](../product/business-rules.md#money)).
- **Emails** go through the [outbox](../integrations/messaging.md), whose
  live delivery is unverified ([feature status](../product/feature-status.md#integrations)).
- **Players' data**: the playing profile, levels, games, blocks, reports
  made and groups are in the data export and go with the account
  ([privacy](../architecture/privacy.md)).

## Implementation and tests

| Part | Code | Tests |
| ---- | ---- | ----- |
| Open games, joining, waiting lists, invitations, private links | `src/lib/games.ts`, `src/app/games/HostTools.tsx` | `tests/games.test.ts`, `tests/matchmaking.test.ts`, `tests/matchmaking-routes.test.ts` |
| Moving a game to another time | `src/lib/game-moves.ts`, `src/app/games/MoveGame.tsx`, `src/components/ChangeTime.tsx` | `tests/game-moves.test.ts` |
| Suggested games and players | `src/lib/matchmaking.ts`, `src/app/games/Suggested.tsx` | `tests/matchmaking.test.ts`, `tests/matchmaking-routes.test.ts` |
| Playing profiles | `src/lib/player-profiles.ts` | `tests/matchmaking.test.ts` |
| Blocking and reporting | `src/lib/player-safety.ts` | `tests/matchmaking.test.ts`, `tests/matchmaking-routes.test.ts` |
| Weekly games, groups, suggestion emails | `src/lib/game-series.ts`, `src/lib/groups.ts` | `tests/community.test.ts` |
| Invitations by email to a game or a group | `src/lib/player-invitations.ts`, `src/app/player-invitation/page.tsx` | `tests/player-invitations.test.ts`, `tests/components/games-screens.test.tsx` |
| Withdrawing an invitation by email | `src/lib/player-invitations.ts` (`withdrawPlayerInvitation`), `src/lib/games.ts`, `src/lib/groups.ts`, `db/migrations/0213_player_invitations_withdrawn.sql` | `tests/invitation-withdrawals.test.ts` (races on Postgres), `tests/components/invitation-withdrawals.test.tsx` |
| Women-only and men-only games | `src/lib/who.ts` | `tests/who.test.ts` |
| Visual acceptance, several players at once | | `tests/uat/matchmaking.uat.ts`, `tests/uat/community.uat.ts` |

Which parts are verified, and how, is in
[feature status](../product/feature-status.md#open-games-and-matchmaking).

## Open decisions and known issues

- Moving a game is decided by its owner: a called-off game does not block
  its booking, a game with players moves only as a proposal they answer or
  as the venue's change with a reason (decided 24 October 2026). How long a
  proposal holds the new time (a day at most) is fixed, not set by the venue.
- Earned levels, messages between players, persistent teams
  and group news are proposals in the [roadmap](../roadmap/roadmap.md).
