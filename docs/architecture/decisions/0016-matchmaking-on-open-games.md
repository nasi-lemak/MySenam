# ADR 0016: Matchmaking is built on open games, deterministic and opt-in

- **Status:** current, decided 2026-10-24. What players and hosts see is
  [open games and matchmaking](../../features/matchmaking.md).
- **Context:** open games already let a host advertise places on their own
  booking, with shares paid to the venue. Players asked for more: games
  suggested to them, hosts finding players, invitations, private games,
  waiting lists, weekly games and groups. Each of these could have become an
  engine of its own (a second booking path, a ranking model, a wallet for
  splitting money between players), and each would have brought its own
  money, privacy and concurrency questions.
- **Decision:**
  - **One participation model.** Everything is a row per person per game in
    `open_game_players`, whose status says where they stand (invited,
    requested, accepted, declined, left, removed, waitlisted, offered,
    expired). Joining never books a court: the game is the host's booking,
    and a weekly game is the host's weekly booking. A date without a booking
    has no game.
  - **Capacity under one lock.** Every change that takes or frees a place
    runs in one serializable transaction that first locks the game's row
    (`SELECT … FOR UPDATE`), and counts accepted players and places held. On
    Postgres the previous code let six people into a one-place game (B16).
  - **Deterministic, explainable matching.** Hard constraints decide whether
    a game can be suggested; published weights rank the rest; every point is
    a reason shown to the player. No learning, no embeddings, no hidden
    signals; ties are broken by date, distance and id so the order never
    wobbles. Levels and ages are self-declared and presented as such; the
    only rules on who plays are the host's own, the ones joining enforces.
  - **Being found is opt-in, and for declared adults only.** A host sees a
    first name, a level and a distance band, never a point, a phone number,
    an email or a calendar. Somebody under 18, or who has not said, is never
    suggested and can be invited only by a fellow member of a community group,
    whose membership both sides agreed to.
  - **No new money.** Shares are paid to the venue as before; nothing is
    charged because players match, nothing moves between players, and there
    is no wallet. A freed place is held for the next in line, never filled
    without their yes.
  - **Notices through the outbox, keyed.** Invitations, held places and
    suggested games are emails with a dedupe key, so a job run on two
    servers sends one.
- **Consequences:** the existing money, refund and privacy rules apply to
  every new workflow unchanged. Ranking reads a bounded number of candidates
  (300 games, 500 players) and is not measured at marketplace size. Earned
  ratings, messages between players and teams that persist across
  tournaments are left to the [roadmap](../../roadmap/roadmap.md).
