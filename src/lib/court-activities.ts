import { activityKeys } from "./activity-registry";
import { DEFAULT_MAX_PLAYERS, type Court, type Sport } from "./types";

/**
 * What a court can be booked for (ADR 0011): one or more activities, each at
 * its own rates where it has them. Browser-safe.
 */

/**
 * A court as offered for one of its activities: that activity, at its own
 * rates where it has them. Everything that depends on what is played (the
 * booking rules, peak hours, prices, passes) reads the court through this.
 */
export function courtFor(court: Court, sport: Sport = court.sport): Court {
  const own = court.activities.find((a) => a.sport === sport);
  if (sport === court.sport && (own?.offPeakRate ?? null) === null) return court;
  return {
    ...court,
    sport,
    offPeakRate: own?.offPeakRate ?? court.offPeakRate,
    peakRate: own?.peakRate ?? court.peakRate,
  };
}

/** Can this court be booked for this activity? */
export function courtOffers(court: Pick<Court, "sport" | "activities">, sport: Sport): boolean {
  return court.sport === sport || court.activities.some((a) => a.sport === sport);
}

/** Every activity a court offers, the main one first. */
export function courtSports(court: Pick<Court, "sport" | "activities">): Sport[] {
  return [court.sport, ...court.activities.map((a) => a.sport).filter((s) => s !== court.sport)];
}

/** Each court once for every activity it offers, as offered for it: what a venue sells. */
export function offeredCourts(courts: Court[]): Court[] {
  return courts.flatMap((c) => courtSports(c).map((s) => courtFor(c, s)));
}

/** The activities offered across these courts, in the catalogue's order (others after). */
export function sportsOf(courts: Pick<Court, "sport" | "activities">[]): Sport[] {
  const here = new Set(courts.flatMap(courtSports));
  const known = activityKeys();
  return [...known.filter((s) => here.has(s)), ...[...here].filter((s) => !known.includes(s)).sort()];
}

/**
 * How many one booking can be for: on a shared facility (a gym floor, a fleet
 * of kayaks) one place per person or per item hired, up to its places; on a
 * court priced per player, how many play; anywhere else one booking, whoever
 * plays.
 */
export function placesPerBooking(court: Pick<Court, "capacity" | "perPlayer" | "maxPlayers">): number {
  const most = court.maxPlayers ?? DEFAULT_MAX_PLAYERS;
  if (court.capacity > 1) return Math.min(most, court.capacity);
  return court.perPlayer ? most : 1;
}
