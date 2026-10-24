import { getDb } from "./db";
import { isActivity } from "./activities";
import { offerSlotPlace } from "./store";
import { addDays, todayISO } from "./time";
import { type Sport } from "./types";
import {
  cancelTournament,
  checkHold,
  holdInTheWay,
  placeHold,
  tournamentById,
  type HoldRequest,
  type Tournament,
} from "./tournaments";

/**
 * A competition with divisions: one event at a venue — a club championship,
 * a junior open — holding its courts and hours once, with each division (men's
 * singles, girls under 12, mixed doubles) a tournament of its own inside it:
 * its own format, rules, who may enter, fee, entries and draw (ADR 0013).
 *
 * The hold belongs to the competition. A division's draw is scheduled into
 * that time around the matches the other divisions already have, on court and
 * by player: somebody entered in two divisions is never put on court in both
 * at once. Held time goes back on sale once every division still running has
 * made its draw, and what is left of it as results come in. A division's
 * matches are the competition's length unless it gives its own; each draw is
 * fitted around the others' matches by their own lengths.
 */

export interface Competition {
  id: number;
  venueId: number;
  name: string;
  sport: Sport;
  startsOn: string;
  endsOn: string;
  startMin: number;
  endMin: number;
  matchMinutes: number;
  courtIds: number[];
  /** How many divisions one player may enter; null for no limit. */
  maxDivisionsPerPlayer: number | null;
  description: string | null;
  status: "open" | "cancelled";
}

export interface CompetitionDetail extends Competition {
  divisions: Tournament[];
}

export interface CompetitionInput extends HoldRequest {
  name: string;
  maxDivisionsPerPlayer?: number | null;
  description?: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string; clashes?: number };

interface CRow {
  id: number;
  venue_id: number;
  name: string;
  sport: Sport;
  starts_on: string;
  ends_on: string;
  start_min: number;
  end_min: number;
  match_minutes: number;
  max_divisions_per_player: number | null;
  description: string | null;
  status: "open" | "cancelled";
  court_ids: number[] | null;
}

const C_SELECT = `SELECT c.*, ARRAY(SELECT court_id FROM competition_courts cc WHERE cc.competition_id = c.id ORDER BY court_id) AS court_ids FROM competitions c`;

function toCompetition(r: CRow): Competition {
  return {
    id: r.id,
    venueId: r.venue_id,
    name: r.name,
    sport: r.sport,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    startMin: r.start_min,
    endMin: r.end_min,
    matchMinutes: r.match_minutes,
    courtIds: (r.court_ids ?? []).map(Number),
    maxDivisionsPerPlayer: r.max_divisions_per_player,
    description: r.description,
    status: r.status,
  };
}

export async function competitionById(id: number): Promise<Competition | null> {
  const row = (await getDb().prepare(`${C_SELECT} WHERE c.id = ?`).get(id)) as CRow | undefined;
  return row ? toCompetition(row) : null;
}

/** A competition and its divisions, for staff and for its public page. */
export async function competitionDetail(id: number): Promise<CompetitionDetail | null> {
  const c = await competitionById(id);
  if (!c) return null;
  const ids = (await getDb().prepare("SELECT id FROM tournaments WHERE competition_id = ? ORDER BY id").all(id)) as { id: number }[];
  const divisions = (await Promise.all(ids.map((r) => tournamentById(r.id)))).filter((t): t is Tournament => t !== null);
  return { ...c, divisions };
}

/** A venue's competitions still to come or under way, newest first. */
export async function listCompetitions(venueIds: number[]): Promise<Competition[]> {
  if (venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(`${C_SELECT} WHERE c.venue_id IN (${venueIds.map(() => "?").join(",")}) AND c.ends_on >= ? ORDER BY c.starts_on DESC, c.id DESC`)
    .all(...venueIds, addDays(todayISO(), -30))) as CRow[];
  return rows.map(toCompetition);
}

/**
 * Set a competition up and hold its courts for its days and hours, as a
 * tournament on its own would be: refused over an outage or a booking.
 * Divisions are added to it afterwards (lib/tournaments.ts `createTournament`
 * with `competitionId`).
 */
export async function createCompetition(input: CompetitionInput, adminId: number): Promise<Result<Competition>> {
  const db = getDb();
  const name = input.name?.trim() ?? "";
  if (name.length < 3 || name.length > 100) return { ok: false, error: "Give it a name." };
  if (!(await isActivity(input.sport))) return { ok: false, error: "Unknown sport." };
  const cap = input.maxDivisionsPerPlayer ?? null;
  if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 20)) return { ok: false, error: "A player may enter 1 to 20 divisions, or leave it open." };
  const checked = await checkHold(input);
  if (!checked.ok) return checked;
  const hold = checked.hold;
  const before = await holdInTheWay(hold);
  if (before) return before;
  let id = 0;
  const refused = await db.transaction(async () => {
    const meanwhile = await holdInTheWay(hold);
    if (meanwhile) return meanwhile;
    const row = (await db
      .prepare(
        `INSERT INTO competitions (venue_id, name, sport, starts_on, ends_on, start_min, end_min, match_minutes, max_divisions_per_player, description, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        hold.venueId,
        name,
        hold.sport,
        hold.startsOn,
        hold.endsOn,
        hold.startMin,
        hold.endMin,
        hold.matchMinutes,
        cap,
        input.description?.trim().slice(0, 2000) || null,
        adminId
      )) as { id: number };
    id = row.id;
    for (const c of hold.courtIds) await db.prepare("INSERT INTO competition_courts (competition_id, court_id) VALUES (?, ?)").run(id, c);
    await placeHold(hold, `Competition: ${name}`, { competitionId: id });
    return null;
  })();
  if (refused) return refused;
  return { ok: true, value: (await competitionById(id))! };
}

/**
 * Called off, every division with it: each division is called off as a
 * tournament is (entrants told, fees paid online owed back), and the
 * competition's courts go back on sale.
 */
export async function cancelCompetition(id: number): Promise<Result<Competition>> {
  const db = getDb();
  const c = await competitionById(id);
  if (!c || c.status === "cancelled") return { ok: false, error: "That cannot be called off now." };
  const divisions = (await db
    .prepare("SELECT id FROM tournaments WHERE competition_id = ? AND status NOT IN ('cancelled', 'finished')")
    .all(id)) as { id: number }[];
  if ((await db.prepare("SELECT 1 FROM tournaments WHERE competition_id = ? AND status = 'finished'").get(id)) !== undefined)
    return { ok: false, error: "A division has finished: call off the others one by one." };
  for (const d of divisions) await cancelTournament(d.id);
  const freed = (await db.prepare("SELECT DISTINCT court_id, date FROM blocks WHERE competition_id = ? AND date >= ?").all(id, todayISO())) as {
    court_id: number;
    date: string;
  }[];
  await db.transaction(async () => {
    await db.prepare("UPDATE competitions SET status = 'cancelled' WHERE id = ?").run(id);
    await db.prepare("DELETE FROM blocks WHERE competition_id = ?").run(id);
  })();
  for (const day of freed) await offerSlotPlace(day.court_id, day.date);
  return { ok: true, value: (await competitionById(id))! };
}
