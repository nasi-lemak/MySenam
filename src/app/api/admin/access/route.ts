import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getVenue, listAccessReveals } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Who has been given a door code at this venue, most recent first. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!await getVenue(venueId)) return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  return NextResponse.json(
    { reveals: await listAccessReveals(venueId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
