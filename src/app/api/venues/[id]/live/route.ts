import { NextRequest, NextResponse } from "next/server";
import { getLiveOccupancy } from "@/lib/store";
import { mayShowVenue } from "@/lib/listing";

export const dynamic = "force-dynamic";

/**
 * Public: how busy each facility at this venue is right now. Derived from door
 * check-ins, so it reflects people actually present rather than bookings held.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  if (!(await mayShowVenue(venueId, req)).show)
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  return NextResponse.json({
    asOf: new Date().toISOString(),
    occupancy: await getLiveOccupancy(venueId),
  });
}
