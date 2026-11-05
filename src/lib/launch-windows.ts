import { getDb, withTransaction } from "./db";
import { addDays, dayOfWeek, isValidDateString } from "./time";
import { DAY_MINUTES, instantOf, type Span } from "./interval";
import { launchDay, type LaunchDay, type LaunchRuleSpec, type LaunchSource, type TideEvent, type TideKind, type TideRuleSpec, type WeeklyWindows } from "./launch-day";
import { MAX_TIDE_TEXT, parseTideCsv, type RowFault, type RowWarning } from "./tide-import";
import { venueZoneOf } from "./zones";
import type { Sport } from "./types";

/**
 * The launch and tide windows of water hire: the rules a venue sets for a
 * resource and the tide table it keeps (ADR 0037). What a rule leaves of a
 * date is worked out in lib/launch-day.ts; this file keeps the rules and the
 * table and hands each court's day its window (`CourtDay.launch`,
 * lib/store.ts). The bookings a change leaves outside a window are
 * lib/launch-worklist.ts.
 *
 * No service is asked for tides. The table is what staff typed or imported,
 * and it is never shown to customers as a forecast.
 */

export interface LaunchRule {
  id: number;
  venueId: number;
  courtId: number;
  /** null: every activity the resource offers. */
  sport: Sport | null;
  source: LaunchSource;
  weekly: WeeklyWindows | null;
  station: string | null;
  tide: TideRuleSpec | null;
  minWindowMin: number;
  returnBufferMin: number;
  updatedAt: string;
}

interface RuleRow {
  id: number;
  venue_id: number;
  court_id: number;
  sport: string | null;
  source: LaunchSource;
  weekly: string | null;
  station: string | null;
  tide_rule: "height" | "event" | null;
  min_height_cm: number | null;
  event_kind: TideKind | null;
  event_minutes: number | null;
  min_window_min: number;
  return_buffer_min: number;
  updated_at: string;
}

/** What is stored of a week, made safe to use. */
export function parseWeekly(raw: unknown): WeeklyWindows | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length !== 7) return null;
  return value.map((d) => {
    const w = d as { from?: unknown; to?: unknown } | null;
    return w && Number.isInteger(w.from) && Number.isInteger(w.to) ? { from: w.from as number, to: w.to as number } : null;
  });
}

const toRule = (r: RuleRow): LaunchRule => ({
  id: r.id,
  venueId: r.venue_id,
  courtId: r.court_id,
  sport: (r.sport as Sport | null) ?? null,
  source: r.source,
  weekly: parseWeekly(r.weekly),
  station: r.station,
  tide:
    r.tide_rule === "height" && r.min_height_cm !== null
      ? { rule: "height", minHeightCm: r.min_height_cm }
      : r.tide_rule === "event" && r.event_kind && r.event_minutes !== null
        ? { rule: "event", eventKind: r.event_kind, eventMinutes: r.event_minutes }
        : null,
  minWindowMin: r.min_window_min,
  returnBufferMin: r.return_buffer_min,
  updatedAt: r.updated_at,
});

/** A rule as the day is worked out from it. */
export function ruleSpec(r: LaunchRule): LaunchRuleSpec {
  return { source: r.source, weekly: r.weekly, tide: r.tide, minWindowMin: r.minWindowMin, returnBufferMin: r.returnBufferMin };
}

/** The rule that applies to a resource for an activity: one for that activity, else the resource's own for all. */
export function ruleFor(rules: readonly LaunchRule[], sport: Sport): LaunchRule | null {
  return rules.find((r) => r.sport === sport) ?? rules.find((r) => r.sport === null) ?? null;
}

export async function listRules(venueId: number): Promise<LaunchRule[]> {
  return ((await getDb().prepare("SELECT * FROM launch_rules WHERE venue_id = ? ORDER BY court_id, sport NULLS FIRST").all(venueId)) as RuleRow[]).map(toRule);
}

export async function rulesForCourts(courtIds: number[]): Promise<Map<number, LaunchRule[]>> {
  const out = new Map<number, LaunchRule[]>();
  if (courtIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(`SELECT * FROM launch_rules WHERE court_id IN (${courtIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(...courtIds)) as RuleRow[];
  for (const row of rows) {
    const rule = toRule(row);
    out.set(rule.courtId, [...(out.get(rule.courtId) ?? []), rule]);
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A venue's tide entries for a station between two instants (ms), sorted. */
export async function tideEventsBetween(venueId: number, station: string, fromMs: number, toMs: number): Promise<TideEvent[]> {
  const rows = (await getDb()
    .prepare("SELECT at, kind, height_cm FROM tide_events WHERE venue_id = ? AND station = ? AND at >= ? AND at <= ? ORDER BY at")
    .all(venueId, station, iso(fromMs), iso(toMs))) as { at: string; kind: TideKind; height_cm: number }[];
  return rows.map((r) => ({ atMs: Date.parse(r.at), kind: r.kind, cm: r.height_cm }));
}

/** What the tide table is read across a date: the entries a stretch of up to this many hours beyond it can need. */
const TIDE_LOOKAROUND_MS = 16 * 3_600_000;

/** One court's place in a day's hours: where its day is kept and what it is open. */
export interface LaunchAsk {
  courtId: number;
  venueId: number;
  sport: Sport;
  zone: string;
  open: Span;
  /** Shut all day: nothing for a window to narrow. */
  closed: boolean;
}

/**
 * What the courts' rules leave of one date: for each court with a rule for the
 * activity it is offered for, its `LaunchDay`; the others are not narrowed
 * (null). `tides` may be given where the caller already holds the table.
 */
export async function launchDaysFor(date: string, asks: LaunchAsk[]): Promise<Map<number, LaunchDay | null>> {
  const out = new Map<number, LaunchDay | null>();
  if (asks.length === 0) return out;
  const rules = await rulesForCourts([...new Set(asks.map((a) => a.courtId))]);
  const tables = new Map<string, TideEvent[]>();
  for (const ask of asks) {
    const rule = ruleFor(rules.get(ask.courtId) ?? [], ask.sport);
    if (!rule || ask.closed) {
      out.set(ask.courtId, null);
      continue;
    }
    let events: TideEvent[] = [];
    if (rule.source !== "weekly" && rule.station) {
      const key = `${ask.venueId}\u0000${rule.station}\u0000${ask.zone}`;
      if (!tables.has(key)) {
        const start = instantOf(date, 0, ask.zone).getTime();
        const end = instantOf(date, DAY_MINUTES, ask.zone).getTime();
        tables.set(key, await tideEventsBetween(ask.venueId, rule.station, start - TIDE_LOOKAROUND_MS, end + TIDE_LOOKAROUND_MS));
      }
      events = tables.get(key)!;
    }
    out.set(ask.courtId, launchDay(rule.id, ruleSpec(rule), { date, zone: ask.zone, weekday: dayOfWeek(date), open: ask.open, events }));
  }
  return out;
}

// ------------------------------------------------------------------ rules

export type RuleInput = {
  id?: unknown;
  courtId?: unknown;
  sport?: unknown;
  source?: unknown;
  weekly?: unknown;
  station?: unknown;
  tide?: unknown;
  minWindowMin?: unknown;
  returnBufferMin?: unknown;
};

/** A station's name as kept: trimmed, runs of spaces made one. */
export function stationName(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const name = text.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 60 ? name : null;
}

/** A week as given, checked: each day a window or none, a window within the day and never across midnight. */
export function validateWeekly(input: unknown): { ok: true; weekly: WeeklyWindows } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length !== 7) return { ok: false, error: "Give seven days, Sunday first." };
  const week: WeeklyWindows = [];
  for (let i = 0; i < 7; i++) {
    const d = input[i] as { from?: unknown; to?: unknown } | null | undefined | "none";
    if (d === null || d === undefined || d === "none") week.push(null);
    else if (typeof d === "object" && Number.isInteger(d.from) && Number.isInteger(d.to)) {
      const from = d.from as number;
      const to = d.to as number;
      if (from < 0 || to > DAY_MINUTES || to <= from)
        return { ok: false, error: "A launch window starts before it ends and stays within the day: it never crosses midnight. Give two windows (one each side) for one that does." };
      week.push({ from, to });
    } else return { ok: false, error: "Each day is a launch window, or none." };
  }
  if (week.every((d) => d === null)) return { ok: false, error: "Give a launch window for at least one day, or remove the rule." };
  return { ok: true, weekly: week };
}

export type RuleResult = { ok: true; rule: LaunchRule } | { ok: false; error: string };

/**
 * Set a resource's window rule (for one activity, or all it offers): made, or
 * replaced where the resource already has one for that activity. Existing
 * bookings are never touched: those the new rule leaves outside the window
 * are listed (lib/launch-worklist.ts).
 */
export async function saveRule(venueId: number, input: RuleInput, adminId: number | null): Promise<RuleResult> {
  const courtId = Number(input.courtId);
  const db = getDb();
  const court = Number.isInteger(courtId) ? ((await db.prepare("SELECT id, sport FROM courts WHERE id = ? AND venue_id = ?").get(courtId, venueId)) as { id: number; sport: string } | undefined) : undefined;
  if (!court) return { ok: false, error: "That resource is not at this venue." };
  let sport: string | null = null;
  if (input.sport !== undefined && input.sport !== null && input.sport !== "") {
    if (typeof input.sport !== "string") return { ok: false, error: "That activity is not offered on this resource." };
    const offered = (await db.prepare("SELECT 1 AS x FROM court_activities WHERE court_id = ? AND sport = ?").get(courtId, input.sport)) as unknown;
    if (!offered && court.sport !== input.sport) return { ok: false, error: "That activity is not offered on this resource." };
    sport = input.sport;
  }
  const source = input.source;
  if (source !== "weekly" && source !== "tide" && source !== "both") return { ok: false, error: "Choose a launch window, a tide table, or both." };

  let weeklyJson: string | null = null;
  if (source !== "tide") {
    const week = validateWeekly(input.weekly);
    if (!week.ok) return week;
    weeklyJson = JSON.stringify(week.weekly);
  }

  let station: string | null = null;
  let tideRule: "height" | "event" | null = null;
  let minHeightCm: number | null = null;
  let eventKind: TideKind | null = null;
  let eventMinutes: number | null = null;
  if (source !== "weekly") {
    station = stationName(input.station);
    if (!station) return { ok: false, error: "Name the tide station the table is kept under (up to 60 characters)." };
    const tide = (input.tide ?? {}) as { rule?: unknown; minHeight?: unknown; eventKind?: unknown; eventMinutes?: unknown };
    if (tide.rule === "height") {
      const metres = typeof tide.minHeight === "number" ? tide.minHeight : Number(tide.minHeight);
      if (tide.minHeight === "" || tide.minHeight === null || !Number.isFinite(metres) || metres < -5 || metres > 25) return { ok: false, error: "Give the least tide height in metres, from -5 to 25." };
      tideRule = "height";
      minHeightCm = Math.round(metres * 100);
    } else if (tide.rule === "event") {
      if (tide.eventKind !== "high" && tide.eventKind !== "low") return { ok: false, error: "Say which tide the window is around: high or low." };
      const minutes = Number(tide.eventMinutes);
      if (tide.eventMinutes === "" || tide.eventMinutes === null || !Number.isInteger(minutes) || minutes < 0 || minutes > 720) return { ok: false, error: "Give the minutes either side of the tide, from 0 to 720." };
      tideRule = "event";
      eventKind = tide.eventKind;
      eventMinutes = minutes;
    } else return { ok: false, error: "Choose how the tide decides: a least height, or around a high or low tide." };
  }

  const minWindow = input.minWindowMin === undefined || input.minWindowMin === "" ? 0 : Number(input.minWindowMin);
  if (!Number.isInteger(minWindow) || minWindow < 0 || minWindow > DAY_MINUTES) return { ok: false, error: "The shortest window is whole minutes, up to a day." };
  const back = input.returnBufferMin === undefined || input.returnBufferMin === "" ? 0 : Number(input.returnBufferMin);
  if (!Number.isInteger(back) || back < 0 || back > 240) return { ok: false, error: "Back before the window closes is whole minutes, up to 4 hours." };

  const sameCourt = (await db
    .prepare(sport === null ? "SELECT id FROM launch_rules WHERE court_id = ? AND sport IS NULL" : "SELECT id FROM launch_rules WHERE court_id = ? AND sport = ?")
    .get(...(sport === null ? [courtId] : [courtId, sport]))) as { id: number } | undefined;
  let id = sameCourt?.id;
  if (input.id !== undefined && input.id !== null) {
    const asked = Number(input.id);
    const own = Number.isInteger(asked) ? ((await db.prepare("SELECT id, court_id, sport FROM launch_rules WHERE id = ? AND venue_id = ?").get(asked, venueId)) as { id: number; court_id: number; sport: string | null } | undefined) : undefined;
    if (!own) return { ok: false, error: "That rule is not at this venue." };
    if (own.court_id !== courtId || own.sport !== sport) return { ok: false, error: "A rule stays with its resource and activity: remove it and make another." };
    id = own.id;
  }
  const values = [source, weeklyJson, station, tideRule, minHeightCm, eventKind, eventMinutes, minWindow, back, adminId] as const;
  if (id !== undefined) {
    await db
      .prepare(
        `UPDATE launch_rules SET source = ?, weekly = ?, station = ?, tide_rule = ?, min_height_cm = ?, event_kind = ?, event_minutes = ?,
                min_window_min = ?, return_buffer_min = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(...values, id);
  } else {
    const row = (await db
      .prepare(
        `INSERT INTO launch_rules (venue_id, court_id, sport, source, weekly, station, tide_rule, min_height_cm, event_kind, event_minutes,
                                   min_window_min, return_buffer_min, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(venueId, courtId, sport, ...values)) as { id: number };
    id = row.id;
  }
  return { ok: true, rule: toRule((await db.prepare("SELECT * FROM launch_rules WHERE id = ?").get(id)) as RuleRow) };
}

export async function ruleById(venueId: number, id: number): Promise<LaunchRule | null> {
  const row = (await getDb().prepare("SELECT * FROM launch_rules WHERE id = ? AND venue_id = ?").get(id, venueId)) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

/** Take a rule away: the resource is limited by its opening hours alone again. */
export async function deleteRule(venueId: number, id: number): Promise<LaunchRule | null> {
  const rule = await ruleById(venueId, id);
  if (!rule) return null;
  await getDb().prepare("DELETE FROM launch_rules WHERE id = ? AND venue_id = ?").run(id, venueId);
  return rule;
}

// ------------------------------------------------------------- tide table

export interface TideRow {
  id: number;
  station: string;
  atMs: number;
  /** On the venue's clock. */
  date: string;
  time: string;
  kind: TideKind;
  heightCm: number;
  source: "typed" | "csv";
}

async function venueZone(venueId: number): Promise<string> {
  const row = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  return venueZoneOf(row ?? {});
}

/** The stations a venue keeps a table for, with how many entries each holds and the dates they run between (on the venue's clock). */
export async function tideStations(venueId: number): Promise<{ station: string; entries: number; from: string; until: string }[]> {
  const zone = await venueZone(venueId);
  const rows = (await getDb()
    .prepare("SELECT station, COUNT(*)::int AS n, MIN(at) AS first, MAX(at) AS last FROM tide_events WHERE venue_id = ? GROUP BY station ORDER BY station")
    .all(venueId)) as { station: string; n: number; first: string; last: string }[];
  const dateOf = (at: string) => localParts(Date.parse(at), zone).date;
  return rows.map((r) => ({ station: r.station, entries: r.n, from: dateOf(r.first), until: dateOf(r.last) }));
}

/** An instant as the date and 24-hour time on a zone's clock. */
export function localParts(ms: number, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** A station's entries from a local date on (up to `limit`), soonest first. */
export async function listTide(venueId: number, station: string, fromDate: string, limit = 400): Promise<TideRow[]> {
  const zone = await venueZone(venueId);
  const from = isValidDateString(fromDate) ? instantOf(fromDate, 0, zone).toISOString() : "0000";
  const rows = (await getDb()
    .prepare("SELECT id, station, at, kind, height_cm, source FROM tide_events WHERE venue_id = ? AND station = ? AND at >= ? ORDER BY at LIMIT ?")
    .all(venueId, station, from, Math.min(Math.max(1, limit), 2000))) as { id: number; station: string; at: string; kind: TideKind; height_cm: number; source: "typed" | "csv" }[];
  return rows.map((r) => ({ id: r.id, station: r.station, atMs: Date.parse(r.at), ...localParts(Date.parse(r.at), zone), kind: r.kind, heightCm: r.height_cm, source: r.source }));
}

export type TideImportResult =
  | { ok: true; added: number; changed: number; unchanged: number; rows: number; from: string; until: string; warnings: RowWarning[]; preview: boolean; station: string }
  | { ok: false; error: string; errors: RowFault[]; warnings: RowWarning[]; rows: number };

/**
 * Add entries to a station's table from CSV (lib/tide-import.ts for the format),
 * or, with `preview`, say what would be. Every row is checked first and a table
 * with any fault stores nothing: the faults come back row by row. An entry at an
 * instant the table already has replaces it (so a corrected table is imported
 * over the old one), counted as changed when its kind or height differs.
 */
export async function importTide(
  venueId: number,
  input: { station: unknown; csv: unknown; times?: unknown; preview?: boolean; source?: "typed" | "csv" },
  adminId: number | null
): Promise<TideImportResult> {
  const station = stationName(input.station);
  if (!station) return { ok: false, error: "Name the tide station (up to 60 characters).", errors: [], warnings: [], rows: 0 };
  if (typeof input.csv !== "string" || input.csv.trim() === "") return { ok: false, error: "Paste the tide table or choose a file.", errors: [], warnings: [], rows: 0 };
  if (input.csv.length > MAX_TIDE_TEXT) return { ok: false, error: "That table is too long to read at once: send it in parts.", errors: [], warnings: [], rows: 0 };
  const times = input.times === "utc" ? "utc" : "venue";
  const zone = await venueZone(venueId);
  const parsed = parseTideCsv(input.csv, { zone, times });
  if (parsed.errors.length > 0) {
    return { ok: false, error: `${parsed.errors.length} row${parsed.errors.length === 1 ? " has a fault" : "s have faults"}: nothing was stored.`, errors: parsed.errors, warnings: parsed.warnings, rows: parsed.rows };
  }
  if (parsed.events.length === 0) return { ok: false, error: "The table has no rows.", errors: [], warnings: [], rows: 0 };
  const db = getDb();
  const sorted = [...parsed.events].sort((a, b) => a.atMs - b.atMs);
  const existing = (await db
    .prepare("SELECT at, kind, height_cm FROM tide_events WHERE venue_id = ? AND station = ? AND at >= ? AND at <= ?")
    .all(venueId, station, iso(sorted[0].atMs), iso(sorted[sorted.length - 1].atMs))) as { at: string; kind: TideKind; height_cm: number }[];
  const had = new Map(existing.map((e) => [Date.parse(e.at), e]));
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const e of sorted) {
    const old = had.get(e.atMs);
    if (!old) added++;
    else if (old.kind !== e.kind || old.height_cm !== e.cm) changed++;
    else unchanged++;
  }
  const done = {
    ok: true as const,
    added,
    changed,
    unchanged,
    rows: parsed.rows,
    from: localParts(sorted[0].atMs, zone).date,
    until: localParts(sorted[sorted.length - 1].atMs, zone).date,
    warnings: parsed.warnings,
    preview: input.preview === true,
    station,
  };
  if (input.preview) return done;
  await withTransaction(async () => {
    for (const e of sorted)
      await db
        .prepare(
          `INSERT INTO tide_events (venue_id, station, at, kind, height_cm, source, entered_by) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (venue_id, station, at) DO UPDATE SET kind = EXCLUDED.kind, height_cm = EXCLUDED.height_cm, source = EXCLUDED.source, entered_by = EXCLUDED.entered_by`
        )
        .run(venueId, station, iso(e.atMs), e.kind, e.cm, input.source ?? "csv", adminId);
  });
  return done;
}

/** One entry typed by hand: the same checks as a CSV row of one. */
export async function addTideEntry(
  venueId: number,
  input: { station: unknown; date: unknown; time: unknown; kind: unknown; heightM: unknown },
  adminId: number | null
): Promise<TideImportResult> {
  const clean = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/[\r\n,;\t]/g, " ") : "");
  const csv = `date,time,type,height_m\n${clean(input.date)},${clean(input.time)},${clean(input.kind)},${clean(input.heightM)}`;
  return importTide(venueId, { station: input.station, csv, times: "venue", source: "typed" }, adminId);
}

/** Remove entries: one by id, or a station's between two local dates (both counted). Returns how many went. */
export async function deleteTide(
  venueId: number,
  input: { id?: unknown; station?: unknown; from?: unknown; until?: unknown }
): Promise<{ ok: true; removed: number; station: string } | { ok: false; error: string }> {
  const db = getDb();
  if (input.id !== undefined && input.id !== null) {
    const id = Number(input.id);
    const row = Number.isInteger(id) ? ((await db.prepare("SELECT id, station FROM tide_events WHERE id = ? AND venue_id = ?").get(id, venueId)) as { id: number; station: string } | undefined) : undefined;
    if (!row) return { ok: false, error: "That entry is not in this venue's table." };
    await db.prepare("DELETE FROM tide_events WHERE id = ? AND venue_id = ?").run(id, venueId);
    return { ok: true, removed: 1, station: row.station };
  }
  const station = stationName(input.station);
  if (!station) return { ok: false, error: "Name the tide station." };
  if (typeof input.from !== "string" || typeof input.until !== "string" || !isValidDateString(input.from) || !isValidDateString(input.until) || input.until < input.from)
    return { ok: false, error: "Give the first and last date to remove, the first not after the last." };
  const zone = await venueZone(venueId);
  const result = (await db
    .prepare("DELETE FROM tide_events WHERE venue_id = ? AND station = ? AND at >= ? AND at < ? RETURNING id")
    .all(venueId, station, instantOf(input.from, 0, zone).toISOString(), instantOf(addDays(input.until, 1), 0, zone).toISOString())) as unknown[];
  return { ok: true, removed: result.length, station };
}
