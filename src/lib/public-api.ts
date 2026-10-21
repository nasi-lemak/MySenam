import { apiBooking } from "./api-keys";
import { getDb } from "./db";
import { findBookingByCode, getCourt } from "./store";
import type { Booking } from "./types";

/**
 * What the public API (`/api/v1`, lib/api-keys.ts) reads, for one venue at a
 * time: its bookings between two dates, or one by its code.
 */

export const MAX_RANGE_DAYS = 31;

export async function bookingsBetween(venueId: number, from: string, to: string): Promise<Record<string, unknown>[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.demo = 0 AND b.date BETWEEN ? AND ? ORDER BY b.date, b.start_hour, b.id LIMIT 1000`
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
  return apiBooking({ ...b, courtName: court.name, sport: court.sport });
}

/** Days between two dates, inclusive of both. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
