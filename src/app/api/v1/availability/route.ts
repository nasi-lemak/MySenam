import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { apiCourtDays } from "@/lib/public-api";
import { getAvailability } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { type Sport } from "@/lib/types";

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
  if (sport && !(await isActivity(sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  // The venue's own system sees everything it may hire out, rooms run as classes included.
  const grid = await getAvailability(caller.venueId, date, (sport as Sport) || undefined, false, true);
  return NextResponse.json({ date, courts: apiCourtDays(grid) });
}
