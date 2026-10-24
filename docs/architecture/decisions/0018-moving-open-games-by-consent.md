# ADR 0018: An open game with players moves by their consent, on a held time

- **Status:** current, decided 2026-10-24 by the product owner. What hosts,
  players and staff see is
  [moving a game](../../features/matchmaking.md#moving-a-game-to-another-time).
- **Context:** a booking that had ever had an open game could not be moved
  to another time by anybody, even after the game was called off or while
  nobody was in it. That was too strict for real venues. But a game with
  players is several people's plans: moving it as if it were only the host's
  booking would move them without asking, and moving it first and asking
  after would leave a time sold twice or a game nobody can play.
- **Decision:**
  - **The booking engine moves the booking; the game decides when.** There
    is one way to move court time (`rescheduleBooking`, lib/store.ts), with
    its rules on what is free, how long, what it costs and who may go past
    them. lib/game-moves.ts adds only who must be asked, and when.
  - **State decides.** A called-off game does not block its booking (and
    keeps where it was); a game nobody is in moves with its booking; a game
    with players moves only as its host's proposal or the venue's change; a
    game that has begun keeps its time.
  - **A proposal holds the new time as a claim of its own** (kind `move`),
    beside the booking's claim, with an expiry, as a waiting-list offer holds
    time. The database's constraints keep it from being sold twice. When the
    last player answers, the booking moves onto it in the same transaction
    that lets the hold go; if anything is in the way the move fails and
    everybody is told, and nothing half-moves.
  - **Notification is not consent.** Each player keeps their place or
    leaves; silence lets the proposal run out. A venue's change is made at
    once, by a manager, with a reason, and each player then confirms or
    leaves; until they do, the host sees who has not.
  - **Locks in one order:** the game's row, then the booking's, then the
    court's spaces, so a move, a join and a proposal answered at once queue
    rather than deadlock; a booking found moved since it was read is refused.
- **Consequences:** joining pauses while players are asked, so nobody joins
  a game whose time is about to change without being asked. A proposal holds
  for a day at most, not configurable per venue. Leaving keeps its existing
  money rule (a paid share owed back), so a move creates no new refund path.
  A new time overlapping the game's own on a court that shares its floor (a
  pitch over its court) cannot be held beside it and is refused.
