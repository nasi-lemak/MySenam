import { CoachHeld, coachTeachingRefusal, holdCoach } from "./class-coaches";
import { coachById } from "./coaching";
import { coachLocale } from "./coach-schedule";
import { getDb, withTransaction } from "./db";
import { refuse } from "./entitlements";
import { instantOf } from "./interval";
import { notifyClassChanged } from "./notify";
import { enqueue } from "./outbox";
import { clockRange, isAmount, money, roundMoney } from "./region";
import { classOfferHolds, getClass, getCourt, offerClassPlace, venueHours } from "./store";
import type { ClassSession, Refusal } from "./types";

/**
 * Changing a class after it is in the diary (lib/store.ts schedules and
 * cancels them): its name, instructor, places and price, for one session or
 * for it and the rest of its weekly series.
 *
 * - **Places up** (to the room's own capacity): the new places go to the
 *   waiting list through the existing offer path (`offerClassPlace`), one
 *   offer at a time, as a cancelled enrolment's place does.
 * - **Places down**: never below the people enrolled and the places held by
 *   live waiting-list offers. Counted under the class's row lock, the lock
 *   every enrolment takes, so a place cannot be taken while it is counted.
 * - **Price**: for enrolments made from now on. Each enrolment carries the
 *   price it was made at (`bookings.total_price`), so nothing already
 *   enrolled, paid or not, is repriced.
 * - **Name or instructor**: those enrolled in a session changed, and those
 *   holding a live offer of a place in one, are told by email, once per
 *   change (lib/notify.ts `notifyClassChanged`). A price or places change
 *   tells nobody: it changes nothing anybody signed up for.
 * - **The instructor as a coach of the venue** (`coachId`, lib/class-coaches.ts):
 *   the coach is checked as a lesson's coach is (the venue's, active, coaching
 *   the activity, working then, in nothing else) and held for every session
 *   changed, all or none; `coachId: null`, or a typed instructor name in its
 *   place, makes it a name only again.
 *
 * A session that has started, or is cancelled, is not changed; with
 * `series`, the later sessions of the series that have not started are
 * changed too, all or none.
 */
export interface ClassChange {
  name?: unknown;
  instructor?: unknown;
  /** One of the venue's coaches as the instructor (a number), or null for a name only (lib/class-coaches.ts). */
  coachId?: unknown;
  capacity?: unknown;
  price?: unknown;
  /** This session and every later one in its series that has not started. */
  series?: unknown;
}

export type ClassChangeResult =
  | {
      ok: true;
      /** As each was before and is now, in date order. */
      changed: { before: ClassSession; after: ClassSession }[];
      /** Sessions whose new places were offered to their waiting list. */
      offered: number;
      /** Emails written to those enrolled or offered a place, of a new name or instructor. */
      told: number;
    }
  | Refusal;

const startedAlready = async (c: ClassSession) =>
  instantOf(c.date, c.startMin, (await venueHours(c.venueId)).zone).getTime() <= Date.now();

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super("CLASS_CHANGE_REFUSED");
  }
}

export async function changeClass(classId: number, change: ClassChange): Promise<ClassChangeResult> {
  const session = await getClass(classId);
  if (!session) return refuse("CLASS_NOT_FOUND");
  if (session.status === "cancelled") return refuse("CLASS_CANCELLED");
  if (await startedAlready(session)) return refuse("CLASS_STARTED");

  const name = change.name === undefined ? undefined : typeof change.name === "string" ? change.name.trim() : "";
  if (name !== undefined && (name.length < 2 || name.length > 100)) return { ok: false, error: "Class name is required." };
  let instructor = change.instructor === undefined ? undefined : typeof change.instructor === "string" ? change.instructor.trim() : "";
  if (instructor !== undefined && (instructor.length < 2 || instructor.length > 100)) return { ok: false, error: "Instructor name is required." };
  const capacity = change.capacity === undefined ? undefined : Number(change.capacity);
  if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1)) return { ok: false, error: "Capacity must be at least 1." };
  if (change.price !== undefined && !isAmount(change.price)) return { ok: false, error: `Price must be ${money(0)} or more.` };
  const price = change.price === undefined ? undefined : roundMoney(change.price as number);
  // The instructor as a coach: a coach's id, null for a name only; a typed name (other than the coach's own) is a name only too.
  if (change.coachId !== undefined && change.coachId !== null && (typeof change.coachId !== "number" || !Number.isInteger(change.coachId) || change.coachId <= 0))
    return { ok: false, error: "Choose one of the venue's coaches." };
  const coach = typeof change.coachId === "number" ? await coachById(change.coachId) : null;
  if (typeof change.coachId === "number" && (!coach || coach.venueId !== session.venueId)) return refuse("COACH_NOT_FOUND");
  /** `undefined`: the coach is left as it is; a coach; or null: a name only. */
  let newCoach: number | null | undefined = change.coachId === undefined ? undefined : (coach?.id ?? null);
  const newInstructor = coach ? coach.name : instructor;
  if (newCoach === undefined && instructor !== undefined && session.coachId != null && instructor !== session.instructor) newCoach = null;
  if (newCoach === undefined && instructor !== undefined && session.coachId != null && instructor === session.instructor) instructor = undefined;
  if (name === undefined && instructor === undefined && capacity === undefined && price === undefined && newCoach === undefined)
    return { ok: false, error: "Nothing to change." };
  const court = await getCourt(session.courtId);
  if (capacity !== undefined && court && capacity > court.capacity)
    return { ok: false, error: `Capacity must be 1–${court.capacity}, the capacity of ${court.name}.` };

  // This one, and with `series` every later session of its series still to come.
  const ids = [session.id];
  if (change.series === true && session.seriesCode) {
    const later = (await getDb()
      .prepare("SELECT id FROM classes WHERE series_code = ? AND status = 'scheduled' AND id <> ? AND (date > ? OR (date = ? AND start_min > ?)) ORDER BY date, start_min")
      .all(session.seriesCode, session.id, session.date, session.date, session.startMin)) as { id: number }[];
    for (const r of later) {
      const c = await getClass(r.id);
      if (c && !(await startedAlready(c))) ids.push(r.id);
    }
  }

  const zone = (await venueHours(session.venueId)).zone;
  // A coach: working through every session and free for it (their own held sessions here do not count against them), before anything is written.
  const sessions = (await Promise.all(ids.map((id) => getClass(id)))).filter((c): c is ClassSession => c !== null);
  if (coach) {
    const why = await coachTeachingRefusal(
      coach.id,
      session.venueId,
      session.sport,
      sessions.map((c) => ({ date: c.date, startMin: c.startMin, endMin: c.endMin })),
      zone,
      ids
    );
    if (why) return why;
  }

  let changed: { before: ClassSession; after: ClassSession }[];
  try {
    changed = await withTransaction(async () => {
      const out: { before: ClassSession; after: ClassSession }[] = [];
      const db = getDb();
      for (const id of ids) {
        // The lock every enrolment takes while it counts places (lib/store.ts `enrolPeopleOnce`).
        await db.prepare("SELECT id FROM classes WHERE id = ? FOR UPDATE").get(id);
        const before = (await getClass(id))!;
        if (before.status === "cancelled") throw new Refused(refuse("CLASS_CANCELLED"));
        if (capacity !== undefined && capacity < before.capacity) {
          const taken = before.enrolled + (await classOfferHolds(id));
          if (capacity < taken)
            throw new Refused({
              ok: false,
              error: `${before.date}: ${taken} place(s) are taken or offered; the class cannot have fewer than that.`,
            });
        }
        // The typed name behind a coach is the coach's own name, so it reads right if the class is made a name only again.
        await db
          .prepare("UPDATE classes SET name = ?, instructor = ?, capacity = ?, price = ?, coach_id = ? WHERE id = ?")
          .run(
            name ?? before.name,
            newInstructor ?? before.instructor,
            capacity ?? before.capacity,
            price ?? before.price,
            newCoach === undefined ? (before.coachId ?? null) : newCoach,
            id
          );
        if (newCoach === null) await db.prepare("DELETE FROM coach_claims WHERE class_id = ?").run(id);
        else if (newCoach !== undefined) await holdCoach(id, newCoach, { date: before.date, startMin: before.startMin, endMin: before.endMin }, zone);
        out.push({ before, after: (await getClass(id))! });
      }
      return out;
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    if (err instanceof CoachHeld) return err.refusal;
    throw err;
  }

  // New places go to whoever waits, through the waiting list's own offer (told by the outbox's sweep).
  let offered = 0;
  for (const c of changed) if (c.after.capacity > c.before.capacity && (await offerClassPlace(c.after.id))) offered++;
  // A new name or instructor is told to those enrolled and those offered a place, once (lib/notify.ts).
  const told = await notifyClassChanged(changed);
  // The coach who stops teaching it, and the one who starts, are told too (ADR 0060).
  await notifyCoachesOfChange(changed);
  return { ok: true, changed, offered, told };
}

/**
 * A change of the instructor as one of the venue's coaches (`coachId`): the coach who no longer teaches the changed sessions and
 * the coach who now does are each told once, by email in their own language where the venue has their address (`coach_lesson`, as a
 * class moved is told): the first session and how many. A name or price change, or a coach left as it was, tells no coach.
 * Returns how many emails were written.
 */
async function notifyCoachesOfChange(changed: { before: ClassSession; after: ClassSession }[]): Promise<number> {
  const first = changed[0];
  if (!first) return 0;
  const change = `${first.after.id}:${Date.now()}`;
  const moved = changed.filter((c) => (c.before.coachId ?? null) !== (c.after.coachId ?? null));
  const tell: { coachId: number; how: "Lost" | "Gained"; sessions: ClassSession[] }[] = [];
  for (const c of moved) {
    for (const [coachId, how, session] of [
      [c.before.coachId, "Lost", c.before],
      [c.after.coachId, "Gained", c.after],
    ] as const) {
      if (!coachId) continue;
      const known = tell.find((t) => t.coachId === coachId && t.how === how);
      if (known) known.sessions.push(session);
      else tell.push({ coachId, how, sessions: [session] });
    }
  }
  let written = 0;
  for (const { coachId, how, sessions } of tell) {
    const coach = await coachById(coachId);
    const row = (await getDb().prepare("SELECT email, locale FROM coaches WHERE id = ?").get(coachId)) as { email: string | null; locale: string | null } | undefined;
    if (!coach || !row?.email?.trim()) continue;
    const locale = coachLocale(row.locale);
    const at = sessions[0];
    const venue = (await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(at.venueId)) as { name: string } | undefined;
    await enqueue({
      venueId: at.venueId,
      bookingId: null,
      kind: "coach_lesson",
      channel: "email",
      recipient: row.email.trim(),
      locale,
      subject: `fx2.msg.coachClass${how}Subject`,
      body: `fx2.msg.coachClass${how}`,
      dedupeKey: `classcoach:${change}:${coachId}:${how}`,
      vars: {
        name: coach.name.split(/\s+/)[0],
        class: at.name,
        venue: venue?.name ?? "",
        n: String(sessions.length),
        date: at.date,
        time: clockRange(at.startMin, at.endMin, locale),
        court: at.courtName,
      },
    });
    written++;
  }
  return written;
}

/** The change in words, for the activity log: what was, and what is. */
export function classChangeDetail(changed: { before: ClassSession; after: ClassSession }[]): string {
  const first = changed[0];
  if (!first) return "";
  const { before, after } = first;
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`name ${before.name} → ${after.name}`);
  if (before.instructor !== after.instructor) parts.push(`instructor ${before.instructor} → ${after.instructor}`);
  if ((before.coachId ?? null) !== (after.coachId ?? null))
    parts.push(after.coachId ? `instructor is the venue's coach ${after.instructor}` : `instructor ${after.instructor} is a name only, no longer a coach`);
  if (before.capacity !== after.capacity) parts.push(`places ${before.capacity} → ${after.capacity}`);
  if (before.price !== after.price) parts.push(`price ${money(before.price)} → ${money(after.price)} (new enrolments)`);
  const sessions = changed.length > 1 ? `, ${changed.length} sessions from ${before.date}` : `, ${before.date}`;
  return `${before.name}${sessions}: ${parts.join("; ") || "no change"}`;
}
