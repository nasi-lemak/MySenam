import { NextResponse } from "next/server";
import type { Refusal } from "./types";
import { isMinute, parseClock } from "./interval";

/**
 * A request's JSON body, which a handler reads fields of: an object, or it
 * throws, as `req.json()` does on text that is not JSON, for the handler's own
 * catch to answer 400. `null`, a list, a number or a string is valid JSON
 * but no body of fields, so it is refused the same way rather than read.
 */
export async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  const body = (await req.json()) as unknown;
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("The JSON body is not an object.");
  return body as Record<string, unknown>;
}

/** `jsonObject`, or the 400 to send: for a handler without a catch of its own. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    return await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
}

/**
 * A refusal, on its way to the browser.
 *
 * `error` is the English sentence and goes out whatever happens, so anything
 * reading it keeps working. `code` and `vars` ride alongside when the store
 * named the refusal, which is what lets the page say it in the reader's
 * language instead of this one.
 */
export function refusal(r: Refusal, status = 409): NextResponse {
  // Too busy to finish (lib/db.ts, BusyError): nothing was kept, so it is safe to send again.
  if (r.code === "BUSY") return NextResponse.json({ error: r.error, code: r.code }, { status: 503, headers: { "Retry-After": "2" } });
  return NextResponse.json({ error: r.error, code: r.code, vars: r.vars }, { status });
}

/** When a request asks for: exact minutes of the business day, or the older list of grid columns. */
export interface RequestedTime {
  start?: number;
  end?: number;
  minutes?: number;
  hours?: number[];
  /** On a resource sold by the game: how many games from `start` (lib/store.ts `spanFor`). */
  games?: number;
}

/**
 * Read the time a request asks for. `start` and `end` are minutes of the
 * business day (1087 is 18:07; past 1440 is after midnight) or "HH:MM";
 * `minutes` is a length instead of an end. `hours`, the older form, lists
 * the grid columns chosen (18 and 18.5), read on the court's own grid.
 * Whether the court allows that time is the store's to say.
 */
export function readTime(
  body: Record<string, unknown>,
  /** Where a booking may be asked for by the game: `games` and a `start` are enough (the bookings, quote and API routes). */
  opts: { games?: boolean } = {}
): { ok: true; when: RequestedTime } | { ok: false; error: string } {
  const minute = (v: unknown): number | null | undefined =>
    v === undefined || v === null ? undefined : typeof v === "string" ? parseClock(v) : isMinute(v) ? v : null;
  const start = minute(body.start);
  if (opts.games && body.games !== undefined && body.games !== null) {
    // By the game: a start and how many games; the length is the venue's estimate for them (lib/booking-rules.ts `gameHold`).
    const games = typeof body.games === "string" && /^\d+$/.test(body.games) ? Number(body.games) : body.games;
    if (!Number.isInteger(games) || (games as number) < 1 || (games as number) > 20) return { ok: false, error: "games must be a whole number of games, 1 to 20." };
    if (start === undefined || start === null) return { ok: false, error: "start must be minutes of the day (0–1680) or HH:MM." };
    return { ok: true, when: { start, games: games as number } };
  }
  if (start !== undefined) {
    const end = minute(body.end);
    const minutes = body.minutes;
    if (start === null) return { ok: false, error: "start must be minutes of the day (0–1680) or HH:MM." };
    if (end === null) return { ok: false, error: "end must be minutes of the day (0–1680) or HH:MM." };
    if (end === undefined && !(Number.isInteger(minutes) && (minutes as number) > 0))
      return { ok: false, error: "Give an end, or a length in minutes." };
    return { ok: true, when: end !== undefined ? { start, end } : { start, minutes: minutes as number } };
  }
  const hours = body.hours;
  if (!Array.isArray(hours) || hours.length === 0 || hours.length > 96 || !hours.every((h) => typeof h === "number" && isMinute(Math.round(h * 60)) && Number.isInteger(h * 60)))
    return { ok: false, error: "Give start and end (minutes of the day, or HH:MM), or hours as a list of grid times." };
  return { ok: true, when: { hours: hours as number[] } };
}

/**
 * A minute of the day from a request: `body[key]` as minutes or HH:MM, else
 * `body[hourKey]` in hours (18.5), the older form. NaN when neither reads.
 */
export function readMinute(body: Record<string, unknown>, key: string, hourKey?: string): number {
  const v = body[key];
  if (v !== undefined && v !== null) {
    const m = typeof v === "string" ? parseClock(v) : isMinute(v) ? v : null;
    return m === null ? NaN : m;
  }
  const h = hourKey ? body[hourKey] : undefined;
  return typeof h === "number" && Number.isFinite(h) ? Math.round(h * 60) : NaN;
}
