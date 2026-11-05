import crypto from "crypto";
import { getDb, withTransaction } from "./db";
import { refuse } from "./entitlements";
import { toCsv } from "./export";
import { formatMinute, minuteOfDay } from "./interval";
import { bookingPlaces } from "./participants";
import { addDays, localDateOf, todayISO } from "./time";
import type { Refusal } from "./types";

/**
 * The attendance register (owner's decision, 5 November 2026; docs/features/programmes.md#attendance-registers; ADR 0042).
 *
 * A **session** is one class session (`classes.id`) or one coached lesson (`bookings.id` with a coach). Both identifiers survive a move
 * (the class's own time is changed in place; a lesson keeps its booking), so a register stays with its session when it is moved.
 *
 * - **Expected** are the people on the session: each confirmed enrolment or lesson booking's places (the customer's own, and each person
 *   booked for, a child by their participant record: full name to staff and to the session's own instructor, nobody else), plus
 *   **walk-ins** the instructor or the desk adds by name.
 * - **A mark** is `present`, `absent`, `late` or `excused` with a short note, who marked it and when. It is the instructor's record, declared,
 *   never verified (AGENTS.md). **No money moves because of a mark**: nothing here charges, refunds, uses or restores a pass or an
 *   entitlement, or runs the late-cancel or no-show policy; nothing else reads a mark (not ratings, results, levels or eligibility).
 * - **Who and when.** The instructor through their private link (only sessions of theirs), and the desk or a manager from the dashboard,
 *   on the day of the session and after; before that day only a manager. A register stays editable until a manager locks it or the venue's
 *   number of days after (`venues.attendance_lock_days`); after that, or once locked, only a manager corrects it, with a reason, and every
 *   such correction is kept (`attendance_changes`) and logged.
 * - **Who sees what.** Never public. A customer sees their own marks, and a guardian their child's, on their account page and in the data
 *   export; erasing an account or a participant anonymises their marks, kept as counts; marks go with the venue's retention schedule.
 */

export const MARKS = ["present", "absent", "late", "excused"] as const;
export type Mark = (typeof MARKS)[number];
export const isMark = (v: unknown): v is Mark => typeof v === "string" && (MARKS as readonly string[]).includes(v);

export type SessionKind = "class" | "lesson";
export interface SessionRef {
  kind: SessionKind;
  id: number;
}
export const isKind = (v: unknown): v is SessionKind => v === "class" || v === "lesson";

export const NOTE_MAX = 200;
export const REASON_MIN = 3;
export const REASON_MAX = 300;
export const WALK_IN_MAX = 50;

/** Who is asking: a member of staff (a manager, or the desk), or a coach at their own link. */
export type Viewer = { kind: "staff"; id: number; name: string; manager: boolean } | { kind: "coach"; coachId: number; name: string };

export const staffViewer = (admin: { id: number; name: string; role: string }): Viewer => ({ kind: "staff", id: admin.id, name: admin.name, manager: admin.role !== "desk" });

export interface SessionInfo {
  kind: SessionKind;
  id: number;
  venueId: number;
  title: string;
  where: string;
  date: string;
  startMin: number;
  endMin: number;
  seriesCode: string | null;
  cancelled: boolean;
  /** The coach whose session it is, who may mark it through their link; null for a class whose instructor is only a name. */
  coachId: number | null;
  zone: string;
}

let classesHaveCoach: boolean | null = null;
/**
 * The seam for "a class's instructor as one of the venue's coaches" (the class workstream): a class's coach, when `classes.coach_id`
 * exists and is set, may mark that class's register at their own link. A class whose instructor is a name only has no coach here: the
 * desk and managers mark it.
 */
async function classCoachId(classId: number): Promise<number | null> {
  if (classesHaveCoach === null) {
    const found = await getDb()
      .prepare("SELECT 1 AS x FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'classes' AND column_name = 'coach_id'")
      .get();
    classesHaveCoach = !!found;
  }
  if (!classesHaveCoach) return null;
  const row = (await getDb().prepare("SELECT coach_id FROM classes WHERE id = ?").get(classId)) as { coach_id: number | null } | undefined;
  return row?.coach_id ?? null;
}

/** A session by its reference, with where and when; null where there is none (a lesson is a booking with a coach, not a class place). */
export async function sessionInfo(ref: SessionRef): Promise<SessionInfo | null> {
  const db = getDb();
  if (ref.kind === "class") {
    const row = (await db
      .prepare(
        `SELECT cl.id, cl.name, cl.date, cl.start_min, cl.end_min, cl.series_code, cl.status, c.name AS court, c.venue_id
           FROM classes cl JOIN courts c ON c.id = cl.court_id WHERE cl.id = ?`
      )
      .get(ref.id)) as
      | { id: number; name: string; date: string; start_min: number; end_min: number; series_code: string | null; status: string; court: string; venue_id: number }
      | undefined;
    if (!row) return null;
    const { venueHours } = await import("./store");
    return {
      kind: "class",
      id: row.id,
      venueId: row.venue_id,
      title: row.name,
      where: row.court,
      date: row.date,
      startMin: row.start_min,
      endMin: row.end_min,
      seriesCode: row.series_code,
      cancelled: row.status === "cancelled",
      coachId: await classCoachId(row.id),
      zone: (await venueHours(row.venue_id)).zone,
    };
  }
  const row = (await db
    .prepare(
      `SELECT b.id, b.date, b.start_min, b.end_min, b.status, b.coach_id, c.name AS court, c.venue_id, k.name AS coach
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN coaches k ON k.id = b.coach_id
        WHERE b.id = ? AND b.coach_id IS NOT NULL AND b.class_id IS NULL`
    )
    .get(ref.id)) as { id: number; date: string; start_min: number; end_min: number; status: string; coach_id: number; court: string; venue_id: number; coach: string } | undefined;
  if (!row) return null;
  const { venueHours } = await import("./store");
  return {
    kind: "lesson",
    id: row.id,
    venueId: row.venue_id,
    title: row.coach,
    where: row.court,
    date: row.date,
    startMin: row.start_min,
    endMin: row.end_min,
    seriesCode: null,
    cancelled: row.status === "cancelled",
    coachId: row.coach_id,
    zone: (await venueHours(row.venue_id)).zone,
  };
}

/** Has anybody been marked present or late at this session? A lesson so marked is not moved; a class's mover asks the same. */
export async function attendanceTaken(ref: SessionRef): Promise<boolean> {
  return !!(await getDb()
    .prepare("SELECT 1 FROM attendance_marks WHERE kind = ? AND session_id = ? AND mark IN ('present', 'late') LIMIT 1")
    .get(ref.kind, ref.id));
}

// ------------------------------------------------------------------ the register

export interface RegisterLine {
  key: string;
  name: string;
  walkIn: boolean;
  /** Somebody booked for (a child, or another person the customer manages). */
  booked_for: boolean;
  /** Staff only. */
  bookingCode: string | null;
  phone: string | null;
  /** On the session's list as enrolled or booked; false for a walk-in; `cancelled` for a place since cancelled. */
  cancelled: boolean;
  mark: Mark | null;
  note: string | null;
  markedBy: string | null;
  markedAt: string | null;
  changes: number;
}

export interface RegisterChange {
  key: string;
  was: Mark | null;
  now: Mark;
  reason: string | null;
  late: boolean;
  by: string;
  at: string;
}

export type Phase = "early" | "open" | "closed";

export interface Register {
  session: { kind: SessionKind; id: number; title: string; where: string; date: string; startMin: number; endMin: number; seriesCode: string | null; cancelled: boolean };
  lines: RegisterLine[];
  phase: Phase;
  /** This viewer may mark now, without a reason. */
  canMark: boolean;
  /** A manager, correcting after the register closed: a reason is needed. */
  canCorrect: boolean;
  canLock: boolean;
  locked: { at: string; by: string } | null;
  /** The last day the instructor and the desk may still change it, if not locked first. */
  closesOn: string;
  /** Managers: every change after a first mark, newest first. */
  history?: RegisterChange[];
}

interface Person {
  key: string;
  name: string;
  bookingId: number;
  bookingCode: string;
  phone: string;
  participantId: number | null;
  userId: number | null;
  bookedFor: boolean;
  cancelled: boolean;
}

/** The people a session expects: each place of each enrolment or lesson booking, a place since cancelled only when it was marked. */
async function expectedPeople(ref: SessionRef): Promise<Person[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT id, code, name, phone, user_id, status FROM bookings
        WHERE ${ref.kind === "class" ? "class_id = ?" : "id = ?"} ORDER BY id`
    )
    .all(ref.id)) as { id: number; code: string; name: string; phone: string; user_id: number | null; status: string }[];
  const out: Person[] = [];
  for (const b of rows) {
    for (const place of await bookingPlaces(b.id)) {
      if (place.customer)
        out.push({ key: `c:${b.id}`, name: b.name, bookingId: b.id, bookingCode: b.code, phone: b.phone, participantId: null, userId: b.user_id, bookedFor: false, cancelled: b.status === "cancelled" });
      else if (place.participantId !== null)
        out.push({ key: `p:${b.id}:${place.participantId}`, name: place.name ?? "", bookingId: b.id, bookingCode: b.code, phone: b.phone, participantId: place.participantId, userId: null, bookedFor: true, cancelled: b.status === "cancelled" });
    }
  }
  return out;
}

interface MarkRow {
  id: number;
  person_key: string;
  booking_id: number | null;
  participant_id: number | null;
  user_id: number | null;
  walk_in_name: string | null;
  mark: Mark;
  note: string | null;
  marked_by_name: string;
  marked_at: Date | string;
  anonymised_at: unknown;
  changes: number;
}

const iso = (v: unknown) => new Date(v as string).toISOString();

async function marksOf(ref: SessionRef): Promise<MarkRow[]> {
  return (await getDb()
    .prepare(
      `SELECT m.id, m.person_key, m.booking_id, m.participant_id, m.user_id, m.walk_in_name, m.mark, m.note, m.marked_by_name, m.marked_at, m.anonymised_at,
              (SELECT COUNT(*)::int FROM attendance_changes c WHERE c.mark_id = m.id) AS changes
         FROM attendance_marks m WHERE m.kind = ? AND m.session_id = ? ORDER BY m.id`
    )
    .all(ref.kind, ref.id)) as MarkRow[];
}

async function lockOf(ref: SessionRef): Promise<{ at: string; by: string } | null> {
  const row = (await getDb()
    .prepare("SELECT locked_at, locked_by_name FROM attendance_sessions WHERE kind = ? AND session_id = ? AND locked_at IS NOT NULL")
    .get(ref.kind, ref.id)) as { locked_at: Date | string; locked_by_name: string | null } | undefined;
  return row ? { at: iso(row.locked_at), by: row.locked_by_name ?? "" } : null;
}

async function lockDays(venueId: number): Promise<number> {
  const row = (await getDb().prepare("SELECT attendance_lock_days AS n FROM venues WHERE id = ?").get(venueId)) as { n: number } | undefined;
  return row?.n ?? 14;
}

/** Where a register stands today: before its day (`early`), open, or closed (locked, or past the venue's days). */
export function phaseOf(info: Pick<SessionInfo, "date" | "zone">, days: number, locked: boolean, now = new Date()): { phase: Phase; closesOn: string } {
  const today = localDateOf(now.toISOString(), info.zone);
  const closesOn = addDays(info.date, days);
  if (locked || today > closesOn) return { phase: "closed", closesOn };
  return { phase: today < info.date ? "early" : "open", closesOn };
}

/** Whether this viewer may open this session's register at all: staff of its venue (the route checked), or the coach whose session it is. */
export function mayOpen(viewer: Viewer, info: SessionInfo): boolean {
  return viewer.kind === "staff" || (info.coachId !== null && info.coachId === viewer.coachId);
}

/** The register of a session as this viewer sees it. A coach not on the session is told it is not found. */
export async function registerFor(viewer: Viewer, ref: SessionRef, now = new Date()): Promise<Register | Refusal> {
  const info = await sessionInfo(ref);
  if (!info || !mayOpen(viewer, info)) return refuse("ATTENDANCE_NOT_FOUND");
  const staff = viewer.kind === "staff";
  const manager = staff && viewer.manager;
  const locked = await lockOf(ref);
  const { phase, closesOn } = phaseOf(info, await lockDays(info.venueId), locked !== null, now);
  const people = await expectedPeople(ref);
  const marks = await marksOf(ref);
  const byKey = new Map(marks.map((m) => [m.person_key, m]));
  const lines: RegisterLine[] = [];
  const shown = new Set<string>();
  for (const p of people) {
    const m = byKey.get(p.key);
    // A place since cancelled stays only where somebody was already marked at it.
    if (p.cancelled && !m) continue;
    shown.add(p.key);
    lines.push(lineOf(p.key, p.name, false, p.bookedFor, p, m, staff));
  }
  for (const m of marks) {
    if (shown.has(m.person_key)) continue;
    const walkIn = m.person_key.startsWith("w:");
    lines.push(lineOf(m.person_key, m.anonymised_at ? "" : (m.walk_in_name ?? ""), walkIn, false, null, m, staff));
  }
  const register: Register = {
    session: { kind: info.kind, id: info.id, title: info.title, where: info.where, date: info.date, startMin: info.startMin, endMin: info.endMin, seriesCode: info.seriesCode, cancelled: info.cancelled },
    lines,
    phase,
    canMark: !info.cancelled && (phase === "open" || (phase === "early" && manager)),
    canCorrect: manager && !info.cancelled && phase === "closed",
    canLock: manager,
    locked,
    closesOn,
  };
  if (manager) {
    const rows = (await getDb()
      .prepare(
        `SELECT m.person_key, c.was_mark, c.now_mark, c.reason, c.late, c.by_name, c.changed_at
           FROM attendance_changes c JOIN attendance_marks m ON m.id = c.mark_id
          WHERE m.kind = ? AND m.session_id = ? ORDER BY c.id DESC`
      )
      .all(ref.kind, ref.id)) as { person_key: string; was_mark: Mark | null; now_mark: Mark; reason: string | null; late: boolean; by_name: string; changed_at: Date | string }[];
    register.history = rows.map((r) => ({ key: r.person_key, was: r.was_mark, now: r.now_mark, reason: r.reason, late: r.late, by: r.by_name, at: iso(r.changed_at) }));
  }
  return register;
}

function lineOf(key: string, name: string, walkIn: boolean, bookedFor: boolean, person: Person | null, m: MarkRow | undefined, staff: boolean): RegisterLine {
  return {
    key,
    name,
    walkIn,
    booked_for: bookedFor,
    bookingCode: staff && person ? person.bookingCode : null,
    phone: staff && person ? person.phone : null,
    cancelled: person?.cancelled ?? false,
    mark: m?.mark ?? null,
    note: m && !m.anonymised_at ? m.note : null,
    markedBy: m ? m.marked_by_name : null,
    markedAt: m ? iso(m.marked_at) : null,
    changes: m?.changes ?? 0,
  };
}

// ------------------------------------------------------------------ marking

export interface Marked {
  ok: true;
  line: RegisterLine;
  /** A correction after the register closed (a manager, with a reason). */
  late: boolean;
  /** What it was, for the log; null for a first mark. */
  was: Mark | null;
  info: SessionInfo;
}

/**
 * What a write needs at this moment: the day's rule and the reason after the register closed. A refusal where this viewer may not.
 * Early (before the day) is a manager's; closed is a manager's with a reason; open is anyone's who may open the register.
 */
function mayWrite(viewer: Viewer, info: SessionInfo, state: Phase, reason: string | null): { late: boolean } | Refusal {
  if (info.cancelled) return refuse("ATTENDANCE_CANCELLED");
  const manager = viewer.kind === "staff" && viewer.manager;
  if (state === "open") return { late: false };
  if (state === "early") return manager ? { late: false } : refuse("ATTENDANCE_EARLY");
  if (!manager) return refuse("ATTENDANCE_CLOSED");
  if (!reason || reason.length < REASON_MIN) return refuse("ATTENDANCE_REASON");
  return { late: true };
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim().slice(0, max);
  return t === "" ? null : t;
};

/** The session row held for the length of a write, made if need be: marks, locks and unlocks of one session take turns. */
async function holdSession(info: SessionInfo): Promise<{ locked: boolean }> {
  const db = getDb();
  await db
    .prepare("INSERT INTO attendance_sessions (kind, session_id, venue_id, session_date) VALUES (?, ?, ?, ?) ON CONFLICT (kind, session_id) DO NOTHING")
    .run(info.kind, info.id, info.venueId, info.date);
  const row = (await db.prepare("SELECT locked_at FROM attendance_sessions WHERE kind = ? AND session_id = ? FOR UPDATE").get(info.kind, info.id)) as { locked_at: unknown };
  return { locked: row.locked_at !== null };
}

function byOf(viewer: Viewer): { kind: "staff" | "coach"; adminId: number | null; coachId: number | null; name: string } {
  return viewer.kind === "staff" ? { kind: "staff", adminId: viewer.id, coachId: null, name: viewer.name } : { kind: "coach", adminId: null, coachId: viewer.coachId, name: viewer.name };
}

/**
 * Mark one person on a session (a first mark, or a change). A change within the open days is the instructor's or the desk's own to make;
 * every change is kept with what it was. After the register closed only a manager may, with a reason (`ATTENDANCE_REASON` without).
 * Nothing but the mark changes: no money, pass, entitlement or policy (tests/attendance-no-money.test.ts).
 */
export async function markAttendance(
  viewer: Viewer,
  ref: SessionRef,
  input: { key: unknown; mark: unknown; note?: unknown; reason?: unknown },
  now = new Date()
): Promise<Marked | Refusal> {
  if (!isMark(input.mark)) return refuse("ATTENDANCE_MARK");
  if (typeof input.key !== "string" || input.key.length > 60) return refuse("ATTENDANCE_PERSON");
  const info = await sessionInfo(ref);
  if (!info || !mayOpen(viewer, info)) return refuse("ATTENDANCE_NOT_FOUND");
  const note = clean(input.note, NOTE_MAX);
  const reason = clean(input.reason, REASON_MAX);
  const key = input.key;
  const mark = input.mark;
  const days = await lockDays(info.venueId);
  const by = byOf(viewer);
  let outcome = { late: false, was: null } as { late: boolean; was: Mark | null } | Refusal;
  await withTransaction(async () => {
    const db = getDb();
    const { locked } = await holdSession(info);
    const { phase } = phaseOf(info, days, locked, now);
    const may = mayWrite(viewer, info, phase, reason);
    if ("ok" in may) {
      outcome = may;
      return;
    }
    const existing = (await db
      .prepare("SELECT id, mark, note, anonymised_at FROM attendance_marks WHERE kind = ? AND session_id = ? AND person_key = ? FOR UPDATE")
      .get(ref.kind, ref.id, key)) as { id: number; mark: Mark; note: string | null; anonymised_at: unknown } | undefined;
    if (existing) {
      if (existing.anonymised_at) {
        outcome = refuse("ATTENDANCE_PERSON");
        return;
      }
      if (existing.mark === mark && (existing.note ?? null) === note) {
        outcome = { late: false, was: existing.mark };
        return;
      }
      await db
        .prepare(
          `UPDATE attendance_marks SET mark = ?, note = ?, marked_by_kind = ?, marked_by_admin_id = ?, marked_by_coach_id = ?, marked_by_name = ?, marked_at = ?::timestamptz, updated_at = ?::timestamptz
            WHERE id = ?`
        )
        .run(mark, note, by.kind, by.adminId, by.coachId, by.name, now.toISOString(), now.toISOString(), existing.id);
      await db
        .prepare("INSERT INTO attendance_changes (mark_id, was_mark, now_mark, was_note, now_note, reason, late, by_name, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz)")
        .run(existing.id, existing.mark, mark, existing.note, note, may.late ? reason : null, may.late, by.name, now.toISOString());
      outcome = { late: may.late, was: existing.mark };
      return;
    }
    // A first mark: for somebody on the session's list (a place of its enrolments or lesson), never for anybody else.
    const person = (await expectedPeople(ref)).find((p) => p.key === key);
    if (!person) {
      outcome = refuse("ATTENDANCE_PERSON");
      return;
    }
    const made = (await db
      .prepare(
        `INSERT INTO attendance_marks (kind, session_id, venue_id, session_date, person_key, booking_id, participant_id, user_id, mark, note,
                                       marked_by_kind, marked_by_admin_id, marked_by_coach_id, marked_by_name, marked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz) RETURNING id`
      )
      .get(ref.kind, ref.id, info.venueId, info.date, key, person.bookingId, person.participantId, person.userId, mark, note, by.kind, by.adminId, by.coachId, by.name, now.toISOString(), now.toISOString())) as {
      id: number;
    };
    // A first mark after the register closed is a correction too: kept with its reason.
    if (may.late)
      await db
        .prepare("INSERT INTO attendance_changes (mark_id, was_mark, now_mark, was_note, now_note, reason, late, by_name, changed_at) VALUES (?, NULL, ?, NULL, ?, ?, true, ?, ?::timestamptz)")
        .run(made.id, mark, note, reason, by.name, now.toISOString());
    outcome = { late: may.late, was: null };
  });
  if ("ok" in outcome) return outcome;
  const register = await registerFor(viewer, ref, now);
  if ("ok" in register) return register;
  const line = register.lines.find((l) => l.key === key);
  return { ok: true, line: line!, late: outcome.late, was: outcome.was, info };
}

/** Add somebody who came without being on the list, by name only, marked present unless said otherwise. */
export async function addWalkIn(
  viewer: Viewer,
  ref: SessionRef,
  input: { name: unknown; mark?: unknown; note?: unknown; reason?: unknown },
  now = new Date()
): Promise<Marked | Refusal> {
  const name = clean(input.name, 80);
  if (!name) return refuse("ATTENDANCE_NAME");
  const mark = input.mark === undefined ? "present" : input.mark;
  if (!isMark(mark)) return refuse("ATTENDANCE_MARK");
  const info = await sessionInfo(ref);
  if (!info || !mayOpen(viewer, info)) return refuse("ATTENDANCE_NOT_FOUND");
  const note = clean(input.note, NOTE_MAX);
  const reason = clean(input.reason, REASON_MAX);
  const days = await lockDays(info.venueId);
  const by = byOf(viewer);
  const key = `w:${crypto.randomBytes(5).toString("hex")}`;
  let outcome = { late: false } as { late: boolean } | Refusal;
  await withTransaction(async () => {
    const db = getDb();
    const { locked } = await holdSession(info);
    const { phase } = phaseOf(info, days, locked, now);
    const may = mayWrite(viewer, info, phase, reason);
    if ("ok" in may) {
      outcome = may;
      return;
    }
    const { n } = (await db.prepare("SELECT COUNT(*)::int AS n FROM attendance_marks WHERE kind = ? AND session_id = ? AND person_key LIKE 'w:%'").get(ref.kind, ref.id)) as { n: number };
    if (n >= WALK_IN_MAX) {
      outcome = refuse("ATTENDANCE_WALK_INS");
      return;
    }
    const made = (await db
      .prepare(
        `INSERT INTO attendance_marks (kind, session_id, venue_id, session_date, person_key, walk_in_name, mark, note, marked_by_kind, marked_by_admin_id, marked_by_coach_id, marked_by_name, marked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz) RETURNING id`
      )
      .get(ref.kind, ref.id, info.venueId, info.date, key, name, mark, note, by.kind, by.adminId, by.coachId, by.name, now.toISOString(), now.toISOString())) as { id: number };
    if (may.late)
      await db
        .prepare("INSERT INTO attendance_changes (mark_id, was_mark, now_mark, was_note, now_note, reason, late, by_name, changed_at) VALUES (?, NULL, ?, NULL, ?, ?, true, ?, ?::timestamptz)")
        .run(made.id, mark, note, reason, by.name, now.toISOString());
    outcome = { late: may.late };
  });
  if ("ok" in outcome) return outcome;
  const register = await registerFor(viewer, ref, now);
  if ("ok" in register) return register;
  return { ok: true, line: register.lines.find((l) => l.key === key)!, late: outcome.late, was: null, info };
}

/** Take a walk-in off the register (added by mistake); on the same terms as marking. Somebody on the list is marked, not removed. */
export async function removeWalkIn(viewer: Viewer, ref: SessionRef, input: { key: unknown; reason?: unknown }, now = new Date()): Promise<{ ok: true; late: boolean; info: SessionInfo } | Refusal> {
  if (typeof input.key !== "string" || !input.key.startsWith("w:")) return refuse("ATTENDANCE_PERSON");
  const info = await sessionInfo(ref);
  if (!info || !mayOpen(viewer, info)) return refuse("ATTENDANCE_NOT_FOUND");
  const reason = clean(input.reason, REASON_MAX);
  const days = await lockDays(info.venueId);
  let outcome = { late: false } as { late: boolean } | Refusal;
  await withTransaction(async () => {
    const { locked } = await holdSession(info);
    const { phase } = phaseOf(info, days, locked, now);
    const may = mayWrite(viewer, info, phase, reason);
    if ("ok" in may) {
      outcome = may;
      return;
    }
    const gone = await getDb().prepare("DELETE FROM attendance_marks WHERE kind = ? AND session_id = ? AND person_key = ?").run(ref.kind, ref.id, input.key);
    outcome = gone.changes === 1 ? { late: may.late } : refuse("ATTENDANCE_PERSON");
  });
  return "ok" in outcome ? outcome : { ok: true, late: outcome.late, info };
}

/** A manager closes a register (from then every correction is theirs, with a reason), or opens it again. */
export async function lockRegister(
  viewer: Viewer,
  ref: SessionRef,
  lock: boolean,
  now = new Date()
): Promise<{ ok: true; info: SessionInfo; locked: boolean } | Refusal> {
  if (viewer.kind !== "staff" || !viewer.manager) return refuse("ATTENDANCE_MANAGER");
  const info = await sessionInfo(ref);
  if (!info) return refuse("ATTENDANCE_NOT_FOUND");
  await withTransaction(async () => {
    await holdSession(info);
    await getDb()
      .prepare(
        lock
          ? "UPDATE attendance_sessions SET locked_at = ?::timestamptz, locked_by_admin_id = ?, locked_by_name = ? WHERE kind = ? AND session_id = ?"
          : "UPDATE attendance_sessions SET locked_at = NULL, locked_by_admin_id = NULL, locked_by_name = NULL WHERE kind = ? AND session_id = ?"
      )
      .run(...(lock ? [now.toISOString(), viewer.id, viewer.name, ref.kind, ref.id] : [ref.kind, ref.id]));
  });
  return { ok: true, info, locked: lock };
}

// ------------------------------------------------------------------ what a viewer is shown about whom

/** A short phrase of a session for a log line: "Junior tennis 2026-11-06 17:00". Names the class or the coach, never a person. */
export function sessionLabel(info: SessionInfo, locale = "en"): string {
  return `${info.kind === "lesson" ? "Lesson with " : ""}${info.title} ${info.date} ${formatMinute(info.startMin, locale)}`;
}

// ------------------------------------------------------------------ reports and export

export type ReportScope = { classId: number } | { seriesCode: string } | { from: string; to: string };

export interface ReportSession {
  kind: SessionKind;
  id: number;
  date: string;
  startMin: number;
  title: string;
  expected: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  locked: boolean;
}

export interface ReportPerson {
  name: string;
  walkIn: boolean;
  present: number;
  late: number;
  absent: number;
  excused: number;
  marked: number;
  /** (present + late) of (present + late + absent): excused sessions are left out; null with nothing to count. */
  presentRate: number | null;
  /** Trailing absences in session order: an excused session neither counts nor breaks the run; present or late ends it. */
  missedInARow: number;
  /** Entries left on the person's active session passes at this venue (a suggestion for staff only: nothing is used or restored by a mark). */
  passEntriesLeft: number | null;
}

export interface Report {
  scope: ReportScope;
  label: string;
  sessions: ReportSession[];
  people: ReportPerson[];
  totals: { present: number; late: number; absent: number; excused: number; presentRate: number | null };
}

interface ScopedSession {
  kind: SessionKind;
  id: number;
  date: string;
  startMin: number;
  title: string;
  expected: number;
  locked: boolean;
}

async function sessionsInScope(venueId: number, scope: ReportScope): Promise<{ label: string; sessions: ScopedSession[] } | null> {
  const db = getDb();
  const classRows = async (where: string, ...args: unknown[]) =>
    (await db
      .prepare(
        `SELECT cl.id, cl.name, cl.date, cl.start_min, cl.series_code,
                (SELECT COUNT(*)::int FROM bookings b WHERE b.class_id = cl.id AND b.status = 'confirmed') AS expected,
                EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.kind = 'class' AND s.session_id = cl.id AND s.locked_at IS NOT NULL) AS locked
           FROM classes cl JOIN courts c ON c.id = cl.court_id
          WHERE c.venue_id = ? AND cl.status = 'scheduled' AND ${where} ORDER BY cl.date, cl.start_min, cl.id`
      )
      .all(venueId, ...args)) as { id: number; name: string; date: string; start_min: number; series_code: string | null; expected: number; locked: boolean }[];
  const asScoped = (rows: Awaited<ReturnType<typeof classRows>>): ScopedSession[] =>
    rows.map((r) => ({ kind: "class", id: r.id, date: r.date, startMin: r.start_min, title: r.name, expected: Number(r.expected), locked: r.locked }));
  if ("classId" in scope) {
    const rows = await classRows("cl.id = ?", scope.classId);
    return rows[0] ? { label: rows[0].name, sessions: asScoped(rows) } : null;
  }
  if ("seriesCode" in scope) {
    const rows = await classRows("UPPER(cl.series_code) = UPPER(?)", scope.seriesCode);
    return rows[0] ? { label: rows[0].name, sessions: asScoped(rows) } : null;
  }
  const classes = asScoped(await classRows("cl.date BETWEEN ? AND ?", scope.from, scope.to));
  const lessons = (
    (await db
      .prepare(
        `SELECT b.id, b.date, b.start_min, k.name AS coach,
                EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.kind = 'lesson' AND s.session_id = b.id AND s.locked_at IS NOT NULL) AS locked
           FROM bookings b JOIN courts c ON c.id = b.court_id JOIN coaches k ON k.id = b.coach_id
          WHERE c.venue_id = ? AND b.coach_id IS NOT NULL AND b.class_id IS NULL AND b.status = 'confirmed' AND b.date BETWEEN ? AND ? ORDER BY b.date, b.start_min, b.id`
      )
      .all(venueId, scope.from, scope.to)) as { id: number; date: string; start_min: number; coach: string; locked: boolean }[]
  ).map((r): ScopedSession => ({ kind: "lesson", id: r.id, date: r.date, startMin: r.start_min, title: r.coach, expected: 1, locked: r.locked }));
  return { label: `${scope.from} – ${scope.to}`, sessions: [...classes, ...lessons].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin) };
}

interface ReportMark {
  kind: SessionKind;
  session_id: number;
  session_date: string;
  person_key: string;
  mark: Mark;
  note: string | null;
  marked_by_name: string;
  marked_at: Date | string;
  anonymised_at: unknown;
  walk_in_name: string | null;
  participant_id: number | null;
  user_id: number | null;
  name: string | null;
  phone_key: string | null;
  corrected: boolean;
}

async function marksInScope(venueId: number, sessions: ScopedSession[]): Promise<ReportMark[]> {
  if (sessions.length === 0) return [];
  const classIds = sessions.filter((s) => s.kind === "class").map((s) => s.id);
  const lessonIds = sessions.filter((s) => s.kind === "lesson").map((s) => s.id);
  const marks = (a: unknown[]) => a.map(() => "?").join(",");
  const parts = [
    ...(classIds.length ? [`(m.kind = 'class' AND m.session_id IN (${marks(classIds)}))`] : []),
    ...(lessonIds.length ? [`(m.kind = 'lesson' AND m.session_id IN (${marks(lessonIds)}))`] : []),
  ];
  return (await getDb()
    .prepare(
      `SELECT m.kind, m.session_id, m.session_date, m.person_key, m.mark, m.note, m.marked_by_name, m.marked_at, m.anonymised_at, m.walk_in_name, m.participant_id, m.user_id,
              CASE WHEN m.anonymised_at IS NOT NULL THEN NULL
                   WHEN m.participant_id IS NOT NULL THEN COALESCE(bp.name, pa.display_name)
                   WHEN m.person_key LIKE 'w:%' THEN m.walk_in_name
                   ELSE b.name END AS name,
              b.phone_key,
              EXISTS (SELECT 1 FROM attendance_changes c WHERE c.mark_id = m.id) AS corrected
         FROM attendance_marks m
         LEFT JOIN bookings b ON b.id = m.booking_id
         LEFT JOIN booking_participants bp ON bp.booking_id = m.booking_id AND bp.participant_id = m.participant_id
         LEFT JOIN participants pa ON pa.id = m.participant_id
        WHERE m.venue_id = ? AND (${parts.join(" OR ")}) ORDER BY m.session_date, m.session_id, m.id`
    )
    .all(venueId, ...classIds, ...lessonIds)) as ReportMark[];
}

/** Who is the same person across sessions: their participant record, their account, a walk-in's name as typed, or a guest's name and number as booked. */
function identityOf(m: ReportMark): string | null {
  if (m.anonymised_at) return null;
  if (m.participant_id !== null) return `p:${m.participant_id}`;
  if (m.user_id !== null) return `u:${m.user_id}`;
  if (m.person_key.startsWith("w:")) return m.walk_in_name ? `w:${m.walk_in_name.toLowerCase()}` : null;
  return m.name && m.phone_key ? `g:${m.phone_key}:${m.name.toLowerCase()}` : null;
}

const rate = (present: number, late: number, absent: number): number | null => {
  const seen = present + late + absent;
  return seen === 0 ? null : Math.round(((present + late) / seen) * 1000) / 10;
};

/**
 * The attendance of a class's sessions (or a series, or every session in a period): per session and per person, with the present rate and
 * who has missed several in a row, and for managers what the venue might do about it (never done by a mark). Counts the marks made.
 */
export async function attendanceReport(venueId: number, scope: ReportScope): Promise<Report | null> {
  const found = await sessionsInScope(venueId, scope);
  if (!found) return null;
  const marks = await marksInScope(venueId, found.sessions);
  const sessions: ReportSession[] = found.sessions.map((s) => {
    const mine = marks.filter((m) => m.kind === s.kind && m.session_id === s.id);
    const count = (k: Mark) => mine.filter((m) => m.mark === k).length;
    return { kind: s.kind, id: s.id, date: s.date, startMin: s.startMin, title: s.title, expected: s.expected, present: count("present"), late: count("late"), absent: count("absent"), excused: count("excused"), locked: s.locked };
  });
  const order = new Map(found.sessions.map((s, i) => [`${s.kind}:${s.id}`, i]));
  const byPerson = new Map<string, ReportMark[]>();
  for (const m of marks) {
    const id = identityOf(m);
    if (id === null) continue;
    byPerson.set(id, [...(byPerson.get(id) ?? []), m]);
  }
  const people: ReportPerson[] = [];
  for (const [id, mine] of byPerson) {
    mine.sort((a, b) => (order.get(`${a.kind}:${a.session_id}`) ?? 0) - (order.get(`${b.kind}:${b.session_id}`) ?? 0));
    const count = (k: Mark) => mine.filter((m) => m.mark === k).length;
    let run = 0;
    for (const m of [...mine].reverse()) {
      if (m.mark === "excused") continue;
      if (m.mark === "absent") run++;
      else break;
    }
    people.push({
      name: mine[mine.length - 1].name ?? "",
      walkIn: id.startsWith("w:"),
      present: count("present"),
      late: count("late"),
      absent: count("absent"),
      excused: count("excused"),
      marked: mine.length,
      presentRate: rate(count("present"), count("late"), count("absent")),
      missedInARow: run,
      passEntriesLeft: await passEntriesLeft(venueId, id),
    });
  }
  people.sort((a, b) => b.missedInARow - a.missedInARow || b.absent - a.absent || a.name.localeCompare(b.name));
  const total = (k: Mark) => sessions.reduce((n, s) => n + s[k], 0);
  return {
    scope,
    label: found.label,
    sessions,
    people,
    totals: { present: total("present"), late: total("late"), absent: total("absent"), excused: total("excused"), presentRate: rate(total("present"), total("late"), total("absent")) },
  };
}

/** What is left on the active entry passes a person holds at this venue: only for a participant record or an account, never guessed from a name. */
async function passEntriesLeft(venueId: number, identity: string): Promise<number | null> {
  const [kind, raw] = identity.split(":");
  if (kind !== "p" && kind !== "u") return null;
  const left = "(p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0))";
  const holder = kind === "p" ? "p.holder_kind = 'participant' AND p.holder_participant_id = ?" : "p.holder_kind = 'customer' AND p.user_id = ?";
  const row = (await getDb()
    .prepare(
      `SELECT COALESCE(SUM(${left}), 0)::int AS n, COUNT(*)::int AS passes FROM passes p
        WHERE p.venue_id = ? AND p.status = 'active' AND p.kind = 'session' AND p.expires_on >= ? AND ${holder}`
    )
    .get(venueId, todayISO(), Number(raw))) as { n: number; passes: number };
  return row.passes === 0 ? null : row.n;
}

/**
 * One row per mark, for a spreadsheet: staff only, children named in full (as the register shows staff). Columns: date, start, kind
 * (class or lesson), session, person, role (enrolled, booked for or walk-in), mark, note, marked by, marked at, corrected.
 */
export const CSV_COLUMNS = ["Date", "Start", "Kind", "Session", "Person", "Role", "Mark", "Note", "Marked by", "Marked at", "Corrected"] as const;

export async function attendanceCsv(venueId: number, scope: ReportScope): Promise<string | null> {
  const found = await sessionsInScope(venueId, scope);
  if (!found) return null;
  const marks = await marksInScope(venueId, found.sessions);
  const sessionOf = new Map(found.sessions.map((s) => [`${s.kind}:${s.id}`, s]));
  const rows = marks.map((m) => {
    const s = sessionOf.get(`${m.kind}:${m.session_id}`)!;
    const role = m.person_key.startsWith("w:") ? "walk-in" : m.participant_id !== null || m.person_key.startsWith("p:") ? "booked for" : "enrolled";
    return [
      m.session_date,
      formatMinute(s.startMin),
      m.kind,
      s.title,
      m.anonymised_at ? "" : (m.name ?? ""),
      role,
      m.mark,
      m.anonymised_at ? "" : (m.note ?? ""),
      m.marked_by_name,
      new Date(m.marked_at).toISOString(),
      m.corrected ? "yes" : "no",
    ];
  });
  return toCsv([...CSV_COLUMNS], rows);
}

// ------------------------------------------------------------------ the customer's own

export interface MyAttendanceLine {
  date: string;
  startMin: number;
  kind: SessionKind;
  title: string;
  venue: string;
  mark: Mark;
  /** Whose mark: null for the account's own; a person the account manages, by the name the account knows them by. */
  forName: string | null;
}

const MINE_SQL = `
  SELECT m.session_date, m.kind, m.session_id, m.mark, v.name AS venue,
         CASE WHEN m.kind = 'class' THEN cl.name ELSE k.name END AS title,
         CASE WHEN m.kind = 'class' THEN cl.start_min ELSE lb.start_min END AS start_min,
         pa.display_name AS participant_name
    FROM attendance_marks m
    JOIN venues v ON v.id = m.venue_id
    LEFT JOIN classes cl ON m.kind = 'class' AND cl.id = m.session_id
    LEFT JOIN bookings lb ON m.kind = 'lesson' AND lb.id = m.session_id
    LEFT JOIN coaches k ON k.id = lb.coach_id
    LEFT JOIN participants pa ON pa.id = m.participant_id
   WHERE m.anonymised_at IS NULL AND `;

interface MineRow {
  session_date: string;
  kind: SessionKind;
  mark: Mark;
  venue: string;
  title: string | null;
  start_min: number | null;
  participant_name: string | null;
}

const toMine = (r: MineRow, forName: string | null): MyAttendanceLine => ({
  date: r.session_date,
  startMin: r.start_min ?? 0,
  kind: r.kind,
  title: r.title ?? "",
  venue: r.venue,
  mark: r.mark,
  forName,
});

/**
 * An account's attendance: its own marks, and a guardian's for each person they manage (their participant record's name), newest first.
 * Never anybody else's, never a coach's note: the note is the instructor's own record, shown to staff and the instructor only.
 */
export async function myAttendance(userId: number): Promise<MyAttendanceLine[]> {
  const { guardianshipsOf, linkedParticipantOf } = await import("./participants");
  const db = getDb();
  const own = (await db.prepare(`${MINE_SQL} m.user_id = ? ORDER BY m.session_date DESC, start_min DESC`).all(userId)) as MineRow[];
  const lines = own.map((r) => toMine(r, null));
  const ids = new Map<number, string>();
  for (const g of await guardianshipsOf(userId)) ids.set(g.participant.id, g.participant.displayName);
  const linked = await linkedParticipantOf(userId);
  if (linked) ids.set(linked.id, linked.displayName);
  for (const [id, name] of ids) {
    const rows = (await db.prepare(`${MINE_SQL} m.participant_id = ? ORDER BY m.session_date DESC, start_min DESC`).all(id)) as MineRow[];
    // The linked login's own record is theirs, not "for" anybody.
    lines.push(...rows.map((r) => toMine(r, linked && linked.id === id ? null : name)));
  }
  return lines.sort((a, b) => b.date.localeCompare(a.date) || b.startMin - a.startMin);
}

/** What the personal-data export holds of an account's attendance: its own marks and those of the people it manages, with each note kept. */
export async function attendanceExport(userId: number): Promise<unknown[]> {
  const { guardianshipsOf, linkedParticipantOf } = await import("./participants");
  const db = getDb();
  const ids = new Set<number>((await guardianshipsOf(userId, { archived: true })).map((g) => g.participant.id));
  const linked = await linkedParticipantOf(userId);
  if (linked) ids.add(linked.id);
  return await db
    .prepare(
      `SELECT m.session_date AS date, m.kind, v.name AS venue,
              CASE WHEN m.kind = 'class' THEN cl.name ELSE k.name END AS session, m.mark, m.note, m.marked_by_name AS marked_by, m.marked_at,
              CASE WHEN m.user_id = ? THEN 'own place' ELSE pa.display_name END AS for_whom
         FROM attendance_marks m
         JOIN venues v ON v.id = m.venue_id
         LEFT JOIN classes cl ON m.kind = 'class' AND cl.id = m.session_id
         LEFT JOIN bookings lb ON m.kind = 'lesson' AND lb.id = m.session_id
         LEFT JOIN coaches k ON k.id = lb.coach_id
         LEFT JOIN participants pa ON pa.id = m.participant_id
        WHERE m.anonymised_at IS NULL AND (m.user_id = ? ${ids.size ? `OR m.participant_id IN (${[...ids].map(() => "?").join(",")})` : ""})
        ORDER BY m.session_date DESC, m.id`
    )
    .all(userId, userId, ...ids);
}

/**
 * An account being erased: its own marks are anonymised, kept as counts of who came, naming nobody (no account, no note, no name),
 * inside the erasure's transaction. The people it manages are anonymised as their records go (`forgetAttendanceOfParticipant`).
 */
export async function forgetAttendanceOfUser(userId: number): Promise<void> {
  const db = getDb();
  const marks = (await db.prepare("SELECT id FROM attendance_marks WHERE user_id = ?").all(userId)) as { id: number }[];
  for (const m of marks) await anonymise(m.id);
}

/** A participant's record erased: their marks are anonymised the same way. */
export async function forgetAttendanceOfParticipant(participantId: number): Promise<void> {
  const marks = (await getDb().prepare("SELECT id FROM attendance_marks WHERE participant_id = ?").all(participantId)) as { id: number }[];
  for (const m of marks) await anonymise(m.id);
}

async function anonymise(markId: number): Promise<void> {
  const db = getDb();
  await db.prepare("UPDATE attendance_marks SET user_id = NULL, participant_id = NULL, booking_id = NULL, walk_in_name = NULL, note = NULL, anonymised_at = now() WHERE id = ?").run(markId);
  await db.prepare("UPDATE attendance_changes SET was_note = NULL, now_note = NULL WHERE mark_id = ?").run(markId);
}

/** The minute of the session day now is, for a screen saying whether a session has begun (the venue's clock). */
export function minutesIntoSession(info: Pick<SessionInfo, "date" | "startMin" | "zone">, now = new Date()): number {
  return minuteOfDay(now, info.date, info.zone) - info.startMin;
}
