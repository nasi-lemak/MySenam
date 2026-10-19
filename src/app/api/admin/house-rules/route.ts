import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { houseRules, setHouseRules } from "@/lib/house-rules";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

/** `?venueId` → the venue's fair-use rules for booking online. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ rules: await houseRules(venueId) });
}

/** `{ venueId, upcoming, perWeek, perDay, aheadDays }`, each a number or blank for no limit. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const result = await setHouseRules(venueId, body);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  await logFromRequest(req, { venueId, action: "settings.changed", detail: `House rules: ${JSON.stringify(result.rules)}` });
  return NextResponse.json({ rules: result.rules });
}
