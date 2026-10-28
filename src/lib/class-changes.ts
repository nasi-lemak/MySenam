import { getDb, withTransaction } from "./db";
import { refuse } from "./entitlements";
import { instantOf } from "./interval";
import { isAmount, money, roundMoney } from "./region";
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
 *
 * A session that has started, or is cancelled, is not changed; with
 * `series`, the later sessions of the series that have not started are
 * changed too, all or none.
 */
export interface ClassChange {
  name?: unknown;
  instructor?: unknown;
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
  const instructor = change.instructor === undefined ? undefined : typeof change.instructor === "string" ? change.instructor.trim() : "";
  if (instructor !== undefined && (instructor.length < 2 || instructor.length > 100)) return { ok: false, error: "Instructor name is required." };
  const capacity = change.capacity === undefined ? undefined : Number(change.capacity);
  if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1)) return { ok: false, error: "Capacity must be at least 1." };
  if (change.price !== undefined && !isAmount(change.price)) return { ok: false, error: `Price must be ${money(0)} or more.` };
  const price = change.price === undefined ? undefined : roundMoney(change.price as number);
  if (name === undefined && instructor === undefined && capacity === undefined && price === undefined)
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
        await db
          .prepare("UPDATE classes SET name = ?, instructor = ?, capacity = ?, price = ? WHERE id = ?")
          .run(name ?? before.name, instructor ?? before.instructor, capacity ?? before.capacity, price ?? before.price, id);
        out.push({ before, after: (await getClass(id))! });
      }
      return out;
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    throw err;
  }

  // New places go to whoever waits, through the waiting list's own offer (told by the outbox's sweep).
  let offered = 0;
  for (const c of changed) if (c.after.capacity > c.before.capacity && (await offerClassPlace(c.after.id))) offered++;
  return { ok: true, changed, offered };
}

/** The change in words, for the activity log: what was, and what is. */
export function classChangeDetail(changed: { before: ClassSession; after: ClassSession }[]): string {
  const first = changed[0];
  if (!first) return "";
  const { before, after } = first;
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`name ${before.name} → ${after.name}`);
  if (before.instructor !== after.instructor) parts.push(`instructor ${before.instructor} → ${after.instructor}`);
  if (before.capacity !== after.capacity) parts.push(`places ${before.capacity} → ${after.capacity}`);
  if (before.price !== after.price) parts.push(`price ${money(before.price)} → ${money(after.price)} (new enrolments)`);
  const sessions = changed.length > 1 ? `, ${changed.length} sessions from ${before.date}` : `, ${before.date}`;
  return `${before.name}${sessions}: ${parts.join("; ") || "no change"}`;
}
