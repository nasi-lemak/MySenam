import { getDb, withTransaction } from "./db";
import { scheduleTimed, standings, startStep, type Slot, type Standing, type Taken, type TimedMatch, type Window } from "./brackets";
import { PERSON_OF } from "./competition-entrants";
import { formatMinute, instantOf } from "./interval";
import { said, type StaffText } from "./staff-text";
import type { OutReason, OutStage, ScoringRules, SwissTiebreak } from "./tournament-rules";
import {
  decide,
  minutesFor,
  recordResult,
  releaseUnneeded,
  siblingMatches,
  tellEntry,
  tournamentById,
  tournamentDetail,
  tournamentZone,
  type Match,
  type Result,
  type Tournament,
  type TournamentDetail,
} from "./tournaments";
import type { Written } from "./outbox";

/**
 * Swiss tournaments (docs/architecture/decisions/0033-swiss-tournaments-and-club-ladders.md,
 * docs/features/tournaments.md#swiss-tournaments).
 *
 * A fixed number of rounds; each paired from the standings the round before left, once every match of it is decided
 * (or the organiser closes it), by published rules: score groups, no rematch, no second bye, the Dutch halves of a score
 * group, sides balanced. Standings are a pure function of the recorded results (`swissStandings`): points, then the
 * event's tie-breaks, then the initial order, so nothing is left to chance and a replay from the results gives the same
 * table. The matches are rows of the group stage (stage `group`, group 1, the round in `round`), so results, players'
 * reports, officials, the day's board, ratings and the live page work unchanged; a bye is a `bye` row.
 *
 * The first half of this file is arithmetic apart from the database, tested on its own; the second stores and reads
 * what it decides, and is called from lib/tournaments.ts (the draw, a result, somebody leaving, a correction).
 */

// ------------------------------------------------------------ arithmetic: rounds

/** The rounds an event plays unless told: the fewest that can leave one unbeaten entrant, ⌈log₂ n⌉, at least 1. */
export function defaultRounds(n: number): number {
  let rounds = 0;
  for (let size = 1; size < n; size *= 2) rounds++;
  return Math.max(rounds, 1);
}

/** The most rounds in which nobody need meet twice: n − 1 for an even number, n for an odd (a bye each). */
export function maxRounds(n: number): number {
  return n % 2 === 0 ? n - 1 : n;
}

/** What breaks ties after the points unless the event chooses: Buchholz, median Buchholz, then the scoring's own keys but the points. */
export function defaultTiebreaks(scoring: Pick<ScoringRules, "rankBy">): SwissTiebreak[] {
  return ["buchholz", "median_buchholz", ...scoring.rankBy.filter((k): k is Exclude<typeof k, "points"> => k !== "points")];
}

// ------------------------------------------------------------ arithmetic: standings

/** A decided match as the standings read it. `b` is null for a bye (a point for `a`, no opponent). */
export interface SwissResult {
  a: number;
  b: number | null;
  winner: number | null;
  score: string | null;
  status: "done" | "walkover" | "retired" | "bye";
}

export interface SwissLine extends Standing {
  /** 1 for the leader: points, then the tie-breaks, then the initial order. */
  rank: number;
  /** Swiss points: the table points of the results, and the points of byes. */
  points: number;
  byes: number;
  buchholz: number;
  medianBuchholz: number;
  out: OutReason | null;
  resultsVoid: boolean;
}

const ratio = (won: number, lost: number): number => (lost === 0 ? (won === 0 ? 0 : Number.MAX_SAFE_INTEGER) : won / lost);

/**
 * The table of a Swiss event, from the results that count (the caller leaves out those of somebody whose results are
 * void), best first. `initial` is each entry's place in the initial order, which settles whatever is still level.
 */
export function swissStandings(
  entryIds: number[],
  initial: Map<number, number>,
  results: SwissResult[],
  scoring: Pick<ScoringRules, "kind" | "tablePoints" | "rankBy" | "retired"> & Partial<Pick<ScoringRules, "setPoints" | "bestOf" | "walkover">>,
  rules: { byePoints: number; tiebreaks: SwissTiebreak[] }
): SwissLine[] {
  const played = results.filter((r) => r.b !== null && r.status !== "bye");
  const table = new Map(
    standings(
      entryIds,
      played.map((r) => ({ a: r.a, b: r.b!, winner: r.winner, score: r.score, draw: r.status === "done" && r.winner === null, retired: r.status === "retired", walkover: r.status === "walkover" })),
      scoring
    ).map((s) => [s.entryId, s])
  );
  const byes = new Map<number, number>();
  for (const r of results) if (r.b === null && r.status === "bye" && r.winner !== null) byes.set(r.winner, (byes.get(r.winner) ?? 0) + 1);
  const points = new Map<number, number>();
  for (const id of entryIds) points.set(id, (table.get(id)?.points ?? 0) + (byes.get(id) ?? 0) * rules.byePoints);
  const opponents = new Map<number, number[]>(entryIds.map((id) => [id, []]));
  for (const r of played) {
    if (r.winner === null && r.status !== "done") continue;
    opponents.get(r.a)?.push(r.b!);
    opponents.get(r.b!)?.push(r.a);
  }
  const buchholz = (id: number) => (opponents.get(id) ?? []).reduce((sum, o) => sum + (points.get(o) ?? 0), 0);
  const median = (id: number) => {
    const theirs = (opponents.get(id) ?? []).map((o) => points.get(o) ?? 0).sort((x, y) => x - y);
    return theirs.length >= 3 ? theirs.slice(1, -1).reduce((x, y) => x + y, 0) : theirs.reduce((x, y) => x + y, 0);
  };
  const headToHead = (x: number, y: number) =>
    played.find((r) => r.winner !== null && ((r.a === x && r.b === y) || (r.a === y && r.b === x)))?.winner;
  const lines = entryIds.map((id): SwissLine => {
    const s = table.get(id)!;
    return { ...s, points: points.get(id)!, byes: byes.get(id) ?? 0, buchholz: buchholz(id), medianBuchholz: median(id), rank: 0, out: null, resultsVoid: false };
  });
  const value = (line: SwissLine, key: Exclude<SwissTiebreak, "head_to_head">): number =>
    key === "buchholz"
      ? line.buchholz
      : key === "median_buchholz"
        ? line.medianBuchholz
        : key === "wins"
          ? line.won
          : key === "set_diff"
            ? line.setDiff
            : key === "set_ratio"
              ? ratio(line.setsWon, line.setsLost)
              : key === "point_diff"
                ? line.pointDiff
                : key === "point_ratio"
                  ? ratio(line.pointsFor, line.pointsAgainst)
                  : line.pointsFor;
  lines.sort((x, y) => {
    if (x.points !== y.points) return y.points - x.points;
    for (const key of rules.tiebreaks) {
      if (key === "head_to_head") {
        const met = headToHead(x.entryId, y.entryId);
        if (met === x.entryId) return -1;
        if (met === y.entryId) return 1;
        continue;
      }
      const [vx, vy] = [value(x, key), value(y, key)];
      if (vx !== vy) return vy - vx;
    }
    return (initial.get(x.entryId) ?? Infinity) - (initial.get(y.entryId) ?? Infinity) || x.entryId - y.entryId;
  });
  lines.forEach((l, i) => (l.rank = i + 1));
  return lines;
}

// ------------------------------------------------------------ arithmetic: pairing

export interface PairingPlayer {
  id: number;
  points: number;
  /** Place in the initial order (1 is first). */
  rank: number;
}

/** Why one pairing was made, kept and shown: the score groups, a float, the bye. */
export interface PairNote {
  kind: "pair" | "bye";
  a: number;
  b: number | null;
  aPoints: number;
  bPoints: number | null;
  /** The two were not in the same score group: one floated. */
  float: boolean;
}

export interface Pairing {
  pairs: { a: number; b: number; note: PairNote }[];
  bye: { id: number; note: PairNote } | null;
}

export const metKey = (x: number, y: number): string => (x < y ? `${x}:${y}` : `${y}:${x}`);

/** How many choices the search may try before it gives up on a round (far more than 128 entries need). */
const SEARCH_BUDGET = 400_000;

class TooComplex extends Error {}

/**
 * Pair a round (ADR 0033). Players by points (high first) then initial order. With an odd number, the bye goes to the
 * lowest-ranked player without one, the first from the bottom for whom everybody else can still be paired. Then the
 * best-ranked unpaired player is paired with the first opponent they have not met: the lower half of their own score
 * group first (the Dutch method), then the rest of the group, then the groups below, best first; a choice that leaves
 * the others unpairable is undone and the next is tried. The player first-named in each pair is the one first-named fewer
 * times (`firstCount`: times first less times second), level the better ranked. Null: no pairing without a rematch or a
 * second bye exists (or the search gave up).
 */
export function pairRound(players: PairingPlayer[], met: Set<string>, hadBye: Set<number>, firstCount: Map<number, number> = new Map()): Pairing | null {
  const order = [...players].sort((x, y) => y.points - x.points || x.rank - y.rank || x.id - y.id);
  const budget = { left: SEARCH_BUDGET };
  const prefer = (p: PairingPlayer, rest: PairingPlayer[]): PairingPlayer[] => {
    const same = rest.filter((q) => q.points === p.points);
    const lower = rest.filter((q) => q.points !== p.points);
    const half = Math.floor((same.length + 1) / 2);
    // The group is p and `same`; its lower half starts at index `half` of the group, which is `half - 1` of `same`.
    return half >= 1 ? [...same.slice(half - 1), ...same.slice(0, half - 1), ...lower] : [...same, ...lower];
  };
  const solve = (rem: PairingPlayer[]): [PairingPlayer, PairingPlayer][] | null => {
    if (rem.length === 0) return [];
    const [p, ...rest] = rem;
    for (const q of prefer(p, rest)) {
      if (met.has(metKey(p.id, q.id))) continue;
      if (--budget.left < 0) throw new TooComplex();
      const sub = solve(rest.filter((x) => x !== q));
      if (sub) return [[p, q], ...sub];
    }
    return null;
  };
  try {
    let bye: PairingPlayer | null = null;
    let pairs: [PairingPlayer, PairingPlayer][] | null;
    if (order.length % 2 === 1) {
      pairs = null;
      for (const candidate of [...order].reverse()) {
        if (hadBye.has(candidate.id)) continue;
        const sub = solve(order.filter((x) => x !== candidate));
        if (sub) {
          bye = candidate;
          pairs = sub;
          break;
        }
      }
    } else pairs = solve(order);
    if (!pairs) return null;
    const first = (id: number) => firstCount.get(id) ?? 0;
    const made = pairs.map(([p, q]) => {
      const pFirst = first(p.id) < first(q.id) || (first(p.id) === first(q.id) && order.indexOf(p) < order.indexOf(q));
      const [a, b] = pFirst ? [p, q] : [q, p];
      return { a: a.id, b: b.id, note: { kind: "pair", a: a.id, b: b.id, aPoints: a.points, bPoints: b.points, float: a.points !== b.points } as PairNote, top: Math.min(order.indexOf(p), order.indexOf(q)) };
    });
    made.sort((x, y) => x.top - y.top);
    return {
      pairs: made.map(({ a, b, note }) => ({ a, b, note })),
      bye: bye ? { id: bye.id, note: { kind: "bye", a: bye.id, b: null, aPoints: bye.points, bPoints: null, float: false } } : null,
    };
  } catch (err) {
    if (err instanceof TooComplex) return null;
    throw err;
  }
}

/**
 * Could `rounds` rounds of `perRound` matches of `minutes` each all be placed, one round after the previous ends, in
 * the time held? Used at the draw, so an event whose rounds cannot all fit is refused then rather than stranded later.
 */
export function roundsFit(
  rounds: number,
  perRound: number,
  minutes: number,
  windows: Window[],
  opts: { step: number; origin: number; occupied?: Taken[]; allowed?: (date: string, minute: number) => boolean }
): boolean {
  let occupied = [...(opts.occupied ?? [])];
  let after: { date: string; minute: number } | null = null;
  for (let r = 1; r <= rounds; r++) {
    const batch: TimedMatch[] = Array.from({ length: perRound }, (_, i) => ({ key: `r${r}-${i}`, minutes, sides: [`r${r}-${i}a`, `r${r}-${i}b`], after: [] }));
    const placed = scheduleTimed(batch, windows, {
      step: opts.step,
      origin: opts.origin,
      occupied,
      allowed: (date, minute) => (opts.allowed ? opts.allowed(date, minute) : true) && (!after || date > after.date || (date === after.date && minute >= after.minute)),
    });
    if (!placed.ok) return false;
    const slots = [...placed.placed.values()];
    occupied = [...occupied, ...slots.map((s) => ({ courtId: s.courtId, date: s.date, start: s.minute, end: s.end }))];
    after = slots.reduce((latest, s) => (!latest || s.date > latest.date || (s.date === latest.date && s.end > latest.minute) ? { date: s.date, minute: s.end } : latest), null as { date: string; minute: number } | null);
  }
  return true;
}

/** A small deterministic source of randomness from a recorded seed (mulberry32), so a draw can be reproduced from it. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ what a tournament shows

export interface SwissRound {
  round: number;
  pairedAt: string;
  /** Every match of it is decided. */
  complete: boolean;
  notes: PairNote[];
}

/** A Swiss event as it stands: its settings, the rounds paired and why, and the table. */
export interface SwissDetail {
  roundsTotal: number;
  plannedRounds: number;
  seed: number;
  tiebreaks: SwissTiebreak[];
  byePoints: number;
  rounds: SwissRound[];
  standings: SwissLine[];
  /** The round due to be paired next (the one before it is complete), or null. */
  nextRound: number | null;
  /** Why the next round could not be paired, when it could not. */
  blocked: string | null;
}

interface EventRow {
  rounds: number;
  planned_rounds: number;
  seed: number | string;
  tiebreaks: string;
  bye_points: number;
  blocked: string | null;
}

async function eventOf(tournamentId: number): Promise<EventRow | null> {
  return ((await getDb().prepare("SELECT rounds, planned_rounds, seed, tiebreaks, bye_points, blocked FROM swiss_events WHERE tournament_id = ?").get(tournamentId)) as EventRow | undefined) ?? null;
}

const readTiebreaks = (raw: string): SwissTiebreak[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as SwissTiebreak[]) : [];
  } catch {
    return [];
  }
};

/** The results of a Swiss event as the table reads them: not those of somebody whose results are void. */
function countedResults(matches: Match[], voided: Set<number>): SwissResult[] {
  return matches
    .filter((m) => m.stage === "group" && (m.status === "done" || m.status === "walkover" || m.status === "retired" || m.status === "bye"))
    .filter((m) => m.a !== null && !voided.has(m.a) && (m.b === null || !voided.has(m.b)))
    .filter((m) => !(m.status === "bye" && m.b !== null && m.winner === null))
    .map((m) => ({ a: m.a!, b: m.b, winner: m.winner, score: m.score, status: m.status as SwissResult["status"] }));
}

/**
 * The Swiss part of a tournament's detail (lib/tournaments.ts `tournamentDetail`): null for another format, and for a
 * Swiss event not yet drawn.
 */
export async function swissOf(
  t: Tournament,
  matches: Match[],
  entries: { id: number; out: { reason: OutReason; stage: OutStage | null } | null }[],
  voided: Set<number>
): Promise<SwissDetail | null> {
  if (t.format !== "swiss") return null;
  const ev = await eventOf(t.id);
  if (!ev) return null;
  const db = getDb();
  const ranks = new Map(
    ((await db.prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ? AND swiss_rank IS NOT NULL").all(t.id)) as { id: number; swiss_rank: number }[]).map((r) => [r.id, r.swiss_rank])
  );
  const tiebreaks = readTiebreaks(ev.tiebreaks);
  const inDraw = [...ranks.keys()];
  const lines = swissStandings(inDraw, ranks, countedResults(matches, voided), t.rules.scoring, { byePoints: ev.bye_points, tiebreaks });
  const outOf = new Map(entries.filter((e) => e.out).map((e) => [e.id, e.out!.reason]));
  for (const l of lines) {
    l.out = outOf.get(l.entryId) ?? null;
    l.resultsVoid = voided.has(l.entryId);
  }
  // Those whose results are void are listed after everybody whose results count, unranked as in a group's table.
  const ordered = [...lines.filter((l) => !l.resultsVoid), ...lines.filter((l) => l.resultsVoid)];
  const roundRows = (await db.prepare("SELECT round, paired_at, notes FROM swiss_rounds WHERE tournament_id = ? ORDER BY round").all(t.id)) as { round: number; paired_at: string; notes: string }[];
  const rounds = roundRows.map((r): SwissRound => {
    const mine = matches.filter((m) => m.stage === "group" && m.round === r.round);
    let notes: PairNote[] = [];
    try {
      notes = JSON.parse(r.notes) as PairNote[];
    } catch {
      notes = [];
    }
    return { round: r.round, pairedAt: r.paired_at, complete: mine.length > 0 && mine.every((m) => m.status !== "scheduled"), notes };
  });
  const latest = rounds[rounds.length - 1];
  const nextRound = t.status === "drawn" && latest && latest.complete && latest.round < ev.rounds ? latest.round + 1 : null;
  return {
    roundsTotal: ev.rounds,
    plannedRounds: ev.planned_rounds,
    seed: Number(ev.seed),
    tiebreaks,
    byePoints: ev.bye_points,
    rounds,
    standings: ordered.map((l, i) => ({ ...l, rank: l.resultsVoid ? 0 : i + 1 })),
    nextRound,
    blocked: ev.blocked,
  };
}

// ------------------------------------------------------------ the draw

interface DrawEntry {
  id: number;
  seed: number | null;
  user_id: number | null;
}

/** The windows of the time a tournament holds, within its hours each day, around what the competition's other divisions use. */
async function windowsOf(t: Tournament): Promise<Window[]> {
  const holds = (await getDb()
    .prepare("SELECT court_id, date, start_min, end_min FROM blocks WHERE tournament_id = ? OR (competition_id IS NOT NULL AND competition_id = ?) ORDER BY date, start_min")
    .all(t.id, t.competition?.id ?? null)) as { court_id: number; date: string; start_min: number; end_min: number }[];
  return holds
    .filter((h) => t.courtIds.includes(h.court_id) && h.date >= t.startsOn && h.date <= t.endsOn)
    .map((h) => ({ courtId: h.court_id, date: h.date, start: Math.max(h.start_min, t.startMin), end: Math.min(h.end_min, t.endMin) }))
    .filter((w) => w.end > w.start);
}

type Placed = Map<string, Slot & { end: number }>;

/**
 * Where a round's matches go: into the time held, each on a court and not twice for a side, after the previous round's
 * last match and after now, around what is on the courts already (this event's earlier rounds, another division's).
 */
async function placeRound(
  t: Tournament,
  matches: { key: string; sides: number[]; minutes: number }[],
  people: Map<number, number | null>
): Promise<{ ok: true; placed: Placed } | { ok: false; unplaced: number }> {
  const db = getDb();
  const zone = await tournamentZone(t.id);
  const windows = await windowsOf(t);
  const siblings = t.competition ? await siblingMatches(t.competition.id, t.id) : [];
  const own = (await db
    .prepare("SELECT entry_a, entry_b, court_id, date, start_min, COALESCE(minutes, ?) AS minutes FROM tournament_matches WHERE tournament_id = ? AND court_id IS NOT NULL AND date IS NOT NULL AND start_min IS NOT NULL")
    .all(t.matchMinutes, t.id)) as { entry_a: number | null; entry_b: number | null; court_id: number; date: string; start_min: number; minutes: number }[];
  const occupied: Taken[] = [
    ...siblings.map((o) => ({ courtId: o.courtId, date: o.date, start: o.minute, end: o.minute + o.minutes })),
    ...own.map((o) => ({ courtId: o.court_id, date: o.date, start: o.start_min, end: o.start_min + o.minutes })),
  ];
  const sideBusy = new Map<string, Taken[]>();
  const busy = (key: string, w: Taken) => sideBusy.set(key, [...(sideBusy.get(key) ?? []), w]);
  for (const o of siblings) for (const u of o.userIds) busy(`u${u}`, { date: o.date, start: o.minute, end: o.minute + o.minutes });
  for (const o of own)
    for (const e of [o.entry_a, o.entry_b])
      if (e !== null) {
        busy(`e${e}`, { date: o.date, start: o.start_min, end: o.start_min + o.minutes });
        const p = people.get(e);
        if (p !== null && p !== undefined) busy(`u${p}`, { date: o.date, start: o.start_min, end: o.start_min + o.minutes });
      }
  const last = own.reduce<{ date: string; minute: number } | null>((late, o) => {
    const end = o.start_min + o.minutes;
    return !late || o.date > late.date || (o.date === late.date && end > late.minute) ? { date: o.date, minute: end } : late;
  }, null);
  const now = Date.now();
  const sidesOf = (ids: number[]) => ids.flatMap((id) => [`e${id}`, ...(people.get(id) != null ? [`u${people.get(id)}`] : [])]);
  const toPlay: TimedMatch[] = matches.map((m) => ({ key: m.key, minutes: m.minutes, sides: sidesOf(m.sides), after: [] }));
  const step = startStep([t.matchMinutes, ...matches.map((m) => m.minutes)]);
  return scheduleTimed(toPlay, windows, {
    step,
    origin: t.startMin,
    occupied,
    sideBusy,
    allowed: (date, minute) => instantOf(date, minute, zone).getTime() > now && (!last || date > last.date || (date === last.date && minute >= last.minute)),
  });
}

/** The account each entry is played by (a participant is told apart from the guardian's own entry). */
async function peopleOf(tournamentId: number): Promise<Map<number, number | null>> {
  const rows = (await getDb().prepare(`SELECT id, ${PERSON_OF("tournament_entries")} AS person FROM tournament_entries WHERE tournament_id = ?`).all(tournamentId)) as { id: number; person: number | null }[];
  return new Map(rows.map((r) => [r.id, r.person]));
}

/**
 * Make a Swiss draw (lib/tournaments.ts `makeDraw`): the initial order (seeds, then a drawn order from the recorded seed),
 * the rounds, and round 1 paired and placed. Refused, with nothing changed, if the rounds asked for cannot be played by
 * so many entries or cannot all fit in the time held.
 */
export async function drawSwiss(t: Tournament, entries: DrawEntry[], random: () => number): Promise<Result<null>> {
  const db = getDb();
  const n = entries.length;
  if (n < 4) return { ok: false, error: "A Swiss event needs at least 4 entries: fewer play a round robin." };
  const settings = t.rules.swiss ?? { rounds: null, byePoints: null, tiebreaks: null };
  const rounds = settings.rounds ?? defaultRounds(n);
  if (rounds > maxRounds(n))
    return { ok: false, error: `${n} entries can play at most ${maxRounds(n)} rounds without anybody meeting twice: ask for fewer rounds.` };
  const seed = Math.floor(random() * 4294967296);
  const drawn = seededRandom(seed);
  // Seeds first, in seed order; the rest in an order drawn from the recorded seed (the only randomness there is).
  const seeded = entries.filter((e) => e.seed !== null).sort((x, y) => x.seed! - y.seed! || x.id - y.id);
  const unseeded = entries.filter((e) => e.seed === null).sort((x, y) => x.id - y.id);
  const shuffled = [...unseeded];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(drawn() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const initial = [...seeded, ...shuffled].map((e) => e.id);
  const minutes = minutesFor(t, "group");
  const people = await peopleOf(t.id);
  const first = pairRound(
    initial.map((id, i) => ({ id, points: 0, rank: i + 1 })),
    new Set(),
    new Set()
  );
  if (!first) return { ok: false, error: "The first round could not be paired." };
  const perRound = Math.floor(n / 2);
  const zone = await tournamentZone(t.id);
  const now = Date.now();
  const windows = await windowsOf(t);
  const siblings = t.competition ? await siblingMatches(t.competition.id, t.id) : [];
  const fits = roundsFit(rounds, perRound, minutes, windows, {
    step: startStep([t.matchMinutes, minutes]),
    origin: t.startMin,
    occupied: siblings.map((o) => ({ courtId: o.courtId, date: o.date, start: o.minute, end: o.minute + o.minutes })),
    allowed: (date, minute) => instantOf(date, minute, zone).getTime() > now,
  });
  if (!fits)
    return {
      ok: false,
      error: `Not enough court time: ${rounds} rounds of ${perRound} matches of ${minutes} minutes do not fit in the hours held. Add courts, hours or days, shorten the matches, play fewer rounds, or take fewer entries.`,
    };
  const matches = first.pairs.map((p, i) => ({ key: `r1-${i + 1}`, sides: [p.a, p.b], minutes }));
  const placed = await placeRound(t, matches, people);
  if (!placed.ok) return { ok: false, error: `Not enough court time: ${placed.unplaced} of ${matches.length} matches do not fit in the hours held.` };
  const tiebreaks = settings.tiebreaks ?? defaultTiebreaks(t.rules.scoring);
  const byePoints = settings.byePoints ?? t.rules.scoring.tablePoints.win;
  await db.transaction(async () => {
    for (let i = 0; i < initial.length; i++) await db.prepare("UPDATE tournament_entries SET swiss_rank = ? WHERE id = ?").run(i + 1, initial[i]);
    await db
      .prepare("INSERT INTO swiss_events (tournament_id, rounds, planned_rounds, seed, tiebreaks, bye_points) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.id, rounds, rounds, seed, JSON.stringify(tiebreaks), byePoints);
    await storeRound(t, 1, first, matches, placed.placed, minutes);
    await db.prepare("UPDATE tournaments SET status = 'drawn' WHERE id = ?").run(t.id);
  })();
  return { ok: true, value: null };
}

/** Write a paired round: its matches (and the bye), where they were placed, and why each pairing was made. */
async function storeRound(t: Tournament, round: number, pairing: Pairing, matches: { key: string }[], placed: Placed, minutes: number): Promise<void> {
  const db = getDb();
  let position = 0;
  for (let i = 0; i < pairing.pairs.length; i++) {
    const p = pairing.pairs[i];
    const at = placed.get(matches[i].key);
    position++;
    await db
      .prepare(
        `INSERT INTO tournament_matches (tournament_id, stage, group_no, round, position, entry_a, entry_b, court_id, date, start_min, status, minutes)
         VALUES (?, 'group', 1, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`
      )
      .run(t.id, round, position, p.a, p.b, at?.courtId ?? null, at?.date ?? null, at?.minute ?? null, minutes);
  }
  if (pairing.bye)
    await db
      .prepare(
        `INSERT INTO tournament_matches (tournament_id, stage, group_no, round, position, entry_a, entry_b, winner, status, minutes)
         VALUES (?, 'group', 1, ?, ?, ?, NULL, ?, 'bye', ?)`
      )
      .run(t.id, round, position + 1, pairing.bye.id, pairing.bye.id, minutes);
  await db
    .prepare("INSERT INTO swiss_rounds (tournament_id, round, notes) VALUES (?, ?, ?)")
    .run(t.id, round, JSON.stringify([...pairing.pairs.map((p) => p.note), ...(pairing.bye ? [pairing.bye.note] : [])]));
}

// ------------------------------------------------------------ pairing the next round

/** What pairing the next round came to. */
export type PairOutcome = { ok: true; paired: number | null } | { ok: false; error: string; code: "NOT_READY" | "NO_PAIRING" | "NO_TIME" | "FEW_PLAYERS" };

/** Has every round of the event been paired? (The held time is kept until it has.) */
export async function allRoundsPaired(tournamentId: number): Promise<boolean> {
  const row = (await getDb()
    .prepare("SELECT e.rounds, (SELECT COUNT(*)::int FROM swiss_rounds r WHERE r.tournament_id = e.tournament_id) AS paired FROM swiss_events e WHERE e.tournament_id = ?")
    .get(tournamentId)) as { rounds: number; paired: number } | undefined;
  return !row || row.paired >= row.rounds;
}

/** Is any round of a competition's Swiss divisions still to be paired? (A competition's held time is kept until none is.) */
export async function competitionHasUnpaired(competitionId: number): Promise<boolean> {
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM swiss_events e JOIN tournaments d ON d.id = e.tournament_id
        WHERE d.competition_id = ? AND d.status = 'drawn' AND e.rounds > (SELECT COUNT(*) FROM swiss_rounds r WHERE r.tournament_id = e.tournament_id) LIMIT 1`
    )
    .get(competitionId));
}

/**
 * Pair the next round if the one before it is decided, from the standings as they are: everybody still in, nobody
 * against somebody they have met, a bye to the lowest-ranked without one. Where it cannot be done, the round is left
 * unpaired and the reason kept for the organiser (`swiss_events.blocked`); nothing is paired against the rules. Safe to
 * call again: it pairs a round at most once, and nothing while a match of the latest round is undecided.
 */
export async function pairNextRound(tournamentId: number): Promise<PairOutcome> {
  const db = getDb();
  // One at a time, whoever asks (a result, a leaver, the organiser): the round is paired once.
  await db.prepare("SELECT id FROM tournaments WHERE id = ? FOR UPDATE").get(tournamentId);
  const t = await tournamentById(tournamentId);
  const ev = await eventOf(tournamentId);
  if (!t || !ev || t.status !== "drawn") return { ok: false, error: "No round is due.", code: "NOT_READY" };
  const latest = (await db.prepare("SELECT MAX(round)::int AS n FROM swiss_rounds WHERE tournament_id = ?").get(tournamentId)) as { n: number | null };
  const round = (latest.n ?? 0) + 1;
  if (round > ev.rounds) return { ok: true, paired: null };
  if ((await db.prepare("SELECT 1 FROM tournament_matches WHERE tournament_id = ? AND stage = 'group' AND round = ? AND status = 'scheduled' LIMIT 1").get(tournamentId, round - 1)))
    return { ok: false, error: "The round before is not decided yet.", code: "NOT_READY" };
  const d = (await tournamentDetail(tournamentId))!;
  const active = d.entries.filter((e) => e.status === "entered");
  if (active.length < 2) {
    // Nobody left to play: the event ends with the rounds it has.
    await db.prepare("UPDATE swiss_events SET rounds = ?, blocked = NULL WHERE tournament_id = ?").run(round - 1, tournamentId);
    return { ok: false, error: "Too few players are left to pair another round: the event ends here.", code: "FEW_PLAYERS" };
  }
  const swiss = d.swiss!;
  const points = new Map(swiss.standings.map((l) => [l.entryId, l.points]));
  const ranks = new Map(((await db.prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ?").all(tournamentId)) as { id: number; swiss_rank: number | null }[]).map((r) => [r.id, r.swiss_rank ?? 9999]));
  const pairsPlayed = d.matches.filter((m) => m.stage === "group" && m.a !== null && m.b !== null);
  const met = new Set(pairsPlayed.map((m) => metKey(m.a!, m.b!)));
  const hadBye = new Set(d.matches.filter((m) => m.stage === "group" && m.status === "bye" && m.b === null && m.a !== null).map((m) => m.a!));
  const firstCount = new Map<number, number>();
  for (const m of pairsPlayed) {
    firstCount.set(m.a!, (firstCount.get(m.a!) ?? 0) + 1);
    firstCount.set(m.b!, (firstCount.get(m.b!) ?? 0) - 1);
  }
  const pairing = pairRound(
    active.map((e) => ({ id: e.id, points: points.get(e.id) ?? 0, rank: ranks.get(e.id)! })),
    met,
    hadBye,
    firstCount
  );
  const stop = async (error: string, code: "NO_PAIRING" | "NO_TIME"): Promise<PairOutcome> => {
    await db.prepare("UPDATE swiss_events SET blocked = ? WHERE tournament_id = ?").run(`${code}:${round}`, tournamentId);
    return { ok: false, error, code };
  };
  if (!pairing)
    return stop(`Round ${round} cannot be paired without a rematch or a second bye. End the event after round ${round - 1}, or take the player who cannot be paired out.`, "NO_PAIRING");
  const minutes = minutesFor(t, "group");
  const matches = pairing.pairs.map((p, i) => ({ key: `r${round}-${i + 1}`, sides: [p.a, p.b], minutes }));
  const placed = await placeRound(t, matches, await peopleOf(tournamentId));
  if (!placed.ok) return stop(`Round ${round} does not fit in the court time held (${placed.unplaced} of ${matches.length} matches).`, "NO_TIME");
  await storeRound(t, round, pairing, matches, placed.placed, minutes);
  await db.prepare("UPDATE swiss_events SET blocked = NULL WHERE tournament_id = ?").run(tournamentId);
  await tellRound(await tournamentDetail(tournamentId) as TournamentDetail, round);
  return { ok: true, paired: round };
}

/** What follows any change to a Swiss event's results or entries (lib/tournaments.ts `afterChange`). */
export async function afterSwissChange(tournamentId: number): Promise<void> {
  await pairNextRound(tournamentId);
  await releaseUnneeded(tournamentId);
}

/** Everybody in the round, told who they play and when, or that they have the bye (in their language, to the account that holds the entry). */
async function tellRound(d: TournamentDetail, round: number): Promise<void> {
  const names = new Map(d.entries.map((e) => [e.id, e.name]));
  const mine = d.matches.filter((m) => m.stage === "group" && m.round === round);
  for (const m of mine) {
    if (m.status === "bye" && m.a !== null) {
      await tellEntry(m.a, d, (tr) => tr("swiss.mail.s", { t: d.name, round }), (tr) => tr("swiss.mail.bye", { t: d.name, round }));
      continue;
    }
    if (m.a === null || m.b === null) continue;
    for (const [me, them] of [[m.a, m.b], [m.b, m.a]] as const) {
      const text: Written = (tr) =>
        m.date !== null && m.minute !== null
          ? tr("swiss.mail.match", { t: d.name, round, opponent: names.get(them) ?? "", date: m.date, time: formatMinute(m.minute, tr.locale), court: m.courtName ?? "" })
          : tr("swiss.mail.unplaced", { t: d.name, round, opponent: names.get(them) ?? "" });
      await tellEntry(me, d, (tr) => tr("swiss.mail.s", { t: d.name, round }), text);
    }
  }
}

// ------------------------------------------------------------ closing a round, ending early

export interface RoundResolution {
  matchId: number;
  /** The side that did not come loses: the winner by walkover. Null: neither came, nobody scores. */
  winner: number | null;
}

/**
 * The organiser closes the latest round with matches still undecided: each is given a walkover to the side named (through
 * `recordResult`, so the event's rules for walkovers decide the table), or marked as played by nobody. The next round is
 * then paired. Every undecided match must be given an answer; nothing is changed otherwise.
 */
export async function closeRound(tournamentId: number, round: number, resolutions: RoundResolution[]): Promise<Result<TournamentDetail>> {
  const t = await tournamentById(tournamentId);
  const ev = await eventOf(tournamentId);
  if (!t || !ev || t.status !== "drawn") return { ok: false, error: "That event is not being played." };
  const latest = (await getDb().prepare("SELECT MAX(round)::int AS n FROM swiss_rounds WHERE tournament_id = ?").get(tournamentId)) as { n: number | null };
  if (latest.n !== round) return { ok: false, error: "Only the latest round can be closed." };
  const open = (await getDb()
    .prepare("SELECT id, entry_a, entry_b FROM tournament_matches WHERE tournament_id = ? AND stage = 'group' AND round = ? AND status = 'scheduled' AND entry_a IS NOT NULL AND entry_b IS NOT NULL ORDER BY position")
    .all(tournamentId, round)) as { id: number; entry_a: number; entry_b: number }[];
  if (open.length === 0) {
    const paired = await pairNextRound(tournamentId);
    return paired.ok || paired.code === "NOT_READY" ? { ok: true, value: (await tournamentDetail(tournamentId, { forStaff: true }))! } : { ok: false, error: paired.error, code: paired.code };
  }
  const answers = new Map(resolutions.map((r) => [r.matchId, r.winner]));
  for (const m of open) {
    if (!answers.has(m.id)) return { ok: false, error: "Say what happens to every match still to play: a walkover to a side, or neither came." };
    const w = answers.get(m.id)!;
    if (w !== null && w !== m.entry_a && w !== m.entry_b) return { ok: false, error: "A walkover is to one of the two sides." };
  }
  // Nobody came: no points and no result, kept so the pair is not paired again. Then the walkovers; the last decides the round.
  await withTransaction(async () => {
    for (const m of open) if (answers.get(m.id) === null) await decide(m.id, null, null, "bye");
  });
  for (const m of open) {
    const w = answers.get(m.id);
    if (w === null || w === undefined) continue;
    const done = await recordResult(m.id, { winner: w, walkover: true });
    if (!done.ok) return done;
  }
  const paired = await withTransaction(() => pairNextRound(tournamentId));
  if (!paired.ok && paired.code !== "NOT_READY") await releaseUnneeded(tournamentId);
  return { ok: true, value: (await tournamentDetail(tournamentId, { forStaff: true }))! };
}

/** The organiser ends the event after the last round paired (when no legal pairing is left, or too few play). Matches still to play are played; then it finishes. */
export async function endSwiss(tournamentId: number): Promise<Result<TournamentDetail>> {
  const t = await tournamentById(tournamentId);
  const ev = await eventOf(tournamentId);
  if (!t || !ev || t.status !== "drawn") return { ok: false, error: "That event is not being played." };
  const latest = (await getDb().prepare("SELECT MAX(round)::int AS n FROM swiss_rounds WHERE tournament_id = ?").get(tournamentId)) as { n: number | null };
  const paired = latest.n ?? 0;
  if (paired < 1) return { ok: false, error: "No round has been paired." };
  if (ev.rounds <= paired) return { ok: false, error: "The last round is paired already." };
  await withTransaction(async () => {
    await getDb().prepare("UPDATE swiss_events SET rounds = ?, blocked = NULL WHERE tournament_id = ?").run(paired, tournamentId);
    const open = await getDb().prepare("SELECT 1 FROM tournament_matches WHERE tournament_id = ? AND status = 'scheduled' LIMIT 1").get(tournamentId);
    if (!open) await getDb().prepare("UPDATE tournaments SET status = 'finished' WHERE id = ? AND status = 'drawn' AND NOT EXISTS (SELECT 1 FROM tournament_issues WHERE tournament_id = ? AND status = 'open')").run(tournamentId, tournamentId);
  });
  await releaseUnneeded(tournamentId);
  return { ok: true, value: (await tournamentDetail(tournamentId, { forStaff: true }))! };
}

// ------------------------------------------------------------ corrections

/** Is a round after this one paired? A result of this round changed then is a correction (stand, or pair again). */
export async function laterRoundPaired(tournamentId: number, round: number): Promise<boolean> {
  return !!(await getDb().prepare("SELECT 1 FROM swiss_rounds WHERE tournament_id = ? AND round > ? LIMIT 1").get(tournamentId, round));
}

/**
 * Pair again the rounds after `round`, which was corrected: possible only while no match after it has a result (a result,
 * a walkover or a retirement; a bye is not one). What was paired is removed, the next round paired from the corrected
 * standings under the same rules and placed in the time held, or the correction is refused with why and nothing changes.
 * Runs inside the correction's transaction (lib/tournaments.ts `recordResultOnce`).
 */
export async function repairFrom(tournamentId: number, round: number): Promise<{ ok: true } | { ok: false; blockers: StaffText[] }> {
  const db = getDb();
  const played = (await db
    .prepare(
      `SELECT round, position FROM tournament_matches WHERE tournament_id = ? AND stage = 'group' AND round > ? AND status IN ('done', 'walkover', 'retired')
        ORDER BY round, position`
    )
    .all(tournamentId, round)) as { round: number; position: number }[];
  if (played.length > 0) return { ok: false, blockers: [said("srv.tn.block.swissPlayed", { round: played[0].round, n: played.length })] };
  await db.prepare("DELETE FROM tournament_matches WHERE tournament_id = ? AND stage = 'group' AND round > ?").run(tournamentId, round);
  await db.prepare("DELETE FROM swiss_rounds WHERE tournament_id = ? AND round > ?").run(tournamentId, round);
  const paired = await pairNextRound(tournamentId);
  if (!paired.ok) return { ok: false, blockers: [said("srv.tn.block.swissRepair", { round: round + 1, why: paired.error })] };
  return { ok: true };
}

/** A round's matches with no court: for tests and the page, which show where a round could not be placed. */
export const roundOf = (d: Pick<TournamentDetail, "matches">, round: number): Match[] => d.matches.filter((m) => m.stage === "group" && m.round === round);

