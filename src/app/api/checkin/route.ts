import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { checkInByToken, getCourt, getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Public self-service check-in from the QR code on a booking. */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { token } = (body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || token.trim() === "")
    return NextResponse.json({ error: "token is required." }, { status: 400 });

  const limited = rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = checkInByToken(token);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  const court = getCourt(result.booking.courtId)!;
  const venue = getVenue(court.venueId)!;
  return NextResponse.json({
    booking: result.booking,
    court: { name: court.name, sport: court.sport },
    venue: { name: venue.name, area: venue.area },
  });
}
