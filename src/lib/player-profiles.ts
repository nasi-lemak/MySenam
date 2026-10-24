import { getDb } from "./db";
import { readPoint } from "./geo";

/**
 * How a player likes to play, as far as finding them a game needs: an area
 * and an approximate point, how far they will go, the days and parts of the
 * day that suit them, casual or competitive, and the most they would pay as
 * a share. Their level in each sport is kept apart, sport by sport
 * (player_levels, lib/games.ts).
 *
 * Everything here is what the player says, and nothing checks it — their
 * age included, which is recorded as declared and never as verified. The
 * point is rounded to two decimal places (about a kilometre) before it is
 * kept, so nobody's address is; and nobody else ever sees it, only a
 * distance band worked out from it.
 *
 * Being found is opt-in: `discoverable` lets hosts see them among the
 * players suggested for a game, and only somebody who has declared they are
 * 18 or over can switch it on. `invitable` lets any host invite them, not
 * only hosts they have played with or share a group with.
 */

export const DAY_PARTS = ["morning", "afternoon", "evening"] as const;
export type DayPart = (typeof DAY_PARTS)[number];
export const INTENSITIES = ["casual", "competitive", "any"] as const;
export type Intensity = (typeof INTENSITIES)[number];
export const MATCH_NOTICES = ["none", "digest", "each"] as const;
export type MatchNotice = (typeof MATCH_NOTICES)[number];

/** Which part of the day an hour falls in: before noon, before five, after. */
export function dayPart(hour: number): DayPart {
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

export interface PlayerProfile {
  area: string | null;
  /** Rounded to about a kilometre; shown back only to its owner. */
  near: { lat: number; lng: number } | null;
  maxKm: number;
  /** 0 Sunday … 6 Saturday; empty for no preference. */
  days: number[];
  times: DayPart[];
  intensity: Intensity;
  maxShare: number | null;
  discoverable: boolean;
  invitable: boolean;
  /** Declared 18 or over (true), under 18 (false), or not said (null). Not verified. */
  adult: boolean | null;
  notifyMatches: MatchNotice;
}

export const DEFAULT_PROFILE: PlayerProfile = {
  area: null,
  near: null,
  maxKm: 10,
  days: [],
  times: [],
  intensity: "any",
  maxShare: null,
  discoverable: false,
  invitable: false,
  adult: null,
  notifyMatches: "digest",
};

export interface ProfileRow {
  user_id: number;
  area: string | null;
  near_lat: string | number | null;
  near_lng: string | number | null;
  max_km: number;
  days: string | null;
  times: string | null;
  intensity: Intensity;
  max_share: string | number | null;
  discoverable: number;
  invitable: number;
  adult: number | null;
  notify_matches: MatchNotice;
}

export function toProfile(r: ProfileRow | undefined): PlayerProfile {
  if (!r) return { ...DEFAULT_PROFILE };
  return {
    area: r.area,
    near: r.near_lat !== null && r.near_lng !== null ? { lat: Number(r.near_lat), lng: Number(r.near_lng) } : null,
    maxKm: r.max_km,
    days: r.days ? r.days.split(",").map(Number) : [],
    times: r.times ? (r.times.split(",") as DayPart[]) : [],
    intensity: r.intensity,
    maxShare: r.max_share === null ? null : Number(r.max_share),
    discoverable: r.discoverable === 1,
    invitable: r.invitable === 1,
    adult: r.adult === null ? null : r.adult === 1,
    notifyMatches: r.notify_matches,
  };
}

export async function playerProfile(userId: number): Promise<PlayerProfile> {
  return toProfile((await getDb().prepare("SELECT * FROM player_profiles WHERE user_id = ?").get(userId)) as ProfileRow | undefined);
}

/** Whether they have said they are 18 or over. Their word, not checked. */
export async function declaredAdult(userId: number): Promise<boolean | null> {
  const row = (await getDb().prepare("SELECT adult FROM player_profiles WHERE user_id = ?").get(userId)) as { adult: number | null } | undefined;
  return row?.adult === undefined || row.adult === null ? null : row.adult === 1;
}

export type ProfileResult = { ok: true; profile: PlayerProfile } | { ok: false; error: string };

/** Change some of a profile; what is not given stays as it was. */
export async function saveProfile(userId: number, input: Partial<Record<keyof PlayerProfile, unknown>>): Promise<ProfileResult> {
  const next = { ...(await playerProfile(userId)) };
  if ("area" in input) {
    if (input.area !== null && typeof input.area !== "string") return { ok: false, error: "Which area?" };
    next.area = typeof input.area === "string" ? input.area.trim().slice(0, 80) || null : null;
  }
  if ("near" in input) {
    if (input.near === null) next.near = null;
    else {
      const near = input.near as { lat?: unknown; lng?: unknown } | undefined;
      const point = readPoint(near?.lat, near?.lng);
      if (!point || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return { ok: false, error: "That is not a place we can use." };
      next.near = { lat: Math.round(point.lat * 100) / 100, lng: Math.round(point.lng * 100) / 100 };
    }
  }
  if ("maxKm" in input) {
    const km = Number(input.maxKm);
    if (!Number.isInteger(km) || km < 1 || km > 100) return { ok: false, error: "How far: 1 to 100 km." };
    next.maxKm = km;
  }
  if ("days" in input) {
    if (!Array.isArray(input.days) || !input.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
      return { ok: false, error: "Days are 0 (Sunday) to 6 (Saturday)." };
    next.days = [...new Set(input.days as number[])].sort();
  }
  if ("times" in input) {
    if (!Array.isArray(input.times) || !input.times.every((t) => (DAY_PARTS as readonly unknown[]).includes(t)))
      return { ok: false, error: "Morning, afternoon or evening." };
    next.times = DAY_PARTS.filter((p) => (input.times as unknown[]).includes(p));
  }
  if ("intensity" in input) {
    if (!(INTENSITIES as readonly unknown[]).includes(input.intensity)) return { ok: false, error: "Casual, competitive or either." };
    next.intensity = input.intensity as Intensity;
  }
  if ("maxShare" in input) {
    if (input.maxShare === null) next.maxShare = null;
    else {
      const share = Number(input.maxShare);
      if (!Number.isFinite(share) || share < 0 || share > 10000) return { ok: false, error: "That is not an amount." };
      next.maxShare = Math.round(share * 100) / 100;
    }
  }
  if ("adult" in input) {
    if (input.adult !== null && typeof input.adult !== "boolean") return { ok: false, error: "Over 18, under 18, or not saying." };
    next.adult = input.adult as boolean | null;
  }
  if ("discoverable" in input) next.discoverable = input.discoverable === true;
  if ("invitable" in input) next.invitable = input.invitable === true;
  if ("notifyMatches" in input) {
    if (!(MATCH_NOTICES as readonly unknown[]).includes(input.notifyMatches)) return { ok: false, error: "Never, a daily digest, or each game." };
    next.notifyMatches = input.notifyMatches as MatchNotice;
  }
  // Being found by strangers, or invited by anybody, is for adults who say so.
  if (next.adult !== true && (next.discoverable || next.invitable))
    return { ok: false, error: "Only players who say they are 18 or over can be found or invited by other players." };

  await getDb()
    .prepare(
      `INSERT INTO player_profiles (user_id, area, near_lat, near_lng, max_km, days, times, intensity, max_share, discoverable, invitable, adult, notify_matches)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET area = excluded.area, near_lat = excluded.near_lat, near_lng = excluded.near_lng,
         max_km = excluded.max_km, days = excluded.days, times = excluded.times, intensity = excluded.intensity,
         max_share = excluded.max_share, discoverable = excluded.discoverable, invitable = excluded.invitable,
         adult = excluded.adult, notify_matches = excluded.notify_matches, updated_at = datetime('now')`
    )
    .run(
      userId,
      next.area,
      next.near?.lat ?? null,
      next.near?.lng ?? null,
      next.maxKm,
      next.days.length ? next.days.join(",") : null,
      next.times.length ? next.times.join(",") : null,
      next.intensity,
      next.maxShare,
      next.discoverable ? 1 : 0,
      next.invitable ? 1 : 0,
      next.adult === null ? null : next.adult ? 1 : 0,
      next.notifyMatches
    );
  return { ok: true, profile: next };
}
