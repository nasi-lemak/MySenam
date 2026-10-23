import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The key's venue: its details, hours and courts with their rates. */
export async function GET(req: NextRequest) {
  const caller = await apiCaller(req, "availability");
  if (caller instanceof NextResponse) return caller;
  const v = (await getVenue(caller.venueId))!;
  return NextResponse.json({
    venue: {
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
      courts: v.courts.map((c) => ({ id: c.id, name: c.name, sport: c.sport, offPeakRate: c.offPeakRate, peakRate: c.peakRate, capacity: c.capacity })),
    },
  });
}
