import { NextRequest, NextResponse } from "next/server";
import { getAvailability, getVenue, getVenueClosure } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";
import { Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const venueId = Number(params.get("venueId"));
  const date = params.get("date") ?? todayISO();
  const sportParam = params.get("sport");

  if (!Number.isInteger(venueId) || venueId <= 0) {
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  }
  if (!isValidDateString(date)) {
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  }
  let sport: Sport | undefined;
  if (sportParam) {
    if (!SPORTS.includes(sportParam as Sport)) {
      return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
    }
    sport = sportParam as Sport;
  }
  if (!getVenue(venueId)) {
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  }

  return NextResponse.json({
    date,
    availability: getAvailability(venueId, date, sport),
    closure: getVenueClosure(venueId, date),
  });
}
