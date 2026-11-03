import crypto from "crypto";
import { aside, getDb, mustRethrow, withTransaction } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { groupResultsVoid, readRules, type CompetitionRules } from "./tournament-rules";
import {
  isProvisional,
  levelOfRating,
  orderKey,
  readRatingRules,
  replay,
  type Level,
  type RatingFormat,
  type RatingRules,
  type ReplayMember,
  type ReplayRow,
  type ResultKind,
} from "./rating-math";
import { ACTS_FOR } from "./participants";
import { todayISO } from "./time";
import type { Refusal } from "./types";

/**
 * Ratings built from results, and rankings across events (docs/features/tournaments.md#ratings-and-rankings,
 * docs/features/matchmaking.md#earned-levels; ADR 0031; migration 0270).
 *
 * **The ledger is the source of truth.** `rated_results` holds one row per decided match of an event a venue marked as
 * rated (a tournament match, a box-league match, a team-league game, a team-league fixture), with both sides and the
 * outcome. A rating is a pure function of the ledger's live rows in a defined order (`replay`, lib/rating-math.ts): when
 * a result is corrected, voided, struck or restored the affected rows are voided and written again (`syncRatedEvent`),
 * and the pool's ratings (one venue, one sport, one format) are recomputed from the whole ledger under the pool's row
 * lock. Nothing is ever updated from a previous rating, so nothing drifts.
 *
 * **This module only consumes results.** They are entered through `recordResult` (lib/tournaments.ts) and the league
 * functions (lib/leagues.ts, lib/team-leagues.ts) as always; those call `ratedAfter` once they have committed, and the
 * scheduler's `ratingsCatchUp` re-reads any event whose results differ from the last read (safe to run twice, on two
 * servers, or after a missed call). Nothing here scores, ranks an event's table or enters a result.
 *
 * **Who can be rated.** An account ('user'), a child a guardian manages ('participant': for the child's guardian only,
 * never ranked or shown to anyone else), a persistent team ('team'). A name typed into an entry (a doubles partner, a
 * typed roster, somebody entered at the counter) is not a person the app can rate: a side with nobody who can be rated
 * is not counted, and a pair counts as the entrant alone.
 *
 * **Who sees a rating.** The player, and the guardian of a child. Anyone else only what the player chose: a number to
 * matched hosts and players (`rating_shared`), or a place on the venue's public rankings (`rank_publicly`, under the
 * name they gave), both for declared adults only. A team is listed once its captain publishes it.
 */

export type SourceKind = "tournament" | "league" | "team_league";
export const SOURCE_KINDS: SourceKind[] = ["tournament", "league", "team_league"];
export type SubjectKind = "user" | "participant" | "team";

export type RatingRefusal = Refusal & { status?: number };
export type RatingResult<T> = { ok: true; value: T } | RatingRefusal;

const ENGLISH = translator("en");
export function ratingRefusal(code: ErrorCode, vars: Record<string, string | number> = {}, status = 409): RatingRefusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(Object.keys(vars).length > 0 ? { vars } : {}), status };
}

// ------------------------------------------------------------ the rules

export async function ratingRulesNow(): Promise<{ version: number; rules: RatingRules }> {
  const row = (await getDb().prepare("SELECT version, rules FROM rating_rules WHERE id = 1").get()) as { version: number; rules: string } | undefined;
  return { version: row?.version ?? 1, rules: readRatingRules(row?.rules) };
}

// ------------------------------------------------------------ the facts of an event

interface SubjectRef {
  kind: SubjectKind;
  id: number;
  /** As the event showed them; empty for a child (shown as "a junior player"). */
  label: string;
}

interface Fact {
  format: RatingFormat;
  sourceMatch: number;
  unitNo: number;
  resultRef: number;
  playedOn: string;
  playOrder: number;
  outcome: number;
  kind: ResultKind;
  margin: number | null;
  hash: string;
  a: SubjectRef[];
  b: SubjectRef[];
}

interface EventFacts {
  venueId: number;
  sport: string;
  name: string;
  facts: Fact[];
}

const hashOf = (x: unknown): string => crypto.createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 20);

function uniqueSubjects(list: (SubjectRef | null)[]): SubjectRef[] {
  const seen = new Set<string>();
  const out: SubjectRef[] = [];
  for (const s of list) {
    if (!s || seen.has(`${s.kind}:${s.id}`)) continue;
    seen.add(`${s.kind}:${s.id}`);
    out.push(s);
  }
  return out;
}

/** The goals or points a decisive tally was won by ("3-2" is 1), or null where the score is not a tally. */
export function tallyMargin(score: string | null): number | null {
  const m = /^\s*(\d{1,3})\s*-\s*(\d{1,3})/.exec(score ?? "");
  return m ? Math.abs(Number(m[1]) - Number(m[2])) : null;
}

async function tournamentFacts(id: number): Promise<EventFacts | null> {
  const db = getDb();
  const t = (await db
    .prepare("SELECT id, venue_id, name, sport, status, format, entry_kind, team_size, rules, starts_on, rated FROM tournaments WHERE id = ?")
    .get(id)) as
    | { id: number; venue_id: number; name: string; sport: string; status: string; format: string; entry_kind: string | null; team_size: number; rules: string | null; starts_on: string; rated: boolean }
    | undefined;
  if (!t) return null;
  const base = { venueId: t.venue_id, sport: t.sport, name: t.name };
  // A performance event's heats are marks, not head-to-head results; a called-off event's results are moot.
  if (!t.rated || t.status === "cancelled" || t.format === "performance") return { ...base, facts: [] };
  const rules: CompetitionRules = readRules(t.rules);
  const entryKind = t.entry_kind ?? (t.team_size === 2 ? "pair" : "player");
  const format: RatingFormat = entryKind === "team" ? "team" : entryKind === "pair" ? "doubles" : "singles";
  const entries = new Map(
    (
      (await db
        .prepare("SELECT id, name, user_id, participant_id, team_id, out_reason, out_stage FROM tournament_entries WHERE tournament_id = ?")
        .all(id)) as { id: number; name: string; user_id: number | null; participant_id: number | null; team_id: number | null; out_reason: "withdrawn" | "retired" | "disqualified" | null; out_stage: "before_draw" | "groups" | "knockout" | null }[]
    ).map((e) => [e.id, e])
  );
  const subject = (entryId: number): SubjectRef | null => {
    const e = entries.get(entryId);
    if (!e) return null;
    if (format === "team") return e.team_id ? { kind: "team", id: e.team_id, label: e.name } : null;
    if (e.participant_id) return { kind: "participant", id: e.participant_id, label: "" };
    if (e.user_id) return { kind: "user", id: e.user_id, label: e.name };
    return null;
  };
  const matches = (await db
    .prepare(
      `SELECT id, stage, entry_a, entry_b, winner, score, status, date, start_min FROM tournament_matches
        WHERE tournament_id = ? AND stage IN ('group', 'knockout') AND status IN ('done', 'walkover', 'retired') AND entry_a IS NOT NULL AND entry_b IS NOT NULL ORDER BY id`
    )
    .all(id)) as { id: number; stage: string; entry_a: number; entry_b: number; winner: number | null; score: string | null; status: "done" | "walkover" | "retired"; date: string | null; start_min: number | null }[];
  const facts: Fact[] = [];
  for (const m of matches) {
    // Group results of somebody whose results are void under the event's own rules are left out of its table, and out of the ratings.
    if (m.stage === "group") {
      const voided = [m.entry_a, m.entry_b].some((e) => {
        const x = entries.get(e);
        return !!x && groupResultsVoid(rules, x.out_reason, x.out_stage);
      });
      if (voided) continue;
    }
    const a = uniqueSubjects([subject(m.entry_a)]);
    const b = uniqueSubjects([subject(m.entry_b)]);
    if (a.length === 0 || b.length === 0) continue;
    const outcome = m.winner === m.entry_a ? 1 : m.winner === m.entry_b ? 0 : m.status === "done" && m.winner === null ? 0.5 : null;
    if (outcome === null) continue;
    const kind: ResultKind = m.status === "done" ? "played" : m.status;
    const margin = rules.scoring.kind === "tally" && kind === "played" ? tallyMargin(m.score) : null;
    facts.push({
      format,
      sourceMatch: m.id,
      unitNo: 0,
      resultRef: m.id,
      playedOn: m.date ?? t.starts_on,
      playOrder: m.start_min ?? 0,
      outcome,
      kind,
      margin,
      hash: hashOf({ format, outcome, kind, margin, r: [m.id, m.entry_a, m.entry_b] }),
      a,
      b,
    });
  }
  return { ...base, facts };
}

async function leagueFacts(id: number): Promise<EventFacts | null> {
  const db = getDb();
  const l = (await db.prepare("SELECT id, venue_id, name, sport, team_size, rules, rated FROM leagues WHERE id = ?").get(id)) as
    | { id: number; venue_id: number; name: string; sport: string; team_size: number; rules: string | null; rated: boolean }
    | undefined;
  if (!l) return null;
  const base = { venueId: l.venue_id, sport: l.sport, name: l.name };
  if (!l.rated) return { ...base, facts: [] };
  const rules = readRules(l.rules);
  const format: RatingFormat = l.team_size === 2 ? "doubles" : "singles";
  const players = new Map(
    ((await db.prepare("SELECT id, name, user_id, participant_id FROM league_players WHERE league_id = ?").all(id)) as { id: number; name: string; user_id: number | null; participant_id: number | null }[]).map((p) => [p.id, p])
  );
  const subject = (playerId: number): SubjectRef | null => {
    const p = players.get(playerId);
    if (!p) return null;
    if (p.participant_id) return { kind: "participant", id: p.participant_id, label: "" };
    return p.user_id ? { kind: "user", id: p.user_id, label: p.name } : null;
  };
  const matches = (await db
    .prepare(
      `SELECT m.id, m.player_a, m.player_b, m.winner, m.score, m.status, m.reported_at, m.updated_at
         FROM league_matches m JOIN league_seasons s ON s.id = m.season_id
        WHERE s.league_id = ? AND m.status IN ('confirmed', 'walkover') ORDER BY m.id`
    )
    .all(id)) as { id: number; player_a: number; player_b: number; winner: number | null; score: string | null; status: "confirmed" | "walkover"; reported_at: string | null; updated_at: string | null }[];
  const facts: Fact[] = [];
  for (const m of matches) {
    const a = uniqueSubjects([subject(m.player_a)]);
    const b = uniqueSubjects([subject(m.player_b)]);
    if (a.length === 0 || b.length === 0) continue;
    if (m.winner !== m.player_a && m.winner !== m.player_b) continue;
    const outcome = m.winner === m.player_a ? 1 : 0;
    const kind: ResultKind = m.status === "walkover" ? "walkover" : "played";
    const margin = rules.scoring.kind === "tally" && kind === "played" ? tallyMargin(m.score) : null;
    const day = (m.reported_at ?? m.updated_at ?? "").slice(0, 10);
    facts.push({
      format,
      sourceMatch: m.id,
      unitNo: 0,
      resultRef: m.id,
      playedOn: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayISO(),
      playOrder: 0,
      outcome,
      kind,
      margin,
      hash: hashOf({ format, outcome, kind, margin, r: [m.id, m.player_a, m.player_b] }),
      a,
      b,
    });
  }
  return { ...base, facts };
}

async function teamLeagueFacts(id: number): Promise<EventFacts | null> {
  const db = getDb();
  const l = (await db.prepare("SELECT id, venue_id, name, sport, rules, rubbers, rated FROM team_leagues WHERE id = ?").get(id)) as
    | { id: number; venue_id: number; name: string; sport: string; rules: string; rubbers: string; rated: boolean }
    | undefined;
  if (!l) return null;
  const base = { venueId: l.venue_id, sport: l.sport, name: l.name };
  if (!l.rated) return { ...base, facts: [] };
  const rules = readRules(l.rules);
  const fixtures = (await db
    .prepare(
      `SELECT f.id, f.status, f.date, f.start_min, ht.team_id AS home_team_id, ht.name AS home_name, aw.team_id AS away_team_id, aw.name AS away_name
         FROM team_fixtures f JOIN team_league_teams ht ON ht.id = f.home_team JOIN team_league_teams aw ON aw.id = f.away_team
        WHERE f.league_id = ? AND f.status IN ('confirmed', 'forfeit') ORDER BY f.id`
    )
    .all(id)) as { id: number; status: "confirmed" | "forfeit"; date: string; start_min: number; home_team_id: number | null; home_name: string; away_team_id: number | null; away_name: string }[];
  if (fixtures.length === 0) return { ...base, facts: [] };
  const ids = fixtures.map((f) => f.id);
  const marks = ids.map(() => "?").join(",");
  const rubbers = (await db
    .prepare(`SELECT id, fixture_id, rubber_no, kind, score, winner, played, walkover FROM team_fixture_rubbers WHERE fixture_id IN (${marks}) ORDER BY fixture_id, rubber_no`)
    .all(...ids)) as { id: number; fixture_id: number; rubber_no: number; kind: "singles" | "doubles" | "team"; score: string | null; winner: "home" | "away" | null; played: boolean; walkover: boolean }[];
  const lineups = (await db
    .prepare(`SELECT id, fixture_id, rubber_no, side, team_member_id, name FROM team_fixture_lineups WHERE fixture_id IN (${marks}) ORDER BY id`)
    .all(...ids)) as { id: number; fixture_id: number; rubber_no: number; side: "home" | "away"; team_member_id: number | null; name: string }[];
  const memberIds = [...new Set(lineups.map((x) => x.team_member_id).filter((x): x is number => x !== null))];
  const members = new Map<number, { user_id: number | null; participant_id: number | null }>();
  if (memberIds.length > 0)
    for (const m of (await db
      .prepare(`SELECT id, user_id, participant_id FROM team_members WHERE id IN (${memberIds.map(() => "?").join(",")})`)
      .all(...memberIds)) as { id: number; user_id: number | null; participant_id: number | null }[])
      members.set(m.id, m);
  const facts: Fact[] = [];
  for (const f of fixtures) {
    const mine = rubbers.filter((r) => r.fixture_id === f.id);
    const playedRubbers = mine.filter((r) => r.played);
    const forfeit = f.status === "forfeit";
    // The teams' result: games won each; the whole-team match's own score gives a margin where it is a tally.
    if (f.home_team_id && f.away_team_id && f.home_team_id !== f.away_team_id && playedRubbers.length > 0) {
      const home = playedRubbers.filter((r) => r.winner === "home").length;
      const away = playedRubbers.filter((r) => r.winner === "away").length;
      const outcome = home > away ? 1 : away > home ? 0 : 0.5;
      const kind: ResultKind = forfeit ? "walkover" : "played";
      const margin = !forfeit && rules.scoring.kind === "tally" && mine.length === 1 ? tallyMargin(mine[0].score) : null;
      facts.push({
        format: "team",
        sourceMatch: f.id,
        unitNo: 0,
        resultRef: f.id,
        playedOn: f.date,
        playOrder: f.start_min,
        outcome,
        kind,
        margin,
        hash: hashOf({ format: "team", outcome, kind, margin, r: [f.id, f.home_team_id, f.away_team_id, home, away] }),
        a: [{ kind: "team", id: f.home_team_id, label: f.home_name }],
        b: [{ kind: "team", id: f.away_team_id, label: f.away_name }],
      });
    }
    // Each singles or doubles game of it: the people picked to play it.
    for (const r of mine) {
      if (r.kind === "team" || !r.played) continue;
      const side = (s: "home" | "away") => {
        const picks = lineups.filter((x) => x.fixture_id === f.id && x.rubber_no === r.rubber_no && x.side === s);
        return {
          ids: picks.map((x) => x.id),
          subjects: uniqueSubjects(
            picks.map((x): SubjectRef | null => {
              const m = x.team_member_id !== null ? members.get(x.team_member_id) : undefined;
              if (!m) return null;
              if (m.participant_id) return { kind: "participant", id: m.participant_id, label: "" };
              return m.user_id ? { kind: "user", id: m.user_id, label: x.name } : null;
            })
          ),
        };
      };
      const home = side("home");
      const away = side("away");
      if (home.subjects.length === 0 || away.subjects.length === 0) continue;
      const outcome = r.winner === "home" ? 1 : r.winner === "away" ? 0 : 0.5;
      const kind: ResultKind = r.walkover || forfeit ? "walkover" : "played";
      const margin = !r.walkover && !forfeit && rules.scoring.kind === "tally" ? tallyMargin(r.score) : null;
      facts.push({
        format: r.kind,
        sourceMatch: f.id,
        unitNo: r.rubber_no,
        resultRef: r.id,
        playedOn: f.date,
        playOrder: f.start_min,
        outcome,
        kind,
        margin,
        hash: hashOf({ format: r.kind, outcome, kind, margin, r: [r.id, home.ids, away.ids] }),
        a: home.subjects,
        b: away.subjects,
      });
    }
  }
  return { ...base, facts };
}

async function factsOf(kind: SourceKind, id: number): Promise<EventFacts | null> {
  return kind === "tournament" ? tournamentFacts(id) : kind === "league" ? leagueFacts(id) : teamLeagueFacts(id);
}

/** A string that changes whenever anything the facts are read from does: what the scheduled catch-up compares. */
async function fingerprintOf(kind: SourceKind, id: number): Promise<string | null> {
  const sql =
    kind === "tournament"
      ? `SELECT t.status || '|' || t.rated::text || '|' ||
           COALESCE((SELECT md5(string_agg(m.id::text || ':' || m.status || ':' || COALESCE(m.winner, 0)::text || ':' || COALESCE(m.score, '') || ':' || COALESCE(m.entry_a, 0)::text || ':' || COALESCE(m.entry_b, 0)::text, ',' ORDER BY m.id)) FROM tournament_matches m WHERE m.tournament_id = t.id), '') || '|' ||
           COALESCE((SELECT md5(string_agg(e.id::text || ':' || COALESCE(e.out_reason, '') || ':' || COALESCE(e.out_stage, '') || ':' || COALESCE(e.team_id, 0)::text, ',' ORDER BY e.id)) FROM tournament_entries e WHERE e.tournament_id = t.id), '') AS fp
         FROM tournaments t WHERE t.id = ?`
      : kind === "league"
        ? `SELECT l.status || '|' || l.rated::text || '|' ||
             COALESCE((SELECT md5(string_agg(m.id::text || ':' || m.status || ':' || COALESCE(m.winner, 0)::text || ':' || COALESCE(m.score, '') || ':' || m.version::text, ',' ORDER BY m.id)) FROM league_matches m JOIN league_seasons s ON s.id = m.season_id WHERE s.league_id = l.id), '') AS fp
           FROM leagues l WHERE l.id = ?`
        : `SELECT l.status || '|' || l.rated::text || '|' ||
             COALESCE((SELECT md5(string_agg(f.id::text || ':' || f.status || ':' || f.version::text, ',' ORDER BY f.id)) FROM team_fixtures f WHERE f.league_id = l.id), '') || '|' ||
             COALESCE((SELECT md5(string_agg(tt.id::text || ':' || COALESCE(tt.team_id, 0)::text, ',' ORDER BY tt.id)) FROM team_league_teams tt WHERE tt.league_id = l.id), '') AS fp
           FROM team_leagues l WHERE l.id = ?`;
  const row = (await getDb().prepare(sql).get(id)) as { fp: string } | undefined;
  return row?.fp ?? null;
}

// ------------------------------------------------------------ reading an event into the ledger

export interface SyncSummary {
  added: number;
  voided: number;
  pools: { venueId: number; sport: string; format: RatingFormat }[];
}

interface LiveRow {
  id: number;
  format: RatingFormat;
  source_match: number;
  unit_no: number;
  fact_hash: string;
}

const poolKey = (p: { venueId: number; sport: string; format: string }) => `${p.venueId}|${p.sport}|${p.format}`;

/**
 * Read an event's results as they stand now into the ledger, and recompute the pools they touch. A result no longer
 * standing (corrected, struck, voided by the event's rules, the event called off or no longer rated) has its row voided; one
 * that stands and is not in the ledger gets a row; one that is there unchanged is left alone. Safe to run twice: the second
 * run finds nothing to do. One event is read at a time (its `rating_syncs` row is locked), and each pool is
 * recomputed under its own lock, taken in a fixed order.
 */
export async function syncRatedEvent(kind: SourceKind, id: number): Promise<SyncSummary> {
  return withTransaction(async () => {
    const db = getDb();
    await db.prepare("INSERT INTO rating_syncs (source_kind, source_id, fingerprint) VALUES (?, ?, '') ON CONFLICT DO NOTHING").run(kind, id);
    await db.prepare("SELECT source_id FROM rating_syncs WHERE source_kind = ? AND source_id = ? FOR UPDATE").get(kind, id);
    const event = await factsOf(kind, id);
    const live = (await db
      .prepare("SELECT id, format, source_match, unit_no, fact_hash FROM rated_results WHERE source_kind = ? AND source_id = ? AND voided_at IS NULL")
      .all(kind, id)) as LiveRow[];
    const summary: SyncSummary = { added: 0, voided: 0, pools: [] };
    const touched = new Map<string, { venueId: number; sport: string; format: RatingFormat }>();
    const touch = (venueId: number, sport: string, format: RatingFormat) => touched.set(poolKey({ venueId, sport, format }), { venueId, sport, format });
    const wanted = new Map((event?.facts ?? []).map((f) => [`${f.sourceMatch}:${f.unitNo}`, f]));
    const poolOf = async (resultId: number) =>
      (await db.prepare("SELECT venue_id, sport, format FROM rated_results WHERE id = ?").get(resultId)) as { venue_id: number; sport: string; format: RatingFormat };
    const gone = event === null ? "event_removed" : wanted.size === 0 ? "not_counted" : "result_changed";
    for (const row of live) {
      const f = wanted.get(`${row.source_match}:${row.unit_no}`);
      if (f && f.hash === row.fact_hash && f.format === row.format) continue;
      const pool = await poolOf(row.id);
      await db.prepare("UPDATE rated_results SET voided_at = datetime('now'), voided_reason = ? WHERE id = ?").run(f ? "result_changed" : gone, row.id);
      touch(pool.venue_id, pool.sport, pool.format);
      summary.voided++;
    }
    const stillLive = new Set(
      ((await db.prepare("SELECT source_match, unit_no FROM rated_results WHERE source_kind = ? AND source_id = ? AND voided_at IS NULL").all(kind, id)) as { source_match: number; unit_no: number }[]).map(
        (r) => `${r.source_match}:${r.unit_no}`
      )
    );
    if (event) {
      for (const f of wanted.values()) {
        if (stillLive.has(`${f.sourceMatch}:${f.unitNo}`)) continue;
        // A result written again keeps where the first one fell in the order, so a correction never moves it.
        const before = (await db
          .prepare("SELECT played_on, play_order FROM rated_results WHERE source_kind = ? AND source_id = ? AND source_match = ? AND unit_no = ? ORDER BY id DESC LIMIT 1")
          .get(kind, id, f.sourceMatch, f.unitNo)) as { played_on: string; play_order: number } | undefined;
        const made = (await db
          .prepare(
            `INSERT INTO rated_results (venue_id, sport, format, source_kind, source_id, source_match, unit_no, result_ref, event_name, played_on, play_order, outcome, kind, margin, fact_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
          )
          .get(
            event.venueId,
            event.sport,
            f.format,
            kind,
            id,
            f.sourceMatch,
            f.unitNo,
            f.resultRef,
            event.name,
            before?.played_on ?? f.playedOn,
            before?.play_order ?? f.playOrder,
            f.outcome,
            f.kind,
            f.margin,
            f.hash
          )) as { id: number };
        for (const [side, subjects] of [["a", f.a], ["b", f.b]] as const)
          for (const s of subjects)
            await db.prepare("INSERT INTO rated_result_subjects (result_id, side, subject_kind, subject_id, label) VALUES (?, ?, ?, ?, ?)").run(made.id, side, s.kind, s.id, s.label);
        touch(event.venueId, event.sport, f.format);
        summary.added++;
      }
    }
    summary.pools = [...touched.values()].sort((x, y) => (poolKey(x) < poolKey(y) ? -1 : 1));
    for (const p of summary.pools) await recomputePool(p.venueId, p.sport, p.format);
    const fp = (await fingerprintOf(kind, id)) ?? "";
    await db.prepare("UPDATE rating_syncs SET fingerprint = ?, synced_at = datetime('now') WHERE source_kind = ? AND source_id = ?").run(fp, kind, id);
    return summary;
  });
}

/**
 * What the code that changes results calls once it has committed: read the event into the ledger. It never fails the change
 * that caused it (an error is logged and the scheduled catch-up reads the event again), and costs two cheap queries for
 * an event that is not rated.
 */
export async function ratedAfter(kind: SourceKind, id: number): Promise<void> {
  try {
    const table = kind === "tournament" ? "tournaments" : kind === "league" ? "leagues" : "team_leagues";
    const db = getDb();
    const row = (await db.prepare(`SELECT rated FROM ${table} WHERE id = ?`).get(id)) as { rated: boolean } | undefined;
    if (!row) return;
    if (!row.rated) {
      const any = await db.prepare("SELECT 1 AS x FROM rated_results WHERE source_kind = ? AND source_id = ? AND voided_at IS NULL LIMIT 1").get(kind, id);
      if (!any) return;
    }
    await aside(() => syncRatedEvent(kind, id));
  } catch (err) {
    if (mustRethrow(err)) throw err;
    console.error("[mysenam] reading an event's results into the ratings failed; the scheduler will read it again:", err);
  }
}

/**
 * The scheduled catch-up (lib/scheduler.ts): read again every rated event whose results differ from the last read, and
 * recompute any pool last computed under older rules. Re-running it changes nothing it has already put right.
 */
export async function ratingsCatchUp(): Promise<{ events: number; pools: number }> {
  const db = getDb();
  let events = 0;
  for (const [kind, table] of [["tournament", "tournaments"], ["league", "leagues"], ["team_league", "team_leagues"]] as const) {
    const candidates = (await db
      .prepare(
        `SELECT x.id FROM ${table} x
          WHERE x.rated OR EXISTS (SELECT 1 FROM rated_results r WHERE r.source_kind = ? AND r.source_id = x.id AND r.voided_at IS NULL)
          ORDER BY x.id LIMIT 1000`
      )
      .all(kind)) as { id: number }[];
    for (const c of candidates) {
      const synced = (await db.prepare("SELECT fingerprint FROM rating_syncs WHERE source_kind = ? AND source_id = ?").get(kind, c.id)) as { fingerprint: string } | undefined;
      if (synced && synced.fingerprint === (await fingerprintOf(kind, c.id))) continue;
      try {
        await syncRatedEvent(kind, c.id);
        events++;
      } catch (err) {
        console.error(`[mysenam] ratings catch-up of ${kind} ${c.id} failed:`, err);
      }
    }
  }
  const { version } = await ratingRulesNow();
  const stale = (await db.prepare("SELECT venue_id, sport, format FROM rating_pools WHERE rules_version <> ? ORDER BY venue_id, sport, format LIMIT 200").all(version)) as { venue_id: number; sport: string; format: RatingFormat }[];
  for (const p of stale) await withTransaction(() => recomputePool(p.venue_id, p.sport, p.format));
  return { events, pools: stale.length };
}

// ------------------------------------------------------------ recomputing a pool

const memberKey = (kind: string, id: number | null, rowId: number) => (kind === "removed" || id === null ? `removed:${rowId}` : `${kind}:${id}`);

/** The pool's ratings, replayed from its ledger: the one place a rating is computed. Takes the pool's row lock. */
export async function recomputePool(venueId: number, sport: string, format: RatingFormat): Promise<void> {
  await withTransaction(async () => {
    const db = getDb();
    const { version, rules } = await ratingRulesNow();
    await db.prepare("INSERT INTO rating_pools (venue_id, sport, format) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(venueId, sport, format);
    await db.prepare("SELECT venue_id FROM rating_pools WHERE venue_id = ? AND sport = ? AND format = ? FOR UPDATE").get(venueId, sport, format);
    const results = (await db
      .prepare(
        `SELECT r.id, r.source_kind, r.source_id, r.source_match, r.unit_no, r.played_on, r.play_order, r.outcome, r.kind, r.margin,
                r.weight, r.margin_factor, r.side_a_rating, r.side_b_rating, r.expected_a,
                EXISTS (SELECT 1 FROM rating_exclusions x WHERE x.lifted_at IS NULL AND x.source_kind = r.source_kind AND x.source_id = r.source_id
                           AND x.source_match = r.source_match AND x.unit_no = r.unit_no) AS excluded
           FROM rated_results r WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL ORDER BY r.id`
      )
      .all(venueId, sport, format)) as {
      id: number;
      source_kind: string;
      source_id: number;
      source_match: number;
      unit_no: number;
      played_on: string;
      play_order: number;
      outcome: string | number;
      kind: ResultKind;
      margin: number | null;
      weight: string | null;
      margin_factor: string | null;
      side_a_rating: string | null;
      side_b_rating: string | null;
      expected_a: string | null;
      excluded: boolean;
    }[];
    const subjects = (await db
      .prepare(
        `SELECT s.id, s.result_id, s.side, s.subject_kind, s.subject_id, s.frozen_rating, s.rating_before, s.rating_after, s.k, s.games_before
           FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id
          WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL ORDER BY s.id`
      )
      .all(venueId, sport, format)) as {
      id: number;
      result_id: number;
      side: "a" | "b";
      subject_kind: string;
      subject_id: number | null;
      frozen_rating: string | null;
      rating_before: string | null;
      rating_after: string | null;
      k: string | null;
      games_before: number | null;
    }[];
    const byResult = new Map<number, typeof subjects>();
    for (const s of subjects) byResult.set(s.result_id, [...(byResult.get(s.result_id) ?? []), s]);
    const rows: ReplayRow[] = [];
    const orders = new Map<number, string>();
    for (const r of results) {
      const order = orderKey({ playedOn: r.played_on, playOrder: r.play_order, sourceKind: r.source_kind, sourceId: r.source_id, sourceMatch: r.source_match, unitNo: r.unit_no });
      orders.set(r.id, order);
      if (r.excluded) continue;
      const members = (side: "a" | "b"): ReplayMember[] =>
        (byResult.get(r.id) ?? [])
          .filter((s) => s.side === side)
          .map((s) => ({ key: memberKey(s.subject_kind, s.subject_id, s.id), ...(s.subject_kind === "removed" ? { frozen: s.frozen_rating === null ? rules.start : Number(s.frozen_rating) } : {}) }));
      rows.push({ id: r.id, order, outcome: Number(r.outcome), kind: r.kind, margin: r.margin, a: members("a"), b: members("b") });
    }
    const resetRows = (await db
      .prepare("SELECT subject_kind, subject_id, cutoff_key FROM rating_resets WHERE venue_id = ? AND sport = ? AND format = ? ORDER BY id")
      .all(venueId, sport, format)) as { subject_kind: string; subject_id: number; cutoff_key: string }[];
    // The latest reset of each subject is the one that applies.
    const resets = new Map<string, string>();
    for (const x of resetRows) resets.set(`${x.subject_kind}:${x.subject_id}`, x.cutoff_key);
    const out = replay(rows, rules, resets);

    // Write what changed.
    const num = (v: string | null) => (v === null ? null : Number(v));
    for (const r of results) {
      const o = out.rows.get(r.id);
      const next = o ? { weight: o.weight, mf: o.marginFactor, a: o.sideA, b: o.sideB, e: o.expectedA } : null;
      const same = next
        ? num(r.weight) === next.weight && num(r.margin_factor) === next.mf && num(r.side_a_rating) === next.a && num(r.side_b_rating) === next.b && num(r.expected_a) === next.e
        : r.weight === null && r.margin_factor === null && r.side_a_rating === null && r.side_b_rating === null && r.expected_a === null;
      if (!same)
        await db
          .prepare("UPDATE rated_results SET weight = ?, margin_factor = ?, side_a_rating = ?, side_b_rating = ?, expected_a = ? WHERE id = ?")
          .run(next?.weight ?? null, next?.mf ?? null, next?.a ?? null, next?.b ?? null, next?.e ?? null, r.id);
    }
    for (const s of subjects) {
      const o = out.rows.get(s.result_id)?.members.get(`${s.side}:${memberKey(s.subject_kind, s.subject_id, s.id)}`);
      const same = o
        ? num(s.rating_before) === o.before && num(s.rating_after) === o.after && num(s.k) === o.k && s.games_before === o.gamesBefore
        : s.rating_before === null && s.rating_after === null && s.k === null && s.games_before === null;
      if (!same)
        await db
          .prepare("UPDATE rated_result_subjects SET rating_before = ?, rating_after = ?, k = ?, games_before = ? WHERE id = ?")
          .run(o?.before ?? null, o?.after ?? null, o?.k ?? null, o?.gamesBefore ?? null, s.id);
    }
    await db.prepare("DELETE FROM rating_subjects WHERE venue_id = ? AND sport = ? AND format = ?").run(venueId, sport, format);
    for (const [key, st] of out.subjects) {
      // Somebody whose results moved nothing yet (a walkover only) has no rating to show.
      if (key.startsWith("removed:") || st.games === 0) continue;
      const [kind, id] = key.split(":");
      await db
        .prepare(
          `INSERT INTO rating_subjects (venue_id, sport, format, subject_kind, subject_id, rating, games, wins, draws, losses, last_played_on)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(venueId, sport, format, kind, Number(id), st.rating, st.games, st.wins, st.draws, st.losses, st.lastOrder ? st.lastOrder.slice(0, 10) : null);
    }
    await db.prepare("UPDATE rating_pools SET rules_version = ?, recomputed_at = datetime('now') WHERE venue_id = ? AND sport = ? AND format = ?").run(version, venueId, sport, format);
  });
}

// ------------------------------------------------------------ which events count

export interface RatedEvent {
  kind: SourceKind;
  id: number;
  name: string;
  sport: string;
  rated: boolean;
  /** A manager can change it until the event starts. */
  canChange: boolean;
  /** Results in the ledger now. */
  counted: number;
}

const EVENT_SQL: Record<SourceKind, string> = {
  tournament: `SELECT t.id, t.venue_id, t.name, t.sport, t.rated, (t.status IN ('open', 'closed') AND t.format <> 'performance') AS can_change
                 FROM tournaments t WHERE t.venue_id = ? AND t.status <> 'cancelled' AND t.format <> 'performance' ORDER BY t.id DESC LIMIT 100`,
  league: `SELECT l.id, l.venue_id, l.name, l.sport, l.rated, (l.status = 'running' AND NOT EXISTS (SELECT 1 FROM league_seasons s WHERE s.league_id = l.id AND s.status <> 'forming')) AS can_change
             FROM leagues l WHERE l.venue_id = ? AND l.status = 'running' ORDER BY l.id DESC LIMIT 100`,
  team_league: `SELECT l.id, l.venue_id, l.name, l.sport, l.rated, (l.status = 'forming') AS can_change
                  FROM team_leagues l WHERE l.venue_id = ? AND l.status <> 'closed' ORDER BY l.id DESC LIMIT 100`,
};

/** A venue's events that could be rated, for its manager. */
export async function venueRatedEvents(venueId: number): Promise<RatedEvent[]> {
  const db = getDb();
  const out: RatedEvent[] = [];
  for (const kind of SOURCE_KINDS) {
    const rows = (await db.prepare(EVENT_SQL[kind]).all(venueId)) as { id: number; name: string; sport: string; rated: boolean; can_change: boolean }[];
    for (const r of rows) {
      const counted = (await db.prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = ? AND source_id = ? AND voided_at IS NULL").get(kind, r.id)) as { n: number };
      out.push({ kind, id: r.id, name: r.name, sport: r.sport, rated: r.rated === true, canChange: r.can_change === true, counted: counted.n });
    }
  }
  return out;
}

/** The venue an event belongs to, or null. */
export async function eventVenue(kind: SourceKind, id: number): Promise<{ venueId: number; name: string } | null> {
  const table = kind === "tournament" ? "tournaments" : kind === "league" ? "leagues" : "team_leagues";
  const row = (await getDb().prepare(`SELECT venue_id, name FROM ${table} WHERE id = ?`).get(id)) as { venue_id: number; name: string } | undefined;
  return row ? { venueId: row.venue_id, name: row.name } : null;
}

/**
 * Mark an event as rated, or not (a manager's, before it starts). Its results already in then enter the ledger; the ledger is the
 * same as if it had been rated from the start.
 */
export async function setEventRated(kind: SourceKind, id: number, rated: boolean): Promise<RatingResult<{ rated: boolean; name: string; venueId: number }>> {
  const info = await eventVenue(kind, id);
  if (!info) return ratingRefusal("RT_NOT_FOUND", {}, 404);
  const events = await venueRatedEvents(info.venueId);
  const event = events.find((e) => e.kind === kind && e.id === id);
  if (!event) return ratingRefusal("RT_NOT_FOUND", {}, 404);
  if (event.rated === rated) return { ok: true, value: { rated, name: info.name, venueId: info.venueId } };
  if (!event.canChange) return ratingRefusal("RT_STARTED");
  const table = kind === "tournament" ? "tournaments" : kind === "league" ? "leagues" : "team_leagues";
  await getDb().prepare(`UPDATE ${table} SET rated = ? WHERE id = ?`).run(rated, id);
  await syncRatedEvent(kind, id);
  return { ok: true, value: { rated, name: info.name, venueId: info.venueId } };
}

// ------------------------------------------------------------ managers: leave a result out, start a rating again

const REASON_MIN = 3;
const REASON_MAX = 200;
const reasonOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length >= REASON_MIN && s.length <= REASON_MAX ? s : null;
};

interface LedgerKey {
  sourceKind: SourceKind;
  sourceId: number;
  sourceMatch: number;
  unitNo: number;
}

/** Leave one result out of the ratings, with a reason. It stays in the ledger, and comes back if the exclusion is lifted. */
export async function excludeResult(venueId: number, key: LedgerKey, reason: unknown, by: string): Promise<RatingResult<{ id: number }>> {
  const why = reasonOf(reason);
  if (!why) return ratingRefusal("RT_REASON", {}, 400);
  return withTransaction(async () => {
    const db = getDb();
    const row = (await db
      .prepare("SELECT sport, format FROM rated_results WHERE venue_id = ? AND source_kind = ? AND source_id = ? AND source_match = ? AND unit_no = ? AND voided_at IS NULL")
      .get(venueId, key.sourceKind, key.sourceId, key.sourceMatch, key.unitNo)) as { sport: string; format: RatingFormat } | undefined;
    if (!row) return ratingRefusal("RT_NOT_A_RESULT", {}, 404);
    const have = await db
      .prepare("SELECT id FROM rating_exclusions WHERE source_kind = ? AND source_id = ? AND source_match = ? AND unit_no = ? AND lifted_at IS NULL")
      .get(key.sourceKind, key.sourceId, key.sourceMatch, key.unitNo);
    if (have) return ratingRefusal("RT_ALREADY_EXCLUDED");
    const made = (await db
      .prepare("INSERT INTO rating_exclusions (venue_id, source_kind, source_id, source_match, unit_no, reason, by_name) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get(venueId, key.sourceKind, key.sourceId, key.sourceMatch, key.unitNo, why, by)) as { id: number };
    await recomputePool(venueId, row.sport, row.format);
    return { ok: true as const, value: { id: made.id } };
  });
}

export async function liftExclusion(venueId: number, exclusionId: number, reason: unknown, by: string): Promise<RatingResult<{ id: number }>> {
  const why = reasonOf(reason);
  if (!why) return ratingRefusal("RT_REASON", {}, 400);
  return withTransaction(async () => {
    const db = getDb();
    const x = (await db
      .prepare("SELECT x.id, r.sport, r.format FROM rating_exclusions x JOIN rated_results r ON r.source_kind = x.source_kind AND r.source_id = x.source_id AND r.source_match = x.source_match AND r.unit_no = x.unit_no AND r.voided_at IS NULL WHERE x.id = ? AND x.venue_id = ? AND x.lifted_at IS NULL")
      .get(exclusionId, venueId)) as { id: number; sport: string; format: RatingFormat } | undefined;
    if (!x) {
      // An exclusion whose result has since left the ledger can still be lifted.
      const lone = await db.prepare("UPDATE rating_exclusions SET lifted_at = datetime('now'), lifted_reason = ?, lifted_by_name = ? WHERE id = ? AND venue_id = ? AND lifted_at IS NULL").run(why, by, exclusionId, venueId);
      return lone.changes > 0 ? { ok: true as const, value: { id: exclusionId } } : ratingRefusal("RT_NOT_EXCLUDED", {}, 404);
    }
    await db.prepare("UPDATE rating_exclusions SET lifted_at = datetime('now'), lifted_reason = ?, lifted_by_name = ? WHERE id = ?").run(why, by, exclusionId);
    await recomputePool(venueId, x.sport, x.format);
    return { ok: true as const, value: { id: exclusionId } };
  });
}

/**
 * Start a subject's rating again at a venue, with a reason: its results to now stay in the ledger and still count for the
 * people who played them, but its own rating and record begin again at the starting rating.
 */
export async function resetSubject(
  venueId: number,
  pool: { sport: string; format: RatingFormat },
  subject: { kind: SubjectKind; id: number },
  reason: unknown,
  by: string
): Promise<RatingResult<{ id: number }>> {
  const why = reasonOf(reason);
  if (!why) return ratingRefusal("RT_REASON", {}, 400);
  return withTransaction(async () => {
    const db = getDb();
    await db.prepare("SELECT venue_id FROM rating_pools WHERE venue_id = ? AND sport = ? AND format = ? FOR UPDATE").get(venueId, pool.sport, pool.format);
    const rows = (await db
      .prepare(
        `SELECT r.played_on, r.play_order, r.source_kind, r.source_id, r.source_match, r.unit_no FROM rated_results r JOIN rated_result_subjects s ON s.result_id = r.id
          WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL AND s.subject_kind = ? AND s.subject_id = ?`
      )
      .all(venueId, pool.sport, pool.format, subject.kind, subject.id)) as { played_on: string; play_order: number; source_kind: string; source_id: number; source_match: number; unit_no: number }[];
    if (rows.length === 0) return ratingRefusal("RT_NO_SUBJECT", {}, 404);
    const cutoff = rows
      .map((r) => orderKey({ playedOn: r.played_on, playOrder: r.play_order, sourceKind: r.source_kind, sourceId: r.source_id, sourceMatch: r.source_match, unitNo: r.unit_no }))
      .sort()
      .pop()!;
    const made = (await db
      .prepare("INSERT INTO rating_resets (venue_id, sport, format, subject_kind, subject_id, cutoff_key, reason, by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get(venueId, pool.sport, pool.format, subject.kind, subject.id, cutoff, why, by)) as { id: number };
    await recomputePool(venueId, pool.sport, pool.format);
    return { ok: true as const, value: { id: made.id } };
  });
}

// ------------------------------------------------------------ reading ratings

export const SEASONS_FROM = 2000;

export interface Standing {
  kind: SubjectKind;
  id: number;
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  provisional: boolean;
  /** Most recent first: W, D, L. */
  form: ("W" | "D" | "L")[];
  lastPlayedOn: string | null;
}

interface FoldRow {
  subject_kind: SubjectKind;
  subject_id: number;
  played_on: string;
  play_order: number;
  source_kind: string;
  source_id: number;
  source_match: number;
  unit_no: number;
  side: "a" | "b";
  outcome: string;
  weight: string;
  rating_after: string;
  games_before: number;
}

/**
 * Everybody in a pool as the ledger puts them, folded from its counted rows: the rating after their last result (in the
 * `season` year if one is given), the record in it, and their latest results. Provisional ones are included, flagged;
 * a caller that ranks leaves them out.
 */
export async function poolStandings(venueId: number, sport: string, format: RatingFormat, opts: { season?: number; rules?: RatingRules } = {}): Promise<Standing[]> {
  const rules = opts.rules ?? (await ratingRulesNow()).rules;
  const season = opts.season !== undefined ? [`${opts.season}-01-01`, `${opts.season}-12-31`] : null;
  const rows = (await getDb()
    .prepare(
      `SELECT s.subject_kind, s.subject_id, r.played_on, r.play_order, r.source_kind, r.source_id, r.source_match, r.unit_no, s.side, r.outcome, r.weight, s.rating_after, s.games_before
         FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id
        WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL AND r.weight > 0 AND s.subject_id IS NOT NULL AND s.rating_after IS NOT NULL
          ${season ? "AND r.played_on >= ? AND r.played_on <= ?" : ""}`
    )
    .all(venueId, sport, format, ...(season ?? []))) as FoldRow[];
  const resets = (await getDb().prepare("SELECT subject_kind, subject_id, cutoff_key FROM rating_resets WHERE venue_id = ? AND sport = ? AND format = ? ORDER BY id").all(venueId, sport, format)) as {
    subject_kind: string;
    subject_id: number;
    cutoff_key: string;
  }[];
  const cut = new Map<string, string>();
  for (const x of resets) cut.set(`${x.subject_kind}:${x.subject_id}`, x.cutoff_key);
  const by = new Map<string, { row: FoldRow; order: string; result: number }[]>();
  for (const r of rows) {
    const key = `${r.subject_kind}:${r.subject_id}`;
    const order = orderKey({ playedOn: r.played_on, playOrder: r.play_order, sourceKind: r.source_kind, sourceId: r.source_id, sourceMatch: r.source_match, unitNo: r.unit_no });
    // Results before a reset are history: the record and the form begin again after it.
    const reset = cut.get(key);
    if (reset !== undefined && order <= reset) continue;
    const a = Number(r.outcome);
    by.set(key, [...(by.get(key) ?? []), { row: r, order, result: r.side === "a" ? a : 1 - a }]);
  }
  const out: Standing[] = [];
  for (const [key, list] of by) {
    list.sort((x, y) => (x.order < y.order ? -1 : 1));
    const last = list[list.length - 1];
    const [kind, id] = key.split(":");
    const wins = list.filter((x) => x.result === 1).length;
    const losses = list.filter((x) => x.result === 0).length;
    const draws = list.length - wins - losses;
    out.push({
      kind: kind as SubjectKind,
      id: Number(id),
      rating: Number(last.row.rating_after),
      games: season ? last.row.games_before + 1 : list.length,
      wins,
      draws,
      losses,
      provisional: isProvisional(rules, season ? last.row.games_before + 1 : list.length),
      form: list.slice(-rules.formLength).reverse().map((x) => (x.result === 1 ? "W" : x.result === 0 ? "L" : "D")),
      lastPlayedOn: last.row.played_on,
    });
  }
  return out;
}

/** A subject's standing in a pool now, or null where it has none. */
export async function currentStanding(venueId: number, sport: string, format: RatingFormat, kind: SubjectKind, id: number): Promise<{ rating: number; games: number; provisional: boolean } | null> {
  const row = (await getDb()
    .prepare("SELECT rating, games FROM rating_subjects WHERE venue_id = ? AND sport = ? AND format = ? AND subject_kind = ? AND subject_id = ?")
    .get(venueId, sport, format, kind, id)) as { rating: string; games: number } | undefined;
  if (!row) return null;
  const { rules } = await ratingRulesNow();
  return { rating: Number(row.rating), games: row.games, provisional: isProvisional(rules, row.games) };
}

// ----- what the public sees

export interface BoardRow {
  rank: number;
  kind: "person" | "team";
  name: string;
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  form: ("W" | "D" | "L")[];
  /** On a business-wide board: the branch whose pool this is. */
  venue?: string;
}

export interface Board {
  venueId: number;
  venueName: string;
  sport: string;
  format: RatingFormat;
  /** A year, or "all". */
  season: string;
  rows: BoardRow[];
}

/** The pools of a venue that have anything counted, and the years results fall in. */
export async function boardChoices(venueId: number): Promise<{ pools: { sport: string; format: RatingFormat }[]; seasons: number[] }> {
  const db = getDb();
  const pools = (await db
    .prepare("SELECT DISTINCT sport, format FROM rated_results WHERE venue_id = ? AND voided_at IS NULL AND weight > 0 ORDER BY sport, format")
    .all(venueId)) as { sport: string; format: RatingFormat }[];
  const years = (await db.prepare("SELECT DISTINCT substr(played_on, 1, 4) AS y FROM rated_results WHERE venue_id = ? AND voided_at IS NULL AND weight > 0 ORDER BY y DESC").all(venueId)) as { y: string }[];
  return { pools, seasons: years.map((y) => Number(y.y)).filter((y) => y >= SEASONS_FROM) };
}

/**
 * Who a public ranking may show, and by what name: a declared adult who chose to be listed, under the name they gave; a team its
 * captain published. Nobody else: not a child, not a person who has not said yes, not a provisional rating.
 */
async function publicNames(people: number[], teams: number[]): Promise<{ people: Map<number, string>; teams: Map<number, string> }> {
  const db = getDb();
  const p = new Map<number, string>();
  const t = new Map<number, string>();
  if (people.length > 0)
    for (const r of (await db
      .prepare(`SELECT user_id, rank_name FROM player_profiles WHERE user_id IN (${people.map(() => "?").join(",")}) AND rank_publicly = 1 AND adult = 1 AND rank_name IS NOT NULL AND rank_name <> ''`)
      .all(...people)) as { user_id: number; rank_name: string }[])
      p.set(r.user_id, r.rank_name);
  if (teams.length > 0)
    for (const r of (await db.prepare(`SELECT id, name FROM teams WHERE id IN (${teams.map(() => "?").join(",")}) AND published = true AND status = 'active'`).all(...teams)) as { id: number; name: string }[])
      t.set(r.id, r.name);
  return { people: p, teams: t };
}

async function boardOf(venueId: number, venueName: string, sport: string, format: RatingFormat, season: number | undefined, rules: RatingRules): Promise<BoardRow[]> {
  const all = (await poolStandings(venueId, sport, format, { season, rules })).filter((s) => !s.provisional && s.kind !== "participant");
  const names = await publicNames(
    all.filter((s) => s.kind === "user").map((s) => s.id),
    all.filter((s) => s.kind === "team").map((s) => s.id)
  );
  const rows: Omit<BoardRow, "rank">[] = [];
  for (const s of all) {
    const name = s.kind === "user" ? names.people.get(s.id) : names.teams.get(s.id);
    if (!name) continue;
    rows.push({ kind: s.kind === "team" ? "team" : "person", name, rating: Math.round(s.rating), games: s.games, wins: s.wins, draws: s.draws, losses: s.losses, form: s.form, venue: venueName });
  }
  rows.sort((x, y) => y.rating - x.rating || y.games - x.games || x.name.localeCompare(y.name));
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** A venue's public ranking for a sport and format: only people who chose to be listed, and published teams, non-provisional. */
export async function venueBoard(venueId: number, sport: string, format: RatingFormat, opts: { season?: number } = {}): Promise<Board | null> {
  const venue = (await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(venueId)) as { name: string } | undefined;
  if (!venue) return null;
  const { rules } = await ratingRulesNow();
  const rows = (await boardOf(venueId, venue.name, sport, format, opts.season, rules)).map(({ venue: _v, ...r }) => r);
  return { venueId, venueName: venue.name, sport, format, season: opts.season === undefined ? "all" : String(opts.season), rows };
}

/**
 * The branches of a venue's business side by side, for the branches that allow it (and only if this venue does): each branch's
 * own pool, not a merged rating, as the pools are per venue. Null where the venue is on its own or has not allowed it.
 */
export async function businessBoard(venueId: number, sport: string, format: RatingFormat, opts: { season?: number } = {}): Promise<Board | null> {
  const db = getDb();
  const own = (await db.prepare("SELECT v.name, v.business_id, COALESCE(s.business_board, false) AS allowed FROM venues v LEFT JOIN venue_rating_settings s ON s.venue_id = v.id WHERE v.id = ?").get(venueId)) as
    | { name: string; business_id: number | null; allowed: boolean }
    | undefined;
  if (!own || own.business_id === null || !own.allowed) return null;
  const branches = (await db
    .prepare("SELECT v.id, v.name FROM venues v JOIN venue_rating_settings s ON s.venue_id = v.id WHERE v.business_id = ? AND s.business_board = true ORDER BY v.id")
    .all(own.business_id)) as { id: number; name: string }[];
  const { rules } = await ratingRulesNow();
  const rows: BoardRow[] = [];
  for (const b of branches) rows.push(...(await boardOf(b.id, b.name, sport, format, opts.season, rules)));
  rows.sort((x, y) => y.rating - x.rating || y.games - x.games || x.name.localeCompare(y.name));
  return { venueId, venueName: own.name, sport, format, season: opts.season === undefined ? "all" : String(opts.season), rows: rows.map((r, i) => ({ ...r, rank: i + 1 })) };
}

export async function setBusinessBoard(venueId: number, allowed: boolean): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO venue_rating_settings (venue_id, business_board) VALUES (?, ?)
       ON CONFLICT (venue_id) DO UPDATE SET business_board = excluded.business_board, updated_at = datetime('now')`
    )
    .run(venueId, allowed);
}

export async function businessBoardAllowed(venueId: number): Promise<boolean> {
  const row = (await getDb().prepare("SELECT business_board FROM venue_rating_settings WHERE venue_id = ?").get(venueId)) as { business_board: boolean } | undefined;
  return row?.business_board === true;
}

// ----- what a player (or a guardian) sees of their own

export interface MyPool {
  venueId: number;
  venueName: string;
  sport: string;
  format: RatingFormat;
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  provisional: boolean;
  /** The declared level this rating earns, shown only once it is not provisional. */
  earns: Level | null;
  form: ("W" | "D" | "L")[];
}

export interface MyRatings {
  /** The account's own, and then each child it acts for. */
  who: { participantId: number | null; name: string | null; pools: MyPool[] }[];
  /** Teams the account is on, or acts for a child who is: a team's rating is shown to its members. */
  teams: { teamId: number; name: string; pools: MyPool[] }[];
}

async function poolsOf(kind: SubjectKind, id: number, rules: RatingRules): Promise<MyPool[]> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT s.venue_id, v.name AS venue_name, s.sport, s.format FROM rating_subjects s JOIN venues v ON v.id = s.venue_id
        WHERE s.subject_kind = ? AND s.subject_id = ? ORDER BY v.name, s.sport, s.format`
    )
    .all(kind, id)) as { venue_id: number; venue_name: string; sport: string; format: RatingFormat }[];
  const out: MyPool[] = [];
  for (const r of rows) {
    const st = (await poolStandings(r.venue_id, r.sport, r.format, { rules })).find((s) => s.kind === kind && s.id === id);
    if (!st) continue;
    out.push({
      venueId: r.venue_id,
      venueName: r.venue_name,
      sport: r.sport,
      format: r.format,
      rating: Math.round(st.rating),
      games: st.games,
      wins: st.wins,
      draws: st.draws,
      losses: st.losses,
      provisional: st.provisional,
      earns: st.provisional ? null : levelOfRating(rules, st.rating),
      form: st.form,
    });
  }
  return out;
}

export async function myRatings(userId: number): Promise<MyRatings> {
  const { rules } = await ratingRulesNow();
  const kids = (await getDb().prepare(`SELECT p.id, p.display_name FROM participants p WHERE ${ACTS_FOR("p")} ORDER BY p.id`).all(userId, userId)) as { id: number; display_name: string }[];
  const who: MyRatings["who"] = [{ participantId: null, name: null, pools: await poolsOf("user", userId, rules) }];
  for (const k of kids) {
    const pools = await poolsOf("participant", k.id, rules);
    if (pools.length > 0) who.push({ participantId: k.id, name: k.display_name, pools });
  }
  const mine = (await getDb()
    .prepare(
      `SELECT DISTINCT t.id, t.name FROM teams t JOIN team_members m ON m.team_id = t.id
        WHERE m.status = 'member' AND (m.user_id = ? OR m.acting_user_id = ?) ORDER BY t.name, t.id`
    )
    .all(userId, userId)) as { id: number; name: string }[];
  const teams: MyRatings["teams"] = [];
  for (const t of mine) {
    const pools = await poolsOf("team", t.id, rules);
    if (pools.length > 0) teams.push({ teamId: t.id, name: t.name, pools });
  }
  return { who, teams };
}

export interface HistoryLine {
  resultId: number;
  eventName: string;
  playedOn: string;
  kind: ResultKind;
  /** The subject's own result. */
  result: "win" | "draw" | "loss";
  /** Who they played, as the event showed them; a child is "a junior player" (empty label). */
  opponents: { label: string; junior: boolean }[];
  /** Counted in the rating: false for a walkover that moved nothing, or a result a manager left out. */
  counted: boolean;
  excluded: boolean;
  ratingBefore: number | null;
  ratingAfter: number | null;
  change: number | null;
  k: number | null;
  /** The chance (percent) this side was given to win. Exact when the opponent's rating is public to them, else to the nearest ten. */
  expected: number | null;
  expectedExact: boolean;
  /** The opposing side's rating then, only where everybody on it has made their rating visible. */
  opponentRating: number | null;
  weight: number | null;
  marginFactor: number | null;
  /** Before a manager restarted this rating: still explains the results, no longer counts to the record. */
  beforeReset: boolean;
}

/**
 * A subject's results in a pool, newest first, each explained: the opponent, what the rating expected, what happened and
 * how far it moved. What is shown of an opponent is what the event showed of them; their rating only if they chose to show it.
 */
export async function ratingHistory(
  venueId: number,
  sport: string,
  format: RatingFormat,
  subject: { kind: SubjectKind; id: number },
  opts: { limit?: number } = {}
): Promise<HistoryLine[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const mine = (await db
    .prepare(
      `SELECT r.id, r.event_name, r.played_on, r.play_order, r.source_kind, r.source_id, r.source_match, r.unit_no, r.kind, r.outcome, r.weight, r.margin_factor, r.expected_a, r.side_a_rating, r.side_b_rating,
              s.side, s.rating_before, s.rating_after, s.k,
              EXISTS (SELECT 1 FROM rating_exclusions x WHERE x.lifted_at IS NULL AND x.source_kind = r.source_kind AND x.source_id = r.source_id AND x.source_match = r.source_match AND x.unit_no = r.unit_no) AS excluded
         FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id
        WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL AND s.subject_kind = ? AND s.subject_id = ?`
    )
    .all(venueId, sport, format, subject.kind, subject.id)) as {
    id: number;
    event_name: string;
    played_on: string;
    play_order: number;
    source_kind: string;
    source_id: number;
    source_match: number;
    unit_no: number;
    kind: ResultKind;
    outcome: string;
    weight: string | null;
    margin_factor: string | null;
    expected_a: string | null;
    side_a_rating: string | null;
    side_b_rating: string | null;
    side: "a" | "b";
    rating_before: string | null;
    rating_after: string | null;
    k: string | null;
    excluded: boolean;
  }[];
  if (mine.length === 0) return [];
  const resets = (await db
    .prepare("SELECT cutoff_key FROM rating_resets WHERE venue_id = ? AND sport = ? AND format = ? AND subject_kind = ? AND subject_id = ? ORDER BY id DESC LIMIT 1")
    .get(venueId, sport, format, subject.kind, subject.id)) as { cutoff_key: string } | undefined;
  const ordered = mine
    .map((r) => ({ r, order: orderKey({ playedOn: r.played_on, playOrder: r.play_order, sourceKind: r.source_kind, sourceId: r.source_id, sourceMatch: r.source_match, unitNo: r.unit_no }) }))
    .sort((x, y) => (x.order < y.order ? 1 : -1))
    .slice(0, limit);
  const ids = ordered.map((x) => x.r.id);
  const others = (await db
    .prepare(`SELECT result_id, side, subject_kind, subject_id, label FROM rated_result_subjects WHERE result_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
    .all(...ids)) as { result_id: number; side: "a" | "b"; subject_kind: string; subject_id: number | null; label: string }[];
  // Which opponents have made their rating visible (declared adults who chose to show it or be listed; published teams).
  const userIds = [...new Set(others.filter((o) => o.subject_kind === "user" && o.subject_id !== null).map((o) => o.subject_id as number))];
  const teamIds = [...new Set(others.filter((o) => o.subject_kind === "team" && o.subject_id !== null).map((o) => o.subject_id as number))];
  const visibleUsers = new Set<number>();
  const visibleTeams = new Set<number>();
  if (userIds.length > 0)
    for (const r of (await db
      .prepare(`SELECT user_id FROM player_profiles WHERE user_id IN (${userIds.map(() => "?").join(",")}) AND adult = 1 AND (rating_shared = 1 OR rank_publicly = 1)`)
      .all(...userIds)) as { user_id: number }[])
      visibleUsers.add(r.user_id);
  if (teamIds.length > 0)
    for (const r of (await db.prepare(`SELECT id FROM teams WHERE id IN (${teamIds.map(() => "?").join(",")}) AND published = true AND status = 'active'`).all(...teamIds)) as { id: number }[]) visibleTeams.add(r.id);
  const num = (v: string | null) => (v === null ? null : Number(v));
  return ordered.map(({ r, order }) => {
    const opp = others.filter((o) => o.result_id === r.id && o.side !== r.side);
    const oppVisible = opp.length > 0 && opp.every((o) => (o.subject_kind === "user" && o.subject_id !== null && visibleUsers.has(o.subject_id)) || (o.subject_kind === "team" && o.subject_id !== null && visibleTeams.has(o.subject_id)));
    const a = Number(r.outcome);
    const result = (r.side === "a" ? a : 1 - a) === 1 ? "win" : (r.side === "a" ? a : 1 - a) === 0 ? "loss" : "draw";
    const expA = num(r.expected_a);
    const mineExpected = expA === null ? null : r.side === "a" ? expA : 1 - expA;
    const counted = !r.excluded && (num(r.weight) ?? 0) > 0;
    const before = num(r.rating_before);
    const after = num(r.rating_after);
    const labels: { label: string; junior: boolean }[] = [];
    for (const o of opp) {
      const junior = o.subject_kind === "participant";
      const entry = { label: o.subject_kind === "removed" ? "" : o.label, junior };
      if (!labels.some((l) => l.label === entry.label && l.junior === entry.junior)) labels.push(entry);
    }
    return {
      resultId: r.id,
      eventName: r.event_name,
      playedOn: r.played_on,
      kind: r.kind,
      result,
      opponents: labels,
      counted,
      excluded: r.excluded,
      ratingBefore: r.excluded ? null : before,
      ratingAfter: r.excluded ? null : after,
      change: r.excluded || before === null || after === null ? null : Math.round((after - before) * 100) / 100,
      k: r.excluded ? null : num(r.k),
      expected: mineExpected === null ? null : oppVisible ? Math.round(mineExpected * 100) : Math.round(mineExpected * 10) * 10,
      expectedExact: oppVisible,
      opponentRating: oppVisible ? num(r.side === "a" ? r.side_b_rating : r.side_a_rating) : null,
      weight: num(r.weight),
      marginFactor: num(r.margin_factor),
      beforeReset: resets ? order <= resets.cutoff_key : false,
    };
  });
}

/** May this account see this subject's ratings: its own, or a child it acts for. */
export async function mayViewSubject(userId: number, subject: { kind: SubjectKind; id: number }): Promise<boolean> {
  if (subject.kind === "user") return subject.id === userId;
  if (subject.kind === "participant") {
    const row = await getDb().prepare(`SELECT p.id FROM participants p WHERE p.id = ? AND ${ACTS_FOR("p")}`).get(subject.id, userId, userId);
    return !!row;
  }
  const row = await getDb().prepare("SELECT 1 AS x FROM team_members WHERE team_id = ? AND status = 'member' AND (user_id = ? OR acting_user_id = ?)").get(subject.id, userId, userId);
  return !!row;
}

// ----- what a team's members see

export async function teamRatings(teamId: number): Promise<MyPool[]> {
  const { rules } = await ratingRulesNow();
  return poolsOf("team", teamId, rules);
}

// ----- what a venue's manager sees

export interface StaffRatings {
  events: RatedEvent[];
  businessBoard: boolean;
  inBusiness: boolean;
  pools: {
    sport: string;
    format: RatingFormat;
    subjects: { kind: SubjectKind; id: number; label: string; rating: number; games: number; provisional: boolean; wins: number; draws: number; losses: number }[];
  }[];
  results: {
    sourceKind: SourceKind;
    sourceId: number;
    sourceMatch: number;
    unitNo: number;
    sport: string;
    format: RatingFormat;
    eventName: string;
    playedOn: string;
    sides: { a: string; b: string };
    outcome: number;
    kind: ResultKind;
    counted: boolean;
    excluded: { id: number; reason: string; by: string | null; at: string } | null;
  }[];
  resets: { sport: string; format: RatingFormat; subject: string; reason: string; by: string | null; at: string }[];
}

/** A subject's name as the event showed it, for staff; a child's marked as a junior. */
function staffLabel(kind: string, label: string): string {
  return kind === "participant" || label === "" ? "(junior player)" : label;
}

export async function staffRatings(venueId: number): Promise<StaffRatings> {
  const db = getDb();
  const { rules } = await ratingRulesNow();
  const venue = (await db.prepare("SELECT business_id FROM venues WHERE id = ?").get(venueId)) as { business_id: number | null } | undefined;
  const subjects = (await db
    .prepare("SELECT sport, format, subject_kind, subject_id, rating, games, wins, draws, losses FROM rating_subjects WHERE venue_id = ? ORDER BY sport, format, rating DESC, subject_id")
    .all(venueId)) as { sport: string; format: RatingFormat; subject_kind: SubjectKind; subject_id: number; rating: string; games: number; wins: number; draws: number; losses: number }[];
  const labels = new Map<string, string>();
  for (const l of (await db
    .prepare(
      `SELECT s.subject_kind, s.subject_id, s.label, r.sport, r.format FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id
        WHERE r.venue_id = ? AND r.voided_at IS NULL AND s.subject_id IS NOT NULL ORDER BY s.id`
    )
    .all(venueId)) as { subject_kind: string; subject_id: number; label: string }[])
    labels.set(`${l.subject_kind}:${l.subject_id}`, staffLabel(l.subject_kind, l.label));
  const pools = new Map<string, StaffRatings["pools"][number]>();
  for (const s of subjects) {
    const k = `${s.sport}|${s.format}`;
    const pool = pools.get(k) ?? { sport: s.sport, format: s.format, subjects: [] };
    pool.subjects.push({
      kind: s.subject_kind,
      id: s.subject_id,
      label: labels.get(`${s.subject_kind}:${s.subject_id}`) ?? "",
      rating: Math.round(Number(s.rating)),
      games: s.games,
      provisional: isProvisional(rules, s.games),
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
    });
    pools.set(k, pool);
  }
  const rows = (await db
    .prepare(
      `SELECT r.id, r.source_kind, r.source_id, r.source_match, r.unit_no, r.sport, r.format, r.event_name, r.played_on, r.outcome, r.kind, r.weight,
              x.id AS x_id, x.reason AS x_reason, x.by_name AS x_by, x.created_at AS x_at
         FROM rated_results r LEFT JOIN rating_exclusions x ON x.source_kind = r.source_kind AND x.source_id = r.source_id AND x.source_match = r.source_match AND x.unit_no = r.unit_no AND x.lifted_at IS NULL
        WHERE r.venue_id = ? AND r.voided_at IS NULL ORDER BY r.played_on DESC, r.id DESC LIMIT 150`
    )
    .all(venueId)) as {
    id: number;
    source_kind: SourceKind;
    source_id: number;
    source_match: number;
    unit_no: number;
    sport: string;
    format: RatingFormat;
    event_name: string;
    played_on: string;
    outcome: string;
    kind: ResultKind;
    weight: string | null;
    x_id: number | null;
    x_reason: string | null;
    x_by: string | null;
    x_at: string | null;
  }[];
  const sideLabels = new Map<string, string[]>();
  if (rows.length > 0)
    for (const s of (await db
      .prepare(`SELECT result_id, side, subject_kind, label FROM rated_result_subjects WHERE result_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`)
      .all(...rows.map((r) => r.id))) as { result_id: number; side: string; subject_kind: string; label: string }[]) {
      const key = `${s.result_id}:${s.side}`;
      const label = s.subject_kind === "removed" ? "(removed)" : staffLabel(s.subject_kind, s.label);
      const list = sideLabels.get(key) ?? [];
      if (!list.includes(label)) list.push(label);
      sideLabels.set(key, list);
    }
  const resets = (await db
    .prepare("SELECT sport, format, subject_kind, subject_id, reason, by_name, created_at FROM rating_resets WHERE venue_id = ? ORDER BY id DESC LIMIT 50")
    .all(venueId)) as { sport: string; format: RatingFormat; subject_kind: string; subject_id: number; reason: string; by_name: string | null; created_at: string }[];
  return {
    events: await venueRatedEvents(venueId),
    businessBoard: await businessBoardAllowed(venueId),
    inBusiness: venue?.business_id != null,
    pools: [...pools.values()],
    results: rows.map((r) => ({
      sourceKind: r.source_kind,
      sourceId: r.source_id,
      sourceMatch: r.source_match,
      unitNo: r.unit_no,
      sport: r.sport,
      format: r.format,
      eventName: r.event_name,
      playedOn: r.played_on,
      sides: { a: (sideLabels.get(`${r.id}:a`) ?? []).join(" / "), b: (sideLabels.get(`${r.id}:b`) ?? []).join(" / ") },
      outcome: Number(r.outcome),
      kind: r.kind,
      counted: r.x_id === null && (r.weight === null ? true : Number(r.weight) > 0),
      excluded: r.x_id === null ? null : { id: r.x_id, reason: r.x_reason ?? "", by: r.x_by, at: r.x_at ?? "" },
    })),
    resets: resets.map((r) => ({ sport: r.sport, format: r.format, subject: labels.get(`${r.subject_kind}:${r.subject_id}`) ?? "", reason: r.reason, by: r.by_name, at: r.created_at })),
  };
}

// ------------------------------------------------------------ seeding a draw from ratings

export interface SeedProposal {
  /** The entries to seed, best first, each with the rating it was proposed from. */
  seeds: { entryId: number; name: string; seed: number; rating: number }[];
  /** Entries left unseeded because they have no earned rating yet (or only a provisional one). */
  unrated: number;
}

/** A proposal only: the entries of a tournament that has not been drawn, best rating first. A manager confirms it by setting the seeds. */
export async function proposeSeeds(tournamentId: number): Promise<RatingResult<SeedProposal>> {
  const db = getDb();
  const t = (await db.prepare("SELECT id, venue_id, sport, status, format, entry_kind, team_size FROM tournaments WHERE id = ?").get(tournamentId)) as
    | { id: number; venue_id: number; sport: string; status: string; format: string; entry_kind: string | null; team_size: number }
    | undefined;
  if (!t) return ratingRefusal("RT_NOT_FOUND", {}, 404);
  if (t.status === "drawn" || t.status === "finished" || t.status === "cancelled" || t.format === "performance") return ratingRefusal("RT_SEED_DRAWN");
  const entryKind = t.entry_kind ?? (t.team_size === 2 ? "pair" : "player");
  const format: RatingFormat = entryKind === "team" ? "team" : entryKind === "pair" ? "doubles" : "singles";
  const entries = (await db
    .prepare("SELECT id, name, user_id, participant_id, team_id FROM tournament_entries WHERE tournament_id = ? AND status = 'entered'")
    .all(tournamentId)) as { id: number; name: string; user_id: number | null; participant_id: number | null; team_id: number | null }[];
  const standings = await poolStandings(t.venue_id, t.sport, format);
  const rated: { entryId: number; name: string; rating: number }[] = [];
  for (const e of entries) {
    const kind: SubjectKind | null = format === "team" ? (e.team_id ? "team" : null) : e.participant_id ? "participant" : e.user_id ? "user" : null;
    const id = kind === "team" ? e.team_id : kind === "participant" ? e.participant_id : e.user_id;
    const st = kind && id ? standings.find((s) => s.kind === kind && s.id === id) : undefined;
    if (st && !st.provisional) rated.push({ entryId: e.id, name: e.name, rating: Math.round(st.rating) });
  }
  rated.sort((x, y) => y.rating - x.rating || x.entryId - y.entryId);
  // As many seeds as the draw can keep apart: a quarter of the field, at least two, at most eight.
  const count = Math.min(rated.length, Math.max(2, Math.min(8, Math.floor(entries.length / 4))));
  return { ok: true, value: { seeds: rated.slice(0, count).map((r, i) => ({ ...r, seed: i + 1 })), unrated: entries.length - rated.length } };
}

/**
 * A manager confirming a seeding proposal they were shown: the seeds are set through the draw's own input (`setEntry`) only if the
 * proposal is still the same (the ratings may have moved since), and never over seeds staff already set.
 */
export async function applySeedProposal(tournamentId: number, shown: unknown): Promise<RatingResult<SeedProposal>> {
  const now = await proposeSeeds(tournamentId);
  if (!now.ok) return now;
  const list = Array.isArray(shown) ? (shown as { entryId?: unknown; seed?: unknown }[]) : [];
  const same = list.length === now.value.seeds.length && now.value.seeds.every((s, i) => list[i]?.entryId === s.entryId && list[i]?.seed === s.seed);
  if (!same) return ratingRefusal("RT_SEED_CHANGED");
  const have = await getDb().prepare("SELECT 1 AS x FROM tournament_entries WHERE tournament_id = ? AND seed IS NOT NULL LIMIT 1").get(tournamentId);
  if (have) return ratingRefusal("RT_SEED_EXISTS");
  const { setEntry } = await import("./tournaments");
  for (const s of now.value.seeds) {
    const done = await setEntry(s.entryId, { seed: s.seed });
    if (!done.ok) return ratingRefusal("RT_SEED_CHANGED");
  }
  return now;
}

// ------------------------------------------------------------ privacy

function personRows(kind: "user" | "participant", id: number) {
  return getDb()
    .prepare(
      `SELECT v.name AS venue, r.sport, r.format, r.event_name, r.played_on, r.kind, r.outcome, s.side, s.rating_before, s.rating_after, s.k, r.expected_a, r.weight
         FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id JOIN venues v ON v.id = r.venue_id
        WHERE s.subject_kind = ? AND s.subject_id = ? AND r.voided_at IS NULL ORDER BY r.played_on, r.id`
    )
    .all(kind, id);
}

async function subjectExport(kind: "user" | "participant", id: number): Promise<Record<string, unknown>> {
  const db = getDb();
  return {
    ratings: await db
      .prepare(
        `SELECT v.name AS venue, s.sport, s.format, s.rating, s.games, s.wins, s.draws, s.losses FROM rating_subjects s JOIN venues v ON v.id = s.venue_id
          WHERE s.subject_kind = ? AND s.subject_id = ? ORDER BY v.name, s.sport, s.format`
      )
      .all(kind, id),
    results: await personRows(kind, id),
  };
}

/** What the data export holds of an account's ratings: where it stands and each result that moved it. */
export async function ratingsExport(userId: number): Promise<unknown> {
  return subjectExport("user", userId);
}

/** The same for a child a guardian manages (their record, in the guardian's export). */
export async function participantRatingsExport(participantId: number): Promise<unknown> {
  return subjectExport("participant", participantId);
}

/**
 * Take a subject out of the ledger's identity: its rows stay as results for the other side, as "(removed)", standing at the
 * rating it had then, so nobody else's rating moves; its standings, and any reset of it, go. Every pool it was in is replayed.
 */
async function forgetSubject(kind: SubjectKind, id: number): Promise<void> {
  await withTransaction(async () => {
    const db = getDb();
    const { rules } = await ratingRulesNow();
    const pools = (await db
      .prepare(
        `SELECT DISTINCT r.venue_id, r.sport, r.format FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id
          WHERE s.subject_kind = ? AND s.subject_id = ? ORDER BY r.venue_id, r.sport, r.format`
      )
      .all(kind, id)) as { venue_id: number; sport: string; format: RatingFormat }[];
    await db
      .prepare("UPDATE rated_result_subjects SET subject_kind = 'removed', subject_id = NULL, label = '', frozen_rating = COALESCE(rating_before, ?) WHERE subject_kind = ? AND subject_id = ?")
      .run(rules.start, kind, id);
    await db.prepare("DELETE FROM rating_subjects WHERE subject_kind = ? AND subject_id = ?").run(kind, id);
    await db.prepare("DELETE FROM rating_resets WHERE subject_kind = ? AND subject_id = ?").run(kind, id);
    for (const p of pools) await recomputePool(p.venue_id, p.sport, p.format);
  });
}

/** Closing an account: its ratings and its place in the ledger go (lib/privacy.ts). */
export async function forgetRatingsOfUser(userId: number): Promise<void> {
  await forgetSubject("user", userId);
}

/** Erasing a participant's record (lib/participants.ts). */
export async function forgetRatingsOfParticipant(participantId: number): Promise<void> {
  await forgetSubject("participant", participantId);
}

// ------------------------------------------------------------ matchmaking's view (lib/matchmaking.ts)

/** The format a game of this many places is played in: two players singles, more doubles. */
export const gameFormat = (spots: number): RatingFormat => (spots + 1 <= 2 ? "singles" : "doubles");

/** An account's non-provisional ratings by venue, sport and format: what the matcher may use when the player chose earned levels. */
export async function earnedRatingsOf(userId: number): Promise<Map<string, { rating: number; games: number }>> {
  const { rules } = await ratingRulesNow();
  const rows = (await getDb()
    .prepare("SELECT venue_id, sport, format, rating, games FROM rating_subjects WHERE subject_kind = 'user' AND subject_id = ? AND games >= ?")
    .all(userId, rules.provisionalGames)) as { venue_id: number; sport: string; format: RatingFormat; rating: string; games: number }[];
  return new Map(rows.map((r) => [`${r.venue_id}|${r.sport}|${r.format}`, { rating: Math.round(Number(r.rating)), games: r.games }]));
}

export const ratingKey = (venueId: number, sport: string, format: RatingFormat) => `${venueId}|${sport}|${format}`;

/**
 * The ratings of the people in games who chose to share theirs (a declared adult, rating non-provisional, shared with the
 * hosts and players matched with them): the average and how many, per game. A player who did not share is not counted.
 */
export async function gameReferenceRatings(games: { id: number; venueId: number; sport: string; spots: number; hostId: number }[]): Promise<Map<number, { rating: number; n: number }>> {
  const out = new Map<number, { rating: number; n: number }>();
  if (games.length === 0) return out;
  const { rules } = await ratingRulesNow();
  const db = getDb();
  for (const format of ["singles", "doubles"] as const) {
    const these = games.filter((g) => gameFormat(g.spots) === format);
    if (these.length === 0) continue;
    const rows = (await db
      .prepare(
        `SELECT g.id AS game_id, rs.rating FROM open_games g JOIN bookings b ON b.id = g.booking_id JOIN courts c ON c.id = b.court_id
           JOIN rating_subjects rs ON rs.venue_id = c.venue_id AND rs.sport = b.sport AND rs.format = ? AND rs.subject_kind = 'user' AND rs.games >= ?
           JOIN player_profiles pp ON pp.user_id = rs.subject_id AND pp.rating_shared = 1 AND pp.adult = 1
          WHERE g.id IN (${these.map(() => "?").join(",")})
            AND (rs.subject_id = g.host_id OR EXISTS (SELECT 1 FROM open_game_players p WHERE p.game_id = g.id AND p.user_id = rs.subject_id AND p.status = 'accepted'))`
      )
      .all(format, rules.provisionalGames, ...these.map((g) => g.id))) as { game_id: number; rating: string }[];
    const sums = new Map<number, number[]>();
    for (const r of rows) sums.set(r.game_id, [...(sums.get(r.game_id) ?? []), Number(r.rating)]);
    for (const [gameId, list] of sums) out.set(gameId, { rating: Math.round(list.reduce((a, b) => a + b, 0) / list.length), n: list.length });
  }
  return out;
}

/** Everybody's non-provisional rating in one pool, by account: what a host's suggested players are held against. */
export async function poolEarned(venueId: number, sport: string, format: RatingFormat): Promise<Map<number, number>> {
  const { rules } = await ratingRulesNow();
  const rows = (await getDb()
    .prepare("SELECT subject_id, rating FROM rating_subjects WHERE venue_id = ? AND sport = ? AND format = ? AND subject_kind = 'user' AND games >= ?")
    .all(venueId, sport, format, rules.provisionalGames)) as { subject_id: number; rating: string }[];
  return new Map(rows.map((r) => [r.subject_id, Math.round(Number(r.rating))]));
}
