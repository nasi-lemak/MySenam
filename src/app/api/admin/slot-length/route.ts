import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { setSlotMinutes, venueHours } from "@/lib/store";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → whether the venue sells by the hour or the half hour. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ slotMinutes: (await venueHours(venueId)).step * 60 });
}

/** `{ venueId, minutes }`: 60 or 30. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const result = await setSlotMinutes(venueId, body.minutes);
  if (!result.ok) return NextResponse.json(result, { status: 409 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: result.slotMinutes === 30 ? "Courts sold by the half hour" : "Courts sold by the hour",
  });
  return NextResponse.json(result);
}
