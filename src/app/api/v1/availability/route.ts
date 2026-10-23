import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { getAvailability } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { SPORTS, type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * `?date=YYYY-MM-DD[&sport=]` → each court's day. `starts` is what may be
 * booked: each minute of the day a booking may start at, and the longest it
 * may run from there; `policy` says which lengths (`lengths`, or
 * `minLength` to `maxLength` in steps of `lengthStep`). `slots` is the same
 * day drawn as a grid of `grid` minutes, for showing: a column is free,
 * partly held or held, with its price.
 */
export async function GET(req: NextRequest) {
  const caller = await apiCaller(req, "availability");
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
      policy: g.policy,
      starts: g.starts,
      grid: g.grid,
      unit: g.unit,
      slots: g.slots.map((s) => ({ minute: s.minute, hour: s.hour, rate: s.rate, available: s.available, partly: s.partly ?? false, booked: s.booked, capacity: s.capacity })),
    })),
  });
}
