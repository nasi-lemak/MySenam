import { DAY_MINUTES, formatMinute, instantOf, type Span } from "./interval";

/**
 * The daily window water hire is limited to (ADR 0037): a launch window (the
 * ramp is open, the launch crew is there) and, on tidal water, the stretches
 * of the day the water is deep enough, from a tide table the venue typed or
 * imported. Pure: no database, nothing fetched. The rules and the table are
 * read in lib/launch-windows.ts and the result, a `LaunchDay`, rides on the
 * court's day (`CourtDay.launch`, lib/store.ts) so every path that books,
 * moves or searches meets it in `policyBreaches` (lib/booking-rules.ts).
 *
 * Not a safety system. The window is only the hours the venue's own data
 * leave: whether to launch is the venue's judgement, always.
 *
 * Time. A window is whole minutes of one local date, within [0, 1440] and
 * never across midnight: the business day's minutes after 24:00 are never in a
 * window, and a tide that serves 23:00 to 01:00 is two windows, the evening's
 * on its date and the early morning's on the next. A tide event is an instant;
 * the minutes of a date are read at the instants `instantOf` gives them, so a
 * day the clocks change is read as it happened (a booking touching the change
 * is refused anyway, lib/time.ts `crossesClockChange`).
 */

export type TideKind = "high" | "low";

/** One entry of a tide table: an instant (epoch milliseconds, on a whole minute), what it is, and its height in centimetres. */
export interface TideEvent {
  atMs: number;
  kind: TideKind;
  cm: number;
}

/**
 * The longest stretch between two entries the table is trusted across. A tide
 * turns about every 6 hours (12 where it comes once a day); more than 15
 * hours between neighbours means an entry is missing, and the stretch is
 * "no tide data", never guessed.
 */
export const MAX_TIDE_GAP_MIN = 15 * 60;

/** What the tide must be for the water to be usable. */
export type TideRuleSpec =
  | { rule: "height"; minHeightCm: number }
  | { rule: "event"; eventKind: TideKind; eventMinutes: number };

/** A weekday's launch window, in minutes of the day; index 0 is Sunday. null: no launch that day. */
export type WeeklyWindows = ({ from: number; to: number } | null)[];

export type LaunchSource = "weekly" | "tide" | "both";

/** A resource's rule, as the day is worked out from it. */
export interface LaunchRuleSpec {
  source: LaunchSource;
  weekly: WeeklyWindows | null;
  tide: TideRuleSpec | null;
  /** A window shorter than this (minutes) is not offered at all. */
  minWindowMin: number;
  /** Minutes before the window closes by which a booking must be back. */
  returnBufferMin: number;
}

/** Why a stretch of the day is closed by the window, as customers and staff are told. */
export type LaunchReason = "outside_launch" | "low_water" | "no_tide_data" | "short_window" | "return_buffer";

export interface ClosedStretch extends Span {
  reason: LaunchReason;
}

/** What a rule leaves of one date. */
export interface LaunchDay {
  ruleId: number;
  /** The windows, in order, whole minutes within [0, 1440] and the day's opening hours, none shorter than the rule's minimum. */
  windows: Span[];
  /** Minutes before a window closes that a booking must be back by. */
  returnBuffer: number;
  /** The stretches of the opening hours the window closes, with why (minutes of the date, in order, not overlapping). */
  closed: ClosedStretch[];
}

const EPSILON = 1e-9;
const MINUTE_MS = 60_000;

/**
 * The tide's height in centimetres at an instant, by half-cosine (rule of
 * twelfths smoothed) interpolation between the two entries either side:
 * h = h0 + (h1 - h0) * (1 - cos(pi * f)) / 2 for f the fraction of the way. null
 * where the table says nothing: before its first entry, after its last, or
 * across a stretch longer than `MAX_TIDE_GAP_MIN` or between two entries of
 * one kind (a missing entry). `events` must be sorted by time.
 */
export function tideHeightCm(events: readonly TideEvent[], atMs: number): number | null {
  let lo = 0;
  let hi = events.length - 1;
  if (hi < 0 || atMs < events[0].atMs || atMs > events[hi].atMs) return null;
  // The last entry at or before the instant.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].atMs <= atMs) lo = mid;
    else hi = mid - 1;
  }
  const a = events[lo];
  if (a.atMs === atMs) return a.cm;
  const b = events[lo + 1];
  if (!b || a.kind === b.kind || b.atMs - a.atMs > MAX_TIDE_GAP_MIN * MINUTE_MS) return null;
  const f = (atMs - a.atMs) / (b.atMs - a.atMs);
  return a.cm + ((b.cm - a.cm) * (1 - Math.cos(Math.PI * f))) / 2;
}

/** Each whole-minute boundary of a date (0 to 1440) as an instant, in ms. */
export function minuteInstants(date: string, zone: string): number[] {
  const start = instantOf(date, 0, zone).getTime();
  const end = instantOf(date, DAY_MINUTES, zone).getTime();
  const out: number[] = [];
  if (end - start === DAY_MINUTES * MINUTE_MS) {
    for (let m = 0; m <= DAY_MINUTES; m++) out.push(start + m * MINUTE_MS);
  } else {
    // A day the clocks change: each minute as the zone has it.
    for (let m = 0; m <= DAY_MINUTES; m++) out.push(instantOf(date, m, zone).getTime());
  }
  return out;
}

type Sample = "ok" | "low" | "nodata";

/** The tide at each minute boundary of a date, against the rule. */
export function tideSamples(events: readonly TideEvent[], instants: readonly number[], spec: TideRuleSpec): Sample[] {
  const near =
    spec.rule === "event"
      ? events.filter((e) => e.kind === spec.eventKind && e.atMs >= instants[0] - spec.eventMinutes * MINUTE_MS && e.atMs <= instants[instants.length - 1] + spec.eventMinutes * MINUTE_MS)
      : [];
  return instants.map((t): Sample => {
    const cm = tideHeightCm(events, t);
    if (cm === null) return "nodata";
    if (spec.rule === "height") return cm + EPSILON >= spec.minHeightCm ? "ok" : "low";
    return near.some((e) => Math.abs(e.atMs - t) <= spec.eventMinutes * MINUTE_MS) ? "ok" : "low";
  });
}

/** Runs of consecutive true values in `usable[i]` for the interval [i, i+1], as spans. */
function runs(usable: readonly boolean[]): Span[] {
  const out: Span[] = [];
  let from = -1;
  for (let m = 0; m <= usable.length; m++) {
    if (m < usable.length && usable[m]) {
      if (from < 0) from = m;
    } else if (from >= 0) {
      out.push({ start: from, end: m });
      from = -1;
    }
  }
  return out;
}

/**
 * What a rule leaves of one date. `open` is the court's opening hours that day
 * (minutes; the part past midnight is never in a window); `events` the tide
 * table of the rule's station, sorted, around the date. Deterministic: the same
 * rule, hours and table always give the same windows.
 */
export function launchDay(
  ruleId: number,
  spec: LaunchRuleSpec,
  input: { date: string; zone: string; weekday: number; open: Span; events: readonly TideEvent[] }
): LaunchDay {
  const minutes = DAY_MINUTES;
  const open = { start: Math.max(0, input.open.start), end: Math.min(minutes, input.open.end) };
  const inHours = (m: number) => m >= open.start && m < open.end;

  const weeklyWindow = spec.source !== "tide" ? (spec.weekly?.[input.weekday] ?? null) : null;
  const weeklyOk = (m: number) => spec.source === "tide" || (weeklyWindow !== null && m >= weeklyWindow.from && m < Math.min(weeklyWindow.to, minutes));

  // The tide, per interval [m, m+1]: usable only where both ends are.
  let tideAt: (m: number) => Sample = () => "ok";
  if (spec.source !== "weekly" && spec.tide) {
    const samples = tideSamples(input.events, minuteInstants(input.date, input.zone), spec.tide);
    tideAt = (m) => (samples[m] === "nodata" || samples[m + 1] === "nodata" ? "nodata" : samples[m] === "low" || samples[m + 1] === "low" ? "low" : "ok");
  }

  const reasons: (LaunchReason | null)[] = new Array(minutes).fill(null);
  const usable: boolean[] = new Array(minutes).fill(false);
  for (let m = 0; m < minutes; m++) {
    if (!inHours(m)) continue;
    if (!weeklyOk(m)) reasons[m] = "outside_launch";
    else {
      const t = tideAt(m);
      if (t === "nodata") reasons[m] = "no_tide_data";
      else if (t === "low") reasons[m] = "low_water";
      else usable[m] = true;
    }
  }

  const windows: Span[] = [];
  for (const run of runs(usable)) {
    if (run.end - run.start < Math.max(1, spec.minWindowMin)) {
      for (let m = run.start; m < run.end; m++) reasons[m] = "short_window";
    } else windows.push(run);
  }
  // The minutes a booking must already be back by.
  for (const w of windows)
    for (let m = Math.max(w.start, w.end - spec.returnBufferMin); m < w.end; m++) reasons[m] = "return_buffer";

  const closed: ClosedStretch[] = [];
  for (let m = 0; m < minutes; m++) {
    const reason = reasons[m];
    if (reason === null) continue;
    const last = closed[closed.length - 1];
    if (last && last.reason === reason && last.end === m) last.end = m + 1;
    else closed.push({ start: m, end: m + 1, reason });
  }
  return { ruleId, windows, returnBuffer: spec.returnBufferMin, closed };
}

/** The stretches of a day a booking may be in: each window less the return buffer. */
export function bookableWindows(day: LaunchDay): Span[] {
  return day.windows.map((w) => ({ start: w.start, end: w.end - day.returnBuffer })).filter((w) => w.end > w.start);
}

/** Is the whole of `span` inside one window, back by the return buffer? */
export function launchOk(day: LaunchDay, span: Span): boolean {
  return bookableWindows(day).some((w) => w.start <= span.start && span.end <= w.end);
}

/** A window as a line: "7:10 AM–10:40 AM". */
export function windowText(w: Span, locale = "en"): string {
  return `${formatMinute(w.start, locale)}–${formatMinute(w.end, locale)}`;
}

/** The refusal for a span outside the window: a code of the customer dictionary and what it quotes. */
export type LaunchRefusal =
  | { code: "TIDE_NO_DATA"; vars: Record<string, never> }
  | { code: "LAUNCH_RETURN"; vars: { back: string; minutes: number } }
  | { code: "LAUNCH_WINDOW"; vars: { window: string } }
  | { code: "LAUNCH_CLOSED"; vars: Record<string, never> };

/** Why `span` is outside the window (call only where `launchOk` is false). */
export function launchRefusal(day: LaunchDay, span: Span): LaunchRefusal {
  // Time nobody can know the water for comes first: the table says nothing there.
  if (day.closed.some((c) => c.reason === "no_tide_data" && c.start < span.end && span.start < c.end)) return { code: "TIDE_NO_DATA", vars: {} };
  const inside = day.windows.find((w) => w.start <= span.start && span.end <= w.end);
  if (inside) return { code: "LAUNCH_RETURN", vars: { back: formatMinute(inside.end - day.returnBuffer), minutes: day.returnBuffer } };
  if (day.windows.length > 0) return { code: "LAUNCH_WINDOW", vars: { window: day.windows.map((w) => windowText(w)).join(", ") } };
  return { code: "LAUNCH_CLOSED", vars: {} };
}

/** The customer's phrase key for a reason a stretch of the day is closed. */
export const LAUNCH_REASON_PHRASE = {
  outside_launch: "wtr1.reason.outside_launch",
  low_water: "wtr1.reason.low_water",
  no_tide_data: "wtr1.reason.no_tide_data",
  short_window: "wtr1.reason.short_window",
  return_buffer: "wtr1.reason.return_buffer",
} as const satisfies Record<LaunchReason, string>;

/** What tells a customer most, first, where several reasons share a stretch of time. */
const REASON_ORDER: LaunchReason[] = ["no_tide_data", "low_water", "outside_launch", "short_window", "return_buffer"];

/** The reason the minutes of [from, to) are closed by the window: the most telling of those inside it; null where none is. */
export function reasonFor(day: LaunchDay, from: number, to: number): LaunchReason | null {
  const hit = day.closed.filter((c) => c.start < to && from < c.end).map((c) => c.reason);
  return REASON_ORDER.find((r) => hit.includes(r)) ?? null;
}
