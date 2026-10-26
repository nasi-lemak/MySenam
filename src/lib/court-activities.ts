import { activityKeys } from "./activity-registry";
import { DEFAULT_MAX_PLAYERS, MAX_PLAYERS, type Court, type Sport } from "./types";

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

/**
 * The most a venue may let one booking take here: every place of a resource
 * with places (a fleet of 20 kayaks may go to one group), or MAX_PLAYERS on a
 * court priced per player. Unset, it is DEFAULT_MAX_PLAYERS (or the places,
 * if fewer).
 */
export function mostPerBookingAllowed(capacity: number): number {
  return capacity > 1 ? capacity : MAX_PLAYERS;
}

/**
 * Items listed with kinds of the same thing under one heading (lib/resources.ts
 * `setCourtHeading`): those sharing a heading (whatever its capitals) together,
 * where the first of them comes; the rest each on their own, in their order.
 */
export function groupByHeading<T>(items: T[], headingOf: (item: T) => string | null | undefined): { heading: string | null; items: T[] }[] {
  const groups: { heading: string | null; items: T[] }[] = [];
  const byKey = new Map<string, { heading: string | null; items: T[] }>();
  for (const item of items) {
    const heading = headingOf(item)?.trim() || null;
    if (heading === null) {
      groups.push({ heading: null, items: [item] });
      continue;
    }
    const group = byKey.get(heading.toLowerCase());
    if (group) group.items.push(item);
    else {
      const made = { heading, items: [item] };
      byKey.set(heading.toLowerCase(), made);
      groups.push(made);
    }
  }
  return groups;
}

/**
 * What a resource's booking rules ask of a customer before they may book it
 * (lib/sign-offs.ts): a recorded certification, a staff sign-off, or nothing.
 * Shown beside it in search and on the venue's grid; the booking itself is
 * where it is enforced.
 */
export type KindNeeds = "signOff" | "certification" | null;

export function needsOf(policy: { signOff?: boolean; certification?: boolean }): KindNeeds {
  return policy.certification ? "certification" : policy.signOff ? "signOff" : null;
}

/** A day's rows as shown: grouped by heading, `heading` on the first of each group, `under` on all of one. */
export function headedRows<R extends { court: Pick<Court, "heading"> }>(rows: R[]): (R & { heading: string | null; under: boolean })[] {
  return groupByHeading(rows, (r) => r.court.heading).flatMap((g) =>
    g.items.map((r, i) => ({ ...r, heading: i === 0 ? g.heading : null, under: g.heading !== null }))
  );
}

/** Players an open game looks for, at most, unless the court lets one booking take more. */
export const OPEN_GAME_SPOTS = 10;

/**
 * The most players an open game on a booking here can look for: ten, or as
 * many more as the venue lets one booking take, less the host, who plays too.
 */
export function mostSpots(court: Pick<Court, "capacity" | "perPlayer" | "maxPlayers">): number {
  return Math.max(OPEN_GAME_SPOTS, placesPerBooking(court) - 1);
}
