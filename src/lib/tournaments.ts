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
  roundRobin,
  scheduleTimed,
  scoreRefusal,
  shuffle,
  standings,
  startStep,
  type Standing,
  type Taken,
  type TimedMatch,
  type Window,
} from "./brackets";
import { aggregate, formatMark, parseMark, rankPerformances, seedHeats, type Ranked } from "./performance-math";
import { templateByKey, templateFor, type EntryKind } from "./competition-templates";
import { entrantCategoryRefusal, entrantParticipantId, entrantUserId, entrantVenueRefusal, declaredGender, membersOnlyEntrantRefusal, PERSON_OF, recordEntered, selfEntrant, type Entrant } from "./competition-entrants";
import { refuse } from "./entitlements";
import { ACTS_FOR } from "./participants";
import { listRule, OPEN_TO_CUSTOMERS } from "./listing";
import { baseUrl, emailPlayer, sentences, type Written } from "./outbox";
import { blockSlots, offerSlotPlace, releaseBlockTime, venueHours } from "./store";
import { venueZoneOf } from "./zones";
import { addDays, isValidDateString, todayISO } from "./time";
import { formatMinute, hoursOf, instantOf, minutesOf } from "./interval";
import { type CounterMethod, type Sport } from "./types";
import type { Level } from "./games";
import { isCategory, isPartnerGender, type Category } from "./who";
import { money } from "./region";
import { groupResultsVoid, parseRules, readRules, type CompetitionRules, type OutReason, type OutStage } from "./tournament-rules";
import { clockValue, englishOf, joinSaid, readStaffText, said, type StaffText, type StaffValue } from "./staff-text";

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

/**
 * "knockout"; "groups" (round-robin groups, then a knockout); "round_robin"
 * (everybody plays everybody, the table is the result); "performance"
 * (heats, and a final, ranked by a time, distance or score).
 */
export type Format = "knockout" | "groups" | "round_robin" | "performance";
export type TournamentStatus = "open" | "closed" | "drawn" | "finished" | "cancelled";
export type EntryStatus = "entered" | "waitlisted" | "withdrawn";
/** Stages a match length can be set for: the knockout's last round and its third-place match are "final". */
export type StageKey = "group" | "knockout" | "final" | "heat";
export const STAGE_KEYS: StageKey[] = ["group", "knockout", "final", "heat"];

export interface Tournament {
  id: number;
  venueId: number;
  venueName: string;
  area: string;
  name: string;
  sport: Sport;
  format: Format;
  teamSize: 1 | 2;
  /** One player, a pair, or a team with a roster. */
  entryKind: EntryKind;
  /** A team's roster, fewest and most names. */
  roster: { min: number; max: number } | null;
  /** The sport template it was set up from (lib/competition-templates.ts). */
  template: string | null;
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
  /** How long each match is given on court, unless its stage says otherwise. */
  matchMinutes: number;
  /** Match length by stage, over `matchMinutes`; each match keeps its own once drawn (Match.minutes). */
  stageMinutes: Partial<Record<StageKey, number>>;
  /** A knockout whose semi-final losers play for third place. */
  thirdPlace: boolean;
  description: string | null;
  status: TournamentStatus;
  courtIds: number[];
  entered: number;
  waitlisted: number;
  payOnline: boolean;
  /** How it treats somebody who leaves (lib/tournament-rules.ts). */
  rules: CompetitionRules;
  /** The competition it is a division of, sharing that competition's courts and hours. */
  competition: { id: number; name: string } | null;
  /** Who may enter: the last day entries are taken, ages on the first day, members only. */
  entriesCloseOn: string | null;
  ageRange: { min: number | null; max: number | null } | null;
  membersOnly: boolean;
  /** Who enters results: staff (and officials), or the players, one side reporting and the other confirming. */
  resultsBy: "staff" | "players";
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
  /** A team's name is its `name`; its roster only for staff and the captain. */
  roster?: string[] | null;
  /** A performance event's entry mark, for seeding. */
  entryMark: number | null;
  /** Marked arrived on the day by staff. */
  checkedIn: boolean;
  /** Only for staff: a declared minor's guardian and consent, as the entrant declared them, and an organiser's own eligibility check. */
  guardian?: { name: string; consentAt: string } | null;
  eligibilityChecked?: { at: string; by: string } | null;
  /** Only for staff: the ages declared (date of birth), never verified by the app. */
  declaredBirthDate?: string | null;
  /** Only for staff (and the guardian): the participant entered, where it is one a guardian manages (ADR 0023). */
  participantId?: number | null;
  /** Only for staff: entered at the counter, by whom, and the number given (a contact, not proof of who they are). */
  atCounter?: { by: string; phone: string | null } | null;
}

/** A line of a group's table: who is out is shown where their results put them, never ranked to go through. */
export type GroupStanding = Standing & { out: OutReason | null; resultsVoid: boolean };

export interface Match {
  id: number;
  stage: "group" | "knockout" | "heat" | "final";
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
  /** The match its winner goes on to, in a knockout, and which side of it. */
  next: number | null;
  nextSlot: "a" | "b" | null;
  /** A semi-final's loser goes to the third-place match, on this side of it. */
  loserNext: number | null;
  loserNextSlot: "a" | "b" | null;
  /** 3: the third-place match. */
  placement: 3 | null;
  /** How long it is given on court. */
  minutes: number;
  /** "done" with no winner is a draw (where the rules allow one). */
  status: "scheduled" | "done" | "walkover" | "bye" | "retired";
  /** Who entered the result: "staff", "players" (reported and confirmed), "official: <name>". */
  resultBy?: string | null;
}

/** A competitor's line in a heat or final, ranked within it. */
export interface PerformanceLine {
  entryId: number;
  lane: number;
  status: "pending" | "ok" | "dns" | "dnf" | "dq";
  attempts: (number | null)[];
  result: number | null;
  /** The result as people read it: 1:02.35, 7.42, 312. */
  shown: string | null;
  rank: number | null;
}

/** Where a performance event stands: heats and final by match, and the overall ranking once there is one. */
export interface PerformanceDetail {
  lines: Record<number, PerformanceLine[]>;
  /** Everybody, best first: the final's order, then the heats' for the rest; null rank for no result. */
  ranking: { entryId: number; rank: number | null; result: number | null; shown: string | null; status: PerformanceLine["status"]; stage: "final" | "heat" }[];
  /** Level for the last place in the final: the organiser chooses (makeFinal). */
  tieForFinal: number[] | null;
}

/** A correction that left the wrong competitor in matches already played (lib/tournaments.ts, `openIssues`). */
export interface ProgressionIssue {
  id: number;
  fromMatchId: number;
  wrongEntry: number;
  rightEntry: number | null;
  /** The fixtures affected, each said in a sentence; played ones first in the order they were played. `phrase`: the same for the staff language (none on issues from before). */
  affected: { matchId: number; played: boolean; text: string; phrase?: StaffText }[];
  status: "open" | "stood" | "replayed";
  reason?: string;
  resolutionReason?: string | null;
  createdAt: string;
}

export interface TournamentDetail extends Tournament {
  entries: Entry[];
  matches: Match[];
  /** Each group's table, once the draw is made. */
  groups: { groupNo: number; table: GroupStanding[] }[];
  /** Corrections made after the knockout began; why, and what they changed, only for staff. */
  /** `knockout`: the match corrected was a knockout match, so "standings_only" corrected its record only. */
  corrections: {
    kind: "replace" | "standings_only" | "stand" | "replay";
    knockout: boolean;
    createdAt: string;
    reason?: string;
    changes?: string[];
    /** The same, as phrases for staff screens in the staff language; null for corrections from before phrases were kept. */
    changePhrases?: StaffText[] | null;
  }[];
  /** Progression left wrong by a correction, open until an organiser resolves it; while any is open the tournament does not finish. */
  issues: ProgressionIssue[];
  /** A performance event's heats, final and ranking. */
  performance: PerformanceDetail | null;
}

const T_SELECT = `
  SELECT t.*, v.name AS venue_name, v.area,
         (SELECT COUNT(*)::int FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status = 'entered') AS entered,
         (SELECT COUNT(*)::int FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status = 'waitlisted') AS waitlisted,
         ARRAY(SELECT court_id FROM tournament_courts tc WHERE tc.tournament_id = t.id ORDER BY court_id) AS court_ids,
         EXISTS (SELECT 1 FROM venue_payment_accounts a WHERE a.venue_id = v.id AND a.enabled = 1) AS pay_online,
         (SELECT c.name FROM competitions c WHERE c.id = t.competition_id) AS competition_name
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
  entry_kind: EntryKind | null;
  roster_min: number | null;
  roster_max: number | null;
  template: string | null;
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
  competition_id: number | null;
  competition_name: string | null;
  entries_close_on: string | null;
  age_min: number | null;
  age_max: number | null;
  members_only: number;
  results_by: "staff" | "players" | null;
  stage_minutes: string | null;
  third_place: number | null;
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
    entryKind: r.entry_kind ?? (r.team_size === 2 ? "pair" : "player"),
    roster: r.roster_min !== null && r.roster_max !== null ? { min: r.roster_min, max: r.roster_max } : null,
    template: r.template,
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
    stageMinutes: readStageMinutes(r.stage_minutes),
    thirdPlace: Boolean(r.third_place),
    description: r.description,
    status: r.status,
    courtIds: (r.court_ids ?? []).map(Number),
    entered: r.entered,
    waitlisted: r.waitlisted,
    payOnline: Boolean(r.pay_online),
    rules: readRules(r.rules),
    competition: r.competition_id ? { id: r.competition_id, name: r.competition_name ?? "" } : null,
    entriesCloseOn: r.entries_close_on ?? null,
    ageRange: r.age_min !== null || r.age_max !== null ? { min: r.age_min ?? null, max: r.age_max ?? null } : null,
    membersOnly: Boolean(r.members_only),
    resultsBy: r.results_by === "players" ? "players" : "staff",
  };
}

function readStageMinutes(text: string | null): Partial<Record<StageKey, number>> {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(STAGE_KEYS.filter((k) => Number.isInteger(raw[k])).map((k) => [k, raw[k] as number]));
  } catch {
    return {};
  }
}

/** The length a match of this stage is given: its stage's, else the tournament's. */
export function minutesFor(t: Pick<Tournament, "matchMinutes" | "stageMinutes">, stage: StageKey): number {
  return t.stageMinutes[stage] ?? t.matchMinutes;
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
        `SELECT id, name, status, seed, paid_at, user_id, out_reason, out_stage, roster, entry_mark, checked_in_at,
                guardian_name, guardian_consent_at, eligibility_checked_at, eligibility_checked_by, birth_date, participant_id, contact_phone, entered_by_name FROM tournament_entries
          WHERE tournament_id = ? ORDER BY status = 'entered' DESC, seed NULLS LAST, id`
      )
      .all(id)) as EntryRow[]
  ).map((e) => toEntry(e, opts.forStaff ?? false));
  const matches = await matchesOf(id, t.matchMinutes);
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
        // A retirement counts as a win; its partial score counts only where the rules say "as_played".
        .map((m) => ({ a: m.a!, b: m.b!, winner: m.winner, score: m.score, draw: m.status === "done" && m.winner === null, retired: m.status === "retired", walkover: m.status === "walkover" })),
      t.rules.scoring
    ).map((s) => ({ ...s, out: out.get(s.entryId)?.reason ?? null, resultsVoid: voided.has(s.entryId) }));
    // Void results leave nothing to rank by: listed after everybody whose results count.
    return { groupNo: g, table: [...table.filter((s) => !s.resultsVoid), ...table.filter((s) => s.resultsVoid)] };
  });
  const corrections = (
    (await db
      .prepare(
        `SELECT c.kind, c.reason, c.changes, c.change_phrases, c.created_at, m.stage FROM tournament_corrections c
           LEFT JOIN tournament_matches m ON m.id = c.match_id WHERE c.tournament_id = ? ORDER BY c.id`
      )
      .all(id)) as { kind: "replace" | "standings_only"; reason: string; changes: string; change_phrases: string | null; created_at: string; stage: string | null }[]
  ).map((c) => ({
    kind: c.kind,
    knockout: c.stage === "knockout",
    createdAt: c.created_at,
    ...(opts.forStaff ? { reason: c.reason, changes: JSON.parse(c.changes) as string[], changePhrases: storedPhrases(c.change_phrases) } : {}),
  }));
  const issues = (
    (await db.prepare("SELECT * FROM tournament_issues WHERE tournament_id = ? ORDER BY id").all(id)) as {
      id: number;
      from_match_id: number;
      wrong_entry: number;
      right_entry: number | null;
      reason: string;
      affected: string;
      status: ProgressionIssue["status"];
      resolution_reason: string | null;
      created_at: string;
    }[]
  ).map((i) => ({
    id: i.id,
    fromMatchId: i.from_match_id,
    wrongEntry: i.wrong_entry,
    rightEntry: i.right_entry,
    affected: JSON.parse(i.affected) as ProgressionIssue["affected"],
    status: i.status,
    createdAt: i.created_at,
    ...(opts.forStaff ? { reason: i.reason, resolutionReason: i.resolution_reason } : {}),
  }));
  const performance = t.format === "performance" ? await performanceOf(t, matches, out, voided) : null;
  return { ...t, entries, matches, groups, corrections, issues, performance };
}

interface EntryRow {
  id: number;
  name: string;
  status: EntryStatus;
  seed: number | null;
  paid_at: string | null;
  user_id: number | null;
  out_reason: OutReason | null;
  out_stage: OutStage | null;
  roster: string | null;
  entry_mark: number | string | null;
  checked_in_at?: string | null;
  guardian_name?: string | null;
  guardian_consent_at?: string | null;
  eligibility_checked_at?: string | null;
  eligibility_checked_by?: string | null;
  birth_date?: string | null;
  participant_id?: number | null;
  contact_phone?: string | null;
  entered_by_name?: string | null;
}

function toEntry(e: EntryRow, forStaff: boolean): Entry {
  return {
    id: e.id,
    name: e.name,
    status: e.status,
    seed: e.seed,
    paid: e.paid_at !== null,
    ...(forStaff
      ? {
          userId: e.user_id,
          roster: e.roster ? (JSON.parse(e.roster) as string[]) : null,
          guardian: e.guardian_name && e.guardian_consent_at ? { name: e.guardian_name, consentAt: e.guardian_consent_at } : null,
          eligibilityChecked: e.eligibility_checked_at ? { at: e.eligibility_checked_at, by: e.eligibility_checked_by ?? "" } : null,
          declaredBirthDate: e.birth_date ?? null,
          participantId: e.participant_id ?? null,
          atCounter: e.entered_by_name ? { by: e.entered_by_name, phone: e.contact_phone ?? null } : null,
        }
      : {}),
    out: e.status === "withdrawn" ? { reason: e.out_reason ?? "withdrawn", stage: e.out_stage } : null,
    entryMark: e.entry_mark === null ? null : Number(e.entry_mark),
    checkedIn: Boolean(e.checked_in_at),
  };
}

/**
 * A performance event as it stands: each heat's and the final's lines,
 * ranked within it, and everybody overall — the final's order first, then
 * the rest by their heat results. Results of somebody out stand or are void
 * by the rules, as group results do; void, they are shown with no rank.
 */
async function performanceOf(t: Tournament, matches: Match[], out: Map<number, { reason: OutReason }>, voided: Set<number>): Promise<PerformanceDetail> {
  const rules = t.rules.performance!;
  const rows = (await getDb()
    .prepare("SELECT match_id, entry_id, lane, attempts, result, status FROM tournament_performances WHERE tournament_id = ? ORDER BY match_id, lane")
    .all(t.id)) as { match_id: number; entry_id: number; lane: number; attempts: string | null; result: number | string | null; status: PerformanceLine["status"] }[];
  const asPerformer = (r: (typeof rows)[number]) => ({
    entryId: r.entry_id,
    status: voided.has(r.entry_id) && r.status === "ok" ? ("dq" as const) : r.status,
    attempts: r.attempts ? (JSON.parse(r.attempts) as (number | null)[]) : [],
    result: r.result === null ? null : Number(r.result),
  });
  const lines: Record<number, PerformanceLine[]> = {};
  for (const m of matches.filter((x) => x.stage === "heat" || x.stage === "final")) {
    const mine = rows.filter((r) => r.match_id === m.id);
    const ranked = rankPerformances(mine.map(asPerformer), rules);
    lines[m.id] = mine.map((r) => {
      const k = ranked.find((x) => x.entryId === r.entry_id)!;
      return { entryId: r.entry_id, lane: r.lane, status: k.status, attempts: k.attempts, result: k.result, shown: k.result === null ? null : formatMark(k.result, rules.measure), rank: k.rank };
    });
  }
  const heatIds = new Set(matches.filter((m) => m.stage === "heat").map((m) => m.id));
  const finalMatch = matches.find((m) => m.stage === "final") ?? null;
  const heatRanked = rankPerformances(rows.filter((r) => heatIds.has(r.match_id)).map(asPerformer), rules);
  const finalRanked = finalMatch ? rankPerformances(rows.filter((r) => r.match_id === finalMatch.id).map(asPerformer), rules) : [];
  const finalists = new Set(finalRanked.map((r) => r.entryId));
  const show = (r: Ranked) => (r.result === null ? null : formatMark(r.result, rules.measure));
  const ranking: PerformanceDetail["ranking"] = [];
  for (const r of finalRanked) ranking.push({ entryId: r.entryId, rank: r.rank, result: r.result, shown: show(r), status: r.status, stage: "final" });
  // After the finalists, the rest in heat order, ranked on from the final's size.
  const rest = heatRanked.filter((r) => !finalists.has(r.entryId));
  const offset = finalRanked.length;
  rest.forEach((r, i) => {
    const level = i > 0 && r.rank !== null && rest[i - 1].rank === r.rank;
    const rank = r.rank === null ? null : level ? ranking[ranking.length - 1].rank : offset + i + 1;
    ranking.push({ entryId: r.entryId, rank, result: r.result, shown: show(r), status: r.status, stage: "heat" });
  });
  return { lines, ranking, tieForFinal: finalMatch && finalists.size === 0 ? cutTie(heatRanked, rules.finalSize, out) : null };
}

/** Those level for the last place in a final of `size`, if more are level than places are left; else null. */
function cutTie(heatRanked: Ranked[], size: number, out: Map<number, unknown>): number[] | null {
  const eligible = heatRanked.filter((r) => r.rank !== null && !out.has(r.entryId));
  if (eligible.length <= size || size === 0) return null;
  const last = eligible[size - 1].rank;
  const level = eligible.filter((r) => r.rank === last);
  const before = eligible.filter((r) => r.rank! < last!).length;
  return before + level.length > size ? level.map((r) => r.entryId) : null;
}

async function matchesOf(tournamentId: number, defaultMinutes: number): Promise<Match[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT m.*, c.name AS court_name FROM tournament_matches m LEFT JOIN courts c ON c.id = m.court_id
        WHERE m.tournament_id = ? ORDER BY m.stage = 'knockout', m.round, m.group_no, m.placement NULLS FIRST, m.position`
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
    next_match_id: number | null;
    next_slot: "a" | "b" | null;
    status: Match["status"];
    result_by: string | null;
    minutes: number | null;
    placement: number | null;
    loser_next_match_id: number | null;
    loser_next_slot: "a" | "b" | null;
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
    next: r.next_match_id,
    nextSlot: r.next_slot,
    loserNext: r.loser_next_match_id,
    loserNextSlot: r.loser_next_slot,
    placement: r.placement === 3 ? 3 : null,
    minutes: r.minutes ?? defaultMinutes,
    status: r.status,
    ...(r.result_by ? { resultBy: r.result_by } : {}),
  }));
}

// ------------------------------------------------------------ setting one up

export type Result<T = Tournament> = { ok: true; value: T } | { ok: false; error: string; clashes?: number; code?: string; vars?: Record<string, string | number> };

export interface TournamentInput {
  venueId: number;
  name: string;
  sport: Sport;
  format: Format;
  teamSize: 1 | 2;
  /** A team event, with a roster of names each; otherwise `teamSize` says singles or doubles. */
  entryKind?: EntryKind;
  roster?: { min: number; max: number } | null;
  /** The sport template to start from (lib/competition-templates.ts); its rules, with `rules` laid over them. */
  template?: string | null;
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
  /** How long each match is given on court; an hour unless said. A division's own, or its competition's. */
  matchMinutes?: number;
  /** Longer or shorter matches for a stage: {"final": 90}. */
  stageMinutes?: Partial<Record<StageKey, number>> | null;
  /** A knockout's semi-final losers play for third place. */
  thirdPlace?: boolean;
  courtIds: number[];
  description?: string;
  /** Scoring, ranking and how it treats somebody who leaves, over the template's (lib/tournament-rules.ts). */
  rules?: unknown;
  /** A division of this competition (lib/competitions.ts): days, hours, courts and match length are its. */
  competitionId?: number | null;
  /** The last day entries are taken, in the venue's time; the scheduler closes them after it. */
  entriesCloseOn?: string | null;
  /** Ages on the first day, from the date of birth each entrant declares. */
  ageMin?: number | null;
  ageMax?: number | null;
  /** Only the venue's members (an active membership) may enter. */
  membersOnly?: boolean;
  /** "players": one side reports each result and the other confirms it (lib/match-reports.ts). */
  resultsBy?: "staff" | "players";
}

/** The time zone of the venue running a tournament. */
async function tournamentZone(tournamentId: number): Promise<string> {
  const row = (await getDb().prepare("SELECT venue_id FROM tournaments WHERE id = ?").get(tournamentId)) as { venue_id: number } | undefined;
  return (await venueHours(row?.venue_id ?? 0)).zone;
}

/** Days, hours and courts to hold for a tournament or a competition, as asked. */
export interface HoldRequest {
  venueId: number;
  sport: Sport;
  startsOn: string;
  endsOn: string;
  startMin?: number;
  endMin?: number;
  startHour?: number;
  endHour?: number;
  matchMinutes?: number;
  courtIds: number[];
}

/** A hold that has been checked: inside the venue's hours every day, its courts for the sport. */
export interface CheckedHold {
  venueId: number;
  sport: Sport;
  startsOn: string;
  endsOn: string;
  startMin: number;
  endMin: number;
  matchMinutes: number;
  courtIds: number[];
}

type Refused = { ok: false; error: string; clashes?: number };

/** Whether the days, hours and courts asked for can be held at all (not yet whether they are free). */
export async function checkHold(input: HoldRequest): Promise<{ ok: true; hold: CheckedHold } | Refused> {
  const db = getDb();
  if (!isValidDateString(input.startsOn) || !isValidDateString(input.endsOn) || input.endsOn < input.startsOn)
    return { ok: false, error: "Give the first and last day." };
  if (addDays(input.startsOn, 13) < input.endsOn) return { ok: false, error: "Two weeks at most." };
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
  return { ok: true, hold: { venueId: input.venueId, sport: input.sport, startsOn: input.startsOn, endsOn: input.endsOn, startMin, endMin, matchMinutes, courtIds } };
}

/**
 * A court out of service on any of those days cannot be held for them. Out
 * of service, or already booked in those hours: say so, rather than hold over
 * it. Asked again inside the transaction that holds the hours, so a booking
 * or an outage made meanwhile is seen there.
 */
export async function holdInTheWay(h: CheckedHold): Promise<Refused | null> {
  const db = getDb();
  const marks = h.courtIds.map(() => "?").join(",");
  const out = (await db
    .prepare(
      `SELECT c.name FROM court_outages o JOIN courts c ON c.id = o.court_id
        WHERE o.court_id IN (${marks}) AND o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?) LIMIT 1`
    )
    .get(...h.courtIds, h.endsOn, h.startsOn)) as { name: string } | undefined;
  if (out) return { ok: false, error: `${out.name} is out of service then. Choose other courts or days.` };
  // Bookings holding these courts' spaces in that time each day, a court sharing their floor's too.
  const { clashes } = (await db
    .prepare(
      `SELECT COUNT(DISTINCT b.id)::int AS clashes FROM claims c JOIN bookings b ON b.id = c.booking_id
        WHERE c.active
          AND (c.space_id IN (SELECT space_id FROM court_spaces WHERE court_id IN (${marks}))
               OR (c.space_id IS NULL AND c.court_id IN (${marks})))
          AND b.date >= ? AND b.date <= ? AND b.start_min < ? AND b.end_min > ?`
    )
    .get(...h.courtIds, ...h.courtIds, h.startsOn, h.endsOn, h.endMin, h.startMin)) as { clashes: number };
  if (clashes > 0)
    return {
      ok: false,
      error: `${clashes === 1 ? "A booking is" : `${clashes} bookings are`} already in those hours. Move ${clashes === 1 ? "it" : "them"}, or choose other hours or courts.`,
      clashes,
    };
  return null;
}

/**
 * The time, held each day on each court, for a tournament or a competition.
 * Time staff had already blocked stays theirs, and is simply not time the
 * draw can use. Run inside the transaction that creates the holder.
 */
export async function placeHold(h: CheckedHold, label: string, owner: { tournamentId: number } | { competitionId: number }): Promise<void> {
  for (let d = h.startsOn; d <= h.endsOn; d = addDays(d, 1))
    for (const c of h.courtIds) {
      const held = await blockSlots(c, d, { start: h.startMin, end: h.endMin }, label, undefined, owner);
      if (!held.ok) throw new Error(held.error);
    }
}

/** The competition a division is part of: its hold, which the division's own fields copy. */
interface CompetitionHold {
  id: number;
  name: string;
  status: string;
  hold: CheckedHold;
}

async function competitionHold(id: number): Promise<CompetitionHold | null> {
  const db = getDb();
  const row = (await db
    .prepare("SELECT id, name, status, venue_id, sport, starts_on, ends_on, start_min, end_min, match_minutes FROM competitions WHERE id = ?")
    .get(id)) as
    | { id: number; name: string; status: string; venue_id: number; sport: Sport; starts_on: string; ends_on: string; start_min: number; end_min: number; match_minutes: number }
    | undefined;
  if (!row) return null;
  const courts = (await db.prepare("SELECT court_id FROM competition_courts WHERE competition_id = ? ORDER BY court_id").all(id)) as { court_id: number }[];
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    hold: {
      venueId: row.venue_id,
      sport: row.sport,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      startMin: row.start_min,
      endMin: row.end_min,
      matchMinutes: row.match_minutes,
      courtIds: courts.map((c) => c.court_id),
    },
  };
}

/** Who may enter, from a form: a closing day, an age range, members only. */
function checkEligibility(input: Pick<TournamentInput, "entriesCloseOn" | "ageMin" | "ageMax" | "membersOnly">, startsOn: string): Refused | null {
  if (input.entriesCloseOn !== undefined && input.entriesCloseOn !== null) {
    if (!isValidDateString(input.entriesCloseOn)) return { ok: false, error: "Give the last day entries are taken." };
    if (input.entriesCloseOn >= startsOn) return { ok: false, error: "Entries must close before the first day." };
  }
  const age = (v: unknown) => v === undefined || v === null || (Number.isInteger(v) && (v as number) >= 3 && (v as number) <= 99);
  if (!age(input.ageMin) || !age(input.ageMax)) return { ok: false, error: "Ages are 3 to 99." };
  if (input.ageMin && input.ageMax && input.ageMin > input.ageMax) return { ok: false, error: "The youngest age is above the oldest." };
  return null;
}

/** Stage lengths from a form: each 5 minutes to 10 hours, and no longer than a day's time. */
function checkStageMinutes(input: unknown, dayMinutes: number): { ok: true; value: Partial<Record<StageKey, number>> } | Refused {
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Give stage lengths in minutes." };
  const value: Partial<Record<StageKey, number>> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "") continue;
    if (!STAGE_KEYS.includes(k as StageKey)) return { ok: false, error: `No stage called ${k}.` };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 5 || n > 600) return { ok: false, error: "Give each stage's matches 5 minutes to 10 hours." };
    if (n > dayMinutes) return { ok: false, error: `A ${k} match of ${n} minutes does not fit in the time each day.` };
    value[k as StageKey] = n;
  }
  return { ok: true, value };
}

export async function createTournament(input: TournamentInput, adminId: number): Promise<Result> {
  const db = getDb();
  const name = input.name.trim();
  if (name.length < 3 || name.length > 100) return { ok: false, error: "Give it a name." };
  // A division of a competition: its venue, sport, days, hours and courts are the competition's.
  const competition = input.competitionId ? await competitionHold(input.competitionId) : null;
  if (input.competitionId && (!competition || competition.status !== "open")) return { ok: false, error: "That competition is not taking divisions." };
  if (competition && competition.hold.venueId !== input.venueId) return { ok: false, error: "That competition is at another venue." };
  // Its held time is shared out at each draw: a division added after one would find it given back.
  if (competition && (await db.prepare("SELECT 1 FROM tournaments WHERE competition_id = ? AND status IN ('drawn', 'finished')").get(competition.id)))
    return { ok: false, error: "A division's draw is made: add divisions before any draw." };
  const sport = competition ? competition.hold.sport : input.sport;
  if (!(await isActivity(sport))) return { ok: false, error: "Unknown sport." };
  if (!["knockout", "groups", "round_robin", "performance"].includes(input.format))
    return { ok: false, error: "A knockout, groups then a knockout, a round robin, or a performance event." };
  // The sport's own template, where it suits the format asked for; else the general one.
  const sportTemplate = templateFor(sport);
  const template = input.template ? templateByKey(input.template) : sportTemplate.formats.includes(input.format) ? sportTemplate : templateByKey(input.format === "performance" ? "best_attempt" : "custom");
  if (!template) return { ok: false, error: "Unknown template." };
  const parsedRules = parseRules(input.rules ?? null, template.rules);
  if (!parsedRules.ok) return parsedRules;
  const rules = parsedRules.rules;
  if (input.format === "performance" && !rules.performance) return { ok: false, error: "A performance event needs what is measured: choose a performance template." };
  if (input.format !== "performance" && rules.performance) return { ok: false, error: "That template is for a performance event." };
  const entryKind: EntryKind = input.entryKind ?? (input.teamSize === 2 ? "pair" : "player");
  if (!["player", "pair", "team"].includes(entryKind)) return { ok: false, error: "Players, pairs or teams." };
  if (input.format === "performance" && entryKind !== "player") return { ok: false, error: "A performance event takes players one by one." };
  const roster = entryKind === "team" ? input.roster ?? template.roster ?? { min: 2, max: 20 } : null;
  if (roster && (!Number.isInteger(roster.min) || !Number.isInteger(roster.max) || roster.min < 1 || roster.max > 40 || roster.min > roster.max))
    return { ok: false, error: "A roster of 1 to 40 names, the fewest no more than the most." };
  const teamSize = entryKind === "pair" ? 2 : 1;
  const category = input.category ?? "open";
  if (!isCategory(category)) return { ok: false, error: "Open, women's, men's or mixed." };
  if (category === "mixed" && teamSize !== 2) return { ok: false, error: "Mixed is doubles: one woman and one man." };
  if (!Number.isInteger(input.maxEntries) || input.maxEntries < 2 || input.maxEntries > 128)
    return { ok: false, error: "Between 2 and 128 entries." };
  if (!Number.isFinite(input.entryFee) || input.entryFee < 0 || input.entryFee > 10000) return { ok: false, error: "Check the entry fee." };
  let hold: CheckedHold;
  if (competition) {
    // A division may give its matches a length of its own, inside the competition's time.
    const own = input.matchMinutes ?? competition.hold.matchMinutes;
    if (!Number.isInteger(own) || own < 5 || own > 600) return { ok: false, error: "Give each match 5 minutes to 10 hours." };
    if (competition.hold.endMin - competition.hold.startMin < own) return { ok: false, error: "The time each day must fit at least one match." };
    hold = { ...competition.hold, matchMinutes: own };
    const today = todayISO((await venueHours(hold.venueId)).zone);
    if (hold.startsOn <= today) return { ok: false, error: "That competition has started: divisions are added before it." };
  } else {
    const checked = await checkHold({ ...input, sport });
    if (!checked.ok) return checked;
    hold = checked.hold;
  }
  const ineligible = checkEligibility(input, hold.startsOn);
  if (ineligible) return ineligible;
  const stageMinutes = checkStageMinutes(input.stageMinutes ?? null, hold.endMin - hold.startMin);
  if (!stageMinutes.ok) return stageMinutes;
  if (input.thirdPlace && input.format !== "knockout" && input.format !== "groups")
    return { ok: false, error: "A third-place match is for a knockout, or groups then a knockout." };
  if (!competition) {
    const before = await holdInTheWay(hold);
    if (before) return before;
  }

  let id = 0;
  const refused = await db.transaction(async () => {
    if (!competition) {
      const meanwhile = await holdInTheWay(hold);
      if (meanwhile) return meanwhile;
    }
    const info = await db
      .prepare(
        `INSERT INTO tournaments (venue_id, name, sport, format, team_size, category, level, entry_fee, max_entries, group_size, advance,
                                  starts_on, ends_on, start_min, end_min, match_minutes, description, created_by, rules,
                                  entry_kind, roster_min, roster_max, template, competition_id, entries_close_on, age_min, age_max, members_only, results_by,
                                  stage_minutes, third_place)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        hold.venueId,
        name,
        sport,
        input.format,
        teamSize,
        category,
        input.level,
        Math.round(input.entryFee * 100) / 100,
        input.maxEntries,
        Math.min(Math.max(input.groupSize ?? 4, 3), 6),
        input.advance === 1 ? 1 : 2,
        hold.startsOn,
        hold.endsOn,
        hold.startMin,
        hold.endMin,
        hold.matchMinutes,
        input.description?.trim().slice(0, 2000) || null,
        adminId,
        JSON.stringify(rules),
        entryKind,
        roster?.min ?? null,
        roster?.max ?? null,
        template.key,
        competition?.id ?? null,
        input.entriesCloseOn ?? null,
        input.ageMin ?? null,
        input.ageMax ?? null,
        input.membersOnly ? 1 : 0,
        input.resultsBy === "players" && input.format !== "performance" ? "players" : "staff",
        Object.keys(stageMinutes.value).length > 0 ? JSON.stringify(stageMinutes.value) : null,
        input.thirdPlace ? 1 : 0
      );
    id = info.lastInsertRowid as number;
    for (const c of hold.courtIds) await db.prepare("INSERT INTO tournament_courts (tournament_id, court_id) VALUES (?, ?)").run(id, c);
    // A division plays in its competition's hold; a tournament on its own holds its time itself.
    if (!competition) await placeHold(hold, `Tournament: ${name}`, { tournamentId: id });
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
  for (const entryId of await entrants(id)) await tellEntry(entryId, t, (tr) => tr("mail.tour.calledOff.s", { t: t.name }), (tr) => tr("mail.tour.calledOff.b", { t: t.name, venue: t.venueName }));
  // A division: the competition's time it would have used goes back once nothing else needs it.
  if (t.competition) await releaseCompetitionTime(t.competition.id);
  return { ok: true, value: (await tournamentById(id))! };
}

/**
 * Entries close at the end of their last day, in the venue's time: run by the
 * scheduler. Returns how many tournaments it closed.
 */
export async function closeDueEntries(): Promise<number> {
  const db = getDb();
  const due = (await db
    .prepare("SELECT id, venue_id, entries_close_on FROM tournaments WHERE status = 'open' AND entries_close_on IS NOT NULL AND entries_close_on < ?")
    // Nowhere is more than a day ahead of UTC, so nothing closing on a later day is missed.
    .all(addDays(todayISO("UTC"), 1))) as { id: number; venue_id: number; entries_close_on: string }[];
  let closed = 0;
  for (const t of due) {
    if (todayISO((await venueHours(t.venue_id)).zone) <= t.entries_close_on) continue;
    const done = await db.prepare("UPDATE tournaments SET status = 'closed' WHERE id = ? AND status = 'open'").run(t.id);
    closed += done.changes;
  }
  return closed;
}

// ------------------------------------------------------------ entries

/** Whole years old on `day`, born on `birthDate` (both YYYY-MM-DD). */
/**
 * Below this declared age an entry needs a parent or guardian's agreement.
 * An operator policy, not a legal determination: what consent the law asks
 * for, and whether a venue needs more (a signed form), is for the operator
 * and the organiser to settle (docs/features/tournaments.md).
 */
export const GUARDIAN_AGE = 18;

export function ageOn(birthDate: string, day: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Why a declared date of birth is outside a tournament's ages on its first day, or null. */
function ageRefusal(birthDate: unknown, t: Pick<Tournament, "ageRange" | "startsOn">, whose: "Your" | "Your partner's"): string | null {
  if (!t.ageRange) return null;
  if (typeof birthDate !== "string" || !isValidDateString(birthDate) || birthDate >= t.startsOn) return `${whose} date of birth is needed: this is for ages ${ageText(t.ageRange)}.`;
  const age = ageOn(birthDate, t.startsOn);
  if ((t.ageRange.min !== null && age < t.ageRange.min) || (t.ageRange.max !== null && age > t.ageRange.max))
    return `${whose === "Your" ? "You are" : "Your partner is"} ${age} on ${t.startsOn}: this is for ages ${ageText(t.ageRange)}.`;
  return null;
}

export function ageText(range: { min: number | null; max: number | null }): string {
  return range.min !== null && range.max !== null ? `${range.min} to ${range.max}` : range.min !== null ? `${range.min} and over` : `${range.max} and under`;
}

/** What an entry says besides who enters: a partner, a team, a mark, declared dates of birth, a guardian's agreement. */
export interface EntryInput {
  partnerName?: string;
  partnerGender?: string;
  teamName?: string;
  roster?: unknown;
  entryMark?: string;
  birthDate?: string;
  partnerBirthDate?: string;
  rosterEligible?: boolean;
  /** For a declared minor: a parent or guardian's name, and that they agree. */
  guardianName?: string;
  guardianConsent?: boolean;
  /** An entrant with no account of their own (a participant, or at the counter): their gender as declared, where the event asks. */
  gender?: string;
}

/** Enter a tournament as the account holder, for themself (`enterAs`). */
export async function enter(user: { id: number; name: string }, tournamentId: number, input: EntryInput = {}): Promise<Result<Entry>> {
  return enterAs(selfEntrant(user), tournamentId, input);
}

/**
 * Enter a tournament: the account holder for themself, a guardian for a
 * participant they manage, or staff at the counter (lib/competition-entrants.ts),
 * one set of checks for each. Who may enter is the tournament's to say:
 * entries close after their last day; an age range is checked on the first
 * day against the dates of birth declared for the entrant and a partner (a
 * captain declares their roster within it); a declared minor needs a parent
 * or guardian's agreement; members only means the entrant's own membership
 * at the venue, or a family membership naming them (ADR 0025); a competition
 * may cap how many of its divisions one player enters.
 */
export async function enterAs(entrant: Entrant, tournamentId: number, input: EntryInput = {}): Promise<Result<Entry>> {
  const db = getDb();
  const t = await tournamentById(tournamentId);
  if (!t || t.status !== "open") return { ok: false, error: "Entries are not open." };
  const today = todayISO((await venueHours(t.venueId)).zone);
  if (t.entriesCloseOn && today > t.entriesCloseOn) return { ok: false, error: `Entries closed on ${t.entriesCloseOn}.` };
  const userId = entrantUserId(entrant);
  const participantId = entrantParticipantId(entrant);
  // The entrant's own membership, or a family one naming them; never a guardian's (ADR 0025).
  if (t.membersOnly) {
    const notMember = await membersOnlyEntrantRefusal(t.venueId, entrant, today);
    if (notMember) return notMember;
  }
  let birthDate: string | null = null;
  let partnerBirthDate: string | null = null;
  if (t.ageRange) {
    const mine = ageRefusal(input.birthDate, t, "Your");
    if (mine) return { ok: false, error: mine, code: "AGE_RANGE" };
    birthDate = input.birthDate!;
    if (t.teamSize === 2) {
      const theirs = ageRefusal(input.partnerBirthDate, t, "Your partner's");
      if (theirs) return { ok: false, error: theirs, code: "AGE_RANGE" };
      partnerBirthDate = input.partnerBirthDate!;
    }
    if (t.entryKind === "team" && input.rosterEligible !== true) return { ok: false, error: `Confirm that everybody on the roster is aged ${ageText(t.ageRange)} on ${t.startsOn}.`, code: "AGE_RANGE" };
  }
  // A declared minor enters with a parent or guardian's agreement, as the entrant declares it: the app does not verify it.
  let guardianName: string | null = null;
  const minor =
    (birthDate !== null && ageOn(birthDate, t.startsOn) < GUARDIAN_AGE) ||
    (partnerBirthDate !== null && ageOn(partnerBirthDate, t.startsOn) < GUARDIAN_AGE) ||
    (t.entryKind === "team" && t.ageRange !== null && t.ageRange.max !== null && t.ageRange.max < GUARDIAN_AGE);
  if (minor) {
    // A guardian entering somebody they manage is the one agreeing: their name unless they give another.
    guardianName = input.guardianName?.trim() || (entrant.kind === "participant" ? entrant.guardianName : "");
    if (guardianName.length < 2 || guardianName.length > 80 || input.guardianConsent !== true)
      return { ok: false, error: `Entrants under ${GUARDIAN_AGE} need a parent or guardian's agreement: give their name and confirm they agree.`, code: "GUARDIAN_CONSENT" };
  }
  if (t.competition) {
    const cap = (await db.prepare("SELECT max_divisions_per_player AS cap FROM competitions WHERE id = ?").get(t.competition.id)) as { cap: number | null };
    // Counted per person: the account holder's own entries, or the participant's however they were entered.
    const person = participantId !== null ? -participantId : userId;
    if (cap.cap !== null && person !== null) {
      const { n } = (await db
        .prepare(
          `SELECT COUNT(*)::int AS n FROM tournament_entries e JOIN tournaments d ON d.id = e.tournament_id
            WHERE d.competition_id = ? AND d.id <> ? AND d.status <> 'cancelled' AND ${PERSON_OF("e")} = ? AND e.status <> 'withdrawn'`
        )
        .get(t.competition.id, t.id, person)) as { n: number };
      if (n >= cap.cap) return { ok: false, error: `One player may enter ${cap.cap} division${cap.cap === 1 ? "" : "s"} of ${t.competition.name}, and you have.`, code: "DIVISION_LIMIT" };
    }
  }
  // A women's event takes women; mixed doubles, a woman and a man.
  const partnerGender = isPartnerGender(input.partnerGender) ? input.partnerGender : null;
  const notFor = await entrantCategoryRefusal(entrant, t.category, t.teamSize === 2 ? { partnerGender } : null, input.gender);
  if (notFor) return { ok: false, error: notFor.error, code: notFor.code, ...(notFor.vars ? { vars: notFor.vars } : {}) };
  const open = (await db
    .prepare(`SELECT (${OPEN_TO_CUSTOMERS}) AS open FROM venues v WHERE v.id = ?`)
    .get(t.venueId)) as { open: boolean };
  if (!open.open) return { ok: false, error: "That venue is not taking entries at the moment." };
  const notHere = await entrantVenueRefusal(t.venueId, entrant, today);
  if (notHere) return { ok: false, error: notHere.error, code: notHere.code, ...(notHere.vars ? { vars: notHere.vars } : {}) };
  const partner = input.partnerName?.trim() ?? "";
  if (t.teamSize === 2 && (partner.length < 2 || partner.length > 60)) return { ok: false, error: "Name your partner." };
  // A team: its name, and its roster of names (the one entering among them, as captain).
  let teamName = "";
  let roster: string[] | null = null;
  if (t.entryKind === "team") {
    teamName = input.teamName?.trim() ?? "";
    if (teamName.length < 2 || teamName.length > 60) return { ok: false, error: "Name your team." };
    const names = Array.isArray(input.roster) ? input.roster.map((n) => String(n ?? "").trim()).filter(Boolean) : [];
    if (names.some((n) => n.length < 2 || n.length > 60)) return { ok: false, error: "Each name on the roster is 2 to 60 letters." };
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return { ok: false, error: "A name is on the roster twice." };
    const { min, max } = t.roster ?? { min: 1, max: 40 };
    if (names.length < min || names.length > max) return { ok: false, error: `A roster of ${min} to ${max} names.` };
    roster = names;
    const taken = (await db
      .prepare("SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND status <> 'withdrawn' AND lower(team_name) = lower(?)")
      .get(tournamentId, teamName)) as unknown;
    if (taken) return { ok: false, error: "A team of that name has entered already." };
  }
  // A performance event: the entry mark seeds the heats, if given.
  let entryMark: number | null = null;
  if (t.format === "performance" && input.entryMark?.trim()) {
    const mark = parseMark(input.entryMark, t.rules.performance!.measure);
    if (mark === undefined || mark === null) return { ok: false, error: t.rules.performance!.measure === "time" ? "Give an entry time like 1:02.35, or leave it empty." : "Give your entry mark as a number, or leave it empty." };
    entryMark = mark;
  }
  // Once each: the account holder for themself, and each participant however many enter them.
  const already =
    participantId !== null
      ? await db.prepare("SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND participant_id = ? AND status <> 'withdrawn'").get(tournamentId, participantId)
      : userId !== null
        ? await db.prepare("SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND user_id = ? AND participant_id IS NULL AND status <> 'withdrawn'").get(tournamentId, userId)
        : undefined;
  if (already) return entrant.kind === "self" ? { ok: false, error: "You have entered already." } : refuse("LG5_ENTERED_ALREADY", { name: entrant.name });
  const status: EntryStatus = t.entered >= t.maxEntries ? "waitlisted" : "entered";
  const name = t.entryKind === "team" ? teamName : t.teamSize === 2 ? `${entrant.name} / ${partner}` : entrant.name;
  const info = await db
    .prepare(
      `INSERT INTO tournament_entries (tournament_id, user_id, name, partner_name, partner_gender, status, team_name, roster, entry_mark, birth_date, partner_birth_date,
                                       guardian_name, guardian_consent_at, participant_id, entrant_gender, contact_phone, entered_by_admin_id, entered_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${guardianName ? "datetime('now')" : "NULL"}, ?, ?, ?, ?, ?)`
    )
    .run(
      tournamentId,
      userId,
      name.slice(0, 130),
      partner || null,
      t.teamSize === 2 ? partnerGender : null,
      status,
      t.entryKind === "team" ? teamName : null,
      roster ? JSON.stringify(roster) : null,
      entryMark,
      birthDate,
      partnerBirthDate,
      guardianName,
      participantId,
      declaredGender(entrant, t.category, input.gender),
      entrant.kind === "counter" ? entrant.phone : null,
      entrant.kind === "counter" ? entrant.adminId : null,
      entrant.kind === "counter" ? entrant.adminName : null
    );
  await recordEntered(entrant, t.venueId, "tournament.entered", t.name);
  if (userId !== null)
    await tellEntrant(
      userId,
      t,
      (tr) => tr(status === "entered" ? "mail.tour.entered.s" : "mail.tour.waiting.s", { t: t.name }),
      (tr) =>
        sentences(
          tr,
          entrant.kind === "participant" && tr("lg5.mail.entryFor", { name: entrant.name }),
          status === "entered" && tr("mail.tour.entered.b", { t: t.name, venue: t.venueName, date: t.startsOn }),
          status === "entered" && t.entryFee > 0 && tr(t.payOnline ? "mail.tour.feeOnline" : "mail.tour.feeVenue", { fee: money(t.entryFee.toFixed(2)) }),
          status === "entered" && tr("mail.tour.entered.next"),
          status !== "entered" && tr("mail.tour.waiting.b", { t: t.name })
        )
    );
  return { ok: true, value: (await entryById(info.lastInsertRowid as number))! };
}

async function entryById(id: number): Promise<Entry | null> {
  const r = (await getDb()
    .prepare(
      `SELECT id, name, status, seed, paid_at, user_id, out_reason, out_stage, roster, entry_mark, checked_in_at,
              guardian_name, guardian_consent_at, eligibility_checked_at, eligibility_checked_by, birth_date, participant_id, contact_phone, entered_by_name FROM tournament_entries WHERE id = ?`
    )
    .get(id)) as EntryRow | undefined;
  return r ? toEntry(r, true) : null;
}

/** The player's own entry in a tournament, if they have one. */
export async function myEntry(userId: number, tournamentId: number): Promise<Entry | null> {
  const r = (await getDb()
    .prepare("SELECT id FROM tournament_entries WHERE tournament_id = ? AND user_id = ? AND participant_id IS NULL AND status <> 'withdrawn' ORDER BY id DESC LIMIT 1")
    .get(tournamentId, userId)) as { id: number } | undefined;
  return r ? await entryById(r.id) : null;
}

/** Entries this account made for people it still acts for (a guardian's), not withdrawn. */
export async function managedEntries(userId: number, tournamentId: number): Promise<Entry[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT e.id FROM tournament_entries e JOIN participants p ON p.id = e.participant_id
        WHERE e.tournament_id = ? AND e.user_id = ? AND e.status <> 'withdrawn' AND ${ACTS_FOR("p")} ORDER BY e.id`
    )
    .all(tournamentId, userId, userId, userId)) as { id: number }[];
  return (await Promise.all(rows.map((r) => entryById(r.id)))).filter((e): e is Entry => e !== null);
}

/**
 * Its rules, changed before the draw (after it, results already depend on
 * them). Null for the defaults.
 */
export async function setRules(tournamentId: number, input: unknown): Promise<Result> {
  const t = await tournamentById(tournamentId);
  if (!t) return { ok: false, error: "Tournament not found." };
  if (t.status !== "open" && t.status !== "closed") return { ok: false, error: "The draw is made: its rules stand as they were." };
  // Laid over what it has: a change to one rule leaves the rest (its scoring among them) as they were.
  const parsed = parseRules(input, t.rules);
  if (!parsed.ok) return parsed;
  if (t.format === "performance" ? !parsed.rules.performance : parsed.rules.performance) return { ok: false, error: "Those rules are for another kind of event." };
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
export async function takeOut(
  entryId: number,
  reason: OutReason,
  note?: string,
  /** The token its preview gave: when given, it is made only against the tournament as previewed. */
  confirm?: { token: string }
): Promise<Result<{ entry: Entry } & Changes>> {
  if (confirm && (await takeOutToken(entryId, reason)) !== confirm.token)
    return { ok: false, error: "The tournament has changed since you looked. Review it again.", code: "CHANGED" };
  return withTransaction(async () => {
    const before = await detailForEntry(entryId);
    const done = await takeOutOnce(entryId, reason, note);
    if (!done.ok) return done;
    const after = before ? (await tournamentDetail(before.id, { forStaff: true }))! : null;
    return { ok: true, value: { entry: done.value, ...changesOf(before && after ? changePhrases(before, after) : []) } };
  });
}

/**
 * What taking somebody out would change, without changing anything; whether
 * it is consequential (after the draw, it changes matches and tables, so it
 * is confirmed against this preview's token); and that token.
 */
export async function previewTakeOut(entryId: number, reason: OutReason): Promise<Result<Changes & { consequential: boolean; token: string }>> {
  const token = await takeOutToken(entryId, reason);
  const preview = await dryRun(async (): Promise<Result<Changes & { consequential: boolean }>> => {
    const before = await detailForEntry(entryId);
    const done = await takeOutOnce(entryId, reason);
    if (!done.ok) return done;
    const after = before ? (await tournamentDetail(before.id, { forStaff: true }))! : null;
    return { ok: true, value: { ...changesOf(before && after ? changePhrases(before, after) : []), consequential: !!before && before.status === "drawn" } };
  });
  return preview.ok ? { ok: true, value: { ...preview.value, token } } : preview;
}

async function takeOutToken(entryId: number, reason: OutReason): Promise<string> {
  const r = (await getDb().prepare("SELECT tournament_id FROM tournament_entries WHERE id = ?").get(entryId)) as { tournament_id: number } | undefined;
  return r ? await stateToken(r.tournament_id, { entryId, reason }) : "";
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
  if (t.status === "drawn" && t.format === "performance") {
    // Their heats and final still to come: did not start. Results already in stand or are void by the rules (performanceOf).
    await db
      .prepare(
        `UPDATE tournament_performances SET status = 'dns', note = ?, updated_at = datetime('now')
          WHERE entry_id = ? AND status = 'pending'`
      )
      .run(`Out: ${reason}`, entryId);
    for (const m of (await db.prepare("SELECT DISTINCT match_id FROM tournament_performances WHERE entry_id = ?").all(entryId)) as { match_id: number }[]) {
      const left = (await db.prepare("SELECT COUNT(*)::int AS n FROM tournament_performances WHERE match_id = ? AND status = 'pending'").get(m.match_id)) as { n: number };
      if (left.n === 0) await db.prepare("UPDATE tournament_matches SET status = 'done' WHERE id = ?").run(m.match_id);
    }
    await fillFinal(t.id, null);
    await finishIfDone(t.id);
    await releaseUnneeded(t.id);
    return { ok: true, value: (await entryById(entryId))! };
  }
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
      if (next.user_id) await tellEntry(next.id, t, (tr) => tr("mail.tour.promoted.s", { t: t.name }), (tr) => tr("mail.tour.promoted.b", { t: t.name, venue: t.venueName }));
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
  return englishOf(matchNamePhrase(d, m));
}

/** A match's name ("Semi-final 2") as a phrase, for staff screens in the staff language. */
function matchNamePhrase(d: TournamentDetail, m: Match): StaffText {
  if (m.stage === "group") return said("srv.round.group", { n: String(m.groupNo) });
  if (m.placement === 3) return said("srv.round.third");
  const rounds = Math.max(...d.matches.filter((x) => x.stage === "knockout").map((x) => x.round));
  const from = rounds - m.round;
  return from === 0
    ? said("srv.round.final")
    : from === 1
      ? said("srv.round.semi", { n: m.position })
      : from === 2
        ? said("srv.round.quarter", { n: m.position })
        : said("srv.round.knockout", { round: m.round, n: m.position });
}

/** What a change said, in English (as the activity log and older screens have it) and as phrases for the staff language. */
export interface Changes {
  changes: string[];
  changePhrases: StaffText[];
}

const changesOf = (phrases: StaffText[]): Changes => ({ changes: phrases.map(englishOf), changePhrases: phrases });

/** Phrases kept beside stored sentences, read back; none when there are none (rows from before) or they do not read. */
function storedPhrases(raw: string | null): StaffText[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map((x) => readStaffText(JSON.stringify(x))).filter((x): x is StaffText => x !== null) : null;
  } catch {
    return null;
  }
}

/** Who an entry is, in a sentence: their name, or "nobody". */
const entryName = (d: TournamentDetail, id: number | null): StaffValue => (id === null ? said("srv.tn.nobody") : (d.entries.find((e) => e.id === id)?.name ?? `#${id}`));

/** "A v B". */
const sidesOf = (d: TournamentDetail, a: number | null, b: number | null) => said("srv.tn.sides", { a: entryName(d, a), b: entryName(d, b) });

/** Names joined with "and", or "nobody". */
const namesAnd = (d: TournamentDetail, ids: number[]): StaffValue => (ids.length === 0 ? said("srv.tn.nobody") : joinSaid(ids.map((id) => entryName(d, id)), "srv.list.and"));

/**
 * What changed between two states of a tournament, as sentences for its
 * organiser: matches given, changed or filled differently; who now goes
 * through from each group; who is out, and whether their results count.
 */
export function describeChanges(before: TournamentDetail, after: TournamentDetail): string[] {
  return changePhrases(before, after).map(englishOf);
}

/** The same, as phrases for staff screens in the staff language. */
export function changePhrases(before: TournamentDetail, after: TournamentDetail): StaffText[] {
  const name = (id: number | null) => entryName(after, id);
  const outcome = (m: Match): StaffText =>
    m.status === "scheduled"
      ? said("srv.tn.outcome.toPlay")
      : m.status === "bye"
        ? m.winner === null
          ? said("srv.tn.outcome.byeNobody")
          : said("srv.tn.outcome.bye", { name: name(m.winner) })
        : m.status === "walkover"
          ? said("srv.tn.outcome.walkover", { name: name(m.winner) })
          : m.status === "retired"
            ? said("srv.tn.outcome.retired", { name: name(m.winner) })
            : m.winner === null
              ? m.score
                ? said("srv.tn.outcome.drawnScore", { score: m.score })
                : said("srv.tn.outcome.drawn")
              : m.score
                ? said("srv.tn.outcome.wonScore", { name: name(m.winner), score: m.score })
                : said("srv.tn.outcome.won", { name: name(m.winner) });
  const out: StaffText[] = [];
  for (const e of after.entries) {
    const was = before.entries.find((x) => x.id === e.id);
    if (e.out && !was?.out) {
      const voidNow = after.groups.some((g) => g.table.some((s) => s.entryId === e.id && s.resultsVoid));
      const why = said(e.out.stage ? `srv.tn.out.at.${e.out.stage}` : "srv.tn.out.at", { reason: said(`srv.tn.out.reason.${e.out.reason}`) });
      out.push(said(voidNow ? "srv.tn.out.void" : e.out.stage === "groups" ? "srv.tn.out.stand" : "srv.tn.out", { name: e.name, why }));
    }
  }
  for (const m of after.matches) {
    const was = before.matches.find((x) => x.id === m.id);
    if (!was) continue;
    const match = matchNamePhrase(after, m);
    if (was.a !== m.a || was.b !== m.b) out.push(said("srv.tn.change.sides", { match, sides: sidesOf(after, m.a, m.b), was: sidesOf(after, was.a, was.b) }));
    if (was.status !== m.status || was.winner !== m.winner || was.score !== m.score)
      out.push(said("srv.tn.change.result", { match, sides: sidesOf(after, m.a, m.b), outcome: outcome(m), was: outcome(was) }));
  }
  for (const g of after.groups) {
    const wasG = before.groups.find((x) => x.groupNo === g.groupNo);
    const through = (table: GroupStanding[]) => table.filter((s) => !s.out).slice(0, after.advance).map((s) => s.entryId);
    const now = through(g.table);
    const then = wasG ? through(wasG.table) : [];
    if (now.join() !== then.join()) out.push(said("srv.tn.change.group", { n: g.groupNo, now: namesAnd(after, now), was: namesAnd(after, then) }));
  }
  return out;
}

/** Is there a fee paid online for this entry or place that has not been owed back in full? */
export async function paidOnline(column: "tournament_entry_id" | "league_place_id", id: number): Promise<boolean> {
  return !!(await getDb()
    .prepare(`SELECT 1 FROM online_payments WHERE ${column} = ? AND status = 'paid' AND refund_due < amount LIMIT 1`)
    .get(id));
}

export async function setEntry(
  entryId: number,
  change: {
    paid?: boolean;
    /** How the desk took the fee, for its receipt and the cash-up (lib/cash-up.ts). */
    via?: CounterMethod | null;
    seed?: number | null;
    checkedIn?: boolean;
    eligibilityCheckedBy?: string | null;
  }
): Promise<Result<Entry>> {
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
    if (changed.changes === 1) await receiptFee("entry", entryId, change.paid, change.via);
  }
  if (change.seed !== undefined) {
    if (change.seed !== null && (!Number.isInteger(change.seed) || change.seed < 1 || change.seed > 64))
      return { ok: false, error: "A seed is 1 or more." };
    await db.prepare("UPDATE tournament_entries SET seed = ? WHERE id = ?").run(change.seed, entryId);
  }
  // Arrived on the day; taken back if marked by mistake.
  if (change.checkedIn !== undefined)
    await db.prepare(`UPDATE tournament_entries SET checked_in_at = ${change.checkedIn ? "COALESCE(checked_in_at, datetime('now'))" : "NULL"} WHERE id = ?`).run(entryId);
  // An organiser's own check (a document seen at the desk): who checked and when, never the document.
  if (change.eligibilityCheckedBy !== undefined)
    await db
      .prepare(`UPDATE tournament_entries SET eligibility_checked_at = ${change.eligibilityCheckedBy ? "datetime('now')" : "NULL"}, eligibility_checked_by = ? WHERE id = ?`)
      .run(change.eligibilityCheckedBy ? change.eligibilityCheckedBy.slice(0, 100) : null, entryId);
  const entry = await entryById(entryId);
  return entry ? { ok: true, value: entry } : { ok: false, error: "Not found." };
}

// ------------------------------------------------------------ the draw

interface NewMatch {
  key: string;
  stage: "group" | "knockout" | "heat" | "final";
  groupNo: number | null;
  round: number;
  position: number;
  a: number | null;
  b: number | null;
  nextKey: string | null;
  nextSlot: "a" | "b" | null;
  after: string[];
  bye: boolean;
  /** A heat's competitors, each in a lane. */
  lanes?: { lane: number; entryId: number }[];
  /** The third-place match; and, on a semi-final, where its loser goes. */
  placement?: 3;
  loserNextKey?: string;
  loserNextSlot?: "a" | "b";
}

/** Which stage length a match takes (Tournament.stageMinutes). */
function stageKeyOf(m: Pick<NewMatch, "stage" | "round" | "placement">, lastRound: number): StageKey {
  if (m.stage === "group") return "group";
  if (m.stage === "heat") return "heat";
  if (m.stage === "final" || m.placement === 3 || m.round === lastRound) return "final";
  return "knockout";
}

/**
 * The skeleton of a knockout of `size` lines, round by round; with
 * `thirdPlace`, a third-place match the semi-finals' losers go to.
 */
function knockout(size: number, firstPairs: [number | null, number | null][], feedersOfRoundOne: string[], thirdPlace = false): NewMatch[] {
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
  if (thirdPlace && rounds >= 2) {
    for (const semi of out.filter((m) => m.round === rounds - 1)) {
      semi.loserNextKey = "k3p";
      semi.loserNextSlot = semi.position === 1 ? "a" : "b";
    }
    out.push({
      key: "k3p",
      stage: "knockout",
      groupNo: null,
      round: rounds,
      position: 2,
      placement: 3,
      a: null,
      b: null,
      nextKey: null,
      nextSlot: null,
      after: [`k${rounds - 1}-1`, `k${rounds - 1}-2`],
      bye: false,
    });
  }
  return out;
}

/**
 * Make the draw: seeds first in seed order, everybody else by lot; the
 * matches; and a court and an hour for each. All or nothing.
 */
/**
 * A match another division of the same competition has on court: where,
 * when, for how long, and whose accounts play — or may yet play, for a side
 * still to be decided: everybody who could still reach it.
 */
interface SiblingMatch {
  id: number;
  courtId: number;
  date: string;
  minute: number;
  minutes: number;
  userIds: number[];
}

async function siblingMatches(competitionId: number, exceptTournamentId: number, own = false): Promise<SiblingMatch[]> {
  // `own`: this division's matches instead, with who could play each.
  const which = own ? "d.id = ?" : "d.id <> ?";
  const rows = (await getDb()
    .prepare(
      `SELECT m.id, m.tournament_id, m.status, m.court_id, m.date, m.start_min, COALESCE(m.minutes, d.match_minutes) AS match_minutes,
              m.next_match_id, m.next_slot, m.loser_next_match_id, m.loser_next_slot,
              (SELECT ${PERSON_OF("e")} FROM tournament_entries e WHERE e.id = m.entry_a) AS user_a,
              (SELECT ${PERSON_OF("e")} FROM tournament_entries e WHERE e.id = m.entry_b) AS user_b,
              m.entry_a IS NULL AS open_a, m.entry_b IS NULL AS open_b, m.stage,
              ARRAY(SELECT ${PERSON_OF("e")} FROM tournament_performances p JOIN tournament_entries e ON e.id = p.entry_id
                     WHERE p.match_id = m.id AND ${PERSON_OF("e")} IS NOT NULL) AS lane_users
         FROM tournament_matches m JOIN tournaments d ON d.id = m.tournament_id
        WHERE d.competition_id = ? AND ${which} AND d.status <> 'cancelled'`
    )
    .all(competitionId, exceptTournamentId)) as {
    id: number;
    tournament_id: number;
    status: string;
    court_id: number | null;
    date: string | null;
    start_min: number | null;
    match_minutes: number;
    next_match_id: number | null;
    next_slot: "a" | "b" | null;
    loser_next_match_id: number | null;
    loser_next_slot: "a" | "b" | null;
    user_a: number | null;
    user_b: number | null;
    open_a: boolean;
    open_b: boolean;
    stage: string;
    lane_users: number[] | null;
  }[];
  // Everybody entered in each division: who could fill a place nothing feeds yet (a knockout filled from the groups).
  const entered = new Map<number, number[]>();
  for (const e of (await getDb()
    .prepare(
      `SELECT e.tournament_id, ${PERSON_OF("e")} AS user_id FROM tournament_entries e JOIN tournaments d ON d.id = e.tournament_id
        WHERE d.competition_id = ? AND ${which} AND e.status = 'entered' AND ${PERSON_OF("e")} IS NOT NULL`
    )
    .all(competitionId, exceptTournamentId)) as { tournament_id: number; user_id: number }[])
    entered.set(e.tournament_id, [...(entered.get(e.tournament_id) ?? []), e.user_id]);
  const known = (r: (typeof rows)[number]) => [r.user_a, r.user_b, ...(r.lane_users ?? []).map(Number)].filter((u): u is number => u !== null);
  /** Who could still come to one side of a match: through the matches feeding it, else anybody in the division. */
  const reach = (r: (typeof rows)[number], slot: "a" | "b", seen: Set<number>): number[] => {
    const feeders = rows.filter((f) => (f.next_match_id === r.id && f.next_slot === slot) || (f.loser_next_match_id === r.id && f.loser_next_slot === slot));
    if (feeders.length === 0) return entered.get(r.tournament_id) ?? [];
    return feeders.flatMap((f) => (f.status !== "scheduled" || seen.has(f.id) ? [] : couldPlay(f, new Set([...seen, f.id]))));
  };
  const couldPlay = (r: (typeof rows)[number], seen: Set<number>): number[] =>
    r.stage === "group" || r.stage === "knockout"
      ? [...known(r), ...(r.open_a ? reach(r, "a", seen) : []), ...(r.open_b ? reach(r, "b", seen) : [])]
      : // A performance final filled only once the heats are in: anybody in the heats may swim it.
        r.stage === "final" && known(r).length === 0
        ? (entered.get(r.tournament_id) ?? [])
        : known(r);
  return rows
    .filter((r) => r.status === "scheduled" && r.court_id !== null && r.date !== null && r.start_min !== null)
    .map((r) => ({
      id: r.id,
      courtId: r.court_id!,
      date: r.date!,
      minute: r.start_min!,
      minutes: r.match_minutes,
      userIds: [...new Set(couldPlay(r, new Set([r.id])))],
    }));
}

export async function makeDraw(tournamentId: number, random: () => number = Math.random): Promise<Result<TournamentDetail>> {
  const db = getDb();
  const t = await tournamentById(tournamentId);
  if (!t || (t.status !== "open" && t.status !== "closed")) return { ok: false, error: "The draw is made already, or it is over." };
  const entries = (await db
    .prepare(`SELECT id, seed, entry_mark, ${PERSON_OF("tournament_entries")} AS user_id FROM tournament_entries WHERE tournament_id = ? AND status = 'entered' ORDER BY seed NULLS LAST, id`)
    .all(tournamentId)) as { id: number; seed: number | null; entry_mark: number | string | null; user_id: number | null }[];
  const minimum = t.format === "groups" ? 3 : 2;
  if (entries.length < minimum) return { ok: false, error: `At least ${minimum} entries are needed.` };
  if (t.format === "round_robin" && entries.length > 16) return { ok: false, error: "A round robin is for 16 entries at most: make groups instead." };
  const ranked = [...entries.filter((e) => e.seed !== null), ...shuffle(entries.filter((e) => e.seed === null), random)].map((e) => e.id);

  const matches: NewMatch[] = [];
  if (t.format === "knockout") {
    // A third-place match needs two semi-finals to come from.
    matches.push(...knockout(bracketSize(ranked.length), firstRound(ranked), [], t.thirdPlace && ranked.length >= 4));
  } else if (t.format === "performance") {
    // Heats seeded by entry mark, the best in the last heat and the middle lanes; the unmarked drawn by lot before them.
    const rules = t.rules.performance!;
    const sign = rules.better === "lower" ? 1 : -1;
    const marked = entries.filter((e) => e.entry_mark !== null).sort((x, y) => sign * (Number(x.entry_mark) - Number(y.entry_mark)) || x.id - y.id);
    const order = [...marked, ...shuffle(entries.filter((e) => e.entry_mark === null), random)].map((e) => e.id);
    const heats = seedHeats(order, rules.heatSize);
    const heatCount = Math.max(...heats.map((h) => h.heat));
    for (let h = 1; h <= heatCount; h++)
      matches.push({
        key: `h${h}`,
        stage: "heat",
        groupNo: null,
        round: 1,
        position: h,
        a: null,
        b: null,
        nextKey: null,
        nextSlot: null,
        after: [],
        bye: false,
        lanes: heats.filter((x) => x.heat === h).map((x) => ({ lane: x.lane, entryId: x.entry })),
      });
    // A final only where there is more than one heat to come from.
    if (rules.finalSize > 0 && heatCount > 1)
      matches.push({ key: "final", stage: "final", groupNo: null, round: 2, position: 1, a: null, b: null, nextKey: null, nextSlot: null, after: matches.map((m) => m.key), bye: false });
  } else {
    // A round robin is one group of everybody, and its table is the result.
    const groups = t.format === "round_robin" ? [ranked] : intoGroups(ranked, groupCount(ranked.length, t.groupSize));
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
    const qualifiers = t.format === "round_robin" ? 0 : groups.length * t.advance;
    if (qualifiers >= 2) {
      const groupKeys = matches.map((m) => m.key);
      const size = bracketSize(qualifiers);
      const lines = Array.from({ length: qualifiers }, () => null);
      // Who fills it is known only when the groups finish; byes, if any, are
      // marked then, so they still fall to the best group finishers.
      matches.push(...knockout(size, firstRound(lines).map(() => [null, null] as [null, null]), groupKeys, t.thirdPlace && qualifiers >= 4));
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
  // Each match's length: its stage's, else the tournament's.
  const lastRound = Math.max(0, ...matches.filter((m) => m.stage === "knockout").map((m) => m.round));
  const lengthOf = new Map(matches.map((m) => [m.key, minutesFor(t, stageKeyOf(m, lastRound))]));
  // A player is also known by their account, so a division does not put them on court while they play in another.
  const person = new Map(entries.filter((e) => e.user_id !== null).map((e) => [e.id, `u${e.user_id}`]));
  const sidesOf = (ids: (number | null)[]) => ids.flatMap((id) => (id === null ? [] : [`e${id}`, ...(person.has(id) ? [person.get(id)!] : [])]));
  // Who could yet play a match whose sides are still to be decided: everybody in the matches feeding it.
  const byKey = new Map(matches.map((m) => [m.key, m]));
  const fedBy = (m: NewMatch, seen = new Set<string>()): number[] =>
    m.after.flatMap((k) => {
      const f = byKey.get(k);
      if (!f || seen.has(k)) return [];
      seen.add(k);
      return [f.a, f.b, ...(f.lanes ?? []).map((l) => l.entryId), ...fedBy(f, seen)].filter((x): x is number => x !== null);
    });
  const toPlay: TimedMatch[] = matches
    .filter((m) => !m.bye)
    .map((m) => ({
      key: m.key,
      minutes: lengthOf.get(m.key)!,
      ...(m.stage !== "heat" && (m.a === null || m.b === null) ? { could: sidesOf([...new Set(fedBy(m))]) } : {}),
      sides: m.lanes
        ? sidesOf(m.lanes.map((l) => l.entryId))
        : m.stage === "final"
          ? ["final"]
          : [...(m.a !== null ? sidesOf([m.a]) : [`w:${m.key}:a`]), ...(m.b !== null ? sidesOf([m.b]) : [`w:${m.key}:b`])],
      after: m.after.filter((k) => !byes.has(k)),
    }));
  const zone = await tournamentZone(tournamentId);
  // The time still held (an outage since takes its hold away): the tournament's own hold, or
  // its competition's, within its hours each day, around what the competition's other divisions use.
  const holds = (await db
    .prepare("SELECT court_id, date, start_min, end_min FROM blocks WHERE tournament_id = ? OR (competition_id IS NOT NULL AND competition_id = ?) ORDER BY date, start_min")
    .all(tournamentId, t.competition?.id ?? null)) as { court_id: number; date: string; start_min: number; end_min: number }[];
  const windows: Window[] = holds
    .filter((h) => t.courtIds.includes(h.court_id) && h.date >= t.startsOn && h.date <= t.endsOn)
    .map((h) => ({ courtId: h.court_id, date: h.date, start: Math.max(h.start_min, t.startMin), end: Math.min(h.end_min, t.endMin) }))
    .filter((w) => w.end > w.start);
  const siblings = t.competition ? await siblingMatches(t.competition.id, tournamentId) : [];
  const sideBusy = new Map<string, Taken[]>();
  for (const o of siblings)
    for (const u of o.userIds) sideBusy.set(`u${u}`, [...(sideBusy.get(`u${u}`) ?? []), { date: o.date, start: o.minute, end: o.minute + o.minutes }]);
  const now = Date.now();
  const scheduled = scheduleTimed(toPlay, windows, {
    step: startStep([t.matchMinutes, ...toPlay.map((m) => m.minutes)]),
    origin: t.startMin,
    occupied: siblings.map((o) => ({ courtId: o.courtId, date: o.date, start: o.minute, end: o.minute + o.minutes })),
    sideBusy,
    allowed: (date, minute) => instantOf(date, minute, zone).getTime() > now,
  });
  if (!scheduled.ok)
    return {
      ok: false,
      error: `Not enough court time: ${scheduled.unplaced} of ${toPlay.length} matches do not fit in the hours held. Add courts, hours or days, shorten the matches, or take fewer entries.`,
    };

  await db.transaction(async () => {
    const ids = new Map<string, number>();
    // Last round first, so each match can point at the one its winner goes to.
    for (const m of [...matches].sort((x, y) => (y.stage === "knockout" ? y.round : 0) - (x.stage === "knockout" ? x.round : 0))) {
      const at = scheduled.placed.get(m.key);
      const info = await db
        .prepare(
          `INSERT INTO tournament_matches (tournament_id, stage, group_no, round, position, entry_a, entry_b,
                                           next_match_id, next_slot, court_id, date, start_min, winner, status,
                                           minutes, placement, loser_next_match_id, loser_next_slot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          m.bye ? "bye" : "scheduled",
          lengthOf.get(m.key)!,
          m.placement ?? null,
          m.loserNextKey ? ids.get(m.loserNextKey) ?? null : null,
          m.loserNextSlot ?? null
        );
      ids.set(m.key, info.lastInsertRowid as number);
      for (const l of m.lanes ?? [])
        await db
          .prepare("INSERT INTO tournament_performances (tournament_id, match_id, entry_id, lane) VALUES (?, ?, ?, ?)")
          .run(tournamentId, info.lastInsertRowid as number, l.entryId, l.lane);
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
  /** Who won; null for a draw, where the rules allow one. */
  winner: number | null;
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
  readonly blockers: StaffText[];
  constructor(blockers: StaffText[]) {
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
    | {
        id: number;
        tournament_id: number;
        stage: string;
        entry_a: number | null;
        entry_b: number | null;
        next_match_id: number | null;
        next_slot: "a" | "b" | null;
        loser_next_match_id: number | null;
        loser_next_slot: "a" | "b" | null;
        status: string;
      }
    | undefined;
  if (!m) return { ok: false, error: "Match not found." };
  const t = (await tournamentById(m.tournament_id))!;
  if (t.status !== "drawn" && t.status !== "finished") return { ok: false, error: "The draw is not made." };
  if (m.stage === "heat" || m.stage === "final") return { ok: false, error: "A heat's results are each competitor's marks." };
  if (m.status === "bye") return { ok: false, error: "That is a bye." };
  if (m.entry_a === null || m.entry_b === null) return { ok: false, error: "Both sides are not known yet." };
  const draw = input.winner === null;
  if (draw) {
    if (!(t.rules.scoring.kind === "tally" && t.rules.scoring.draws && m.stage === "group"))
      return { ok: false, error: "This match needs a winner: draws are allowed only in the group matches of a sport scored in goals." };
    if (input.walkover || input.retired) return { ok: false, error: "A walkover or a retirement has a winner." };
  } else if (input.winner !== m.entry_a && input.winner !== m.entry_b) return { ok: false, error: "The winner has to be one of the two." };
  if (mode === "replace" && m.stage !== "group")
    return { ok: false, error: "The match it fed has been played, so the knockout after it stands as played; a replay is arranged by hand." };
  const score = input.score?.trim() || null;
  if (score) {
    // A retirement stops part-way: the score is what was played, whoever led, and is kept as it was.
    const refusal = scoreRefusal(score, draw ? null : input.winner === m.entry_a, t.rules.scoring, { retired: input.retired, drawAllowed: draw });
    if (refusal) return { ok: false, error: refusal };
  } else if (draw) return { ok: false, error: "Give the score of the draw." };
  else if (!input.walkover && !input.retired) return { ok: false, error: "Give the score, or mark it a walkover or a retirement." };
  const loser = input.winner === m.entry_a ? m.entry_b : m.entry_a;
  // Where the winner goes on to, and a semi-final's loser (the third-place match).
  const onward = [
    { id: m.next_match_id, slot: m.next_slot, goes: input.winner },
    { id: m.loser_next_match_id, slot: m.loser_next_slot, goes: loser },
  ].filter((o): o is { id: number; slot: "a" | "b"; goes: number | null } => o.id !== null && o.slot !== null);
  let recordOnly = false;
  for (const o of onward) {
    const next = (await db.prepare("SELECT status, entry_a, entry_b FROM tournament_matches WHERE id = ?").get(o.id)) as {
      status: string;
      entry_a: number | null;
      entry_b: number | null;
    };
    const there = o.slot === "a" ? next.entry_a : next.entry_b;
    if (next.status === "done" || next.status === "walkover" || next.status === "retired") {
      // A replayed match whose winner (or loser) is who went on already: consistent, recorded, and nothing after it changes.
      if (m.status === "scheduled" && o.goes === there) recordOnly = true;
      else if (mode === "normal")
        throw new KnockoutUnderway(
          "A match it fed is played already. A manager can review what correcting this result would change, and correct its record without changing who went on."
        );
      recordOnly = true;
    }
  }
  if (recordOnly && input.outOfEvent) return { ok: false, error: "A correction of the record only cannot take anybody out of the event; withdraw them instead." };
  const before = m.stage === "group" ? qualifiers((await tournamentDetail(t.id))!, t.advance) : null;
  await decide(matchId, input.winner, score, input.retired ? "retired" : input.walkover ? "walkover" : "done", !recordOnly);
  if (input.retired && input.outOfEvent && loser !== null) {
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
  if (!wanted) throw new CorrectionBlocked([said("srv.tn.block.groupsUnfinished")]);
  const firstRound = d.matches.filter((x) => x.stage === "knockout" && x.round === 1).sort((x, y) => x.position - y.position);
  const blockers: StaffText[] = [];
  const changes: { id: number; a: number | null; b: number | null }[] = [];
  firstRound.forEach((x, i) => {
    const [a, b] = wanted[i];
    if (x.a === a && x.b === b) return;
    if (x.status !== "scheduled")
      blockers.push(said(x.status === "bye" ? "srv.tn.block.bye" : "srv.tn.block.decided", { match: matchNamePhrase(d, x), sides: sidesOf(d, x.a, x.b), as: sidesOf(d, a, b) }));
    else if (x.courtId === null || a === null || b === null) blockers.push(said("srv.tn.block.noCourt", { match: matchNamePhrase(d, x), sides: sidesOf(d, a, b) }));
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
  /**
   * Progression the "standings_only" way would leave wrong — the wrong
   * competitor in matches already played — each opened as an issue for the
   * organiser to resolve, and said here before anything is changed.
   */
  issuesIfStandingsOnly?: string[];
  issuePhrasesIfStandingsOnly?: StaffText[];
  /** False: it goes in as an ordinary result; `changes` says what it changes. Each list's `…Phrases`: the same for staff screens in the staff language. */
  needsCorrection: boolean;
  changes: string[];
  changePhrases: StaffText[];
  /** Put into the knockout too: possible, and what it changes; or why not. */
  replace: ({ possible: true } & Changes) | { possible: false; blockers: string[]; blockerPhrases: StaffText[] };
  /** Corrected in the group table only, the knockout left as it is being played. */
  standingsOnly: Changes;
  /** Given back to confirm against: a change made meanwhile makes it stale. */
  token: string;
}

/** What a result would change, without changing anything; for one that needs a correction, both ways of making it. */
export async function previewResult(matchId: number, input: ResultInput): Promise<Result<CorrectionPreview>> {
  const m = (await getDb().prepare("SELECT tournament_id FROM tournament_matches WHERE id = ?").get(matchId)) as { tournament_id: number } | undefined;
  if (!m) return { ok: false, error: "Match not found." };
  const token = await correctionToken(m.tournament_id, matchId, input);
  const attempt = (mode: ResultMode) =>
    dryRun(async (): Promise<{ ok: true; changes: StaffText[]; issues?: StaffText[] } | { ok: false; error: string; blockers?: StaffText[]; underway?: boolean }> => {
      const before = (await tournamentDetail(m.tournament_id, { forStaff: true }))!;
      try {
        const done = await recordResultOnce(matchId, input, mode);
        if (!done.ok) return done;
        const issues = mode === "standings_only" ? findProgressionIssues(before, done.value, matchId).map((i) => issueSentence(done.value, i)) : [];
        return { ok: true, changes: changePhrases(before, done.value), issues };
      } catch (err) {
        if (err instanceof KnockoutUnderway) return { ok: false, error: err.message, underway: true };
        if (err instanceof CorrectionBlocked) return { ok: false, error: "blocked", blockers: err.blockers };
        throw err;
      }
    });
  const normal = await attempt("normal");
  if (normal.ok) {
    const both = changesOf(normal.changes);
    return { ok: true, value: { needsCorrection: false, ...both, replace: { possible: true, ...both }, standingsOnly: both, token } };
  }
  if (!normal.underway) return { ok: false, error: normal.error };
  const replace = await attempt("replace");
  const standingsOnly = await attempt("standings_only");
  if (!standingsOnly.ok) return { ok: false, error: standingsOnly.error };
  return {
    ok: true,
    value: {
      needsCorrection: true,
      changes: [],
      changePhrases: [],
      replace: replace.ok
        ? { possible: true, ...changesOf(replace.changes) }
        : replace.blockers
          ? { possible: false, blockers: replace.blockers.map(englishOf), blockerPhrases: replace.blockers }
          : { possible: false, blockers: [replace.error], blockerPhrases: [] },
      standingsOnly: changesOf(standingsOnly.changes),
      issuesIfStandingsOnly: (standingsOnly.issues ?? []).map(englishOf),
      issuePhrasesIfStandingsOnly: standingsOnly.issues ?? [],
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
): Promise<Result<{ detail: TournamentDetail } & Changes>> {
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
      const changes = changePhrases(before, done.value);
      const touched = new Set(done.value.matches.filter((x) => {
        const was = before.matches.find((y) => y.id === x.id)!;
        return was.status !== x.status || was.winner !== x.winner || was.a !== x.a || was.b !== x.b || was.score !== x.score;
      }).map((x) => x.id));
      await getDb()
        .prepare(
          `INSERT INTO tournament_corrections (tournament_id, match_id, kind, reason, changes, change_phrases, before_state, admin_id, admin_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          m.tournament_id,
          matchId,
          confirm.mode,
          reason.slice(0, 1000),
          JSON.stringify(changes.map(englishOf)),
          JSON.stringify(changes),
          JSON.stringify(before.matches.filter((x) => touched.has(x.id))),
          by.id,
          by.name
        );
      // The record put right, the knockout left as played: where that left the wrong competitor in it, say so, and hold the finish.
      if (confirm.mode === "standings_only") {
        const found = findProgressionIssues(before, done.value, matchId);
        for (const issue of found) {
          await getDb()
            .prepare(
              `INSERT INTO tournament_issues (tournament_id, from_match_id, wrong_entry, right_entry, reason, affected, opened_by)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(m.tournament_id, issue.fromMatchId, issue.wrong, issue.right, reason.slice(0, 1000), JSON.stringify(issue.affected), by.id);
          changes.push(issueSentence(done.value, issue));
        }
        // Finished on progression now known to be wrong: not finished until it is resolved.
        if (found.length > 0) await getDb().prepare("UPDATE tournaments SET status = 'drawn' WHERE id = ? AND status = 'finished'").run(m.tournament_id);
      }
      return { ok: true, value: { detail: (await tournamentDetail(m.tournament_id, { forStaff: true }))!, ...changesOf(changes) } };
    });
  } catch (err) {
    if (err instanceof CorrectionBlocked) return { ok: false, error: `It cannot be put into the knockout safely: ${err.blockers.map(englishOf).join(" ")}`, code: "BLOCKED" };
    throw err;
  }
}

// ------------------------------------------------------------ performance events

export interface PerformanceInput {
  entryId: number;
  /** Each attempt as written: "1:02.35", "7.42", "X" for a foul; as many as the rules give, or fewer for "best". */
  attempts?: string[];
  /** "ok" (the default when attempts are given), or why there is no result: did not start, did not finish, disqualified. */
  status?: "ok" | "dns" | "dnf" | "dq";
  note?: string;
}

/**
 * A heat's or final's results: each competitor's attempts, or why they have
 * none. Marks are read as the event measures them; a total needs every
 * attempt. Once every competitor in it has a line, it is done; once every
 * heat is, the final is filled from the heats' ranking (the best in the
 * middle lanes) — unless competitors are level for its last place, when the
 * organiser chooses (makeFinal). A heat put right after the final is filled
 * is refused if it would change who is in the final and the final has any
 * result; before then the final is filled again. All one change.
 */
export async function recordPerformances(matchId: number, lines: PerformanceInput[]): Promise<Result<TournamentDetail>> {
  return withTransaction(async (): Promise<Result<TournamentDetail>> => {
    const db = getDb();
    const m = (await db.prepare("SELECT id, tournament_id, stage FROM tournament_matches WHERE id = ?").get(matchId)) as
      | { id: number; tournament_id: number; stage: string }
      | undefined;
    if (!m || (m.stage !== "heat" && m.stage !== "final")) return { ok: false, error: "That is not a heat or a final." };
    const t = (await tournamentById(m.tournament_id))!;
    if (t.status !== "drawn" && t.status !== "finished") return { ok: false, error: "The draw is not made." };
    const rules = t.rules.performance!;
    const inIt = new Set(
      ((await db.prepare("SELECT entry_id FROM tournament_performances WHERE match_id = ?").all(matchId)) as { entry_id: number }[]).map((r) => r.entry_id)
    );
    if (inIt.size === 0) return { ok: false, error: "Nobody is in it yet." };
    const before = m.stage === "heat" ? await finalists(t.id) : null;
    for (const line of lines) {
      if (!inIt.has(line.entryId)) return { ok: false, error: "Somebody given is not in it." };
      const status = line.status ?? "ok";
      if (!["ok", "dns", "dnf", "dq"].includes(status)) return { ok: false, error: "A result, or did not start, did not finish, disqualified." };
      let attempts: (number | null)[] = [];
      let result: number | null = null;
      if (status === "ok") {
        const given = (line.attempts ?? []).map((a) => String(a ?? "").trim()).filter((a) => a !== "");
        if (given.length === 0) return { ok: false, error: "Give each competitor's mark, or say why there is none." };
        if (given.length > rules.attempts) return { ok: false, error: `${rules.attempts} attempt${rules.attempts === 1 ? "" : "s"} each at most.` };
        for (const a of given) {
          const mark = parseMark(a, rules.measure);
          if (mark === undefined) return { ok: false, error: rules.measure === "time" ? `"${a}" is not a time: write 1:02.35 or 62.35.` : `"${a}" is not a mark: write a number, or X for a foul.` };
          attempts.push(mark);
        }
        result = rules.aggregate === "total" && attempts.length < rules.attempts ? null : aggregate(attempts, rules);
        if (result === null)
          return { ok: false, error: rules.aggregate === "total" ? `A total needs all ${rules.attempts} scores.` : "Every attempt is a foul: no result — say so with did not finish, or give a mark." };
      } else attempts = [];
      await db
        .prepare("UPDATE tournament_performances SET attempts = ?, result = ?, status = ?, note = ?, updated_at = datetime('now') WHERE match_id = ? AND entry_id = ?")
        .run(JSON.stringify(attempts), result, status, line.note?.trim().slice(0, 300) || null, matchId, line.entryId);
    }
    // Every line in: done.
    const pending = (await db.prepare("SELECT COUNT(*)::int AS n FROM tournament_performances WHERE match_id = ? AND status = 'pending'").get(matchId)) as { n: number };
    await db.prepare("UPDATE tournament_matches SET status = ?, updated_at = datetime('now') WHERE id = ?").run(pending.n === 0 ? "done" : "scheduled", matchId);
    if (m.stage === "heat") {
      const now = await finalists(t.id);
      const final = (await db.prepare("SELECT id FROM tournament_matches WHERE tournament_id = ? AND stage = 'final'").get(t.id)) as { id: number } | undefined;
      if (final && before && before.filled && now.wanted && now.wanted.join() !== before.current.join()) {
        const started = (await db.prepare("SELECT 1 FROM tournament_performances WHERE match_id = ? AND status <> 'pending'").get(final.id)) as unknown;
        if (started) throw new PerformanceRefused("The final has results: a heat correction that changes who was in it is not made. Correct the final's results, or arrange a re-swim by hand.");
        await db.prepare("DELETE FROM tournament_performances WHERE match_id = ?").run(final.id);
      }
      await fillFinal(t.id, null);
    }
    await finishIfDone(t.id);
    await releaseUnneeded(t.id);
    return { ok: true, value: (await tournamentDetail(t.id, { forStaff: true }))! };
  }).catch((err) => {
    if (err instanceof PerformanceRefused) return { ok: false as const, error: err.message };
    throw err;
  });
}

class PerformanceRefused extends Error {}

/** Who is in the final now, and who the heats send (null while a heat is still to finish, or a tie for the last place needs choosing). */
async function finalists(tournamentId: number): Promise<{ filled: boolean; current: number[]; wanted: number[] | null }> {
  const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
  const final = d.matches.find((m) => m.stage === "final");
  const current = final ? (d.performance!.lines[final.id] ?? []).map((l) => l.entryId).sort((a, b) => a - b) : [];
  return { filled: current.length > 0, current, wanted: final ? wantedFinalists(d, null)?.sort((a, b) => a - b) ?? null : null };
}

/** The heats' best, for the final, in ranking order; null until every heat is done, or while a tie for the last place is unchosen. */
function wantedFinalists(d: TournamentDetail, chosen: number[] | null): number[] | null {
  const rules = d.rules.performance!;
  if (d.matches.some((m) => m.stage === "heat" && m.status === "scheduled")) return null;
  const out = new Set(d.entries.filter((e) => e.out).map((e) => e.id));
  const heatRanking = d.performance!.ranking.filter((r) => r.stage === "heat" && r.rank !== null && !out.has(r.entryId));
  if (heatRanking.length <= rules.finalSize) return heatRanking.map((r) => r.entryId);
  const lastRank = heatRanking[rules.finalSize - 1].rank;
  const sure = heatRanking.filter((r) => r.rank! < lastRank!).map((r) => r.entryId);
  const level = heatRanking.filter((r) => r.rank === lastRank).map((r) => r.entryId);
  if (sure.length + level.length <= rules.finalSize) return [...sure, ...level];
  if (!chosen) return null;
  const places = rules.finalSize - sure.length;
  if (chosen.length !== places || chosen.some((id) => !level.includes(id))) return null;
  return [...sure, ...chosen];
}

/** Fill the final from the heats, if it is empty and the heats say who: lanes from the middle out, the best in the middle. */
async function fillFinal(tournamentId: number, chosen: number[] | null): Promise<boolean> {
  const db = getDb();
  const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
  const final = d.matches.find((m) => m.stage === "final");
  if (!final || (d.performance!.lines[final.id] ?? []).length > 0) return false;
  const wanted = wantedFinalists(d, chosen);
  if (!wanted || wanted.length === 0) return false;
  const { centreOutLanes } = await import("./performance-math");
  const lanes = centreOutLanes(Math.max(d.rules.performance!.finalSize, wanted.length));
  for (let i = 0; i < wanted.length; i++)
    await db.prepare("INSERT INTO tournament_performances (tournament_id, match_id, entry_id, lane) VALUES (?, ?, ?, ?)").run(tournamentId, final.id, wanted[i], lanes[i]);
  await db.prepare("UPDATE tournament_matches SET status = 'scheduled' WHERE id = ?").run(final.id);
  return true;
}

/**
 * The organiser's choice for the last places in the final, where competitors
 * are level on their heat results (after a swim-off, say): exactly as many
 * of those level as there are places left.
 */
export async function makeFinal(tournamentId: number, chosen: number[]): Promise<Result<TournamentDetail>> {
  return withTransaction(async (): Promise<Result<TournamentDetail>> => {
    const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
    if (!d.performance?.tieForFinal) return { ok: false, error: "Nobody is level for the final's last place." };
    if (!(await fillFinal(tournamentId, chosen))) return { ok: false, error: "Choose exactly as many of those level as there are places left in the final." };
    return { ok: true, value: (await tournamentDetail(tournamentId, { forStaff: true }))! };
  });
}

// ------------------------------------------------------------ progression issues

interface FoundIssue {
  fromMatchId: number;
  wrong: number;
  right: number | null;
  affected: ProgressionIssue["affected"];
}

const played = (m: Match) => m.status === "done" || m.status === "walkover" || m.status === "retired";

/**
 * The matches a competitor is in from `fromId` on, in place of another:
 * that match, then each one they went on to by winning — the chain a
 * wrong advancement runs along. Ends at a match they lost, have not played,
 * or the final.
 */
function wrongChain(d: TournamentDetail, fromId: number, wrong: number): Match[] {
  const chain: Match[] = [];
  let m = d.matches.find((x) => x.id === fromId);
  while (m && (m.a === wrong || m.b === wrong) && !chain.includes(m)) {
    chain.push(m);
    if (!(played(m) && m.winner === wrong && m.next !== null)) break;
    m = d.matches.find((x) => x.id === m!.next);
  }
  return chain;
}

function chainSentences(d: TournamentDetail, chain: Match[], wrong: number, right: number | null): ProgressionIssue["affected"] {
  const name = (id: number | null) => entryName(d, id);
  return chain.map((m) => {
    const opponent = m.a === wrong ? m.b : m.a;
    const who = { match: matchNamePhrase(d, m), wrong: name(wrong), right: name(right), opponent: name(opponent) };
    const how = m.score ? "Score" : m.status === "walkover" ? "Walkover" : "";
    const result = m.winner === null ? said(`srv.tn.chain.drawn${how}`, { score: m.score ?? "" }) : said(`srv.tn.chain.won${how}`, { name: name(m.winner), score: m.score ?? "" });
    const phrase = played(m)
      ? said(right === null ? "srv.tn.chain.played" : "srv.tn.chain.playedInstead", { ...who, result })
      : said(right === null ? "srv.tn.chain.toPlay" : "srv.tn.chain.toPlayInstead", who);
    return { matchId: m.id, played: played(m), text: englishOf(phrase), phrase };
  });
}

/**
 * Progression a record-only correction leaves wrong. A knockout result
 * corrected after its next match was played: whoever went on was the old
 * winner, and the new one should have. A group result corrected in the
 * table only: each line of the knockout whose competitor is not the one
 * the tables now send. Only where the wrong competitor has played on, or
 * is to — otherwise nothing is inconsistent.
 */
function findProgressionIssues(before: TournamentDetail, after: TournamentDetail, matchId: number): FoundIssue[] {
  const was = before.matches.find((m) => m.id === matchId);
  const now = after.matches.find((m) => m.id === matchId);
  if (!was || !now) return [];
  const found: FoundIssue[] = [];
  if (now.stage === "knockout") {
    if (was.winner !== null && now.winner !== was.winner && now.next !== null) {
      const chain = wrongChain(after, now.next, was.winner);
      if (chain.length > 0) found.push({ fromMatchId: now.next, wrong: was.winner, right: now.winner, affected: chainSentences(after, chain, was.winner, now.winner) });
    }
    // A semi-final: who went to the third-place match lost it before, and has now won it.
    if (was.winner !== null && now.winner !== null && now.winner !== was.winner && now.loserNext !== null) {
      const chain = wrongChain(after, now.loserNext, now.winner);
      if (chain.length > 0) found.push({ fromMatchId: now.loserNext, wrong: now.winner, right: was.winner, affected: chainSentences(after, chain, now.winner, was.winner) });
    }
    return found;
  }
  const wanted = qualifiers(after, after.advance);
  if (!wanted) return found;
  const first = after.matches.filter((m) => m.stage === "knockout" && m.round === 1).sort((x, y) => x.position - y.position);
  first.forEach((m, i) => {
    (["a", "b"] as const).forEach((side, k) => {
      const there = m[side];
      const should = wanted[i]?.[k] ?? null;
      if (there === null || there === should) return;
      const chain = wrongChain(after, m.id, there);
      if (chain.length > 0) found.push({ fromMatchId: m.id, wrong: there, right: should, affected: chainSentences(after, chain, there, should) });
    });
  });
  return found;
}

function issueSentence(d: TournamentDetail, i: FoundIssue): StaffText {
  return said("srv.tn.issue.underReview", {
    wrong: entryName(d, i.wrong),
    right: entryName(d, i.right),
    affected: joinSaid(i.affected.map((a) => a.phrase ?? a.text), "srv.list.space"),
  });
}

/** A fingerprint of a tournament as it stands, for confirming against what was reviewed. */
async function stateToken(tournamentId: number, extra: unknown = null): Promise<string> {
  const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
  const state = {
    extra,
    matches: d.matches.map((m) => [m.id, m.status, m.winner, m.a, m.b, m.score, m.courtId, m.date, m.minute]),
    entries: d.entries.map((e) => [e.id, e.status]),
    issues: d.issues.map((i) => [i.id, i.status]),
  };
  const crypto = await import("crypto");
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 32);
}

export interface IssueReview {
  issue: ProgressionIssue;
  /** Replaying: the matches to replay and those needing a new court and time, or why it cannot be done here. */
  replay:
    | { possible: true; matches: { matchId: number; name: string; namePhrase: StaffText; needsSlot: boolean }[] }
    | { possible: false; blockers: string[]; blockerPhrases: StaffText[] };
  token: string;
}

/** What replaying the wrong chain would do, or why it cannot be done safely here. */
async function replayPlan(d: TournamentDetail, issue: ProgressionIssue): Promise<IssueReview["replay"]> {
  const name = (id: number | null) => entryName(d, id);
  const blockers: StaffText[] = [];
  if (issue.rightEntry === null) blockers.push(said("srv.tn.replay.nobody"));
  else {
    if (d.entries.find((e) => e.id === issue.rightEntry)?.out) blockers.push(said("srv.tn.replay.left", { name: name(issue.rightEntry) }));
    // Already in the knockout from where it went wrong on: they cannot be in two places in it.
    const from = d.matches.find((m) => m.id === issue.fromMatchId);
    const elsewhere = d.matches.find((m) => m.stage === "knockout" && m.round >= (from?.round ?? 1) && (m.a === issue.rightEntry || m.b === issue.rightEntry));
    if (elsewhere) blockers.push(said("srv.tn.replay.already", { name: name(issue.rightEntry), match: matchNamePhrase(d, elsewhere) }));
  }
  if (d.entries.find((e) => e.id === issue.wrongEntry)?.out && blockers.length === 0) {
    // Out since: their place is still the right one's; replaying is still possible.
  }
  const chain = wrongChain(d, issue.fromMatchId, issue.wrongEntry);
  if (chain.length === 0) blockers.push(said("srv.tn.replay.changed"));
  if (blockers.length > 0) return { possible: false, blockers: blockers.map(englishOf), blockerPhrases: blockers };
  const zone = await tournamentZone(d.id);
  const now = Date.now();
  return {
    possible: true,
    matches: chain.map((m) => ({
      matchId: m.id,
      name: matchName(d, m),
      namePhrase: matchNamePhrase(d, m),
      needsSlot: played(m) || m.courtId === null || m.date === null || m.minute === null || instantOf(m.date, m.minute, zone).getTime() <= now,
    })),
  };
}

/** The open issue, what letting it stand or replaying would mean, and a token to confirm against. */
export async function reviewIssue(issueId: number): Promise<Result<IssueReview>> {
  const row = (await getDb().prepare("SELECT tournament_id FROM tournament_issues WHERE id = ?").get(issueId)) as { tournament_id: number } | undefined;
  if (!row) return { ok: false, error: "Not found." };
  const d = (await tournamentDetail(row.tournament_id, { forStaff: true }))!;
  const issue = d.issues.find((i) => i.id === issueId)!;
  if (issue.status !== "open") return { ok: false, error: "That has been resolved." };
  return { ok: true, value: { issue, replay: await replayPlan(d, issue), token: await stateToken(d.id, issueId) } };
}

export interface MatchSlot {
  courtId: number;
  date: string;
  startMin: number;
}

/**
 * Give a match a court and a time, held for the tournament like the rest of
 * its time: the court must be the venue's for the sport, open then, in the
 * future, not used by another of its matches, with neither side playing
 * elsewhere then; and the time must be the tournament's already or free to
 * hold — a booking there is never moved (blockSlots holds around it, and the
 * slot is refused). Inside the caller's transaction.
 */
async function holdMatchSlot(t: Tournament, match: Match, slot: MatchSlot, ignoring: Set<number>): Promise<string | null> {
  const db = getDb();
  const end = slot.startMin + match.minutes;
  if (!isValidDateString(slot.date) || !Number.isInteger(slot.startMin)) return "Give the date and time.";
  const court = (await db
    .prepare("SELECT c.id, c.name FROM courts c WHERE c.id = ? AND c.venue_id = ? AND EXISTS (SELECT 1 FROM court_activities ca WHERE ca.court_id = c.id AND ca.sport = ?)")
    .get(slot.courtId, t.venueId, t.sport)) as { id: number; name: string } | undefined;
  if (!court) return "Choose one of this venue's courts for the sport.";
  const zone = await tournamentZone(t.id);
  if (instantOf(slot.date, slot.startMin, zone).getTime() <= Date.now()) return `${slot.date} ${formatMinute(slot.startMin)} has gone by.`;
  const venue = (await db.prepare("SELECT open_min, close_min, week_hours FROM venues WHERE id = ?").get(t.venueId)) as {
    open_min: number;
    close_min: number;
    week_hours: string | null;
  };
  const on = hoursOn({ openMin: venue.open_min, closeMin: venue.close_min, weekHours: parseWeekHours(venue.week_hours) }, slot.date);
  if (on.closed || slot.startMin < on.openMin || end > on.closeMin) return `The venue is not open for all of ${formatMinute(slot.startMin)}–${formatMinute(end)} on ${slot.date}.`;
  const others = (await db
    .prepare(
      `SELECT id, court_id, entry_a, entry_b, start_min FROM tournament_matches
        WHERE tournament_id = ? AND status = 'scheduled' AND date = ? AND start_min < ? AND start_min + COALESCE(minutes, ?) > ? AND id <> ?`
    )
    .all(t.id, slot.date, end, t.matchMinutes, slot.startMin, match.id)) as { id: number; court_id: number | null; entry_a: number | null; entry_b: number | null }[];
  const live = others.filter((o) => !ignoring.has(o.id));
  if (live.some((o) => o.court_id === slot.courtId)) return `Another match of this tournament is on ${court.name} then.`;
  if (t.competition) {
    const elsewhere = (await siblingMatches(t.competition.id, t.id)).filter((o) => o.date === slot.date && o.minute < end && slot.startMin < o.minute + o.minutes);
    if (elsewhere.some((o) => o.courtId === slot.courtId)) return `A match of another division is on ${court.name} then.`;
    // Its sides, and for a side still to be decided everybody who could reach it.
    const sides = (await getDb()
      .prepare(`SELECT ${PERSON_OF("tournament_entries")} AS user_id FROM tournament_entries WHERE id IN (${[match.a ?? 0, match.b ?? 0].join(",")}) AND ${PERSON_OF("tournament_entries")} IS NOT NULL`)
      .all()) as { user_id: number }[];
    const players = [...sides.map((p) => p.user_id), ...((await siblingMatches(t.competition.id, t.id, true)).find((o) => o.id === match.id)?.userIds ?? [])];
    if (elsewhere.some((o) => o.userIds.some((u) => players.includes(u)))) return "One of the sides plays in another division then.";
  }
  const sides = [match.a, match.b].filter((x): x is number => x !== null);
  if (live.some((o) => sides.includes(o.entry_a ?? -1) || sides.includes(o.entry_b ?? -1))) return "One of the sides plays another match then.";
  const covered = async () =>
    !!(await db
      .prepare(
        "SELECT 1 FROM blocks WHERE (tournament_id = ? OR (competition_id IS NOT NULL AND competition_id = ?)) AND court_id = ? AND date = ? AND start_min <= ? AND end_min >= ?"
      )
      .get(t.id, t.competition?.id ?? null, slot.courtId, slot.date, slot.startMin, end));
  if (!(await covered())) {
    const held = await blockSlots(
      slot.courtId,
      slot.date,
      { start: slot.startMin, end },
      t.competition ? `Competition: ${t.competition.name}` : `Tournament: ${t.name}`,
      undefined,
      t.competition ? { competitionId: t.competition.id } : { tournamentId: t.id }
    );
    if (!held.ok || !(await covered())) {
      if (held.ok && held.blockIds.length > 0) await db.prepare(`DELETE FROM blocks WHERE id IN (${held.blockIds.map(() => "?").join(",")})`).run(...held.blockIds);
      return `${court.name} is not free for all of ${formatMinute(slot.startMin)}–${formatMinute(end)} on ${slot.date}: a booking or a block is there.`;
    }
  }
  await db.prepare("UPDATE tournament_matches SET court_id = ?, date = ?, start_min = ?, updated_at = datetime('now') WHERE id = ?").run(slot.courtId, slot.date, slot.startMin, match.id);
  return null;
}

/**
 * Move a fixture still to play, or change how long it is given, as an
 * organiser: to a court and time held for the tournament or free to hold,
 * with the same checks as any match's slot (holdMatchSlot), after every
 * match feeding it ends and before every match it feeds begins. The
 * length is the time held, not a limit on play. Both sides are told.
 * Atomic: the match moves, and the time it needs is held, or nothing changes.
 */
export async function moveMatch(matchId: number, to: MatchSlot & { minutes?: number }): Promise<Result<{ detail: TournamentDetail; change: string }>> {
  const row = (await getDb().prepare("SELECT tournament_id FROM tournament_matches WHERE id = ?").get(matchId)) as { tournament_id: number } | undefined;
  if (!row) return { ok: false, error: "Match not found." };
  const tournamentId = row.tournament_id;
  const result = await withTransaction(async (): Promise<Result<{ detail: TournamentDetail; change: string }>> => {
    const db = getDb();
    // One change to a tournament's fixtures at a time.
    await db.prepare("SELECT id FROM tournaments WHERE id = ? FOR UPDATE").get(tournamentId);
    const t = (await tournamentById(tournamentId))!;
    if (t.status !== "drawn") return { ok: false, error: "Fixtures are moved once the draw is made, until it is over." };
    const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
    const m = d.matches.find((x) => x.id === matchId)!;
    if (m.status !== "scheduled") return { ok: false, error: "That match is decided: a result is corrected, not moved." };
    const minutes = to.minutes ?? m.minutes;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) return { ok: false, error: "Give the match 5 minutes to 10 hours." };
    const start = { date: to.date, minute: to.startMin };
    const end = { date: to.date, minute: to.startMin + minutes };
    const before = (x: { date: string; minute: number }, y: { date: string; minute: number }) => x.date < y.date || (x.date === y.date && x.minute <= y.minute);
    // What has to be over first, and what has to come after.
    const firstRoundAfterGroups = m.stage === "knockout" && m.round === 1 && d.matches.some((x) => x.stage === "group");
    const feeders = d.matches.filter(
      (x) => x.next === m.id || x.loserNext === m.id || (firstRoundAfterGroups && x.stage === "group") || (m.stage === "final" && x.stage === "heat")
    );
    const fed = d.matches.filter(
      (x) =>
        x.id === m.next ||
        x.id === m.loserNext ||
        (m.stage === "group" && x.stage === "knockout" && x.round === 1) ||
        (m.stage === "heat" && x.stage === "final")
    );
    for (const f of feeders)
      if (f.status === "scheduled" && f.date !== null && f.minute !== null && !before({ date: f.date, minute: f.minute + f.minutes }, start))
        return { ok: false, error: `${matchName(d, m)} has to start after ${matchName(d, f)} ends (${f.date} ${formatMinute(f.minute + f.minutes)}).` };
    for (const f of fed)
      if (f.status === "scheduled" && f.date !== null && f.minute !== null && !before(end, { date: f.date, minute: f.minute }))
        return { ok: false, error: `${matchName(d, m)} has to end before ${matchName(d, f)} starts (${f.date} ${formatMinute(f.minute)}).` };
    const refused = await holdMatchSlot(t, { ...m, minutes }, to, new Set());
    if (refused) throw new IssueRefused(refused);
    await db.prepare("UPDATE tournament_matches SET minutes = ?, updated_at = datetime('now') WHERE id = ?").run(minutes, matchId);
    const court = (await db.prepare("SELECT name FROM courts WHERE id = ?").get(to.courtId)) as { name: string };
    const change = `${matchName(d, m)} moved to ${to.date} ${formatMinute(to.startMin)}–${formatMinute(to.startMin + minutes)}, ${court.name}${
      m.date !== null && m.minute !== null ? ` (was ${m.date} ${formatMinute(m.minute)}–${formatMinute(m.minute + m.minutes)}, ${m.courtName ?? ""})` : ""
    }.`;
    return { ok: true, value: { detail: (await tournamentDetail(tournamentId, { forStaff: true }))!, change } };
  }).catch((err) => {
    if (err instanceof IssueRefused) return { ok: false as const, error: err.message };
    throw err;
  });
  if (!result.ok) return result;
  // Time the old slot no longer needs goes back on sale.
  await releaseUnneeded(tournamentId);
  const d = result.value.detail;
  const m = d.matches.find((x) => x.id === matchId)!;
  for (const entryId of [m.a, m.b]) {
    if (entryId !== null)
      await tellEntry(
        entryId,
        d,
        (tr) => tr("mail.tour.moved.s", { t: d.name }),
        (tr) => tr("mail.tour.moved.b", { match: matchName(d, m), t: d.name, date: m.date!, time: formatMinute(m.minute!, tr.locale), court: m.courtName ?? "" })
      );
  }
  return { ok: true, value: { detail: (await tournamentDetail(tournamentId, { forStaff: true }))!, change: result.value.change } };
}

/**
 * Resolve a progression issue, as an organiser who reviewed it, with a
 * reason. "stand": the results as played stand, the wrong advancement
 * accepted (the other side agreed, say), and it is recorded so. "replay":
 * the matches the wrong competitor played from where they went wrong are
 * played again — the first with the right competitor in their place, each
 * later one with whoever wins the one before — each at a court and time the
 * organiser gives and the tournament holds; what was played is kept in the
 * record, never deleted, and nothing after the replays is touched (if a
 * replay changes who goes on again, that is a correction of its own).
 * Confirmed only against the tournament as it was reviewed.
 */
export async function resolveIssue(
  issueId: number,
  confirm: { action: "stand" | "replay"; reason: string; token: string; slots?: Record<string, MatchSlot> },
  by: { id: number; name: string }
): Promise<Result<{ detail: TournamentDetail } & Changes>> {
  const row = (await getDb().prepare("SELECT tournament_id, status FROM tournament_issues WHERE id = ?").get(issueId)) as
    | { tournament_id: number; status: string }
    | undefined;
  if (!row) return { ok: false, error: "Not found." };
  if (row.status !== "open") return { ok: false, error: "That has been resolved." };
  const reason = confirm.reason?.trim() ?? "";
  if (reason.length < 5) return { ok: false, error: "Say why: how it was resolved is kept with its reason." };
  if (confirm.action !== "stand" && confirm.action !== "replay") return { ok: false, error: 'Let the results "stand", or "replay".' };
  if ((await stateToken(row.tournament_id, issueId)) !== confirm.token)
    return { ok: false, error: "The tournament has changed since you looked. Review it again.", code: "CHANGED" };
  const tournamentId = row.tournament_id;
  const result = await withTransaction(async (): Promise<Result<{ detail: TournamentDetail } & Changes>> => {
    const db = getDb();
    const before = (await tournamentDetail(tournamentId, { forStaff: true }))!;
    const t = (await tournamentById(tournamentId))!;
    const issue = before.issues.find((i) => i.id === issueId)!;
    const name = (id: number | null) => entryName(before, id);
    let changes: StaffText[];
    let reset: Match[] = [];
    if (confirm.action === "stand") {
      changes = [said("srv.tn.stand", { wrong: name(issue.wrongEntry), right: name(issue.rightEntry) })];
    } else {
      const plan = await replayPlan(before, issue);
      if (!plan.possible) return { ok: false, error: `It cannot be replayed here: ${plan.blockers.join(" ")}`, code: "BLOCKED" };
      const chain = wrongChain(before, issue.fromMatchId, issue.wrongEntry);
      const ids = new Set(chain.map((m) => m.id));
      changes = [];
      let previousEnd: { date: string; minute: number } | null = null;
      for (let i = 0; i < chain.length; i++) {
        const m = chain[i];
        const need = plan.matches.find((x) => x.matchId === m.id)!;
        // Who plays it: the right competitor in the first; in each later one, whoever wins the replay before.
        const feederSide = i === 0 ? (m.a === issue.wrongEntry ? "a" : "b") : chain[i - 1].nextSlot!;
        const newSide = i === 0 ? issue.rightEntry : null;
        await db
          .prepare(`UPDATE tournament_matches SET entry_${feederSide} = ?, winner = NULL, score = NULL, status = 'scheduled', updated_at = datetime('now') WHERE id = ?`)
          .run(newSide, m.id);
        const slot = confirm.slots?.[String(m.id)];
        if (need.needsSlot && !slot) throw new IssueRefused(`Give ${need.name} a court and a time for the replay.`);
        if (slot) {
          if (previousEnd && (slot.date < previousEnd.date || (slot.date === previousEnd.date && slot.startMin < previousEnd.minute)))
            throw new IssueRefused(`${need.name} has to be after the match before it in the replay.`);
          const fresh = { ...m, a: feederSide === "a" ? newSide : m.a, b: feederSide === "b" ? newSide : m.b };
          const refused = await holdMatchSlot(t, fresh, slot, ids);
          if (refused) throw new IssueRefused(`${need.name}: ${refused}`);
          previousEnd = { date: slot.date, minute: slot.startMin + m.minutes };
        } else if (m.date !== null && m.minute !== null) previousEnd = { date: m.date, minute: m.minute + m.minutes };
        const at: Record<string, StaffValue> = slot ? { date: slot.date, time: clockValue(slot.startMin) } : {};
        changes.push(
          i === 0
            ? said(slot ? "srv.tn.replay.firstAt" : "srv.tn.replay.first", { match: need.namePhrase, right: name(issue.rightEntry), wrong: name(issue.wrongEntry), ...at })
            : said(slot ? "srv.tn.replay.nextAt" : "srv.tn.replay.next", { match: need.namePhrase, ...at })
        );
      }
      // The last match the wrong competitor won sent them on: that place now waits for the replay's winner.
      const last = chain[chain.length - 1];
      if (played(last) && last.winner === issue.wrongEntry && last.next !== null && !ids.has(last.next)) {
        const after = before.matches.find((x) => x.id === last.next);
        if (after && after.status === "scheduled") await db.prepare(`UPDATE tournament_matches SET entry_${last.nextSlot} = NULL WHERE id = ?`).run(last.next);
      }
      reset = chain;
    }
    await db
      .prepare("UPDATE tournament_issues SET status = ?, resolved_by = ?, resolution_reason = ?, resolved_at = datetime('now') WHERE id = ?")
      .run(confirm.action === "stand" ? "stood" : "replayed", by.id, reason.slice(0, 1000), issueId);
    await db
      .prepare(
        `INSERT INTO tournament_corrections (tournament_id, match_id, kind, reason, changes, change_phrases, before_state, admin_id, admin_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(tournamentId, issue.fromMatchId, confirm.action, reason.slice(0, 1000), JSON.stringify(changes.map(englishOf)), JSON.stringify(changes), JSON.stringify(reset), by.id, by.name);
    await afterChange(tournamentId, false);
    return { ok: true, value: { detail: (await tournamentDetail(tournamentId, { forStaff: true }))!, ...changesOf(changes) } };
  }).catch((err) => {
    if (err instanceof IssueRefused) return { ok: false as const, error: err.message };
    throw err;
  });
  if (result.ok && confirm.action === "replay") {
    // Everybody in the replays hears when they play.
    const d = result.value.detail;
    for (const m of d.matches.filter((x) => x.status === "scheduled" && x.date !== null && result.value.changes.some((c) => c.startsWith(matchName(d, x))))) {
      for (const entryId of [m.a, m.b]) {
        if (entryId !== null)
          await tellEntry(
            entryId,
            d,
            (tr) => tr("mail.tour.replay.s", { t: d.name }),
            (tr) => tr("mail.tour.replay.b", { match: matchName(d, m), t: d.name, date: m.date!, time: formatMinute(m.minute!, tr.locale), court: m.courtName ?? "" })
          );
      }
    }
  }
  return result;
}

/** Thrown to undo a resolution that cannot be made as asked, with why. */
class IssueRefused extends Error {}

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
  const m = (await db.prepare("SELECT next_match_id, next_slot, loser_next_match_id, loser_next_slot, entry_a, entry_b FROM tournament_matches WHERE id = ?").get(matchId)) as {
    next_match_id: number | null;
    next_slot: "a" | "b" | null;
    loser_next_match_id: number | null;
    loser_next_slot: "a" | "b" | null;
    entry_a: number | null;
    entry_b: number | null;
  };
  await db
    .prepare(
      `UPDATE tournament_matches SET winner = ?, score = ?, status = ?, result_by = NULL, updated_at = datetime('now')${status === "bye" ? ", court_id = NULL, date = NULL, start_min = NULL" : ""} WHERE id = ?`
    )
    .run(winner, score, status, matchId);
  // A result entered settles any report waiting on the match (lib/match-reports.ts).
  await db
    .prepare("UPDATE tournament_reports SET status = 'superseded', answered_at = datetime('now') WHERE match_id = ? AND status IN ('pending', 'disputed')")
    .run(matchId);
  if (m.next_match_id !== null && goesOn)
    await db.prepare(`UPDATE tournament_matches SET entry_${m.next_slot} = ? WHERE id = ?`).run(winner, m.next_match_id);
  // A semi-final's loser goes to the third-place match; a bye sends nobody there.
  if (m.loser_next_match_id !== null && goesOn) {
    const loser = winner === null || status === "bye" ? null : winner === m.entry_a ? m.entry_b : m.entry_a;
    await db.prepare(`UPDATE tournament_matches SET entry_${m.loser_next_slot} = ? WHERE id = ?`).run(loser, m.loser_next_match_id);
  }
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
  if (group.length === 0 || !d.matches.some((m) => m.stage === "knockout") || group.some((m) => m.status === "scheduled")) return null;
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
    // Filled again after a group result was put right or somebody left: who
    // is newly in it, and who is no longer, are told (as a replay's players are).
    const before = new Set(firstRoundMatches.flatMap((m) => [m.a, m.b]).filter((e): e is number => e !== null));
    const after = new Set(pairs.flat().filter((e): e is number => e !== null));
    // Somebody who left knows they did: only those still in are told.
    const stillIn = new Set(detail.entries.filter((e) => !e.out).map((e) => e.id));
    const accounts = (await db.prepare("SELECT id, user_id FROM tournament_entries WHERE tournament_id = ? AND user_id IS NOT NULL").all(tournamentId)) as {
      id: number;
      user_id: number;
    }[];
    const userOf = new Map(accounts.filter((a) => stillIn.has(a.id)).map((a) => [a.id, a.user_id]));
    for (const id of after)
      if (!before.has(id) && userOf.get(id))
        await tellEntry(id, t, (tr) => tr("mail.tour.through.s", { t: t.name }), (tr) => tr("mail.tour.through.b", { t: t.name }));
    for (const id of before)
      if (!after.has(id) && userOf.get(id))
        await tellEntry(id, t, (tr) => tr("mail.tour.notThrough.s", { t: t.name }), (tr) => tr("mail.tour.notThrough.b", { t: t.name }));
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
      .prepare("SELECT id, stage, status, winner, entry_a, entry_b, next_match_id, next_slot, loser_next_match_id, loser_next_slot FROM tournament_matches WHERE tournament_id = ?")
      .all(tournamentId)) as {
      id: number;
      stage: string;
      status: string;
      winner: number | null;
      entry_a: number | null;
      entry_b: number | null;
      next_match_id: number | null;
      next_slot: "a" | "b" | null;
      loser_next_match_id: number | null;
      loser_next_slot: "a" | "b" | null;
    }[];
    const side = (m: (typeof rows)[number], slot: "a" | "b") => {
      const entry = slot === "a" ? m.entry_a : m.entry_b;
      if (entry !== null) return out.has(entry) ? "out" : "in";
      const feeders = rows.filter((f) => f.next_match_id === m.id && f.next_slot === slot);
      if (feeders.length > 0 && feeders.every((f) => f.status === "bye" && f.winner === null)) return "never";
      // The third-place match: a semi-final decided without a loser (a bye) sends nobody.
      const losers = rows.filter((f) => f.loser_next_match_id === m.id && f.loser_next_slot === slot);
      return losers.length > 0 && losers.every((f) => f.status !== "scheduled") ? "never" : "unknown";
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
    .prepare("SELECT COUNT(*)::int AS n FROM tournament_matches WHERE tournament_id = ? AND status = 'scheduled'")
    .get(tournamentId)) as { n: number };
  if (left.n > 0) return;
  // Progression a correction left wrong is resolved first: a tournament never finishes on it.
  if (await db.prepare("SELECT 1 FROM tournament_issues WHERE tournament_id = ? AND status = 'open'").get(tournamentId)) return;
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
  const t = await tournamentById(tournamentId);
  if (t?.competition) return releaseCompetitionTime(t.competition.id);
  // Before the draw nobody knows which time will be needed.
  if (!t || (t.status !== "drawn" && t.status !== "finished")) return 0;
  return releaseHeld(
    { tournamentId },
    "SELECT court_id, date, start_min, end_min FROM blocks WHERE tournament_id = ?",
    `SELECT court_id, date, MIN(start_min) AS first, MAX(start_min + COALESCE(minutes, ?)) AS last_end FROM tournament_matches
      WHERE tournament_id = ? AND status = 'scheduled' AND court_id IS NOT NULL
      GROUP BY court_id, date`,
    [t.matchMinutes, tournamentId],
    tournamentId,
    await tournamentZone(tournamentId)
  );
}

/**
 * A competition's held time no division will use goes back on sale, once
 * every division still running has made its draw (before then nobody knows
 * what will be needed); a competition whose divisions are all called off
 * gives back all of it.
 */
export async function releaseCompetitionTime(competitionId: number): Promise<number> {
  const db = getDb();
  const divisions = (await db.prepare("SELECT id, status FROM tournaments WHERE competition_id = ?").all(competitionId)) as { id: number; status: TournamentStatus }[];
  if (divisions.some((d) => d.status === "open" || d.status === "closed")) return 0;
  const venue = (await db.prepare("SELECT venue_id FROM competitions WHERE id = ?").get(competitionId)) as { venue_id: number } | undefined;
  if (!venue) return 0;
  return releaseHeld(
    { competitionId },
    "SELECT court_id, date, start_min, end_min FROM blocks WHERE competition_id = ?",
    `SELECT m.court_id, m.date, MIN(m.start_min) AS first, MAX(m.start_min + COALESCE(m.minutes, d.match_minutes)) AS last_end
       FROM tournament_matches m JOIN tournaments d ON d.id = m.tournament_id
      WHERE d.competition_id = ? AND d.status <> 'cancelled' AND m.status = 'scheduled' AND m.court_id IS NOT NULL
      GROUP BY m.court_id, m.date`,
    [competitionId],
    competitionId,
    (await venueHours(venue.venue_id)).zone
  );
}

async function releaseHeld(
  owner: { tournamentId: number } | { competitionId: number },
  heldSql: string,
  neededSql: string,
  neededArgs: number[],
  ownerId: number,
  zone: string
): Promise<number> {
  const db = getDb();
  const held = (await db.prepare(heldSql).all(ownerId)) as { court_id: number; date: string; start_min: number; end_min: number }[];
  const needed = new Map(
    ((await db.prepare(neededSql).all(...neededArgs)) as { court_id: number; date: string; first: number; last_end: number }[]).map((r) => [
      `${r.court_id}:${r.date}`,
      { start: r.first, end: r.last_end },
    ])
  );
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
      const minutes =
        "competitionId" in owner
          ? await releaseBlockTime(b.court_id, b.date, piece, undefined, owner.competitionId)
          : await releaseBlockTime(b.court_id, b.date, piece, owner.tournamentId);
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
      .prepare("SELECT id FROM tournament_entries WHERE tournament_id = ? AND status <> 'withdrawn' AND user_id IS NOT NULL")
      .all(tournamentId)) as { id: number }[]
  ).map((r) => r.id);
}

/** An email to an entrant, written in their language (subject and body take the lookup). */
export async function tellEntrant(userId: number, t: Tournament, subject: Written, body: Written): Promise<void> {
  await emailPlayer({ venueId: t.venueId, userId, subject, body, link: `${baseUrl()}/tournaments/${t.id}` });
}

/**
 * An email about one entry, to the account that holds it: one made for
 * somebody the account acts for says whose it is first (*This entry is for
 * Alya.*), as league emails do, so a guardian with several entered knows
 * which. Nothing with no account to tell.
 */
export async function tellEntry(entryId: number, t: Tournament, subject: Written, body: Written): Promise<void> {
  const e = (await getDb()
    .prepare(
      `SELECT e.user_id, e.participant_id, p.display_name FROM tournament_entries e
         LEFT JOIN participants p ON p.id = e.participant_id WHERE e.id = ?`
    )
    .get(entryId)) as { user_id: number | null; participant_id: number | null; display_name: string | null } | undefined;
  if (!e?.user_id) return;
  const forName = e.participant_id !== null ? e.display_name : null;
  await tellEntrant(e.user_id, t, subject, (tr) => sentences(tr, forName && tr("lg5.mail.entryFor", { name: forName }), body(tr)));
}

async function tellFirstMatches(d: TournamentDetail): Promise<void> {
  const db = getDb();
  const names = new Map(d.entries.map((e) => [e.id, e.name]));
  const rows = (await db
    .prepare("SELECT id FROM tournament_entries WHERE tournament_id = ? AND status = 'entered' AND user_id IS NOT NULL")
    .all(d.id)) as { id: number }[];
  for (const r of rows) {
    const heat = d.performance
      ? d.matches.find((m) => m.stage === "heat" && d.performance!.lines[m.id]?.some((l) => l.entryId === r.id))
      : undefined;
    const lane = heat ? d.performance!.lines[heat.id].find((l) => l.entryId === r.id)!.lane : null;
    const first = d.matches.find((m) => m.status === "scheduled" && (m.a === r.id || m.b === r.id));
    const bye = d.matches.some((m) => m.status === "bye" && m.winner === r.id);
    const text: Written = (tr) =>
      heat
        ? tr("mail.tour.draw.heat", { heat: heat.position, t: d.name, lane: lane ?? "", date: heat.date!, time: formatMinute(heat.minute!, tr.locale), court: heat.courtName ?? "" })
        : first
          ? tr("mail.tour.draw.first", {
              t: d.name,
              date: first.date!,
              time: formatMinute(first.minute!, tr.locale),
              court: first.courtName ?? "",
              opponent: names.get(first.a === r.id ? first.b! : first.a!) ?? tr("mail.tour.draw.tbd"),
            })
          : bye
            ? tr("mail.tour.draw.bye", { t: d.name })
            : tr("mail.tour.draw.made", { t: d.name });
    await tellEntry(r.id, d, (tr) => tr("mail.tour.draw.s", { t: d.name }), text);
  }
}
