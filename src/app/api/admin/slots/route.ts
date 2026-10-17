import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getAdminSlots, getVenue } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const params = req.nextUrl.searchParams;
  const venueId = Number(params.get("venueId"));
  const date = params.get("date") ?? todayISO();

  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  if (!isValidDateString(date))
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!await getVenue(venueId)) return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  return NextResponse.json({ date, courts: await getAdminSlots(venueId, date) });
}
