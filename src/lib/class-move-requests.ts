import { createHash } from "node:crypto";
import { logAction } from "./activity";
import { canAccessVenue, type Admin } from "./admin-auth";
import { moveClasses, previewClassMove, type ClassMoveResult, type ClassMoveTo, type MovePreview, type Planned } from "./class-moves";
import { getDb, isUniqueViolation } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { formatMinute, instantOf } from "./interval";
import { tellVenueStaffEach } from "./owner-alerts";
import { baseUrl, emailPlain } from "./outbox";
import { peakRules } from "./peak";
import { staffReaderLocale } from "./staff-locales";
import { staffTranslator, type StaffT } from "./staff-i18n";
import { siteName } from "./site";
import { computePrice, getCourt, venueHours } from "./store";
import type { Refusal } from "./types";

/**
 * Front-desk class moves, and the approval a consequential or exceptional one waits for
 * (docs/features/programmes.md#front-desk-moves-and-approval; ADR 0045; migration 0287).
 *
 * Front desk may move a class at its own venue (`moveClasses`, the one path, preview first) unless a manager has turned that off for the venue
 * (`venues.desk_may_move_classes`, on by default). A manager's own move never needs approval. A desk's move is looked at first, in the preview's own
 * terms: where it meets any of the venue's thresholds (`ClassMoveRules`: all data, with defaults) it is **not applied**; it is stored as a request, with
 * why it needs approval and the preview as the desk saw it, and a manager approves or declines it. Approving makes the move through `moveClasses`, whose
 * own transaction also marks the request approved (`MoveHooks`), after re-reading, under the classes' row locks, everything the request was
 * computed from: a request whose class, enrolments or waiting list changed since is refused as changed and closed. Nobody enrolled or waiting hears
 * anything until a move is actually applied (and then as for any move: `sendClassMoveNotices`, which never names a member of staff).
 *
 * What needs approval is `approvalReasons`:
 *   financially consequential: the new time or court prices differently (court time at the venue's rates, `computePrice`); a term or series with
 *   paid enrolments in it; and, where the venue asks for it (`paidPeople`, off by default), more than that many people who paid or hold a pass entry
 *   or a membership's benefit going through the move;
 *   exceptional: more than `maxDays` days from where a session was; more than `maxSeries` sessions; the session starting (or going to start) within
 *   `withinHours`; people waiting for it; a session that has been moved before.
 */

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

// ---------------------------------------------------------------- the venue's rules

/** What a venue has set for front desk's class moves; every number is the install's default until a manager changes it. */
export interface ClassMoveRules {
  /** Front desk may move a class at this venue (on by default). */
  deskMayMove: boolean;
  /** A move of more than this many days from where a session was needs approval. */
  maxDays: number;
  /** A move of more than this many sessions needs approval. */
  maxSeries: number;
  /** A session that starts, or would start, within this many hours needs approval. */
  withinHours: number;
  /** More than this many paying people needs approval; null: the number of people is not asked. */
  paidPeople: number | null;
  /** A time or court that prices differently needs approval. */
  priceCheck: boolean;
  /** Days a request waits for a manager before it closes itself (never past the class's start). */
  requestDays: number;
}

export const DEFAULT_CLASS_MOVE_RULES: ClassMoveRules = { deskMayMove: true, maxDays: 14, maxSeries: 4, withinHours: 24, paidPeople: null, priceCheck: true, requestDays: 7 };

interface RulesRow {
  desk_may_move_classes: boolean;
  class_move_max_days: number;
  class_move_max_series: number;
  class_move_within_hours: number;
  class_move_paid_people: number | null;
  class_move_price_check: boolean;
  class_move_request_days: number;
}

export async function classMoveRules(venueId: number): Promise<ClassMoveRules> {
  const r = (await getDb()
    .prepare(
      `SELECT desk_may_move_classes, class_move_max_days, class_move_max_series, class_move_within_hours, class_move_paid_people, class_move_price_check, class_move_request_days
         FROM venues WHERE id = ?`
    )
    .get(venueId)) as RulesRow | undefined;
  if (!r) return { ...DEFAULT_CLASS_MOVE_RULES };
  return {
    deskMayMove: r.desk_may_move_classes === true,
    maxDays: Number(r.class_move_max_days),
    maxSeries: Number(r.class_move_max_series),
    withinHours: Number(r.class_move_within_hours),
    paidPeople: r.class_move_paid_people === null ? null : Number(r.class_move_paid_people),
    priceCheck: r.class_move_price_check === true,
    requestDays: Number(r.class_move_request_days),
  };
}

const whole = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** A manager sets them (all optional; what is left out stays). Returns the rules and what changed, in words for the activity log. */
export async function setClassMoveRules(
  venueId: number,
  input: Record<string, unknown>
): Promise<{ ok: true; rules: ClassMoveRules; changed: string[] } | { ok: false; error: string; code: "CLS3_RULES_RANGE" }> {
  const was = await classMoveRules(venueId);
  const next = { ...was };
  let bad = false;
  const take = <K extends "maxDays" | "maxSeries" | "withinHours" | "requestDays">(key: K, min: number, max: number) => {
    if (input[key] === undefined) return;
    const n = whole(input[key], min, max);
    if (n === null) bad = true;
    else next[key] = n;
  };
  take("maxDays", 0, 365);
  take("maxSeries", 0, 52);
  take("withinHours", 0, 720);
  take("requestDays", 1, 60);
  if (input.paidPeople !== undefined) {
    const n = input.paidPeople === null ? null : whole(input.paidPeople, 0, 1000);
    if (input.paidPeople !== null && n === null) bad = true;
    else next.paidPeople = n;
  }
  for (const key of ["deskMayMove", "priceCheck"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") bad = true;
    else next[key] = input[key] as boolean;
  }
  if (bad) {
    const r = refuse("CLS3_RULES_RANGE");
    return { ok: false, error: r.error, code: "CLS3_RULES_RANGE" };
  }
  await getDb()
    .prepare(
      `UPDATE venues SET desk_may_move_classes = ?, class_move_max_days = ?, class_move_max_series = ?, class_move_within_hours = ?, class_move_paid_people = ?,
              class_move_price_check = ?, class_move_request_days = ? WHERE id = ?`
    )
    .run(next.deskMayMove, next.maxDays, next.maxSeries, next.withinHours, next.paidPeople, next.priceCheck, next.requestDays, venueId);
  const changed: string[] = [];
  const diff = (label: string, a: unknown, b: unknown) => {
    if (a !== b) changed.push(`${label} ${String(a ?? "off")} → ${String(b ?? "off")}`);
  };
  diff("front desk may move classes", was.deskMayMove, next.deskMayMove);
  diff("approval beyond days", was.maxDays, next.maxDays);
  diff("approval beyond sessions", was.maxSeries, next.maxSeries);
  diff("approval within hours", was.withinHours, next.withinHours);
  diff("approval beyond paying people", was.paidPeople, next.paidPeople);
  diff("approval when the price differs", was.priceCheck, next.priceCheck);
  diff("request waits days", was.requestDays, next.requestDays);
  return { ok: true, rules: next, changed };
}

// ---------------------------------------------------------------- what needs approval

export const APPROVAL_REASONS = ["price", "paid_term", "paid_people", "far", "long_series", "soon", "waiting", "second"] as const;
export type ApprovalReasonCode = (typeof APPROVAL_REASONS)[number];

/** Why a move needs a manager's approval, as stored with the request and shown to the desk and the manager. */
export interface ApprovalReason {
  code: ApprovalReasonCode;
  kind: "financial" | "exceptional";
  /** How many (sessions, people, days or hours, as the code says) and the limit it passed, where it has one. */
  n?: number;
  limit?: number;
}

const FINANCIAL: ApprovalReasonCode[] = ["price", "paid_term", "paid_people"];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * What in this (feasible) move needs a manager, read from its preview and the venue's rules; none for a manager's own move (never asked). The tests are all
 * "more than", so a threshold of 0 means any.
 */
export async function approvalReasons(venueId: number, preview: MovePreview, rules: ClassMoveRules, now = Date.now()): Promise<ApprovalReason[]> {
  const out: ApprovalReason[] = [];
  const db = getDb();
  const sessions = preview.sessions;
  const ids = sessions.map((s) => s.classId);
  const bookingIds = sessions.flatMap((s) => s.people.map((p) => p.bookingId));
  const { zone } = await venueHours(venueId);
  const add = (code: ApprovalReasonCode, extra: { n?: number; limit?: number } = {}) =>
    out.push({ code, kind: FINANCIAL.includes(code) ? "financial" : "exceptional", ...extra });

  // Financial: the court's time prices differently at the new time or on the new court (the class's own price is per place and never changes).
  if (rules.priceCheck) {
    const rulesOf = await peakRules(venueId);
    let differ = 0;
    for (const s of sessions) {
      const [was, now2] = [await getCourt(s.from.courtId), await getCourt(s.to.courtId)];
      if (!was || !now2) continue;
      const before = computePrice(was, s.from.date, { start: s.from.startMin, end: s.from.endMin }, false, rulesOf);
      const after = computePrice(now2, s.to.date, { start: s.to.startMin, end: s.to.endMin }, false, rulesOf);
      if (Math.abs(before - after) > 0.004) differ++;
    }
    if (differ > 0) add("price", { n: differ });
  }
  if (bookingIds.length > 0) {
    const list = marks(bookingIds.length);
    // Somebody who paid (money in), or holds a pass entry or a membership's benefit: what a cancellation within the refund window gives back.
    const owing = `(b.payment_status = 'paid' AND b.total_price > 0)
        OR EXISTS (SELECT 1 FROM pass_entries e WHERE e.booking_id = b.id AND e.delta < 0)
        OR EXISTS (SELECT 1 FROM place_benefits pb WHERE pb.booking_id = b.id)`;
    if (sessions.length > 1) {
      const term = (await db.prepare(`SELECT 1 AS x FROM bookings b WHERE b.id IN (${list}) AND b.series_code IS NOT NULL AND b.payment_status = 'paid' AND b.total_price > 0 LIMIT 1`).get(...bookingIds)) as
        | { x: number }
        | undefined;
      if (term) add("paid_term", { n: sessions.length });
    }
    if (rules.paidPeople !== null) {
      const paying = (await db
        .prepare(`SELECT COUNT(DISTINCT COALESCE(b.user_id::text, phone_key(b.phone)))::int AS n FROM bookings b WHERE b.id IN (${list}) AND (${owing})`)
        .get(...bookingIds)) as { n: number };
      if (Number(paying.n) > rules.paidPeople) add("paid_people", { n: Number(paying.n), limit: rules.paidPeople });
    }
  }

  // Exceptional.
  const farthest = Math.max(0, ...sessions.map((s) => Math.abs(daysBetween(s.from.date, s.to.date))));
  if (farthest > rules.maxDays) add("far", { n: farthest, limit: rules.maxDays });
  if (sessions.length > rules.maxSeries) add("long_series", { n: sessions.length, limit: rules.maxSeries });
  const horizon = now + rules.withinHours * 3_600_000;
  if (sessions.some((s) => instantOf(s.from.date, s.from.startMin, zone).getTime() <= horizon || instantOf(s.to.date, s.to.startMin, zone).getTime() <= horizon))
    add("soon", { limit: rules.withinHours });
  const waiting = sessions.reduce((n, s) => n + s.waiting, 0);
  if (waiting > 0) add("waiting", { n: waiting });
  const before = (await db.prepare(`SELECT COUNT(DISTINCT class_id)::int AS n FROM class_move_sessions WHERE class_id IN (${marks(ids.length)})`).get(...ids)) as { n: number };
  if (Number(before.n) > 0) add("second", { n: Number(before.n) });
  return out;
}

// ---------------------------------------------------------------- what a request was computed from

interface Fingerprinted {
  classId: number;
  from: { date: string; startMin: number; endMin: number; courtId: number };
  to: { date: string; startMin: number; endMin: number; courtId: number };
  bookings: number[];
  waiting: number;
}

const fingerprintOf = (rows: Fingerprinted[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...rows]
          .sort((a, b) => a.classId - b.classId)
          .map((r) => [r.classId, r.from.date, r.from.startMin, r.from.endMin, r.from.courtId, r.to.date, r.to.startMin, r.to.endMin, r.to.courtId, [...r.bookings].sort((a, b) => a - b), r.waiting])
      )
    )
    .digest("hex");

const fingerprintOfPreview = (p: MovePreview): string =>
  fingerprintOf(
    p.sessions.map((s) => ({
      classId: s.classId,
      from: { date: s.from.date, startMin: s.from.startMin, endMin: s.from.endMin, courtId: s.from.courtId },
      to: { date: s.to.date, startMin: s.to.startMin, endMin: s.to.endMin, courtId: s.to.courtId },
      bookings: s.people.map((x) => x.bookingId),
      waiting: s.waiting,
    }))
  );

/** The same, read from the database for the sessions about to move: called under their row locks, where nobody can enrol or leave. */
async function fingerprintOfPlan(planned: Planned): Promise<string> {
  const db = getDb();
  const rows: Fingerprinted[] = [];
  for (const item of planned.items) {
    const s = item.session;
    const bookings = (await db.prepare("SELECT id FROM bookings WHERE class_id = ? AND status = 'confirmed' ORDER BY id").all(s.id)) as { id: number }[];
    const waiting = (await db.prepare("SELECT COUNT(*)::int AS n FROM waitlist WHERE class_id = ? AND status IN ('waiting', 'offered')").get(s.id)) as { n: number };
    rows.push({
      classId: s.id,
      from: { date: s.date, startMin: s.startMin, endMin: s.endMin, courtId: s.courtId },
      to: { date: item.to.date, startMin: item.to.startMin, endMin: item.to.endMin, courtId: item.to.courtId },
      bookings: bookings.map((b) => b.id),
      waiting: Number(waiting.n),
    });
  }
  return fingerprintOf(rows);
}

// ---------------------------------------------------------------- the request

export type RequestStatus = "open" | "approved" | "declined" | "expired" | "closed";

interface RequestRow {
  id: number;
  venue_id: number;
  class_id: number;
  scope: "one" | "following" | "term";
  to_date: string;
  to_start_min: number;
  to_court_id: number | null;
  requested_by_admin_id: number | null;
  requested_by_name: string;
  note: string | null;
  reasons: string;
  snapshot: string;
  fingerprint: string;
  status: RequestStatus;
  created_at: Date | string;
  expires_at: Date | string;
  decided_by_admin_id: number | null;
  decided_by_name: string | null;
  decided_at: Date | string | null;
  decision_note: string | null;
  closed_reason: string | null;
  move_id: number | null;
}

interface SnapshotSession {
  classId: number;
  name: string;
  from: { date: string; startMin: number; endMin: number; courtId: number; courtName: string };
  to: { date: string; startMin: number; endMin: number; courtId: number; courtName: string };
  enrolled: number;
  waiting: number;
}

/** A request as the dashboard shows it: never a person's name, only counts. */
export interface MoveRequestView {
  id: number;
  venueId: number;
  classId: number;
  className: string;
  scope: "one" | "following" | "term";
  sessions: number;
  /** The chosen session, from and to, as it stood when asked. */
  from: SnapshotSession["from"];
  to: SnapshotSession["to"];
  enrolled: number;
  waiting: number;
  requestedBy: string;
  requestedByMe: boolean;
  note: string | null;
  reasons: ApprovalReason[];
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** `started`, `cancelled` or `changed` where it closed without a decision. */
  closedReason: string | null;
  moveId: number | null;
}

const iso = (d: Date | string) => new Date(d).toISOString();

function viewOf(row: RequestRow, viewerId: number | null): MoveRequestView {
  const snap = JSON.parse(row.snapshot) as { sessions: SnapshotSession[] };
  const chosen = snap.sessions.find((s) => s.classId === row.class_id) ?? snap.sessions[0];
  return {
    id: row.id,
    venueId: row.venue_id,
    classId: row.class_id,
    className: chosen.name,
    scope: row.scope,
    sessions: snap.sessions.length,
    from: chosen.from,
    to: chosen.to,
    enrolled: snap.sessions.reduce((n, s) => n + s.enrolled, 0),
    waiting: snap.sessions.reduce((n, s) => n + s.waiting, 0),
    requestedBy: row.requested_by_name,
    requestedByMe: viewerId !== null && row.requested_by_admin_id === viewerId,
    note: row.note,
    reasons: JSON.parse(row.reasons) as ApprovalReason[],
    status: row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    decidedBy: row.decided_by_name,
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    decisionNote: row.decision_note,
    closedReason: row.closed_reason,
    moveId: row.move_id,
  };
}

async function requestRow(id: number): Promise<RequestRow | undefined> {
  return (await getDb().prepare("SELECT * FROM class_move_requests WHERE id = ?").get(id)) as RequestRow | undefined;
}

/** The words for the activity log: which session, from and to, and why it needed a manager. */
function describe(view: MoveRequestView): string {
  const at = (w: SnapshotSession["from"]) => `${w.date} ${formatMinute(w.startMin)}–${formatMinute(w.endMin)} ${w.courtName}`;
  const many = view.sessions > 1 ? `, ${view.sessions} sessions (${view.scope === "term" ? "the whole term" : "from this one"})` : "";
  return `${view.className}${many}: ${at(view.from)} → ${at(view.to)}; needs approval: ${view.reasons.map((r) => r.code).join(", ")}`;
}

const SYSTEM = { id: null, name: "System" };

/**
 * Open requests that can no longer be decided are closed, and said so in the activity log: past their days (`expired`), for a class that has begun or been
 * cancelled, or one that was moved or changed some other way meanwhile (`closed`, with the reason). Run before every read and decision, for the venues given
 * (null: all).
 */
export async function closeStaleRequests(venueIds: number[] | null = null): Promise<number> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT r.id, r.venue_id, r.class_id, r.expires_at, r.snapshot, r.requested_by_name, r.scope, c.status AS class_status, c.date AS class_date, c.start_min AS class_start,
              c.court_id AS class_court
         FROM class_move_requests r JOIN classes c ON c.id = r.class_id
        WHERE r.status = 'open'${venueIds === null ? "" : venueIds.length === 0 ? " AND FALSE" : ` AND r.venue_id IN (${marks(venueIds.length)})`}`
    )
    .all(...(venueIds ?? []))) as {
    id: number;
    venue_id: number;
    class_id: number;
    expires_at: Date | string;
    snapshot: string;
    requested_by_name: string;
    scope: string;
    class_status: string;
    class_date: string;
    class_start: number;
    class_court: number;
  }[];
  let closed = 0;
  const zones = new Map<number, string>();
  for (const r of rows) {
    if (!zones.has(r.venue_id)) zones.set(r.venue_id, (await venueHours(r.venue_id)).zone);
    const snap = JSON.parse(r.snapshot) as { sessions: SnapshotSession[] };
    const chosen = snap.sessions.find((s) => s.classId === r.class_id) ?? snap.sessions[0];
    let status: "expired" | "closed" | null = null;
    let why: string | null = null;
    if (r.class_status === "cancelled") [status, why] = ["closed", "cancelled"];
    else if (instantOf(r.class_date, r.class_start, zones.get(r.venue_id)!).getTime() <= Date.now()) [status, why] = ["closed", "started"];
    else if (new Date(r.expires_at).getTime() <= Date.now()) status = "expired";
    else if (r.class_date !== chosen.from.date || r.class_start !== chosen.from.startMin || r.class_court !== chosen.from.courtId) [status, why] = ["closed", "changed"];
    if (!status) continue;
    const done = await db
      .prepare("UPDATE class_move_requests SET status = ?, closed_reason = ?, decided_at = now() WHERE id = ? AND status = 'open' RETURNING id")
      .get(status, why, r.id);
    if (!done) continue;
    closed++;
    await logAction(SYSTEM, {
      venueId: r.venue_id,
      action: "class.move_request_closed",
      detail: `${chosen.name} ${chosen.from.date} → ${chosen.to.date}, asked by ${r.requested_by_name}: ${status === "expired" ? "no decision in time" : `closed, class ${why}`}`,
    });
  }
  return closed;
}

/**
 * The requests at these venues (null: all): every one waiting, and those decided or closed in the last `decidedDays` days. `mineOnly` keeps only the
 * viewer's own requests among the decided ones (what a desk is told of the outcome of its own).
 */
export async function listMoveRequests(
  admin: Pick<Admin, "id" | "venueIds">,
  opts: { venueId?: number; decidedDays?: number; mineOnly?: boolean } = {}
): Promise<MoveRequestView[]> {
  const venueIds = opts.venueId !== undefined ? [opts.venueId] : admin.venueIds;
  await closeStaleRequests(venueIds);
  if (venueIds !== null && venueIds.length === 0) return [];
  const cutoff = new Date(Date.now() - (opts.decidedDays ?? 14) * 86_400_000).toISOString();
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM class_move_requests
        WHERE ${venueIds === null ? "TRUE" : `venue_id IN (${marks(venueIds.length)})`}
          AND (status = 'open' OR (decided_at >= ?::timestamptz${opts.mineOnly ? " AND requested_by_admin_id = ?" : ""}))
        ORDER BY (status = 'open') DESC, COALESCE(decided_at, created_at) DESC, id DESC LIMIT 100`
    )
    .all(...(venueIds ?? []), cutoff, ...(opts.mineOnly ? [admin.id] : []))) as RequestRow[];
  return rows.map((r) => viewOf(r, admin.id));
}

export async function moveRequestVenue(id: number): Promise<number | null> {
  const r = (await getDb().prepare("SELECT venue_id FROM class_move_requests WHERE id = ?").get(id)) as { venue_id: number } | undefined;
  return r?.venue_id ?? null;
}

// ---------------------------------------------------------------- the desk's move

export type StaffMove = { id: number | null; name: string; role: "manager" | "desk" };
export type MoveOrRequest =
  | { kind: "moved"; result: Extract<ClassMoveResult, { ok: true }> }
  | { kind: "requested"; request: MoveRequestView }
  | (Refusal & { conflicts?: Extract<ClassMoveResult, { ok: false }>["conflicts"] });

const NOTE_MAX = 300;

/**
 * A move by a member of staff. A manager's is made at once, as it always was. A desk's is made at once where nothing in it needs approval, and otherwise
 * stored as a request and not applied: nobody is told, nothing moves, and a manager is emailed. A move that is blocked (something in the way) is refused
 * as ever, with nothing stored.
 */
export async function moveOrRequest(staff: StaffMove, classId: number, to: ClassMoveTo, scope: unknown, noteIn?: unknown): Promise<MoveOrRequest> {
  const who = { id: staff.id, name: staff.name };
  if (staff.role !== "desk") return direct(who, classId, to, scope);
  const preview = await previewClassMove(classId, to, scope);
  if (!preview.ok) return preview;
  // Blocked, or nothing to approve: the one path decides (and refuses what is in the way, naming it).
  const venueId = (await getDb().prepare("SELECT c.venue_id FROM classes cl JOIN courts c ON c.id = cl.court_id WHERE cl.id = ?").get(classId)) as { venue_id: number } | undefined;
  if (!venueId) return refuse("CLASS_NOT_FOUND");
  const rules = await classMoveRules(venueId.venue_id);
  const reasons = preview.blocked ? [] : await approvalReasons(venueId.venue_id, preview, rules);
  if (reasons.length === 0) return direct(who, classId, to, scope);

  const note = typeof noteIn === "string" && noteIn.trim() !== "" ? noteIn.trim().slice(0, NOTE_MAX) : null;
  const { zone } = await venueHours(venueId.venue_id);
  const earliest = Math.min(...preview.sessions.map((s) => instantOf(s.from.date, s.from.startMin, zone).getTime()));
  const expires = new Date(Math.min(Date.now() + rules.requestDays * 86_400_000, earliest));
  const snapshot = {
    sessions: preview.sessions.map((s) => ({ classId: s.classId, name: s.name, from: s.from, to: s.to, enrolled: s.enrolled, waiting: s.waiting })),
    skipped: preview.skipped.length,
    told: preview.notices.length,
  };
  let row: RequestRow;
  try {
    row = (await getDb()
      .prepare(
        `INSERT INTO class_move_requests (venue_id, class_id, scope, to_date, to_start_min, to_court_id, requested_by_admin_id, requested_by_name, note, reasons, snapshot, fingerprint, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(
        venueId.venue_id, classId, preview.scope, to.date, to.start, to.courtId ?? null, staff.id, staff.name, note, JSON.stringify(reasons), JSON.stringify(snapshot),
        fingerprintOfPreview(preview), expires.toISOString()
      )) as RequestRow;
  } catch (err) {
    if (isUniqueViolation(err)) return refuse("CLS3_REQ_OPEN");
    throw err;
  }
  const request = viewOf(row, staff.id);
  await tellManagers(request, (t) => ({
    subject: t("cls3.mail.asked.s", { class: request.className }),
    body: t("cls3.mail.asked.b", {
      by: request.requestedBy,
      class: request.className,
      was: at(request.from, t),
      now: at(request.to, t),
      why: reasonWords(request.reasons, t),
      note: request.note ? ` "${request.note}"` : "",
      url: `${baseUrl()}/admin`,
    }),
  }));
  return { kind: "requested", request };
}

/** `moveClasses`'s answer as the union above reads it. */
async function direct(who: { id: number | null; name: string }, classId: number, to: ClassMoveTo, scope: unknown): Promise<MoveOrRequest> {
  const done = await moveClasses(who, classId, to, scope);
  return done.ok ? { kind: "moved", result: done } : done;
}

// ---------------------------------------------------------------- a manager's decision

export type DecideResult =
  | { ok: true; request: MoveRequestView; result?: Extract<ClassMoveResult, { ok: true }> }
  | (Refusal & { status: number; conflicts?: Extract<ClassMoveResult, { ok: false }>["conflicts"] });

const gone = (code: ErrorCode, status: number): DecideResult => ({ ...refuse(code), status });

/**
 * A manager approves or declines. Approving makes the move: everything is read again (the preview as it is now against what the desk saw, and again under the
 * classes' row locks), the sessions move through `moveClasses` and the request is marked approved in the same transaction, so two managers approving at once
 * make one move and the other is told it is decided. A request whose class, enrolments or waiting list changed since is refused as changed and closed;
 * a move that something now stands in the way of is refused with what, and stays for the manager to try again or decline. Declining needs a reason and changes
 * nothing. A request at another venue is not found.
 */
export async function decideMoveRequest(
  admin: Admin,
  id: number,
  decision: { approve: true; note?: unknown } | { decline: true; reason?: unknown }
): Promise<DecideResult> {
  if (admin.role === "desk") return gone("CLS3_REQ_GONE", 403);
  const first = await requestRow(id);
  if (!first || !canAccessVenue(admin, first.venue_id)) return gone("CLS3_REQ_GONE", 404);
  await closeStaleRequests([first.venue_id]);
  let row = (await requestRow(id))!;
  if (row.status !== "open") return gone("CLS3_REQ_DECIDED", 409);
  const by = { id: admin.id, name: admin.name };

  if ("decline" in decision) {
    const reason = typeof decision.reason === "string" ? decision.reason.trim().slice(0, NOTE_MAX) : "";
    if (reason === "") return gone("CLS3_REASON", 400);
    const done = (await getDb()
      .prepare("UPDATE class_move_requests SET status = 'declined', decided_by_admin_id = ?, decided_by_name = ?, decided_at = now(), decision_note = ? WHERE id = ? AND status = 'open' RETURNING *")
      .get(admin.id, admin.name, reason, id)) as RequestRow | undefined;
    if (!done) return gone("CLS3_REQ_DECIDED", 409);
    const view = viewOf(done, admin.id);
    await logAction(by, { venueId: row.venue_id, action: "class.move_declined", detail: `${describe(view)}; asked by ${view.requestedBy}; declined: ${reason}` });
    await tellRequester(done, (t) => ({
      subject: t("cls3.mail.declined.s", { class: view.className }),
      body: t("cls3.mail.declined.b", { by: admin.name, class: view.className, was: at(view.from, t), now: at(view.to, t), reason }),
    }));
    return { ok: true, request: view };
  }

  const note = typeof decision.note === "string" && decision.note.trim() !== "" ? decision.note.trim().slice(0, NOTE_MAX) : null;
  const to: ClassMoveTo = { date: row.to_date, start: row.to_start_min, ...(row.to_court_id !== null ? { courtId: row.to_court_id } : {}) };
  // What the manager is approving is what the desk asked: read again now, before the locks (a friendly refusal), and again under them (the one that counts).
  const seen = await previewClassMove(row.class_id, to, row.scope);
  if (!seen.ok) {
    // Another manager's approval, a moment ago, is why the class is already there.
    if (await decidedMeanwhile(id)) return gone("CLS3_REQ_DECIDED", 409);
    await closeOne(row, "changed");
    return { ...seen, status: 409 };
  }
  if (fingerprintOfPreview(seen) !== row.fingerprint) {
    if (await decidedMeanwhile(id)) return gone("CLS3_REQ_DECIDED", 409);
    await closeOne(row, "changed");
    return gone("CLS3_REQ_CHANGED", 409);
  }
  const result = await moveClasses(by, row.class_id, to, row.scope, {
    locked: async (planned) => {
      const live = (await getDb().prepare("SELECT status FROM class_move_requests WHERE id = ? FOR UPDATE").get(id)) as { status: RequestStatus } | undefined;
      if (live?.status !== "open") return refuse("CLS3_REQ_DECIDED");
      return (await fingerprintOfPlan(planned)) === row.fingerprint ? null : refuse("CLS3_REQ_CHANGED");
    },
    applied: async (moveId) => {
      await getDb()
        .prepare("UPDATE class_move_requests SET status = 'approved', decided_by_admin_id = ?, decided_by_name = ?, decided_at = now(), decision_note = ?, move_id = ? WHERE id = ?")
        .run(admin.id, admin.name, note, moveId, id);
    },
  });
  if (!result.ok) {
    if (result.code !== "CLS3_REQ_DECIDED" && (await decidedMeanwhile(id))) return gone("CLS3_REQ_DECIDED", 409);
    if (result.code === "CLS3_REQ_CHANGED") {
      await closeOne(row, "changed");
      return gone("CLS3_REQ_CHANGED", 409);
    }
    if (result.code === "CLS3_REQ_DECIDED") return gone("CLS3_REQ_DECIDED", 409);
    return { ...result, status: 409 };
  }
  row = (await requestRow(id))!;
  const view = viewOf(row, admin.id);
  await logAction(by, { venueId: row.venue_id, action: "class.move_approved", detail: `${describe(view)}; asked by ${view.requestedBy}; approved${note ? `: ${note}` : ""}` });
  await tellRequester(row, (t) => ({
    subject: t("cls3.mail.approved.s", { class: view.className }),
    body: t("cls3.mail.approved.b", { by: admin.name, class: view.className, was: at(view.from, t), now: at(view.to, t), n: result.told }),
  }));
  return { ok: true, request: view, result };
}

/** Whether the request is no longer open: decided by another manager, or closed, since it was read. */
async function decidedMeanwhile(id: number): Promise<boolean> {
  return (await requestRow(id))?.status !== "open";
}

async function closeOne(row: RequestRow, why: string): Promise<void> {
  const done = await getDb().prepare("UPDATE class_move_requests SET status = 'closed', closed_reason = ?, decided_at = now() WHERE id = ? AND status = 'open' RETURNING id").get(why, row.id);
  if (!done) return;
  const view = viewOf(row, null);
  await logAction(SYSTEM, { venueId: row.venue_id, action: "class.move_request_closed", detail: `${view.className} ${view.from.date} → ${view.to.date}, asked by ${view.requestedBy}: closed, ${why}` });
}

/** The activity log's words for an applied move that came through approval (the route adds them to `class.moved`). */
export function approvedMoveDetail(view: MoveRequestView, approver: string): string {
  return `requested by ${view.requestedBy}, approved by ${approver}; needed approval: ${view.reasons.map((r) => r.code).join(", ")}`;
}

// ---------------------------------------------------------------- telling staff

const at = (w: SnapshotSession["from"], t: StaffT) => `${w.date} ${formatMinute(w.startMin, t.locale)}–${formatMinute(w.endMin, t.locale)}, ${w.courtName}`;

/** The reasons in the reader's staff language, joined as that language joins them. */
export function reasonWords(reasons: ApprovalReason[], t: StaffT): string {
  return reasons.map((r) => t(`cls3.why.${r.code}`, { n: r.n ?? 0, limit: r.limit ?? 0 })).join(t.locale === "zh" ? "；" : "; ");
}

async function tellManagers(request: MoveRequestView, write: (t: StaffT) => { subject: string; body: string }): Promise<void> {
  await tellVenueStaffEach(request.venueId, write, { managersOnly: true });
}

/** The member of staff who asked hears the outcome, by email in their own staff language, where they have an account still. */
async function tellRequester(row: RequestRow, write: (t: StaffT) => { subject: string; body: string }): Promise<void> {
  if (row.requested_by_admin_id === null) return;
  const who = (await getDb().prepare("SELECT email, name, locale FROM admins WHERE id = ?").get(row.requested_by_admin_id)) as { email: string; name: string; locale: string | null } | undefined;
  if (!who) return;
  const t = staffTranslator(staffReaderLocale(who.locale));
  const { subject, body } = write(t);
  await emailPlain({
    to: who.email,
    subject,
    text: t("r9d.venueMail", { name: who.name, body, site: siteName() }),
    kind: "staff_alert",
    venueId: row.venue_id,
    expiresMinutes: 7 * 24 * 60,
    locale: t.locale,
  });
}
