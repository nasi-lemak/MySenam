import { isActivity } from "./activities";
import { getDb, withTransaction } from "./db";
import { hoursOn, parseWeekHours } from "./week-hours";
import { receiptFee } from "./documents";
import {
  bracketSize,
  firstRound,
  groupCount,
  intoGroups,
  knockoutFromGroups,
  parseScore,
  roundRobin,
  scheduleMatches,
  shuffle,
  standings,
  type Slot,
  type Standing,
  type ToSchedule,
} from "./brackets";
import { accessRefusal } from "./access";
import { listRule, OPEN_TO_CUSTOMERS } from "./listing";
import { baseUrl, emailPlayer } from "./outbox";
import { blockSlots, offerSlotPlace, releaseBlockTime, venueHours } from "./store";
import { venueZoneOf } from "./zones";
import { addDays, isValidDateString, todayISO } from "./time";
import { formatMinute, hoursOf, instantOf, minutesOf } from "./interval";
import { type Sport } from "./types";
import type { Level } from "./games";
import { categoryRefusal, isCategory, isPartnerGender, type Category } from "./who";
import { money } from "./region";
import { groupResultsVoid, parseRules, readRules, type CompetitionRules, type OutReason, type OutStage } from "./tournament-rules";

/**
 * Tournaments run by venues.
 *
 * A venue sets one up — sport, singles or doubles, level, entry fee, how many
 * may enter, the days and hours, and which courts — and those hours are held
 * at once, as blocks, so nobody books over them. Players enter with their
 * account (and name a partner for doubles), and pay the fee online to the
 * venue or at its counter; past the limit they wait, and move up when
 * somebody withdraws.
 *
 * Staff make the draw: a straight knockout, or round-robin groups whose best
 * go through to one. Seeds are kept apart and get the byes; everybody else
 * is drawn by lot. Every match is given a court and an hour within those
 * held, with nobody playing twice at once and no round before the one it
 * follows — or the draw says how many matches did not fit — and the held
 * hours no match will use go back on sale, then more as results come in
 * (releaseUnneeded). Staff enter each
 * result; winners move on by themselves, groups fill the knockout when their
 * last match is in, and the public page shows it all as it happens.
 */

export type Format = "knockout" | "groups";
export type TournamentStatus = "open" | "closed" | "drawn" | "finished" | "cancelled";
export type EntryStatus = "entered" | "waitlisted" | "withdrawn";

export interface Tournament {
  id: number;
  venueId: number;
  venueName: string;
  area: string;
  name: string;
  sport: Sport;
  format: Format;
  teamSize: 1 | 2;
  /** Open, women's, men's, or mixed doubles (lib/who.ts). */
  category: Category;
  level: Level | null;
  entryFee: number;
  maxEntries: number;
  groupSize: number;
  advance: number;
  startsOn: string;
  endsOn: string;
  /** The time of each day it holds its courts, in minutes of the day and in hours. */
  startMin: number;
  endMin: number;
  startHour: number;
  endHour: number;
  /** How long each match is given on court. */
  matchMinutes: number;
  description: string | null;
  status: TournamentStatus;
  courtIds: number[];
  entered: number;
  waitlisted: number;
  payOnline: boolean;
  /** How it treats somebody who leaves (lib/tournament-rules.ts). */
  rules: CompetitionRules;
}

export interface Entry {
  id: number;
  name: string;
  status: EntryStatus;
  seed: number | null;
  paid: boolean;
  /** Only for staff, and for the player themselves. */
  userId?: number | null;
  /** Why they are out, and when: null while they are in (or waiting). */
  out: { reason: OutReason; stage: OutStage | null } | null;
}

/** A line of a group's table: who is out is shown where their results put them, never ranked to go through. */
export type GroupStanding = Standing & { out: OutReason | null; resultsVoid: boolean };

export interface Match {
  id: number;
  stage: "group" | "knockout";
  groupNo: number | null;
  round: number;
  position: number;
  a: number | null;
  b: number | null;
  courtId: number | null;
  courtName: string | null;
  date: string | null;
  /** When it starts, in minutes of the day and in hours. */
  minute: number | null;
  hour: number | null;
  score: string | null;
  winner: number | null;
  status: "scheduled" | "done" | "walkover" | "bye" | "retired";
}

export interface TournamentDetail extends Tournament {
  entries: Entry[];
  matches: Match[];
  /** Each group's table, once the draw is made. */
  groups: { groupNo: number; table: GroupStanding[] }[];
  /** Corrections made after the knockout began; why, and what they changed, only for staff. */
  /** `knockout`: the match corrected was a knockout match, so "standings_only" corrected its record only. */
  corrections: { kind: "replace" | "standings_only"; knockout: boolean; createdAt: string; reason?: string; changes?: string[] }[];
}

const T_SELECT = `
  SELECT t.*, v.name AS venue_name, v.area,
         (SELECT COUNT(*)::int FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status = 'entered') AS entered,
         (SELECT COUNT(*)::int FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status = 'waitlisted') AS waitlisted,
         ARRAY(SELECT court_id FROM tournament_courts tc WHERE tc.tournament_id = t.id ORDER BY court_id) AS court_ids,
         EXISTS (SELECT 1 FROM venue_payment_accounts a WHERE a.venue_id = v.id AND a.enabled = 1) AS pay_online
    FROM tournaments t JOIN venues v ON v.id = t.venue_id`;

interface TRow {
  id: number;
  venue_id: number;
  venue_name: string;
  area: string;
  name: string;
  sport: Sport;
  format: Format;
  team_size: number;
  category: Category;
  level: Level | null;
  entry_fee: number | string;
  max_entries: number;
  group_size: number;
  advance: number;
  starts_on: string;
  ends_on: string;
  start_min: number;
  end_min: number;
  match_minutes: number;
  description: string | null;
  status: TournamentStatus;
  court_ids: number[];
  entered: number;
  waitlisted: number;
  pay_online: boolean;
  rules: string | null;
}

function toTournament(r: TRow): Tournament {
  return {
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name,
    area: r.area,
    name: r.name,
    sport: r.sport,
    format: r.format,
    teamSize: r.team_size === 2 ? 2 : 1,
    category: r.category ?? "open",
    level: r.level,
    entryFee: Number(r.entry_fee),
    maxEntries: r.max_entries,
    groupSize: r.group_size,
    advance: r.advance,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    startMin: r.start_min,
    endMin: r.end_min,
    startHour: hoursOf(r.start_min),
    endHour: hoursOf(r.end_min),
    matchMinutes: r.match_minutes ?? 60,
    description: r.description,
    status: r.status,
    courtIds: (r.court_ids ?? []).map(Number),
    entered: r.entered,
    waitlisted: r.waitlisted,
    payOnline: Boolean(r.pay_online),
    rules: readRules(r.rules),
  };
}

export async function tournamentById(id: number): Promise<Tournament | null> {
  const row = (await getDb().prepare(`${T_SELECT} WHERE t.id = ?`).get(id)) as TRow | undefined;
  return row ? toTournament(row) : null;
}

/** A venue's own tournaments, newest first, for its staff. */
export async function listTournaments(venueIds: number[]): Promise<Tournament[]> {
  if (venueIds.length === 0) return [];
  return (
    (await getDb()
      .prepare(`${T_SELECT} WHERE t.venue_id IN (${venueIds.map(() => "?").join(",")}) ORDER BY t.starts_on DESC, t.id DESC`)
      .all(...venueIds)) as TRow[]
  ).map(toTournament);
}

/** Tournaments the public can see: coming up, or just played, at venues customers can reach. */
export async function publicTournaments(filter: { sport?: Sport; venueIds?: number[] } = {}): Promise<Tournament[]> {
  const clauses = [listRule(filter.venueIds), "t.status <> 'cancelled'", "t.ends_on >= ?"];
  const params: (string | number)[] = [addDays(todayISO(), -7)];
  if (filter.sport) {
    clauses.push("t.sport = ?");
    params.push(filter.sport);
  }
  if (filter.venueIds) {
    if (filter.venueIds.length === 0) return [];
    clauses.push(`t.venue_id IN (${filter.venueIds.map(() => "?").join(",")})`);
    params.push(...filter.venueIds);
  }
  return (
    (await getDb()
      .prepare(`${T_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY t.starts_on, t.id LIMIT 100`)
      .all(...params)) as TRow[]
  ).map(toTournament);
}

export async function tournamentDetail(id: number, opts: { forStaff?: boolean } = {}): Promise<TournamentDetail | null> {
  const t = await tournamentById(id);
  if (!t) return null;
  const db = getDb();
  const entries = (
    (await db
      .prepare(
        `SELECT id, name, status, seed, paid_at, user_id, out_reason, out_stage FROM tournament_entries
          WHERE tournament_id = ? ORDER BY status = 'entered' DESC, seed NULLS LAST, id`
      )
      .all(id)) as {
      id: number;
      name: string;
      status: EntryStatus;
      seed: number | null;
      paid_at: string | null;
      user_id: number | null;
      out_reason: OutReason | null;
      out_stage: OutStage | null;
    }[]
  ).map((e) => ({
    id: e.id,
    name: e.name,
    status: e.status,
    seed: e.seed,
    paid: e.paid_at !== null,
    ...(opts.forStaff ? { userId: e.user_id } : {}),
    out: e.status === "withdrawn" ? { reason: e.out_reason ?? "withdrawn", stage: e.out_stage } : null,
  }));
  const matches = await matchesOf(id);
  // Whoever is out goes no further. Their group results stand or are void by
  // the tournament's rules; standing, they are shown where those results put
  // them, flagged, and the next in the table goes through instead (B10).
  const out = new Map(entries.filter((e) => e.out).map((e) => [e.id, e.out!]));
  const voided = new Set([...out].filter(([, o]) => groupResultsVoid(t.rules, o.reason, o.stage)).map(([id]) => id));
  const groups = [...new Set(matches.filter((m) => m.stage === "group").map((m) => m.groupNo!))].sort((a, b) => a - b).map((g) => {
    const inGroup = matches.filter((m) => m.stage === "group" && m.groupNo === g);
    const ids = [...new Set(inGroup.flatMap((m) => [m.a!, m.b!]))];
    const table = standings(
      ids,
      inGroup
        .filter((m) => !voided.has(m.a!) && !voided.has(m.b!))
        // A match one side stopped part-way counts as won, without its partial score.
        .map((m) => ({ a: m.a!, b: m.b!, winner: m.winner, score: m.status === "retired" ? null : m.score }))
    ).map((s) => ({ ...s, out: out.get(s.entryId)?.reason ?? null, resultsVoid: voided.has(s.entryId) }));
    // Void results leave nothing to rank by: listed after everybody whose results count.
    return { groupNo: g, table: [...table.filter((s) => !s.resultsVoid), ...table.filter((s) => s.resultsVoid)] };
  });
  const corrections = (
    (await db
      .prepare(
        `SELECT c.kind, c.reason, c.changes, c.created_at, m.stage FROM tournament_corrections c
           LEFT JOIN tournament_matches m ON m.id = c.match_id WHERE c.tournament_id = ? ORDER BY c.id`
      )
      .all(id)) as { kind: "replace" | "standings_only"; reason: string; changes: string; created_at: string; stage: string | null }[]
  ).map((c) => ({
    kind: c.kind,
    knockout: c.stage === "knockout",
    createdAt: c.created_at,
    ...(opts.forStaff ? { reason: c.reason, changes: JSON.parse(c.changes) as string[] } : {}),
  }));
  return { ...t, entries, matches, groups, corrections };
}

async function matchesOf(tournamentId: number): Promise<Match[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT m.*, c.name AS court_name FROM tournament_matches m LEFT JOIN courts c ON c.id = m.court_id
        WHERE m.tournament_id = ? ORDER BY m.stage = 'knockout', m.round, m.group_no, m.position`
    )
    .all(tournamentId)) as {
    id: number;
    stage: "group" | "knockout";
    group_no: number | null;
    round: number;
    position: number;
    entry_a: number | null;
    entry_b: number | null;
    court_id: number | null;
    court_name: string | null;
    date: string | null;
    start_min: number | null;
    score: string | null;
    winner: number | null;
    status: Match["status"];
  }[];
  return rows.map((r) => ({
    id: r.id,
    stage: r.stage,
    groupNo: r.group_no,
    round: r.round,
    position: r.position,
    a: r.entry_a,
    b: r.entry_b,
    courtId: r.court_id,
    courtName: r.court_name,
    date: r.date,
    minute: r.start_min,
    hour: r.start_min === null ? null : hoursOf(r.start_min),
    score: r.score,
    winner: r.winner,
    status: r.status,
  }));
}

// ------------------------------------------------------------ setting one up

export type Result<T = Tournament> = { ok: true; value: T } | { ok: false; error: string; clashes?: number; code?: string };

export interface TournamentInput {
  venueId: number;
  name: string;
  sport: Sport;
  format: Format;
  teamSize: 1 | 2;
  category?: Category;
  level: Level | null;
  entryFee: number;
  maxEntries: number;
  groupSize?: number;
  advance?: number;
  startsOn: string;
  endsOn: string;
  /** The time each day, in minutes of the day (or hours, the older way). */
  startMin?: number;
  endMin?: number;
  startHour?: number;
  endHour?: number;
  /** How long each match is given on court; an hour unless said. */
  matchMinutes?: number;
  courtIds: number[];
  description?: string;
  /** How it treats somebody who leaves; the defaults unless said (lib/tournament-rules.ts). */
  rules?: CompetitionRules;
}

/** The time zone of the venue running a tournament. */
async function tournamentZone(tournamentId: number): Promise<string> {
  const row = (await getDb().prepare("SELECT venue_id FROM tournaments WHERE id = ?").get(tournamentId)) as { venue_id: number } | undefined;
  return (await venueHours(row?.venue_id ?? 0)).zone;
}

/** Every day, court and match slot a tournament would hold: one match long each, from the start of its time. */
function heldSlots(t: { startsOn: string; endsOn: string; startMin: number; endMin: number; matchMinutes: number; courtIds: number[] }): Slot[] {
  const slots: Slot[] = [];
  for (let d = t.startsOn; d <= t.endsOn; d = addDays(d, 1))
    for (let m = t.startMin; m + t.matchMinutes <= t.endMin; m += t.matchMinutes) for (const c of t.courtIds) slots.push({ courtId: c, date: d, minute: m });
  return slots;
}

export async function createTournament(input: TournamentInput, adminId: number): Promise<Result> {
  const db = getDb();
  const name = input.name.trim();
  if (name.length < 3 || name.length > 100) return { ok: false, error: "Give it a name." };
  if (!(await isActivity(input.sport))) return { ok: false, error: "Unknown sport." };
  if (input.format !== "knockout" && input.format !== "groups") return { ok: false, error: "Knockout, or groups then knockout." };
  const category = input.category ?? "open";
  if (!isCategory(category)) return { ok: false, error: "Open, women's, men's or mixed." };
  if (category === "mixed" && input.teamSize !== 2) return { ok: false, error: "Mixed is doubles: one woman and one man." };
  if (!isValidDateString(input.startsOn) || !isValidDateString(input.endsOn) || input.endsOn < input.startsOn)
    return { ok: false, error: "Give the first and last day." };
  if (addDays(input.startsOn, 13) < input.endsOn) return { ok: false, error: "Two weeks at most." };
  if (!Number.isInteger(input.maxEntries) || input.maxEntries < 2 || input.maxEntries > 128)
    return { ok: false, error: "Between 2 and 128 entries." };
  if (!Number.isFinite(input.entryFee) || input.entryFee < 0 || input.entryFee > 10000) return { ok: false, error: "Check the entry fee." };
  const venue = (await db
    .prepare("SELECT open_min, close_min, week_hours, time_zone, lat, lng FROM venues WHERE id = ?")
    .get(input.venueId)) as
    | { open_min: number; close_min: number; week_hours: string | null; time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  if (!venue) return { ok: false, error: "Venue not found." };
  // Today where the venue is.
  if (input.startsOn <= todayISO(venueZoneOf(venue))) return { ok: false, error: "It has to start after today, so players can enter." };
  const startMin = input.startMin ?? (input.startHour === undefined ? NaN : minutesOf(input.startHour));
  const endMin = input.endMin ?? (input.endHour === undefined ? NaN : minutesOf(input.endHour));
  const matchMinutes = input.matchMinutes ?? 60;
  if (!Number.isInteger(matchMinutes) || matchMinutes < 5 || matchMinutes > 600) return { ok: false, error: "Give each match 5 minutes to 10 hours." };
  if (!(endMin > startMin)) return { ok: false, error: "The hours must be within the venue's opening hours." };
  if (endMin - startMin < matchMinutes) return { ok: false, error: "The time each day must fit at least one match." };
  // Every day of it, by that day's own hours.
  const usual = { openMin: venue.open_min, closeMin: venue.close_min, weekHours: parseWeekHours(venue.week_hours) };
  for (let d = input.startsOn; d <= input.endsOn; d = addDays(d, 1)) {
    const on = hoursOn(usual, d);
    if (on.closed) return { ok: false, error: `The venue is closed on ${d}.` };
    if (startMin < on.openMin || endMin > on.closeMin)
      return { ok: false, error: `The hours must be within the venue's opening hours, which on ${d} are ${formatMinute(on.openMin)}–${formatMinute(on.closeMin)}.` };
  }
  const courtIds = [...new Set(input.courtIds)];
  if (courtIds.length === 0) return { ok: false, error: "Hold at least one court." };
  const courts = (await db
    .prepare(
      `SELECT c.id FROM courts c WHERE c.venue_id = ? AND EXISTS (SELECT 1 FROM court_activities ca WHERE ca.court_id = c.id AND ca.sport = ?)
          AND c.id IN (${courtIds.map(() => "?").join(",")})`
    )
    .all(input.venueId, input.sport, ...courtIds)) as { id: number }[];
  if (courts.length !== courtIds.length) return { ok: false, error: "Hold only this venue's courts for that sport." };

  // A court out of service on any of those days cannot be held for them.
  // Out of service, or already booked in those hours: say so, rather than
  // hold over it. Asked again inside the transaction that holds the hours, so
  // a booking or an outage made meanwhile is seen there.
  const inTheWay = async (): Promise<{ ok: false; error: string; clashes?: number } | null> => {
    const out = (await db
      .prepare(
        `SELECT c.name FROM court_outages o JOIN courts c ON c.id = o.court_id
          WHERE o.court_id IN (${courtIds.map(() => "?").join(",")})
            AND o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?) LIMIT 1`
      )
      .get(...courtIds, input.endsOn, input.startsOn)) as { name: string } | undefined;
    if (out) return { ok: false, error: `${out.name} is out of service then. Choose other courts or days.` };
    // Bookings holding these courts' spaces in that time each day, a court sharing their floor's too.
    const { clashes } = (await db
      .prepare(
        `SELECT COUNT(DISTINCT b.id)::int AS clashes FROM claims c JOIN bookings b ON b.id = c.booking_id
          WHERE c.active
            AND (c.space_id IN (SELECT space_id FROM court_spaces WHERE court_id IN (${courtIds.map(() => "?").join(",")}))
                 OR (c.space_id IS NULL AND c.court_id IN (${courtIds.map(() => "?").join(",")})))
            AND b.date >= ? AND b.date <= ? AND b.start_min < ? AND b.end_min > ?`
      )
      .get(...courtIds, ...courtIds, input.startsOn, input.endsOn, endMin, startMin)) as { clashes: number };
    if (clashes > 0)
      return {
        ok: false,
        error: `${clashes === 1 ? "A booking is" : `${clashes} bookings are`} already in those hours. Move ${clashes === 1 ? "it" : "them"}, or choose other hours or courts.`,
        clashes,
      };
    return null;
  };
  const before = await inTheWay();
  if (before) return before;

  let id = 0;
  const refused = await db.transaction(async () => {
    const meanwhile = await inTheWay();
    if (meanwhile) return meanwhile;
    const info = await db
      .prepare(
        `INSERT INTO tournaments (venue_id, name, sport, format, team_size, category, level, entry_fee, max_entries, group_size, advance,
                                  starts_on, ends_on, start_min, end_min, match_minutes, description, created_by, rules)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.venueId,
        name,
        input.sport,
        input.format,
        input.teamSize === 2 ? 2 : 1,
        category,
        input.level,
        Math.round(input.entryFee * 100) / 100,
        input.maxEntries,
        Math.min(Math.max(input.groupSize ?? 4, 3), 6),
        input.advance === 1 ? 1 : 2,
        input.startsOn,
        input.endsOn,
        startMin,
        endMin,
        matchMinutes,
        input.description?.trim().slice(0, 2000) || null,
        adminId,
        input.rules ? JSON.stringify(input.rules) : null
      );
    id = info.lastInsertRowid as number;
    for (const c of courtIds) await db.prepare("INSERT INTO tournament_courts (tournament_id, court_id) VALUES (?, ?)").run(id, c);
    // The time, held each day on each court. Time staff had already blocked
    // stays theirs, and is simply not time the draw can use.
    for (let d = input.startsOn; d <= input.endsOn; d = addDays(d, 1))
      for (const c of courtIds) {
        const held = await blockSlots(c, d, { start: startMin, end: endMin }, `Tournament: ${name}`, undefined, { tournamentId: id });
        if (!held.ok) throw new Error(held.error);
      }
    return null;
  })();
  if (refused) return refused;
  return { ok: true, value: (await tournamentById(id))! };
}

/** No more entries; the draw comes next. */
export async function closeEntries(id: number): Promise<Result> {
  const done = await getDb().prepare("UPDATE tournaments SET status = 'closed' WHERE id = ? AND status = 'open'").run(id);
  if (done.changes === 0) return { ok: false, error: "Entries are not open." };
  return { ok: true, value: (await tournamentById(id))! };
}

/** Called off: the courts go back, entrants hear, and fees paid online are owed back. */
export async function cancelTournament(id: number): Promise<Result> {
  const db = getDb();
  const t = await tournamentById(id);
  if (!t || t.status === "cancelled" || t.status === "finished") return { ok: false, error: "That cannot be called off now." };
  const freed = (await db
    .prepare("SELECT DISTINCT court_id, date FROM blocks WHERE tournament_id = ? AND date >= ?")
    .all(id, todayISO())) as { court_id: number; date: string }[];
  await db.transaction(async () => {
    await db.prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").run(id);
    // Its holds go, and their claims with them.
    await db.prepare("DELETE FROM blocks WHERE tournament_id = ?").run(id);
    await db
      .prepare(
        `UPDATE online_payments SET refund_due = amount
          WHERE purpose = 'entry' AND status = 'paid'
            AND tournament_entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id = ? AND status <> 'withdrawn')`
      )
      .run(id);
  })();
  // Whoever is waiting for one of those courts is offered it.
  for (const day of freed) await offerSlotPlace(day.court_id, day.date);
  for (const userId of await entrants(id)) await tellEntrant(userId, t, `${t.name} is called off`, `${t.name} at ${t.venueName} has been called off. Any entry fee you paid online will be refunded by the venue.`);
  return { ok: true, value: (await tournamentById(id))! };
}

// ------------------------------------------------------------ entries

export async function enter(
  user: { id: number; name: string },
  tournamentId: number,
  input: { partnerName?: string; partnerGender?: string } = {}
): Promise<Result<Entry>> {
  const db = getDb();
  const t = await tournamentById(tournamentId);
  if (!t || t.status !== "open") return { ok: false, error: "Entries are not open." };
  // A women's event takes women; mixed doubles, a woman and a man.
  const partnerGender = isPartnerGender(input.partnerGender) ? input.partnerGender : null;
  const notFor = await categoryRefusal(user.id, t.category, t.teamSize === 2 ? { partnerGender } : null);
  if (notFor) return { ok: false, error: notFor.error, code: notFor.code };
  const open = (await db
    .prepare(`SELECT (${OPEN_TO_CUSTOMERS}) AS open FROM venues v WHERE v.id = ?`)
    .get(t.venueId)) as { open: boolean };
  if (!open.open) return { ok: false, error: "That venue is not taking entries at the moment." };
  const notHere = await accessRefusal(t.venueId, user.id);
  if (notHere) return { ok: false, error: notHere.error, code: notHere.code };
  const partner = input.partnerName?.trim() ?? "";
  if (t.teamSize === 2 && (partner.length < 2 || partner.length > 60)) return { ok: false, error: "Name your partner." };
  if (await db.prepare("SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND user_id = ? AND status <> 'withdrawn'").get(tournamentId, user.id))
    return { ok: false, error: "You have entered already." };
  const status: EntryStatus = t.entered >= t.maxEntries ? "waitlisted" : "entered";
  const name = t.teamSize === 2 ? `${user.name.trim()} / ${partner}` : user.name.trim();
  const info = await db
    .prepare("INSERT INTO tournament_entries (tournament_id, user_id, name, partner_name, partner_gender, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(tournamentId, user.id, name.slice(0, 130), partner || null, t.teamSize === 2 ? partnerGender : null, status);
  await tellEntrant(
    user.id,
    t,
    status === "entered" ? `You're entered: ${t.name}` : `You're on the waiting list: ${t.name}`,
    status === "entered"
      ? `You're entered in ${t.name} at ${t.venueName}, ${t.startsOn}.` +
          (t.entryFee > 0 ? ` The entry fee is ${money(t.entryFee.toFixed(2))}${t.payOnline ? "; pay it from the tournament's page" : ", paid at the venue"}.` : "") +
          " You'll hear your first match once the draw is made."
      : `${t.name} is full, so you're on its waiting list. If somebody withdraws, you're in, and we'll tell you.`
  );
  return { ok: true, value: (await entryById(info.lastInsertRowid as number))! };
}

async function entryById(id: number): Promise<Entry | null> {
  const r = (await getDb()
    .prepare("SELECT id, name, status, seed, paid_at, user_id, out_reason, out_stage FROM tournament_entries WHERE id = ?")
    .get(id)) as
    | {
        id: number;
        name: string;
        status: EntryStatus;
        seed: number | null;
        paid_at: string | null;
        user_id: number | null;
        out_reason: OutReason | null;
        out_stage: OutStage | null;
      }
    | undefined;
  return r
    ? {
        id: r.id,
        name: r.name,
        status: r.status,
        seed: r.seed,
        paid: r.paid_at !== null,
        userId: r.user_id,
        out: r.status === "withdrawn" ? { reason: r.out_reason ?? "withdrawn", stage: r.out_stage } : null,
      }
    : null;
}

/** The player's own entry in a tournament, if they have one. */
export async function myEntry(userId: number, tournamentId: number): Promise<Entry | null> {
  const r = (await getDb()
    .prepare("SELECT id FROM tournament_entries WHERE tournament_id = ? AND user_id = ? AND status <> 'withdrawn' ORDER BY id DESC LIMIT 1")
    .get(tournamentId, userId)) as { id: number } | undefined;
  return r ? await entryById(r.id) : null;
}

/**
 * Its rules, changed before the draw (after it, results already depend on
 * them). Null for the defaults.
 */
export async function setRules(tournamentId: number, input: unknown): Promise<Result> {
  const t = await tournamentById(tournamentId);
  if (!t) return { ok: false, error: "Tournament not found." };
  if (t.status !== "open" && t.status !== "closed") return { ok: false, error: "The draw is made: its rules stand as they were." };
  const parsed = parseRules(input);
  if (!parsed.ok) return parsed;
  await getDb().prepare("UPDATE tournaments SET rules = ? WHERE id = ?").run(JSON.stringify(parsed.rules), tournamentId);
  return { ok: true, value: (await tournamentById(tournamentId))! };
}

/** Out, as a player who withdrew. Kept for the callers that only ever meant that. */
export async function withdraw(entryId: number): Promise<Result<Entry>> {
  const done = await takeOut(entryId, "withdrawn");
  return done.ok ? { ok: true, value: done.value.entry } : done;
}

/**
 * Out of the competition: withdrew, retired (stopped, injured), or was
 * disqualified. Before the draw, the place goes to whoever has waited
 * longest, and a fee paid online is owed back if the rules say so. After
 * it, they go no further: each group match they have left is a walkover to
 * the other side; their group results stand or are void by the rules; they
 * never take a place that sends somebody on (the next in their table does);
 * a knockout not yet played is filled again without them; and a knockout
 * match against them is a walkover as soon as the other side is known.
 * Knockout results already played stand. All one change, and what it
 * changed is said back, sentence by sentence, for the organiser.
 */
export function takeOut(entryId: number, reason: OutReason, note?: string): Promise<Result<{ entry: Entry; changes: string[] }>> {
  return withTransaction(async () => {
    const before = await detailForEntry(entryId);
    const done = await takeOutOnce(entryId, reason, note);
    if (!done.ok) return done;
    const after = before ? (await tournamentDetail(before.id, { forStaff: true }))! : null;
    return { ok: true, value: { entry: done.value, changes: before && after ? describeChanges(before, after) : [] } };
  });
}

/** What taking somebody out would change, without changing anything. */
export async function previewTakeOut(entryId: number, reason: OutReason): Promise<Result<{ changes: string[] }>> {
  return dryRun(async () => {
    const before = await detailForEntry(entryId);
    const done = await takeOutOnce(entryId, reason);
    if (!done.ok) return done;
    const after = before ? (await tournamentDetail(before.id, { forStaff: true }))! : null;
    return { ok: true, value: { changes: before && after ? describeChanges(before, after) : [] } };
  });
}

async function detailForEntry(entryId: number): Promise<TournamentDetail | null> {
  const r = (await getDb().prepare("SELECT tournament_id FROM tournament_entries WHERE id = ?").get(entryId)) as { tournament_id: number } | undefined;
  return r ? await tournamentDetail(r.tournament_id, { forStaff: true }) : null;
}

async function takeOutOnce(entryId: number, reason: OutReason, note?: string): Promise<Result<Entry>> {
  const db = getDb();
  const row = (await db
    .prepare("SELECT e.id, e.status, e.tournament_id FROM tournament_entries e WHERE e.id = ?")
    .get(entryId)) as { id: number; status: EntryStatus; tournament_id: number } | undefined;
  if (!row || row.status === "withdrawn") return { ok: false, error: "That entry is not in." };
  const t = (await tournamentById(row.tournament_id))!;
  if (t.status === "finished" || t.status === "cancelled") return { ok: false, error: "That tournament is over." };
  const stage: OutStage = t.status !== "drawn" ? "before_draw" : (await knockoutStarted(t.id)) || t.format === "knockout" ? "knockout" : "groups";

  await db
    .prepare("UPDATE tournament_entries SET status = 'withdrawn', out_reason = ?, out_stage = ?, out_at = datetime('now'), out_note = ? WHERE id = ?")
    .run(reason, stage, note?.trim().slice(0, 500) || null, entryId);
  if (t.status === "drawn") {
    const pending = (await db
      .prepare(
        `SELECT id, entry_a, entry_b FROM tournament_matches
          WHERE tournament_id = ? AND stage = 'group' AND status = 'scheduled' AND (entry_a = ? OR entry_b = ?)`
      )
      .all(t.id, entryId, entryId)) as { id: number; entry_a: number | null; entry_b: number | null }[];
    for (const m of pending) await decide(m.id, m.entry_a === entryId ? m.entry_b! : m.entry_a!, null, "walkover");
    await afterChange(t.id, true);
    return { ok: true, value: (await entryById(entryId))! };
  }

  if (t.rules.refundBeforeDraw)
    await db
      .prepare("UPDATE online_payments SET refund_due = amount WHERE purpose = 'entry' AND status = 'paid' AND tournament_entry_id = ?")
      .run(entryId);
  if (row.status === "entered") {
    const next = (await db
      .prepare("SELECT id, user_id FROM tournament_entries WHERE tournament_id = ? AND status = 'waitlisted' ORDER BY id LIMIT 1")
      .get(t.id)) as { id: number; user_id: number | null } | undefined;
    if (next) {
      await db.prepare("UPDATE tournament_entries SET status = 'entered' WHERE id = ?").run(next.id);
      if (next.user_id) await tellEntrant(next.user_id, t, `You're in: ${t.name}`, `A place came free in ${t.name} at ${t.venueName}, and it's yours.`);
    }
  }
  return { ok: true, value: (await entryById(entryId))! };
}

/** Thrown to undo whatever a dry run did, carrying what it found. */
class DryRun<T> extends Error {
  readonly value: T;
  constructor(value: T) {
    super("dry run");
    this.value = value;
  }
}

/** Do it in a transaction, see what it did, and undo it all. */
async function dryRun<T>(fn: () => Promise<T>): Promise<T> {
  try {
    await withTransaction(async () => {
      throw new DryRun(await fn());
    });
  } catch (err) {
    if (err instanceof DryRun) return err.value as T;
    throw err;
  }
  throw new Error("unreachable");
}

/** A match, as an organiser names it. */
function matchName(d: TournamentDetail, m: Match): string {
  if (m.stage === "group") return `Group ${m.groupNo}`;
  const rounds = Math.max(...d.matches.filter((x) => x.stage === "knockout").map((x) => x.round));
  const from = rounds - m.round;
  return from === 0 ? "Final" : from === 1 ? `Semi-final ${m.position}` : from === 2 ? `Quarter-final ${m.position}` : `Knockout round ${m.round}, match ${m.position}`;
}

/**
 * What changed between two states of a tournament, as sentences for its
 * organiser: matches given, changed or filled differently; who now goes
 * through from each group; who is out, and whether their results count.
 */
export function describeChanges(before: TournamentDetail, after: TournamentDetail): string[] {
  const name = (id: number | null) => (id === null ? "nobody" : after.entries.find((e) => e.id === id)?.name ?? `#${id}`);
  const outcome = (m: Match) =>
    m.status === "scheduled"
      ? "to play"
      : m.status === "bye"
        ? m.winner === null
          ? "nobody goes through"
          : `a bye for ${name(m.winner)}`
        : m.status === "walkover"
          ? `a walkover to ${name(m.winner)}`
          : m.status === "retired"
            ? `won by ${name(m.winner)} (the other side retired)`
            : `won by ${name(m.winner)}${m.score ? ` ${m.score}` : ""}`;
  const out: string[] = [];
  for (const e of after.entries) {
    const was = before.entries.find((x) => x.id === e.id);
    if (e.out && !was?.out) {
      const voidNow = after.groups.some((g) => g.table.some((s) => s.entryId === e.id && s.resultsVoid));
      out.push(
        `${e.name} is out (${e.out.reason}${e.out.stage === "before_draw" ? ", before the draw" : e.out.stage === "groups" ? ", in the groups" : e.out.stage === "knockout" ? ", in the knockout" : ""}).` +
          (voidNow ? " Their group results no longer count, under this tournament's rules." : e.out.stage === "groups" ? " The group results they played stand." : "")
      );
    }
  }
  for (const m of after.matches) {
    const was = before.matches.find((x) => x.id === m.id);
    if (!was) continue;
    const sides = (x: Match) => `${name(x.a)} v ${name(x.b)}`;
    if (was.a !== m.a || was.b !== m.b) out.push(`${matchName(after, m)}: now ${sides(m)} (was ${sides(was)}).`);
    if (was.status !== m.status || was.winner !== m.winner || was.score !== m.score)
      out.push(`${matchName(after, m)}, ${sides(m)}: ${outcome(m)} (was ${outcome(was)}).`);
  }
  for (const g of after.groups) {
    const wasG = before.groups.find((x) => x.groupNo === g.groupNo);
    const through = (table: GroupStanding[]) => table.filter((s) => !s.out).slice(0, after.advance).map((s) => s.entryId);
    const now = through(g.table);
    const then = wasG ? through(wasG.table) : [];
    if (now.join() !== then.join()) out.push(`Group ${g.groupNo} now puts ${now.map(name).join(" and ") || "nobody"} on top (was ${then.map(name).join(" and ") || "nobody"}).`);
  }
  return out;
}

/** Is there a fee paid online for this entry or place that has not been owed back in full? */
export async function paidOnline(column: "tournament_entry_id" | "league_place_id", id: number): Promise<boolean> {
  return !!(await getDb()
    .prepare(`SELECT 1 FROM online_payments WHERE ${column} = ? AND status = 'paid' AND refund_due < amount LIMIT 1`)
    .get(id));
}

export async function setEntry(entryId: number, change: { paid?: boolean; seed?: number | null }): Promise<Result<Entry>> {
  const db = getDb();
  if (change.paid !== undefined) {
    // A fee paid online is the gateway's to give back, not a mark to take off:
    // unmarked, it would be paid again at the counter with the first never owed back.
    if (!change.paid && (await paidOnline("tournament_entry_id", entryId)))
      return { ok: false, error: "This fee was paid online. Refund it from the online payments list instead." };
    // One statement, so two marks at once receipt it once.
    const changed = await db
      .prepare(`UPDATE tournament_entries SET paid_at = ${change.paid ? "datetime('now')" : "NULL"} WHERE id = ? AND paid_at IS ${change.paid ? "NULL" : "NOT NULL"}`)
      .run(entryId);
    // Paid at the counter just now, or the mark taken back: receipted, or credited.
    if (changed.changes === 1) await receiptFee("entry", entryId, change.paid);
  }
  if (change.seed !== undefined) {
    if (change.seed !== null && (!Number.isInteger(change.seed) || change.seed < 1 || change.seed > 64))
      return { ok: false, error: "A seed is 1 or more." };
    await db.prepare("UPDATE tournament_entries SET seed = ? WHERE id = ?").run(change.seed, entryId);
  }
  const entry = await entryById(entryId);
  return entry ? { ok: true, value: entry } : { ok: false, error: "Not found." };
}

// ------------------------------------------------------------ the draw

interface NewMatch {
  key: string;
  stage: "group" | "knockout";
  groupNo: number | null;
  round: number;
  position: number;
  a: number | null;
  b: number | null;
  nextKey: string | null;
  nextSlot: "a" | "b" | null;
  after: string[];
  bye: boolean;
}

/** The skeleton of a knockout of `size` lines, round by round. */
function knockout(size: number, firstPairs: [number | null, number | null][], feedersOfRoundOne: string[]): NewMatch[] {
  const rounds = Math.log2(size);
  const out: NewMatch[] = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let p = 1; p <= count; p++) {
      const pair = r === 1 ? firstPairs[p - 1] : [null, null];
      out.push({
        key: `k${r}-${p}`,
        stage: "knockout",
        groupNo: null,
        round: r,
        position: p,
        a: pair[0],
        b: pair[1],
        nextKey: r < rounds ? `k${r + 1}-${Math.ceil(p / 2)}` : null,
        nextSlot: r < rounds ? (p % 2 === 1 ? "a" : "b") : null,
        after: r === 1 ? feedersOfRoundOne : [`k${r - 1}-${p * 2 - 1}`, `k${r - 1}-${p * 2}`],
        bye: false,
      });
    }
  }
  return out;
}

/**
 * Make the draw: seeds first in seed order, everybody else by lot; the
 * matches; and a court and an hour for each. All or nothing.
 */
export async function makeDraw(tournamentId: number, random: () => number = Math.random): Promise<Result<TournamentDetail>> {
  const db = getDb();
  const t = await tournamentById(tournamentId);
  if (!t || (t.status !== "open" && t.status !== "closed")) return { ok: false, error: "The draw is made already, or it is over." };
  const entries = (await db
    .prepare("SELECT id, seed FROM tournament_entries WHERE tournament_id = ? AND status = 'entered' ORDER BY seed NULLS LAST, id")
    .all(tournamentId)) as { id: number; seed: number | null }[];
  const minimum = t.format === "groups" ? 3 : 2;
  if (entries.length < minimum) return { ok: false, error: `At least ${minimum} entries are needed.` };
  const ranked = [...entries.filter((e) => e.seed !== null), ...shuffle(entries.filter((e) => e.seed === null), random)].map((e) => e.id);

  const matches: NewMatch[] = [];
  if (t.format === "knockout") {
    matches.push(...knockout(bracketSize(ranked.length), firstRound(ranked), []));
  } else {
    const groups = intoGroups(ranked, groupCount(ranked.length, t.groupSize));
    let longest = 0;
    groups.forEach((members, gi) => {
      const rounds = roundRobin(members.length);
      longest = Math.max(longest, rounds.length);
      rounds.forEach((pairs, ri) =>
        pairs.forEach(([x, y], pi) =>
          matches.push({
            key: `g${gi + 1}-${ri + 1}-${pi + 1}`,
            stage: "group",
            groupNo: gi + 1,
            round: ri + 1,
            position: pi + 1,
            a: members[x],
            b: members[y],
            nextKey: null,
            nextSlot: null,
            after: [],
            bye: false,
          })
        )
      );
    });
    // Round by round across the groups, so every group is played at once.
    matches.sort((x, y) => x.round - y.round || x.groupNo! - y.groupNo! || x.position - y.position);
    const qualifiers = groups.length * t.advance;
    if (qualifiers >= 2) {
      const groupKeys = matches.map((m) => m.key);
      const size = bracketSize(qualifiers);
      const lines = Array.from({ length: qualifiers }, () => null);
      // Who fills it is known only when the groups finish; byes, if any, are
      // marked then, so they still fall to the best group finishers.
      matches.push(...knockout(size, firstRound(lines).map(() => [null, null] as [null, null]), groupKeys));
    }
  }

  // Byes go straight through, before scheduling.
  for (const m of matches.filter((x) => x.stage === "knockout" && x.round === 1 && t.format === "knockout")) {
    if ((m.a === null) !== (m.b === null)) {
      m.bye = true;
      const next = matches.find((x) => x.key === m.nextKey);
      if (next) next[m.nextSlot!] = m.a ?? m.b;
    }
  }
  const byes = new Set(matches.filter((m) => m.bye).map((m) => m.key));
  const toPlay: ToSchedule[] = matches
    .filter((m) => !m.bye)
    .map((m) => ({
      key: m.key,
      sides: [m.a !== null ? `e${m.a}` : `w:${m.key}:a`, m.b !== null ? `e${m.b}` : `w:${m.key}:b`],
      after: m.after.filter((k) => !byes.has(k)),
    }));
  const zone = await tournamentZone(tournamentId);
  // The match slots wholly inside what is still held (an outage since takes its hold away).
  const holds = (await db
    .prepare("SELECT court_id, date, start_min, end_min FROM blocks WHERE tournament_id = ? ORDER BY date, start_min")
    .all(tournamentId)) as { court_id: number; date: string; start_min: number; end_min: number }[];
  const now = Date.now();
  const slots = heldSlots(t).filter(
    (s) =>
      holds.some((h) => h.court_id === s.courtId && h.date === s.date && h.start_min <= s.minute && s.minute + t.matchMinutes <= h.end_min) &&
      instantOf(s.date, s.minute, zone).getTime() > now
  );
  const scheduled = scheduleMatches(toPlay, slots);
  if (!scheduled.ok)
    return {
      ok: false,
      error: `Not enough court time: ${scheduled.unplaced} of ${toPlay.length} matches do not fit in the hours held. Add courts, hours or days, or take fewer entries.`,
    };

  await db.transaction(async () => {
    const ids = new Map<string, number>();
    // Last round first, so each match can point at the one its winner goes to.
    for (const m of [...matches].sort((x, y) => (y.stage === "knockout" ? y.round : 0) - (x.stage === "knockout" ? x.round : 0))) {
      const at = scheduled.placed.get(m.key);
      const info = await db
        .prepare(
          `INSERT INTO tournament_matches (tournament_id, stage, group_no, round, position, entry_a, entry_b,
                                           next_match_id, next_slot, court_id, date, start_min, winner, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          tournamentId,
          m.stage,
          m.groupNo,
          m.round,
          m.position,
          m.a,
          m.b,
          m.nextKey ? ids.get(m.nextKey) ?? null : null,
          m.nextSlot,
          at?.courtId ?? null,
          at?.date ?? null,
          at?.minute ?? null,
          m.bye ? (m.a ?? m.b) : null,
          m.bye ? "bye" : "scheduled"
        );
      ids.set(m.key, info.lastInsertRowid as number);
    }
    await db.prepare("UPDATE tournaments SET status = 'drawn' WHERE id = ?").run(tournamentId);
  })();

  await releaseUnneeded(tournamentId);
  const detail = (await tournamentDetail(tournamentId))!;
  await tellFirstMatches(detail);
  return { ok: true, value: detail };
}

// ------------------------------------------------------------ results

/**
 * A result: who won, and the score if there is one; or a walkover; or a
 * retirement (one side stopped part-way: the other wins, with whatever score
 * there was, and the one who stopped is out of the event too if the
 * organiser says so). The winner goes on to their next match; the last
 * group match fills the knockout; the final finishes it. A result can be
 * put right until the match it fed is played. A group result put right
 * after the knockout is filled fills it again, if nothing in it has been
 * played; once something has, a change that would alter who is in the
 * knockout is refused here (code KNOCKOUT_STARTED) and goes through the
 * correction an organiser previews and confirms instead (B9).
 */
export async function recordResult(matchId: number, input: ResultInput): Promise<Result<TournamentDetail>> {
  try {
    return await withTransaction(() => recordResultOnce(matchId, input, "normal"));
  } catch (err) {
    // Caught outside the transaction, so the result goes with it.
    if (err instanceof KnockoutUnderway) return { ok: false, error: err.message, code: "KNOCKOUT_STARTED" };
    throw err;
  }
}

export interface ResultInput {
  winner: number;
  score?: string;
  walkover?: boolean;
  /** The other side stopped part-way (injured, say). */
  retired?: boolean;
  /** With `retired`: and is out of the event, the matches they have left walkovers. */
  outOfEvent?: boolean;
}

/** Thrown to undo a group result that would change a knockout already being played. */
class KnockoutUnderway extends Error {}

/** Thrown to undo a correction that cannot be made safely, with why. */
class CorrectionBlocked extends Error {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super("blocked");
    this.blockers = blockers;
  }
}

/**
 * How a result goes in. "normal": as above. After the knockout has begun,
 * an organiser's correction: "replace" puts the group's new qualifiers into
 * the knockout where every match that changes is still to be played (and
 * still has its court), else it is blocked with the reasons; "standings_only"
 * corrects the group and leaves the knockout as it is being played. For a
 * knockout match whose next match has been played, "standings_only" corrects
 * that match's record only: who goes on is not changed, since the match after
 * it was played by whoever did.
 */
type ResultMode = "normal" | "replace" | "standings_only";

async function recordResultOnce(matchId: number, input: ResultInput, mode: ResultMode): Promise<Result<TournamentDetail>> {
  const db = getDb();
  const m = (await db.prepare("SELECT * FROM tournament_matches WHERE id = ?").get(matchId)) as
    | { id: number; tournament_id: number; stage: string; entry_a: number | null; entry_b: number | null; next_match_id: number | null; status: string }
    | undefined;
  if (!m) return { ok: false, error: "Match not found." };
  const t = (await tournamentById(m.tournament_id))!;
  if (t.status !== "drawn" && t.status !== "finished") return { ok: false, error: "The draw is not made." };
  if (m.status === "bye") return { ok: false, error: "That is a bye." };
  if (m.entry_a === null || m.entry_b === null) return { ok: false, error: "Both sides are not known yet." };
  if (input.winner !== m.entry_a && input.winner !== m.entry_b) return { ok: false, error: "The winner has to be one of the two." };
  if (mode === "replace" && m.stage !== "group")
    return { ok: false, error: "The match it fed has been played, so the knockout after it stands as played; a replay is arranged by hand." };
  const score = input.score?.trim() || null;
  if (score) {
    const parsed = parseScore(score);
    if (!parsed) return { ok: false, error: 'Write the score as sets, like "21-15, 18-21, 21-10".' };
    const winnerSets = input.winner === m.entry_a ? parsed.setsA : parsed.setsB;
    const loserSets = input.winner === m.entry_a ? parsed.setsB : parsed.setsA;
    // A retirement stops part-way: the score is what was played, whoever led.
    if (!input.retired && winnerSets <= loserSets) return { ok: false, error: "That score says the other side won." };
  } else if (!input.walkover && !input.retired) return { ok: false, error: "Give the score, or mark it a walkover or a retirement." };
  let recordOnly = false;
  if (m.next_match_id !== null) {
    const next = (await db.prepare("SELECT status FROM tournament_matches WHERE id = ?").get(m.next_match_id)) as { status: string };
    if (next.status === "done" || next.status === "walkover" || next.status === "retired") {
      if (mode === "normal")
        throw new KnockoutUnderway(
          "The next match is played already. A manager can review what correcting this result would change, and correct its record without changing who went on."
        );
      recordOnly = true;
    }
  }
  if (recordOnly && input.outOfEvent) return { ok: false, error: "A correction of the record only cannot take anybody out of the event; withdraw them instead." };
  const loser = input.winner === m.entry_a ? m.entry_b : m.entry_a;
  const before = m.stage === "group" ? qualifiers((await tournamentDetail(t.id))!, t.advance) : null;
  await decide(matchId, input.winner, score, input.retired ? "retired" : input.walkover ? "walkover" : "done", !recordOnly);
  if (input.retired && input.outOfEvent) {
    const out = await takeOutOnce(loser, "retired");
    if (!out.ok) return out;
  }
  if (mode === "replace") await replaceQualifiers(t.id);
  await afterChange(t.id, m.stage === "group" && mode === "normal");
  const after = (await tournamentDetail(t.id, { forStaff: true }))!;
  if (before && mode === "normal") {
    const wanted = qualifiers(after, t.advance)!;
    // The knockout could not be filled again, and this result is why.
    if (!samePairs(before, wanted) && !samePairs(firstRoundOf(after), wanted)) {
      throw new KnockoutUnderway(
        "The knockout has started, and this result would change who is in it. A manager can review what it would change and correct it, in the knockout where that is still safe or in the group table only."
      );
    }
  }
  return { ok: true, value: after };
}

/**
 * Put the groups' qualifiers into a knockout already being played, where
 * that is safe: each first-round match whose players change must still be
 * to play, with its court. Anything else is blocked, with why, and the
 * organiser resolves it by hand.
 */
async function replaceQualifiers(tournamentId: number): Promise<void> {
  const db = getDb();
  const t = (await tournamentById(tournamentId))!;
  const d = (await tournamentDetail(tournamentId))!;
  const wanted = qualifiers(d, t.advance);
  if (!wanted) throw new CorrectionBlocked(["The groups are not finished, so there is nothing to put into the knockout yet."]);
  const firstRound = d.matches.filter((x) => x.stage === "knockout" && x.round === 1).sort((x, y) => x.position - y.position);
  const name = (id: number | null) => (id === null ? "nobody" : d.entries.find((e) => e.id === id)?.name ?? `#${id}`);
  const blockers: string[] = [];
  const changes: { id: number; a: number | null; b: number | null }[] = [];
  firstRound.forEach((x, i) => {
    const [a, b] = wanted[i];
    if (x.a === a && x.b === b) return;
    if (x.status !== "scheduled")
      blockers.push(`${matchName(d, x)}, ${name(x.a)} v ${name(x.b)}, has been ${x.status === "bye" ? "given as a bye" : "decided"}: it would need replaying as ${name(a)} v ${name(b)}.`);
    else if (x.courtId === null || a === null || b === null) blockers.push(`${matchName(d, x)} would become ${name(a)} v ${name(b)}, which has no court held for it.`);
    else changes.push({ id: x.id, a, b });
  });
  if (blockers.length > 0) throw new CorrectionBlocked(blockers);
  for (const c of changes) await db.prepare("UPDATE tournament_matches SET entry_a = ?, entry_b = ?, updated_at = datetime('now') WHERE id = ?").run(c.a, c.b, c.id);
}

/** A fingerprint of the tournament as it stands and the change asked for: a preview is confirmed only against what it was made from. */
async function correctionToken(tournamentId: number, matchId: number, input: ResultInput): Promise<string> {
  const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
  const state = {
    matchId,
    input: { winner: input.winner, score: input.score?.trim() || null, walkover: !!input.walkover, retired: !!input.retired, outOfEvent: !!input.outOfEvent },
    matches: d.matches.map((m) => [m.id, m.status, m.winner, m.a, m.b, m.score]),
    entries: d.entries.map((e) => [e.id, e.status]),
  };
  const crypto = await import("crypto");
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 32);
}

export interface CorrectionPreview {
  /** False: it goes in as an ordinary result; `changes` says what it changes. */
  needsCorrection: boolean;
  changes: string[];
  /** Put into the knockout too: possible, and what it changes; or why not. */
  replace: { possible: true; changes: string[] } | { possible: false; blockers: string[] };
  /** Corrected in the group table only, the knockout left as it is being played. */
  standingsOnly: { changes: string[] };
  /** Given back to confirm against: a change made meanwhile makes it stale. */
  token: string;
}

/** What a result would change, without changing anything; for one that needs a correction, both ways of making it. */
export async function previewResult(matchId: number, input: ResultInput): Promise<Result<CorrectionPreview>> {
  const m = (await getDb().prepare("SELECT tournament_id FROM tournament_matches WHERE id = ?").get(matchId)) as { tournament_id: number } | undefined;
  if (!m) return { ok: false, error: "Match not found." };
  const token = await correctionToken(m.tournament_id, matchId, input);
  const attempt = (mode: ResultMode) =>
    dryRun(async (): Promise<{ ok: true; changes: string[] } | { ok: false; error: string; blockers?: string[]; underway?: boolean }> => {
      const before = (await tournamentDetail(m.tournament_id, { forStaff: true }))!;
      try {
        const done = await recordResultOnce(matchId, input, mode);
        if (!done.ok) return done;
        return { ok: true, changes: describeChanges(before, done.value) };
      } catch (err) {
        if (err instanceof KnockoutUnderway) return { ok: false, error: err.message, underway: true };
        if (err instanceof CorrectionBlocked) return { ok: false, error: "blocked", blockers: err.blockers };
        throw err;
      }
    });
  const normal = await attempt("normal");
  if (normal.ok)
    return { ok: true, value: { needsCorrection: false, changes: normal.changes, replace: { possible: true, changes: normal.changes }, standingsOnly: { changes: normal.changes }, token } };
  if (!normal.underway) return { ok: false, error: normal.error };
  const replace = await attempt("replace");
  const standingsOnly = await attempt("standings_only");
  if (!standingsOnly.ok) return { ok: false, error: standingsOnly.error };
  return {
    ok: true,
    value: {
      needsCorrection: true,
      changes: [],
      replace: replace.ok ? { possible: true, changes: replace.changes } : { possible: false, blockers: replace.blockers ?? [replace.error] },
      standingsOnly: { changes: standingsOnly.changes },
      token,
    },
  };
}

/**
 * A correction after the knockout has begun, confirmed by an organiser who
 * saw its preview: made only against the state the preview was made from,
 * with a reason, and kept — what it changed, what the matches were before,
 * who made it — so the history of the competition is never lost.
 */
export async function applyCorrection(
  matchId: number,
  input: ResultInput,
  confirm: { mode: "replace" | "standings_only"; reason: string; token: string },
  by: { id: number; name: string }
): Promise<Result<{ detail: TournamentDetail; changes: string[] }>> {
  const m = (await getDb().prepare("SELECT tournament_id FROM tournament_matches WHERE id = ?").get(matchId)) as { tournament_id: number } | undefined;
  if (!m) return { ok: false, error: "Match not found." };
  const reason = confirm.reason?.trim() ?? "";
  if (reason.length < 5) return { ok: false, error: "Say why: a correction after the knockout has begun is kept with its reason." };
  if ((await correctionToken(m.tournament_id, matchId, input)) !== confirm.token)
    return { ok: false, error: "The tournament has changed since you looked. Review the correction again.", code: "CHANGED" };
  try {
    return await withTransaction(async () => {
      const before = (await tournamentDetail(m.tournament_id, { forStaff: true }))!;
      const done = await recordResultOnce(matchId, input, confirm.mode);
      if (!done.ok) return done;
      const changes = describeChanges(before, done.value);
      const touched = new Set(done.value.matches.filter((x) => {
        const was = before.matches.find((y) => y.id === x.id)!;
        return was.status !== x.status || was.winner !== x.winner || was.a !== x.a || was.b !== x.b || was.score !== x.score;
      }).map((x) => x.id));
      await getDb()
        .prepare(
          `INSERT INTO tournament_corrections (tournament_id, match_id, kind, reason, changes, before_state, admin_id, admin_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(m.tournament_id, matchId, confirm.mode, reason.slice(0, 1000), JSON.stringify(changes), JSON.stringify(before.matches.filter((x) => touched.has(x.id))), by.id, by.name);
      return { ok: true, value: { detail: (await tournamentDetail(m.tournament_id, { forStaff: true }))!, changes } };
    });
  } catch (err) {
    if (err instanceof CorrectionBlocked) return { ok: false, error: `It cannot be put into the knockout safely: ${err.blockers.join(" ")}`, code: "BLOCKED" };
    throw err;
  }
}

/** A match decided, and its winner put into the match they go on to. */
async function decide(
  matchId: number,
  winner: number | null,
  score: string | null,
  status: "done" | "walkover" | "bye" | "retired",
  /** False for a correction of the record only: the next match was played by whoever did. */
  goesOn = true
): Promise<void> {
  const db = getDb();
  const m = (await db.prepare("SELECT next_match_id, next_slot FROM tournament_matches WHERE id = ?").get(matchId)) as {
    next_match_id: number | null;
    next_slot: "a" | "b" | null;
  };
  await db
    .prepare(
      `UPDATE tournament_matches SET winner = ?, score = ?, status = ?, updated_at = datetime('now')${status === "bye" ? ", court_id = NULL, date = NULL, start_min = NULL" : ""} WHERE id = ?`
    )
    .run(winner, score, status, matchId);
  if (m.next_match_id !== null && goesOn)
    await db.prepare(`UPDATE tournament_matches SET entry_${m.next_slot} = ? WHERE id = ?`).run(winner, m.next_match_id);
}

/** What follows any change to a tournament's results or entries. */
async function afterChange(tournamentId: number, groupsChanged: boolean): Promise<void> {
  if (groupsChanged) await fillKnockout(tournamentId);
  await resolveUncontested(tournamentId);
  await finishIfDone(tournamentId);
  // A walkover, a bye or the final may leave a court with nothing more to play.
  await releaseUnneeded(tournamentId);
}

/**
 * Who the groups send into the knockout's first round, pair by pair, now:
 * group winners on the top lines, each runner-up in the other half from its
 * own group's winner, and nobody who has withdrawn (their line is a bye).
 * Null for a knockout drawn straight, with no knockout after the groups, or
 * while a group match is still to be decided.
 */
function qualifiers(d: TournamentDetail, advance: number): [number | null, number | null][] | null {
  const group = d.matches.filter((m) => m.stage === "group");
  if (group.length === 0 || !d.matches.some((m) => m.stage === "knockout") || group.some((m) => m.winner === null)) return null;
  // The places that go through are taken by the first in each table still in: whoever is out is passed over.
  const eligible = d.groups.map((g) => g.table.filter((s) => !s.out));
  const winners = eligible.map((e) => e[0]?.entryId ?? null);
  const runnersUp = advance === 2 ? eligible.map((e) => e[1]?.entryId ?? null) : [];
  return firstRound(knockoutFromGroups(winners, runnersUp));
}

function firstRoundOf(d: TournamentDetail): [number | null, number | null][] {
  return d.matches
    .filter((m) => m.stage === "knockout" && m.round === 1)
    .sort((a, b) => a.position - b.position)
    .map((m) => [m.a, m.b]);
}

const samePairs = (x: [number | null, number | null][], y: [number | null, number | null][]) =>
  x.length === y.length && x.every((p, i) => p[0] === y[i][0] && p[1] === y[i][1]);

/** Has any knockout match been decided by playing it, or by a walkover? */
async function knockoutStarted(tournamentId: number): Promise<boolean> {
  return !!(await getDb()
    .prepare("SELECT 1 FROM tournament_matches WHERE tournament_id = ? AND stage = 'knockout' AND status IN ('done', 'walkover', 'retired') LIMIT 1")
    .get(tournamentId));
}

/**
 * The groups are in: their best go into the knockout. If it was filled
 * before and the groups now send somebody else (a result put right, or a
 * withdrawal), it is filled again, as long as none of it has been played and
 * every match it needs still has its court; otherwise it is left as it is.
 */
async function fillKnockout(tournamentId: number): Promise<void> {
  const db = getDb();
  const t = (await tournamentById(tournamentId))!;
  const detail = (await tournamentDetail(tournamentId))!;
  const pairs = qualifiers(detail, t.advance);
  if (!pairs) return;
  const firstRoundMatches = detail.matches.filter((m) => m.stage === "knockout" && m.round === 1).sort((a, b) => a.position - b.position);
  if (firstRoundMatches.some((m) => m.a !== null || m.b !== null || m.status !== "scheduled")) {
    if (samePairs(firstRoundOf(detail), pairs)) return;
    if (await knockoutStarted(tournamentId)) return;
    // A match given as a bye has no court any more, so cannot become one to play.
    if (firstRoundMatches.some((m, i) => m.courtId === null && pairs[i][0] !== null && pairs[i][1] !== null)) return;
    await db
      .prepare(
        `UPDATE tournament_matches SET entry_a = NULL, entry_b = NULL, winner = NULL, score = NULL, status = 'scheduled', updated_at = datetime('now')
          WHERE tournament_id = ? AND stage = 'knockout'`
      )
      .run(tournamentId);
  }
  for (let i = 0; i < firstRoundMatches.length; i++) {
    const [a, b] = pairs[i];
    await db.prepare("UPDATE tournament_matches SET entry_a = ?, entry_b = ? WHERE id = ?").run(a, b, firstRoundMatches[i].id);
    // One side only: a bye. Neither (both lines withdrawn): nobody goes through.
    if (a === null || b === null) await decide(firstRoundMatches[i].id, a ?? b, null, "bye");
  }
}

/**
 * Knockout matches nobody can contest any more, settled as soon as that is
 * known: against somebody who has withdrawn, a walkover; against a line
 * nobody will fill (a bye that sent nobody through), a bye; with neither
 * side able to play, a bye that sends nobody through. Repeated until nothing
 * changes, since each may settle the next.
 */
async function resolveUncontested(tournamentId: number): Promise<void> {
  const db = getDb();
  const out = new Set(
    ((await db.prepare("SELECT id FROM tournament_entries WHERE tournament_id = ? AND status = 'withdrawn'").all(tournamentId)) as { id: number }[]).map(
      (r) => r.id
    )
  );
  for (let guard = 0; guard < 256; guard++) {
    const rows = (await db
      .prepare("SELECT id, stage, status, winner, entry_a, entry_b, next_match_id, next_slot FROM tournament_matches WHERE tournament_id = ?")
      .all(tournamentId)) as {
      id: number;
      stage: string;
      status: string;
      winner: number | null;
      entry_a: number | null;
      entry_b: number | null;
      next_match_id: number | null;
      next_slot: "a" | "b" | null;
    }[];
    const side = (m: (typeof rows)[number], slot: "a" | "b") => {
      const entry = slot === "a" ? m.entry_a : m.entry_b;
      if (entry !== null) return out.has(entry) ? "out" : "in";
      const feeders = rows.filter((f) => f.next_match_id === m.id && f.next_slot === slot);
      return feeders.length > 0 && feeders.every((f) => f.status === "bye" && f.winner === null) ? "never" : "unknown";
    };
    const next = rows
      .filter((m) => m.stage === "knockout" && m.status === "scheduled")
      .map((m) => ({ m, a: side(m, "a"), b: side(m, "b") }))
      .find(({ a, b }) => a !== "unknown" && b !== "unknown" && !(a === "in" && b === "in"));
    if (!next) return;
    const { m, a, b } = next;
    const through = a === "in" ? m.entry_a : b === "in" ? m.entry_b : null;
    if (through !== null && (a === "out" || b === "out")) await decide(m.id, through, null, "walkover");
    else await decide(m.id, through, null, "bye");
  }
}

/** Every match decided: finished. */
async function finishIfDone(tournamentId: number): Promise<void> {
  const db = getDb();
  const left = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM tournament_matches WHERE tournament_id = ? AND winner IS NULL AND status <> 'bye'")
    .get(tournamentId)) as { n: number };
  if (left.n > 0) return;
  await db.prepare("UPDATE tournaments SET status = 'finished' WHERE id = ? AND status = 'drawn'").run(tournamentId);
}

/**
 * Give back the held time no match needs. Once the draw is made, every
 * match has its court and time and none ever moves, so on each court each
 * day only the time from its first match still to play to the end of its
 * last is needed — the time between stays held, so a match that runs over
 * does not run into somebody's booking. A court with nothing left to play
 * that day is given back whole; when the last match is in, everything left
 * is. Time already gone stays, as the record of what was held. Whoever is
 * waiting for a court that day is offered what came free. Returns how many
 * hours came free.
 */
export async function releaseUnneeded(tournamentId: number): Promise<number> {
  const db = getDb();
  const t = await tournamentById(tournamentId);
  // Before the draw nobody knows which time will be needed.
  if (!t || (t.status !== "drawn" && t.status !== "finished")) return 0;
  const held = (await db
    .prepare("SELECT court_id, date, start_min, end_min FROM blocks WHERE tournament_id = ?")
    .all(tournamentId)) as { court_id: number; date: string; start_min: number; end_min: number }[];
  const needed = new Map(
    (
      (await db
        .prepare(
          `SELECT court_id, date, MIN(start_min) AS first, MAX(start_min) AS last FROM tournament_matches
            WHERE tournament_id = ? AND status = 'scheduled' AND court_id IS NOT NULL
            GROUP BY court_id, date`
        )
        .all(tournamentId)) as { court_id: number; date: string; first: number; last: number }[]
    ).map((r) => [`${r.court_id}:${r.date}`, { start: r.first, end: r.last + t.matchMinutes }])
  );
  const zone = await tournamentZone(tournamentId);
  let freed = 0;
  const days = new Map<string, { court_id: number; date: string }>();
  for (const b of held) {
    // Not what has gone by: from the next minute on.
    const nowMinute = Math.ceil((Date.now() - instantOf(b.date, 0, zone).getTime()) / 60_000);
    const keep = needed.get(`${b.court_id}:${b.date}`);
    const from = Math.max(b.start_min, nowMinute);
    const pieces = keep
      ? [{ start: from, end: Math.min(b.end_min, keep.start) }, { start: Math.max(from, keep.end), end: b.end_min }]
      : [{ start: from, end: b.end_min }];
    for (const piece of pieces) {
      if (piece.end <= piece.start) continue;
      const minutes = await releaseBlockTime(b.court_id, b.date, piece, tournamentId);
      if (minutes > 0) {
        freed += minutes;
        days.set(`${b.court_id}:${b.date}`, b);
      }
    }
  }
  for (const b of days.values()) await offerSlotPlace(b.court_id, b.date);
  return freed / 60;
}

// ------------------------------------------------------------ telling people

async function entrants(tournamentId: number): Promise<number[]> {
  return (
    (await getDb()
      .prepare("SELECT user_id FROM tournament_entries WHERE tournament_id = ? AND status <> 'withdrawn' AND user_id IS NOT NULL")
      .all(tournamentId)) as { user_id: number }[]
  ).map((r) => r.user_id);
}

async function tellEntrant(userId: number, t: Tournament, subject: string, body: string): Promise<void> {
  await emailPlayer({ venueId: t.venueId, userId, subject, body, link: `${baseUrl()}/tournaments/${t.id}` });
}

async function tellFirstMatches(d: TournamentDetail): Promise<void> {
  const db = getDb();
  const names = new Map(d.entries.map((e) => [e.id, e.name]));
  const rows = (await db
    .prepare("SELECT id, user_id FROM tournament_entries WHERE tournament_id = ? AND status = 'entered' AND user_id IS NOT NULL")
    .all(d.id)) as { id: number; user_id: number }[];
  for (const r of rows) {
    const first = d.matches.find((m) => m.status === "scheduled" && (m.a === r.id || m.b === r.id));
    const bye = d.matches.some((m) => m.status === "bye" && m.winner === r.id);
    const text = first
      ? `Your first match in ${d.name}: ${first.date} ${formatMinute(first.minute!)}, ${first.courtName}, against ${names.get(first.a === r.id ? first.b! : first.a!) ?? "to be decided"}.`
      : bye
        ? `You have a bye in the first round of ${d.name}. Your next match is on the draw.`
        : `The draw for ${d.name} is made.`;
    await tellEntrant(r.user_id, d, `The draw is made: ${d.name}`, text);
  }
}
