import tzlookup from "@photostructure/tz-lookup";
import { getDb } from "./db.ts";
import { region } from "./region.ts";
import { keepsOneOffset } from "./time.ts";

/**
 * Which time zone a venue is in. Server only: the boundaries come with the
 * lookup, which the browser has no need to download.
 *
 * Worked out from the venue's map pin rather than its address: the pin is a
 * point that has been checked to be in the country, an address is free text.
 * A zone that is not one of the country's (a pin dropped across a border the
 * check let through) gives way to the country's own.
 */
export function zoneForPin(lat: number | null | undefined, lng: number | null | undefined): string {
  const r = region();
  if (lat === null || lat === undefined || lng === null || lng === undefined) return r.timeZone;
  try {
    const zone = tzlookup(lat, lng);
    return r.timeZones.includes(zone) ? zone : r.timeZone;
  } catch {
    return r.timeZone;
  }
}

/**
 * A venue's zone: the one staff chose, else where its pin is, else the
 * install's. A stored zone that is not one of the country's, or that changes
 * its clocks (written by hand, or left from another country), is not used.
 */
export function venueZoneOf(row: { time_zone?: string | null; lat?: number | null; lng?: number | null }): string {
  if (row.time_zone && region().timeZones.includes(row.time_zone) && keepsOneOffset(row.time_zone)) return row.time_zone;
  return zoneForPin(row.lat, row.lng);
}

export interface ZoneSettings {
  /** The zone in force. */
  zone: string;
  /** Chosen by staff, rather than worked out from the pin. */
  chosen: boolean;
  /** Where the pin says, for comparison. */
  fromPin: string;
  /** The zones this country has. */
  options: string[];
}

export async function zoneSettings(venueId: number): Promise<ZoneSettings | null> {
  const row = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  if (!row) return null;
  return {
    zone: venueZoneOf(row),
    chosen: row.time_zone !== null,
    fromPin: zoneForPin(row.lat, row.lng),
    options: region().timeZones,
  };
}

/**
 * Staff set the venue's zone, one of the country's; null goes back to
 * following the pin. Bookings keep their wall-clock times: 18:00 stays 18:00.
 */
export async function setVenueZone(venueId: number, zone: unknown): Promise<{ ok: true; settings: ZoneSettings } | { ok: false; error: string }> {
  if (zone !== null && (typeof zone !== "string" || !region().timeZones.includes(zone)))
    return { ok: false, error: `Pick one of ${region().name}'s time zones: ${region().timeZones.join(", ")}.` };
  if (zone !== null && !keepsOneOffset(zone))
    return { ok: false, error: `${zone} changes its clocks during the year, which bookings here cannot follow yet.` };
  const done = await getDb().prepare("UPDATE venues SET time_zone = ? WHERE id = ?").run(zone, venueId);
  if (done.changes === 0) return { ok: false, error: "Venue not found." };
  return { ok: true, settings: (await zoneSettings(venueId))! };
}
