import { NextRequest, NextResponse } from "next/server";
import { seriesWeeks } from "@/lib/house-rules";
import { activeMembership, getAvailability, getVenue, getVenueClosure } from "@/lib/store";
import { getSessionUser } from "@/lib/auth";
import { shows, storefrontForRequest } from "@/lib/storefront";
import { mayShowVenue } from "@/lib/listing";
import { releaseExpiredHolds } from "@/lib/holds";
import { isValidDateString, todayISO } from "@/lib/time";
import { Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // A slot held for somebody who never paid shows free on time, scheduler or not.
  await releaseExpiredHolds();
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
  // Nor a venue customers may not reach yet, except to its own staff.
  const venue = await getVenue(venueId);
  if (
    !venue ||
    !shows(await storefrontForRequest(req), venueId) ||
    !(await mayShowVenue(venueId, req)).show
  ) {
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
    timeZone: venue.timeZone,
    // The most weeks one weekly booking may run here.
    seriesWeeks: await seriesWeeks(venueId),
  });
}
