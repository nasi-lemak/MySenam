import { NextRequest, NextResponse } from "next/server";
import { activeMembership, getAvailability, getVenue, getVenueClosure } from "@/lib/store";
import { getSessionUser } from "@/lib/auth";
import { shows, storefrontForRequest } from "@/lib/storefront";
import { isValidDateString, todayISO } from "@/lib/time";
import { Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
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
  // A storefront's pages do not show other venues, and neither does this.
  if (!await getVenue(venueId) || !shows(await storefrontForRequest(req), venueId)) {
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  }

  // A signed-in member sees their own rates, so the grid is not a bait price.
  // Guests see the public rate and still get the member rate at booking if
  // their phone number matches, which the confirmation then shows.
  const user = await getSessionUser(req);
  const membership = user ? await activeMembership(venueId, user.phone, date) : null;

  return NextResponse.json({
    date,
    availability: await getAvailability(venueId, date, sport, membership !== null),
    closure: await getVenueClosure(venueId, date),
    memberRates: membership !== null,
  });
}
