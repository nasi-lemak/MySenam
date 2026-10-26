import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { seriesWeeks } from "@/lib/house-rules";
import { listConcessions } from "@/lib/concessions";
import { activeMembership, getAvailability, getVenue, getVenueClosure, memberNumberTrusted } from "@/lib/store";
import { getSessionUser } from "@/lib/auth";
import { canAccessVenue, getSessionAdmin } from "@/lib/admin-auth";
import { shows, storefrontForRequest } from "@/lib/storefront";
import { mayShowVenue } from "@/lib/listing";
import { releaseExpiredHolds } from "@/lib/holds";
import { isValidDateString, todayISO } from "@/lib/time";
import { Sport } from "@/lib/types";

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
    if (!(await isActivity(sportParam))) {
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
  // Member prices for the account's own number, proved or linked to the membership: what booking would charge.
  const held = user ? await activeMembership(venueId, user.phone, date) : null;
  const membership = held && user && (await memberNumberTrusted(user.phone, { userId: user.id, by: "customer" })) ? held : null;

  return NextResponse.json({
    date,
    // A tier with its own price level prices the grid at that.
    // Rooms run as classes are the venue's own staff's to hire out; customers book their classes.
    availability: await getAvailability(venueId, date, sport, membership ? (membership.ratePercent ?? true) : false, await (async () => { const staff = await getSessionAdmin(req); return staff !== null && canAccessVenue(staff, venueId); })()),
    closure: await getVenueClosure(venueId, date),
    memberRates: membership !== null,
    timeZone: venue.timeZone,
    // The most weeks one weekly booking may run here.
    seriesWeeks: await seriesWeeks(venueId),
    // Concession prices offered here, chosen at booking and shown at the counter.
    concessions: await listConcessions(venueId),
    // The venue's own staff at the counter: they may book for a child the venue knows (lib/participant-bookings.ts).
    atCounter: await (async () => {
      const admin = await getSessionAdmin(req);
      return !!admin && canAccessVenue(admin, venueId);
    })(),
    // A manager of this venue may book outside its booking rules (recorded).
    mayOverride: await (async () => {
      const admin = await getSessionAdmin(req);
      return !!admin && admin.role !== "desk" && canAccessVenue(admin, venueId);
    })(),
  });
}
