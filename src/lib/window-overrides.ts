import { getDb } from "./db";
import { logAction } from "./activity";
import { errorText, translator, type ErrorCode } from "./i18n";
import { formatMinute, type Span } from "./interval";
import { windowText, type LaunchDay } from "./launch-day";
import { isWindowCode, managerMayGoPast, type WindowCode } from "./restriction-strength";
import type { Refusal } from "./types";

/**
 * A manager's override of an advisory launch or tide window, for one booking, with a reason that is kept (ADR 0046, which
 * supersedes the sentence in ADR 0037 that no override goes past a window).
 *
 * A window is the venue's own judgement, so it is advisory unless the venue marked its rule hard (`launch_rules.strength`,
 * lib/launch-windows.ts). Where a booking, a move, a reschedule or a class term is refused for a window (`LAUNCH_WINDOW`,
 * `LAUNCH_RETURN`, `LAUNCH_CLOSED`, `TIDE_NO_DATA`, `LAUNCH_WEEK`), an authorised manager of the venue may go past it by sending
 * `overrideWindow: true` and a `windowReason` at least as long as the venue's minimum (install data 15, the venue may change it). The
 * request is checked again here (`windowOverrideAuth`): a manager of this venue, the venue not having turned the override off, a
 * reason of the length. Front desk, customers and the venue's API key are never offered it and never accepted.
 *
 * What it never reaches: a hard window; a change of the clocks (`CLOCK_CHANGE`); a closure, outage, block or rain-out (the database
 * holds that time, lib/claims.ts, a safety closure or not); the roster's required supervision (`SV1_NO_SUPERVISOR`, lib/rosters.ts); the
 * court's booking rules, eligibility, sign-offs, capacity. A manager's older override of a court's booking rules still goes past none
 * of the window.
 *
 * What it writes, in the booking's own transaction, only for what was actually refused: a row of `booking_window_overrides` (who, when,
 * why, which rule, which refusal, the day's window as it stood) and an entry in the staff activity log; both or neither, so a
 * preview or a booking that fails leaves nothing. A manager reads them as a report, and a venue's count in a week over its limit
 * is a needs-attention line (`windowOverrideAlert`). The customer's result is a normal booking, unchanged.
 */

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

/** A reason is read as written: a few words at least, no essay. */
export const WINDOW_REASON_MAX = 300;

/** Who is overriding and why, once the route has authorised it. */
export interface WindowOverrideRecord {
  venueId: number;
  adminId: number;
  adminName: string;
  reason: string;
  /**
   * Writes the activity log's entry, given by the route that authorised the override (`windowOverrideAuth`): the booking path runs it in the
   * booking's own transaction beside the record, so both stand or neither does (and the log is the route's, not the engine's).
   */
  log?: (entry: { action: string; bookingCode: string | null; detail: string }) => Promise<void>;
}

/** What a request asks for, read from its body: nothing, the reason given, or why not. */
export function readWindowOverride(body: Record<string, unknown>): { reason: string } | Refusal | null {
  const { overrideWindow, windowReason } = body;
  if ((overrideWindow === undefined || overrideWindow === null || overrideWindow === false) && (windowReason === undefined || windowReason === null)) return null;
  if (overrideWindow !== true) return refuse("SAFE1_WINDOW_REASON", { min: 1, max: WINDOW_REASON_MAX });
  const reason = typeof windowReason === "string" ? windowReason.trim() : "";
  if (reason.length === 0 || reason.length > WINDOW_REASON_MAX) return refuse("SAFE1_WINDOW_REASON", { min: 1, max: WINDOW_REASON_MAX });
  return { reason };
}

// ------------------------------------------------------------ the venue's settings

export interface WindowOverrideSettings {
  /** The venue lets its managers override an advisory window (default yes: the owner's decision). */
  enabled: boolean;
  /** The shortest reason, in characters. */
  reasonMin: number;
  /** More overrides than this in 7 days raises a needs-attention line; 0 is no alert. */
  weeklyAlert: number;
  /** Whether the venue has its own figure for each, or the install's. */
  own: { reasonMin: boolean; weeklyAlert: boolean };
}

async function defaults(): Promise<{ reasonMin: number; weeklyAlert: number }> {
  const row = (await getDb().prepare("SELECT reason_min, weekly_alert FROM window_override_defaults WHERE id = 1").get()) as { reason_min: number; weekly_alert: number } | undefined;
  return { reasonMin: row ? Number(row.reason_min) : 15, weeklyAlert: row ? Number(row.weekly_alert) : 5 };
}

export async function windowSettings(venueId: number): Promise<WindowOverrideSettings> {
  const base = await defaults();
  const row = (await getDb().prepare("SELECT enabled, reason_min, weekly_alert FROM venue_window_override_settings WHERE venue_id = ?").get(venueId)) as
    | { enabled: boolean; reason_min: number | null; weekly_alert: number | null }
    | undefined;
  return {
    enabled: row ? row.enabled === true : true,
    reasonMin: row?.reason_min != null ? Number(row.reason_min) : base.reasonMin,
    weeklyAlert: row?.weekly_alert != null ? Number(row.weekly_alert) : base.weeklyAlert,
    own: { reasonMin: row?.reason_min != null, weeklyAlert: row?.weekly_alert != null },
  };
}

/** A manager's change to the venue's settings: only what is given changes; `null` or "" takes a figure back to the install's. */
export async function saveWindowSettings(
  venueId: number,
  input: { enabled?: unknown; reasonMin?: unknown; weeklyAlert?: unknown },
  adminId: number | null
): Promise<{ ok: true; settings: WindowOverrideSettings; before: WindowOverrideSettings } | { ok: false; error: string }> {
  const before = await windowSettings(venueId);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return { ok: false, error: "Allowing the override is yes or no." };
  const figure = (v: unknown, min: number, max: number): number | null | "bad" | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : "bad";
  };
  const reasonMin = figure(input.reasonMin, 3, WINDOW_REASON_MAX);
  const weeklyAlert = figure(input.weeklyAlert, 0, 1000);
  if (reasonMin === "bad") return { ok: false, error: `The shortest reason is a whole number of characters, from 3 to ${WINDOW_REASON_MAX}.` };
  if (weeklyAlert === "bad") return { ok: false, error: "The weekly alert is a whole number of overrides, from 0 (no alert) to 1000." };
  const enabled = typeof input.enabled === "boolean" ? input.enabled : before.enabled;
  const nextReason = reasonMin === undefined ? (before.own.reasonMin ? before.reasonMin : null) : reasonMin;
  const nextAlert = weeklyAlert === undefined ? (before.own.weeklyAlert ? before.weeklyAlert : null) : weeklyAlert;
  await getDb()
    .prepare(
      `INSERT INTO venue_window_override_settings (venue_id, enabled, reason_min, weekly_alert, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, now())
       ON CONFLICT (venue_id) DO UPDATE SET enabled = EXCLUDED.enabled, reason_min = EXCLUDED.reason_min, weekly_alert = EXCLUDED.weekly_alert,
                                            updated_by = EXCLUDED.updated_by, updated_at = now()`
    )
    .run(venueId, enabled, nextReason, nextAlert, adminId);
  return { ok: true, settings: await windowSettings(venueId), before };
}

// ------------------------------------------------------------ authorising a request

/**
 * May this member of staff override the advisory windows at this venue, with this reason? A manager of the venue (the caller has
 * checked the venue is theirs), where the venue has not turned it off and the reason is as long as the venue asks. Front desk never
 * (403), as every manager's power answers them (lib/roles.ts).
 */
export async function windowOverrideAuth(
  staff: { id: number; name: string; role: "manager" | "desk"; owner?: boolean } | null,
  venueId: number,
  reason: string
): Promise<{ ok: true; record: WindowOverrideRecord } | { ok: false; refusal: Refusal; status: number }> {
  // The platform owner's own emergency override is a separate decision and not built (ADR 0046): the owner account is no venue's manager here.
  if (!staff || staff.role === "desk" || staff.owner === true) return { ok: false, refusal: refuse("SAFE1_WINDOW_MANAGERS"), status: 403 };
  const settings = await windowSettings(venueId);
  if (!settings.enabled) return { ok: false, refusal: refuse("SAFE1_WINDOW_OFF"), status: 403 };
  if (reason.length < settings.reasonMin || reason.length > WINDOW_REASON_MAX)
    return { ok: false, refusal: refuse("SAFE1_WINDOW_REASON", { min: settings.reasonMin, max: WINDOW_REASON_MAX }), status: 400 };
  const by = { id: staff.id, name: staff.name };
  return { ok: true, record: { venueId, adminId: staff.id, adminName: staff.name, reason, log: (entry) => logAction(by, { venueId, ...entry }) } };
}

/**
 * Whether a window refusal may be gone past, for the booking path: the override was asked and authorised, and the rule that made
 * the refusal is advisory (never a hard one, and never a refusal that is not a window's at all).
 */
export function mayGoPastWindow(record: WindowOverrideRecord | undefined, day: Pick<LaunchDay, "strength"> | null | undefined): boolean {
  return record !== undefined && day != null && managerMayGoPast(day.strength);
}

/** What a manager is told at the counter about a window refusal: the offer, or that there is none. */
export async function windowOffer(
  staff: { role: "manager" | "desk"; owner?: boolean } | null,
  venueId: number,
  code: string | undefined,
  strength: "advisory" | "hard" | null
): Promise<{ policy: "launch_window"; overridable: boolean; askManager: boolean; hard: boolean; reasonMin: number } | null> {
  if (!staff || !isWindowCode(code)) return null;
  const settings = await windowSettings(venueId);
  if (strength === "hard") return { policy: "launch_window", overridable: false, askManager: false, hard: true, reasonMin: settings.reasonMin };
  return {
    policy: "launch_window",
    overridable: settings.enabled && staff.role !== "desk" && staff.owner !== true,
    askManager: settings.enabled && staff.role === "desk",
    hard: false,
    reasonMin: settings.reasonMin,
  };
}

// ------------------------------------------------------------ the record

/** The day's window as a line, as the venue's rule left it. */
export function windowLine(day: LaunchDay | null | undefined): string {
  if (!day || day.windows.length === 0) return "closed";
  return `${day.windows.map((w) => windowText(w)).join(", ")}${day.returnBuffer > 0 ? `, back ${day.returnBuffer} min before it closes` : ""}`;
}

export interface WindowOverrideWhat {
  code: WindowCode;
  action: "booked" | "moved" | "class";
  courtId: number;
  date: string;
  span: Span;
  day: LaunchDay | null | undefined;
  /** The booking (its id and code) or the class session it was made for. */
  booking?: { id: number; code: string };
  classId?: number;
  /** What the person overridden is told in the log: the customer's name, a class's name. */
  who?: string;
}

/**
 * Write what an override let through: the row, and the activity log's entry, in the transaction that makes or moves the booking.
 * Called only for what was actually refused.
 */
export async function recordWindowOverride(record: WindowOverrideRecord, what: WindowOverrideWhat): Promise<void> {
  const line = windowLine(what.day);
  await getDb()
    .prepare(
      `INSERT INTO booking_window_overrides (venue_id, booking_id, class_id, court_id, rule_id, refusal_code, action, date, start_min, end_min, window_text, reason, admin_id, admin_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.venueId,
      what.booking?.id ?? null,
      what.classId ?? null,
      what.courtId,
      what.day?.ruleId ?? null,
      what.code,
      what.action,
      what.date,
      what.span.start,
      what.span.end,
      line,
      record.reason,
      record.adminId,
      record.adminName
    );
  await record.log?.({
    action: "booking.window_overridden",
    bookingCode: what.booking?.code ?? null,
    detail: `${what.date} ${formatMinute(what.span.start)}–${formatMinute(what.span.end)}: went past the ${what.day?.strength ?? "advisory"} window (${what.code}; ${line}) for ${what.who ?? "a booking"}: ${record.reason}`,
  });
}

// ------------------------------------------------------------ the report and the alert

export interface WindowOverrideRow {
  id: number;
  bookingCode: string | null;
  classId: number | null;
  /** A booking's customer, or a class's name. */
  who: string;
  courtName: string;
  date: string;
  startMin: number;
  endMin: number;
  code: string;
  action: "booked" | "moved" | "class";
  window: string;
  reason: string;
  adminName: string;
  ruleId: number | null;
  createdAt: string;
}

const asIso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/** A venue's overrides in the last `days` days, newest first. */
export async function windowOverridesReport(venueId: number, days = 30, limit = 200): Promise<WindowOverrideRow[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT w.id, b.code AS booking_code, w.class_id, COALESCE(b.name, k.name, '') AS who, COALESCE(c.name, '') AS court_name, w.date, w.start_min, w.end_min,
              w.refusal_code, w.action, w.window_text, w.reason, w.admin_name, w.rule_id, w.created_at
         FROM booking_window_overrides w
         LEFT JOIN bookings b ON b.id = w.booking_id
         LEFT JOIN classes k ON k.id = w.class_id
         LEFT JOIN courts c ON c.id = w.court_id
        WHERE w.venue_id = ? AND w.created_at >= now() - (?::int * interval '1 day')
        ORDER BY w.created_at DESC, w.id DESC LIMIT ?`
    )
    .all(venueId, Math.max(1, Math.min(366, Math.floor(days))), limit)) as {
    id: number; booking_code: string | null; class_id: number | null; who: string; court_name: string; date: string; start_min: number; end_min: number;
    refusal_code: string; action: "booked" | "moved" | "class"; window_text: string; reason: string; admin_name: string; rule_id: number | null; created_at: unknown;
  }[];
  return rows.map((r) => ({
    id: r.id,
    bookingCode: r.booking_code,
    classId: r.class_id,
    who: r.who,
    courtName: r.court_name,
    date: r.date,
    startMin: Number(r.start_min),
    endMin: Number(r.end_min),
    code: r.refusal_code,
    action: r.action,
    window: r.window_text,
    reason: r.reason,
    adminName: r.admin_name,
    ruleId: r.rule_id,
    createdAt: asIso(r.created_at),
  }));
}

/** How many overrides this venue has made in the last `days` days. */
export async function windowOverrideCount(venueId: number, days: number): Promise<number> {
  const row = (await getDb()
    .prepare("SELECT COUNT(*) AS n FROM booking_window_overrides WHERE venue_id = ? AND created_at >= now() - (?::int * interval '1 day')")
    .get(venueId, days)) as { n: number };
  return Number(row.n);
}

/** The needs-attention line: more overrides in 7 days than the venue's limit. Null where within it (or no alert is set). */
export async function windowOverrideAlert(venueId: number): Promise<{ venueId: number; count: number; limit: number; days: 7 } | null> {
  const { weeklyAlert } = await windowSettings(venueId);
  if (weeklyAlert <= 0) return null;
  const count = await windowOverrideCount(venueId, 7);
  return count > weeklyAlert ? { venueId, count, limit: weeklyAlert, days: 7 } : null;
}

export interface BookingWindowOverride {
  code: string;
  window: string;
  reason: string;
  adminName: string;
  createdAt: string;
}

/** The overrides on these bookings, for the staff dashboard. */
export async function windowOverridesFor(bookingIds: number[]): Promise<Map<number, BookingWindowOverride[]>> {
  const out = new Map<number, BookingWindowOverride[]>();
  if (bookingIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT booking_id, refusal_code, window_text, reason, admin_name, created_at FROM booking_window_overrides
        WHERE booking_id IN (${bookingIds.map(() => "?").join(",")}) ORDER BY id`
    )
    .all(...bookingIds)) as { booking_id: number; refusal_code: string; window_text: string; reason: string; admin_name: string; created_at: unknown }[];
  for (const r of rows)
    out.set(r.booking_id, [...(out.get(r.booking_id) ?? []), { code: r.refusal_code, window: r.window_text, reason: r.reason, adminName: r.admin_name, createdAt: asIso(r.created_at) }]);
  return out;
}
