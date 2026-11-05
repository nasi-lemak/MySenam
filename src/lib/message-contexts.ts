import { getDb } from "./db";
import { slotStartsAt, todayISO, addDays } from "./time";
import { venueZoneOf } from "./zones";
import { isDeclaredMinor, shortName } from "./public-names";

/**
 * The contexts a message can be written in, and who is in each (docs/features/player-messages.md; ADR 0039).
 *
 * A thread begins only inside something people already share and the app already knows: the same open game, team, community group, or
 * a fixture they are both in (a tournament match, a box-league match, a ladder challenge, a team-league fixture). Nothing here looks a
 * person up: the one question is "who is in this context, now?", answered from the live tables every time (nothing is copied, so a
 * player who leaves, is withdrawn or has their entry removed stops being in it at once).
 *
 * **Seats are accounts, never children.** A child is never an account that messages: where the context holds a child (a team member
 * who is a participant a guardian manages, a tournament, league or ladder entry for one), the seat is the *guardian's* account,
 * labelled with the child's short name (`shortName`, the rule behind every public page), never the child's full name, never the
 * guardian's own name. An entry for a team is the captain's seat, labelled by the team's name, and a team's members are not given a
 * seat in a fixture they play in.
 */

export const CONTEXT_KINDS = ["game", "team", "group", "tournament_match", "league_match", "ladder_challenge", "team_fixture"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** The kind as it is written in an address: `/messages/tournament-match/12`. */
export const kindInUrl = (kind: ContextKind): string => kind.replace(/_/g, "-");
export function kindFromUrl(raw: string): ContextKind | null {
  const kind = raw.replace(/-/g, "_");
  return (CONTEXT_KINDS as readonly string[]).includes(kind) ? (kind as ContextKind) : null;
}

/** How a person shows in a context: a first name, a guardian of children by their short names, or a team's captain. Localised by the reader. */
export interface SeatLabel {
  n?: string;
  g?: string[];
  c?: string;
}

export interface Seat {
  userId: number;
  from: SeatLabel;
}

export interface ContextInfo {
  kind: ContextKind;
  id: number;
  /** The venue it belongs to; null for a group, or a team with no venue (the platform owner then moderates). */
  venueId: number | null;
  venueName: string | null;
  /** What to call it: an event's, team's or group's name; null for a game. */
  name: string | null;
  sport: string | null;
  /** A game's day and start, or a fixture's, where it has one. */
  date: string | null;
  startMin: number | null;
  /** Over: a game played or called off, a team archived, a fixture decided. */
  ended: boolean;
  /** When it ended, as stored (UTC), where that is known; the thread's own first sight of it stands otherwise. */
  endedAt: string | null;
}

export interface Context {
  info: ContextInfo;
  seats: Seat[];
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;
const stamp = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

/** One seat per account: an account that is in the context twice (its own place and a child's) shows once, both ways. */
function merge(parts: { userId: number; from: SeatLabel }[]): Seat[] {
  const by = new Map<number, SeatLabel>();
  for (const p of parts) {
    const had = by.get(p.userId) ?? {};
    by.set(p.userId, {
      ...(had.n ?? p.from.n ? { n: had.n ?? p.from.n } : {}),
      ...(had.c ?? p.from.c ? { c: had.c ?? p.from.c } : {}),
      ...((had.g?.length ?? 0) + (p.from.g?.length ?? 0) > 0 ? { g: [...(had.g ?? []), ...(p.from.g ?? [])] } : {}),
    });
  }
  return [...by.entries()].map(([userId, from]) => ({ userId, from }));
}

// ------------------------------------------------------------------ each kind

async function gameContext(id: number): Promise<Context | null> {
  const db = getDb();
  const g = (await db
    .prepare(
      `SELECT g.id, g.host_id, g.status, v.id AS venue_id, v.name AS venue_name, v.time_zone, v.lat, v.lng, b.sport,
              COALESCE(g.was_date, b.date) AS date, COALESCE(g.was_start_min, b.start_min) AS start_min, COALESCE(g.was_end_min, b.end_min) AS end_min
         FROM open_games g JOIN bookings b ON b.id = g.booking_id JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE g.id = ?`
    )
    .get(id)) as
    | { id: number; host_id: number; status: string; venue_id: number; venue_name: string; time_zone: string | null; lat: number | null; lng: number | null; sport: string; date: string; start_min: number; end_min: number }
    | undefined;
  if (!g) return null;
  const people = (await db
    .prepare(
      `SELECT u.id, u.name FROM users u WHERE u.id = ?
       UNION SELECT u.id, u.name FROM open_game_players p JOIN users u ON u.id = p.user_id WHERE p.game_id = ? AND p.status = 'accepted'`
    )
    .all(g.host_id, id)) as { id: number; name: string }[];
  const endsAt = slotStartsAt(g.date, g.end_min / 60, venueZoneOf(g));
  const over = g.status === "cancelled" || endsAt.getTime() <= Date.now();
  return {
    info: {
      kind: "game",
      id,
      venueId: g.venue_id,
      venueName: g.venue_name,
      name: null,
      sport: g.sport,
      date: g.date,
      startMin: g.start_min,
      ended: over,
      endedAt: g.status === "cancelled" ? null : over ? stamp(endsAt) : null,
    },
    seats: people.map((p) => ({ userId: p.id, from: { n: firstName(p.name) } })),
  };
}

async function teamContext(id: number): Promise<Context | null> {
  const db = getDb();
  const t = (await db
    .prepare("SELECT t.id, t.name, t.sport, t.status, t.archived_at, t.venue_id, v.name AS venue_name FROM teams t LEFT JOIN venues v ON v.id = t.venue_id WHERE t.id = ?")
    .get(id)) as { id: number; name: string; sport: string; status: string; archived_at: string | null; venue_id: number | null; venue_name: string | null } | undefined;
  if (!t) return null;
  const members = (await db
    .prepare(
      `SELECT m.user_id, m.participant_id, m.acting_user_id, u.name AS user_name, p.display_name AS participant_name
         FROM team_members m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN participants p ON p.id = m.participant_id
        WHERE m.team_id = ? AND m.status = 'member'`
    )
    .all(id)) as { user_id: number | null; participant_id: number | null; acting_user_id: number | null; user_name: string | null; participant_name: string | null }[];
  const parts: { userId: number; from: SeatLabel }[] = [];
  for (const m of members) {
    if (m.participant_id !== null) {
      if (m.acting_user_id !== null) parts.push({ userId: m.acting_user_id, from: { g: [shortName(m.participant_name ?? "")] } });
    } else if (m.user_id !== null) parts.push({ userId: m.user_id, from: { n: firstName(m.user_name ?? "") } });
  }
  return {
    info: { kind: "team", id, venueId: t.venue_id, venueName: t.venue_name, name: t.name, sport: t.sport, date: null, startMin: null, ended: t.status !== "active", endedAt: t.archived_at },
    seats: merge(parts),
  };
}

async function groupContext(id: number): Promise<Context | null> {
  const db = getDb();
  const g = (await db.prepare("SELECT id, name, sport, status FROM community_groups WHERE id = ?").get(id)) as { id: number; name: string; sport: string; status: string } | undefined;
  if (!g) return null;
  const members = (await db
    .prepare("SELECT u.id, u.name FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND m.status = 'member'")
    .all(id)) as { id: number; name: string }[];
  return {
    info: { kind: "group", id, venueId: null, venueName: null, name: g.name, sport: g.sport, date: null, startMin: null, ended: g.status !== "active", endedAt: null },
    seats: members.map((m) => ({ userId: m.id, from: { n: firstName(m.name) } })),
  };
}

/**
 * One side of a fixture, as a seat: the account that entered (a guardian, where a declared minor or a participant is the entrant, shown
 * by the child's short name), or the captain of a team.
 */
function entrantSeat(e: {
  userId: number | null;
  userName: string | null;
  name: string;
  team: string | null;
  participantId: number | null;
  guardian: boolean;
  birthDate: string | null;
  partnerBirthDate: string | null;
  on: string;
}): { userId: number; from: SeatLabel } | null {
  if (e.userId === null) return null;
  if (e.team) return { userId: e.userId, from: { c: e.team } };
  const minor = isDeclaredMinor({ guardian: e.guardian, participantId: e.participantId, birthDate: e.birthDate, partnerBirthDate: e.partnerBirthDate }, e.on);
  return { userId: e.userId, from: minor ? { g: [shortName(e.name)] } : { n: firstName(e.userName ?? e.name) } };
}

async function tournamentMatchContext(id: number): Promise<Context | null> {
  const db = getDb();
  const m = (await db
    .prepare(
      `SELECT m.id, m.status, m.entry_a, m.entry_b, m.date, m.start_min, m.updated_at, t.name, t.sport, t.status AS t_status, t.starts_on, t.ends_on, t.venue_id, v.name AS venue_name
         FROM tournament_matches m JOIN tournaments t ON t.id = m.tournament_id JOIN venues v ON v.id = t.venue_id WHERE m.id = ?`
    )
    .get(id)) as
    | { id: number; status: string; entry_a: number | null; entry_b: number | null; date: string | null; start_min: number | null; updated_at: string | null; name: string; sport: string; t_status: string; starts_on: string; ends_on: string; venue_id: number; venue_name: string }
    | undefined;
  if (!m || m.entry_a === null || m.entry_b === null || m.status === "bye") return null;
  const rows = (await db
    .prepare(
      `SELECT e.id, e.user_id, u.name AS user_name, e.name, e.team_name, e.team_id, e.participant_id, e.guardian_name, e.birth_date, e.partner_birth_date
         FROM tournament_entries e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.id IN (?, ?) AND e.status <> 'withdrawn'`
    )
    .all(m.entry_a, m.entry_b)) as {
    id: number; user_id: number | null; user_name: string | null; name: string; team_name: string | null; team_id: number | null; participant_id: number | null;
    guardian_name: string | null; birth_date: string | null; partner_birth_date: string | null;
  }[];
  const seats = rows.flatMap((e) => {
    const seat = entrantSeat({
      userId: e.user_id, userName: e.user_name, name: e.name, team: e.team_id !== null || e.team_name ? (e.team_name ?? e.name) : null,
      participantId: e.participant_id, guardian: !!e.guardian_name, birthDate: e.birth_date, partnerBirthDate: e.partner_birth_date, on: m.starts_on,
    });
    return seat ? [seat] : [];
  });
  const decided = m.status === "done" || m.status === "walkover";
  const over = decided || m.t_status === "finished" || m.t_status === "cancelled";
  return {
    info: { kind: "tournament_match", id, venueId: m.venue_id, venueName: m.venue_name, name: m.name, sport: m.sport, date: m.date, startMin: m.start_min, ended: over, endedAt: decided ? m.updated_at : null },
    seats: merge(seats),
  };
}

async function leagueMatchContext(id: number): Promise<Context | null> {
  const db = getDb();
  const m = (await db
    .prepare(
      `SELECT m.id, m.status, m.updated_at, m.player_a, m.player_b, l.name, l.sport, l.venue_id, v.name AS venue_name, s.status AS season_status, s.starts_on
         FROM league_matches m JOIN league_seasons s ON s.id = m.season_id JOIN leagues l ON l.id = s.league_id JOIN venues v ON v.id = l.venue_id WHERE m.id = ?`
    )
    .get(id)) as
    | { id: number; status: string; updated_at: string | null; player_a: number; player_b: number; name: string; sport: string; venue_id: number; venue_name: string; season_status: string; starts_on: string }
    | undefined;
  if (!m) return null;
  const rows = (await db
    .prepare(
      `SELECT p.user_id, u.name AS user_name, p.name, p.participant_id FROM league_players p LEFT JOIN users u ON u.id = p.user_id WHERE p.id IN (?, ?) AND p.status = 'active'`
    )
    .all(m.player_a, m.player_b)) as { user_id: number | null; user_name: string | null; name: string; participant_id: number | null }[];
  const seats = rows.flatMap((p) => {
    const seat = entrantSeat({ userId: p.user_id, userName: p.user_name, name: p.name, team: null, participantId: p.participant_id, guardian: false, birthDate: null, partnerBirthDate: null, on: m.starts_on });
    return seat ? [seat] : [];
  });
  const decided = ["confirmed", "walkover", "void"].includes(m.status);
  return {
    info: { kind: "league_match", id, venueId: m.venue_id, venueName: m.venue_name, name: m.name, sport: m.sport, date: null, startMin: null, ended: decided || m.season_status === "finished", endedAt: decided ? m.updated_at : null },
    seats: merge(seats),
  };
}

async function ladderChallengeContext(id: number): Promise<Context | null> {
  const db = getDb();
  const c = (await db
    .prepare(
      `SELECT c.id, c.status, c.updated_at, c.challenger, c.challenged, c.agreed_on, c.agreed_min, l.name, l.sport, l.venue_id, v.name AS venue_name, s.ended_on, s.started_on
         FROM ladder_challenges c JOIN ladder_seasons s ON s.id = c.season_id JOIN ladders l ON l.id = c.ladder_id JOIN venues v ON v.id = l.venue_id WHERE c.id = ?`
    )
    .get(id)) as
    | { id: number; status: string; updated_at: string | null; challenger: number; challenged: number; agreed_on: string | null; agreed_min: number | null; name: string; sport: string; venue_id: number; venue_name: string; ended_on: string | null; started_on: string }
    | undefined;
  if (!c) return null;
  const rows = (await db
    .prepare(`SELECT p.user_id, u.name AS user_name, p.name, p.participant_id FROM ladder_players p LEFT JOIN users u ON u.id = p.user_id WHERE p.id IN (?, ?) AND p.status = 'active'`)
    .all(c.challenger, c.challenged)) as { user_id: number | null; user_name: string | null; name: string; participant_id: number | null }[];
  const seats = rows.flatMap((p) => {
    const seat = entrantSeat({ userId: p.user_id, userName: p.user_name, name: p.name, team: null, participantId: p.participant_id, guardian: false, birthDate: null, partnerBirthDate: null, on: c.started_on });
    return seat ? [seat] : [];
  });
  const decided = ["confirmed", "walkover", "declined", "cancelled", "lapsed", "void"].includes(c.status);
  return {
    info: { kind: "ladder_challenge", id, venueId: c.venue_id, venueName: c.venue_name, name: c.name, sport: c.sport, date: c.agreed_on, startMin: c.agreed_min, ended: decided || c.ended_on !== null, endedAt: decided ? c.updated_at : null },
    seats: merge(seats),
  };
}

async function teamFixtureContext(id: number): Promise<Context | null> {
  const db = getDb();
  const f = (await db
    .prepare(
      `SELECT f.id, f.status, f.updated_at, f.date, f.start_min, f.home_team, f.away_team, l.name, l.sport, l.venue_id, v.name AS venue_name
         FROM team_fixtures f JOIN team_leagues l ON l.id = f.league_id JOIN venues v ON v.id = l.venue_id WHERE f.id = ?`
    )
    .get(id)) as
    | { id: number; status: string; updated_at: string | null; date: string; start_min: number; home_team: number; away_team: number; name: string; sport: string; venue_id: number; venue_name: string }
    | undefined;
  if (!f) return null;
  const sides = (await db
    .prepare(
      `SELECT x.name, COALESCE(t.captain_user_id, x.entered_by) AS captain FROM team_league_teams x LEFT JOIN teams t ON t.id = x.team_id
        WHERE x.id IN (?, ?) AND x.status = 'entered'`
    )
    .all(f.home_team, f.away_team)) as { name: string; captain: number | null }[];
  const decided = ["confirmed", "forfeit", "void"].includes(f.status);
  return {
    info: { kind: "team_fixture", id, venueId: f.venue_id, venueName: f.venue_name, name: f.name, sport: f.sport, date: f.date, startMin: f.start_min, ended: decided, endedAt: decided ? f.updated_at : null },
    seats: merge(sides.flatMap((s) => (s.captain === null ? [] : [{ userId: s.captain, from: { c: s.name } }]))),
  };
}

/** The context and who is in it, now; null when there is no such thing. */
export async function contextOf(kind: ContextKind, id: number): Promise<Context | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  switch (kind) {
    case "game":
      return gameContext(id);
    case "team":
      return teamContext(id);
    case "group":
      return groupContext(id);
    case "tournament_match":
      return tournamentMatchContext(id);
    case "league_match":
      return leagueMatchContext(id);
    case "ladder_challenge":
      return ladderChallengeContext(id);
    case "team_fixture":
      return teamFixtureContext(id);
  }
}

/**
 * The row that makes somebody a member of a context, locked `FOR SHARE`, so whoever takes the place away (leaving a game, a team,
 * a group) waits for a message being written, or this waits for it: a message is never written by somebody the context has already
 * let go. Used inside the sending transaction. A fixture's membership is read, not locked: no player leaves one by their own act
 * (staff withdraw an entrant, which is a decision about the whole event).
 */
export async function lockSeat(kind: ContextKind, id: number, userId: number): Promise<void> {
  const db = getDb();
  if (kind === "game") {
    await db.prepare("SELECT 1 FROM open_games WHERE id = ? FOR SHARE").get(id);
    await db.prepare("SELECT 1 FROM open_game_players WHERE game_id = ? AND user_id = ? FOR SHARE").get(id, userId);
  } else if (kind === "team") {
    await db.prepare("SELECT 1 FROM team_members WHERE team_id = ? AND (user_id = ? OR acting_user_id = ?) AND status = 'member' FOR SHARE").all(id, userId, userId);
  } else if (kind === "group") {
    await db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? FOR SHARE").get(id, userId);
  }
}

/** Contexts this person is in now or was in recently enough to still read: candidates for their list of messages, to be checked by `contextOf`. */
export async function candidateContexts(userId: number): Promise<{ kind: ContextKind; id: number }[]> {
  const db = getDb();
  const since = addDays(todayISO(), -16);
  const stampSince = `${since} 00:00:00`;
  const out: { kind: ContextKind; id: number }[] = [];
  const add = (kind: ContextKind, rows: unknown[]) => {
    for (const r of rows as { id: number }[]) out.push({ kind, id: r.id });
  };
  add(
    "game",
    await db
      .prepare(
        `SELECT g.id FROM open_games g JOIN bookings b ON b.id = g.booking_id
          WHERE COALESCE(g.was_date, b.date) >= ?
            AND (g.host_id = ? OR EXISTS (SELECT 1 FROM open_game_players p WHERE p.game_id = g.id AND p.user_id = ? AND p.status = 'accepted'))`
      )
      .all(since, userId, userId)
  );
  add(
    "team",
    await db
      .prepare(
        `SELECT DISTINCT t.id FROM team_members m JOIN teams t ON t.id = m.team_id
          WHERE (m.user_id = ? OR m.acting_user_id = ?) AND m.status = 'member' AND (t.status = 'active' OR t.archived_at >= ?)`
      )
      .all(userId, userId, stampSince)
  );
  add(
    "group",
    await db
      .prepare("SELECT g.id FROM group_members m JOIN community_groups g ON g.id = m.group_id WHERE m.user_id = ? AND m.status = 'member'")
      .all(userId)
  );
  add(
    "tournament_match",
    await db
      .prepare(
        `SELECT DISTINCT m.id FROM tournament_matches m JOIN tournament_entries e ON e.id IN (m.entry_a, m.entry_b)
          WHERE e.user_id = ? AND e.status <> 'withdrawn' AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL AND m.status <> 'bye'
            AND (m.status = 'scheduled' OR m.updated_at >= ?)`
      )
      .all(userId, stampSince)
  );
  add(
    "league_match",
    await db
      .prepare(
        `SELECT DISTINCT m.id FROM league_matches m JOIN league_players p ON p.id IN (m.player_a, m.player_b)
          WHERE p.user_id = ? AND p.status = 'active' AND (m.status IN ('unplayed', 'reported', 'disputed') OR m.updated_at >= ?)`
      )
      .all(userId, stampSince)
  );
  add(
    "ladder_challenge",
    await db
      .prepare(
        `SELECT DISTINCT c.id FROM ladder_challenges c JOIN ladder_players p ON p.id IN (c.challenger, c.challenged)
          WHERE p.user_id = ? AND p.status = 'active' AND (c.status IN ('pending', 'accepted', 'reported', 'disputed') OR c.updated_at >= ?)`
      )
      .all(userId, stampSince)
  );
  add(
    "team_fixture",
    await db
      .prepare(
        `SELECT DISTINCT f.id FROM team_fixtures f
           JOIN team_league_teams x ON x.id IN (f.home_team, f.away_team) AND x.status = 'entered'
           LEFT JOIN teams t ON t.id = x.team_id
          WHERE COALESCE(t.captain_user_id, x.entered_by) = ? AND (f.status IN ('scheduled', 'reported', 'disputed') OR f.updated_at >= ?)`
      )
      .all(userId, stampSince)
  );
  // Threads they have written in or read, whatever the list above says: an ended context still being read.
  for (const r of (await db
    .prepare(
      `SELECT DISTINCT t.context_kind AS kind, t.context_id AS id FROM player_message_threads t
        WHERE t.id IN (SELECT thread_id FROM player_message_reads WHERE user_id = ?) OR t.id IN (SELECT thread_id FROM player_messages WHERE sender_id = ?)`
    )
    .all(userId, userId)) as { kind: ContextKind; id: number }[])
    out.push(r);
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
