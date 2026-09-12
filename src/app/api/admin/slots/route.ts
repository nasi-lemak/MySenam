import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAdminSlots, getVenue } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const params = req.nextUrl.searchParams;
  const venueId = Number(params.get("venueId"));
  const date = params.get("date") ?? todayISO();

  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  if (!isValidDateString(date))
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  if (!getVenue(venueId))
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  return NextResponse.json({ date, courts: getAdminSlots(venueId, date) });
}
