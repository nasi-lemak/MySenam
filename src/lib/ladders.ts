import { isActivity } from "./activities";
import { getDb, isBusy, withTransaction } from "./db";
import { flipScore, scoreRefusal } from "./brackets";
import { categoryOfWho, declaredGender, entrantCategoryRefusal, entrantParticipantId, entrantUserId, entrantVenueRefusal, selfEntrant, type Entrant } from "./competition-entrants";
import { templateByKey, templateFor, type RubberKind } from "./competition-templates";
import { AsyncLocalStorage } from "node:async_hooks";
import { logAction } from "./activity";
import {
  carryAgreement,
  confirmHold,
  expiredHoldsToTell,
  extendHold,
  holdHistory,
  holdViews,
  ladderCourts,
  makeHold,
  markExpiryTold,
  moveHold,
  ownCancellations,
  previewHold,
  liftPause,
  offerFreed,
  recordEvent,
  releaseHold,
  resolveHoldLimits,
  setHoldLimits,
  type HoldLimitsView,
  type HoldRefusal,
  type HoldView,
} from "./ladder-holds";
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

/** `challenge`: for a refusal of a stale act (`LAD5_STALE`), the challenge as it is now, so the page shows the current proposal again (ADR 0051). */
export type LadderRefusal = Refusal & { status: number; challenge?: ChallengeView };
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
  /** Singles or pairs ('players'), or persistent teams entered by their captains ('teams', docs/features/tournaments.md#team-ladders). */
  kind: "players" | "teams";
  /** Whether the venue holds court time for accepted challenges (off unless a manager turned it on), and where and for how long. */
  courtTime: CourtTimeSettings;
  /** A ladder of teams: what a team match is made of. */
  team: TeamSettings | null;
  /** On the ladder now. */
  players: number;
  season: { id: number; number: number; startedOn: string } | null;
}

/** Court time held by the venue for accepted challenges (lib/ladder-holds.ts). Off by default: a challenge then holds nothing. */
export interface CourtTimeSettings {
  on: boolean;
  /** The courts it may use; none: any court of the venue for the sport. */
  courtIds: number[];
  /** Minutes held for a match when the manager set them; otherwise the template's (a team ladder's: its games added up). */
  minutes: number | null;
  /** The minutes a hold is for now, whichever way they are known. */
  matchMinutes: number;
  /** A hold is tentative until both players (or a manager) confirm it, and lapses if they do not in time (ADR 0048). On unless a manager turns it off for the ladder. */
  needsConfirmation: boolean;
}

/** What a team match on a ladder of teams is made of and who may play (the same shape as a team league's). */
export interface TeamSettings {
  rubbers: RubberKind[];
  rubberMinutes: number;
  rosterMin: number;
  rosterMax: number;
  maxRubbersPerPlayer: number;
}

export interface LadderRowView {
  playerId: number;
  rank: number;
  /** As shown: the name given, or first name and initial on a junior ladder. */
  name: string;
  frozenUntil: string | null;
  /** Whether the place is in an open challenge. Only for staff: nobody else is told who is in one (a player sees their own in `MyPlace`). */
  inChallenge?: boolean;
  /** Only for staff. */
  userId?: number | null;
  participantId?: number | null;
  atCounter?: { by: string; phone: string | null } | null;
  activeOn?: string;
  /** Only for staff, on a ladder of teams. */
  teamId?: number | null;
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
  /**
   * The revision of the challenge's proposal (the day and time asked, or the move asked), which goes up whenever it changes or ends. An act answers the revision it saw
   * (`rev`); one for a revision that is no longer current is refused (`LAD5_STALE`) and a superseded proposal can never be accepted (ADR 0051).
   */
  rev: number;
  resolvedOn: string | null;
  /** Only for staff. */
  disputeNote?: string | null;
  /** The court the venue holds for it, when the ladder holds court time and one is held (staff and the two sides only). */
  hold?: HoldView | null;
  /** A ladder of teams: the games and lineups the viewer may see, and the forfeit requests on it (staff, and the captain of each side). */
  team?: import("./team-ladders").TeamChallengeView;
  forfeitRequests?: import("./team-forfeits").LadderForfeitRequestView[];
  /** A time one side has asked the other to agree (a move, or the first specific time) (staff and the two sides only). */
  move?: { onDate: string; minute: number | null; by: number; respondBy: string | null } | null;
  /** Only for staff: what happened to its proposals and holds, in order, attributing nothing (ADR 0051). */
  history?: HoldEventView[];
}

/** One thing that happened to a proposal or a hold (ADR 0051): said as it happened, never as anyone's fault. `reservedCapacity`: whether a court was ever really held by it. */
export interface HoldEventView {
  kind: string;
  /** The player's place who acted, if a player did; the venue's own or the system's acts have none. */
  by: number | null;
  byName: string | null;
  rev: number | null;
  date: string | null;
  startMin: number | null;
  reservedCapacity: boolean;
  note: string | null;
  at: string;
}

export interface SeasonView {
  id: number;
  number: number;
  startedOn: string;
  endedOn: string | null;
  finalRanks: { rank: number; playerId: number; name: string }[] | null;
}

/**
 * A decided result as the public sees it: who won, against whom, and the score with the winner's games first. Never who challenged
 * whom, when it was proposed or played, or anything about a challenge that did not end in a confirmed result.
 */
export interface LadderResultView {
  /** The day it was decided. */
  on: string | null;
  winnerName: string;
  loserName: string;
  score: string | null;
}

export interface LadderDetail extends Ladder {
  seasons: SeasonView[];
  viewing: SeasonView | null;
  rows: LadderRowView[];
  /**
   * The confirmed results of the season viewed, newest first: all the public is shown of the matches (docs/features/tournaments.md#club-ladders).
   * A challenge that is open or ended any other way (declined, lapsed, cancelled, a walkover, struck) is not a result.
   */
  results: LadderResultView[];
  /** Only for staff: every challenge of the season, in every state. A player's own are `MyPlace.open` and `history`. */
  challenges?: ChallengeView[];
  /** Only for staff: the limits on held court time that apply to this ladder and where each comes from (ADR 0048, ADR 0050). Never shown to players or the public. */
  holdLimits?: HoldLimitsView;
  /**
   * Only for staff: for each place with holds released unplayed in the window, neutral numbers: how many, of which the player's own cancellations of a hold that reserved
   * court capacity (the one thing the anti-abuse pause counts), when the latest was, and until when new holds are paused for them (ADR 0051). Never shown to players or the public.
   */
  holdHistory?: { playerId: number; name: string; releasedUnplayed: number; cancelledByPlayer: number; last: string | null; pausedUntil: string | null }[];
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
  /** Open challenges involving the place, with the other side's contact once accepted (adult ladders only), and the ordinary booking attached to it, if one is. */
  open: (ChallengeView & { contact: { name: string; phone: string; whatsapp: string } | null; booking: ChallengeBooking | null })[];
  history: (ChallengeView & { booking: ChallengeBooking | null })[];
  /** Where a challenge's players book a court: the venue's own booking page for the sport, as anybody does (no court is held for a challenge). */
  bookingPage: string;
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
  court_time_on?: boolean | null;
  /** Whether a hold has to be confirmed by both players (migration 0290; true unless a manager turned it off). */
  needs_confirmation?: boolean | null;
  match_minutes?: number | null;
  kind?: "players" | "teams" | null;
  rubbers?: string | null;
  rubber_minutes?: number | null;
  roster_min?: number | null;
  roster_max?: number | null;
  max_rubbers_per_player?: number | null;
}

export interface SeasonRow {
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

export async function currentSeason(ladderId: number): Promise<SeasonRow | undefined> {
  return (await getDb().prepare("SELECT * FROM ladder_seasons WHERE ladder_id = ? AND ended_on IS NULL ORDER BY number DESC LIMIT 1").get(ladderId)) as SeasonRow | undefined;
}

/** The games a team match on a ladder of teams is made of, from what was stored. */
function readRubbers(raw: string | null | undefined): RubberKind[] {
  try {
    const v = JSON.parse(raw ?? "") as RubberKind[];
    if (Array.isArray(v) && v.length > 0) return v;
  } catch {
    /* the default */
  }
  return ["team"];
}

async function toLadder(r: LRow): Promise<Ladder> {
  const season = await currentSeason(r.id);
  const teams = r.kind === "teams";
  const team: TeamSettings | null = teams
    ? { rubbers: readRubbers(r.rubbers), rubberMinutes: r.rubber_minutes ?? 40, rosterMin: r.roster_min ?? 2, rosterMax: r.roster_max ?? 12, maxRubbersPerPlayer: r.max_rubbers_per_player ?? 2 }
    : null;
  const matchMinutes = r.match_minutes ?? (team ? team.rubbers.length * team.rubberMinutes : (templateByKey(r.template ?? "")?.matchMinutes ?? templateFor(r.sport).matchMinutes));
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
    kind: teams ? "teams" : "players",
    courtTime: { on: r.court_time_on === true, courtIds: await ladderCourts(r.id), minutes: r.match_minutes ?? null, matchMinutes, needsConfirmation: r.needs_confirmation !== false },
    team,
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

export interface PlayerRow {
  id: number;
  ladder_id: number;
  user_id: number | null;
  team_id?: number | null;
  /** A team's captain now: the account that acts for the place. */
  captain_user_id?: number | null;
  name: string;
  participant_id: number | null;
  contact_phone: string | null;
  entered_by_name: string | null;
  status: "active" | "left";
  /** The name as the ladder shows it: short on a junior ladder unless the child's guardian authorised the full name for this season (lib/public-names.ts). */
  shown: string;
}

export async function playersOf(ladderId: number): Promise<Map<number, PlayerRow>> {
  const db = getDb();
  const rows = (await db.prepare("SELECT id, ladder_id, user_id, team_id, (SELECT t.captain_user_id FROM teams t WHERE t.id = ladder_players.team_id) AS captain_user_id, name, participant_id, contact_phone, entered_by_name, status FROM ladder_players WHERE ladder_id = ?").all(ladderId)) as Omit<PlayerRow, "shown">[];
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

const toChallenge = (c: ChallengeRow, names: Map<number, string>, forStaff: boolean, holds?: Map<number, HoldView>): ChallengeView => ({
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
  rev: Number(c.proposal_rev ?? 1),
  resolvedOn: c.resolved_on,
  ...(forStaff ? { disputeNote: c.dispute_note } : {}),
  ...(holds ? { hold: holds.get(c.id) ?? null, move: c.move_on ? { onDate: c.move_on, minute: c.move_min ?? null, by: c.move_by!, respondBy: c.move_respond_by ?? null } : null } : {}),
});

export interface ChallengeRow {
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
  move_on?: string | null;
  move_min?: number | null;
  move_by?: number | null;
  /** The revision of the proposal (migration 0293); 1 for a challenge already in flow when it was added. */
  proposal_rev?: number | string;
  move_respond_by?: string | null;
}

export async function ladderDetail(id: number, opts: { season?: number; forStaff?: boolean } = {}): Promise<LadderDetail | null> {
  const ladder = await ladderById(id);
  if (!ladder) return null;
  const db = getDb();
  const seasonRows = (await db.prepare("SELECT * FROM ladder_seasons WHERE ladder_id = ? ORDER BY number DESC").all(id)) as SeasonRow[];
  const people = await playersOf(id);
  // The venue's staff run the ladder from the names players gave (two juniors can share a first name and initial); the public is shown by the rule.
  const names = new Map([...people].map(([pid, p]) => [pid, opts.forStaff ? p.name : p.shown]));
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
  let results: LadderResultView[] = [];
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
        ...(opts.forStaff
          ? { inChallenge: open.has(r.playerId), userId: p.user_id, participantId: p.participant_id, teamId: p.team_id ?? null, atCounter: p.entered_by_name ? { by: p.entered_by_name, phone: p.contact_phone } : null, activeOn: r.activeOn }
          : {}),
      };
    });
  } else if (viewing?.finalRanks) rows = viewing.finalRanks.map((f) => ({ playerId: f.playerId, rank: f.rank, name: (opts.forStaff ? people.get(f.playerId)?.name : undefined) ?? f.name, frozenUntil: null, ...(opts.forStaff ? { inChallenge: false } : {}) }));
  if (viewing) {
    // What the public is shown of the matches is the confirmed results and nothing else. Every challenge is staff's, and a player's own are `myPlaces`.
    const decided = (await db
      .prepare("SELECT * FROM ladder_challenges WHERE season_id = ? AND status = 'confirmed' AND winner IS NOT NULL ORDER BY resolved_on DESC, id DESC LIMIT 100")
      .all(viewing.id)) as ChallengeRow[];
    results = decided.map((c) => ({
      on: c.resolved_on,
      winnerName: names.get(c.winner!) ?? "",
      loserName: names.get(c.winner === c.challenger ? c.challenged : c.challenger) ?? "",
      // Stored with the challenger's games first.
      score: c.score === null ? null : c.winner === c.challenger ? c.score : flipScore(c.score),
    }));
    if (opts.forStaff) {
      const cs = (await db.prepare("SELECT * FROM ladder_challenges WHERE season_id = ? ORDER BY id DESC LIMIT 200").all(viewing.id)) as ChallengeRow[];
      const holds = ladder.courtTime.on || cs.length > 0 ? await holdViews(cs.map((c) => c.id)) : new Map<number, HoldView>();
      challenges = cs.map((c) => toChallenge(c, names, true, holds));
      const holdEvents = await holdEventViews(cs.map((c) => c.id));
      for (const c of challenges) c.history = holdEvents.get(c.id) ?? [];
      if (ladder.kind === "teams") {
        const ids = cs.map((c) => c.id);
        const teams = await (await import("./team-ladders")).teamViews(ladder, ids, { staff: true });
        const requests = await (await import("./team-forfeits")).ladderForfeitRequests(ids, { forStaff: true, viewerId: null });
        for (const c of challenges) {
          if (teams.has(c.id)) c.team = teams.get(c.id);
          if (requests.has(c.id)) c.forfeitRequests = requests.get(c.id);
        }
      }
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
  }
  const history = opts.forStaff ? (await holdHistory(ladder)).map((a) => ({ ...a, name: people.get(a.playerId)?.name ?? "" })) : [];
  return { ...ladder, seasons, viewing, rows, results, ...(opts.forStaff ? { challenges, holdLimits: await resolveHoldLimits(ladder), holdHistory: history } : {}), ...(events ? { events } : {}) };
}

/** What happened to these challenges' proposals and holds, oldest first (staff only, ADR 0051). */
async function holdEventViews(challengeIds: number[]): Promise<Map<number, HoldEventView[]>> {
  const out = new Map<number, HoldEventView[]>();
  if (challengeIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(`SELECT * FROM ladder_hold_events WHERE challenge_id IN (${challengeIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(...challengeIds)) as { challenge_id: number; place_id: number | null; by_name: string | null; kind: string; rev: number | null; date: string | null; start_min: number | null; reserved_capacity: boolean; note: string | null; at: Date | string }[];
  for (const r of rows) {
    const list = out.get(r.challenge_id) ?? [];
    list.push({ kind: r.kind, by: r.place_id, byName: r.by_name, rev: r.rev, date: r.date, startMin: r.start_min, reservedCapacity: r.reserved_capacity === true, note: r.note, at: new Date(r.at).toISOString() });
    out.set(r.challenge_id, list);
  }
  return out;
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
  /** 'teams': a ladder of persistent teams (docs/features/tournaments.md#team-ladders). Default 'players'. */
  kind?: "players" | "teams";
  /** A ladder of teams: what a team match is made of; the template's games and a team league's defaults where not given. */
  team?: Partial<TeamSettings>;
  /** Whether the venue holds court time for accepted challenges (off unless given), the courts it may use and the minutes held. */
  courtTime?: { on?: boolean; courtIds?: number[]; minutes?: number | null };
}

const RUBBER_KINDS: RubberKind[] = ["singles", "doubles", "team"];
const MAX_RUBBERS = 9;

/** The courts of a venue for a sport that can hold a match: one place each, for that sport. Or why not. */
async function courtsRefusal(venueId: number, sport: string, raw: unknown): Promise<number[] | LadderRefusal> {
  const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter((n) => Number.isInteger(n)))] : [];
  if (Array.isArray(raw) && raw.length > 0 && ids.length === 0) return ladderRefusal("LAD2_COURTS", {}, 400);
  for (const id of ids) {
    const ok = await getDb()
      .prepare("SELECT 1 FROM courts c WHERE c.id = ? AND c.venue_id = ? AND c.capacity = 1 AND EXISTS (SELECT 1 FROM court_activities ca WHERE ca.court_id = c.id AND ca.sport = ?)")
      .get(id, venueId, sport);
    if (!ok) return ladderRefusal("LAD2_COURTS", {}, 400);
  }
  return ids;
}

const minutesOk = (v: unknown): number | null | LadderRefusal => (v === undefined || v === null || v === "" ? null : Number.isInteger(Number(v)) && Number(v) >= 10 && Number(v) <= 480 ? Number(v) : ladderRefusal("LAD2_MINUTES", {}, 400));

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
export async function venueToday(venueId: number): Promise<string> {
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
  if (input.kind !== undefined && input.kind !== "players" && input.kind !== "teams") return ladderRefusal("LAD2_KIND", {}, 400);
  const teams = input.kind === "teams";
  // A ladder of teams: a forfeit changes the ranks, so (as in a team league) it is a manager's to give: declining is free, and a challenge nobody answers lapses.
  if (teams && parsedSettings.settings.declineIs === "forfeit") return ladderRefusal("LAD2_TEAM_DECLINE", {}, 400);
  if (teams && audience !== "adults") return ladderRefusal("LAD2_TEAM_AUDIENCE", {}, 400);
  if (!(await db.prepare("SELECT 1 FROM court_activities ca JOIN courts c ON c.id = ca.court_id WHERE c.venue_id = ? AND ca.sport = ?").get(input.venueId, input.sport)))
    return ladderRefusal("LD_NO_COURTS", {}, 400);
  // Scored as a head-to-head competition: the sport's template unless another is chosen.
  const own = templateFor(input.sport);
  const template = input.template ? templateByKey(input.template) : own.rules.performance ? templateByKey("custom") : own;
  if (!template || template.rules.performance) return ladderRefusal("LD_TEMPLATE", {}, 400);
  const parsed = parseRules(input.rules ?? null, template.rules);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
  if (parsed.rules.performance) return ladderRefusal("LD_TEMPLATE", {}, 400);
  // A ladder of teams: the games of a team match, as the sport's template has them and a team league's defaults for the rest.
  let team: TeamSettings | null = null;
  if (teams) {
    let rubbers: RubberKind[] = template.rubbers ? [...template.rubbers] : ["team"];
    if (input.team?.rubbers !== undefined) {
      const given = Array.isArray(input.team.rubbers) ? input.team.rubbers : [];
      if (given.length < 1 || given.length > MAX_RUBBERS || given.some((k) => !RUBBER_KINDS.includes(k)) || (given.includes("team") && given.length !== 1)) return ladderRefusal("LAD2_RUBBERS", { n: MAX_RUBBERS }, 400);
      rubbers = given;
    }
    // A challenge has to have a winner: an even number of games could end level.
    if (rubbers.length > 1 && rubbers.length % 2 === 0) return ladderRefusal("LAD2_RUBBERS_ODD", {}, 400);
    const whole = (v: unknown, lo: number, hi: number, fallback: number): number | null => (v === undefined || v === null || v === "" ? fallback : Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null);
    const rubberMinutes = whole(input.team?.rubberMinutes, 5, 300, template.matchMinutes);
    const rosterMin = whole(input.team?.rosterMin, 1, 40, Math.max(2, rubbers.includes("team") ? (template.roster?.min ?? 5) : 2));
    const rosterMax = whole(input.team?.rosterMax, 1, 40, rubbers.includes("team") ? (template.roster?.max ?? 14) : 12);
    const cap = whole(input.team?.maxRubbersPerPlayer, 1, 10, 2);
    if (rubberMinutes === null || rosterMin === null || rosterMax === null || cap === null || rosterMin > rosterMax) return ladderRefusal("LAD2_TEAM_NUMBERS", {}, 400);
    team = { rubbers, rubberMinutes, rosterMin, rosterMax, maxRubbersPerPlayer: cap };
  }
  const courtTime = input.courtTime ?? {};
  const courtIds = await courtsRefusal(input.venueId, input.sport, courtTime.courtIds ?? []);
  if (!Array.isArray(courtIds)) return courtIds;
  const matchMinutes = minutesOk(courtTime.minutes);
  if (typeof matchMinutes === "object" && matchMinutes !== null) return matchMinutes;
  const today = await venueToday(input.venueId);
  const s = parsedSettings.settings;
  let id = 0;
  await db.transaction(async () => {
    const info = await db
      .prepare(
        `INSERT INTO ladders (venue_id, name, sport, team_size, who, audience, level, description, rules, template, reach, respond_days, play_days, cooldown_days,
                              inactive_days, inactive_drop, freeze_max_days, decline_is, created_by, court_time_on, match_minutes, kind, rubbers, rubber_minutes,
                              roster_min, roster_max, max_rubbers_per_player)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.venueId,
        name,
        input.sport,
        teams ? 1 : input.teamSize === 2 ? 2 : 1,
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
        adminId,
        courtTime.on === true,
        matchMinutes,
        teams ? "teams" : "players",
        team ? JSON.stringify(team.rubbers) : null,
        team?.rubberMinutes ?? null,
        team?.rosterMin ?? null,
        team?.rosterMax ?? null,
        team?.maxRubbersPerPlayer ?? null
      );
    id = info.lastInsertRowid as number;
    for (const c of courtIds) await db.prepare("INSERT INTO ladder_courts (ladder_id, court_id) VALUES (?, ?)").run(id, c);
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

/**
 * A manager turns the venue's holding of court time for accepted challenges on or off, names the courts it may use and the minutes held
 * (their reason is in the log). It applies from now and never rewrites what was held or agreed: a hold already made runs its course.
 */
export async function changeCourtTime(ladderId: number, change: { on?: unknown; courtIds?: unknown; minutes?: unknown; needsConfirmation?: unknown }): Promise<LadderResult<Ladder>> {
  return withLadder(ladderId, async (ladder) => {
    const db = getDb();
    if (change.on !== undefined && typeof change.on !== "boolean") return ladderRefusal("LAD2_COURTS", {}, 400);
    if (change.needsConfirmation !== undefined && typeof change.needsConfirmation !== "boolean") return ladderRefusal("LAD2_COURTS", {}, 400);
    const courtIds = change.courtIds === undefined ? ladder.courtTime.courtIds : await courtsRefusal(ladder.venueId, ladder.sport, change.courtIds);
    if (!Array.isArray(courtIds)) return courtIds;
    const minutes = change.minutes === undefined ? ladder.courtTime.minutes : minutesOk(change.minutes);
    if (typeof minutes === "object" && minutes !== null) return minutes;
    await db.prepare("UPDATE ladders SET court_time_on = ?, match_minutes = ? WHERE id = ?").run((change.on as boolean | undefined) ?? ladder.courtTime.on, minutes, ladderId);
    // Whether a hold has to be confirmed applies to holds made from now on; a hold already made keeps the state it has.
    if (typeof change.needsConfirmation === "boolean") await db.prepare("UPDATE ladders SET needs_confirmation = ? WHERE id = ?").run(change.needsConfirmation, ladderId);
    await db.prepare("DELETE FROM ladder_courts WHERE ladder_id = ?").run(ladderId);
    for (const c of courtIds) await db.prepare("INSERT INTO ladder_courts (ladder_id, court_id) VALUES (?, ?)").run(ladderId, c);
    return { ok: true, value: (await ladderById(ladderId))! };
  });
}

/**
 * A manager sets the limits on held court time for a venue (`scope: "venue"`: every ladder of it without its own) or for this ladder (ADR 0048, ADR 0050): the most
 * holds live at once on a ladder, the most one player's challenges may have live at once (`maxActive`; `maxWeek` is its old name), and how many holds a player may
 * cancel themselves in the window before a pause applies to creating new ones (`maxCancelled`; `maxAbandoned` is its old name). Each is a number within the install's bounds (refused with
 * them, `LAD3_BOUNDS`), `null` to go back to the default above, or left out to stay. It applies to holds made from now on and never releases one, even if set
 * below what is in use. The route logs it with who, before and after, and the reason if given.
 */
export async function changeHoldLimits(
  ladderId: number,
  scope: "venue" | "ladder",
  change: { maxLive?: unknown; maxActive?: unknown; maxWeek?: unknown; maxCancelled?: unknown; maxAbandoned?: unknown }
): Promise<LadderResult<{ before: HoldLimitsView; after: HoldLimitsView }>> {
  return withLadder(ladderId, async (ladder) => {
    const done = await setHoldLimits(ladder, scope, change);
    if (!done.ok) return holdRefusal(done);
    return { ok: true, value: { before: done.before, after: done.after } };
  });
}

/** Run `fn` in a transaction under the ladder's row lock: nothing else changes the ladder meanwhile. */
export async function withLadder<T>(ladderId: number, fn: (ladder: Ladder, season: SeasonRow) => Promise<LadderResult<T>>): Promise<LadderResult<T>> {
  const freed: Freed[] = [];
  try {
    const done = await withTransaction(async () => {
      freed.length = 0;
      await getDb().prepare("SELECT id FROM ladders WHERE id = ? FOR UPDATE").get(ladderId);
      const ladder = await ladderById(ladderId);
      if (!ladder) return ladderRefusal("LD_NOT_FOUND", {}, 404);
      const season = await currentSeason(ladderId);
      if (!season) return ladderRefusal("LD_CLOSED");
      return freedStore.run(freed, () => fn(ladder, season));
    });
    // Court time a hold let go goes to whoever is waiting for it, once the change is committed.
    if (freed.length > 0) await offerFreed(freed);
    return done;
  } catch (err) {
    if (isBusy(err)) return ladderRefusal("LD_BUSY", {}, 503);
    throw err;
  }
}

type Freed = { courtId: number | null; date: string };
const freedStore = new AsyncLocalStorage<Freed[]>();

/** Let a challenge's hold go (if it has one), once, for `reason`; its court time is offered on afterwards (`withLadder`). */
export async function letGo(challengeId: number, reason: string, by: string | null = null, note: string | null = null, cancelledBy?: number): Promise<boolean> {
  const out = await releaseHold(challengeId, reason, by, note, cancelledBy);
  if (!out) return false;
  freedStore.getStore()?.push({ courtId: out.courtId, date: out.date });
  return true;
}

// ------------------------------------------------------------ writing the ledger

/** Rewrite the cached ranks of a season from the replay of its ledger. */
export async function settle(seasonId: number): Promise<ReplayRow[]> {
  const db = getDb();
  const ranks = await ranksOf(seasonId);
  await db.prepare("DELETE FROM ladder_ranks WHERE season_id = ?").run(seasonId);
  for (const r of ranks) await db.prepare("INSERT INTO ladder_ranks (season_id, player_id, rank, frozen_until, active_on) VALUES (?, ?, ?, ?, ?)").run(seasonId, r.playerId, r.rank, r.frozenUntil, r.activeOn);
  return ranks;
}

export async function addEvent(
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
export async function writeResult(
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
    if (ladder.kind === "teams") return ladderRefusal("LAD2_TEAMS_ONLY", {}, 403);
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
export async function myPlayer(userId: number, playerId: number): Promise<PlayerRow | null> {
  const row = (await getDb()
    .prepare(
      `SELECT lp.id, lp.ladder_id, lp.user_id, lp.team_id, lp.name, lp.participant_id, lp.contact_phone, lp.entered_by_name, lp.status
         FROM ladder_players lp LEFT JOIN participants p ON p.id = lp.participant_id LEFT JOIN teams tm ON tm.id = lp.team_id
        WHERE lp.id = ? AND lp.status = 'active'
          AND ((lp.user_id = ? AND (lp.participant_id IS NULL OR ${ACTS_FOR("p")})) OR (lp.team_id IS NOT NULL AND tm.captain_user_id = ? AND tm.status = 'active'))`
    )
    .get(playerId, userId, userId, userId, userId)) as PlayerRow | undefined;
  return row ?? null;
}

/** The places this account holds on a ladder (its own and those it holds for people it acts for). */
export async function myPlaces(userId: number, ladderId: number): Promise<MyPlace[]> {
  const ladder = await ladderById(ladderId);
  if (!ladder?.season) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT lp.id FROM ladder_players lp LEFT JOIN participants p ON p.id = lp.participant_id LEFT JOIN teams tm ON tm.id = lp.team_id
        WHERE lp.ladder_id = ? AND lp.status = 'active'
          AND ((lp.user_id = ? AND (lp.participant_id IS NULL OR ${ACTS_FOR("p")})) OR (lp.team_id IS NOT NULL AND tm.captain_user_id = ? AND tm.status = 'active')) ORDER BY lp.id`
    )
    .all(ladderId, userId, userId, userId, userId)) as { id: number }[];
  const out: MyPlace[] = [];
  for (const r of rows) out.push(await placeOf(ladder, r.id, userId));
  return out;
}

async function placeOf(ladder: Ladder, playerId: number, viewerId: number): Promise<MyPlace> {
  const db = getDb();
  const season = ladder.season!;
  const people = await playersOf(ladder.id);
  const names = new Map([...people].map(([id, p]) => [id, p.shown]));
  // Their own place, or their child's, is shown by the name it was entered under; everybody else by the rule.
  const own = people.get(playerId);
  if (own) names.set(playerId, own.name);
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
  const open: MyPlace["open"] = [];
  const holdsOf = await holdViews(challenges.map((c) => c.id));
  for (const c of challenges.filter((x) => OPEN.includes(x.status))) {
    const otherId = c.challenger === playerId ? c.challenged : c.challenger;
    const other = people.get(otherId);
    // An adult ladder's accepted challenge shows the other side's number, for arranging it, to them alone; a junior ladder's never.
    let contact: { name: string; phone: string; whatsapp: string } | null = null;
    if (ladder.audience === "adults" && other && c.status !== "pending") {
      const phone = ((await db.prepare("SELECT COALESCE(u.phone, ?) AS phone FROM (SELECT 1) x LEFT JOIN users u ON u.id = ?").get(other.contact_phone, other.user_id ?? other.captain_user_id ?? null)) as { phone: string | null }).phone;
      if (phone) contact = { name: names.get(otherId) ?? "", phone, whatsapp: toWhatsAppNumber(phone) };
    }
    open.push({ ...toChallenge(c, names, false, holdsOf), contact, booking: null });
  }
  // The ordinary booking each challenge carries, if its players attached one (`attachBooking`); nothing about it is held by the ladder.
  const carried = await liveBookings(challenges.map((c) => c.id));
  for (const o of open) o.booking = carried.get(o.id) ?? null;
  const history = challenges.filter((x) => !OPEN.includes(x.status)).slice(0, 20).map((c) => ({ ...toChallenge(c, names, false, holdsOf), booking: carried.get(c.id) ?? null }));
  // A ladder of teams: the games and the lineups this captain may see, and the forfeit requests on their challenges.
  if (ladder.kind === "teams") {
    const ids = [...open.map((o) => o.id), ...history.map((h) => h.id)];
    const teams = await (await import("./team-ladders")).teamViews(ladder, ids, { userId: viewerId });
    const requests = await (await import("./team-forfeits")).ladderForfeitRequests(ids, { forStaff: false, viewerId });
    for (const c of [...open, ...history]) {
      if (teams.has(c.id)) c.team = teams.get(c.id);
      if (requests.has(c.id)) c.forfeitRequests = requests.get(c.id);
    }
  }
  return {
    playerId,
    name: names.get(playerId) ?? "",
    participantId: people.get(playerId)?.participant_id ?? null,
    rank: me?.rank ?? null,
    frozenUntil: me?.frozenUntil ?? null,
    targets,
    open,
    history,
    bookingPage: `/venue/${ladder.venueId}?sport=${ladder.sport}`,
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
export async function cancelOpenFor(ladder: Ladder, season: SeasonRow, playerId: number, why: "left" | "frozen" | "season"): Promise<void> {
  const db = getDb();
  const today = await venueToday(ladder.venueId);
  const open = (await db.prepare(`SELECT * FROM ladder_challenges WHERE season_id = ? AND (challenger = ? OR challenged = ?) AND status IN (${OPEN_SQL})`).all(season.id, playerId, playerId)) as ChallengeRow[];
  for (const c of open) {
    await db.prepare("UPDATE ladder_challenges SET status = 'cancelled', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, c.id);
    await letGo(c.id, why);
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
    // On a ladder that holds court time the proposal is recorded neutrally, and a fully specified one is its maker's agreement to that exact specification (ADR 0051).
    if (ladder.courtTime.on && when.on) {
      if (when.min !== null) await recordAgreement(ladder, made.id, mine, "proposed", Number(made.proposal_rev ?? 1), when.on, when.min);
      await eventOf(ladder, made.id, "proposed", mine, { rev: Number(made.proposal_rev ?? 1), date: when.on, startMin: when.min });
    }
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

export const fmtMin = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The challenge, its ladder and the season it was in, with the places the account holds in it. */
export async function challengeFor(userId: number, challengeId: number): Promise<{ ch: ChallengeRow; myId: number } | null> {
  const ch = (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(challengeId)) as ChallengeRow | undefined;
  if (!ch) return null;
  const mine = (await myPlayer(userId, ch.challenger)) ? ch.challenger : (await myPlayer(userId, ch.challenged)) ? ch.challenged : null;
  // An account on both sides (a guardian whose two children play each other) answers for neither: staff decide that one.
  if (mine === null || ((await myPlayer(userId, ch.challenger)) && (await myPlayer(userId, ch.challenged)))) return null;
  return { ch, myId: mine };
}

export const stale = (c: ChallengeRow, expected: { version?: number }) => expected.version !== undefined && expected.version !== Number(c.version);
export const changedRefusal = () => ladderRefusal("LD_CHANGED");

/** What an act says it saw: the challenge's `version` (any change), the `rev` of the proposal it answers (ADR 0051), and the court it was shown. */
export type Expected = { version?: number; rev?: number; courtId?: number };

/**
 * An act that answers a proposal names the revision it saw (ADR 0051). One for a revision that is no longer current is refused (`LAD5_STALE`) with the current proposal
 * returned, so the page shows it again: nothing is agreed, merged or held, and a superseded proposal can never be accepted. Checked under the ladder's lock.
 */
export async function staleRevision(ladder: Ladder, ch: ChallengeRow, expected: { rev?: number }): Promise<LadderRefusal | null> {
  if (expected.rev === undefined || expected.rev === Number(ch.proposal_rev ?? 1)) return null;
  return { ...ladderRefusal("LAD5_STALE"), challenge: await viewOf(ladder, ch.id) };
}

/**
 * The API asks for the revision on every act that answers a proposal, on a ladder that holds court time (ADR 0051): without one the act is refused (`LAD5_REV_NEEDED`, 400),
 * never taken as "current", since that could be a stale acceptance. On a ladder that holds no court the optional `version` stays the only check, as before.
 */
export async function revisionNeeded(userId: number, challengeId: number, rev: unknown): Promise<LadderRefusal | null> {
  if (typeof rev === "number" && Number.isInteger(rev)) return null;
  // Only a player on the challenge is told anything about it: anybody else gets the answer they always did (not found).
  if (!(await challengeFor(userId, challengeId))) return null;
  const row = await getDb().prepare("SELECT 1 FROM ladder_challenges c JOIN ladders l ON l.id = c.ladder_id WHERE c.id = ? AND l.court_time_on").get(challengeId);
  return row ? ladderRefusal("LAD5_REV_NEEDED", {}, 400) : null;
}

/** A proposal nobody answered by its last day (the challenge's response window) cannot be accepted or countered any more (ADR 0051). The ladder's own no-response outcomes are unchanged. */
const proposalLapsed = (ladder: Ladder, ch: ChallengeRow, today: string): LadderRefusal | null =>
  ladder.courtTime.on && ch.status === "pending" && ch.respond_by !== null && today > ch.respond_by ? ladderRefusal("LAD5_EXPIRED", { date: ch.respond_by }) : null;

/** The neutral record (ADR 0051), kept only where the venue holds court time. A proposal never reserves capacity; only a hold does. */
async function eventOf(
  ladder: Pick<Ladder, "id" | "courtTime">,
  challengeId: number,
  kind: string,
  placeId: number | null,
  more: { rev?: number | null; date?: string | null; startMin?: number | null; reservedCapacity?: boolean; note?: string | null; byName?: string | null } = {}
): Promise<void> {
  if (!ladder.courtTime.on) return;
  await recordEvent({ ladderId: ladder.id, challengeId, placeId, kind, minutes: ladder.courtTime.matchMinutes, ...more });
}

/** What a player agreed when they made a proposal: the exact day, start and minutes, with no hold behind it until the other accepts (`ladder_agreed_times`). */
async function recordAgreement(ladder: Pick<Ladder, "courtTime">, challengeId: number, placeId: number, role: "proposed" | "countered", rev: number, on: string, min: number): Promise<void> {
  await getDb()
    .prepare("INSERT INTO ladder_agreed_times (held_id, challenge_id, player_id, role, date, start_min, minutes, court_id, rev) VALUES (NULL, ?, ?, ?, ?, ?, ?, NULL, ?)")
    .run(challengeId, placeId, role, on, min, ladder.courtTime.matchMinutes, rev);
}

/** A material change (the day, start or minutes) ends every agreement recorded for the earlier specification: kept as history, flagged, and never counted toward a hold. */
async function supersedeAgreements(challengeId: number, reason: string): Promise<void> {
  await getDb().prepare("UPDATE ladder_agreed_times SET superseded_at = now(), superseded_reason = ? WHERE challenge_id = ? AND held_id IS NULL AND superseded_at IS NULL").run(reason, challengeId);
}

/** The agreement on record for the proposal now open (its maker's, at this revision), if there is one: none for a challenge already in flow when revisions began. */
async function openAgreement(challengeId: number, placeId: number, rev: number): Promise<{ role: string; minutes: number } | undefined> {
  return (await getDb()
    .prepare("SELECT role, minutes FROM ladder_agreed_times WHERE challenge_id = ? AND player_id = ? AND rev = ? AND held_id IS NULL AND superseded_at IS NULL ORDER BY id DESC LIMIT 1")
    .get(challengeId, placeId, rev)) as { role: string; minutes: number } | undefined;
}

export async function lockedChallenge(challengeId: number): Promise<ChallengeRow | undefined> {
  return (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ? FOR UPDATE").get(challengeId)) as ChallengeRow | undefined;
}

export async function viewOf(ladder: Ladder, challengeId: number): Promise<ChallengeView> {
  const people = await playersOf(ladder.id);
  const row = (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(challengeId)) as ChallengeRow;
  return toChallenge(row, new Map([...people].map(([id, p]) => [id, p.shown])), false, await holdViews([challengeId]));
}

export type Answer =
  | { accept: true; onDate?: string; minute?: number; courtId?: number }
  | { decline: true }
  | { propose: true; onDate: string; minute?: number };

/**
 * A new proposal: the day (and start) one player asks for in answer to the other's, whether by `propose` or by accepting with a time of their own (ADR 0051). It is the
 * proposer's recorded agreement to that exact specification when it is fully specified, **reserves nothing and holds no court**, replaces the proposal before it (a new
 * revision, which ends every agreement recorded for the earlier one), and waits for the other player's explicit acceptance of exactly it.
 */
async function newProposal(ladder: Ladder, ch: ChallengeRow, mineId: number, other: number, me: string, on: string, min: number | null, today: string): Promise<void> {
  const db = getDb();
  const next = Number(ch.proposal_rev ?? 1) + 1;
  if (ladder.courtTime.on) await supersedeAgreements(ch.id, "a newer proposal replaced it");
  await db
    .prepare(
      `UPDATE ladder_challenges SET proposed_on = ?, proposed_min = ?, proposed_by = ?, awaiting = ?, respond_by = ?, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?`
    )
    .run(on, min, mineId, mineId === ch.challenged ? "challenger" : "challenged", addDays(today, ladder.settings.respondDays), ch.id);
  const full = ladder.courtTime.on && min !== null;
  if (full) await recordAgreement(ladder, ch.id, mineId, "countered", next, on, min!);
  await eventOf(ladder, ch.id, "countered", mineId, { rev: next, date: on, startMin: min });
  await tellPlayer(
    other,
    ladder,
    (tr) => tr("ld.mail.answered.s", { l: ladder.name, a: me }),
    (tr) =>
      sentences(
        tr,
        tr("ld.mail.answered.b", { l: ladder.name, a: me, what: tr("ld.ans.proposed", { date: on, time: min === null ? "" : fmtMin(min) }) }),
        full && tr("lad5.mail.counter", { name: me, minutes: ladder.courtTime.matchMinutes })
      )
  );
}

/**
 * The player whose answer a challenge waits for accepts (optionally agreeing a day), declines, or proposes a time, which
 * hands the answer to the other side. Accepting starts the time to play it. A decline is free, or a forfeit, as the
 * ladder's setting says.
 *
 * On a ladder that holds court time (ADR 0051) naming a **different, fully specified time** in answer to a proposal, by `propose` or by accepting with a time of one's
 * own, is a counter-proposal: it is that player's agreement to that exact specification, it holds no court, and the other player must explicitly accept exactly it (the
 * hold is then made confirmed, once; the counter's maker is not asked again). Every proposal has a revision; an act names the one it answers (`expected.rev`) and a
 * superseded proposal can never be accepted (`LAD5_STALE`); a proposal past its last day cannot be accepted (`LAD5_EXPIRED`). A player in a pause on new holds can still
 * accept: the challenge is accepted and no court is held.
 */
export async function answer(userId: number, challengeId: number, input: Answer, expected: Expected = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    const lateRev = await staleRevision(ladder, ch, expected);
    if (lateRev) return lateRev;
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
      if (ladder.courtTime.on) {
        await supersedeAgreements(ch.id, "declined");
        await eventOf(ladder, ch.id, "declined", mineId, { rev: Number(ch.proposal_rev ?? 1) });
      }
    } else if ("propose" in input) {
      const when = proposal(input, today);
      if (!when.ok) return when.refusal;
      if (!when.on) return ladderRefusal("LD_TIME", {}, 400);
      const lapsed = proposalLapsed(ladder, ch, today);
      if (lapsed) return lapsed;
      if (ladder.courtTime.on && when.min !== null && when.on > addDays(today, ladder.settings.playDays)) return ladderRefusal("LAD2_AFTER", { date: addDays(today, ladder.settings.playDays) });
      await newProposal(ladder, ch, mineId, other, me, when.on, when.min, today);
    } else {
      const when = proposal(input, today);
      if (!when.ok) return when.refusal;
      const lapsed = proposalLapsed(ladder, ch, today);
      if (lapsed) return lapsed;
      // Accepting a time the other side proposed agrees it; accepting with a day of their own sets that. A fully specified time one player proposed and the other
      // accepts unchanged is both players' agreement to it (`proposer`, ADR 0050); a different, fully specified time the accepter names is their counter-proposal (ADR 0051).
      const t = acceptedTime(ch, mineId, when);
      const { on, min, proposer } = t;
      if (ladder.courtTime.on && when.on && min !== null && proposer === null) {
        if (on! > addDays(today, ladder.settings.playDays)) return ladderRefusal("LAD2_AFTER", { date: addDays(today, ladder.settings.playDays) });
        await newProposal(ladder, ch, mineId, other, me, on!, min, today);
        return { ok: true, value: await viewOf(ladder, ch.id) };
      }
      // What the proposer agreed is on record (ADR 0051), or, for a challenge already in flow before revisions, is taken from the challenge as before.
      let agreement: { proposer: number; accepter: number; rev?: number; role?: "proposed" | "countered" } | undefined;
      if (proposer !== null && ladder.courtTime.on && on && min !== null) {
        const row = await openAgreement(ch.id, proposer, Number(ch.proposal_rev ?? 1));
        if (row && row.minutes !== ladder.courtTime.matchMinutes) {
          // The match length changed after this time was proposed: what its maker agreed is not what would be held. The proposal ends, nobody's agreement is reused.
          await supersedeAgreements(ch.id, "the match length changed");
          await db.prepare("UPDATE ladder_challenges SET proposed_on = NULL, proposed_min = NULL, proposed_by = NULL, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(ch.id);
          await eventOf(ladder, ch.id, "superseded", null, { rev: Number(ch.proposal_rev ?? 1), date: on, startMin: min, note: "the match length changed" });
          return ladderRefusal("LAD5_TERMS");
        }
        agreement = { proposer, accepter: mineId, ...(row ? { rev: Number(ch.proposal_rev ?? 1), role: row.role === "countered" ? ("countered" as const) : ("proposed" as const) } : {}) };
      } else if (proposer !== null) agreement = { proposer, accepter: mineId };
      // A ladder that holds court time holds a court once a day and time are agreed (a day alone is not a time): refused, with the reason and
      // nothing changed, if nothing is free, so a challenge is never accepted without the court it was promised. The court is the one the accepter was shown, if they
      // were: it is held or nothing is (`LAD4_COURT_CHANGED`). A player in a pause on creating new holds still accepts the invitation to play: nothing is held for them (ADR 0051).
      let held: HoldView | null = null;
      let noHold = false;
      if (ladder.courtTime.on && on && min !== null) {
        if (on > addDays(today, ladder.settings.playDays)) return ladderRefusal("LAD2_AFTER", { date: addDays(today, ladder.settings.playDays) });
        const made = await holdFor(ladder, ch, on, min, people, { kind: "players", placeId: mineId }, { agreement, expectCourtId: input.courtId });
        if (!made.ok) {
          if (made.code !== "LAD5_PAUSED") return made;
          noHold = true;
        } else held = made.hold;
      }
      const confirmBy = await confirmByText(ladder.venueId, held);
      await db
        .prepare(
          `UPDATE ladder_challenges SET status = 'accepted', agreed_on = ?, agreed_min = ?, play_by = ?, respond_by = NULL, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?`
        )
        .run(on, min, addDays(today, ladder.settings.playDays), ch.id);
      if (ladder.courtTime.on) {
        if (!held) await supersedeAgreements(ch.id, "accepted with no court held");
        await eventOf(ladder, ch.id, "accepted", mineId, { rev: Number(ch.proposal_rev ?? 1), date: on, startMin: min, reservedCapacity: held !== null });
        if (held) await eventOf(ladder, ch.id, "held", mineId, { rev: Number(ch.proposal_rev ?? 1), date: held.date, startMin: held.startMin, reservedCapacity: true });
      }
      await tellPlayer(
        other,
        ladder,
        (tr) => tr("ld.mail.answered.s", { l: ladder.name, a: me }),
        (tr) =>
          sentences(
            tr,
            tr("ld.mail.answered.b", {
              l: ladder.name,
              a: me,
              what: tr(on ? "ld.ans.acceptedOn" : "ld.ans.accepted", { date: on ?? "", time: min === null ? "" : fmtMin(min), by: addDays(today, ladder.settings.playDays) }),
            }),
            held && tr("lad2.mail.held", { court: held.court, date: held.date, time: fmtMin(held.startMin) }),
            held?.agreed && tr("lad4.mail.agreed", { name: me, minutes: ladder.courtTime.matchMinutes }),
            noHold && tr("lad5.mail.noHold"),
            confirmBy && tr("lad3.mail.confirmBy", { by: confirmBy })
          )
      );
    }
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/** The challenger withdraws a challenge not yet played: no effect on anybody's rank. */
export async function withdraw(userId: number, challengeId: number, expected: Expected = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found || found.myId !== found.ch.challenger) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder) => {
    const ch = await lockedChallenge(challengeId);
    if (!ch) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    const lateRev = await staleRevision(ladder, ch, expected);
    if (lateRev) return lateRev;
    if (stale(ch, expected)) return changedRefusal();
    if (ch.status !== "pending" && ch.status !== "accepted") return ladderRefusal("LD_NOT_AWAITING");
    await getDb().prepare("UPDATE ladder_challenges SET status = 'cancelled', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(await venueToday(ladder.venueId), ch.id);
    // A hold that really reserved court capacity and its player cancels, in whatever state it was, is their own cancellation (ADR 0051): the one thing the anti-abuse pause
    // counts. A proposal that never reserved a court and is withdrawn is only recorded, neutrally.
    const cancelled = await letGo(ch.id, "withdrawn", null, null, found.myId);
    if (ladder.courtTime.on) {
      await supersedeAgreements(ch.id, "withdrawn");
      await eventOf(ladder, ch.id, cancelled ? "cancelled" : "withdrawn", found.myId, { rev: Number(ch.proposal_rev ?? 1), reservedCapacity: cancelled });
    }
    if (cancelled) await notePause(ladder, found.myId);
    const people = await playersOf(ladder.id);
    await tellEnd(ladder, ch.challenged, (people.get(ch.challenger)?.shown ?? ""), "withdrawn");
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

type EndWhat = "left" | "frozen" | "season" | "declined" | "declinedForfeit" | "withdrawn" | "ignored" | "lapsed" | "notPlayed";

export async function tellEnd(ladder: Ladder, toPlayer: number, who: string, what: EndWhat): Promise<void> {
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
  await letGo(ch.id, "forfeited");
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
    if (ladder.kind === "teams") return ladderRefusal("LAD2_TEAM_REPORT", {}, 400);
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
export async function standResult(ladder: Ladder, season: SeasonRow, ch: ChallengeRow, today: string): Promise<void> {
  await getDb().prepare("UPDATE ladder_challenges SET status = 'confirmed', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, ch.id);
  await letGo(ch.id, "played");
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
export type Decision = { winner: number; score?: string; walkover?: boolean } | { rubbers: unknown } | { void: true } | { clear: true };

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
      await letGo(ch.id, "void", by.name, why);
      await db.prepare("DELETE FROM ladder_challenge_rubbers WHERE challenge_id = ?").run(ch.id);
    } else if ("clear" in decision) {
      await db
        .prepare("UPDATE ladder_challenges SET status = 'accepted', winner = NULL, score = NULL, forfeit = false, reported_by = NULL, reported_at = NULL, dispute_note = NULL, play_by = ?, resolved_on = NULL, decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?")
        .run(addDays(today, ladder.settings.playDays), by.adminId, ch.id);
      await writeResult(ladder.id, season.id, ch, null, today, { reason: why, by: by.name });
      await letGo(ch.id, "cleared", by.name, why);
      await db.prepare("DELETE FROM ladder_challenge_rubbers WHERE challenge_id = ?").run(ch.id);
    } else {
      // A ladder of teams is decided by its games (the team league's checks and its winner); a walkover is a forfeit, given as one.
      let given: { winner: number; score?: string | null; walkover?: boolean };
      let teamGames: Awaited<ReturnType<typeof import("./team-ladders").teamOutcome>> | null = null;
      if ("rubbers" in decision) {
        const teams = await import("./team-ladders");
        teamGames = teams.teamOutcome(ladder, ch, decision.rubbers);
        if (!teamGames.ok) return teamGames;
        given = teamGames.value.walkover ? { winner: teamGames.value.winner, walkover: true } : { winner: teamGames.value.winner, score: teamGames.value.score };
      } else {
        if (ladder.kind === "teams" && !decision.walkover) return ladderRefusal("LAD2_TEAM_REPORT", {}, 400);
        given = decision;
      }
      if (given.winner !== ch.challenger && given.winner !== ch.challenged) return ladderRefusal("LD_WINNER", {}, 400);
      const score = given.score?.trim() || null;
      if (score) {
        const wrong = teamGames ? null : checkScore(given.winner === ch.challenger, score, ladder.rules.scoring);
        if (wrong) return { ok: false, error: wrong, status: 400 };
      } else if (!given.walkover) return ladderRefusal("LD_SCORE_OR_WALKOVER", {}, 400);
      await db
        .prepare("UPDATE ladder_challenges SET status = ?, winner = ?, score = ?, forfeit = ?, resolved_on = COALESCE(resolved_on, ?), decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?")
        .run(score ? "confirmed" : "walkover", given.winner, score, !score, today, by.adminId, ch.id);
      if (teamGames?.ok && !teamGames.value.walkover && ladder.team) await (await import("./team-ladders")).writeRubbers(ch.id, ladder.team.rubbers, teamGames.value.checked);
      else if (!score) await db.prepare("DELETE FROM ladder_challenge_rubbers WHERE challenge_id = ?").run(ch.id);
      const fresh = (await db.prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(ch.id)) as ChallengeRow;
      await writeResult(ladder.id, season.id, fresh, { challengerWon: given.winner === ch.challenger, forfeit: !score }, fresh.resolved_on ?? today, { reason: why, by: by.name });
      await letGo(ch.id, score ? "played" : "forfeited", by.name, why);
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
      await letGo(c.id, "season");
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
  // A booking cancelled by a path that did not say so: the attachment goes, the players are told (idempotent).
  await dropCancelledBookings();
  // A hold nobody confirmed in time is let go, and both sides told once (ADR 0048); the claim path lets it go too whenever it is in the way.
  await tellExpiredHolds();
  // Court time a hold lost (a court taken out of service lets go of the blocks on it): the hold is marked lost, once, and both sides are told.
  await tellLostHolds();
  // A forfeit asked for on a ladder of teams: closed once the challenge ended another way, expired after 14 days (lib/team-forfeits.ts).
  await (await import("./team-forfeits")).housekeepLadderForfeits();
  const total = { confirmed: 0, forfeited: 0, lapsed: 0, thawed: 0, dropped: 0 };
  const ladders = (await db.prepare("SELECT id FROM ladders WHERE status = 'open' ORDER BY id").all()) as { id: number }[];
  for (const l of ladders) {
    const done = await withLadder(l.id, async (ladder, season) => {
      const out = { confirmed: 0, forfeited: 0, lapsed: 0, thawed: 0, dropped: 0 };
      const today = await venueToday(ladder.venueId);
      const open = (await db.prepare(`SELECT * FROM ladder_challenges WHERE season_id = ? AND status IN (${OPEN_SQL}) ORDER BY id`).all(season.id)) as ChallengeRow[];
      const people = await playersOf(ladder.id);
      // A request to move the time that nobody answered by its last day ends (ADR 0051): nothing changes, nobody is blamed, both are told once, and either can ask again.
      for (const c of open) {
        if (c.status !== "accepted" || !c.move_on || c.move_respond_by === null || c.move_respond_by === undefined || today <= c.move_respond_by) continue;
        const done = await db
          .prepare("UPDATE ladder_challenges SET move_on = NULL, move_min = NULL, move_by = NULL, move_respond_by = NULL, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ? AND move_on IS NOT NULL")
          .run(c.id);
        if (done.changes !== 1) continue;
        await supersedeAgreements(c.id, "no response");
        await eventOf(ladder, c.id, "no_response", c.move_by ?? null, { rev: Number(c.proposal_rev ?? 1), date: c.move_on, startMin: c.move_min ?? null, note: "the request to move the time was not answered in time" });
        for (const id of [c.challenger, c.challenged]) await tellPlayer(id, ladder, (tr) => tr("lad5.mail.moveLapsed.s", { l: ladder.name }), (tr) => tr("lad5.mail.moveLapsed.b", { l: ladder.name, date: c.move_on!, time: fmtMin(c.move_min ?? 0) }));
      }
      for (const c of open) {
        if (c.status === "pending" && c.respond_by !== null && today > c.respond_by) await eventOf(ladder, c.id, "no_response", null, { rev: Number(c.proposal_rev ?? 1), date: c.proposed_on, startMin: c.proposed_min, note: "the challenge was not answered in time" });
        if (c.status === "reported" && c.reported_at !== null && c.reported_at < (await daysAgo(CONFIRM_DAYS))) {
          await standResult(ladder, season, c, today);
          out.confirmed++;
        } else if (c.status === "pending" && c.respond_by !== null && today > c.respond_by) {
          // A challenge nobody on a ladder of teams answered lapses with no effect: a forfeit changes the ranks, and on a team ladder
          // giving one is a manager's (the captain asks for it), as in a team league.
          if (c.awaiting === "challenged" && ladder.kind !== "teams") {
            await decideForfeit(ladder, season, c, true, today, { reason: "ignored", by: "" });
            await tellEnd(ladder, c.challenger, (people.get(c.challenged)?.shown ?? ""), "ignored");
            out.forfeited++;
          } else {
            await db.prepare("UPDATE ladder_challenges SET status = 'lapsed', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, c.id);
            await letGo(c.id, "lapsed");
            await tellEnd(ladder, c.awaiting === "challenged" ? c.challenger : c.challenged, (people.get(c.awaiting === "challenged" ? c.challenged : c.challenger)?.shown ?? ""), "lapsed");
            out.lapsed++;
          }
        } else if (c.status === "accepted" && c.play_by !== null && today > c.play_by) {
          await db.prepare("UPDATE ladder_challenges SET status = 'lapsed', resolved_on = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(today, c.id);
          await letGo(c.id, "notPlayed");
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

// ------------------------------------------------------------ the booking a challenge carries

/**
 * A ladder challenge holds no court time: creating, accepting, proposing a time, reporting or withdrawing writes no block, claim or
 * booking (tests/ladder-court-time.test.ts counts them). Once the two have agreed a time they book as anybody does, through the
 * venue's own booking page with all its availability, pricing, payment and eligibility checks; only a confirmed booking reserves the
 * court. Either player may then **attach that booking's code** to the challenge so both see it ("Court booked: Court 2, 19:00"). Attaching
 * changes nothing about the booking (no hold, no price, no new path); if the booking is cancelled the attachment is dropped and both are told.
 */
export interface ChallengeBooking {
  code: string;
  court: string;
  date: string;
  startMin: number;
  endMin: number;
}

async function liveBookings(challengeIds: number[]): Promise<Map<number, ChallengeBooking>> {
  const out = new Map<number, ChallengeBooking>();
  if (challengeIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT x.challenge_id, b.code, c.name AS court, b.date, b.start_min, b.end_min
         FROM ladder_challenge_bookings x JOIN bookings b ON b.id = x.booking_id JOIN courts c ON c.id = b.court_id
        WHERE x.dropped_at IS NULL AND b.status = 'confirmed' AND x.challenge_id IN (${challengeIds.map(() => "?").join(",")})`
    )
    .all(...challengeIds)) as { challenge_id: number; code: string; court: string; date: string; start_min: number; end_min: number }[];
  for (const r of rows) out.set(r.challenge_id, { code: r.code, court: r.court, date: r.date, startMin: r.start_min, endMin: r.end_min });
  return out;
}

/**
 * Either of the two players adds the booking they made (or the other made) to an accepted challenge: by its code, which must be a confirmed
 * booking of this ladder's venue and sport, today or later, made through the account of one of the two players, and not on another
 * challenge. A code that is nobody's of these two is answered as not found, whatever else is true of it. The booking's row is locked while
 * it is read, so a cancellation cannot slip between the look and the attachment.
 */
export async function attachBooking(userId: number, challengeId: number, code: unknown): Promise<LadderResult<ChallengeBooking>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  const typed = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (typed.length < 3 || typed.length > 40) return ladderRefusal("LD_BK_NOT_FOUND", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (ch.status !== "accepted") return ladderRefusal("LD_BK_NOT_OPEN");
    if (await db.prepare("SELECT 1 FROM ladder_challenge_bookings WHERE challenge_id = ? AND dropped_at IS NULL").get(ch.id)) return ladderRefusal("LD_BK_HAVE");
    const b = (await db
      .prepare(
        `SELECT b.id, b.user_id, b.status, b.date, b.sport, b.class_id, b.code, b.start_min, b.end_min, c.name AS court, c.venue_id
           FROM bookings b JOIN courts c ON c.id = b.court_id WHERE UPPER(b.code) = ? FOR UPDATE OF b`
      )
      .get(typed)) as { id: number; user_id: number | null; status: string; date: string; sport: string; class_id: number | null; code: string; start_min: number; end_min: number; court: string; venue_id: number } | undefined;
    const accounts = (await db
      .prepare("SELECT COALESCE(lp.user_id, t.captain_user_id) AS user_id FROM ladder_players lp LEFT JOIN teams t ON t.id = lp.team_id WHERE lp.id IN (?, ?)")
      .all(ch.challenger, ch.challenged)) as { user_id: number | null }[];
    if (!b || b.user_id === null || !accounts.some((a) => a.user_id === b.user_id)) return ladderRefusal("LD_BK_NOT_FOUND", {}, 404);
    if (b.status !== "confirmed" || b.date < (await venueToday(ladder.venueId))) return ladderRefusal("LD_BK_STATE");
    if (b.venue_id !== ladder.venueId) return ladderRefusal("LD_BK_VENUE");
    if (b.sport !== ladder.sport || b.class_id !== null) return ladderRefusal("LD_BK_SPORT");
    if (await db.prepare("SELECT 1 FROM ladder_challenge_bookings WHERE booking_id = ? AND dropped_at IS NULL").get(b.id)) return ladderRefusal("LD_BK_TAKEN");
    await db.prepare("INSERT INTO ladder_challenge_bookings (challenge_id, booking_id, attached_by) VALUES (?, ?, ?)").run(ch.id, b.id, found.myId);
    // The booking is the court time: no second court is kept for the same match.
    await letGo(ch.id, "booking");
    await db.prepare("UPDATE ladder_challenges SET move_on = NULL, move_min = NULL, move_by = NULL WHERE id = ?").run(ch.id);
    const other = found.myId === ch.challenger ? ch.challenged : ch.challenger;
    const people = await playersOf(ladder.id);
    const me = shown(ladder, people.get(found.myId)?.name ?? "");
    const what = { court: b.court, date: b.date, time: fmtMin(b.start_min) };
    await tellPlayer(other, ladder, (tr) => tr("ofc1.lb.mail.attached.s", { l: ladder.name }), (tr) => tr("ofc1.lb.mail.attached.b", { l: ladder.name, a: me, ...what }));
    return { ok: true, value: { code: b.code, court: b.court, date: b.date, startMin: b.start_min, endMin: b.end_min } };
  });
}

/** Either player takes the booking off the challenge. The booking itself is untouched. */
export async function detachBooking(userId: number, challengeId: number): Promise<LadderResult<null>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async () => {
    const done = await getDb()
      .prepare("UPDATE ladder_challenge_bookings SET dropped_at = datetime('now'), dropped_reason = 'removed' WHERE challenge_id = ? AND dropped_at IS NULL")
      .run(challengeId);
    if (done.changes !== 1) return ladderRefusal("LD_BK_NONE");
    return { ok: true, value: null };
  });
}

/**
 * The booking under a challenge was cancelled: the attachment is dropped, once, and both players told that the challenge stands and a court is to
 * be booked again. Called where a booking is cancelled (lib/store.ts) and by the scheduler for any path that did not; running it again changes nothing.
 */
export async function ladderBookingCancelled(bookingId: number): Promise<void> {
  const dropped = (await getDb()
    .prepare("UPDATE ladder_challenge_bookings SET dropped_at = datetime('now'), dropped_reason = 'cancelled' WHERE booking_id = ? AND dropped_at IS NULL RETURNING challenge_id")
    .all(bookingId)) as { challenge_id: number }[];
  for (const d of dropped) {
    const ch = (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(d.challenge_id)) as ChallengeRow | undefined;
    const ladder = ch ? await ladderById(ch.ladder_id) : null;
    if (!ch || !ladder) continue;
    for (const id of [ch.challenger, ch.challenged])
      await tellPlayer(id, ladder, (tr) => tr("ofc1.lb.mail.dropped.s", { l: ladder.name }), (tr) => tr("ofc1.lb.mail.dropped.b", { l: ladder.name }));
  }
}

async function dropCancelledBookings(): Promise<void> {
  const rows = (await getDb()
    .prepare("SELECT DISTINCT x.booking_id FROM ladder_challenge_bookings x JOIN bookings b ON b.id = x.booking_id WHERE x.dropped_at IS NULL AND b.status <> 'confirmed'")
    .all()) as { booking_id: number }[];
  for (const r of rows) await ladderBookingCancelled(r.booking_id);
}

// ------------------------------------------------------------ court time held for an accepted challenge

const holdRefusal = (r: HoldRefusal): LadderRefusal => ladderRefusal(r.code, r.vars, r.code === "LAD3_BOUNDS" ? 400 : 409);

/**
 * What accepting a challenge agrees (ADR 0050): the day and time, and who proposed them when the accepter takes them unchanged. A fully specified time (a day and a
 * start) that the other player proposed and this one accepts, with nothing of their own, is both players' agreement to it (`proposer` is the one who proposed it).
 * A day alone is not a time; a time the accepter names themselves is a counter-proposal the proposer has not agreed, so `proposer` is null and the hold is tentative.
 */
export function acceptedTime(
  ch: Pick<ChallengeRow, "proposed_on" | "proposed_min" | "proposed_by">,
  mineId: number,
  when: { on: string | null; min: number | null }
): { on: string | null; min: number | null; proposer: number | null } {
  const proposedByOther = ch.proposed_by !== null && ch.proposed_by !== mineId;
  const on = when.on ?? (proposedByOther ? ch.proposed_on : null);
  const min = when.on ? when.min : on === ch.proposed_on ? ch.proposed_min : null;
  const unchanged = proposedByOther && on !== null && min !== null && on === ch.proposed_on && min === ch.proposed_min;
  return { on, min, proposer: unchanged ? ch.proposed_by : null };
}

/**
 * Hold a court for a challenge at an agreed day and time (inside the ladder's transaction), labelled for the schedule.
 *
 * Agreement (ADR 0050): `agreement` names the two places that agreed this exact time, and the hold is made confirmed with each one's agreement kept. Without it a hold
 * is tentative on a ladder that asks for confirmation, whoever made it: a counter-proposal, and a time a manager chose, are not both players' agreement. A manager's
 * move that changes nothing material (the day, the start, the minutes and the court, so only a reminder or an extension) keeps the agreement the hold had; any other
 * change by a manager is tentative again and keeps what it replaced (`changedFrom`), so both players are told what changed and each confirms the new specification.
 * `expectCourtId` is the court the player was shown, held or nothing; `preview` looks without holding (`previewHold`).
 */
export async function holdFor(
  ladder: Ladder,
  ch: Pick<ChallengeRow, "id" | "challenger" | "challenged">,
  on: string,
  min: number,
  people: Map<number, Pick<PlayerRow, "name">>,
  by: { kind: "players"; placeId?: number } | { kind: "staff"; name: string },
  opts: { courtId?: number | null; replacing?: boolean; reason?: string; byName?: string | null; agreement?: { proposer: number; accepter: number; rev?: number; role?: "proposed" | "countered" }; expectCourtId?: number | null; preview?: boolean } = {}
): Promise<{ ok: true; hold: HoldView; freed?: { courtId: number | null; date: string } | null } | LadderRefusal> {
  const before = opts.replacing ? (await holdViews([ch.id])).get(ch.id) : undefined;
  let courtId = opts.courtId ?? null;
  let confirmed = false;
  let changedFrom: { date: string; startMin: number; court: string | null } | null = null;
  if (by.kind === "staff" && before) {
    const sameTime = before.date === on && before.startMin === min && before.endMin - before.startMin === ladder.courtTime.matchMinutes;
    const sameCourt = courtId === null || courtId === before.courtId;
    if (sameTime && sameCourt && !before.tentative) {
      // Nothing material changes: the agreement the hold had stands, on the court it had.
      confirmed = true;
      courtId = before.courtId;
    } else if (!(sameTime && sameCourt)) changedFrom = { date: before.date, startMin: before.startMin, court: before.court || null };
  }
  const req = {
    ladder: { id: ladder.id, venueId: ladder.venueId, sport: ladder.sport, name: ladder.name, needsConfirmation: ladder.courtTime.needsConfirmation },
    confirmed,
    agreement: opts.agreement,
    expectCourtId: opts.expectCourtId ?? null,
    changedFrom,
    challengeId: ch.id,
    label: `Ladder match: ${ladder.name}: ${people.get(ch.challenger)?.name ?? ""} v ${people.get(ch.challenged)?.name ?? ""}`.slice(0, 200),
    playerIds: [ch.challenger, ch.challenged] as [number, number],
    date: on,
    startMin: min,
    minutes: ladder.courtTime.matchMinutes,
    courtId,
    by,
  };
  if (opts.preview) {
    const looked = await previewHold({ ...req, replacing: opts.replacing === true });
    return looked.ok ? looked : holdRefusal(looked);
  }
  if (opts.replacing) {
    const moved = await moveHold(req, "moved", opts.byName ?? null, opts.reason ?? null);
    if (!moved.ok) return holdRefusal(moved);
    if (moved.freed) freedStore.getStore()?.push(moved.freed);
    // A change that moves nothing material keeps the agreement the hold had (ADR 0050): the new hold carries its confirmations and what each player agreed.
    if (confirmed && before) {
      await carryAgreement(before.id, moved.hold.id);
      const again = (await holdViews([ch.id])).get(ch.id);
      if (again) return { ...moved, hold: again };
    } else {
      // A material change ends every agreement recorded for the specification it replaced: kept as history, flagged, never counted toward the new hold (ADR 0051).
      await getDb()
        .prepare("UPDATE ladder_agreed_times SET superseded_at = now(), superseded_reason = ? WHERE challenge_id = ? AND held_id IS NOT NULL AND held_id <> ? AND superseded_at IS NULL")
        .run(by.kind === "staff" ? "moved by the venue" : "a new time was agreed", ch.id, moved.hold.id);
    }
    return moved;
  }
  const made = await makeHold(req);
  return made.ok ? made : holdRefusal(made);
}

/**
 * The anti-abuse rule's log (ADR 0051): after a player cancelled a hold that reserved court capacity, say so in the log (by the system, with the objective facts: how many,
 * in how many days, the latest, and until when) once they are at or past the threshold. It writes only the log: the pause itself is read from the history of own cancellations.
 */
async function notePause(ladder: Pick<Ladder, "id" | "venueId" | "name">, placeId: number): Promise<void> {
  const limits = await resolveHoldLimits(ladder);
  const { count, last } = await ownCancellations(placeId, limits.abuse.windowDays);
  if (count < limits.cancelThreshold || last === null) return;
  const who = ((await getDb().prepare("SELECT name FROM ladder_players WHERE id = ?").get(placeId)) as { name: string } | undefined)?.name ?? `place ${placeId}`;
  const until = new Date(last.getTime() + limits.abuse.cooldownHours * 3_600_000).toISOString();
  await logAction(
    { id: null, name: "System" },
    {
      venueId: ladder.venueId,
      action: "ladder.hold_pause",
      detail: `${ladder.name}: ${who} cancelled ${count} holds that had reserved a court in ${limits.abuse.windowDays} days (limit ${limits.cancelThreshold}), the latest at ${last.toISOString()}: new holds are paused for them until ${until}. They can still propose, accept and play.`,
    }
  );
}

/**
 * A manager lifts a player's pause on creating new holds, with a reason (ADR 0051): the count starts again after this moment, so the pause ends at once. It is kept in the
 * neutral record and the activity log. Managers only (the route). The place must be on this ladder.
 */
export async function liftHoldPause(ladderId: number, placeId: unknown, by: { adminId: number | null; name: string }, reason: string): Promise<LadderResult<{ playerId: number }>> {
  const why = reason.trim();
  if (why.length < 3) return ladderRefusal("LD_REASON", {}, 400);
  return withLadder(ladderId, async (ladder) => {
    const id = typeof placeId === "number" ? placeId : Number(placeId);
    const people = await playersOf(ladder.id);
    if (!Number.isInteger(id) || !people.has(id)) return ladderRefusal("LD_NOT_ON", {}, 404);
    await liftPause(ladder, id, by.name, why);
    await logAction(by.adminId === null ? { id: null, name: by.name } : { id: by.adminId, name: by.name }, {
      venueId: ladder.venueId,
      action: "ladder.hold_pause_lifted",
      detail: `${ladder.name}: lifted the pause on new holds for ${people.get(id)?.name ?? `place ${id}`} (${why.slice(0, 200)})`,
    });
    return { ok: true, value: { playerId: id } };
  });
}

/** What the acceptance screen shows before the player agrees (ADR 0050): the court that would be held, the time, and what agreeing does. */
export type HoldPreviewView =
  | { applies: false; /** The player is in a pause on creating new holds (ADR 0051): the act still goes ahead, with no court held. */ paused?: { until: string; hours: number } }
  | {
      applies: true;
      courtId: number | null;
      court: string;
      date: string;
      startMin: number;
      endMin: number;
      minutes: number;
      /**
       * What the player's act does: the court is confirmed at once (this exact time is both players' agreement), is held tentatively until the other confirms, or, for a
       * proposal of their own (a counter-proposal, ADR 0051), nothing is held at all: it is their agreement to this time, not a reservation.
       */
      effect: "confirmed" | "tentative" | "proposal";
      /** The court the challenge holds now, which this would replace. */
      replaces: { court: string; date: string; startMin: number } | null;
    };

/**
 * A non-binding look, for a player on the challenge, at the court that would be held by the act they are about to make: `kind` is `accept` (the other's proposed
 * time, or the day and time sent), `agree_move` (the time the other asked for) or `propose_move` (the day and time they would ask for, which the other would then
 * agree). It is the same path as the hold (`holdFor` with `preview`, a rolled-back savepoint under the same limits, hours, buffers and constraints), so the court named
 * is the one that would be held; it reserves nothing and changes nothing, and it refuses for the reasons the act would, with the same sentences.
 */
export async function previewHoldFor(userId: number, challengeId: number, input: { kind: unknown; onDate?: unknown; minute?: unknown; rev?: number }): Promise<LadderResult<HoldPreviewView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder<HoldPreviewView>(found.ch.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    const lateRev = await staleRevision(ladder, ch, input);
    if (lateRev) return lateRev;
    const mineId = found.myId;
    const other = mineId === ch.challenger ? ch.challenged : ch.challenger;
    const today = await venueToday(ladder.venueId);
    const people = await playersOf(ladder.id);
    const had = (await holdViews([ch.id])).get(ch.id);
    let on: string | null;
    let min: number | null;
    let agreement: { proposer: number; accepter: number } | undefined;
    let replacing = false;
    let proposing = false;
    if (input.kind === "accept" || input.kind === "counter") {
      const waitingFor = ch.awaiting === "challenged" ? ch.challenged : ch.challenger;
      if (ch.status !== "pending" || waitingFor !== mineId) return ladderRefusal("LD_NOT_AWAITING");
      const when = proposal(input, today);
      if (!when.ok) return when.refusal;
      // `counter` is a proposal of their own in answer (the `propose` act): the same look as accepting with a time of one's own, which is a counter-proposal too (ADR 0051).
      const t = input.kind === "counter" ? { on: when.on, min: when.min, proposer: null } : acceptedTime(ch, mineId, when);
      on = t.on;
      min = t.min;
      agreement = t.proposer === null ? undefined : { proposer: t.proposer, accepter: mineId };
      proposing = input.kind === "counter" || (when.on !== null && t.proposer === null);
      if (!ladder.courtTime.on || !on || min === null) return { ok: true, value: { applies: false } };
      if (on > addDays(today, ladder.settings.playDays)) return ladderRefusal("LAD2_AFTER", { date: addDays(today, ladder.settings.playDays) });
    } else if (input.kind === "agree_move") {
      if (ch.status !== "accepted" || !ch.move_on || ch.move_min === null || ch.move_min === undefined || ch.move_by === null || ch.move_by === undefined) return ladderRefusal("LAD2_NO_MOVE");
      if (ch.move_by === mineId) return ladderRefusal("LAD2_OWN_MOVE");
      if (await db.prepare("SELECT 1 FROM ladder_challenge_bookings WHERE challenge_id = ? AND dropped_at IS NULL").get(ch.id)) return ladderRefusal("LAD2_HAS_BOOKING");
      on = ch.move_on;
      min = ch.move_min;
      agreement = { proposer: ch.move_by, accepter: mineId };
      replacing = had !== undefined;
    } else if (input.kind === "propose_move") {
      if (!ladder.courtTime.on) return ladderRefusal("LAD2_OFF");
      if (ch.status !== "accepted") return ladderRefusal("LAD2_NOT_ACCEPTED");
      if (await db.prepare("SELECT 1 FROM ladder_challenge_bookings WHERE challenge_id = ? AND dropped_at IS NULL").get(ch.id)) return ladderRefusal("LAD2_HAS_BOOKING");
      const when = proposal(input, today);
      if (!when.ok) return when.refusal;
      if (!when.on || when.min === null) return ladderRefusal("LAD2_NEED_TIME", {}, 400);
      if (when.on > (ch.play_by ?? addDays(today, ladder.settings.playDays))) return ladderRefusal("LAD2_AFTER", { date: ch.play_by ?? "" });
      on = when.on;
      min = when.min;
      agreement = { proposer: mineId, accepter: other };
      replacing = had !== undefined;
    } else return ladderRefusal("LD_TIME", {}, 400);
    const looked = await holdFor(ladder, ch, on, min, people, { kind: "players", placeId: mineId }, { replacing, agreement: proposing ? undefined : agreement, preview: true });
    // In a pause on creating new holds the act still goes ahead, with no court held (ADR 0051): the screen says so instead of a refusal.
    if (!looked.ok && looked.code === "LAD5_PAUSED") return { ok: true, value: { applies: false, paused: { until: String(looked.vars?.until ?? ""), hours: Number(looked.vars?.hours ?? 0) } } };
    if (!looked.ok) return looked;
    const h = looked.hold;
    return {
      ok: true,
      value: {
        applies: true,
        courtId: h.courtId,
        court: h.court,
        date: h.date,
        startMin: h.startMin,
        endMin: h.endMin,
        minutes: h.endMin - h.startMin,
        effect: proposing ? "proposal" : h.tentative ? "tentative" : "confirmed",
        replaces: replacing && had ? { court: had.court, date: had.date, startMin: had.startMin } : null,
      },
    };
  });
}

/** Holds that lost their court time are marked, and both sides told once that the challenge stands without a court held. */
async function tellLostHolds(): Promise<void> {
  const { reconcileHolds } = await import("./ladder-holds");
  for (const l of await reconcileHolds()) {
    const ladder = await ladderById(l.ladderId);
    const ch = (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(l.challengeId)) as ChallengeRow | undefined;
    if (!ladder || !ch) continue;
    await recordEvent({ ladderId: ladder.id, challengeId: ch.id, kind: "released", reservedCapacity: true, note: "the court was no longer available" });
    for (const id of [ch.challenger, ch.challenged]) await tellPlayer(id, ladder, (tr) => tr("lad2.mail.lost.s", { l: ladder.name }), (tr) => tr("lad2.mail.lost.b", { l: ladder.name }));
  }
}

/**
 * Either player asks the other to agree a day and time for an accepted challenge on a ladder that holds court time: the first specific time
 * (when only a day was agreed) or a move. Nothing is held until the other agrees (`answerMove`).
 */
export async function proposeMove(userId: number, challengeId: number, input: { onDate?: unknown; minute?: unknown }, expected: Expected = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    const lateRev = await staleRevision(ladder, ch, expected);
    if (lateRev) return lateRev;
    if (stale(ch, expected)) return changedRefusal();
    if (!ladder.courtTime.on) return ladderRefusal("LAD2_OFF");
    if (ch.status !== "accepted") return ladderRefusal("LAD2_NOT_ACCEPTED");
    if (await db.prepare("SELECT 1 FROM ladder_challenge_bookings WHERE challenge_id = ? AND dropped_at IS NULL").get(ch.id)) return ladderRefusal("LAD2_HAS_BOOKING");
    const today = await venueToday(ladder.venueId);
    const when = proposal(input, today);
    if (!when.ok) return when.refusal;
    if (!when.on || when.min === null) return ladderRefusal("LAD2_NEED_TIME", {}, 400);
    if (when.on > (ch.play_by ?? addDays(today, ladder.settings.playDays))) return ladderRefusal("LAD2_AFTER", { date: ch.play_by ?? "" });
    // A request that answers the other's request with a different time is a counter-proposal (ADR 0051): its maker's agreement to that exact time, replacing the request before it
    // (a new revision, which ends every agreement recorded for the earlier one). It holds nothing until the other agrees.
    const counters = ch.move_on !== null && ch.move_on !== undefined && ch.move_by !== found.myId;
    const next = Number(ch.proposal_rev ?? 1) + 1;
    await supersedeAgreements(ch.id, "a newer request replaced it");
    const lastDay = ch.play_by ?? addDays(today, ladder.settings.respondDays);
    const respondBy = addDays(today, ladder.settings.respondDays) < lastDay ? addDays(today, ladder.settings.respondDays) : lastDay;
    await db
      .prepare("UPDATE ladder_challenges SET move_on = ?, move_min = ?, move_by = ?, move_respond_by = ?, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?")
      .run(when.on, when.min, found.myId, respondBy, ch.id);
    await recordAgreement(ladder, ch.id, found.myId, counters ? "countered" : "proposed", next, when.on, when.min);
    await eventOf(ladder, ch.id, counters ? "countered" : "proposed", found.myId, { rev: next, date: when.on, startMin: when.min, note: "a new time for the match" });
    const people = await playersOf(ladder.id);
    const me = people.get(found.myId)?.shown ?? "";
    const other = found.myId === ch.challenger ? ch.challenged : ch.challenger;
    await tellPlayer(
      other,
      ladder,
      (tr) => tr("lad2.mail.moveAsked.s", { l: ladder.name, a: me }),
      (tr) => sentences(tr, tr("lad2.mail.moveAsked.b", { l: ladder.name, a: me, date: when.on!, time: fmtMin(when.min!) }), tr("lad5.mail.counter", { name: me, minutes: ladder.courtTime.matchMinutes }))
    );
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/**
 * The other player agrees the time asked (`agree: true`): the new time is held first, then the old one is let go, in one step, so a time that
 * cannot be held is refused with the reason and the old court stays held. The time one asked and the other agrees, unchanged, is both players' agreement
 * to it (ADR 0050, 0051): the hold is made confirmed, whatever state the one it replaces was in, and each player's agreement is kept. `expected.courtId` is the court the
 * agreeing player was shown: held, or nothing is. `expected.rev` is the revision of the request they answer: a superseded request can never be agreed (`LAD5_STALE`), and one
 * past its last day cannot either (`LAD5_EXPIRED`). Or either of them turns the request down or takes it back.
 */
export async function answerMove(userId: number, challengeId: number, agree: boolean, expected: Expected = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    const lateRev = await staleRevision(ladder, ch, expected);
    if (lateRev) return lateRev;
    if (stale(ch, expected)) return changedRefusal();
    if (ch.status !== "accepted" || !ch.move_on || ch.move_min === null || ch.move_min === undefined || ch.move_by === null || ch.move_by === undefined) return ladderRefusal("LAD2_NO_MOVE");
    const people = await playersOf(ladder.id);
    const me = people.get(found.myId)?.shown ?? "";
    const other = found.myId === ch.challenger ? ch.challenged : ch.challenger;
    const rev = Number(ch.proposal_rev ?? 1);
    if (agree) {
      if (ch.move_by === found.myId) return ladderRefusal("LAD2_OWN_MOVE");
      if (await db.prepare("SELECT 1 FROM ladder_challenge_bookings WHERE challenge_id = ? AND dropped_at IS NULL").get(ch.id)) return ladderRefusal("LAD2_HAS_BOOKING");
      if (ch.move_respond_by !== null && ch.move_respond_by !== undefined && (await venueToday(ladder.venueId)) > ch.move_respond_by) return ladderRefusal("LAD5_EXPIRED", { date: ch.move_respond_by });
      const row = await openAgreement(ch.id, ch.move_by, rev);
      if (row && row.minutes !== ladder.courtTime.matchMinutes) {
        // The match length changed after this time was asked: what its maker agreed is not what would be held. The request ends, nobody's agreement is reused.
        await supersedeAgreements(ch.id, "the match length changed");
        await db.prepare("UPDATE ladder_challenges SET move_on = NULL, move_min = NULL, move_by = NULL, move_respond_by = NULL, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(ch.id);
        await eventOf(ladder, ch.id, "superseded", null, { rev, date: ch.move_on, startMin: ch.move_min, note: "the match length changed" });
        return ladderRefusal("LAD5_TERMS");
      }
      const had = await holdViews([ch.id]);
      const made = await holdFor(
        ladder,
        ch,
        ch.move_on,
        ch.move_min,
        people,
        { kind: "players", placeId: found.myId },
        {
          replacing: had.has(ch.id),
          reason: "players agreed a new time",
          byName: me,
          agreement: { proposer: ch.move_by, accepter: found.myId, ...(row ? { rev, role: row.role === "countered" ? ("countered" as const) : ("proposed" as const) } : {}) },
          expectCourtId: expected.courtId,
        }
      );
      // A player in a pause on creating new holds still agrees the time: it is agreed and nothing is held for it (ADR 0051).
      let held: HoldView | null = null;
      if (!made.ok) {
        if (made.code !== "LAD5_PAUSED") return made;
      } else held = made.hold;
      await db
        .prepare("UPDATE ladder_challenges SET agreed_on = ?, agreed_min = ?, move_on = NULL, move_min = NULL, move_by = NULL, move_respond_by = NULL, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?")
        .run(ch.move_on, ch.move_min, ch.id);
      if (!held) await supersedeAgreements(ch.id, "agreed with no court held");
      await eventOf(ladder, ch.id, "accepted", found.myId, { rev, date: ch.move_on, startMin: ch.move_min, reservedCapacity: held !== null });
      if (held) await eventOf(ladder, ch.id, "held", found.myId, { rev, date: held.date, startMin: held.startMin, reservedCapacity: true });
      const confirmBy = await confirmByText(ladder.venueId, held);
      await tellPlayer(
        other,
        ladder,
        (tr) => tr("lad2.mail.moved.s", { l: ladder.name }),
        (tr) =>
          held
            ? sentences(
                tr,
                tr("lad2.mail.moved.b", { l: ladder.name, a: me, court: held.court, date: held.date, time: fmtMin(held.startMin) }),
                held.agreed && tr("lad4.mail.agreed", { name: me, minutes: ladder.courtTime.matchMinutes }),
                confirmBy && tr("lad3.mail.confirmBy", { by: confirmBy })
              )
            : sentences(tr, tr("ld.mail.answered.b", { l: ladder.name, a: me, what: tr("ld.ans.proposed", { date: ch.move_on!, time: fmtMin(ch.move_min!) }) }), tr("lad5.mail.noHold"))
      );
    } else {
      await db.prepare("UPDATE ladder_challenges SET move_on = NULL, move_min = NULL, move_by = NULL, move_respond_by = NULL, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(ch.id);
      const own = ch.move_by === found.myId;
      await supersedeAgreements(ch.id, own ? "withdrawn" : "declined");
      await eventOf(ladder, ch.id, own ? "withdrawn" : "declined", found.myId, { rev, date: ch.move_on, startMin: ch.move_min });
      await tellPlayer(other, ladder, (tr) => tr("lad2.mail.moveNo.s", { l: ladder.name }), (tr) => tr("lad2.mail.moveNo.b", { l: ladder.name, a: me }));
    }
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/**
 * A manager releases a challenge's hold, or moves it to another time (and court), with a reason (kept with the hold, in the log, told to both
 * players). A move holds the new time first and refuses, with the reason, leaving the old court held, if it cannot. Managers only (the route).
 */
export async function staffHold(
  challengeId: number,
  by: { adminId: number | null; name: string },
  action: { release: true } | { confirm: true } | { extend: true } | { move: { onDate: unknown; minute: unknown; courtId?: unknown } },
  reason: string
): Promise<LadderResult<ChallengeView>> {
  const row = (await getDb().prepare("SELECT ladder_id FROM ladder_challenges WHERE id = ?").get(challengeId)) as { ladder_id: number } | undefined;
  if (!row) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  const why = reason.trim();
  // Releasing, moving and extending need a reason; confirming for the players is a manager standing in for them, and its reason is optional.
  if (why.length < 3 && !("confirm" in action)) return ladderRefusal("LD_REASON", {}, 400);
  return withLadder(row.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_SEASON_OVER");
    if (ch.status !== "accepted") return ladderRefusal("LAD2_NOT_ACCEPTED");
    const people = await playersOf(ladder.id);
    if ("release" in action) {
      if (!(await letGo(ch.id, "staff", by.name, why))) return ladderRefusal("LAD2_NO_HOLD");
      await db.prepare("UPDATE ladder_challenges SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(ch.id);
      await eventOf(ladder, ch.id, "released", null, { byName: by.name, reservedCapacity: true, note: why.slice(0, 300) });
      for (const id of [ch.challenger, ch.challenged]) await tellPlayer(id, ladder, (tr) => tr("lad2.mail.released.s", { l: ladder.name }), (tr) => tr("lad2.mail.released.b", { l: ladder.name, why }));
    } else if ("confirm" in action) {
      // A manager confirms for both players (ADR 0048).
      const done = await confirmHold(ch.id, { manager: by.name });
      if (!done.ok) return holdRefusal(done);
      if (done.changed) {
        await db.prepare("UPDATE ladder_challenges SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(ch.id);
        for (const id of [ch.challenger, ch.challenged])
          await tellPlayer(id, ladder, (tr) => tr("lad3.mail.confirmed.s", { l: ladder.name }), (tr) => tr("lad3.mail.confirmed.b", { l: ladder.name, court: done.hold.court, date: done.hold.date, time: fmtMin(done.hold.startMin) }));
      }
    } else if ("extend" in action) {
      const done = await extendHold(ch.id, ladder.venueId, by.name, why);
      if (!done.ok) return holdRefusal(done);
      await db.prepare("UPDATE ladder_challenges SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(ch.id);
      const until = await confirmByText(ladder.venueId, done.hold);
      for (const id of [ch.challenger, ch.challenged])
        await tellPlayer(id, ladder, (tr) => tr("lad3.mail.extended.s", { l: ladder.name }), (tr) => sentences(tr, tr("lad3.mail.extended.b", { l: ladder.name }), until && tr("lad3.mail.confirmBy", { by: until })));
    } else {
      if (!ladder.courtTime.on) return ladderRefusal("LAD2_OFF");
      const today = await venueToday(ladder.venueId);
      const when = proposal(action.move, today);
      if (!when.ok) return when.refusal;
      if (!when.on || when.min === null) return ladderRefusal("LAD2_NEED_TIME", {}, 400);
      const courtId = action.move.courtId === undefined || action.move.courtId === null || action.move.courtId === "" ? null : Number(action.move.courtId);
      if (await db.prepare("SELECT 1 FROM ladder_challenge_bookings WHERE challenge_id = ? AND dropped_at IS NULL").get(ch.id)) return ladderRefusal("LAD2_HAS_BOOKING");
      const had = await holdViews([ch.id]);
      const made = await holdFor(ladder, ch, when.on, when.min, people, { kind: "staff", name: by.name }, { courtId, replacing: had.has(ch.id), reason: why, byName: by.name });
      if (!made.ok) return made;
      // The play-by day moves with a time later than it.
      const playBy = ch.play_by !== null && when.on > ch.play_by ? when.on : ch.play_by;
      await db
        .prepare("UPDATE ladder_challenges SET agreed_on = ?, agreed_min = ?, play_by = ?, move_on = NULL, move_min = NULL, move_by = NULL, move_respond_by = NULL, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?")
        .run(when.on, when.min, playBy, ch.id);
      // The venue's time is a new specification: a request the players had open, and the agreements recorded for it, end with it (ADR 0051).
      await supersedeAgreements(ch.id, "moved by the venue");
      await eventOf(ladder, ch.id, "moved", null, { byName: by.name, date: when.on, startMin: when.min, reservedCapacity: true, note: why.slice(0, 300) });
      // A change the players did not agree is tentative again (ADR 0050): both are told what changed and each confirms the new time. One that moves nothing material
      // keeps the agreement the hold had, and is told as a move as before.
      const changed = made.hold.changed;
      const confirmBy = await confirmByText(ladder.venueId, made.hold);
      for (const id of [ch.challenger, ch.challenged])
        await tellPlayer(
          id,
          ladder,
          (tr) => tr(changed ? "lad4.mail.changed.s" : "lad2.mail.staffMoved.s", { l: ladder.name }),
          (tr) =>
            changed
              ? sentences(
                  tr,
                  tr("lad4.mail.changed.b", {
                    l: ladder.name,
                    court: made.hold.court,
                    date: made.hold.date,
                    time: fmtMin(made.hold.startMin),
                    oldCourt: changed.court ?? "",
                    oldDate: changed.date,
                    oldTime: fmtMin(changed.startMin),
                    why,
                  }),
                  confirmBy && tr("lad4.mail.changedConfirm", { by: confirmBy })
                )
              : sentences(tr, tr("lad2.mail.staffMoved.b", { l: ladder.name, court: made.hold.court, date: made.hold.date, time: fmtMin(made.hold.startMin), why }), confirmBy && tr("lad3.mail.confirmBy", { by: confirmBy }))
        );

    }
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/** When a tentative hold lapses, as the venue's date and time ("2026-11-07 14:30"), or null when it is confirmed or there is no hold. */
async function confirmByText(venueId: number, hold: HoldView | null): Promise<string | null> {
  if (!hold?.tentative || !hold.confirmBy) return null;
  const zone = (await venueHours(venueId)).zone;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(hold.confirmBy))
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * A player confirms the court held for their accepted challenge (ADR 0048). When both have, it is confirmed and stays held until it is let go; the other
 * player is told when one confirms and the other has yet to. Confirming after the hold lapsed is refused (`LAD3_EXPIRED`) and the challenge goes back to
 * agreeing a time; confirming twice changes nothing and tells nobody.
 */
export async function confirmHoldAsPlayer(userId: number, challengeId: number, expected: { version?: number } = {}): Promise<LadderResult<ChallengeView>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (stale(ch, expected)) return changedRefusal();
    if (ch.status !== "accepted") return ladderRefusal("LAD2_NOT_ACCEPTED");
    const side = found.myId === ch.challenger ? "challenger" : "challenged";
    const done = await confirmHold(ch.id, { side });
    if (!done.ok) return holdRefusal(done);
    if (done.changed) {
      await getDb().prepare("UPDATE ladder_challenges SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(ch.id);
      const people = await playersOf(ladder.id);
      const me = people.get(found.myId)?.shown ?? "";
      const other = side === "challenger" ? ch.challenged : ch.challenger;
      const until = await confirmByText(ladder.venueId, done.hold);
      await tellPlayer(
        other,
        ladder,
        (tr) => tr(done.complete ? "lad3.mail.confirmed.s" : "lad3.mail.confirmedBy.s", { l: ladder.name }),
        (tr) =>
          done.complete
            ? tr("lad3.mail.confirmed.b", { l: ladder.name, court: done.hold.court, date: done.hold.date, time: fmtMin(done.hold.startMin) })
            : sentences(tr, tr("lad3.mail.confirmedBy.b", { l: ladder.name, a: me }), until && tr("lad3.mail.confirmBy", { by: until }))
      );
    }
    return { ok: true, value: await viewOf(ladder, ch.id) };
  });
}

/**
 * From the scheduler: holds nobody confirmed in time are let go (the claim path does the same whenever one is in its way) and both players are told once
 * that the court is free again and the challenge is back to arranging a time. The challenge stays accepted, with the day and no time, as when only a day
 * was agreed, so either player can ask for a time to hold again (`proposeMove`). Running it again tells nobody twice.
 */
async function tellExpiredHolds(): Promise<number> {
  const db = getDb();
  let told = 0;
  for (const h of await expiredHoldsToTell()) {
    const done = await withLadder(h.ladderId, async (ladder) => {
      if (!(await markExpiryTold(h.id))) return { ok: true as const, value: false };
      // Nobody confirmed it in time: recorded as no response, attributing nothing and counting towards nothing (ADR 0051).
      await recordEvent({ ladderId: ladder.id, challengeId: h.challengeId, kind: "no_response", date: h.date, startMin: h.startMin, reservedCapacity: true, note: "the court held was not confirmed in time and was released" });
      const ch = (await db.prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(h.challengeId)) as ChallengeRow | undefined;
      // Only a challenge still waiting on that time: one that has been played, withdrawn or given another hold since is left as it is.
      if (!ch || ch.status !== "accepted" || (await holdViews([ch.id])).has(ch.id)) return { ok: true as const, value: false };
      if (ch.agreed_on === h.date && ch.agreed_min === h.startMin)
        await db.prepare("UPDATE ladder_challenges SET agreed_min = NULL, proposal_rev = proposal_rev + 1, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(ch.id);
      for (const id of [ch.challenger, ch.challenged])
        await tellPlayer(id, ladder, (tr) => tr("lad3.mail.expired.s", { l: ladder.name }), (tr) => tr("lad3.mail.expired.b", { l: ladder.name, date: h.date, time: fmtMin(h.startMin) }));
      told++;
      return { ok: true as const, value: true };
    });
    // A ladder that is closed or ended has nobody to tell: the row is marked so the scheduler does not look at it again.
    if (!done.ok) await markExpiryTold(h.id);
    // The court is free for whoever is waiting for it, once (the waiting list's own offer is idempotent per court and day).
    await offerFreed([{ courtId: h.courtId, date: h.date }]);
  }
  return told;
}

// ------------------------------------------------------------ telling people

/** An email to the account that holds a place, in its language; one for somebody the account acts for says whose it is first. */
export async function tellPlayer(playerId: number, ladder: Pick<Ladder, "id" | "venueId">, subject: Written, body: Written): Promise<void> {
  const p = (await getDb()
    .prepare(
      "SELECT COALESCE(lp.user_id, tm.captain_user_id) AS user_id, lp.participant_id, pa.display_name FROM ladder_players lp LEFT JOIN participants pa ON pa.id = lp.participant_id LEFT JOIN teams tm ON tm.id = lp.team_id WHERE lp.id = ?"
    )
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
export async function ratingsAfter(ladderId: number): Promise<void> {
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

