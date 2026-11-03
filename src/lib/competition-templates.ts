import { getDb } from "./db";
import { DEFAULT_RULES, readRules, type CompetitionRules, type PerformanceRules, type ScoringRules } from "./tournament-rules";

/**
 * Sport templates for competitions: how a sport's matches are usually
 * scored and its tables ranked, or how its performances are measured, as a
 * starting point an organiser can change before the draw. They are common
 * club practice, not any governing body's regulations: an organiser running
 * an event under a federation's rules checks them against those rules (the
 * set-up screen says so). Every template is data the one engine reads
 * (lib/tournaments.ts); none adds code of its own (ADR 0013).
 *
 * A venue can also keep its own: a tournament's settings saved under a name,
 * offered when it sets up the next (`saveVenueTemplate`).
 */

export type CompetitionFormat = "knockout" | "groups" | "round_robin" | "performance" | "swiss";
export type EntryKind = "player" | "pair" | "team";
/** A game within a team match: one player a side, a pair a side, or the whole team at once (lib/team-leagues.ts). */
export type RubberKind = "singles" | "doubles" | "team";

export interface CompetitionTemplate {
  key: string;
  label: string;
  /** The activities it is offered for first; any head-to-head template can be chosen for any activity. */
  sports: string[];
  formats: CompetitionFormat[];
  entryKinds: EntryKind[];
  /** For teams: the roster's size, fewest and most. */
  roster: { min: number; max: number } | null;
  matchMinutes: number;
  /**
   * For a league of teams: the games a team match is made of, in order (badminton: singles, doubles, singles). Absent: one match of
   * the whole team, scored as the template scores a match.
   */
  rubbers?: RubberKind[];
  /** What the set-up screen says about it. */
  note: string;
  rules: CompetitionRules;
}

const sets = (bestOf: number, extra: Partial<ScoringRules> = {}): ScoringRules => ({ ...DEFAULT_RULES.scoring, kind: "sets", bestOf, ...extra });
const tally = (extra: Partial<ScoringRules>): ScoringRules => ({ ...DEFAULT_RULES.scoring, kind: "tally", bestOf: 1, ...extra });
const withRules = (scoring: ScoringRules, performance: PerformanceRules | null = null): CompetitionRules => ({ ...DEFAULT_RULES, scoring, performance });
const HEAD_TO_HEAD: CompetitionFormat[] = ["knockout", "groups", "round_robin", "swiss"];

export const TEMPLATES: CompetitionTemplate[] = [
  {
    key: "racket_best_of_3",
    label: "Best of three games (badminton, pickleball)",
    sports: ["badminton", "pickleball", "sepak_takraw"],
    formats: HEAD_TO_HEAD,
    entryKinds: ["player", "pair"],
    roster: null,
    matchMinutes: 45,
    rubbers: ["singles", "doubles", "singles"],
    note: "Scores as games, \"21-15, 18-21, 21-10\". Tables by wins, then game and point difference, then who beat whom.",
    rules: withRules(sets(3)),
  },
  {
    key: "racket_best_of_5",
    label: "Best of five games (table tennis, squash)",
    sports: ["table_tennis", "squash"],
    formats: HEAD_TO_HEAD,
    entryKinds: ["player", "pair"],
    roster: null,
    matchMinutes: 40,
    rubbers: ["singles", "singles", "doubles", "singles", "singles"],
    note: "Scores as games, \"11-7, 9-11, 11-5, 11-8\". Tables by wins, then game and point difference, then who beat whom.",
    rules: withRules(sets(5)),
  },
  {
    key: "tennis_sets",
    label: "Best of three sets (tennis, padel)",
    sports: ["tennis", "padel"],
    formats: HEAD_TO_HEAD,
    entryKinds: ["player", "pair"],
    roster: null,
    matchMinutes: 90,
    rubbers: ["singles", "singles", "doubles"],
    note: "Scores as sets of games, \"6-4, 3-6, 7-5\" (a tie-break set as 7-6). Tables by wins, then set and game difference, then who beat whom.",
    rules: withRules(sets(3)),
  },
  {
    key: "volleyball_sets",
    label: "Volleyball sets",
    sports: ["volleyball"],
    formats: HEAD_TO_HEAD,
    entryKinds: ["team"],
    roster: { min: 6, max: 14 },
    matchMinutes: 90,
    note: "Scores as sets, \"25-20, 23-25, 15-12\". Tables by wins, then set and point difference. For points by set score (3-2-1-0), choose that template.",
    rules: withRules(sets(3)),
  },
  {
    key: "volleyball_points",
    label: "Volleyball, points by set score (3-2-1-0)",
    sports: ["volleyball", "beach_volleyball"],
    formats: HEAD_TO_HEAD,
    entryKinds: ["team", "pair"],
    roster: { min: 6, max: 14 },
    matchMinutes: 120,
    note: "Best of five sets. A win 3-0 or 3-1 earns 3 table points, 3-2 earns 2, a loss 2-3 earns 1, a clear loss 0 (a walkover or retirement counts as clear, and a walkover as 25-0 in three sets). Tables by points, then wins, set and point difference; many leagues rank by set and point ratios instead, which can be chosen: check your competition's rules.",
    rules: withRules(sets(5, { setPoints: { winClear: 3, winDecider: 2, loseDecider: 1, loseClear: 0 }, rankBy: ["points", "wins", "set_diff", "point_diff"], walkover: "25-0, 25-0, 25-0" })),
  },
  {
    key: "goals_league",
    label: "Goals, with draws (futsal, football, floorball)",
    sports: ["futsal", "football", "floorball", "water_polo", "netball"],
    formats: HEAD_TO_HEAD,
    entryKinds: ["team"],
    roster: { min: 5, max: 14 },
    matchMinutes: 60,
    note: "Scores as goals, \"3-2\". Group matches may be drawn: 3 points a win, 1 a draw; then goal difference, goals scored, who beat whom. A walkover counts as 3-0. A knockout match level at the end needs its winner and how it was decided (\"penalties 4-3\").",
    rules: withRules(tally({ draws: true, tablePoints: { win: 3, draw: 1, loss: 0 }, rankBy: ["points", "point_diff", "points_for", "head_to_head"], walkover: "3-0" })),
  },
  {
    key: "basketball_points",
    label: "Points, no draws (basketball)",
    sports: ["basketball"],
    formats: HEAD_TO_HEAD,
    entryKinds: ["team"],
    roster: { min: 5, max: 12 },
    matchMinutes: 60,
    note: "Scores as points, \"78-71\"; every match has a winner. 2 points a win, 1 a loss played; then who beat whom, then point difference and points scored.",
    rules: withRules(tally({ draws: false, tablePoints: { win: 2, draw: 0, loss: 1 }, rankBy: ["points", "head_to_head", "point_diff", "points_for"] })),
  },
  {
    key: "swimming_heats",
    label: "Timed heats and a final (swimming)",
    sports: ["swimming"],
    formats: ["performance"],
    entryKinds: ["player"],
    roster: null,
    matchMinutes: 10,
    note: "One swim each in a heat, eight lanes; the eight fastest swim the final. Times as 1:02.35 or 62.35. Swimmers can give an entry time to be seeded by.",
    rules: withRules(sets(1), { measure: "time", better: "lower", attempts: 1, aggregate: "best", heatSize: 8, finalSize: 8 }),
  },
  {
    key: "timed_heats",
    label: "Timed heats (cycling, rowing machines)",
    sports: ["cycling"],
    formats: ["performance"],
    entryKinds: ["player"],
    roster: null,
    matchMinutes: 15,
    note: "One timed run each, ranked on time; no final unless you set one.",
    rules: withRules(sets(1), { measure: "time", better: "lower", attempts: 1, aggregate: "best", heatSize: 6, finalSize: 0 }),
  },
  {
    key: "archery_ranking",
    label: "Ranking round by ends (archery)",
    sports: ["archery"],
    formats: ["performance"],
    entryKinds: ["player"],
    roster: null,
    matchMinutes: 120,
    note: "Six ends each, scores added up; ranked on the total. Set the number of ends and archers per session.",
    rules: withRules(sets(1), { measure: "score", better: "higher", attempts: 6, aggregate: "total", heatSize: 16, finalSize: 0 }),
  },
  {
    key: "bowling_series",
    label: "Series of games (bowling)",
    sports: ["bowling"],
    formats: ["performance"],
    entryKinds: ["player"],
    roster: null,
    matchMinutes: 60,
    note: "Three games each, pinfall added up; ranked on the total.",
    rules: withRules(sets(1), { measure: "score", better: "higher", attempts: 3, aggregate: "total", heatSize: 8, finalSize: 0 }),
  },
  {
    key: "best_attempt",
    label: "Best of several attempts (distance or score)",
    sports: [],
    formats: ["performance"],
    entryKinds: ["player"],
    roster: null,
    matchMinutes: 30,
    note: "Three attempts each, the best counts and the next best breaks a tie; a foul is written X.",
    rules: withRules(sets(1), { measure: "distance", better: "higher", attempts: 3, aggregate: "best", heatSize: 12, finalSize: 0 }),
  },
  {
    key: "bouldering_tops_zones_attempts",
    label: "Bouldering: tops, zones and attempts",
    sports: ["bouldering"],
    formats: ["performance"],
    entryKinds: ["player"],
    roster: null,
    matchMinutes: 120,
    note: "A qualification round, then a final. Everybody climbs every boulder in the round's time; the judge marks each boulder's zone and top and the attempt each was reached on. Ranked by tops, then zones, then fewer attempts to top, then fewer attempts to zone; level competitors share a place. The best six go through; the final starts with the worst placed. An organiser checks it against the federation's rules where they run it under them.",
    rules: withRules(sets(1), {
      measure: "score",
      better: "higher",
      attempts: 1,
      aggregate: "best",
      heatSize: 20,
      finalSize: 6,
      counted: { kind: "boulders", units: 4, rankBy: ["tops", "zones", "attempts_top", "attempts_zone"], countback: false, finalStart: "reverse", cutTies: "choose" },
    }),
  },
  {
    key: "bouldering_tops_zones",
    label: "Bouldering, club format: tops, then zones",
    sports: ["bouldering"],
    formats: ["performance"],
    entryKinds: ["player"],
    roster: null,
    matchMinutes: 120,
    note: "The simple club format: one round, everybody climbs every boulder in the time. Ranked by tops, then zones; attempts are not counted, and level competitors share a place. No final unless you set one.",
    rules: withRules(sets(1), {
      measure: "score",
      better: "higher",
      attempts: 1,
      aggregate: "best",
      heatSize: 40,
      finalSize: 0,
      counted: { kind: "boulders", units: 5, rankBy: ["tops", "zones"], countback: false, finalStart: "reverse", cutTies: "choose" },
    }),
  },
  {
    key: "climbing_height",
    label: "Climbing by height (a route)",
    sports: ["climbing"],
    formats: ["performance"],
    entryKinds: ["player"],
    roster: null,
    matchMinutes: 120,
    note: "One route. The judge marks the highest hold each climber reached, with a + for a partial one, and their attempts. Ranked by the higher hold, then fewer attempts; level climbers share a place. The best eight go through to a final, where level on both the qualification decides.",
    rules: withRules(sets(1), {
      measure: "score",
      better: "higher",
      attempts: 1,
      aggregate: "best",
      heatSize: 20,
      finalSize: 8,
      counted: { kind: "height", units: 1, rankBy: ["height", "attempts_height"], countback: true, finalStart: "reverse", cutTies: "choose" },
    }),
  },
  {
    key: "custom",
    label: "Your own: sets, matches as before",
    sports: [],
    formats: HEAD_TO_HEAD,
    entryKinds: ["player", "pair", "team"],
    roster: { min: 2, max: 20 },
    matchMinutes: 60,
    note: "The general rules: scores as sets, tables by wins, then set and point difference, then who beat whom. Change any of it below.",
    rules: DEFAULT_RULES,
  },
];

export function templateByKey(key: string | null | undefined): CompetitionTemplate | null {
  return TEMPLATES.find((t) => t.key === key) ?? null;
}

/** The template offered first for an activity: its own, else the general one. */
export function templateFor(sport: string): CompetitionTemplate {
  return TEMPLATES.find((t) => t.sports.includes(sport)) ?? templateByKey("custom")!;
}

/** Templates that make sense for an activity: its own first, then every head-to-head one, then the performance ones. */
export function templatesFor(sport: string): CompetitionTemplate[] {
  const own = TEMPLATES.filter((t) => t.sports.includes(sport));
  return [...own, ...TEMPLATES.filter((t) => !own.includes(t))];
}

export interface VenueTemplate {
  id: number;
  venueId: number;
  name: string;
  sport: string;
  format: CompetitionFormat;
  entryKind: EntryKind;
  roster: { min: number; max: number } | null;
  matchMinutes: number;
  groupSize: number;
  advance: number;
  rules: CompetitionRules;
}

interface VtRow {
  id: number;
  venue_id: number;
  name: string;
  sport: string;
  format: CompetitionFormat;
  entry_kind: EntryKind;
  roster_min: number | null;
  roster_max: number | null;
  match_minutes: number;
  group_size: number;
  advance: number;
  rules: string;
}

const toVenueTemplate = (r: VtRow): VenueTemplate => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  sport: r.sport,
  format: r.format,
  entryKind: r.entry_kind,
  roster: r.roster_min !== null && r.roster_max !== null ? { min: r.roster_min, max: r.roster_max } : null,
  matchMinutes: r.match_minutes,
  groupSize: r.group_size,
  advance: r.advance,
  rules: readRules(r.rules),
});

export async function venueTemplates(venueId: number): Promise<VenueTemplate[]> {
  return ((await getDb().prepare("SELECT * FROM competition_templates WHERE venue_id = ? ORDER BY name").all(venueId)) as VtRow[]).map(toVenueTemplate);
}

export async function venueTemplateById(id: number): Promise<VenueTemplate | null> {
  const r = (await getDb().prepare("SELECT * FROM competition_templates WHERE id = ?").get(id)) as VtRow | undefined;
  return r ? toVenueTemplate(r) : null;
}

/** Keep a tournament's settings under a name, to start the next from. Saving under a name used before replaces it. */
export async function saveVenueTemplate(tournamentId: number, name: string, adminId: number): Promise<{ ok: true; value: VenueTemplate } | { ok: false; error: string }> {
  const clean = name.trim();
  if (clean.length < 3 || clean.length > 80) return { ok: false, error: "Give the template a name." };
  const t = (await getDb()
    .prepare("SELECT venue_id, sport, format, entry_kind, roster_min, roster_max, match_minutes, group_size, advance, rules FROM tournaments WHERE id = ?")
    .get(tournamentId)) as Omit<VtRow, "id" | "name"> | undefined;
  if (!t) return { ok: false, error: "Tournament not found." };
  const row = (await getDb()
    .prepare(
      `INSERT INTO competition_templates (venue_id, name, sport, format, entry_kind, roster_min, roster_max, match_minutes, group_size, advance, rules, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, name) DO UPDATE SET sport = excluded.sport, format = excluded.format, entry_kind = excluded.entry_kind,
         roster_min = excluded.roster_min, roster_max = excluded.roster_max, match_minutes = excluded.match_minutes,
         group_size = excluded.group_size, advance = excluded.advance, rules = excluded.rules
       RETURNING id`
    )
    .get(
      t.venue_id,
      clean,
      t.sport,
      t.format,
      t.entry_kind,
      t.roster_min,
      t.roster_max,
      t.match_minutes,
      t.group_size,
      t.advance,
      JSON.stringify(readRules(t.rules)),
      adminId
    )) as { id: number };
  return { ok: true, value: (await venueTemplateById(row.id))! };
}

export async function deleteVenueTemplate(id: number): Promise<void> {
  await getDb().prepare("DELETE FROM competition_templates WHERE id = ?").run(id);
}
