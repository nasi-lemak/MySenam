import { getDb, withTransaction } from "./db";
import { startStep } from "./brackets";
import { instantOf, formatMinute } from "./interval";
import type { Ranked } from "./performance-math";
import { drawInitialOrder, defaultRounds, placeRound, peopleOf, roundsFit, windowsOf } from "./swiss";
import type { CumulativeRule, OutReason } from "./tournament-rules";
import {
  minutesFor,
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
 * A counted performance event played in Swiss rounds (docs/architecture/decisions/0038-swiss-acceleration-tie-break-screen-and-performance-swiss.md,
 * docs/features/tournaments.md#swiss-for-performance-events).
 *
 * Bouldering and climbing by height are ranked by what each competitor did, not by who they met, so there are no pairings. The Swiss
 * idea that carries over is that each round's groups are formed from the standings the rounds before left: adjacent places climb together.
 * Every round is the same boulders for everybody and is ranked across all its groups together (the event's own counted ranking,
 * `rankCounted`); a competitor's standing is those rounds' placings added up under the event's cumulative rule; the next round's groups
 * are formed from that standing when every group of the round is in. Results enter only through `recordPerformances`; this file reads
 * them. A correction to a round never moves anybody who is grouped: a later round whose groups the corrected standings would form
 * differently is flagged for review, and a manager may group it again, with a preview, while nobody has climbed it.
 *
 * The first half is arithmetic apart from the database, tested on its own.
 */

// ------------------------------------------------------------ arithmetic: groups

/**
 * How many competitors each group of a round has: as many groups as `size` asks for (at least one), but never so many that a group would
 * be left with one competitor, the sizes as even as they can be and the larger ones first. Nobody sits out: there is no bye. n = 3 and a
 * size of 2 is one group of 3, not 2 and 1.
 */
export function heatSizes(n: number, size: number): number[] {
  if (n <= 0) return [];
  const count = Math.min(Math.max(1, Math.ceil(n / Math.max(2, size))), Math.max(1, Math.floor(n / 2)));
  const base = Math.floor(n / count);
  const extra = n % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** A group of a round as formed: its number (heat 1 is the first to climb), and who is in it in the order of start. */
export interface PlannedHeat {
  heat: number;
  entries: number[];
}

/**
 * The groups of a round from the competitors best first: adjacent places form a group, the best group last to climb and, in each group,
 * the worst first and the best last (the event's `finalStart` "reverse", as a final starts), or the best first throughout ("ranking").
 */
export function planHeats(bestFirst: number[], size: number, finalStart: "reverse" | "ranking"): PlannedHeat[] {
  const chunks: number[][] = [];
  let at = 0;
  for (const n of heatSizes(bestFirst.length, size)) {
    chunks.push(bestFirst.slice(at, at + n));
    at += n;
  }
  const inOrder = finalStart === "reverse" ? [...chunks].reverse() : chunks;
  return inOrder.map((members, i) => ({ heat: i + 1, entries: finalStart === "reverse" ? [...members].reverse() : members }));
}

// ------------------------------------------------------------ arithmetic: the standing across rounds

/** What separated an entry from the one above it, where both have the same total: the countback, or the seed. */
export interface CumulativeTie {
  above: number;
  by: "countback" | "seed";
  /** The placings that differed (the better of the two, then this entry's), or the initial places. */
  ahead: number | null;
  behind: number | null;
}

export interface CumulativeLine {
  entryId: number;
  /** The placing in each round counted so far, the first round first. */
  placings: number[];
  /** The placings that make the total: all of them, or the best N. */
  counted: number[];
  /** The sum of `counted`; lower is better. */
  total: number;
  /** 1 for the leader; entries level on the total and on every placing share a place (1, 2, 2, 4). Null for somebody whose results are void. */
  rank: number | null;
  /** The position the next round is grouped by: never shared, the seed ordering whatever is still level. */
  order: number;
  tie: CumulativeTie | null;
  out: OutReason | null;
  resultsVoid: boolean;
}

/**
 * Each entry's placing in one round from the round's ranking across all its groups: the rank, with those level sharing a place (1, 2, 2, 4);
 * somebody with no result in it (did not start, did not finish, disqualified, left, not yet in) one place behind the last who has one.
 */
export function roundPlacings(entryIds: number[], ranked: { entryId: number; rank: number | null }[]): Map<number, number> {
  const ok = new Map(ranked.filter((r) => r.rank !== null).map((r) => [r.entryId, r.rank!]));
  const missing = ok.size + 1;
  return new Map(entryIds.map((id) => [id, ok.get(id) ?? missing]));
}

/**
 * The standing after the rounds given (each a placing for every entry): the total of the placings that count under the rule (all of
 * them, or the best N), lower first; level, the countback (the better best placing, then the next, over every round), then the initial
 * order. The order is total and deterministic; the place shared only where nothing but the initial order separates two.
 */
export function cumulativeRanking(
  entryIds: number[],
  initial: Map<number, number>,
  rounds: Map<number, number>[],
  rule: { cumulative: CumulativeRule; bestN: number | null }
): CumulativeLine[] {
  const lines = entryIds.map((id): CumulativeLine & { all: number[] } => {
    const placings = rounds.map((r) => r.get(id) ?? Math.max(0, ...r.values()) + 1);
    const all = [...placings].sort((x, y) => x - y);
    const counted = rule.cumulative === "best_n" && rule.bestN ? all.slice(0, rule.bestN) : placings;
    return { entryId: id, placings, counted, total: counted.reduce((s, p) => s + p, 0), rank: null, order: 0, tie: null, out: null, resultsVoid: false, all };
  });
  const countback = (x: { all: number[] }, y: { all: number[] }): { order: number; ahead: number | null; behind: number | null } => {
    for (let i = 0; i < Math.max(x.all.length, y.all.length); i++) {
      const [px, py] = [x.all[i], y.all[i]];
      if (px !== py && px !== undefined && py !== undefined) return { order: px - py, ahead: Math.min(px, py), behind: Math.max(px, py) };
    }
    return { order: 0, ahead: null, behind: null };
  };
  const seedOf = (id: number) => initial.get(id) ?? Number.POSITIVE_INFINITY;
  lines.sort((x, y) => x.total - y.total || countback(x, y).order || seedOf(x.entryId) - seedOf(y.entryId) || x.entryId - y.entryId);
  lines.forEach((l, i) => {
    l.order = i + 1;
    const above = i > 0 ? lines[i - 1] : null;
    const level = above && above.total === l.total && countback(above, l).order === 0;
    l.rank = level ? above!.rank : i + 1;
    if (above && above.total === l.total) {
      const c = countback(above, l);
      l.tie = c.order !== 0
        ? { above: above.entryId, by: "countback", ahead: c.ahead, behind: c.behind }
        : { above: above.entryId, by: "seed", ahead: Number.isFinite(seedOf(above.entryId)) ? seedOf(above.entryId) : null, behind: Number.isFinite(seedOf(l.entryId)) ? seedOf(l.entryId) : null };
    }
  });
  return lines.map(({ all: _all, ...line }) => line);
}

/** One entry's moves between the groups of a round when the corrected standings are laid over the groups it has. */
export interface GroupMove {
  entryId: number;
  from: number;
  to: number;
}

/**
 * Where each entry of a grouped round would be if the groups were formed again from `order` (entries best first, from the standings after
 * the round before) keeping the groups' sizes. The sizes of the groups stand, so somebody leaving after the round was grouped moves
 * nobody; only a change in who ranks above whom can move anybody. `heats`: each group's number (1 the first to climb) and members.
 */
export function expectedGrouping(heats: { heat: number; members: number[] }[], order: number[], finalStart: "reverse" | "ranking"): GroupMove[] {
  const here = new Map(heats.flatMap((h) => h.members.map((id) => [id, h.heat] as const)));
  const ranked = order.filter((id) => here.has(id));
  const present = new Set(ranked);
  const bestFirst = finalStart === "reverse" ? [...heats].sort((a, b) => b.heat - a.heat) : [...heats].sort((a, b) => a.heat - b.heat);
  const moves: GroupMove[] = [];
  let at = 0;
  for (const h of bestFirst) {
    // A group keeps the size it has among those still ranked: somebody who left, or whose results are void, is not counted in it.
    const size = h.members.filter((id) => present.has(id)).length;
    for (const id of ranked.slice(at, at + size)) if (here.get(id) !== h.heat) moves.push({ entryId: id, from: here.get(id)!, to: h.heat });
    at += size;
  }
  return moves.sort((a, b) => a.entryId - b.entryId);
}

// ------------------------------------------------------------ what a tournament shows

/** Why a group was formed as it was: each member's place and total in the standing the round was grouped from (null in round 1, which is by lot). */
export interface HeatNote {
  heat: number;
  members: { id: number; place: number | null; total: number | null }[];
}

export interface PerformanceSwissRound {
  round: number;
  groupedAt: string;
  /** Every group of it has all its lines in. */
  complete: boolean;
  heats: { matchId: number; heat: number; entryIds: number[] }[];
  notes: HeatNote[];
}

/** What the corrected standings would form differently in a round already grouped (never done by itself). */
export interface GroupingReview {
  round: number;
  moves: GroupMove[];
}

/** A counted performance event played in Swiss rounds as it stands: its settings, the rounds grouped and why, the standing and what to review. */
export interface PerformanceSwiss {
  roundsTotal: number;
  plannedRounds: number;
  seed: number;
  cumulative: CumulativeRule;
  bestN: number | null;
  rounds: PerformanceSwissRound[];
  /** Best first (by `order`); those whose results are void last, with no place. */
  standings: CumulativeLine[];
  nextRound: number | null;
  /** Why the next round could not be grouped, when it could not (a code: NO_TIME:3). */
  blocked: string | null;
  review: GroupingReview[];
}

interface EventRow {
  rounds: number;
  planned_rounds: number;
  seed: number | string;
  cumulative: CumulativeRule | null;
  best_n: number | null;
  blocked: string | null;
}

async function eventOf(tournamentId: number): Promise<EventRow | null> {
  return ((await getDb().prepare("SELECT rounds, planned_rounds, seed, cumulative, best_n, blocked FROM swiss_events WHERE tournament_id = ?").get(tournamentId)) as EventRow | undefined) ?? null;
}

/** Is this a counted performance event played in Swiss rounds? */
export const isSwissPerformance = (t: Pick<Tournament, "format" | "rules">): boolean => t.format === "performance" && !!t.rules.swiss && !!t.rules.performance?.counted;

const fingerprint = async (value: unknown): Promise<string> => (await import("crypto")).createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

/**
 * The Swiss part of a counted performance event's detail (lib/tournaments.ts `performanceOf`), from each round's ranking across its groups.
 * Null for any other event, and for one not yet drawn.
 */
export async function swissPerformanceOf(
  t: Tournament,
  matches: Match[],
  roundRanked: Map<number, Ranked[]>,
  voided: Set<number>,
  out: Map<number, { reason: OutReason }>
): Promise<PerformanceSwiss | null> {
  if (!isSwissPerformance(t)) return null;
  const ev = await eventOf(t.id);
  if (!ev) return null;
  const db = getDb();
  const rule = { cumulative: ev.cumulative ?? "sum_of_placings", bestN: ev.best_n };
  const initial = new Map(
    ((await db.prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ? AND swiss_rank IS NOT NULL").all(t.id)) as { id: number; swiss_rank: number }[]).map((r) => [r.id, r.swiss_rank])
  );
  const inDraw = [...initial.keys()];
  const heats = matches.filter((m) => m.stage === "heat");
  const members = new Map<number, number[]>();
  for (const r of (await db.prepare("SELECT match_id, entry_id FROM tournament_performances WHERE tournament_id = ? ORDER BY match_id, lane").all(t.id)) as { match_id: number; entry_id: number }[])
    members.set(r.match_id, [...(members.get(r.match_id) ?? []), r.entry_id]);
  const roundRows = (await db.prepare("SELECT round, paired_at, notes, kept_for FROM swiss_rounds WHERE tournament_id = ? ORDER BY round").all(t.id)) as { round: number; paired_at: string; notes: string; kept_for: string | null }[];
  const rounds = roundRows.map((r): PerformanceSwissRound => {
    const mine = heats.filter((m) => m.round === r.round).sort((a, b) => a.position - b.position);
    let notes: HeatNote[] = [];
    try {
      notes = JSON.parse(r.notes) as HeatNote[];
    } catch {
      notes = [];
    }
    return {
      round: r.round,
      groupedAt: r.paired_at,
      complete: mine.length > 0 && mine.every((m) => m.status !== "scheduled"),
      heats: mine.map((m) => ({ matchId: m.id, heat: m.position, entryIds: members.get(m.id) ?? [] })),
      notes,
    };
  });
  // Only rounds whose every group is in count: the standing never changes under a round half climbed.
  const completeRounds = rounds.filter((r) => r.complete).map((r) => r.round);
  const placings = new Map(completeRounds.map((r) => [r, roundPlacings(inDraw, roundRanked.get(r) ?? [])]));
  const after = (upTo: number) => cumulativeRanking(inDraw, initial, completeRounds.filter((r) => r <= upTo).map((r) => placings.get(r)!), rule);
  const lines = cumulativeRanking(inDraw, initial, completeRounds.map((r) => placings.get(r)!), rule);
  for (const l of lines) {
    l.out = out.get(l.entryId)?.reason ?? null;
    l.resultsVoid = voided.has(l.entryId);
    if (l.resultsVoid) {
      l.rank = null;
      l.tie = null;
    } else if (l.tie && voided.has(l.tie.above)) l.tie = null;
  }
  const standings = [...lines.filter((l) => !l.resultsVoid), ...lines.filter((l) => l.resultsVoid)];
  // What the corrected standings would form differently in a round already grouped, unless a manager kept it as it is for exactly this.
  const finalStart = t.rules.performance!.counted!.finalStart;
  const review: GroupingReview[] = [];
  for (const r of rounds) {
    if (r.round < 2 || !completeRounds.includes(r.round - 1)) continue;
    const row = roundRows.find((x) => x.round === r.round)!;
    const moves = expectedGrouping(r.heats.map((h) => ({ heat: h.heat, members: h.entryIds })), after(r.round - 1).filter((l) => !voided.has(l.entryId)).map((l) => l.entryId), finalStart);
    if (moves.length > 0 && row.kept_for !== (await fingerprint(moves))) review.push({ round: r.round, moves });
  }
  const latest = rounds[rounds.length - 1];
  return {
    roundsTotal: ev.rounds,
    plannedRounds: ev.planned_rounds,
    seed: Number(ev.seed),
    cumulative: rule.cumulative,
    bestN: rule.bestN,
    rounds,
    standings,
    nextRound: t.status === "drawn" && latest && latest.complete && latest.round < ev.rounds ? latest.round + 1 : null,
    blocked: ev.blocked,
    review,
  };
}

// ------------------------------------------------------------ the draw and the rounds

/** Write a round's groups: their matches (a counted group is a `heat`), where each was placed, and each competitor's order of start. */
async function storeRound(
  t: Tournament,
  round: number,
  heats: PlannedHeat[],
  placed: Map<string, { courtId: number; date: string; minute: number }>,
  minutes: number,
  notes: HeatNote[]
): Promise<void> {
  const db = getDb();
  for (const h of heats) {
    const at = placed.get(`r${round}-${h.heat}`);
    const info = await db
      .prepare(
        `INSERT INTO tournament_matches (tournament_id, stage, group_no, round, position, entry_a, entry_b, court_id, date, start_min, status, minutes)
         VALUES (?, 'heat', NULL, ?, ?, NULL, NULL, ?, ?, ?, 'scheduled', ?)`
      )
      .run(t.id, round, h.heat, at?.courtId ?? null, at?.date ?? null, at?.minute ?? null, minutes);
    for (let i = 0; i < h.entries.length; i++)
      await db.prepare("INSERT INTO tournament_performances (tournament_id, match_id, entry_id, lane) VALUES (?, ?, ?, ?)").run(t.id, info.lastInsertRowid as number, h.entries[i], i + 1);
  }
  await db.prepare("INSERT INTO swiss_rounds (tournament_id, round, notes) VALUES (?, ?, ?)").run(t.id, round, JSON.stringify(notes));
}

const noteOf = (heats: PlannedHeat[], standing: Map<number, CumulativeLine> | null): HeatNote[] =>
  heats.map((h) => ({ heat: h.heat, members: h.entries.map((id) => ({ id, place: standing?.get(id)?.rank ?? null, total: standing ? (standing.get(id)?.total ?? null) : null })) }));

/**
 * Make the draw of a counted performance event played in Swiss rounds (lib/tournaments.ts `makeDraw`): the initial order (seeds, then a
 * drawn order from the recorded seed, the only randomness), the rounds, and round 1's groups formed from it and placed. Refused, with
 * nothing changed, where the rounds cannot all fit the time held.
 */
export async function drawSwissPerformance(t: Tournament, entries: { id: number; seed: number | null }[], random: () => number): Promise<Result<null>> {
  const db = getDb();
  const settings = t.rules.swiss!;
  const perf = t.rules.performance!;
  const counted = perf.counted!;
  const n = entries.length;
  const rounds = settings.rounds ?? Math.max(2, defaultRounds(n));
  if (rounds < 2) return { ok: false, error: "A Swiss performance event plays at least 2 rounds." };
  const cumulative = settings.cumulative ?? "sum_of_placings";
  if (cumulative === "best_n" && (!settings.bestN || settings.bestN > rounds))
    return { ok: false, error: `The best ${settings.bestN ?? ""} placings cannot count in an event of ${rounds} rounds: choose a number up to ${rounds}.` };
  const { seed, initial } = drawInitialOrder(entries, random);
  const first = planHeats(initial, perf.heatSize, counted.finalStart);
  const minutes = minutesFor(t, "heat");
  const zone = await tournamentZone(t.id);
  const now = Date.now();
  const windows = await windowsOf(t);
  const siblings = t.competition ? await siblingMatches(t.competition.id, t.id) : [];
  const fits = roundsFit(rounds, first.length, minutes, windows, {
    step: startStep([t.matchMinutes, minutes]),
    origin: t.startMin,
    occupied: siblings.map((o) => ({ courtId: o.courtId, date: o.date, start: o.minute, end: o.minute + o.minutes })),
    allowed: (date, minute) => instantOf(date, minute, zone).getTime() > now,
  });
  if (!fits)
    return {
      ok: false,
      error: `Not enough court time: ${rounds} rounds of ${first.length} group${first.length === 1 ? "" : "s"} of ${minutes} minutes do not fit in the hours held. Add courts, hours or days, shorten the rounds, play fewer rounds, or take fewer entries.`,
    };
  const placed = await placeRound(t, first.map((h) => ({ key: `r1-${h.heat}`, sides: h.entries, minutes })), await peopleOf(t.id));
  if (!placed.ok) return { ok: false, error: `Not enough court time: ${placed.unplaced} of ${first.length} groups do not fit in the hours held.` };
  await db.transaction(async () => {
    for (let i = 0; i < initial.length; i++) await db.prepare("UPDATE tournament_entries SET swiss_rank = ? WHERE id = ?").run(i + 1, initial[i]);
    await db
      .prepare("INSERT INTO swiss_events (tournament_id, rounds, planned_rounds, seed, tiebreaks, bye_points, cumulative, best_n) VALUES (?, ?, ?, ?, '[]', 0, ?, ?)")
      .run(t.id, rounds, rounds, seed, cumulative, cumulative === "best_n" ? settings.bestN : null);
    await storeRound(t, 1, first, placed.placed, minutes, noteOf(first, null));
    await db.prepare("UPDATE tournaments SET status = 'drawn', draw_order = ? WHERE id = ?").run(JSON.stringify(initial), t.id);
  })();
  return { ok: true, value: null };
}

/** What grouping the next round came to. */
export type GroupOutcome = { ok: true; grouped: number | null } | { ok: false; error: string; code: "NOT_READY" | "NO_TIME" | "FEW_PLAYERS" };

/** Has every round of the event been grouped? (The held time is kept until it has; `allRoundsPaired` in lib/swiss.ts answers for both kinds.) */
async function latestRound(tournamentId: number): Promise<number> {
  return ((await getDb().prepare("SELECT MAX(round)::int AS n FROM swiss_rounds WHERE tournament_id = ?").get(tournamentId)) as { n: number | null }).n ?? 0;
}

/**
 * Group the next round if every group of the one before is in, from the standing as it is: everybody still in, adjacent places together.
 * Where it cannot be placed in the court time held, the round is left ungrouped and the reason kept for the organiser. Safe to call again:
 * it groups a round at most once, and nothing while a group of the latest round has a line to come. Never fails the result that
 * triggered it.
 */
export async function groupNextRound(tournamentId: number): Promise<GroupOutcome> {
  const db = getDb();
  await db.prepare("SELECT id FROM tournaments WHERE id = ? FOR UPDATE").get(tournamentId);
  const t = await tournamentById(tournamentId);
  const ev = await eventOf(tournamentId);
  if (!t || !ev || !isSwissPerformance(t) || t.status !== "drawn") return { ok: false, error: "No round is due.", code: "NOT_READY" };
  const round = (await latestRound(tournamentId)) + 1;
  if (round > ev.rounds) return { ok: true, grouped: null };
  if (await db.prepare("SELECT 1 FROM tournament_matches WHERE tournament_id = ? AND stage = 'heat' AND round = ? AND status = 'scheduled' LIMIT 1").get(tournamentId, round - 1))
    return { ok: false, error: "The round before is not in yet.", code: "NOT_READY" };
  const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
  const active = new Set(d.entries.filter((e) => e.status === "entered").map((e) => e.id));
  if (active.size < 2) {
    // Nobody left to compare: the event ends with the rounds it has.
    await db.prepare("UPDATE swiss_events SET rounds = ?, blocked = NULL WHERE tournament_id = ?").run(round - 1, tournamentId);
    return { ok: false, error: "Too few competitors are left to group another round: the event ends here.", code: "FEW_PLAYERS" };
  }
  const swiss = d.performance!.swiss!;
  const standing = new Map(swiss.standings.map((l) => [l.entryId, l]));
  const bestFirst = swiss.standings.filter((l) => !l.resultsVoid && active.has(l.entryId)).map((l) => l.entryId);
  const perf = t.rules.performance!;
  const heats = planHeats(bestFirst, perf.heatSize, perf.counted!.finalStart);
  const minutes = minutesFor(t, "heat");
  const placed = await placeRound(t, heats.map((h) => ({ key: `r${round}-${h.heat}`, sides: h.entries, minutes })), await peopleOf(tournamentId));
  if (!placed.ok) {
    await db.prepare("UPDATE swiss_events SET blocked = ? WHERE tournament_id = ?").run(`NO_TIME:${round}`, tournamentId);
    return { ok: false, error: `Round ${round} does not fit in the court time held (${placed.unplaced} of ${heats.length} groups).`, code: "NO_TIME" };
  }
  await storeRound(t, round, heats, placed.placed, minutes, noteOf(heats, standing));
  await db.prepare("UPDATE swiss_events SET blocked = NULL WHERE tournament_id = ?").run(tournamentId);
  await tellRound((await tournamentDetail(tournamentId))!, round);
  return { ok: true, grouped: round };
}

/** What follows a result or a leaver in a Swiss performance event (lib/tournaments.ts): the next round is grouped as soon as the one before is in. */
export async function afterPerformanceChange(tournamentId: number): Promise<void> {
  const t = await tournamentById(tournamentId);
  if (t && isSwissPerformance(t) && t.status === "drawn") await groupNextRound(tournamentId);
}

/** Everybody in the round, told which group they climb in, their order of start and when (in their language, to the account that holds the entry). */
async function tellRound(d: TournamentDetail, round: number): Promise<void> {
  for (const m of d.matches.filter((x) => x.stage === "heat" && x.round === round)) {
    for (const line of d.performance!.lines[m.id] ?? []) {
      const text: Written = (tr) =>
        m.date !== null && m.minute !== null
          ? tr("swpf.mail.group", { t: d.name, round, heat: m.position, lane: line.lane, date: m.date, time: formatMinute(m.minute, tr.locale), court: m.courtName ?? "" })
          : tr("swpf.mail.unplaced", { t: d.name, round, heat: m.position, lane: line.lane });
      await tellEntry(line.entryId, d, (tr) => tr("swpf.mail.s", { t: d.name, round }), text);
    }
  }
}

// ------------------------------------------------------------ corrections: review, keep, group again

/** Did anybody climb round `round` or a later one? A line with a result (or a reason there is none) is a climb. */
async function climbedFrom(tournamentId: number, round: number): Promise<boolean> {
  return !!(await getDb()
    .prepare("SELECT 1 FROM tournament_performances p JOIN tournament_matches m ON m.id = p.match_id WHERE p.tournament_id = ? AND m.stage = 'heat' AND m.round >= ? AND p.status <> 'pending' LIMIT 1")
    .get(tournamentId, round));
}

/** What grouping a round again would do: who moves, the later rounds whose groups are formed afresh, and the token it is confirmed with. */
export interface RegroupPreview {
  round: number;
  /** Everybody who changes group, laid over the groups the round has now. */
  moves: GroupMove[];
  /** Competitors in the round's groups who have left since: not in the new groups. */
  dropped: number[];
  /** Rounds after it whose groups are cleared and formed afresh when this one is in. */
  cleared: number[];
  token: string;
}

async function reviewFor(tournamentId: number, round: number): Promise<{ ok: true; d: TournamentDetail; review: GroupingReview | null } | { ok: false; error: string }> {
  const d = await tournamentDetail(tournamentId, { forStaff: true });
  const s = d?.performance?.swiss;
  if (!d || !s) return { ok: false, error: "That is not a Swiss performance event." };
  if (round < 2 || !s.rounds.some((r) => r.round === round)) return { ok: false, error: "That round is not grouped, or is the first (which is by lot)." };
  if (!s.rounds.some((r) => r.round === round - 1 && r.complete)) return { ok: false, error: "The round before is not in yet." };
  return { ok: true, d, review: s.review.find((r) => r.round === round) ?? null };
}

/**
 * Staff's look before grouping round `round` again from the standings as corrected (changes nothing): who would move group, who has left,
 * which later rounds are cleared. Refused once anybody has climbed that round or a later one: a round climbed is never rewritten.
 */
export async function previewRegroup(tournamentId: number, round: number): Promise<Result<RegroupPreview>> {
  const found = await reviewFor(tournamentId, round);
  if (!found.ok) return found;
  if (found.d.status !== "drawn") return { ok: false, error: "The event is not being played." };
  if (await climbedFrom(tournamentId, round)) return { ok: false, error: `Round ${round} or a later one has results: a round that has been climbed is not grouped again.`, code: "CLIMBED" };
  const s = found.d.performance!.swiss!;
  const active = new Set(found.d.entries.filter((e) => e.status === "entered").map((e) => e.id));
  const stored = s.rounds.find((r) => r.round === round)!;
  const finalStart = found.d.rules.performance!.counted!.finalStart;
  // The standing the round would be grouped from: after the round before.
  const placings = s.rounds.filter((r) => r.round < round && r.complete).map((r) => r.round);
  const prior = await standingAfter(found.d, placings);
  const bestFirst = prior.filter((l) => !l.resultsVoid && active.has(l.entryId)).map((l) => l.entryId);
  const fresh = planHeats(bestFirst, found.d.rules.performance!.heatSize, finalStart);
  const was = new Map(stored.heats.flatMap((h) => h.entryIds.map((id) => [id, h.heat] as const)));
  const now = new Map(fresh.flatMap((h) => h.entries.map((id) => [id, h.heat] as const)));
  const moves = [...now].filter(([id, heat]) => was.has(id) && was.get(id) !== heat).map(([entryId, to]) => ({ entryId, from: was.get(entryId)!, to })).sort((a, b) => a.entryId - b.entryId);
  const dropped = [...was.keys()].filter((id) => !now.has(id)).sort((a, b) => a - b);
  const cleared = s.rounds.filter((r) => r.round > round).map((r) => r.round);
  const token = await fingerprint({ id: tournamentId, round, moves, dropped, cleared, now: [...now].sort((a, b) => a[0] - b[0]), was: [...was].sort((a, b) => a[0] - b[0]) });
  return { ok: true, value: { round, moves, dropped, cleared, token } };
}

/** The standing after the given rounds (all complete), from the event's own detail, as the next round would be grouped from. */
async function standingAfter(d: TournamentDetail, rounds: number[]): Promise<CumulativeLine[]> {
  const s = d.performance!.swiss!;
  const db = getDb();
  const initial = new Map(
    ((await db.prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ? AND swiss_rank IS NOT NULL").all(d.id)) as { id: number; swiss_rank: number }[]).map((r) => [r.id, r.swiss_rank])
  );
  const ids = [...initial.keys()];
  const voided = new Set(s.standings.filter((l) => l.resultsVoid).map((l) => l.entryId));
  // Each round's placings are those the detail's lines give: a round's ranking across its groups, with void results as none.
  const maps = rounds.map((r) => {
    const ranked: { entryId: number; rank: number | null }[] = [];
    for (const m of d.matches.filter((x) => x.stage === "heat" && x.round === r)) for (const l of d.performance!.lines[m.id] ?? []) ranked.push({ entryId: l.entryId, rank: voided.has(l.entryId) ? null : l.rank });
    return roundPlacings(ids, ranked);
  });
  return cumulativeRanking(ids, initial, maps, { cumulative: s.cumulative, bestN: s.bestN }).map((l) => ({ ...l, resultsVoid: voided.has(l.entryId) }));
}

/**
 * Group round `round` again from the standings as corrected, confirmed against the preview: the round's groups and those of every later
 * round are removed (nothing in them has been climbed) and the round is grouped afresh and placed in the time held, or the whole thing is
 * refused and nothing changes. The competitors concerned are told their new group. The audit line is the route's.
 */
export async function regroupFrom(tournamentId: number, round: number, confirm: { token: string; reason: string }): Promise<Result<TournamentDetail>> {
  const reason = confirm.reason.trim();
  if (reason.length < 3) return { ok: false, error: "Give a reason of at least 3 characters." };
  class Refused extends Error {}
  try {
    return await withTransaction(async (): Promise<Result<TournamentDetail>> => {
      const db = getDb();
      await db.prepare("SELECT id FROM tournaments WHERE id = ? FOR UPDATE").get(tournamentId);
      const preview = await previewRegroup(tournamentId, round);
      if (!preview.ok) return preview;
      if (preview.value.token !== confirm.token) return { ok: false, error: "The event has changed since you looked. Review it again.", code: "CHANGED" };
      await db.prepare("DELETE FROM tournament_matches WHERE tournament_id = ? AND stage = 'heat' AND round >= ?").run(tournamentId, round);
      await db.prepare("DELETE FROM swiss_rounds WHERE tournament_id = ? AND round >= ?").run(tournamentId, round);
      const grouped = await groupNextRound(tournamentId);
      if (!grouped.ok || grouped.grouped !== round) throw new Refused(grouped.ok ? "The round could not be grouped again." : grouped.error);
      return { ok: true, value: (await tournamentDetail(tournamentId, { forStaff: true }))! };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: `${err.message} Nothing was changed.` };
    throw err;
  }
}

/**
 * A manager has reviewed what the corrected standings would group differently in round `round` and keeps the grouping as it is: the flag
 * is cleared for exactly that expected grouping (it comes back if a later correction changes it). Nobody moves.
 */
export async function keepGrouping(tournamentId: number, round: number, reason: string): Promise<Result<TournamentDetail>> {
  if (reason.trim().length < 3) return { ok: false, error: "Give a reason of at least 3 characters." };
  const found = await reviewFor(tournamentId, round);
  if (!found.ok) return found;
  if (!found.review) return { ok: false, error: "Nothing about that round needs review." };
  await getDb().prepare("UPDATE swiss_rounds SET kept_for = ? WHERE tournament_id = ? AND round = ?").run(await fingerprint(found.review.moves), tournamentId, round);
  return { ok: true, value: (await tournamentDetail(tournamentId, { forStaff: true }))! };
}
