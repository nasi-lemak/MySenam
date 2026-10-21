import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { bookingForVenue } from "@/lib/public-api";

export const dynamic = "force-dynamic";

/** One of the venue's bookings, by its code. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const caller = await apiCaller(req);
  if (caller instanceof NextResponse) return caller;
  const booking = await bookingForVenue(caller.venueId, (await params).code);
  return booking ? NextResponse.json({ booking }) : NextResponse.json({ error: "Booking not found." }, { status: 404 });
}
