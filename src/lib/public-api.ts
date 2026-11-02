import { apiBooking, apiParticipants } from "./api-keys";
import { getDb } from "./db";
import { findBookingByCode, getCourt } from "./store";
import type { Booking, Court, CourtAvailability, Venue } from "./types";

/**
 * What the public API (`/api/v1`, lib/api-keys.ts) reads, for one venue at a
 * time: its bookings between two dates, or one by its code.
 */

export const MAX_RANGE_DAYS = 31;

export async function bookingsBetween(venueId: number, from: string, to: string): Promise<Record<string, unknown>[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.demo = 0 AND b.date BETWEEN ? AND ? ORDER BY b.date, b.start_min, b.id LIMIT 1000`
    )
    .all(venueId, from, to)) as { code: string }[];
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const b = await bookingForVenue(venueId, r.code);
    if (b) out.push(b);
  }
  return out;
}

/** A booking by its code, only if it is at this venue. */
export async function bookingForVenue(venueId: number, code: string): Promise<Record<string, unknown> | null> {
  const b = (await findBookingByCode(code)) as Booking | null;
  if (!b) return null;
  const court = await getCourt(b.courtId);
  if (!court || court.venueId !== venueId) return null;
  // Who takes part, where it names somebody other than its customer (additive; ADR 0023).
  return { ...apiBooking({ ...b, courtName: court.name, sport: court.sport }), participants: await apiParticipants(b.id) };
}

/** Days between two dates, inclusive of both. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The key's venue as `GET /api/v1/venue` and the MCP server's `my_venue` give it: its details, hours and courts with their rates. */
export function apiVenue(
  v: Venue & { courts: Court[] },
  /**
   * The courts taking entries with no set time (lib/entries.ts `entryResources`), shown on each as `entry`: its
   * walk-in price, longest stay and whether customers check themselves in. Read only: nobody is let in through the API.
   */
  entries: { courtId: number; price: number | null; maxStay: number; selfCheckIn: boolean }[] = []
): Record<string, unknown> {
  return {
    id: v.id,
    name: v.name,
    area: v.area,
    address: v.address,
    phone: v.phone,
    timeZone: v.timeZone,
    // Usual hours in minutes of the business day (and in hours).
    openMin: v.openMin,
    closeMin: v.closeMin,
    openHour: v.openHour,
    closeHour: v.closeHour,
    // Weekdays with their own hours, or closed; null when every day keeps the usual ones.
    weekHours: v.weekHours ?? null,
    courts: v.courts.map((c) => {
      const entry = entries.find((e) => e.courtId === c.id);
      return {
        id: c.id,
        name: c.name,
        sport: c.sport,
        offPeakRate: c.offPeakRate,
        peakRate: c.peakRate,
        capacity: c.capacity,
        ...(entry ? { entry: { price: entry.price, maxStayMinutes: entry.maxStay, selfCheckIn: entry.selfCheckIn } } : {}),
      };
    }),
  };
}

/** Each court's day as `GET /api/v1/availability` and the MCP server's `my_availability` give it. */
export function apiCourtDays(grid: CourtAvailability[]): Record<string, unknown>[] {
  return grid.map((g) => ({
    id: g.court.id,
    name: g.court.name,
    sport: g.court.sport,
    policy: g.policy,
    starts: g.starts,
    grid: g.grid,
    unit: g.unit,
    slots: g.slots.map((s) => ({ minute: s.minute, hour: s.hour, rate: s.rate, available: s.available, partly: s.partly ?? false, booked: s.booked, capacity: s.capacity })),
  }));
}
