import { getDb } from "./db";
import { MAX_CANCEL_CUTOFF_HOURS, SPORTS, type Sport } from "./types";

/**
 * Rules for one sport at a venue, over the venue's own: tennis cancelled a
 * day ahead while badminton is two hours, futsal keeping all of a late
 * cancellation, pickleball's peak starting at 5 PM, padel sold by the half hour
 * in a hall selling hours. Anything not set is the venue's (null here). Read
 * where the rule is applied: the cancellation cutoff (lib/store.ts), the
 * late-cancel share (lib/cancel-policy.ts `cancelPolicyFor`), the peak window
 * (lib/time.ts `forSport`), and what the sport is sold by (lib/store.ts
 * `unitFor`).
 */

export interface SportPeak {
  weekdayFrom: number;
  weekdayUntil: number;
  weekendFrom: number;
  weekendUntil: number;
}

export interface SportRules {
  sport: Sport;
  /** Hours before the start a customer may cancel for free. */
  cutoffHours: number | null;
  /** Percent kept on a late online cancellation; "none" for no cancelling online after the cutoff. */
  lateKeep: number | "none" | null;
  peak: SportPeak | null;
  /** What it is sold by here: 60 (from the hour, in hours) or 30 (from any half hour). */
  slotMinutes: 30 | 60 | null;
}

interface Row {
  sport: Sport;
  cancel_cutoff_hours: number | null;
  late_keep: number | null;
  peak_weekday_from: number | null;
  peak_weekday_until: number | null;
  peak_weekend_from: number | null;
  peak_weekend_until: number | null;
  slot_minutes: number | null;
}

const toRules = (r: Row): SportRules => ({
  sport: r.sport,
  cutoffHours: r.cancel_cutoff_hours,
  lateKeep: r.late_keep === null ? null : r.late_keep === -1 ? "none" : r.late_keep,
  peak:
    r.peak_weekday_from === null || r.peak_weekday_until === null || r.peak_weekend_from === null || r.peak_weekend_until === null
      ? null
      : { weekdayFrom: r.peak_weekday_from, weekdayUntil: r.peak_weekday_until, weekendFrom: r.peak_weekend_from, weekendUntil: r.peak_weekend_until },
  slotMinutes: r.slot_minutes === 30 || r.slot_minutes === 60 ? r.slot_minutes : null,
});

export async function sportRules(venueId: number): Promise<SportRules[]> {
  const rows = (await getDb().prepare("SELECT * FROM sport_rules WHERE venue_id = ? ORDER BY sport").all(venueId)) as Row[];
  return rows.map(toRules);
}

export async function sportRule(venueId: number, sport: Sport): Promise<SportRules | null> {
  const row = (await getDb().prepare("SELECT * FROM sport_rules WHERE venue_id = ? AND sport = ?").get(venueId, sport)) as Row | undefined;
  return row ? toRules(row) : null;
}

/** The peak windows of several venues' sports, for the pricing rules (lib/peak.ts). */
export async function sportPeaks(venueIds: number[]): Promise<Map<number, Record<string, SportPeak>>> {
  const out = new Map<number, Record<string, SportPeak>>();
  if (venueIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT venue_id, sport, peak_weekday_from, peak_weekday_until, peak_weekend_from, peak_weekend_until FROM sport_rules
        WHERE venue_id IN (${venueIds.map(() => "?").join(",")}) AND peak_weekday_from IS NOT NULL`
    )
    .all(...venueIds)) as (Row & { venue_id: number })[];
  for (const r of rows) {
    const peak = toRules(r).peak;
    if (!peak) continue;
    out.set(r.venue_id, { ...(out.get(r.venue_id) ?? {}), [r.sport]: peak });
  }
  return out;
}

const isHour = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 24;

/** Set one sport's rules; each null for the venue's. All null: the sport goes back to the venue's rules. */
export async function setSportRules(
  venueId: number,
  sport: unknown,
  input: { cutoffHours?: unknown; lateKeep?: unknown; peak?: unknown; slotMinutes?: unknown }
): Promise<{ ok: true; rules: SportRules | null } | { ok: false; error: string }> {
  if (!SPORTS.includes(sport as Sport)) return { ok: false, error: "Unknown sport." };
  const cutoff = input.cutoffHours ?? null;
  if (cutoff !== null && (!Number.isInteger(cutoff) || (cutoff as number) < 0 || (cutoff as number) > MAX_CANCEL_CUTOFF_HOURS))
    return { ok: false, error: `Free cancellation up to 0 to ${MAX_CANCEL_CUTOFF_HOURS} hours before, or the venue's.` };
  const keep = input.lateKeep ?? null;
  if (keep !== null && keep !== "none" && (!Number.isInteger(keep) || (keep as number) < 0 || (keep as number) > 100))
    return { ok: false, error: "Keep 0 to 100 percent of a late cancellation, no cancelling online, or the venue's." };
  const peak = (input.peak ?? null) as Record<string, unknown> | null;
  if (
    peak !== null &&
    !(["weekdayFrom", "weekdayUntil", "weekendFrom", "weekendUntil"] as const).every((k) => isHour(peak[k]))
  )
    return { ok: false, error: "Give the peak hours as whole hours, 0 to 24, or the venue's." };
  if (peak !== null && ((peak.weekdayFrom as number) > (peak.weekdayUntil as number) || (peak.weekendFrom as number) > (peak.weekendUntil as number)))
    return { ok: false, error: "Peak ends before it starts." };
  const minutes = input.slotMinutes ?? null;
  if (minutes !== null && minutes !== 30 && minutes !== 60) return { ok: false, error: "Sold by the hour (60), the half hour (30), or the venue's." };
  const db = getDb();
  if (cutoff === null && keep === null && peak === null && minutes === null) {
    await db.prepare("DELETE FROM sport_rules WHERE venue_id = ? AND sport = ?").run(venueId, sport);
    return { ok: true, rules: null };
  }
  await db
    .prepare(
      `INSERT INTO sport_rules (venue_id, sport, cancel_cutoff_hours, late_keep, peak_weekday_from, peak_weekday_until, peak_weekend_from, peak_weekend_until, slot_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, sport) DO UPDATE SET cancel_cutoff_hours = excluded.cancel_cutoff_hours, late_keep = excluded.late_keep,
         peak_weekday_from = excluded.peak_weekday_from, peak_weekday_until = excluded.peak_weekday_until,
         peak_weekend_from = excluded.peak_weekend_from, peak_weekend_until = excluded.peak_weekend_until,
         slot_minutes = excluded.slot_minutes`
    )
    .run(
      venueId,
      sport,
      cutoff,
      keep === "none" ? -1 : keep,
      peak?.weekdayFrom ?? null,
      peak?.weekdayUntil ?? null,
      peak?.weekendFrom ?? null,
      peak?.weekendUntil ?? null,
      minutes
    );
  return { ok: true, rules: await sportRule(venueId, sport as Sport) };
}

/** Free cancellation for this sport here: its own, or the venue's. */
export async function cutoffFor(venueId: number, sport: Sport, venueCutoff: number): Promise<number> {
  return (await sportRule(venueId, sport))?.cutoffHours ?? venueCutoff;
}
