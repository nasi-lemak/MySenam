import crypto from "crypto";
import { getDb, withTransaction } from "./db";
import { isKnownActivity } from "./activity-registry";
import { lockCoach } from "./claims";
import { errorText, translator, type ErrorCode } from "./i18n";
import { addDays, dayOfWeek, isValidDateString, todayISO, zoneOffsetMinutes } from "./time";
import { instantOf, merge, minuteOfDay, rangeLiteral, type Span } from "./interval";
import type { Refusal } from "./types";
import { venueZoneOf } from "./zones";

/**
 * Who supervises a session (ADR 0036; docs/features/venue-operations.md#who-supervises-a-session).
 *
 * Supervised activities (a range, a pool, open water, a climbing wall) are never left to run unstaffed
 * (lib/activities.ts `supervised`), but that says only that the venue is staffed. This module says by whom and with
 * what qualification: a venue defines the roles it rosters (data, `roster_roles`), rosters its staff accounts and its
 * coaches in a weekly pattern with dated exceptions (`roster_shifts`, `roster_exceptions`), records the
 * qualifications they hold with the last day each holds (`roster_qualifications`), and marks an activity or a
 * resource's activity as needing n people in a role on shift (`supervision_rules`). A booking, a class session or an
 * open game there is bookable only for the intervals where at least n qualified people are on shift: asked in the one
 * booking path, `supervisionRefusal`, by every way a session is made or moved.
 *
 * What a roster says is worked out each time, in instants, from the pattern, the exceptions and the qualifications;
 * nothing is stored that could drift from them. A shift is the venue's wall clock on a calendar day (it may run past
 * midnight), turned into instants with the zone's own offset on that day, as a booking is (lib/interval.ts). Leave
 * takes a person off from the time it names (the whole day, midnight to midnight, when it names none). A person whose
 * qualification expires before a shift ends is on shift only until the end of its last day: never silently valid. A
 * coach teaching a lesson is not available to supervise another session at that time (a coach is one person with one
 * schedule; lib/coaching.ts `coach_claims`).
 *
 * Removing a shift, leave, or anything else that leaves a session without its supervisors never cancels a booking: the
 * session stays valid until a manager decides, and is listed (`uncoveredSessions`) for them to cover (name another
 * person), deliberately let stand with a reason, or move or cancel by the usual paths.
 */

export type PersonKind = "staff" | "coach";

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}
/** A refusal in English with the HTTP status a route answers with (the staff screens translate it by its sentence). */
const said = (error: string, status = 400): Refusal & { status: number } => ({ ok: false, error, status });

// ------------------------------------------------------------ roles

export interface RosterRole {
  id: number;
  venueId: number;
  key: string;
  name: string;
  builtin: boolean;
  /** The qualification a holder must have; null: none needed. */
  qualification: string | null;
  active: boolean;
}

/** The starters every venue has, to use or change: a role is data, a qualification a name the venue gives. */
export const STARTER_ROLES: { key: string; name: string; qualification: string }[] = [
  { key: "range_officer", name: "Range officer", qualification: "Range officer certificate" },
  { key: "lifeguard", name: "Lifeguard", qualification: "Lifeguard certificate" },
  { key: "instructor", name: "Instructor", qualification: "Instructor certificate" },
];

interface RoleRow {
  id: number;
  venue_id: number;
  key: string;
  name: string;
  builtin: boolean;
  qualification: string | null;
  active: boolean;
}
const toRole = (r: RoleRow): RosterRole => ({
  id: r.id,
  venueId: r.venue_id,
  key: r.key,
  name: r.name,
  builtin: r.builtin === true,
  qualification: r.qualification,
  active: r.active === true,
});

/** The starter roles, once for each venue; nothing is changed where they are there. */
export async function ensureRoles(venueId: number): Promise<void> {
  const db = getDb();
  for (const s of STARTER_ROLES)
    await db
      .prepare(
        "INSERT INTO roster_roles (venue_id, key, name, builtin, qualification) VALUES (?, ?, ?, true, ?) ON CONFLICT (venue_id, key) DO NOTHING"
      )
      .run(venueId, s.key, s.name, s.qualification);
}

export async function listRoles(venueId: number, opts: { activeOnly?: boolean } = {}): Promise<RosterRole[]> {
  await ensureRoles(venueId);
  const rows = (await getDb()
    .prepare(`SELECT * FROM roster_roles WHERE venue_id = ?${opts.activeOnly ? " AND active" : ""} ORDER BY builtin DESC, id`)
    .all(venueId)) as RoleRow[];
  return rows.map(toRole);
}

async function roleById(venueId: number, id: unknown): Promise<RosterRole | null> {
  if (!Number.isInteger(id)) return null;
  const r = (await getDb().prepare("SELECT * FROM roster_roles WHERE id = ? AND venue_id = ?").get(id, venueId)) as RoleRow | undefined;
  return r ? toRole(r) : null;
}

const cleanText = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

export type RoleResult = { ok: true; role: RosterRole; affected: UncoveredSession[] } | Refusal;

/** Add a role of the venue's own, or change one (its name, the qualification it needs, or turn it off). Sessions a change leaves uncovered are returned. */
export async function saveRole(
  venueId: number,
  input: { id?: unknown; name?: unknown; qualification?: unknown; active?: unknown }
): Promise<RoleResult> {
  await ensureRoles(venueId);
  const db = getDb();
  const name = cleanText(input.name, 60);
  const qualification = cleanText(input.qualification, 80);
  if (input.id === undefined) {
    if (!name || name.length < 2) return said("Give the role a name.");
    const dup = await db.prepare("SELECT 1 FROM roster_roles WHERE venue_id = ? AND lower(name) = lower(?) AND active").get(venueId, name);
    if (dup) return said("The venue already has a role with that name.");
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM roster_roles WHERE venue_id = ?").get(venueId)) as { n: number };
    const row = (await db
      .prepare("INSERT INTO roster_roles (venue_id, key, name, builtin, qualification) VALUES (?, ?, ?, false, ?) RETURNING *")
      .get(venueId, `role-${Number(n.n) + 1}-${Date.now().toString(36)}`, name, qualification)) as RoleRow;
    return { ok: true, role: toRole(row), affected: [] };
  }
  const found = await roleById(venueId, input.id);
  if (!found) return said("That role is not at this venue.", 404);
  if (name !== null && name.length < 2) return said("Give the role a name.");
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    // A role that rules still ask for is not turned off: the rules would ask for nobody, and the activity would quietly stop being asked.
    if (input.active === false && found.active) {
      const used = (await db.prepare("SELECT COUNT(*) AS n FROM supervision_rules WHERE role_id = ?").get(found.id)) as { n: number };
      if (Number(used.n) > 0) return said("Rules still ask for this role. Remove them first, so no activity is left without the check by accident.", 409);
    }
    const affected = await newlyUncovered(venueId, () =>
      db
        .prepare("UPDATE roster_roles SET name = COALESCE(?, name), qualification = ?, active = ? WHERE id = ?")
        .run(name, input.qualification === undefined ? found.qualification : qualification, input.active === undefined ? found.active : input.active === true, found.id)
    );
    return { ok: true as const, role: (await roleById(venueId, found.id))!, affected };
  });
}

// ------------------------------------------------------------ people and qualifications

export interface RosterPerson {
  kind: PersonKind;
  id: number;
  name: string;
}
const keyOf = (kind: PersonKind, id: number) => `${kind}:${id}`;

/** The people a venue rosters: its own staff accounts, and its coaches who still take lessons. */
export async function rosterPeople(venueId: number): Promise<RosterPerson[]> {
  const db = getDb();
  const staff = (await db.prepare("SELECT id, name FROM admins WHERE venue_id = ? ORDER BY name, id").all(venueId)) as { id: number; name: string }[];
  const coaches = (await db.prepare("SELECT id, name FROM coaches WHERE venue_id = ? AND active = 1 ORDER BY name, id").all(venueId)) as { id: number; name: string }[];
  return [...staff.map((p) => ({ kind: "staff" as const, id: p.id, name: p.name })), ...coaches.map((p) => ({ kind: "coach" as const, id: p.id, name: p.name }))];
}

async function personAt(venueId: number, kind: unknown, id: unknown): Promise<RosterPerson | null> {
  if ((kind !== "staff" && kind !== "coach") || !Number.isInteger(id)) return null;
  return (await rosterPeople(venueId)).find((p) => p.kind === kind && p.id === id) ?? null;
}

export interface Qualification {
  id: number;
  venueId: number;
  personKind: PersonKind;
  personId: number;
  qualification: string;
  reference: string | null;
  expiresOn: string | null;
  recordedByName: string | null;
  createdAt: string;
}

interface QualRow {
  id: number;
  venue_id: number;
  person_kind: PersonKind;
  person_id: number;
  qualification: string;
  reference: string | null;
  expires_on: string | null;
  recorded_by_name: string | null;
  created_at: string;
}
const toQual = (r: QualRow): Qualification => ({
  id: r.id,
  venueId: r.venue_id,
  personKind: r.person_kind,
  personId: r.person_id,
  qualification: r.qualification,
  reference: r.reference,
  expiresOn: r.expires_on,
  recordedByName: r.recorded_by_name,
  createdAt: r.created_at,
});

export async function listQualifications(venueId: number): Promise<Qualification[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM roster_qualifications WHERE venue_id = ? AND revoked_at IS NULL ORDER BY person_kind, person_id, id")
    .all(venueId)) as QualRow[];
  return rows.map(toQual);
}

const norm = (s: string) => s.trim().toLowerCase();

export type QualificationResult = { ok: true; qualification: Qualification } | Refusal;

/** A qualification a person holds, as the venue saw it: the last day it holds, and a reference (never a document). */
export async function recordQualification(
  venueId: number,
  input: { personKind?: unknown; personId?: unknown; qualification?: unknown; reference?: unknown; expiresOn?: unknown },
  by: { id: number | null; name: string }
): Promise<QualificationResult> {
  const person = await personAt(venueId, input.personKind, input.personId);
  if (!person) return said("That person is not on this venue's roster list.", 404);
  const qualification = cleanText(input.qualification, 80);
  if (!qualification) return said("Name the qualification.");
  const reference = cleanText(input.reference, 120);
  let expiresOn: string | null = null;
  if (input.expiresOn !== undefined && input.expiresOn !== null && input.expiresOn !== "") {
    if (typeof input.expiresOn !== "string" || !isValidDateString(input.expiresOn)) return said("The last day it holds is a date.");
    expiresOn = input.expiresOn;
  }
  const row = (await getDb()
    .prepare(
      `INSERT INTO roster_qualifications (venue_id, person_kind, person_id, qualification, reference, expires_on, recorded_by, recorded_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(venueId, person.kind, person.id, qualification, reference, expiresOn, by.id, by.name)) as QualRow;
  return { ok: true, qualification: toQual(row) };
}

export async function revokeQualification(venueId: number, id: unknown): Promise<{ ok: true; qualification: Qualification } | Refusal> {
  if (!Number.isInteger(id)) return said("That qualification is not recorded here.", 404);
  const row = (await getDb()
    .prepare("UPDATE roster_qualifications SET revoked_at = datetime('now') WHERE id = ? AND venue_id = ? AND revoked_at IS NULL RETURNING *")
    .get(id, venueId)) as QualRow | undefined;
  return row ? { ok: true, qualification: toQual(row) } : said("That qualification is not recorded here.", 404);
}

// ------------------------------------------------------------ shifts and exceptions

export interface Shift {
  id: number;
  roleId: number;
  personKind: PersonKind;
  personId: number;
  weekday: number;
  fromMin: number;
  toMin: number;
}

export interface RosterException {
  id: number;
  personKind: PersonKind;
  personId: number;
  date: string;
  kind: "extra" | "leave";
  roleId: number | null;
  fromMin: number | null;
  toMin: number | null;
  note: string | null;
}

interface ShiftRow {
  id: number;
  role_id: number;
  person_kind: PersonKind;
  person_id: number;
  weekday: number;
  from_min: number;
  to_min: number;
}
interface ExceptionRow {
  id: number;
  person_kind: PersonKind;
  person_id: number;
  date: string;
  kind: "extra" | "leave";
  role_id: number | null;
  from_min: number | null;
  to_min: number | null;
  note: string | null;
}
const toShift = (r: ShiftRow): Shift => ({
  id: r.id,
  roleId: r.role_id,
  personKind: r.person_kind,
  personId: r.person_id,
  weekday: r.weekday,
  fromMin: r.from_min,
  toMin: r.to_min,
});
const toException = (r: ExceptionRow): RosterException => ({
  id: r.id,
  personKind: r.person_kind,
  personId: r.person_id,
  date: r.date,
  kind: r.kind,
  roleId: r.role_id,
  fromMin: r.from_min,
  toMin: r.to_min,
  note: r.note,
});

export async function listShifts(venueId: number): Promise<Shift[]> {
  const rows = (await getDb().prepare("SELECT * FROM roster_shifts WHERE venue_id = ? ORDER BY weekday, from_min, id").all(venueId)) as ShiftRow[];
  return rows.map(toShift);
}

/** Exceptions from `from` on (today, where not said): the past is history and changes no session to come. */
export async function listExceptions(venueId: number, from: string = todayISO()): Promise<RosterException[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM roster_exceptions WHERE venue_id = ? AND date >= ? ORDER BY date, from_min, id")
    .all(venueId, from)) as ExceptionRow[];
  return rows.map(toException);
}

const isMinuteOfDay = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1440;
const isShiftEnd = (v: unknown, from: number): v is number => typeof v === "number" && Number.isInteger(v) && v > from && v <= from + 1440;

/** Lock the venue's roster: a booking asks while holding it shared, a change to the roster takes it whole, so neither is ever between the other's check and write. */
async function lockRoster(venueId: number, mode: "shared" | "exclusive"): Promise<void> {
  await getDb()
    .prepare(mode === "shared" ? "SELECT pg_advisory_xact_lock_shared(?, ?)" : "SELECT pg_advisory_xact_lock(?, ?)")
    .get(4, venueId);
}

export type ShiftResult = { ok: true; shift: Shift; affected: UncoveredSession[] } | Refusal;

async function checkedRole(venueId: number, id: unknown): Promise<RosterRole | Refusal> {
  const role = await roleById(venueId, id);
  if (!role) return said("That role is not at this venue.", 404);
  if (!role.active) return said("That role is turned off.");
  return role;
}

export async function addShift(
  venueId: number,
  input: { roleId?: unknown; personKind?: unknown; personId?: unknown; weekday?: unknown; fromMin?: unknown; toMin?: unknown }
): Promise<ShiftResult> {
  const role = await checkedRole(venueId, input.roleId);
  if ("ok" in role) return role;
  const person = await personAt(venueId, input.personKind, input.personId);
  if (!person) return said("That person is not on this venue's roster list.", 404);
  const weekday = input.weekday;
  if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return said("Choose a weekday.");
  if (!isMinuteOfDay(input.fromMin)) return said("The shift starts at a time of the day.");
  if (!isShiftEnd(input.toMin, input.fromMin)) return said("The shift ends after it starts, and within a day of it (it may run past midnight).");
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    const row = (await getDb()
      .prepare("INSERT INTO roster_shifts (venue_id, role_id, person_kind, person_id, weekday, from_min, to_min) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(venueId, role.id, person.kind, person.id, weekday, input.fromMin as number, input.toMin as number)) as ShiftRow;
    return { ok: true as const, shift: toShift(row), affected: [] };
  });
}

/** Take a shift out of the weekly pattern. Never cancels a booking: the sessions it leaves uncovered are returned, and listed for a manager. */
export async function removeShift(venueId: number, id: unknown): Promise<{ ok: true; affected: UncoveredSession[] } | Refusal> {
  if (!Number.isInteger(id)) return said("That shift is not on this roster.", 404);
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    const row = await getDb().prepare("SELECT id FROM roster_shifts WHERE id = ? AND venue_id = ?").get(id, venueId);
    if (!row) return said("That shift is not on this roster.", 404);
    return { ok: true as const, affected: await newlyUncovered(venueId, () => getDb().prepare("DELETE FROM roster_shifts WHERE id = ?").run(id)) };
  });
}

export type ExceptionResult = { ok: true; exception: RosterException; affected: UncoveredSession[] } | Refusal;

/** An extra shift on one date, or leave (from a time, or the whole day) for a person. */
export async function addException(
  venueId: number,
  input: { kind?: unknown; personKind?: unknown; personId?: unknown; date?: unknown; roleId?: unknown; fromMin?: unknown; toMin?: unknown; note?: unknown }
): Promise<ExceptionResult> {
  const person = await personAt(venueId, input.personKind, input.personId);
  if (!person) return said("That person is not on this venue's roster list.", 404);
  if (typeof input.date !== "string" || !isValidDateString(input.date)) return said("Choose a date.");
  if (input.kind !== "extra" && input.kind !== "leave") return said("An extra shift, or leave.");
  const note = cleanText(input.note, 200);
  let roleId: number | null = null;
  let fromMin: number | null = null;
  let toMin: number | null = null;
  if (input.kind === "extra") {
    const role = await checkedRole(venueId, input.roleId);
    if ("ok" in role) return role;
    roleId = role.id;
    if (!isMinuteOfDay(input.fromMin)) return said("The shift starts at a time of the day.");
    if (!isShiftEnd(input.toMin, input.fromMin)) return said("The shift ends after it starts, and within a day of it (it may run past midnight).");
    fromMin = input.fromMin;
    toMin = input.toMin as number;
  } else if (input.fromMin !== undefined && input.fromMin !== null) {
    // Leave from a time to a time on that day; the whole day when it names none.
    if (!isMinuteOfDay(input.fromMin)) return said("Leave starts at a time of the day.");
    if (typeof input.toMin !== "number" || !Number.isInteger(input.toMin) || input.toMin <= input.fromMin || input.toMin > 1440) return said("Leave ends after it starts, by the end of the day.");
    fromMin = input.fromMin;
    toMin = input.toMin;
  }
  const date = input.date;
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    let row: ExceptionRow | undefined;
    const affected = await newlyUncovered(venueId, async () => {
      row = (await getDb()
        .prepare("INSERT INTO roster_exceptions (venue_id, person_kind, person_id, date, kind, role_id, from_min, to_min, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
        .get(venueId, person.kind, person.id, date, input.kind, roleId, fromMin, toMin, note)) as ExceptionRow;
    });
    return { ok: true as const, exception: toException(row!), affected };
  });
}

export async function removeException(venueId: number, id: unknown): Promise<{ ok: true; affected: UncoveredSession[] } | Refusal> {
  if (!Number.isInteger(id)) return said("That is not on this roster.", 404);
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    const row = await getDb().prepare("SELECT id FROM roster_exceptions WHERE id = ? AND venue_id = ?").get(id, venueId);
    if (!row) return said("That is not on this roster.", 404);
    return { ok: true as const, affected: await newlyUncovered(venueId, () => getDb().prepare("DELETE FROM roster_exceptions WHERE id = ?").run(id)) };
  });
}

/** Take a recorded qualification back; sessions it leaves uncovered are returned like a removed shift's. */
export async function revokeQualificationChecked(venueId: number, id: unknown): Promise<{ ok: true; qualification: Qualification; affected: UncoveredSession[] } | Refusal> {
  if (!Number.isInteger(id)) return said("That qualification is not recorded here.", 404);
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    let taken: Qualification | null = null;
    const affected = await newlyUncovered(venueId, async () => {
      const r = await revokeQualification(venueId, id);
      if (r.ok) taken = r.qualification;
    });
    return taken ? { ok: true as const, qualification: taken, affected } : said("That qualification is not recorded here.", 404);
  });
}

// ------------------------------------------------------------ rules

export interface SupervisionRule {
  id: number;
  venueId: number;
  courtId: number | null;
  activity: string | null;
  roleId: number;
  needed: number;
}

interface RuleRow {
  id: number;
  venue_id: number;
  court_id: number | null;
  activity: string | null;
  role_id: number;
  needed: number;
}
const toRule = (r: RuleRow): SupervisionRule => ({ id: r.id, venueId: r.venue_id, courtId: r.court_id, activity: r.activity, roleId: r.role_id, needed: Number(r.needed) });

export async function listRules(venueId: number): Promise<SupervisionRule[]> {
  const rows = (await getDb().prepare("SELECT * FROM supervision_rules WHERE venue_id = ? ORDER BY id").all(venueId)) as RuleRow[];
  return rows.map(toRule);
}

/** Mark an activity, a resource, or a resource's activity as needing `needed` people in a role on shift (the rule for that role replaces any before). */
export async function setRule(
  venueId: number,
  input: { courtId?: unknown; activity?: unknown; roleId?: unknown; needed?: unknown }
): Promise<{ ok: true; rule: SupervisionRule; affected: UncoveredSession[] } | Refusal> {
  const role = await checkedRole(venueId, input.roleId);
  if ("ok" in role) return role;
  const db = getDb();
  let courtId: number | null = null;
  if (input.courtId !== undefined && input.courtId !== null) {
    const c = Number.isInteger(input.courtId)
      ? ((await db.prepare("SELECT id FROM courts WHERE id = ? AND venue_id = ?").get(input.courtId, venueId)) as { id: number } | undefined)
      : undefined;
    if (!c) return said("That resource is not at this venue.", 404);
    courtId = c.id;
  }
  const activity = typeof input.activity === "string" && input.activity !== "" ? input.activity : null;
  if (activity !== null && !isKnownActivity(activity)) return said("That is not an activity.");
  if (courtId === null && activity === null) return said("Choose an activity, a resource, or both.");
  const needed = input.needed === undefined ? 1 : input.needed;
  if (typeof needed !== "number" || !Number.isInteger(needed) || needed < 1 || needed > 20) return said("How many people are needed: 1 to 20.");
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    let row: RuleRow | undefined;
    const affected = await newlyUncovered(venueId, async () => {
      const existing = (await db
        .prepare("SELECT id FROM supervision_rules WHERE venue_id = ? AND COALESCE(court_id, 0) = ? AND COALESCE(activity, '') = ? AND role_id = ?")
        .get(venueId, courtId ?? 0, activity ?? "", role.id)) as { id: number } | undefined;
      row = existing
        ? ((await db.prepare("UPDATE supervision_rules SET needed = ? WHERE id = ? RETURNING *").get(needed, existing.id)) as RuleRow)
        : ((await db
            .prepare("INSERT INTO supervision_rules (venue_id, court_id, activity, role_id, needed) VALUES (?, ?, ?, ?, ?) RETURNING *")
            .get(venueId, courtId, activity, role.id, needed)) as RuleRow);
    });
    return { ok: true as const, rule: toRule(row!), affected };
  });
}

export async function removeRule(venueId: number, id: unknown): Promise<{ ok: true } | Refusal> {
  if (!Number.isInteger(id)) return said("That rule is not at this venue.", 404);
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    const done = await getDb().prepare("DELETE FROM supervision_rules WHERE id = ? AND venue_id = ?").run(id, venueId);
    return done.changes === 1 ? { ok: true as const } : said("That rule is not at this venue.", 404);
  });
}

/** What a session of this activity on this resource needs: one entry per role, the most any rule asks. */
export interface Need {
  roleId: number;
  roleKey: string;
  roleName: string;
  needed: number;
}

function needsFrom(rules: (RuleRow & { role_key: string; role_name: string })[], courtId: number, sport: string): Need[] {
  const byRole = new Map<number, Need>();
  for (const r of rules) {
    if (r.court_id !== null && r.court_id !== courtId) continue;
    if (r.activity !== null && r.activity !== sport) continue;
    const have = byRole.get(r.role_id);
    if (!have || have.needed < Number(r.needed)) byRole.set(r.role_id, { roleId: r.role_id, roleKey: r.role_key, roleName: r.role_name, needed: Number(r.needed) });
  }
  return [...byRole.values()].sort((a, b) => a.roleId - b.roleId);
}

const RULES_SQL = `SELECT r.*, ro.key AS role_key, ro.name AS role_name FROM supervision_rules r JOIN roster_roles ro ON ro.id = r.role_id WHERE r.venue_id = ?`;

/** The roles and numbers a session of `sport` on this resource needs; none where nothing is asked. */
export async function needsFor(venueId: number, courtId: number, sport: string): Promise<Need[]> {
  const rules = (await getDb().prepare(RULES_SQL).all(venueId)) as (RuleRow & { role_key: string; role_name: string })[];
  return needsFrom(rules, courtId, sport);
}

// ------------------------------------------------------------ supply: who is on shift, in instants

interface Interval {
  from: number;
  to: number;
}
const joined = (xs: Interval[]): Interval[] => {
  const sorted = xs.filter((x) => x.to > x.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else out.push({ ...x });
  }
  return out;
};
/** `xs` less the parts `cuts` cover. */
const minus = (xs: Interval[], cuts: Interval[]): Interval[] => {
  let out = joined(xs);
  for (const c of joined(cuts)) {
    const next: Interval[] = [];
    for (const x of out) {
      if (c.to <= x.from || c.from >= x.to) next.push(x);
      else {
        if (c.from > x.from) next.push({ from: x.from, to: c.from });
        if (c.to < x.to) next.push({ from: c.to, to: x.to });
      }
    }
    out = next;
  }
  return out;
};
const within = (xs: Interval[], w: Interval): Interval[] =>
  xs.map((x) => ({ from: Math.max(x.from, w.from), to: Math.min(x.to, w.to) })).filter((x) => x.to > x.from);

/** The calendar date, on the venue's clock, a moment falls on. */
function localDate(at: number, zone: string): string {
  return new Date(at + zoneOffsetMinutes(new Date(at), zone) * 60_000).toISOString().slice(0, 10);
}

/** One person on shift in one role: when, and the lessons that take a coach's time (kept apart so a lesson's own coach is free for it). */
export interface Provider {
  person: RosterPerson;
  roleId: number;
  intervals: Interval[];
  busy: { bookingId: number; from: number; to: number }[];
}

/** Their time, less the lessons of other bookings than `exceptBookingId`. */
function availableOf(p: Provider, exceptBookingId?: number): Interval[] {
  return minus(
    p.intervals,
    p.busy.filter((b) => b.bookingId !== exceptBookingId).map((b) => ({ from: b.from, to: b.to }))
  );
}

/**
 * Everybody on shift in `window` (instants, ms), in each role they are rostered for: the weekly pattern and extra shifts,
 * less leave, a coach's time off and, for a qualification the role asks for, the part after it expires (none at all
 * where it is not recorded). Roles that are turned off, and people no longer on the venue's list, give nothing.
 */
export async function supply(venueId: number, zone: string, window: Interval, onlyRoles?: number[]): Promise<Provider[]> {
  const db = getDb();
  const roles = new Map<number, RosterRole>(
    ((await db.prepare("SELECT * FROM roster_roles WHERE venue_id = ? AND active").all(venueId)) as RoleRow[]).map((r) => [r.id, toRole(r)])
  );
  const people = new Map((await rosterPeople(venueId)).map((p) => [keyOf(p.kind, p.id), p]));
  const shifts = (await db.prepare("SELECT * FROM roster_shifts WHERE venue_id = ?").all(venueId)) as ShiftRow[];
  const firstDate = addDays(localDate(window.from, zone), -2);
  const lastDate = addDays(localDate(window.to, zone), 1);
  const exceptions = (await db
    .prepare("SELECT * FROM roster_exceptions WHERE venue_id = ? AND date BETWEEN ? AND ?")
    .all(venueId, firstDate, lastDate)) as ExceptionRow[];
  const quals = (await db
    .prepare("SELECT person_kind, person_id, qualification, expires_on FROM roster_qualifications WHERE venue_id = ? AND revoked_at IS NULL")
    .all(venueId)) as { person_kind: PersonKind; person_id: number; qualification: string; expires_on: string | null }[];

  const dates: string[] = [];
  for (let d = firstDate; d <= lastDate; d = addDays(d, 1)) dates.push(d);

  const made = new Map<string, Interval[]>();
  const add = (person: string, role: number, iv: Interval) => {
    const k = `${person}|${role}`;
    made.set(k, [...(made.get(k) ?? []), iv]);
  };
  for (const d of dates) {
    const weekday = dayOfWeek(d);
    for (const s of shifts) {
      if (s.weekday !== weekday) continue;
      add(keyOf(s.person_kind, s.person_id), s.role_id, { from: instantOf(d, s.from_min, zone).getTime(), to: instantOf(d, s.to_min, zone).getTime() });
    }
  }
  const leave = new Map<string, Interval[]>();
  for (const e of exceptions) {
    const k = keyOf(e.person_kind, e.person_id);
    if (e.kind === "extra" && e.role_id !== null)
      add(k, e.role_id, { from: instantOf(e.date, e.from_min!, zone).getTime(), to: instantOf(e.date, e.to_min!, zone).getTime() });
    else if (e.kind === "leave")
      leave.set(k, [...(leave.get(k) ?? []), { from: instantOf(e.date, e.from_min ?? 0, zone).getTime(), to: instantOf(e.date, e.to_min ?? 1440, zone).getTime() }]);
  }

  // A coach's own time off (whole days), and the lessons they are in.
  const coachIds = [...people.values()].filter((p) => p.kind === "coach").map((p) => p.id);
  const off = new Map<string, Interval[]>();
  const lessons = new Map<string, { bookingId: number; from: number; to: number }[]>();
  if (coachIds.length > 0) {
    const marks = coachIds.map(() => "?").join(",");
    const timeOff = (await db
      .prepare(`SELECT coach_id, from_date, until_date FROM coach_time_off WHERE coach_id IN (${marks}) AND until_date >= ? AND from_date <= ?`)
      .all(...coachIds, firstDate, lastDate)) as { coach_id: number; from_date: string; until_date: string }[];
    for (const o of timeOff) {
      const k = keyOf("coach", o.coach_id);
      off.set(k, [...(off.get(k) ?? []), { from: instantOf(o.from_date, 0, zone).getTime(), to: instantOf(addDays(o.until_date, 1), 0, zone).getTime() }]);
    }
    const range = `[${new Date(window.from).toISOString()},${new Date(window.to).toISOString()})`;
    const claims = (await db
      .prepare(`SELECT coach_id, booking_id, lower(during) AS lo, upper(during) AS hi FROM coach_claims WHERE coach_id IN (${marks}) AND active AND during && ?::tstzrange`)
      .all(...coachIds, range)) as { coach_id: number; booking_id: number; lo: Date; hi: Date }[];
    for (const c of claims) {
      const k = keyOf("coach", c.coach_id);
      lessons.set(k, [...(lessons.get(k) ?? []), { bookingId: c.booking_id, from: new Date(c.lo).getTime(), to: new Date(c.hi).getTime() }]);
    }
  }

  const out: Provider[] = [];
  for (const [k, ivs] of made) {
    const [personKey, roleText] = k.split("|");
    const roleId = Number(roleText);
    const role = roles.get(roleId);
    const person = people.get(personKey);
    if (!role || !person || (onlyRoles && !onlyRoles.includes(roleId))) continue;
    let intervals = minus(joined(ivs), [...(leave.get(personKey) ?? []), ...(off.get(personKey) ?? [])]);
    if (role.qualification) {
      const held = quals.filter((q) => q.person_kind === person.kind && q.person_id === person.id && norm(q.qualification) === norm(role.qualification!));
      if (held.length === 0) continue;
      // Holds until the end of the last day of the one that lasts longest; none ending means until taken back.
      const never = held.some((q) => q.expires_on === null);
      if (!never) {
        const until = Math.max(...held.map((q) => instantOf(addDays(q.expires_on!, 1), 0, zone).getTime()));
        intervals = within(intervals, { from: -Infinity, to: until });
      }
    }
    intervals = within(intervals, window);
    if (intervals.length === 0) continue;
    out.push({ person, roleId, intervals, busy: (lessons.get(personKey) ?? []).filter((b) => b.to > window.from && b.from < window.to) });
  }
  return out;
}

/** Where fewer than `needed` of these are available at once inside `session`, as intervals. */
function shortfall(available: Interval[][], needed: number, session: Interval): Interval[] {
  const points = new Set<number>([session.from, session.to]);
  for (const ivs of available)
    for (const iv of ivs) {
      if (iv.from > session.from && iv.from < session.to) points.add(iv.from);
      if (iv.to > session.from && iv.to < session.to) points.add(iv.to);
    }
  const cuts = [...points].sort((a, b) => a - b);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const mid = { from: cuts[i], to: cuts[i + 1] };
    const count = available.filter((ivs) => ivs.some((iv) => iv.from <= mid.from && iv.to >= mid.to)).length;
    if (count < needed) out.push(mid);
  }
  return joined(out);
}

const instantsOf = (date: string, span: Span, zone: string): Interval => ({
  from: instantOf(date, span.start, zone).getTime(),
  to: instantOf(date, span.end, zone).getTime(),
});
const spanOf = (iv: Interval, date: string, zone: string): Span => ({
  start: minuteOfDay(new Date(iv.from), date, zone),
  end: minuteOfDay(new Date(iv.to), date, zone),
});

export interface Unmet {
  need: Need;
  /** The parts of the session with too few, in minutes of its business day. */
  gaps: Span[];
}

/**
 * Where the session of `sport` on this resource, `span` of business day `date`, has too few qualified people on shift:
 * one entry for each role short, with the parts. Nothing where nothing is asked or all is covered. A coach teaching a
 * lesson of another booking than `exceptBookingId` is not available.
 */
export async function unmetNeeds(input: {
  venueId: number;
  courtId: number;
  sport: string;
  date: string;
  span: Span;
  zone: string;
  exceptBookingId?: number;
  needs?: Need[];
}): Promise<Unmet[]> {
  const needs = input.needs ?? (await needsFor(input.venueId, input.courtId, input.sport));
  if (needs.length === 0) return [];
  const session = instantsOf(input.date, input.span, input.zone);
  const providers = await supply(input.venueId, input.zone, session, needs.map((n) => n.roleId));
  return unmetWith(providers, needs, input.date, session, input.zone, input.exceptBookingId);
}

/** What is short of `needs` over a session, given who is on shift (`supply`). */
function unmetWith(providers: Provider[], needs: Need[], date: string, session: Interval, zone: string, exceptBookingId?: number): Unmet[] {
  const out: Unmet[] = [];
  for (const need of needs) {
    const gaps = shortfall(
      providers.filter((p) => p.roleId === need.roleId).map((p) => availableOf(p, exceptBookingId)),
      need.needed,
      session
    );
    if (gaps.length > 0) out.push({ need, gaps: gaps.map((g) => spanOf(g, date, zone)) });
  }
  return out;
}

// ------------------------------------------------------------ the booking path

/** The roster's refusal of a session: the code a customer is told, naming the role missing. */
export function noSupervisor(un: Unmet): Refusal {
  return refuse("SV1_NO_SUPERVISOR", { role: un.need.roleName, n: un.need.needed });
}

/**
 * The one check every way a session is made or moved asks: null where nothing is asked or where at least `needed`
 * qualified people are on shift for the whole of it, else the refusal for the first role short. Run in the session's own
 * transaction: it takes the venue's roster lock shared first (only where a rule applies), so a shift being removed at
 * the same moment is either seen here or sees this session when it lists what it uncovered. A manager's override of a
 * court's booking rules goes past none of it: the way to book an hour nobody is rostered for is to roster somebody.
 */
export async function supervisionRefusal(input: {
  venueId: number;
  courtId: number;
  sport: string;
  date: string;
  span: Span;
  zone: string;
  exceptBookingId?: number;
}): Promise<Refusal | null> {
  const needs = await needsFor(input.venueId, input.courtId, input.sport);
  if (needs.length === 0) return null;
  await lockRoster(input.venueId, "shared");
  const unmet = await unmetNeeds({ ...input, needs });
  return unmet.length > 0 ? noSupervisor(unmet[0]) : null;
}

/**
 * Several resources' unsupervised spans of one day in one go, for the board and the lists of starts: only the venues
 * and resources a rule applies to cost anything.
 */
export async function unsupervisedOn(
  courts: { id: number; venueId: number; sport: string }[],
  date: string,
  hours: Map<number, { span: Span; zone: string }>
): Promise<Map<number, Span[]>> {
  const out = new Map<number, Span[]>();
  if (courts.length === 0) return out;
  const venueIds = [...new Set(courts.map((c) => c.venueId))];
  const rules = (await getDb()
    .prepare(`${RULES_SQL.replace("WHERE r.venue_id = ?", `WHERE r.venue_id IN (${venueIds.map(() => "?").join(",")})`)}`)
    .all(...venueIds)) as (RuleRow & { role_key: string; role_name: string })[];
  if (rules.length === 0) return out;
  // Who is on shift is read once for a venue, over the whole of its courts' day, and asked of each court.
  const subject = courts
    .map((c) => ({ c, needs: needsFrom(rules.filter((r) => r.venue_id === c.venueId), c.id, c.sport), h: hours.get(c.id) }))
    .filter((x): x is { c: (typeof courts)[number]; needs: Need[]; h: { span: Span; zone: string } } => x.needs.length > 0 && x.h !== undefined && x.h.span.end > x.h.span.start);
  for (const venueId of new Set(subject.map((x) => x.c.venueId))) {
    const mine = subject.filter((x) => x.c.venueId === venueId);
    const sessions = mine.map((x) => instantsOf(date, x.h.span, x.h.zone));
    const window = { from: Math.min(...sessions.map((i) => i.from)), to: Math.max(...sessions.map((i) => i.to)) };
    const providers = await supply(venueId, mine[0].h.zone, window, [...new Set(mine.flatMap((x) => x.needs.map((n) => n.roleId)))]);
    mine.forEach((x, i) => out.set(x.c.id, merge(unmetWith(providers, x.needs, date, sessions[i], x.h.zone).flatMap((u) => u.gaps))));
  }
  return out;
}

// ------------------------------------------------------------ who is named on a session

export type SessionRef = { kind: "booking"; id: number } | { kind: "class"; id: number };

export interface Supervisor {
  id: number;
  roleId: number | null;
  roleKey: string;
  roleName: string;
  how: "rostered" | "covered" | "override";
  personKind: PersonKind | null;
  personId: number | null;
  personName: string | null;
  reason: string | null;
  from: string;
  to: string;
  recordedByName: string | null;
}

interface SupervisorRow {
  id: number;
  booking_id: number | null;
  class_id: number | null;
  role_id: number | null;
  role_key: string;
  role_name: string;
  how: "rostered" | "covered" | "override";
  person_kind: PersonKind | null;
  person_id: number | null;
  person_name: string | null;
  reason: string | null;
  lo: Date;
  hi: Date;
  recorded_by_name: string | null;
}
const toSupervisor = (r: SupervisorRow): Supervisor => ({
  id: r.id,
  roleId: r.role_id,
  roleKey: r.role_key,
  roleName: r.role_name,
  how: r.how,
  personKind: r.person_kind,
  personId: r.person_id,
  personName: r.person_name,
  reason: r.reason,
  from: new Date(r.lo).toISOString(),
  to: new Date(r.hi).toISOString(),
  recordedByName: r.recorded_by_name,
});

const column = (ref: SessionRef) => (ref.kind === "booking" ? "booking_id" : "class_id");

/** Who is named on these sessions now (the record kept when it was made or changed), by session id. */
export async function supervisorsOf(kind: SessionRef["kind"], ids: number[]): Promise<Map<number, Supervisor[]>> {
  const out = new Map<number, Supervisor[]>();
  if (ids.length === 0) return out;
  const col = kind === "booking" ? "booking_id" : "class_id";
  const rows = (await getDb()
    .prepare(
      `SELECT id, booking_id, class_id, role_id, role_key, role_name, how, person_kind, person_id, person_name, reason, lower(during) AS lo, upper(during) AS hi, recorded_by_name
         FROM session_supervisors WHERE ${col} IN (${ids.map(() => "?").join(",")}) AND active ORDER BY id`
    )
    .all(...ids)) as SupervisorRow[];
  for (const r of rows) {
    const id = (kind === "booking" ? r.booking_id : r.class_id)!;
    out.set(id, [...(out.get(id) ?? []), toSupervisor(r)]);
  }
  return out;
}

/** The roles supervising a session, for a customer: the role, never the person. */
export async function rolesOnBookings(ids: number[]): Promise<Map<number, { key: string; name: string }[]>> {
  const out = new Map<number, { key: string; name: string }[]>();
  for (const [id, list] of await supervisorsOf("booking", ids)) {
    const roles = new Map<string, string>();
    for (const s of list) if (s.how !== "override") roles.set(s.roleKey, s.roleName);
    if (roles.size > 0) out.set(id, [...roles].map(([key, name]) => ({ key, name })));
  }
  return out;
}

/**
 * Name who supervises a session just made or moved: the people on shift (the fewest that cover it, staff before coaches),
 * kept as a record whatever the roster does afterwards. Whoever was named before is kept as history, no longer active.
 * Run in the session's transaction, after its claims (a coach's lock comes last).
 */
export async function recordSupervisors(input: {
  session: SessionRef;
  venueId: number;
  courtId: number;
  sport: string;
  date: string;
  span: Span;
  zone: string;
}): Promise<void> {
  const db = getDb();
  const col = column(input.session);
  await db.prepare(`UPDATE session_supervisors SET active = false WHERE ${col} = ? AND active`).run(input.session.id);
  const needs = await needsFor(input.venueId, input.courtId, input.sport);
  if (needs.length === 0) return;
  const session = instantsOf(input.date, input.span, input.zone);
  const except = input.session.kind === "booking" ? input.session.id : undefined;
  const providers = await supply(input.venueId, input.zone, session, needs.map((n) => n.roleId));
  for (const need of needs) {
    // Staff before coaches, those covering most first, then by id: the same answer for the same roster.
    const mine = providers
      .filter((p) => p.roleId === need.roleId)
      .map((p) => ({ p, avail: within(availableOf(p, except), session) }))
      .filter((x) => x.avail.length > 0)
      .sort(
        (a, b) =>
          (a.p.person.kind === b.p.person.kind ? 0 : a.p.person.kind === "staff" ? -1 : 1) ||
          b.avail.reduce((s, i) => s + i.to - i.from, 0) - a.avail.reduce((s, i) => s + i.to - i.from, 0) ||
          a.p.person.id - b.p.person.id
      );
    const chosen: { p: Provider; avail: Interval[] }[] = [];
    for (const x of mine) {
      // Taken where they are on at a moment fewer than `needed` of those chosen so far are.
      const short = shortfall(chosen.map((c) => c.avail), need.needed, session);
      if (short.length === 0) break;
      if (x.avail.some((a) => short.some((g) => a.from < g.to && g.from < a.to))) chosen.push(x);
    }
    for (const c of chosen) {
      if (c.p.person.kind === "coach") await lockCoach(c.p.person.id);
      for (const iv of c.avail)
        await db
          .prepare(
            `INSERT INTO session_supervisors (venue_id, booking_id, class_id, role_id, role_key, role_name, person_kind, person_id, person_name, how, during)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rostered', ?::tstzrange)`
          )
          .run(
            input.venueId,
            input.session.kind === "booking" ? input.session.id : null,
            input.session.kind === "class" ? input.session.id : null,
            need.roleId,
            need.roleKey,
            need.roleName,
            c.p.person.kind,
            c.p.person.id,
            c.p.person.name,
            `[${new Date(iv.from).toISOString()},${new Date(iv.to).toISOString()})`
          );
    }
  }
}

/**
 * Whether this coach is named to supervise a session at any time inside this span, other than `exceptBookingId`'s: a
 * lesson cannot take their time then (lib/coaching.ts `attachCoach`), as a lesson already taking it keeps them from
 * being named.
 */
export async function coachSupervising(coachId: number, date: string, span: Span, zone: string, exceptBookingId?: number): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM session_supervisors s
        WHERE s.person_kind = 'coach' AND s.person_id = ? AND s.active AND s.how <> 'override' AND s.during && ?::tstzrange
          AND (s.booking_id IS NULL OR s.booking_id <> ?)
          AND (s.booking_id IS NULL OR EXISTS (SELECT 1 FROM bookings b WHERE b.id = s.booking_id AND b.status = 'confirmed'))
          AND (s.class_id IS NULL OR EXISTS (SELECT 1 FROM classes c WHERE c.id = s.class_id AND c.status = 'scheduled'))
        LIMIT 1`
    )
    .get(coachId, rangeLiteral(date, span.start, span.end, zone), exceptBookingId ?? 0);
  return row !== undefined;
}

// ------------------------------------------------------------ sessions without their supervisors

export interface UncoveredSession {
  kind: "booking" | "class";
  id: number;
  code: string | null;
  venueId: number;
  courtId: number;
  courtName: string;
  sport: string;
  date: string;
  startMin: number;
  endMin: number;
  /** The customer's name (a booking), or the class's. */
  name: string;
  roles: { roleId: number; roleKey: string; roleName: string; needed: number; gaps: Span[] }[];
}

interface SessionRow {
  kind: "booking" | "class";
  id: number;
  code: string | null;
  court_id: number;
  court_name: string;
  sport: string;
  date: string;
  start_min: number;
  end_min: number;
  name: string;
}

/** How far ahead the worklist looks. */
export const WORKLIST_DAYS = 120;

/**
 * Sessions to come at these venues (all, where none are named) that have too few qualified people on shift and no
 * decision of a manager: a cover named for the gap, or a reason to let it stand. Worked out from the roster as it is now, so a
 * booking made under a shift is listed the moment the shift is gone, and leaves the list when somebody is rostered
 * again. Cancelled bookings and classes are not listed.
 */
export async function uncoveredSessions(venueIds: number[] | null, opts: { venueId?: number } = {}): Promise<UncoveredSession[]> {
  const db = getDb();
  const wanted = (await db.prepare("SELECT DISTINCT venue_id FROM supervision_rules").all()) as { venue_id: number }[];
  const venues = wanted.map((w) => w.venue_id).filter((v) => (venueIds === null || venueIds.includes(v)) && (opts.venueId === undefined || opts.venueId === v));
  const out: UncoveredSession[] = [];
  for (const venueId of venues) out.push(...(await uncoveredAt(venueId)));
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin || a.id - b.id);
}

async function uncoveredAt(venueId: number): Promise<UncoveredSession[]> {
  const db = getDb();
  const row = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  if (!row) return [];
  const zone = venueZoneOf(row);
  const today = todayISO(zone);
  const until = addDays(today, WORKLIST_DAYS);
  const rules = (await db.prepare(RULES_SQL).all(venueId)) as (RuleRow & { role_key: string; role_name: string })[];
  if (rules.length === 0) return [];
  const sessions = (await db
    .prepare(
      `SELECT 'booking' AS kind, b.id, b.code, b.court_id, c.name AS court_name, b.sport, b.date, b.start_min, b.end_min, b.name
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.status = 'confirmed' AND b.class_id IS NULL AND b.date BETWEEN ? AND ?
       UNION ALL
       SELECT 'class' AS kind, k.id, NULL AS code, k.court_id, c.name AS court_name, c.sport, k.date, k.start_min, k.end_min, k.name
         FROM classes k JOIN courts c ON c.id = k.court_id
        WHERE c.venue_id = ? AND k.status = 'scheduled' AND k.date BETWEEN ? AND ?`
    )
    .all(venueId, today, until, venueId, today, until)) as SessionRow[];
  const subject = sessions
    .map((s) => ({ s, needs: needsFrom(rules, s.court_id, s.sport) }))
    .filter((x) => x.needs.length > 0 && instantOf(x.s.date, x.s.end_min, zone).getTime() > Date.now());
  if (subject.length === 0) return [];
  const window = {
    from: Math.min(...subject.map((x) => instantOf(x.s.date, x.s.start_min, zone).getTime())),
    to: Math.max(...subject.map((x) => instantOf(x.s.date, x.s.end_min, zone).getTime())),
  };
  const providers = await supply(venueId, zone, window);
  // What managers decided: a person named to cover, or a session let stand.
  const decisions = (await db
    .prepare(
      `SELECT booking_id, class_id, role_id, how, person_kind, person_id, person_name, lower(during) AS lo, upper(during) AS hi
         FROM session_supervisors WHERE venue_id = ? AND active AND how IN ('covered', 'override')`
    )
    .all(venueId)) as { booking_id: number | null; class_id: number | null; role_id: number | null; how: string; person_kind: PersonKind | null; person_id: number | null; person_name: string | null; lo: Date; hi: Date }[];
  const found: UncoveredSession[] = [];
  for (const { s, needs } of subject) {
    const session = instantsOf(s.date, { start: s.start_min, end: s.end_min }, zone);
    const mine = decisions.filter((d) => (s.kind === "booking" ? d.booking_id === s.id : d.class_id === s.id));
    const roles: UncoveredSession["roles"] = [];
    for (const need of needs) {
      if (mine.some((d) => d.how === "override" && d.role_id === need.roleId)) continue;
      const people = new Map<string, Interval[]>();
      for (const p of providers) if (p.roleId === need.roleId) people.set(keyOf(p.person.kind, p.person.id), availableOf(p, s.kind === "booking" ? s.id : undefined));
      // Somebody a manager named to cover is on, for the part named, whether rostered or not (once, where they are both).
      for (const d of mine)
        if (d.how === "covered" && d.role_id === need.roleId && d.person_kind && d.person_id !== null) {
          const k = keyOf(d.person_kind, d.person_id);
          people.set(k, joined([...(people.get(k) ?? []), { from: new Date(d.lo).getTime(), to: new Date(d.hi).getTime() }]));
        }
      const gaps = shortfall([...people.values()], need.needed, session);
      if (gaps.length > 0) roles.push({ roleId: need.roleId, roleKey: need.roleKey, roleName: need.roleName, needed: need.needed, gaps: gaps.map((g) => spanOf(g, s.date, zone)) });
    }
    if (roles.length > 0)
      found.push({
        kind: s.kind,
        id: s.id,
        code: s.code,
        venueId,
        courtId: s.court_id,
        courtName: s.court_name,
        sport: s.sport,
        date: s.date,
        startMin: s.start_min,
        endMin: s.end_min,
        name: s.name,
        roles,
      });
  }
  return found;
}

/** Run a change to the roster and say which sessions it left uncovered that were not before (within the roster lock the caller holds). */
async function newlyUncovered(venueId: number, change: () => Promise<unknown>): Promise<UncoveredSession[]> {
  const before = new Set((await uncoveredAt(venueId)).map((u) => `${u.kind}:${u.id}`));
  await change();
  const after = await uncoveredAt(venueId);
  return after.filter((u) => !before.has(`${u.kind}:${u.id}`));
}

async function sessionRow(venueId: number, ref: SessionRef): Promise<(SessionRow & { zone: string; venue_id: number }) | null> {
  const db = getDb();
  const r =
    ref.kind === "booking"
      ? await db
          .prepare(
            `SELECT 'booking' AS kind, b.id, b.code, b.court_id, c.name AS court_name, b.sport, b.date, b.start_min, b.end_min, b.name, c.venue_id
               FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ? AND c.venue_id = ? AND b.status = 'confirmed' AND b.class_id IS NULL`
          )
          .get(ref.id, venueId)
      : await db
          .prepare(
            `SELECT 'class' AS kind, k.id, NULL AS code, k.court_id, c.name AS court_name, c.sport, k.date, k.start_min, k.end_min, k.name, c.venue_id
               FROM classes k JOIN courts c ON c.id = k.court_id WHERE k.id = ? AND c.venue_id = ? AND k.status = 'scheduled'`
          )
          .get(ref.id, venueId);
  if (!r) return null;
  const v = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null };
  return { ...(r as SessionRow & { venue_id: number }), zone: venueZoneOf(v) };
}

/**
 * A manager covers a session: names another person to supervise it in a role. They need not be rostered (they are being
 * called in) but must be on the venue's list, hold the qualification the role asks for through the session, and not be
 * teaching a lesson then. Kept with who named them. Returns the session's open gaps after.
 */
export async function coverSession(
  venueId: number,
  input: { kind?: unknown; id?: unknown; roleId?: unknown; personKind?: unknown; personId?: unknown },
  by: { id: number | null; name: string }
): Promise<{ ok: true } | Refusal> {
  if ((input.kind !== "booking" && input.kind !== "class") || !Number.isInteger(input.id)) return said("Choose a session.");
  const role = await checkedRole(venueId, input.roleId);
  if ("ok" in role) return role;
  const person = await personAt(venueId, input.personKind, input.personId);
  if (!person) return said("That person is not on this venue's roster list.", 404);
  const ref = { kind: input.kind, id: input.id as number } as SessionRef;
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    const s = await sessionRow(venueId, ref);
    if (!s) return said("That session is not at this venue, or is cancelled.", 404);
    const needs = await needsFor(venueId, s.court_id, s.sport);
    if (!needs.some((n) => n.roleId === role.id)) return said("That session needs nobody in that role.");
    const during = instantsOf(s.date, { start: s.start_min, end: s.end_min }, s.zone);
    if (role.qualification) {
      const held = (await getDb()
        .prepare("SELECT qualification, expires_on FROM roster_qualifications WHERE venue_id = ? AND person_kind = ? AND person_id = ? AND revoked_at IS NULL")
        .all(venueId, person.kind, person.id)) as { qualification: string; expires_on: string | null }[];
      const ok = held.some(
        (q) => norm(q.qualification) === norm(role.qualification!) && (q.expires_on === null || instantOf(addDays(q.expires_on, 1), 0, s.zone).getTime() >= during.to)
      );
      if (!ok) return said(`${person.name} does not hold the ${role.qualification} through the whole session. Record it first, or name somebody who does.`, 409);
    }
    if (person.kind === "coach") {
      await lockCoach(person.id);
      const busy = (await getDb()
        .prepare("SELECT 1 FROM coach_claims WHERE coach_id = ? AND active AND during && ?::tstzrange AND booking_id <> ? LIMIT 1")
        .get(person.id, rangeLiteral(s.date, s.start_min, s.end_min, s.zone), ref.kind === "booking" ? ref.id : 0)) as unknown;
      if (busy) return said(`${person.name} is teaching a lesson then.`, 409);
    }
    await getDb()
      .prepare(
        `INSERT INTO session_supervisors (venue_id, booking_id, class_id, role_id, role_key, role_name, person_kind, person_id, person_name, how, during, recorded_by, recorded_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'covered', ?::tstzrange, ?, ?)`
      )
      .run(
        venueId,
        ref.kind === "booking" ? ref.id : null,
        ref.kind === "class" ? ref.id : null,
        role.id,
        role.key,
        role.name,
        person.kind,
        person.id,
        person.name,
        rangeLiteral(s.date, s.start_min, s.end_min, s.zone),
        by.id,
        by.name
      );
    return { ok: true as const };
  });
}

/** A manager lets a session stand without somebody in a role, with the reason, which is kept. */
export async function overrideSession(
  venueId: number,
  input: { kind?: unknown; id?: unknown; roleId?: unknown; reason?: unknown },
  by: { id: number | null; name: string }
): Promise<{ ok: true } | Refusal> {
  if ((input.kind !== "booking" && input.kind !== "class") || !Number.isInteger(input.id)) return said("Choose a session.");
  const reason = cleanText(input.reason, 300);
  if (!reason || reason.length < 3) return said("Say why the session may go ahead without them.");
  const role = await roleById(venueId, input.roleId);
  if (!role) return said("That role is not at this venue.", 404);
  const ref = { kind: input.kind, id: input.id as number } as SessionRef;
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    const s = await sessionRow(venueId, ref);
    if (!s) return said("That session is not at this venue, or is cancelled.", 404);
    const needs = await needsFor(venueId, s.court_id, s.sport);
    if (!needs.some((n) => n.roleId === role.id)) return said("That session needs nobody in that role.");
    await getDb()
      .prepare(
        `INSERT INTO session_supervisors (venue_id, booking_id, class_id, role_id, role_key, role_name, how, during, reason, recorded_by, recorded_by_name)
         VALUES (?, ?, ?, ?, ?, ?, 'override', ?::tstzrange, ?, ?, ?)`
      )
      .run(
        venueId,
        ref.kind === "booking" ? ref.id : null,
        ref.kind === "class" ? ref.id : null,
        role.id,
        role.key,
        role.name,
        rangeLiteral(s.date, s.start_min, s.end_min, s.zone),
        reason,
        by.id,
        by.name
      );
    return { ok: true as const };
  });
}

/** Take back a manager's cover or override of a session (it is kept as history, no longer counted). */
export async function undoDecision(venueId: number, id: unknown): Promise<{ ok: true } | Refusal> {
  if (!Number.isInteger(id)) return said("That decision is not at this venue.", 404);
  return withTransaction(async () => {
    await lockRoster(venueId, "exclusive");
    const done = await getDb()
      .prepare("UPDATE session_supervisors SET active = false WHERE id = ? AND venue_id = ? AND active AND how IN ('covered', 'override')")
      .run(id, venueId);
    return done.changes === 1 ? { ok: true as const } : said("That decision is not at this venue.", 404);
  });
}

// ------------------------------------------------------------ what the roster looks like, with its warnings

export interface RosterFlag {
  kind: "no_qualification" | "expires" | "gone";
  personKind: PersonKind;
  personId: number;
  roleId: number;
  shiftId?: number;
  exceptionId?: number;
  qualification?: string | null;
  /** For `expires`: the last day it holds. */
  expiresOn?: string | null;
}

/**
 * What is wrong with the roster as it stands, for a manager: a shift whose role asks for a qualification the person has not
 * recorded, one whose qualification ends before some shift to come does, and a shift whose person is no longer on the
 * venue's list. Such time is never counted as cover (`supply`); this says why.
 */
export async function rosterFlags(venueId: number): Promise<RosterFlag[]> {
  const roles = new Map((await listRoles(venueId)).map((r) => [r.id, r]));
  const people = new Set((await rosterPeople(venueId)).map((p) => keyOf(p.kind, p.id)));
  const quals = await listQualifications(venueId);
  const shifts = await listShifts(venueId);
  const exceptions = (await listExceptions(venueId)).filter((e) => e.kind === "extra" && e.roleId !== null);
  const flags: RosterFlag[] = [];
  const check = (personKind: PersonKind, personId: number, roleId: number, where: { shiftId?: number; exceptionId?: number }, lastShiftEnds: string | null) => {
    if (!people.has(keyOf(personKind, personId))) return flags.push({ kind: "gone", personKind, personId, roleId, ...where });
    const role = roles.get(roleId);
    if (!role?.qualification) return;
    const held = quals.filter((q) => q.personKind === personKind && q.personId === personId && norm(q.qualification) === norm(role.qualification!));
    if (held.length === 0) return flags.push({ kind: "no_qualification", personKind, personId, roleId, qualification: role.qualification, ...where });
    if (held.some((q) => q.expiresOn === null)) return;
    const last = held.map((q) => q.expiresOn!).sort().pop()!;
    if (lastShiftEnds !== null && last < lastShiftEnds) flags.push({ kind: "expires", personKind, personId, roleId, qualification: role.qualification, expiresOn: last, ...where });
  };
  // A weekly shift goes on, so its qualification must reach as far ahead as anybody can book, a half year.
  const horizon = addDays(todayISO(), 180);
  for (const s of shifts) check(s.personKind, s.personId, s.roleId, { shiftId: s.id }, horizon);
  for (const e of exceptions) check(e.personKind, e.personId, e.roleId!, { exceptionId: e.id }, e.date);
  return flags;
}

// ------------------------------------------------------------ a person's own shifts, as a calendar

/** How long a personal calendar link works before a new one is made. */
export const CALENDAR_LINK_DAYS = 365;
const linkHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** A new calendar link for a member of staff, replacing any (only the hash is kept, so the address is shown once). */
export async function makeCalendarLink(adminId: number, baseUrl: string): Promise<{ url: string; until: string }> {
  const token = crypto.randomBytes(24).toString("hex");
  const until = new Date(Date.now() + CALENDAR_LINK_DAYS * 86_400_000).toISOString();
  await getDb()
    .prepare(
      `INSERT INTO roster_calendar_links (admin_id, token_hash, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (admin_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = datetime('now'), expires_at = EXCLUDED.expires_at`
    )
    .run(adminId, linkHash(token), until);
  return { url: `${baseUrl}/api/roster-calendar/${token}.ics`, until };
}

export async function revokeCalendarLink(adminId: number): Promise<void> {
  await getDb().prepare("DELETE FROM roster_calendar_links WHERE admin_id = ?").run(adminId);
}

export async function adminForCalendarToken(token: string): Promise<{ id: number; name: string; venueId: number | null; locale: string | null } | null> {
  if (!/^[A-Za-z0-9]{20,64}$/.test(token)) return null;
  const row = (await getDb()
    .prepare(
      `SELECT a.id, a.name, a.venue_id, a.locale FROM roster_calendar_links l JOIN admins a ON a.id = l.admin_id WHERE l.token_hash = ? AND l.expires_at > ?`
    )
    .get(linkHash(token), new Date().toISOString())) as { id: number; name: string; venue_id: number | null; locale: string | null } | undefined;
  return row ? { id: row.id, name: row.name, venueId: row.venue_id, locale: row.locale } : null;
}

export interface OwnShift {
  roleName: string;
  roleKey: string;
  from: number;
  to: number;
}

/** A person's own shifts from `from` (a date) for `days` days, in instants, as the supply counts them: leave taken off and qualifications as they hold. */
export async function ownShifts(venueId: number, person: { kind: PersonKind; id: number }, from: string, days: number): Promise<OwnShift[]> {
  const row = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  if (!row) return [];
  const zone = venueZoneOf(row);
  const window = { from: instantOf(from, 0, zone).getTime(), to: instantOf(addDays(from, days), 0, zone).getTime() };
  const roles = new Map((await listRoles(venueId)).map((r) => [r.id, r]));
  const out: OwnShift[] = [];
  for (const p of await supply(venueId, zone, window))
    if (p.person.kind === person.kind && p.person.id === person.id)
      for (const iv of p.intervals) out.push({ roleName: roles.get(p.roleId)?.name ?? "", roleKey: roles.get(p.roleId)?.key ?? "", from: iv.from, to: iv.to });
  return out.sort((a, b) => a.from - b.from);
}

/** The roster as a manager or the desk sees it. */
export async function rosterOverview(venueId: number) {
  const [roles, people, qualifications, shifts, exceptions, rules, flags] = await Promise.all([
    listRoles(venueId),
    rosterPeople(venueId),
    listQualifications(venueId),
    listShifts(venueId),
    listExceptions(venueId),
    listRules(venueId),
    rosterFlags(venueId),
  ]);
  return { roles, people, qualifications, shifts, exceptions, rules, flags };
}
