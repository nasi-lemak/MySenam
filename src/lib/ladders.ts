import { isActivity } from "./activities";
import { getDb, isBusy, withTransaction } from "./db";
import { flipScore, scoreRefusal } from "./brackets";
import { categoryOfWho, declaredGender, entrantCategoryRefusal, entrantParticipantId, entrantUserId, entrantVenueRefusal, selfEntrant, type Entrant } from "./competition-entrants";
import { templateByKey, templateFor } from "./competition-templates";
import { errorText, translator, type ErrorCode } from "./i18n";
import { LEVELS, type Level } from "./games";
import { listRule, OPEN_TO_CUSTOMERS } from "./listing";
import { baseUrl, emailPlayer, sentences, type Written } from "./outbox";
import { ACTS_FOR, participantEvent } from "./participants";
import { venueHours } from "./store";
import { authorisedParticipants, publicName, shortName } from "./public-names";
import { addDays, isValidDateString, todayISO } from "./time";
import { parseRules, readRules, type CompetitionRules } from "./tournament-rules";
import { isPartnerGender, isWho, type Who } from "./who";
import { toWhatsAppNumber } from "./transports";
import type { Refusal, Sport } from "./types";

/**
 * Club ladders (ADR 0033, docs/features/tournaments.md#club-ladders; migration 0272).
 *
 * A ladder is a standing list of players (or pairs) ranked 1 to n, kept by a venue. Players challenge the ones a few
 * places above; the challenged answers, they play it, one reports the score and the other confirms it, and the result
 * moves the ranks by a published rule. Everything that changes a rank is an **event** in an ordered ledger
 * (`ladder_events`), and a season's ranks are the pure replay of that ledger (`replay`, apart from the database,
 * tested on its own): a correction replaces an event in its place and the replay gives the new ranks, so nothing
 * drifts. The stored ranks (`ladder_ranks`) are a cache rewritten whole from the replay after every change, under the
 * ladder's row lock.
 *
 * Results are checked by the same scoring rules as a box league's (`scoreRefusal`); the ratings ledger reads a rated
 * ladder's confirmed results (lib/ratings.ts) and never the other way round.
 */

// ------------------------------------------------------------ the replay (no database)

export type EventKind = "join" | "carry" | "leave" | "result" | "drop" | "freeze" | "thaw" | "move" | "remove";

/** What an event carries beyond who it is about (the JSON in `ladder_events.data`). */
export interface EventData {
  /** result: the challenger won (by play, or because the challenged forfeited). */
  challengerWon?: boolean;
  /** result: decided by a forfeit or a walkover: only the winner counts as having been active. */
  forfeit?: boolean;
  /** drop: how many places. */
  places?: number;
  /** freeze: the last day of the freeze. */
  until?: string;
  /** move, or join by a manager: the rank to put them at. */
  toRank?: number;
  reason?: string;
  by?: string;
}

export interface LadderEvent {
  ord: number;
  kind: EventKind;
  playerId: number;
  otherId: number | null;
  /** The day it counts from. */
  on: string;
  data: EventData;
}

export interface ReplayRow {
  playerId: number;
  rank: number;
  frozenUntil: string | null;
  /** The day their idleness is counted from. */
  activeOn: string;
}

const clampRank = (n: number, size: number) => Math.min(Math.max(1, Math.trunc(n)), size);

/**
 * The ladder as its events leave it, best first. Every event is defined whatever the ranks are (a result whose
 * challenger is already above the challenged moves nobody; an event about somebody not on the ladder does nothing), so a
 * replay after a correction is always defined. The same events in the same order always give the same ladder.
 */
export function replay(events: LadderEvent[]): ReplayRow[] {
  const order: number[] = [];
  const state = new Map<number, { frozenUntil: string | null; activeOn: string }>();
  const insertAt = (id: number, at: number) => order.splice(Math.min(Math.max(at, 0), order.length), 0, id);
  const take = (id: number) => {
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    return i;
  };
  for (const e of [...events].sort((x, y) => x.ord - y.ord)) {
    switch (e.kind) {
      case "join":
      case "carry":
        if (order.includes(e.playerId)) break;
        if (e.data.toRank !== undefined) insertAt(e.playerId, clampRank(e.data.toRank, order.length + 1) - 1);
        else order.push(e.playerId);
        state.set(e.playerId, { frozenUntil: null, activeOn: e.on });
        break;
      case "leave":
      case "remove":
        if (take(e.playerId) >= 0) state.delete(e.playerId);
        break;
      case "result": {
        const challenger = e.playerId;
        const challenged = e.otherId;
        if (challenged === null || !order.includes(challenger) || !order.includes(challenged)) break;
        if (e.data.challengerWon && order.indexOf(challenger) > order.indexOf(challenged)) {
          const at = order.indexOf(challenged);
          take(challenger);
          insertAt(challenger, at);
        }
        const winner = e.data.challengerWon ? challenger : challenged;
        for (const id of [challenger, challenged]) {
          if (e.data.forfeit && id !== winner) continue;
          const s = state.get(id)!;
          state.set(id, { ...s, activeOn: e.on });
        }
        break;
      }
      case "drop": {
        const i = order.indexOf(e.playerId);
        if (i < 0) break;
        take(e.playerId);
        insertAt(e.playerId, Math.min(order.length, i + Math.max(1, e.data.places ?? 1)));
        state.set(e.playerId, { ...state.get(e.playerId)!, activeOn: e.on });
        break;
      }
      case "freeze":
        if (state.has(e.playerId)) state.set(e.playerId, { ...state.get(e.playerId)!, frozenUntil: e.data.until ?? null });
        break;
      case "thaw":
        if (state.has(e.playerId)) state.set(e.playerId, { frozenUntil: null, activeOn: e.on });
        break;
      case "move": {
        if (!order.includes(e.playerId)) break;
        take(e.playerId);
        insertAt(e.playerId, clampRank(e.data.toRank ?? order.length + 1, order.length + 1) - 1);
        break;
      }
    }
  }
  return order.map((playerId, i) => ({ playerId, rank: i + 1, frozenUntil: state.get(playerId)!.frozenUntil, activeOn: state.get(playerId)!.activeOn }));
}

/** Whole days from one ISO date to another (negative if it is before). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface LadderSettings {
  reach: number;
  respondDays: number;
  playDays: number;
  cooldownDays: number;
  inactiveDays: number;
  inactiveDrop: number;
  freezeMaxDays: number;
  declineIs: "free" | "forfeit";
}

export const DEFAULT_SETTINGS: LadderSettings = { reach: 3, respondDays: 3, playDays: 14, cooldownDays: 14, inactiveDays: 30, inactiveDrop: 1, freezeMaxDays: 60, declineIs: "free" };

/** Why one player may not challenge another, or null. The code is the refusal's. */
export type NotAllowed = { code: "LD_SELF" | "LD_NOT_ON" | "LD_FROZEN_ME" | "LD_FROZEN_THEM" | "LD_NOT_ABOVE" | "LD_REACH" | "LD_BUSY_ME" | "LD_BUSY_THEM" | "LD_COOLDOWN"; vars?: Record<string, string | number> };

export function mayChallenge(
  ranks: ReplayRow[],
  settings: Pick<LadderSettings, "reach" | "cooldownDays">,
  me: number,
  them: number,
  context: { today: string; busy: Set<number>; lastTogether: Map<string, string>; names: Map<number, string> }
): NotAllowed | null {
  if (me === them) return { code: "LD_SELF" };
  const mine = ranks.find((r) => r.playerId === me);
  const theirs = ranks.find((r) => r.playerId === them);
  if (!mine || !theirs) return { code: "LD_NOT_ON" };
  const name = context.names.get(them) ?? "";
  if (mine.frozenUntil) return { code: "LD_FROZEN_ME", vars: { date: mine.frozenUntil } };
  if (theirs.frozenUntil) return { code: "LD_FROZEN_THEM", vars: { name, date: theirs.frozenUntil } };
  if (theirs.rank >= mine.rank) return { code: "LD_NOT_ABOVE" };
  if (mine.rank - theirs.rank > settings.reach) return { code: "LD_REACH", vars: { name, n: mine.rank - theirs.rank, k: settings.reach } };
  if (context.busy.has(me)) return { code: "LD_BUSY_ME" };
  if (context.busy.has(them)) return { code: "LD_BUSY_THEM", vars: { name } };
  const last = context.lastTogether.get(pairKey(me, them));
  if (last && settings.cooldownDays > 0) {
    const until = addDays(last, settings.cooldownDays);
    if (context.today < until) return { code: "LD_COOLDOWN", vars: { name, date: last, until } };
  }
  return null;
}

export const pairKey = (x: number, y: number): string => (x < y ? `${x}:${y}` : `${y}:${x}`);

// ------------------------------------------------------------ refusals

export type LadderRefusal = Refusal & { status: number };
export type LadderResult<T> = { ok: true; value: T } | LadderRefusal;

const ENGLISH = translator("en");

/** A refusal with its code (`err.LD_…` in the customer dictionaries, so it reads in the reader's language) and HTTP status. */
export function ladderRefusal(code: ErrorCode, vars: Record<string, string | number> = {}, status = 409): LadderRefusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(Object.keys(vars).length > 0 ? { vars } : {}), status };
}

// ------------------------------------------------------------ the shapes

export type LadderStatus = "open" | "closed";
export type ChallengeStatus = "pending" | "accepted" | "reported" | "disputed" | "confirmed" | "walkover" | "declined" | "cancelled" | "lapsed" | "void";
const OPEN: ChallengeStatus[] = ["pending", "accepted", "reported", "disputed"];
const OPEN_SQL = OPEN.map((s) => `'${s}'`).join(", ");

import { CONFIRM_DAYS } from "./ladders-constants";
export { CONFIRM_DAYS };

export interface Ladder {
  id: number;
  venueId: number;
  venueName: string;
  area: string;
  name: string;
  sport: Sport;
  teamSize: 1 | 2;
  who: Who;
  audience: "adults" | "juniors";
  level: Level | null;
  description: string | null;
  status: LadderStatus;
  rules: CompetitionRules;
  template: string | null;
  rated: boolean;
  settings: LadderSettings;
  /** On the ladder now. */
  players: number;
  season: { id: number; number: number; startedOn: string } | null;
}

export interface LadderRowView {
  playerId: number;
  rank: number;
  /** As shown: the name given, or first name and initial on a junior ladder. */
  name: string;
  frozenUntil: string | null;
  inChallenge: boolean;
  /** Only for staff. */
  userId?: number | null;
  participantId?: number | null;
  atCounter?: { by: string; phone: string | null } | null;
  activeOn?: string;
}

export interface ChallengeView {
  id: number;
  challenger: number;
  challenged: number;
  challengerName: string;
  challengedName: string;
  challengerRank: number;
  challengedRank: number;
  status: ChallengeStatus;
  awaiting: "challenged" | "challenger";
  proposedOn: string | null;
  proposedMin: number | null;
  proposedBy: number | null;
  agreedOn: string | null;
  agreedMin: number | null;
  createdOn: string;
  respondBy: string | null;
  playBy: string | null;
  winner: number | null;
  score: string | null;
  forfeit: boolean;
  reportedBy: number | null;
  /** Goes up whenever the challenge changes: an answer names the one it saw. */
  version: number;
  resolvedOn: string | null;
  /** Only for staff. */
  disputeNote?: string | null;
}

export interface SeasonView {
  id: number;
  number: number;
  startedOn: string;
  endedOn: string | null;
  finalRanks: { rank: number; playerId: number; name: string }[] | null;
}

export interface LadderDetail extends Ladder {
  seasons: SeasonView[];
  viewing: SeasonView | null;
  rows: LadderRowView[];
  challenges: ChallengeView[];
  /** Only for staff: the ledger of the season, newest last. */
  events?: { id: number; ord: number; kind: EventKind; playerId: number; otherId: number | null; on: string; data: EventData; voided: boolean; voidedReason: string | null; replaces: number | null }[];
}

export interface MyPlace {
  playerId: number;
  name: string;
  /** A place held for somebody the account acts for. */
  participantId: number | null;
  rank: number | null;
  frozenUntil: string | null;
  /** Players above, within reach, and why not for those who cannot be challenged now. */
  targets: { playerId: number; name: string; rank: number; not: NotAllowed | null }[];
  /** Open challenges involving the place, with the other side's contact once accepted (adult ladders only). */
  open: (ChallengeView & { contact: { name: string; phone: string; whatsapp: string } | null })[];
  history: ChallengeView[];
}

// ------------------------------------------------------------ reading

const L_SELECT = `
  SELECT l.*, v.name AS venue_name, v.area,
         (SELECT COUNT(*)::int FROM ladder_players p WHERE p.ladder_id = l.id AND p.status = 'active') AS player_count
    FROM ladders l JOIN venues v ON v.id = l.venue_id`;

interface LRow {
  id: number;
  venue_id: number;
  venue_name: string;
  area: string;
  name: string;
  sport: Sport;
  team_size: number;
  who: Who;
  audience: "adults" | "juniors";
  level: Level | null;
  description: string | null;
  status: LadderStatus;
  rules: string | null;
  template: string | null;
  rated: boolean;
  reach: number;
  respond_days: number;
  play_days: number;
  cooldown_days: number;
  inactive_days: number;
  inactive_drop: number;
  freeze_max_days: number;
  decline_is: "free" | "forfeit";
  player_count: number;
}

interface SeasonRow {
  id: number;
  ladder_id: number;
  number: number;
  started_on: string;
  ended_on: string | null;
  final_ranks: string | null;
}

const settingsOf = (r: LRow): LadderSettings => ({
  reach: r.reach,
  respondDays: r.respond_days,
  playDays: r.play_days,
  cooldownDays: r.cooldown_days,
  inactiveDays: r.inactive_days,
  inactiveDrop: r.inactive_drop,
  freezeMaxDays: r.freeze_max_days,
  declineIs: r.decline_is,
});

async function currentSeason(ladderId: number): Promise<SeasonRow | undefined> {
  return (await getDb().prepare("SELECT * FROM ladder_seasons WHERE ladder_id = ? AND ended_on IS NULL ORDER BY number DESC LIMIT 1").get(ladderId)) as SeasonRow | undefined;
}

async function toLadder(r: LRow): Promise<Ladder> {
  const season = await currentSeason(r.id);
  return {
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name,
    area: r.area,
    name: r.name,
    sport: r.sport,
    teamSize: r.team_size === 2 ? 2 : 1,
    who: r.who,
    audience: r.audience,
    level: r.level,
    description: r.description,
    status: r.status,
    rules: readRules(r.rules),
    template: r.template,
    rated: r.rated === true,
    settings: settingsOf(r),
    players: r.player_count,
    season: season ? { id: season.id, number: season.number, startedOn: season.started_on } : null,
  };
}

export async function ladderById(id: number): Promise<Ladder | null> {
  const row = (await getDb().prepare(`${L_SELECT} WHERE l.id = ?`).get(id)) as LRow | undefined;
  return row ? toLadder(row) : null;
}

/** A venue's ladders, for its staff. */
export async function listLadders(venueIds: number[]): Promise<Ladder[]> {
  if (venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(`${L_SELECT} WHERE l.venue_id IN (${venueIds.map(() => "?").join(",")}) ORDER BY l.status, l.id DESC`)
    .all(...venueIds)) as LRow[];
  return Promise.all(rows.map(toLadder));
}

/** Ladders the public can see and join: open, at venues customers can reach. */
export async function publicLadders(filter: { sport?: Sport; venueIds?: number[] } = {}): Promise<Ladder[]> {
  const clauses = [listRule(filter.venueIds), "l.status = 'open'"];
  const params: (string | number)[] = [];
  if (filter.sport) {
    clauses.push("l.sport = ?");
    params.push(filter.sport);
  }
  if (filter.venueIds) {
    if (filter.venueIds.length === 0) return [];
    clauses.push(`l.venue_id IN (${filter.venueIds.map(() => "?").join(",")})`);
    params.push(...filter.venueIds);
  }
  const rows = (await getDb().prepare(`${L_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY l.name, l.id LIMIT 100`).all(...params)) as LRow[];
  return Promise.all(rows.map(toLadder));
}

interface PlayerRow {
  id: number;
  ladder_id: number;
  user_id: number | null;
  name: string;
  participant_id: number | null;
  contact_phone: string | null;
  entered_by_name: string | null;
  status: "active" | "left";
  /** The name as the ladder shows it: short on a junior ladder unless the child's guardian authorised the full name for this season (lib/public-names.ts). */
  shown: string;
}

async function playersOf(ladderId: number): Promise<Map<number, PlayerRow>> {
  const db = getDb();
  const rows = (await db.prepare("SELECT id, ladder_id, user_id, name, participant_id, contact_phone, entered_by_name, status FROM ladder_players WHERE ladder_id = ?").all(ladderId)) as Omit<PlayerRow, "shown">[];
  const ladder = (await db.prepare("SELECT venue_id, audience FROM ladders WHERE id = ?").get(ladderId)) as { venue_id: number; audience: "adults" | "juniors" } | undefined;
  const juniors = ladder?.audience === "juniors";
  const authorised = juniors && ladder ? await authorisedParticipants({ kind: "ladder", id: ladderId, venueId: ladder.venue_id }, rows.map((r) => r.participant_id)) : new Set<number>();
  const on = todayISO();
  // Every player on a junior ladder is a declared minor; an adult ladder's are shown as given (the one rule, lib/public-names.ts).
  return new Map(rows.map((r) => [r.id, { ...r, shown: publicName({ name: r.name, guardian: juniors, participantId: r.participant_id }, { on, authorised }) }]));
}

/** A name as the ladder shows it: as given on an adult ladder, first name and the initial of the next on a junior one. */
const shown = (l: Pick<Ladder, "audience">, name: string): string => (l.audience === "juniors" ? shortName(name) : name);

interface EventRow {
  id: number;
  ord: number;
  kind: EventKind;
  player_id: number;
  other_id: number | null;
  challenge_id: number | null;
  on_date: string;
  data: string;
  replaces: number | null;
  voided_at: string | null;
  voided_reason: string | null;
}

const parseData = (raw: string): EventData => {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as EventData) : {};
  } catch {
    return {};
  }
};

async function liveEvents(seasonId: number): Promise<LadderEvent[]> {
  const rows = (await getDb()
    .prepare("SELECT id, ord, kind, player_id, other_id, on_date, data FROM ladder_events WHERE season_id = ? AND voided_at IS NULL ORDER BY ord")
    .all(seasonId)) as EventRow[];
  return rows.map((r) => ({ ord: r.ord, kind: r.kind, playerId: r.player_id, otherId: r.other_id, on: r.on_date, data: parseData(r.data) }));
}

/** The season's ranks as the ledger leaves them now. */
export async function ranksOf(seasonId: number): Promise<ReplayRow[]> {
  return replay(await liveEvents(seasonId));
}

const toChallenge = (c: ChallengeRow, names: Map<number, string>, forStaff: boolean): ChallengeView => ({
  id: c.id,
  challenger: c.challenger,
  challenged: c.challenged,
  challengerName: names.get(c.challenger) ?? "",
  challengedName: names.get(c.challenged) ?? "",
  challengerRank: c.challenger_rank,
  challengedRank: c.challenged_rank,
  status: c.status,
  awaiting: c.awaiting,
  proposedOn: c.proposed_on,
  proposedMin: c.proposed_min,
  proposedBy: c.proposed_by,
  agreedOn: c.agreed_on,
  agreedMin: c.agreed_min,
  createdOn: c.created_on,
  respondBy: c.respond_by,
  playBy: c.play_by,
  winner: c.winner,
  score: c.score,
  forfeit: c.forfeit === true,
  reportedBy: c.reported_by,
  version: Number(c.version),
  resolvedOn: c.resolved_on,
  ...(forStaff ? { disputeNote: c.dispute_note } : {}),
});

interface ChallengeRow {
  id: number;
  ladder_id: number;
  season_id: number;
  challenger: number;
  challenged: number;
  challenger_rank: number;
  challenged_rank: number;
  status: ChallengeStatus;
  awaiting: "challenged" | "challenger";
  proposed_on: string | null;
  proposed_min: number | null;
  proposed_by: number | null;
  agreed_on: string | null;
  agreed_min: number | null;
  created_on: string;
  respond_by: string | null;
  play_by: string | null;
  winner: number | null;
  score: string | null;
  forfeit: boolean;
  reported_by: number | null;
  reported_at: string | null;
  dispute_note: string | null;
  decided_by: number | null;
  resolved_on: string | null;
  version: number | string;
}

export async function ladderDetail(id: number, opts: { season?: number; forStaff?: boolean } = {}): Promise<LadderDetail | null> {
  const ladder = await ladderById(id);
  if (!ladder) return null;
  const db = getDb();
  const seasonRows = (await db.prepare("SELECT * FROM ladder_seasons WHERE ladder_id = ? ORDER BY number DESC").all(id)) as SeasonRow[];
  const people = await playersOf(id);
  const names = new Map([...people].map(([pid, p]) => [pid, p.shown]));
  const seasons: SeasonView[] = seasonRows.map((s) => ({
    id: s.id,
    number: s.number,
    startedOn: s.started_on,
    endedOn: s.ended_on,
    finalRanks: s.final_ranks ? (JSON.parse(s.final_ranks) as SeasonView["finalRanks"]) : null,
  }));
  const viewing = (opts.season !== undefined ? seasons.find((s) => s.number === opts.season) : undefined) ?? seasons.find((s) => s.endedOn === null) ?? seasons[0] ?? null;
  let rows: LadderRowView[] = [];
  let challenges: ChallengeView[] = [];
  let events: LadderDetail["events"];
  if (viewing && viewing.endedOn === null) {
    const ranks = await ranksOf(viewing.id);
    const open = new Set(
      ((await db.prepare(`SELECT challenger, challenged FROM ladder_challenges WHERE season_id = ? AND status IN (${OPEN_SQL})`).all(viewing.id)) as { challenger: number; challenged: number }[]).flatMap((c) => [c.challenger, c.challenged])
    );
    rows = ranks.map((r) => {
      const p = people.get(r.playerId)!;
      return {
        playerId: r.playerId,
        rank: r.rank,
        name: names.get(r.playerId) ?? "",
        frozenUntil: r.frozenUntil,
        inChallenge: open.has(r.playerId),
        ...(opts.forStaff
          ? { userId: p.user_id, participantId: p.participant_id, atCounter: p.entered_by_name ? { by: p.entered_by_name, phone: p.contact_phone } : null, activeOn: r.activeOn }
          : {}),
      };
    });
  } else if (viewing?.finalRanks) rows = viewing.finalRanks.map((f) => ({ playerId: f.playerId, rank: f.rank, name: f.name, frozenUntil: null, inChallenge: false }));
  if (viewing) {
    const cs = (await db.prepare("SELECT * FROM ladder_challenges WHERE season_id = ? ORDER BY id DESC LIMIT 200").all(viewing.id)) as ChallengeRow[];
    challenges = cs.map((c) => toChallenge(c, names, opts.forStaff === true));
    if (opts.forStaff)
      events = ((await db.prepare("SELECT * FROM ladder_events WHERE season_id = ? ORDER BY ord, id").all(viewing.id)) as EventRow[]).map((e) => ({
        id: e.id,
        ord: e.ord,
        kind: e.kind,
        playerId: e.player_id,
        otherId: e.other_id,
        on: e.on_date,
        data: parseData(e.data),
        voided: e.voided_at !== null,
        voidedReason: e.voided_reason,
        replaces: e.replaces,
      }));
  }
  return { ...ladder, seasons, viewing, rows, challenges, ...(events ? { events } : {}) };
}

// ------------------------------------------------------------ setting one up

export interface LadderInput {
  venueId: number;
  name: string;
  sport: Sport;
  teamSize: 1 | 2;
  who?: Who;
  audience?: "adults" | "juniors";
  level: Level | null;
  description?: string;
  template?: string | null;
  rules?: unknown;
  settings?: Partial<LadderSettings>;
}

const intIn = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** The settings given, laid over the defaults, or why they cannot be. */
export function readSettings(input: Partial<LadderSettings> | undefined, base: LadderSettings = DEFAULT_SETTINGS): { ok: true; settings: LadderSettings } | { ok: false; error: string } {
  const s = input ?? {};
  const pick = (key: keyof LadderSettings, lo: number, hi: number, what: string) => {
    if (s[key] === undefined) return { value: base[key] as number };
    const v = intIn(s[key], lo, hi);
    return v === null ? { error: `${what}: ${lo} to ${hi}.` } : { value: v };
  };
  const reach = pick("reach", 1, 10, "Challenge up to this many places above");
  const respond = pick("respondDays", 1, 14, "Days to answer a challenge");
  const play = pick("playDays", 3, 60, "Days to play an accepted challenge");
  const cooldown = pick("cooldownDays", 0, 90, "Days before the same two play again");
  const inactive = pick("inactiveDays", 0, 365, "Days idle before dropping (0: never)");
  const drop = pick("inactiveDrop", 1, 10, "Places dropped");
  const freeze = pick("freezeMaxDays", 1, 180, "The longest freeze in days");
  for (const x of [reach, respond, play, cooldown, inactive, drop, freeze]) if ("error" in x && x.error) return { ok: false, error: x.error };
  if (s.declineIs !== undefined && s.declineIs !== "free" && s.declineIs !== "forfeit") return { ok: false, error: 'Declining is "free" or counts as a "forfeit".' };
  return {
    ok: true,
    settings: {
      reach: reach.value!,
      respondDays: respond.value!,
      playDays: play.value!,
      cooldownDays: cooldown.value!,
      inactiveDays: inactive.value!,
      inactiveDrop: drop.value!,
      freezeMaxDays: freeze.value!,
      declineIs: s.declineIs ?? base.declineIs,
    },
  };
}

/** The day it is at a venue. */
async function venueToday(venueId: number): Promise<string> {
  return todayISO((await venueHours(venueId)).zone);
}

export async function createLadder(input: LadderInput, adminId: number): Promise<LadderResult<Ladder>> {
  const db = getDb();
  const name = input.name.trim();
  if (name.length < 3 || name.length > 100) return { ...ladderRefusal("LD_NAME", {}, 400) };
  if (!(await isActivity(input.sport))) return { ...ladderRefusal("LD_SPORT", {}, 400) };
  if (input.level !== null && !LEVELS.includes(input.level)) return { ...ladderRefusal("LD_LEVEL", {}, 400) };
  const who = input.who ?? "anyone";
  if (!isWho(who)) return { ...ladderRefusal("LD_WHO", {}, 400) };
  const audience = input.audience ?? "adults";
  if (audience !== "adults" && audience !== "juniors") return { ...ladderRefusal("LD_AUDIENCE", {}, 400) };
  const parsedSettings = readSettings(input.settings);
  if (!parsedSettings.ok) return { ok: false, error: parsedSettings.error, status: 400 };
  if (!(await db.prepare("SELECT 1 FROM court_activities ca JOIN courts c ON c.id = ca.court_id WHERE c.venue_id = ? AND ca.sport = ?").get(input.venueId, input.sport)))
    return ladderRefusal("LD_NO_COURTS", {}, 400);
  // Scored as a head-to-head competition: the sport's template unless another is chosen.
  const own = templateFor(input.sport);
  const template = input.template ? templateByKey(input.template) : own.rules.performance ? templateByKey("custom") : own;
  if (!template || template.rules.performance) return ladderRefusal("LD_TEMPLATE", {}, 400);
  const parsed = parseRules(input.rules ?? null, template.rules);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
  if (parsed.rules.performance) return ladderRefusal("LD_TEMPLATE", {}, 400);
  const today = await venueToday(input.venueId);
  const s = parsedSettings.settings;
  let id = 0;
  await db.transaction(async () => {
    const info = await db
      .prepare(
        `INSERT INTO ladders (venue_id, name, sport, team_size, who, audience, level, description, rules, template, reach, respond_days, play_days, cooldown_days,
                              inactive_days, inactive_drop, freeze_max_days, decline_is, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.venueId,
        name,
        input.sport,
        input.teamSize === 2 ? 2 : 1,
        who,
        audience,
        input.level,
        input.description?.trim().slice(0, 2000) || null,
        JSON.stringify(parsed.rules),
        template.key,
        s.reach,
        s.respondDays,
        s.playDays,
        s.cooldownDays,
        s.inactiveDays,
        s.inactiveDrop,
        s.freezeMaxDays,
        s.declineIs,
        adminId
      );
    id = info.lastInsertRowid as number;
    await db.prepare("INSERT INTO ladder_seasons (ladder_id, number, started_on) VALUES (?, 1, ?)").run(id, today);
  })();
  return { ok: true, value: (await ladderById(id))! };
}

/** The ladder's settings changed by a manager, with a reason: they apply from now and never rewrite what happened. */
export async function changeSettings(ladderId: number, change: Partial<LadderSettings>): Promise<LadderResult<Ladder>> {
  return withLadder(ladderId, async (ladder) => {
    const parsed = readSettings(change, ladder.settings);
    if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
    const s = parsed.settings;
    await getDb()
      .prepare(
        `UPDATE ladders SET reach = ?, respond_days = ?, play_days = ?, cooldown_days = ?, inactive_days = ?, inactive_drop = ?, freeze_max_days = ?, decline_is = ? WHERE id = ?`
      )
      .run(s.reach, s.respondDays, s.playDays, s.cooldownDays, s.inactiveDays, s.inactiveDrop, s.freezeMaxDays, s.declineIs, ladderId);
    return { ok: true, value: (await ladderById(ladderId))! };
  });
}

/** Run `fn` in a transaction under the ladder's row lock: nothing else changes the ladder meanwhile. */
async function withLadder<T>(ladderId: number, fn: (ladder: Ladder, season: SeasonRow) => Promise<LadderResult<T>>): Promise<LadderResult<T>> {
  try {
    return await withTransaction(async () => {
      await getDb().prepare("SELECT id FROM ladders WHERE id = ? FOR UPDATE").get(ladderId);
      const ladder = await ladderById(ladderId);
      if (!ladder) return ladderRefusal("LD_NOT_FOUND", {}, 404);
      const season = await currentSeason(ladderId);
      if (!season) return ladderRefusal("LD_CLOSED");
      return fn(ladder, season);
    });
  } catch (err) {
    if (isBusy(err)) return ladderRefusal("LD_BUSY", {}, 503);
    throw err;
  }
}

// ------------------------------------------------------------ writing the ledger

/** Rewrite the cached ranks of a season from the replay of its ledger. */
async function settle(seasonId: number): Promise<ReplayRow[]> {
  const db = getDb();
  const ranks = await ranksOf(seasonId);
  await db.prepare("DELETE FROM ladder_ranks WHERE season_id = ?").run(seasonId);
  for (const r of ranks) await db.prepare("INSERT INTO ladder_ranks (season_id, player_id, rank, frozen_until, active_on) VALUES (?, ?, ?, ?, ?)").run(seasonId, r.playerId, r.rank, r.frozenUntil, r.activeOn);
  return ranks;
}

async function addEvent(
  ladderId: number,
  seasonId: number,
  kind: EventKind,
  playerId: number,
  otherId: number | null,
  on: string,
  data: EventData,
  challengeId: number | null = null
): Promise<number> {
  const db = getDb();
  const next = (await db.prepare("SELECT COALESCE(MAX(ord), 0)::int + 1 AS n FROM ladder_events WHERE season_id = ?").get(seasonId)) as { n: number };
  const made = (await db
    .prepare("INSERT INTO ladder_events (ladder_id, season_id, ord, kind, player_id, other_id, challenge_id, on_date, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .get(ladderId, seasonId, next.n, kind, playerId, otherId, challengeId, on, JSON.stringify(data))) as { id: number };
  return made.id;
}

/**
 * A result for a challenge: written at the end of the ledger the first time; a correction (the challenge already has one)
 * voids it with why and writes its replacement in the same place in the order, so every event after it is replayed on top
 * of the corrected one. `challengerWon: null` voids it and writes nothing.
 */
async function writeResult(
  ladderId: number,
  seasonId: number,
  ch: Pick<ChallengeRow, "id" | "challenger" | "challenged">,
  outcome: { challengerWon: boolean; forfeit: boolean } | null,
  on: string,
  why: { reason: string; by: string } | null
): Promise<void> {
  const db = getDb();
  const live = (await db.prepare("SELECT id, ord, on_date FROM ladder_events WHERE challenge_id = ? AND kind = 'result' AND voided_at IS NULL").get(ch.id)) as { id: number; ord: number; on_date: string } | undefined;
  if (live) await db.prepare("UPDATE ladder_events SET voided_at = datetime('now'), voided_reason = ?, voided_by = ? WHERE id = ?").run(why?.reason ?? "corrected", why?.by ?? null, live.id);
  if (!outcome) return;
  const data: EventData = { challengerWon: outcome.challengerWon, forfeit: outcome.forfeit, ...(why ? { reason: why.reason, by: why.by } : {}) };
  if (!live) {
    await addEvent(ladderId, seasonId, "result", ch.challenger, ch.challenged, on, data, ch.id);
    return;
  }
  // In the same place in the order, counted from the day it first counted.
  await db
    .prepare("INSERT INTO ladder_events (ladder_id, season_id, ord, kind, player_id, other_id, challenge_id, on_date, data, replaces) VALUES (?, ?, ?, 'result', ?, ?, ?, ?, ?, ?)")
    .run(ladderId, seasonId, live.ord, ch.challenger, ch.challenged, ch.id, live.on_date, JSON.stringify(data), live.id);
}

// ------------------------------------------------------------ joining and leaving

export interface JoinInput {
  partnerName?: string;
  partnerGender?: string;
  /** An entrant with no account of their own: their gender as declared, in a women's or men's ladder. */
  gender?: string;
  /** On an adult ladder: the player says they are 18 or over (declared, never verified). */
  adult?: boolean;
  /** A manager adds somebody at a rank. */
  atRank?: number;
}

export async function join(user: { id: number; name: string }, ladderId: number, input: JoinInput = {}): Promise<LadderResult<{ playerId: number }>> {
  return joinAs(selfEntrant(user), ladderId, input);
}

/**
 * Join a ladder, at the bottom: the account holder for themself, a guardian for a participant (junior ladders only), or
 * staff at the counter, through the same checks as a league's (the venue's rule on who it is for; in a women's or men's
 * ladder the player, and a pair's partner, as declared).
 */
export async function joinAs(entrant: Entrant, ladderId: number, input: JoinInput = {}, by: { name: string } | null = null): Promise<LadderResult<{ playerId: number }>> {
  return withLadder(ladderId, async (ladder, season) => {
    const db = getDb();
    if (ladder.status !== "open") return ladderRefusal("LD_CLOSED");
    const open = (await db.prepare(`SELECT (${OPEN_TO_CUSTOMERS}) AS open FROM venues v WHERE v.id = ?`).get(ladder.venueId)) as { open: boolean };
    if (!open.open) return ladderRefusal("LD_VENUE_CLOSED");
    const today = await venueToday(ladder.venueId);
    const notHere = await entrantVenueRefusal(ladder.venueId, entrant, today);
    if (notHere) return { ...notHere, ok: false, status: notHere.status ?? 403 } as LadderRefusal;
    // Who it is for: adults, who say so; or juniors, entered by the guardian who acts for them.
    const participantId = entrantParticipantId(entrant);
    if (ladder.audience === "adults") {
      if (participantId !== null) return ladderRefusal("LD_ADULTS_ONLY", { name: entrant.name }, 403);
      if (input.adult !== true) return ladderRefusal("LD_ADULT_DECLARE", {}, 400);
    } else if (participantId === null) return ladderRefusal("LD_JUNIORS_ONLY", {}, 403);
    const category = categoryOfWho(ladder.who);
    const partnerGender = ladder.teamSize === 2 && isPartnerGender(input.partnerGender) ? input.partnerGender : null;
    const notFor = await entrantCategoryRefusal(entrant, category, ladder.teamSize === 2 ? { partnerGender } : null, input.gender);
    if (notFor) return { ...notFor, ok: false, status: notFor.status ?? 403 } as LadderRefusal;
    const partner = input.partnerName?.trim() ?? "";
    if (ladder.teamSize === 2 && (partner.length < 2 || partner.length > 60)) return ladderRefusal("LD_PARTNER", {}, 400);
    const name = (ladder.teamSize === 2 ? `${entrant.name} / ${partner}` : entrant.name).slice(0, 130);
    const userId = entrantUserId(entrant);
    const before =
      participantId !== null
        ? await db.prepare("SELECT id FROM ladder_players WHERE ladder_id = ? AND participant_id = ? AND status = 'active'").get(ladderId, participantId)
        : userId !== null
          ? await db.prepare("SELECT id FROM ladder_players WHERE ladder_id = ? AND user_id = ? AND participant_id IS NULL AND status = 'active'").get(ladderId, userId)
          : undefined;
    if (before) return ladderRefusal("LD_ALREADY_IN", { name: entrant.name });
    const counter = entrant.kind === "counter" ? entrant : null;
    const made = (await db
      .prepare(
        `INSERT INTO ladder_players (ladder_id, user_id, name, partner_name, partner_gender, participant_id, entrant_gender, contact_phone, entered_by_admin_id, entered_by_name, declared_adult_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        ladderId,
        userId,
        name,
        partner || null,
        partnerGender,
        participantId,
        declaredGender(entrant, category, input.gender),
        counter?.phone ?? null,
        counter?.adminId ?? null,
        counter?.adminName ?? null,
        ladder.audience === "adults" ? new Date().toISOString() : null
      )) as { id: number };
    const atRank = input.atRank !== undefined && by ? Math.max(1, Math.trunc(input.atRank)) : undefined;
    await addEvent(ladderId, season.id, "join", made.id, null, today, atRank !== undefined ? { toRank: atRank, by: by?.name } : {});
    const ranks = await settle(season.id);
    if (participantId !== null)
      await participantEvent(
        participantId,
        "ladder.joined",
        entrant.kind === "participant" ? { userId: entrant.userId, name: entrant.guardianName } : { adminId: entrant.kind === "counter" ? entrant.adminId : null, name: entrant.kind === "counter" ? entrant.adminName : "" },
        { venueId: ladder.venueId, detail: ladder.name }
      );
    await tellPlayer(
      made.id,
      ladder,
      (tr) => tr("ld.mail.joined.s", { l: ladder.name }),
      (tr) => tr("ld.mail.joined.b", { l: ladder.name, venue: ladder.venueName, rank: ranks.find((r) => r.playerId === made.id)!.rank })
    );
    return { ok: true, value: { playerId: made.id } };
  });
}

/** The row of a place this account holds and acts for now, or null: its own, or one it entered for somebody it still acts for. */
async function myPlayer(userId: number, playerId: number): Promise<PlayerRow | null> {
  const row = (await getDb()
    .prepare(
      `SELECT lp.id, lp.ladder_id, lp.user_id, lp.name, lp.participant_id, lp.contact_phone, lp.entered_by_name, lp.status
         FROM ladder_players lp LEFT JOIN participants p ON p.id = lp.participant_id
        WHERE lp.id = ? AND lp.user_id = ? AND lp.status = 'active' AND (lp.participant_id IS NULL OR ${ACTS_FOR("p")})`
    )
    .get(playerId, userId, userId, userId)) as PlayerRow | undefined;
  return row ?? null;
}

/** The places this account holds on a ladder (its own and those it holds for people it acts for). */
export async function myPlaces(userId: number, ladderId: number): Promise<MyPlace[]> {
  const ladder = await ladderById(ladderId);
  if (!ladder?.season) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT lp.id FROM ladder_players lp LEFT JOIN participants p ON p.id = lp.participant_id
        WHERE lp.ladder_id = ? AND lp.user_id = ? AND lp.status = 'active' AND (lp.participant_id IS NULL OR ${ACTS_FOR("p")}) ORDER BY lp.id`
    )
    .all(ladderId, userId, userId, userId)) as { id: number }[];
  const out: MyPlace[] = [];
  for (const r of rows) out.push(await placeOf(ladder, r.id));
  return out;
}

async function placeOf(ladder: Ladder, playerId: number): Promise<MyPlace> {
  const db = getDb();
  const season = ladder.season!;
  const people = await playersOf(ladder.id);
  const names = new Map([...people].map(([id, p]) => [id, p.shown]));
  const ranks = await ranksOf(season.id);
  const me = ranks.find((r) => r.playerId === playerId) ?? null;
  const challenges = (await db.prepare("SELECT * FROM ladder_challenges WHERE season_id = ? AND (challenger = ? OR challenged = ?) ORDER BY id DESC LIMIT 50").all(season.id, playerId, playerId)) as ChallengeRow[];
  const busy = await busyPlayers(season.id);
  const today = await venueToday(ladder.venueId);
  const together = await lastTogether(season.id);
  const targets = me
    ? ranks
        .filter((r) => r.rank < me.rank && me.rank - r.rank <= ladder.settings.reach)
        .map((r) => ({ playerId: r.playerId, name: names.get(r.playerId) ?? "", rank: r.rank, not: mayChallenge(ranks, ladder.settings, playerId, r.playerId, { today, busy, lastTogether: together, names }) }))
    : [];
  const open = [];
  for (const c of challenges.filter((x) => OPEN.includes(x.status))) {
    const otherId = c.challenger === playerId ? c.challenged : c.challenger;
    const other = people.get(otherId);
    // An adult ladder's accepted challenge shows the other side's number, for arranging it, to them alone; a junior ladder's never.
    let contact: { name: string; phone: string; whatsapp: string } | null = null;
    if (ladder.audience === "adults" && other && c.status !== "pending") {
      const phone = ((await db.prepare("SELECT COALESCE(u.phone, ?) AS phone FROM (SELECT 1) x LEFT JOIN users u ON u.id = ?").get(other.contact_phone, other.user_id)) as { phone: string | null }).phone;
      if (phone) contact = { name: names.get(otherId) ?? "", phone, whatsapp: toWhatsAppNumber(phone) };
    }
    open.push({ ...toChallenge(c, names, false), contact });
  }
  return {
    playerId,
    name: names.get(playerId) ?? "",
    participantId: people.get(playerId)?.participant_id ?? null,
    rank: me?.rank ?? null,
    frozenUntil: me?.frozenUntil ?? null,
    targets,
    open,
    history: challenges.filter((x) => !OPEN.includes(x.status)).slice(0, 20).map((c) => toChallenge(c, names, false)),
  };
}

async function busyPlayers(seasonId: number): Promise<Set<number>> {
  const rows = (await getDb().prepare(`SELECT challenger, challenged FROM ladder_challenges WHERE season_id = ? AND status IN (${OPEN_SQL})`).all(seasonId)) as { challenger: number; challenged: number }[];
  return new Set(rows.flatMap((r) => [r.challenger, r.challenged]));
}

/** The last day two players' challenge was played or forfeited, for the cooldown. */
async function lastTogether(seasonId: number): Promise<Map<string, string>> {
  const rows = (await getDb()
    .prepare("SELECT challenger, challenged, resolved_on FROM ladder_challenges WHERE season_id = ? AND status IN ('confirmed', 'walkover') AND resolved_on IS NOT NULL ORDER BY id")
    .all(seasonId)) as { challenger: number; challenged: number; resolved_on: string }[];
  const out = new Map<string, string>();
  for (const r of rows) out.set(pairKey(r.challenger, r.challenged), r.resolved_on);
  return out;
}

/**
 * Out of the ladder (the player's own, or a manager's with a reason): open challenges are cancelled with no effect and
 * the other side is told; those below move up.
 */
export async function leave(playerId: number, by: { name: string; reason?: string } | null = null): Promise<LadderResult<{ playerId: number }>> {
  const p = (await getDb().prepare("SELECT ladder_id, status FROM ladder_players WHERE id = ?").get(playerId)) as { ladder_id: number; status: string } | undefined;
  if (!p || p.status !== "active") return ladderRefusal("LD_NOT_ON", {}, 404);
  if (by && (by.reason?.trim().length ?? 0) < 3) return ladderRefusal("LD_REASON", {}, 400);
  return withLadder(p.ladder_id, async (ladder, season) => {
    const db = getDb();
    const now = (await db.prepare("SELECT status FROM ladder_players WHERE id = ?").get(playerId)) as { status: string };
    if (now.status !== "active") return ladderRefusal("LD_NOT_ON", {}, 404);
    const today = await venueToday(ladder.venueId);
    await cancelOpenFor(ladder, season, playerId, "left");
    await db.prepare("UPDATE ladder_players SET status = 'left', left_at = datetime('now') WHERE id = ?").run(playerId);
    await addEvent(ladder.id, season.id, by ? "remove" : "leave", playerId, null, today, by ? { reason: by.reason?.trim(), by: by.name } : {});
    await settle(season.id);
    await ratingsAfter(ladder.id);
    if (by)
      await tellPlayer(playerId, ladder, (tr) => tr("ld.mail.removed.s", { l: ladder.name }), (tr) => tr("ld.mail.removed.b", { l: ladder.name, reason: by.reason?.trim() ?? "" }));
    return { ok: true, value: { playerId } };
  });
}

/** Cancel every open challenge a player is in, with no effect on the ranks, telling the other side. */
async function cancelOpenFor(ladder: Ladder, season: SeasonRow, playerId: number, why: "left" | "frozen" | "season"): Promise<void> {
  const db = getDb();
  const today = await venueToday(ladder.venueId);
  const open = (await db.prepare(`SELECT * FROM ladder_challenges WHERE season_id = ? AND (challenger = ? OR challenged = ?) AND status IN (${OPEN_SQL})`).all(season.id, playerId, playerId)) as ChallengeRow[];
  for (const c of open) {
    await db.prepare("UPDATE ladder_challenges SET status = 'cancelled', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, c.id);
    const other = c.challenger === playerId ? c.challenged : c.challenger;
    const people = await playersOf(ladder.id);
    const me = (people.get(playerId)?.shown ?? "");
    await tellPlayer(
      other,
      ladder,
      (tr) => tr("ld.mail.ended.s", { l: ladder.name }),
      (tr) => tr("ld.mail.ended.b", { l: ladder.name, a: me, what: tr(`ld.end.${why}`) })
    );
  }
}

// ------------------------------------------------------------ challenging

export interface ChallengeInput {
  /** A day and time proposed for the match, optional. */
  onDate?: string;
  minute?: number;
}

function proposal(input: { onDate?: unknown; minute?: unknown }, today: string): { ok: true; on: string | null; min: number | null } | { ok: false; refusal: LadderRefusal } {
  if (input.onDate === undefined || input.onDate === null || input.onDate === "") return { ok: true, on: null, min: null };
  if (typeof input.onDate !== "string" || !isValidDateString(input.onDate) || input.onDate < today) return { ok: false, refusal: ladderRefusal("LD_TIME", {}, 400) };
  const min = input.minute === undefined || input.minute === null ? null : Number(input.minute);
  if (min !== null && (!Number.isInteger(min) || min < 0 || min > 1439)) return { ok: false, refusal: ladderRefusal("LD_TIME", {}, 400) };
  return { ok: true, on: input.onDate, min };
}

/** A player (their account acts for the place) challenges one of the players within reach above them. */
export async function challenge(userId: number, ladderId: number, mine: number, target: number, input: ChallengeInput = {}): Promise<LadderResult<ChallengeView>> {
  const me = await myPlayer(userId, mine);
  if (!me || me.ladder_id !== ladderId) return ladderRefusal("LD_NOT_YOURS", {}, 403);
  return withLadder(ladderId, async (ladder, season) => {
    const db = getDb();
    const today = await venueToday(ladder.venueId);
    const people = await playersOf(ladderId);
    const them = people.get(target);
    if (!them || them.status !== "active") return ladderRefusal("LD_NOT_ON", {}, 404);
    const mineNow = people.get(mine);
    if (!mineNow || mineNow.status !== "active") return ladderRefusal("LD_NOT_ON", {}, 404);
    const ranks = await ranksOf(season.id);
    const names = new Map([...people].map(([id, p]) => [id, p.shown]));
    const not = mayChallenge(ranks, ladder.settings, mine, target, { today, busy: await busyPlayers(season.id), lastTogether: await lastTogether(season.id), names });
    if (not) return ladderRefusal(not.code, not.vars ?? {});
    const when = proposal(input, today);
    if (!when.ok) return when.refusal;
    const made = (await db
      .prepare(
        `INSERT INTO ladder_challenges (ladder_id, season_id, challenger, challenged, challenger_rank, challenged_rank, proposed_on, proposed_min, proposed_by, created_on, respond_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(
        ladderId,
        season.id,
        mine,
        target,
        ranks.find((r) => r.playerId === mine)!.rank,
        ranks.find((r) => r.playerId === target)!.rank,
        when.on,
        when.min,
        when.on ? mine : null,
        today,
        addDays(today, ladder.settings.respondDays)
      )) as ChallengeRow;
    const a = names.get(mine) ?? "";
    await tellPlayer(
      target,
      ladder,
      (tr) => tr("ld.mail.challenged.s", { l: ladder.name, a }),
      (tr) =>
        sentences(
          tr,
          tr("ld.mail.challenged.b", { l: ladder.name, a, days: ladder.settings.respondDays, date: made.respond_by ?? "" }),
          when.on && tr("ld.mail.proposed", { date: when.on, time: when.min === null ? "" : fmtMin(when.min) })
        )
    );
    return { ok: true, value: toChallenge(made, names, false) };
  });
}

const fmtMin = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The challenge, its ladder and the season it was in, with the places the account holds in it. */
async function challengeFor(userId: number, challengeId: number): Promise<{ ch: ChallengeRow; myId: number } | null> {
  const ch = (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(challengeId)) as ChallengeRow | undefined;
  if (!ch) return null;
  const mine = (await myPlayer(userId, ch.challenger)) ? ch.challenger : (await myPlayer(userId, ch.challenged)) ? ch.challenged : null;
  // An account on both sides (a guardian whose two children play each other) answers for neither: staff decide that one.
  if (mine === null || ((await myPlayer(userId, ch.challenger)) && (await myPlayer(userId, ch.challenged)))) return null;
  return { ch, myId: mine };
}

const stale = (c: ChallengeRow, expected: { version?: number }) => expected.version !== undefined && expected.version !== Number(c.version);
const changedRefusal = () => ladderRefusal("LD_CHANGED");

async function lockedChallenge(challengeId: number): Promise<ChallengeRow | undefined> {
  return (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ? FOR UPDATE").get(challengeId)) as ChallengeRow | undefined;
}

async function viewOf(ladder: Ladder, challengeId: number): Promise<ChallengeView> {
  const people = await playersOf(ladder.id);
  const row = (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(challengeId)) as ChallengeRow;
  return toChallenge(row, new Map([...people].map(([id, p]) => [id, p.shown])), false);
}

export type Answer =
  | { accept: true; onDate?: string; minute?: number }
  | { decline: true }
  | { propose: true; onDate: string; minute?: number };

/**
 * The player whose answer a challenge waits for accepts (optionally agreeing a day), declines, or proposes a time, which
 * hands the answer to the other side. Accepting starts the time to play it. A decline is free, or a forfeit, as the
 * ladder's setting says.
 */
export async function answer(userId: number, challengeId: number, input: Answer, expected: { version?: number } = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (stale(ch, expected)) return changedRefusal();
    const mineId = found.myId;
    const waitingFor = ch.awaiting === "challenged" ? ch.challenged : ch.challenger;
    if (ch.status !== "pending" || waitingFor !== mineId) return ladderRefusal("LD_NOT_AWAITING");
    const today = await venueToday(ladder.venueId);
    const people = await playersOf(ladder.id);
    const other = mineId === ch.challenger ? ch.challenged : ch.challenger;
    const me = (people.get(mineId)?.shown ?? "");
    if ("decline" in input) {
      // The challenger cannot decline their own challenge: they withdraw it (`withdraw`).
      if (mineId === ch.challenger) return ladderRefusal("LD_NOT_AWAITING");
      if (ladder.settings.declineIs === "forfeit") {
        await decideForfeit(ladder, season, ch, true, today, { reason: "declined", by: me });
        await tellEnd(ladder, other, me, "declinedForfeit");
      } else {
        await db.prepare("UPDATE ladder_challenges SET status = 'declined', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, ch.id);
        await tellEnd(ladder, other, me, "declined");
      }
    } else if ("propose" in input) {
      const when = proposal(input, today);
      if (!when.ok) return when.refusal;
      if (!when.on) return ladderRefusal("LD_TIME", {}, 400);
      await db
        .prepare(
          `UPDATE ladder_challenges SET proposed_on = ?, proposed_min = ?, proposed_by = ?, awaiting = ?, respond_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`
        )
        .run(when.on, when.min, mineId, mineId === ch.challenged ? "challenger" : "challenged", addDays(today, ladder.settings.respondDays), ch.id);
      await tellPlayer(
        other,
        ladder,
        (tr) => tr("ld.mail.answered.s", { l: ladder.name, a: me }),
        (tr) => tr("ld.mail.answered.b", { l: ladder.name, a: me, what: tr("ld.ans.proposed", { date: when.on!, time: when.min === null ? "" : fmtMin(when.min) }) })
      );
    } else {
      const when = proposal(input, today);
      if (!when.ok) return when.refusal;
      // Accepting a time the other side proposed agrees it; accepting with a day of their own sets that.
      const on = when.on ?? (ch.proposed_by !== null && ch.proposed_by !== mineId ? ch.proposed_on : null);
      const min = when.on ? when.min : on === ch.proposed_on ? ch.proposed_min : null;
      await db
        .prepare(
          `UPDATE ladder_challenges SET status = 'accepted', agreed_on = ?, agreed_min = ?, play_by = ?, respond_by = NULL, version = version + 1, updated_at = datetime('now') WHERE id = ?`
        )
        .run(on, min, addDays(today, ladder.settings.playDays), ch.id);
      await tellPlayer(
        other,
        ladder,
        (tr) => tr("ld.mail.answered.s", { l: ladder.name, a: me }),
        (tr) =>
          tr("ld.mail.answered.b", {
            l: ladder.name,
            a: me,
            what: tr(on ? "ld.ans.acceptedOn" : "ld.ans.accepted", { date: on ?? "", time: min === null ? "" : fmtMin(min), by: addDays(today, ladder.settings.playDays) }),
          })
      );
    }
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/** The challenger withdraws a challenge not yet played: no effect on anybody's rank. */
export async function withdraw(userId: number, challengeId: number, expected: { version?: number } = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found || found.myId !== found.ch.challenger) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder) => {
    const ch = await lockedChallenge(challengeId);
    if (!ch) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (stale(ch, expected)) return changedRefusal();
    if (ch.status !== "pending" && ch.status !== "accepted") return ladderRefusal("LD_NOT_AWAITING");
    await getDb().prepare("UPDATE ladder_challenges SET status = 'cancelled', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(await venueToday(ladder.venueId), ch.id);
    const people = await playersOf(ladder.id);
    await tellEnd(ladder, ch.challenged, (people.get(ch.challenger)?.shown ?? ""), "withdrawn");
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

type EndWhat = "left" | "frozen" | "season" | "declined" | "declinedForfeit" | "withdrawn" | "ignored" | "lapsed" | "notPlayed";

async function tellEnd(ladder: Ladder, toPlayer: number, who: string, what: EndWhat): Promise<void> {
  await tellPlayer(toPlayer, ladder, (tr) => tr("ld.mail.ended.s", { l: ladder.name }), (tr) => tr("ld.mail.ended.b", { l: ladder.name, a: who, what: tr(`ld.end.${what}`) }));
}

/** A forfeit: the other side wins by default (a walkover), recorded in the ledger. `challengedForfeits`: the challenged lost by default. */
async function decideForfeit(ladder: Ladder, season: SeasonRow, ch: ChallengeRow, challengedForfeits: boolean, today: string, why: { reason: string; by: string }): Promise<void> {
  const db = getDb();
  const winner = challengedForfeits ? ch.challenger : ch.challenged;
  await db
    .prepare("UPDATE ladder_challenges SET status = 'walkover', winner = ?, score = NULL, forfeit = true, resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(winner, today, ch.id);
  await writeResult(ladder.id, season.id, ch, { challengerWon: challengedForfeits, forfeit: true }, today, null);
  void why;
  await settleAndTell(ladder, season, ch.id);
}

/** After a result event: the ranks rewritten, the ratings read again, and both sides told where they stand. */
async function settleAndTell(ladder: Ladder, season: SeasonRow, challengeId: number): Promise<void> {
  const ranks = await settle(season.id);
  const ch = (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(challengeId)) as ChallengeRow;
  for (const id of [ch.challenger, ch.challenged]) {
    const rank = ranks.find((r) => r.playerId === id)?.rank;
    if (rank === undefined) continue;
    const people = await playersOf(ladder.id);
    const a = (people.get(ch.challenger)?.shown ?? "");
    const b = (people.get(ch.challenged)?.shown ?? "");
    const winner = ch.winner === ch.challenger ? a : b;
    await tellPlayer(
      id,
      ladder,
      (tr) => tr("ld.mail.result.s", { l: ladder.name }),
      (tr) => tr(ch.forfeit ? "ld.mail.result.forfeit" : "ld.mail.result.b", { l: ladder.name, a, b, winner, score: ch.score ?? "", rank })
    );
  }
  await ratingsAfter(ladder.id);
}

// ------------------------------------------------------------ results

/** Why a score cannot stand for this winner, by the ladder's scoring rules (the first-named side's score first), or null. */
function checkScore(winnerIsFirst: boolean, score: string, scoring: CompetitionRules["scoring"]): string | null {
  return scoreRefusal(score, winnerIsFirst, scoring);
}

/**
 * Either side says how the match went (their own score first), once it is accepted. They can put it right until the other
 * side answers; the other confirms it, or says it is wrong and the venue decides. A result nobody answers in 3 days stands.
 */
export async function report(userId: number, challengeId: number, input: { winner: number; score: string }, expected: { version?: number } = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (stale(ch, expected)) return changedRefusal();
    const mine = found.myId;
    if (ch.status === "reported" && ch.reported_by !== mine) return ladderRefusal("LD_THEY_REPORTED");
    if (ch.status === "disputed") return ladderRefusal("LD_DISPUTED");
    if (ch.status === "pending") return ladderRefusal("LD_NOT_ACCEPTED");
    if (ch.status !== "accepted" && ch.status !== "reported") return ladderRefusal("LD_RESULT_SETTLED");
    if (input.winner !== ch.challenger && input.winner !== ch.challenged) return ladderRefusal("LD_WINNER", {}, 400);
    // A player writes their own games first; it is kept with the challenger's first.
    const typed = input.score.trim();
    const score = mine === ch.challenger ? typed : flipScore(typed);
    const wrong = checkScore(input.winner === ch.challenger, score, ladder.rules.scoring);
    if (wrong) return { ok: false, error: wrong, status: 400 };
    await getDb()
      .prepare(
        `UPDATE ladder_challenges SET status = 'reported', winner = ?, score = ?, reported_by = ?, reported_at = datetime('now'), version = version + 1, updated_at = datetime('now') WHERE id = ?`
      )
      .run(input.winner, score, mine, ch.id);
    const people = await playersOf(ladder.id);
    const me = (people.get(mine)?.shown ?? "");
    const other = mine === ch.challenger ? ch.challenged : ch.challenger;
    await tellPlayer(
      other,
      ladder,
      (tr) => tr("ld.mail.reported.s", { l: ladder.name, a: me }),
      (tr) => tr("ld.mail.reported.b", { l: ladder.name, a: me, score: typed, winner: input.winner === mine ? tr("ld.they") : tr("ld.you"), days: CONFIRM_DAYS })
    );
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/** The other side agrees with the result they saw: it becomes the result and moves the ranks. */
export async function confirm(userId: number, challengeId: number, expected: { version?: number } = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (stale(ch, expected)) return changedRefusal();
    if (ch.status !== "reported" || ch.reported_by === found.myId) return ladderRefusal("LD_NOTHING_TO_CONFIRM");
    await standResult(ladder, season, ch, await venueToday(ladder.venueId));
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/** A reported result becomes the result (confirmed, or standing unanswered): a ledger event, the ranks rewritten. */
async function standResult(ladder: Ladder, season: SeasonRow, ch: ChallengeRow, today: string): Promise<void> {
  await getDb().prepare("UPDATE ladder_challenges SET status = 'confirmed', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, ch.id);
  await writeResult(ladder.id, season.id, ch, { challengerWon: ch.winner === ch.challenger, forfeit: false }, today, null);
  await settleAndTell(ladder, season, ch.id);
}

/** The other side says it did not go like that: the venue's manager decides. */
export async function dispute(userId: number, challengeId: number, note: string, expected: { version?: number } = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  const why = note.trim().slice(0, 500);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (stale(ch, expected)) return changedRefusal();
    if (ch.status !== "reported" || ch.reported_by === found.myId) return ladderRefusal("LD_NOTHING_TO_CONFIRM");
    if (why.length < 3) return ladderRefusal("LD_REASON", {}, 400);
    await getDb().prepare("UPDATE ladder_challenges SET status = 'disputed', dispute_note = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(why, ch.id);
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/**
 * A manager decides a challenge's result with a reason: a winner and score (a dispute, or a correction after it was
 * confirmed), a walkover, void (it never counts) or clear (to be played again). The result's place in the ledger is kept, so the
 * ranks are the replay of everything with this result as decided.
 */
export type Decision = { winner: number; score?: string; walkover?: boolean } | { void: true } | { clear: true };

export async function decide(challengeId: number, by: { adminId: number | null; name: string }, decision: Decision, reason: string): Promise<LadderResult<ChallengeView>> {
  const row = (await getDb().prepare("SELECT ladder_id FROM ladder_challenges WHERE id = ?").get(challengeId)) as { ladder_id: number } | undefined;
  if (!row) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  const why = reason.trim();
  if (why.length < 3) return ladderRefusal("LD_REASON", {}, 400);
  return withLadder(row.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_SEASON_OVER");
    const today = await venueToday(ladder.venueId);
    if ("void" in decision) {
      await db.prepare("UPDATE ladder_challenges SET status = 'void', winner = NULL, score = NULL, forfeit = false, resolved_on = ?, decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, by.adminId, ch.id);
      await writeResult(ladder.id, season.id, ch, null, today, { reason: why, by: by.name });
    } else if ("clear" in decision) {
      await db
        .prepare("UPDATE ladder_challenges SET status = 'accepted', winner = NULL, score = NULL, forfeit = false, reported_by = NULL, reported_at = NULL, dispute_note = NULL, play_by = ?, resolved_on = NULL, decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?")
        .run(addDays(today, ladder.settings.playDays), by.adminId, ch.id);
      await writeResult(ladder.id, season.id, ch, null, today, { reason: why, by: by.name });
    } else {
      if (decision.winner !== ch.challenger && decision.winner !== ch.challenged) return ladderRefusal("LD_WINNER", {}, 400);
      const score = decision.score?.trim() || null;
      if (score) {
        const wrong = checkScore(decision.winner === ch.challenger, score, ladder.rules.scoring);
        if (wrong) return { ok: false, error: wrong, status: 400 };
      } else if (!decision.walkover) return ladderRefusal("LD_SCORE_OR_WALKOVER", {}, 400);
      await db
        .prepare("UPDATE ladder_challenges SET status = ?, winner = ?, score = ?, forfeit = ?, resolved_on = COALESCE(resolved_on, ?), decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?")
        .run(score ? "confirmed" : "walkover", decision.winner, score, !score, today, by.adminId, ch.id);
      const fresh = (await db.prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(ch.id)) as ChallengeRow;
      await writeResult(ladder.id, season.id, fresh, { challengerWon: decision.winner === ch.challenger, forfeit: !score }, fresh.resolved_on ?? today, { reason: why, by: by.name });
    }
    const ranks = await settle(season.id);
    await ratingsAfter(ladder.id);
    for (const id of [ch.challenger, ch.challenged]) {
      const rank = ranks.find((r) => r.playerId === id)?.rank;
      await tellPlayer(
        id,
        ladder,
        (tr) => tr("ld.mail.decided.s", { l: ladder.name }),
        (tr) => tr("ld.mail.decided.b", { l: ladder.name, reason: why, rank: rank ?? "" })
      );
    }
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

// ------------------------------------------------------------ freezes and the manager's overrides

/** Freeze a place until a day: not challenged, not challenging, not dropping; open challenges are cancelled with no effect. */
export async function freeze(userId: number | null, playerId: number, until: string, by: { name: string } | null = null): Promise<LadderResult<{ until: string }>> {
  const p = (await getDb().prepare("SELECT ladder_id, status FROM ladder_players WHERE id = ?").get(playerId)) as { ladder_id: number; status: string } | undefined;
  if (!p || p.status !== "active") return ladderRefusal("LD_NOT_ON", {}, 404);
  if (userId !== null && !(await myPlayer(userId, playerId))) return ladderRefusal("LD_NOT_YOURS", {}, 403);
  return withLadder(p.ladder_id, async (ladder, season) => {
    const today = await venueToday(ladder.venueId);
    if (typeof until !== "string" || !isValidDateString(until) || until <= today) return ladderRefusal("LD_FREEZE_DATE", {}, 400);
    if (daysBetween(today, until) > ladder.settings.freezeMaxDays) return ladderRefusal("LD_FREEZE_LONG", { days: ladder.settings.freezeMaxDays }, 400);
    const ranks = await ranksOf(season.id);
    if (!ranks.some((r) => r.playerId === playerId)) return ladderRefusal("LD_NOT_ON", {}, 404);
    await cancelOpenFor(ladder, season, playerId, "frozen");
    await addEvent(ladder.id, season.id, "freeze", playerId, null, today, { until, ...(by ? { by: by.name } : {}) });
    await settle(season.id);
    return { ok: true, value: { until } };
  });
}

/** End a freeze early (the player's, or a manager's). Their idleness counts from today. */
export async function thaw(userId: number | null, playerId: number, by: { name: string } | null = null): Promise<LadderResult<{ playerId: number }>> {
  const p = (await getDb().prepare("SELECT ladder_id, status FROM ladder_players WHERE id = ?").get(playerId)) as { ladder_id: number; status: string } | undefined;
  if (!p || p.status !== "active") return ladderRefusal("LD_NOT_ON", {}, 404);
  if (userId !== null && !(await myPlayer(userId, playerId))) return ladderRefusal("LD_NOT_YOURS", {}, 403);
  return withLadder(p.ladder_id, async (ladder, season) => {
    const ranks = await ranksOf(season.id);
    if (!ranks.find((r) => r.playerId === playerId)?.frozenUntil) return ladderRefusal("LD_NOT_FROZEN");
    await addEvent(ladder.id, season.id, "thaw", playerId, null, await venueToday(ladder.venueId), by ? { by: by.name } : {});
    await settle(season.id);
    return { ok: true, value: { playerId } };
  });
}

/** A manager moves somebody to a rank, with a reason: everybody between moves one place. Logged by the caller. */
export async function moveTo(playerId: number, toRank: number, by: { name: string }, reason: string): Promise<LadderResult<{ rank: number }>> {
  const p = (await getDb().prepare("SELECT ladder_id, status, name FROM ladder_players WHERE id = ?").get(playerId)) as { ladder_id: number; status: string; name: string } | undefined;
  if (!p || p.status !== "active") return ladderRefusal("LD_NOT_ON", {}, 404);
  const why = reason.trim();
  if (why.length < 3) return ladderRefusal("LD_REASON", {}, 400);
  if (!Number.isInteger(toRank) || toRank < 1 || toRank > 999) return ladderRefusal("LD_RANK", {}, 400);
  return withLadder(p.ladder_id, async (ladder, season) => {
    if (!(await ranksOf(season.id)).some((r) => r.playerId === playerId)) return ladderRefusal("LD_NOT_ON", {}, 404);
    await addEvent(ladder.id, season.id, "move", playerId, null, await venueToday(ladder.venueId), { toRank, reason: why, by: by.name });
    const ranks = await settle(season.id);
    const rank = ranks.find((r) => r.playerId === playerId)!.rank;
    await tellPlayer(playerId, ladder, (tr) => tr("ld.mail.moved.s", { l: ladder.name }), (tr) => tr("ld.mail.moved.b", { l: ladder.name, rank, reason: why }));
    return { ok: true, value: { rank } };
  });
}

// ------------------------------------------------------------ seasons

/**
 * End the season: open challenges are cancelled with no effect, the final order is archived, and (unless the ladder is
 * closed) the next season begins with everybody carried over in that order. The ledger of the season that ended is never changed.
 */
export async function endSeason(ladderId: number, opts: { close?: boolean } = {}): Promise<LadderResult<Ladder>> {
  return withLadder(ladderId, async (ladder, season) => {
    const db = getDb();
    const today = await venueToday(ladder.venueId);
    const people = await playersOf(ladderId);
    const ranks = await ranksOf(season.id);
    const open = (await db.prepare(`SELECT * FROM ladder_challenges WHERE season_id = ? AND status IN (${OPEN_SQL})`).all(season.id)) as ChallengeRow[];
    for (const c of open) {
      await db.prepare("UPDATE ladder_challenges SET status = 'cancelled', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, c.id);
      for (const id of [c.challenger, c.challenged]) await tellEnd(ladder, id, (people.get(id === c.challenger ? c.challenged : c.challenger)?.shown ?? ""), "season");
    }
    const finalRanks = ranks.map((r) => ({ rank: r.rank, playerId: r.playerId, name: shown(ladder, people.get(r.playerId)?.name ?? "") }));
    await db.prepare("UPDATE ladder_seasons SET ended_on = ?, final_ranks = ? WHERE id = ?").run(today, JSON.stringify(finalRanks), season.id);
    await db.prepare("DELETE FROM ladder_ranks WHERE season_id = ?").run(season.id);
    if (opts.close) await db.prepare("UPDATE ladders SET status = 'closed' WHERE id = ?").run(ladderId);
    else {
      const next = (await db.prepare("INSERT INTO ladder_seasons (ladder_id, number, started_on) VALUES (?, ?, ?) RETURNING id").get(ladderId, season.number + 1, today)) as { id: number };
      for (const r of ranks) await addEvent(ladderId, next.id, "carry", r.playerId, null, today, {});
      await settle(next.id);
    }
    return { ok: true, value: (await ladderById(ladderId))! };
  });
}

// ------------------------------------------------------------ what happens by itself

/**
 * From the scheduler: reports nobody answered stand, a challenge the challenged ignored is forfeited by them, one nobody
 * played lapses, freezes end, and a player idle too long drops. Each change is an ordinary one, under the ladder's lock, and
 * running it again changes nothing it has already done.
 */
export async function ladderHousekeeping(): Promise<{ confirmed: number; forfeited: number; lapsed: number; thawed: number; dropped: number }> {
  const db = getDb();
  const total = { confirmed: 0, forfeited: 0, lapsed: 0, thawed: 0, dropped: 0 };
  const ladders = (await db.prepare("SELECT id FROM ladders WHERE status = 'open' ORDER BY id").all()) as { id: number }[];
  for (const l of ladders) {
    const done = await withLadder(l.id, async (ladder, season) => {
      const out = { confirmed: 0, forfeited: 0, lapsed: 0, thawed: 0, dropped: 0 };
      const today = await venueToday(ladder.venueId);
      const open = (await db.prepare(`SELECT * FROM ladder_challenges WHERE season_id = ? AND status IN (${OPEN_SQL}) ORDER BY id`).all(season.id)) as ChallengeRow[];
      const people = await playersOf(ladder.id);
      for (const c of open) {
        if (c.status === "reported" && c.reported_at !== null && c.reported_at < (await daysAgo(CONFIRM_DAYS))) {
          await standResult(ladder, season, c, today);
          out.confirmed++;
        } else if (c.status === "pending" && c.respond_by !== null && today > c.respond_by) {
          if (c.awaiting === "challenged") {
            await decideForfeit(ladder, season, c, true, today, { reason: "ignored", by: "" });
            await tellEnd(ladder, c.challenger, (people.get(c.challenged)?.shown ?? ""), "ignored");
            out.forfeited++;
          } else {
            await db.prepare("UPDATE ladder_challenges SET status = 'lapsed', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, c.id);
            await tellEnd(ladder, c.challenged, (people.get(c.challenger)?.shown ?? ""), "lapsed");
            out.lapsed++;
          }
        } else if (c.status === "accepted" && c.play_by !== null && today > c.play_by) {
          await db.prepare("UPDATE ladder_challenges SET status = 'lapsed', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, c.id);
          for (const id of [c.challenger, c.challenged]) await tellEnd(ladder, id, (people.get(id === c.challenger ? c.challenged : c.challenger)?.shown ?? ""), "notPlayed");
          out.lapsed++;
        }
      }
      let ranks = await ranksOf(season.id);
      for (const r of ranks.filter((x) => x.frozenUntil !== null && today > x.frozenUntil!)) {
        await addEvent(ladder.id, season.id, "thaw", r.playerId, null, today, {});
        out.thawed++;
      }
      if (out.thawed > 0) ranks = await ranksOf(season.id);
      if (ladder.settings.inactiveDays > 0) {
        const busy = await busyPlayers(season.id);
        for (const r of ranks) {
          if (r.frozenUntil !== null || busy.has(r.playerId)) continue;
          if (daysBetween(r.activeOn, today) < ladder.settings.inactiveDays) continue;
          await addEvent(ladder.id, season.id, "drop", r.playerId, null, today, { places: ladder.settings.inactiveDrop });
          out.dropped++;
          // The ranks change under each drop: the replay says who is where next.
          ranks = await ranksOf(season.id);
          const now = ranks.find((x) => x.playerId === r.playerId);
          await tellPlayer(r.playerId, ladder, (tr) => tr("ld.mail.dropped.s", { l: ladder.name }), (tr) => tr("ld.mail.dropped.b", { l: ladder.name, n: ladder.settings.inactiveDrop, days: ladder.settings.inactiveDays, rank: now?.rank ?? "" }));
        }
      }
      if (out.confirmed + out.forfeited + out.lapsed + out.thawed + out.dropped > 0) await settle(season.id);
      return { ok: true as const, value: out };
    });
    if (done.ok) for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += done.value[k];
  }
  return total;
}

/** A timestamp (as the database writes `datetime('now')`) this many days ago, to compare reported times with. */
async function daysAgo(days: number): Promise<string> {
  const row = (await getDb().prepare(`SELECT datetime('now', '-${Math.trunc(days)} days') AS t`).get()) as { t: string };
  return row.t;
}

// ------------------------------------------------------------ telling people

/** An email to the account that holds a place, in its language; one for somebody the account acts for says whose it is first. */
async function tellPlayer(playerId: number, ladder: Pick<Ladder, "id" | "venueId">, subject: Written, body: Written): Promise<void> {
  const p = (await getDb()
    .prepare("SELECT lp.user_id, lp.participant_id, pa.display_name FROM ladder_players lp LEFT JOIN participants pa ON pa.id = lp.participant_id WHERE lp.id = ?")
    .get(playerId)) as { user_id: number | null; participant_id: number | null; display_name: string | null } | undefined;
  if (!p?.user_id) return;
  const forName = p.participant_id !== null ? p.display_name : null;
  await emailPlayer({
    venueId: ladder.venueId,
    userId: p.user_id,
    subject,
    body: (tr) => sentences(tr, forName && tr("lg5.mail.entryFor", { name: forName }), body(tr)),
    link: `${baseUrl()}/ladders/${ladder.id}`,
  });
}

/** After a result changes: read the ladder into the ratings if it is rated (lib/ratings.ts); never fails the change that caused it. */
async function ratingsAfter(ladderId: number): Promise<void> {
  await (await import("./ratings")).ratedAfter("ladder", ladderId);
}

// ------------------------------------------------------------ their own data

/** The name of these places in the archived final orders of ended seasons replaced too, so an erased person is not left in the archive. */
async function anonymiseArchive(playerIds: number[], anonymous: string): Promise<void> {
  if (playerIds.length === 0) return;
  const db = getDb();
  const seasons = (await db
    .prepare(`SELECT s.id, s.final_ranks FROM ladder_seasons s WHERE s.final_ranks IS NOT NULL AND s.ladder_id IN (SELECT ladder_id FROM ladder_players WHERE id IN (${playerIds.map(() => "?").join(",")}))`)
    .all(...playerIds)) as { id: number; final_ranks: string }[];
  for (const s of seasons) {
    const ranks = JSON.parse(s.final_ranks) as { rank: number; playerId: number; name: string }[];
    if (!ranks.some((r) => playerIds.includes(r.playerId))) continue;
    await db.prepare("UPDATE ladder_seasons SET final_ranks = ? WHERE id = ?").run(JSON.stringify(ranks.map((r) => (playerIds.includes(r.playerId) ? { ...r, name: anonymous } : r))), s.id);
  }
}

/** A person's erasure: out of every ladder, their name replaced in the ledger's places by a placeholder; nobody else moves up or down by it beyond the gap closing. */
export async function forgetLadderPlayer(userId: number, anonymous: string): Promise<void> {
  const db = getDb();
  const rows = (await db.prepare("SELECT id FROM ladder_players WHERE user_id = ? AND participant_id IS NULL AND status = 'active'").all(userId)) as { id: number }[];
  for (const r of rows) await leave(r.id);
  await anonymiseArchive(((await db.prepare("SELECT id FROM ladder_players WHERE user_id = ? AND participant_id IS NULL").all(userId)) as { id: number }[]).map((r) => r.id), anonymous);
  await db.prepare("UPDATE ladder_players SET user_id = NULL WHERE user_id = ? AND participant_id IS NOT NULL").run(userId);
  await db.prepare("UPDATE ladder_players SET name = ?, partner_name = NULL, user_id = NULL, contact_phone = NULL WHERE user_id = ?").run(anonymous, userId);
}

/** A participant's record erased: out of their ladders, their name replaced. */
export async function forgetLadderParticipant(participantId: number, anonymous: string): Promise<void> {
  const db = getDb();
  const rows = (await db.prepare("SELECT id FROM ladder_players WHERE participant_id = ? AND status = 'active'").all(participantId)) as { id: number }[];
  for (const r of rows) await leave(r.id);
  await anonymiseArchive(((await db.prepare("SELECT id FROM ladder_players WHERE participant_id = ?").all(participantId)) as { id: number }[]).map((r) => r.id), anonymous);
  await db.prepare("UPDATE ladder_players SET name = ?, partner_name = NULL, user_id = NULL, contact_phone = NULL, participant_id = NULL WHERE participant_id = ?").run(anonymous, participantId);
}

