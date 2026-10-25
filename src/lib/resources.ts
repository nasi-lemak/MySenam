import { venueMayOffer } from "./activities";
import { activity, activityName } from "./activity-registry";
import { RESOURCE_NOUNS, type ActivityTemplate } from "./activity-catalogue";
import { courtSports, mostPerBookingAllowed } from "./court-activities";
import { getDb, withTransaction } from "./db";
import { isAmount } from "./region";
import { createCourt, getCourt } from "./store";
import { MAX_CAPACITY, MAX_DEPOSIT, type Court, type Sport } from "./types";

/**
 * Resources and what they are booked for (ADR 0011): making them from an
 * activity's template ("8 lanes", "2 bays"), and the activities each one
 * offers, at their own rates. The booking engine books any of them the same
 * way: a court is held by its spaces, a shared facility by its places.
 */

const MAX_RATE = 1000;
/** The most made at once. */
export const MAX_BATCH = 20;

/** What a new resource for an activity starts as: its template, for the form. */
export function templateFor(sport: Sport): ActivityTemplate {
  return activity(sport).template;
}

export interface NewResources {
  venueId: number;
  sport: Sport;
  /** How many to make: "Lane 1" to "Lane 8", numbered on from any already there. */
  count?: number;
  /** Or the name of the one made. */
  name?: string;
  noun?: string;
  offPeakRate: number;
  peakRate: number;
  capacity?: number;
  deposit?: number;
  perPlayer?: boolean;
  maxPlayers?: number | null;
  /** Run as classes only (customers book its classes, not the room); a class activity's rooms are unless said. */
  classesOnly?: boolean;
  /** Indoor or outdoor, for search's filters; the activity's usual one unless given (null: neither said). */
  setting?: "indoor" | "outdoor" | null;
  /** More activities it can also be booked for, at the court's rates unless given. */
  also?: { sport: Sport; offPeakRate?: number | null; peakRate?: number | null }[];
}

/**
 * Make one or more resources for an activity, all or none. Each is an
 * ordinary court to the engine: one held whole, or places on a shared one.
 */
export async function createResources(input: NewResources): Promise<{ ok: true; courts: Court[] } | { ok: false; error: string }> {
  if (!(await venueMayOffer(input.venueId, input.sport))) return { ok: false, error: "Unknown sport." };
  const a = activity(input.sport);
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) return { ok: false, error: `Make 1 to ${MAX_BATCH} at a time.` };
  const noun = input.noun ?? a.template.noun;
  if (!(RESOURCE_NOUNS as readonly string[]).includes(noun)) return { ok: false, error: "Choose what one of them is called." };
  for (const r of [input.offPeakRate, input.peakRate])
    if (!isAmount(r, 0, MAX_RATE)) return { ok: false, error: `Rates are 0 to ${MAX_RATE}.` };
  const capacity = input.capacity ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) return { ok: false, error: `Capacity must be 1–${MAX_CAPACITY}.` };
  if (input.deposit !== undefined && !isAmount(input.deposit, 0, MAX_DEPOSIT)) return { ok: false, error: `A deposit must be 0–${MAX_DEPOSIT}.` };
  // Up to every place a resource with places has (a fleet hired whole), or MAX_PLAYERS on a court priced per player.
  const maxPlayers = input.maxPlayers ?? null;
  const most = mostPerBookingAllowed(capacity);
  if (maxPlayers !== null && (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > most))
    return { ok: false, error: `Up to 1 to ${most} in one booking.` };
  const setting = input.setting === undefined ? a.template.setting : input.setting;
  if (setting !== null && setting !== "indoor" && setting !== "outdoor") return { ok: false, error: "Indoor, outdoor or neither." };
  const also = input.also ?? [];
  for (const extra of also) {
    const checked = await checkActivity(input.venueId, extra);
    if (checked) return { ok: false, error: checked };
  }
  const name = input.name?.trim();
  if (count === 1 && name !== undefined && name.length < 2) return { ok: false, error: "Court name is required." };

  // Numbered on from what is there: a second batch of lanes starts at Lane 9.
  const label = activityNounLabel(noun);
  const taken = (
    (await getDb().prepare("SELECT name FROM courts WHERE venue_id = ?").all(input.venueId)) as { name: string }[]
  ).map((r) => r.name);
  const pattern = new RegExp(`^${label} (\\d+)$`);
  let next = Math.max(0, ...taken.map((n) => Number(pattern.exec(n)?.[1] ?? 0))) + 1;

  const courts = await withTransaction(async () => {
    const made: Court[] = [];
    for (let i = 0; i < count; i++) {
      const created = await createCourt({
        venueId: input.venueId,
        name: count === 1 && name ? name : `${label} ${next++}`,
        sport: input.sport,
        offPeakRate: input.offPeakRate,
        peakRate: input.peakRate,
        capacity,
        deposit: input.deposit ?? 0,
      });
      if (!created.ok) throw new Error(created.error);
      const db = getDb();
      await db
        .prepare("UPDATE courts SET noun = ?, per_player = ?, max_players = ?, setting = ?, classes_only = ? WHERE id = ?")
        // Per player is for a court booked whole; with places, each place is already priced (lib/pricing.ts).
        .run(
          noun === a.template.noun ? null : noun,
          input.perPlayer && capacity === 1 ? 1 : 0,
          maxPlayers,
          setting,
          input.classesOnly ?? a.template.model === "class",
          created.court.id
        );
      for (const extra of also) await addActivity(created.court.id, extra);
      made.push((await getCourt(created.court.id))!);
    }
    return made;
  });
  return { ok: true, courts };
}

/** "Lane", "Bay", "Court": the English label new resources are numbered under. */
export function activityNounLabel(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

async function checkActivity(venueId: number, extra: { sport: Sport; offPeakRate?: number | null; peakRate?: number | null }): Promise<string | null> {
  if (typeof extra.sport !== "string" || !(await venueMayOffer(venueId, extra.sport))) return "Unknown sport.";
  const own = [extra.offPeakRate ?? null, extra.peakRate ?? null];
  if ((own[0] === null) !== (own[1] === null)) return "Give both rates for an activity, or neither.";
  for (const r of own) if (r !== null && !isAmount(r, 0, MAX_RATE)) return `Rates are 0 to ${MAX_RATE}.`;
  return null;
}

async function addActivity(courtId: number, extra: { sport: Sport; offPeakRate?: number | null; peakRate?: number | null }): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO court_activities (court_id, sport, off_peak_rate, peak_rate) VALUES (?, ?, ?, ?)
       ON CONFLICT (court_id, sport) DO UPDATE SET off_peak_rate = EXCLUDED.off_peak_rate, peak_rate = EXCLUDED.peak_rate`
    )
    .run(courtId, extra.sport, extra.offPeakRate ?? null, extra.peakRate ?? null);
}

/**
 * Set what a court can be booked for besides its main activity, each at the
 * court's rates or its own. An activity with bookings still to come on this
 * court cannot be taken off: those customers booked it for that.
 */
export async function setCourtActivities(
  courtId: number,
  list: { sport: Sport; offPeakRate?: number | null; peakRate?: number | null }[]
): Promise<{ ok: true; court: Court } | { ok: false; error: string }> {
  const court = await getCourt(courtId);
  if (!court) return { ok: false, error: "Court not found." };
  if (list.length > 12) return { ok: false, error: "A court offers up to 12 activities." };
  if (new Set(list.map((x) => x.sport)).size !== list.length) return { ok: false, error: "Each activity once." };
  for (const extra of list) {
    const checked = await checkActivity(court.venueId, extra);
    if (checked) return { ok: false, error: checked };
  }
  // A shared facility sells places; an activity on it is sold the same way, so any will do.
  const keep = new Set([court.sport, ...list.map((x) => x.sport)]);
  const dropping = courtSports(court).filter((s) => !keep.has(s));
  for (const sport of dropping) {
    const upcoming = (await getDb()
      .prepare(
        `SELECT b.date FROM bookings b
          WHERE b.court_id = ? AND b.sport = ? AND b.status = 'confirmed' AND b.ends_at > now()
          ORDER BY b.date LIMIT 1`
      )
      .get(courtId, sport)) as { date: string } | undefined;
    if (upcoming)
      return { ok: false, error: `${activityName(sport)} is booked on ${court.name} on ${upcoming.date}. Move or cancel those bookings first.` };
  }
  await withTransaction(async () => {
    const db = getDb();
    for (const sport of dropping) await db.prepare("DELETE FROM court_activities WHERE court_id = ? AND sport = ?").run(courtId, sport);
    for (const [i, extra] of list.entries()) {
      // The main activity's rates are the court's own.
      if (extra.sport === court.sport) continue;
      await addActivity(courtId, extra);
      await db.prepare("UPDATE court_activities SET position = ? WHERE court_id = ? AND sport = ?").run(i + 1, courtId, extra.sport);
    }
  });
  return { ok: true, court: (await getCourt(courtId))! };
}

/** What one of a court is called ("lane", "bay"); null: what its activity's resources are. */
export async function setCourtNoun(courtId: number, noun: string | null): Promise<void> {
  await getDb().prepare("UPDATE courts SET noun = ? WHERE id = ?").run(noun, courtId);
}
