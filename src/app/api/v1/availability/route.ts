import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { getAvailability } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { SPORTS, type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?date=YYYY-MM-DD[&sport=]` → each court's slots that day, with their price and whether they are free. */
export async function GET(req: NextRequest) {
  const caller = await apiCaller(req);
  if (caller instanceof NextResponse) return caller;
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const sport = req.nextUrl.searchParams.get("sport");
  if (!isValidDateString(date)) return NextResponse.json({ error: "date (YYYY-MM-DD) is required." }, { status: 400 });
  if (sport && !SPORTS.includes(sport as Sport)) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  const grid = await getAvailability(caller.venueId, date, (sport as Sport) || undefined);
  return NextResponse.json({
    date,
    courts: grid.map((g) => ({
      id: g.court.id,
      name: g.court.name,
      sport: g.court.sport,
      slots: g.slots.map((s) => ({ hour: s.hour, rate: s.rate, available: s.available, booked: s.booked, capacity: s.capacity })),
    })),
  });
}
