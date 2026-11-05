import { instantOf, parseClock } from "./interval";
import { clockProblem, isValidDateString } from "./time";
import { MAX_TIDE_GAP_MIN, type TideEvent, type TideKind } from "./launch-day";

/**
 * A tide table pasted or uploaded as CSV (ADR 0037). Pure, so the same
 * reading is used to preview a file and to store it, and each bad row is
 * named.
 *
 * Format: a header row, then one row per tide, comma, semicolon or tab
 * separated, in any order of columns:
 *
 *   date,time,type,height_m
 *   2026-11-06,05:42,high,3.1
 *   2026-11-06,11:58,low,0.6
 *
 * - `date`: `YYYY-MM-DD`, or `DD/MM/YYYY` (day first, as written in Malaysia).
 * - `time`: 24-hour `HH:MM`, in the venue's time zone unless the import says
 *   the times are UTC (`times: "utc"`).
 * - `type`: `high` or `low` (`H`, `L`, `HW`, `LW` also read).
 * - the height, under `height` (metres), `height_m`, `height_cm` or
 *   `height_ft`; a figure may carry its own unit (`3.1m`, `10.2ft`, `310cm`),
 *   which must agree with the column's if it names one. Kept to the centimetre.
 *
 * Nothing is read from anywhere else: no service is asked, and the table is the
 * venue's own, never presented as a forecast.
 */

export const MAX_TIDE_ROWS = 5000;
export const MAX_TIDE_TEXT = 400_000;
/** Heights outside these (centimetres) are taken for a typing mistake. */
export const MIN_TIDE_CM = -500;
export const MAX_TIDE_CM = 2500;

/** A row's fault, by a code the staff dictionary says (`wtr1.row.<code>`). */
export interface RowFault {
  /** The row's line in the text, counting the header as line 1; 0 for the file as a whole. */
  line: number;
  code:
    | "columns"
    | "too_many"
    | "short_row"
    | "date"
    | "time"
    | "clock"
    | "type"
    | "height"
    | "height_range"
    | "unit"
    | "dup_in_file";
  vars?: Record<string, string | number>;
}

export interface RowWarning {
  line: number;
  code: "same_kind_neighbours" | "long_gap";
  vars: Record<string, string | number>;
}

export interface ParsedTide extends TideEvent {
  line: number;
  /** As the file said it, local to the venue (or UTC): shown back to staff. */
  date: string;
  time: string;
}

export interface TideParse {
  events: ParsedTide[];
  errors: RowFault[];
  warnings: RowWarning[];
  rows: number;
}

const KIND: Record<string, TideKind> = { high: "high", h: "high", hw: "high", low: "low", l: "low", lw: "low" };

/** The columns a header may name, to the unit a height column is in. */
const HEIGHT_COLUMNS: Record<string, "m" | "cm" | "ft" | null> = { height: null, height_m: "m", height_cm: "cm", height_ft: "ft" };

const split = (line: string, sep: string) => line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());

/** A date as the file wrote it (`YYYY-MM-DD` or `DD/MM/YYYY`), as `YYYY-MM-DD`, or null. */
function readDate(text: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const date = iso ? text : dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : null;
  return date && isValidDateString(date) ? date : null;
}

/** A height figure with an optional unit, in centimetres; null when it is not a number. */
function readHeight(text: string, columnUnit: "m" | "cm" | "ft" | null): { cm: number } | { fault: "height" | "unit" } {
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(m|cm|ft)?$/i.exec(text.trim());
  if (!m) return { fault: "height" };
  const figure = Number(m[1].replace(",", "."));
  const given = (m[2]?.toLowerCase() as "m" | "cm" | "ft" | undefined) ?? null;
  if (given && columnUnit && given !== columnUnit) return { fault: "unit" };
  const unit = given ?? columnUnit ?? "m";
  const cm = unit === "m" ? figure * 100 : unit === "ft" ? figure * 30.48 : figure;
  return { cm: Math.round(cm) };
}

/**
 * Read a tide table. `zone` is the venue's time zone (where `times` is
 * "venue"). Every row is checked and every fault reported: nothing is stored
 * from a table with any (lib/launch-windows.ts), a half-read tide table being
 * worse than none.
 */
export function parseTideCsv(text: string, opts: { zone: string; times: "venue" | "utc" }): TideParse {
  const out: TideParse = { events: [], errors: [], warnings: [], rows: 0 };
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  // Blank lines are skipped but keep their numbers: a line is as the person sees it in their file.
  const headerAt = lines.findIndex((l) => l.trim() !== "");
  if (headerAt < 0) {
    out.errors.push({ line: 0, code: "columns", vars: { missing: "date, time, type, height" } });
    return out;
  }
  const head = lines[headerAt];
  const sep = [",", ";", "\t"].reduce((best, s) => (head.split(s).length > head.split(best).length ? s : best), ",");
  const names = split(head, sep).map((n) => n.toLowerCase().replace(/[\s-]+/g, "_"));
  const col = (name: string) => names.indexOf(name);
  const heightName = Object.keys(HEIGHT_COLUMNS).find((n) => col(n) >= 0);
  const missing = [col("date") < 0 ? "date" : "", col("time") < 0 ? "time" : "", col("type") < 0 ? "type" : "", heightName ? "" : "height"].filter(Boolean);
  if (missing.length > 0) {
    out.errors.push({ line: headerAt + 1, code: "columns", vars: { missing: missing.join(", ") } });
    return out;
  }
  const unit = HEIGHT_COLUMNS[heightName!];
  const seen = new Map<number, number>();

  for (let i = headerAt + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const line = i + 1;
    out.rows++;
    if (out.rows > MAX_TIDE_ROWS) {
      out.errors.push({ line, code: "too_many", vars: { max: MAX_TIDE_ROWS } });
      break;
    }
    const cells = split(lines[i], sep);
    if (cells.length < names.length) {
      out.errors.push({ line, code: "short_row", vars: { found: cells.length, needed: names.length } });
      continue;
    }
    const dateText = cells[col("date")];
    const timeText = cells[col("time")];
    const date = readDate(dateText);
    if (!date) {
      out.errors.push({ line, code: "date", vars: { value: dateText.slice(0, 20) } });
      continue;
    }
    const minute = parseClock(timeText);
    if (minute === null || minute >= 1440) {
      out.errors.push({ line, code: "time", vars: { value: timeText.slice(0, 20) } });
      continue;
    }
    const kind = KIND[cells[col("type")].toLowerCase()];
    if (!kind) {
      out.errors.push({ line, code: "type", vars: { value: cells[col("type")].slice(0, 20) } });
      continue;
    }
    const height = readHeight(cells[col(heightName!)], unit);
    if ("fault" in height) {
      out.errors.push({ line, code: height.fault, vars: { value: cells[col(heightName!)].slice(0, 20) } });
      continue;
    }
    if (height.cm < MIN_TIDE_CM || height.cm > MAX_TIDE_CM) {
      out.errors.push({ line, code: "height_range", vars: { value: cells[col(heightName!)].slice(0, 20), min: MIN_TIDE_CM / 100, max: MAX_TIDE_CM / 100 } });
      continue;
    }
    let atMs: number;
    if (opts.times === "utc") {
      const [y, mo, d] = date.split("-").map(Number);
      atMs = Date.UTC(y, mo - 1, d, 0, minute);
    } else {
      // A time the clocks skip does not exist, one they repeat is two moments: neither is guessed.
      if (clockProblem(date, minute, opts.zone) !== null) {
        out.errors.push({ line, code: "clock", vars: { date, time: timeText } });
        continue;
      }
      atMs = instantOf(date, minute, opts.zone).getTime();
    }
    const first = seen.get(atMs);
    if (first !== undefined) {
      out.errors.push({ line, code: "dup_in_file", vars: { first } });
      continue;
    }
    seen.set(atMs, line);
    out.events.push({ atMs, kind, cm: height.cm, line, date, time: timeText });
  }

  // Neighbours worth a second look: not errors, since the table may be right, but the windows will not use them.
  const sorted = [...out.events].sort((a, b) => a.atMs - b.atMs);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a.kind === b.kind && b.atMs - a.atMs <= MAX_TIDE_GAP_MIN * 60_000)
      out.warnings.push({ line: b.line, code: "same_kind_neighbours", vars: { before: a.line, kind: b.kind } });
    else if (b.atMs - a.atMs > MAX_TIDE_GAP_MIN * 60_000)
      out.warnings.push({ line: b.line, code: "long_gap", vars: { before: a.line, hours: Math.round((b.atMs - a.atMs) / 3_600_000) } });
  }
  return out;
}
