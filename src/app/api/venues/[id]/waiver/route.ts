import { NextRequest, NextResponse } from "next/server";
import { mayShowVenue } from "@/lib/listing";
import { currentWaiver } from "@/lib/waivers";

export const dynamic = "force-dynamic";

/** The venue's waiver as it stands, or null: whether the booking form asks for it (lib/waivers.ts). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = Number((await params).id);
  if (!Number.isInteger(venueId) || venueId <= 0 || !(await mayShowVenue(venueId, req)).show)
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const waiver = await currentWaiver(venueId);
  return NextResponse.json({ waiver: waiver ? { text: waiver.text, since: waiver.createdAt.slice(0, 10) } : null });
}
