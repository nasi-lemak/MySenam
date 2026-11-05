import { getDb, withTransaction } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { rangeLiteral } from "./interval";
import { isConflict, lockCoach } from "./claims";
import { coachById, coachWorks, type Coach } from "./coaching";
import { activityName } from "./activity-registry";
import { todayISO } from "./time";
import type { Refusal, Sport } from "./types";

/**
 * A class's instructor as one of the venue's coaches (migration 0281;
 * docs/features/programmes.md#a-classs-instructor-as-one-of-the-venues-coaches).
 *
 * Not a second coach model: `classes.coach_id` names a row of `coaches`, whose
 * own name customers then read as the instructor. A class with no coach keeps
 * its typed instructor name, as every class made before this did.
 *
 * A coach in a class is claimed for the session's time in `coach_claims`, the
 * table that keeps a coach in one lesson at a time, so the constraint that
 * refuses a lesson over a lesson refuses a class over a lesson, a lesson over
 * a class and a class over a class, to the minute, whatever courts they are
 * on. The rest is what a lesson asks of its coach: the venue's coach, active,
 * coaching that activity, and working then (their hours, not on time off).
 * Nothing here drops a coach silently: a coach retired, on leave or
 * out of hours after the class was set is on the dashboard's worklist
 * (`classCoachConflicts`), the class unchanged.
 */

const ENGLISH = translator("en");
const refuse = (code: ErrorCode, vars?: Record<string, string | number>): Refusal => ({
  ok: false,
  error: errorText(ENGLISH, code, vars),
  code,
  ...(vars ? { vars } : {}),
});

/** A session's time, as the coach is held for it. */
export interface ClassSlot {
  date: string;
  startMin: number;
  endMin: number;
}

/** What a coach is in at a time: a lesson, or a class (named, with its day). */
export type CoachClash = { kind: "lesson" } | { kind: "class"; name: string; date: string };

/** What is in the coach's way over a session's time, ignoring the classes named (those being changed or moved: their own claims are let go). */
export async function coachClash(coachId: number, slot: ClassSlot, zone: string, exceptClassIds: number[] = []): Promise<CoachClash | null> {
  const during = rangeLiteral(slot.date, slot.startMin, slot.endMin, zone);
  const skip = exceptClassIds.length > 0 ? ` AND (cc.class_id IS NULL OR cc.class_id NOT IN (${exceptClassIds.map(() => "?").join(",")}))` : "";
  const row = (await getDb()
    .prepare(
      `SELECT cc.booking_id, cl.name, cl.date FROM coach_claims cc LEFT JOIN classes cl ON cl.id = cc.class_id
        WHERE cc.coach_id = ? AND cc.active AND cc.during && ?::tstzrange${skip} ORDER BY cc.id LIMIT 1`
    )
    .get(coachId, during, ...exceptClassIds)) as { booking_id: number | null; name: string | null; date: string | null } | undefined;
  if (!row) return null;
  return row.booking_id !== null ? { kind: "lesson" } : { kind: "class", name: row.name ?? "", date: row.date ?? slot.date };
}

function clashRefusal(coach: Pick<Coach, "name">, clash: CoachClash): Refusal {
  return clash.kind === "lesson"
    ? refuse("CLSA_COACH_LESSON", { name: coach.name })
    : refuse("CLSA_COACH_CLASS", { name: coach.name, class: clash.name, date: clash.date });
}

/**
 * Whether this coach may teach a class's sessions: one of the venue's active coaches, coaching the activity, working
 * through each session (their hours that weekday, not on time off), and in no lesson or other class then. Read for
 * showing and refusing early; the claim (`holdCoach`) is what the database enforces.
 */
export async function coachTeachingRefusal(
  coachId: number,
  venueId: number,
  sport: Sport,
  slots: ClassSlot[],
  zone: string,
  exceptClassIds: number[] = []
): Promise<Refusal | null> {
  const coach = await coachById(coachId);
  if (!coach || !coach.active || coach.venueId !== venueId) return refuse("COACH_NOT_FOUND");
  if (!coach.sports.includes(sport)) return refuse("CLSA_COACH_SPORT", { name: coach.name, sport: activityName(sport) });
  for (const slot of slots) {
    if (!coachWorks(coach, slot.date, { start: slot.startMin, end: slot.endMin })) return refuse("COACH_NOT_WORKING", { name: coach.name });
    const clash = await coachClash(coachId, slot, zone, exceptClassIds);
    if (clash) return clashRefusal(coach, clash);
  }
  return null;
}

/** Thrown from `holdCoach` when the coach is taken for that time (the database's refusal, said in words). */
export class CoachHeld extends Error {
  constructor(readonly refusal: Refusal) {
    super("COACH_HELD");
  }
}

/**
 * Hold a coach for a class's session, in the transaction that writes the class: any claim the class had is let go first
 * (a moved session, a changed instructor), then the coach is claimed for the new time, after the courts (the order every
 * claim locks in). Throws `CoachHeld` when the coach is in a lesson or another class then.
 */
export async function holdCoach(classId: number, coachId: number, slot: ClassSlot, zone: string): Promise<void> {
  const db = getDb();
  await db.prepare("DELETE FROM coach_claims WHERE class_id = ?").run(classId);
  await lockCoach(coachId);
  try {
    // Under a savepoint of its own: a refusal by the database aborts a transaction, and the reads below say who is in the way.
    await withTransaction(() =>
      db
        .prepare("INSERT INTO coach_claims (coach_id, class_id, during) VALUES (?, ?, ?::tstzrange)")
        .run(coachId, classId, rangeLiteral(slot.date, slot.startMin, slot.endMin, zone))
    );
  } catch (err) {
    if (!isConflict(err)) throw err;
    const coach = await coachById(coachId);
    const clash = await coachClash(coachId, slot, zone, [classId]);
    throw new CoachHeld(clash && coach ? clashRefusal(coach, clash) : refuse("COACH_TAKEN", { name: coach?.name ?? "" }));
  }
}

/** A class with no coach, or called off: its hold on a coach is let go. */
export async function releaseCoach(classId: number): Promise<void> {
  await getDb().prepare("UPDATE coach_claims SET active = false WHERE class_id = ? AND active").run(classId);
}

/** Active coaches of the venue whose name is the instructor's as typed: for the one-click link on a class with a name only. */
export async function coachMatching(venueId: number, name: string): Promise<{ id: number; name: string } | null> {
  const row = (await getDb()
    .prepare("SELECT id, name FROM coaches WHERE venue_id = ? AND active = 1 AND lower(trim(name)) = lower(trim(?)) ORDER BY id LIMIT 2")
    .all(venueId, name)) as { id: number; name: string }[];
  // Two coaches of one name: no guess.
  return row.length === 1 ? row[0] : null;
}

/** A class a coach teaches, as their schedule and calendar show it. */
export interface CoachClass {
  id: number;
  name: string;
  date: string;
  startMin: number;
  endMin: number;
  court: string;
  enrolled: number;
  capacity: number;
}

/** A coach's classes still on, between two dates (a count of who is in them, never who). */
export async function coachClasses(coachId: number, from: string, until: string): Promise<CoachClass[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT cl.id, cl.name, cl.date, cl.start_min, cl.end_min, cl.capacity, c.name AS court,
              (SELECT COUNT(*) FROM bookings b WHERE b.class_id = cl.id AND b.status = 'confirmed')::int AS enrolled
         FROM classes cl JOIN courts c ON c.id = cl.court_id
        WHERE cl.coach_id = ? AND cl.status = 'scheduled' AND cl.date BETWEEN ? AND ?
        ORDER BY cl.date, cl.start_min`
    )
    .all(coachId, from, until)) as { id: number; name: string; date: string; start_min: number; end_min: number; capacity: number; court: string; enrolled: number }[];
  return rows.map((r) => ({ id: r.id, name: r.name, date: r.date, startMin: r.start_min, endMin: r.end_min, court: r.court, enrolled: Number(r.enrolled), capacity: r.capacity }));
}

/** Why a coached class needs somebody's attention. */
export type CoachConflictReason = "inactive" | "time_off" | "outside_hours" | "not_held";

export interface ClassCoachConflict {
  classId: number;
  name: string;
  date: string;
  startMin: number;
  endMin: number;
  venueId: number;
  venueName: string;
  coachId: number;
  coachName: string;
  reasons: CoachConflictReason[];
}

/**
 * The dashboard's worklist: upcoming sessions whose coach can no longer teach them as set. A coach retired, on days off
 * across the session, working other hours now, or (should it ever happen) not held for its time. The class stays as it
 * is and keeps its instructor; staff change it (the class's instructor) or the coach's hours.
 */
export async function classCoachConflicts(venueIds: number[] | null): Promise<ClassCoachConflict[]> {
  if (venueIds && venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT cl.id, cl.name, cl.date, cl.start_min, cl.end_min, cl.coach_id, v.id AS venue_id, v.name AS venue_name,
              EXISTS (SELECT 1 FROM coach_claims cc WHERE cc.class_id = cl.id AND cc.active) AS held
         FROM classes cl JOIN courts c ON c.id = cl.court_id JOIN venues v ON v.id = c.venue_id
        WHERE cl.status = 'scheduled' AND cl.coach_id IS NOT NULL AND cl.date >= ?${venueIds ? ` AND v.id IN (${venueIds.map(() => "?").join(",")})` : ""}
        ORDER BY cl.date, cl.start_min, cl.id`
    )
    .all(todayISO(), ...(venueIds ?? []))) as {
    id: number; name: string; date: string; start_min: number; end_min: number; coach_id: number; venue_id: number; venue_name: string; held: boolean;
  }[];
  const coaches = new Map<number, Coach | null>();
  const out: ClassCoachConflict[] = [];
  for (const r of rows) {
    if (!coaches.has(r.coach_id)) coaches.set(r.coach_id, await coachById(r.coach_id));
    const coach = coaches.get(r.coach_id) ?? null;
    const reasons: CoachConflictReason[] = [];
    if (!coach || !coach.active) reasons.push("inactive");
    if (coach) {
      const off = coach.timeOff.some((o) => r.date >= o.from && r.date <= o.until);
      if (off) reasons.push("time_off");
      else if (!coachWorks(coach, r.date, { start: r.start_min, end: r.end_min })) reasons.push("outside_hours");
    }
    if (!r.held) reasons.push("not_held");
    if (reasons.length > 0)
      out.push({
        classId: r.id, name: r.name, date: r.date, startMin: r.start_min, endMin: r.end_min, venueId: r.venue_id, venueName: r.venue_name,
        coachId: r.coach_id, coachName: coach?.name ?? "", reasons,
      });
  }
  return out;
}
