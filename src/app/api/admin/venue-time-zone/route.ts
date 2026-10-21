import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { setVenueZone, zoneSettings } from "@/lib/zones";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → the venue's time zone, whether staff chose it, and what its pin says. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const settings = await zoneSettings(venueId);
  if (!settings) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  return NextResponse.json({ settings });
}

/** `{ venueId, zone }`: one of the country's zones, or null to follow the map pin. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const result = await setVenueZone(venueId, body.zone ?? null);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: result.settings.chosen ? `Time zone: ${result.settings.zone}` : `Time zone follows the map pin (${result.settings.zone})`,
  });
  return NextResponse.json(result);
}
