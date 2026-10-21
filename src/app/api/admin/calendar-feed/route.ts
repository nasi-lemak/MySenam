import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { feedToken, feedUrl, setFeed } from "@/lib/staff-calendar";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → the address staff subscribe to, or null when the feed is off. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const token = await feedToken(venueId);
  return NextResponse.json({ url: token ? await feedUrl(venueId, token) : null });
}

/** `{ venueId, on }`: on gives a fresh address (the old one stops working); off withdraws it. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { venueId?: unknown; on?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const token = await setFeed(venueId, body.on === true);
  await logFromRequest(req, { venueId, action: "settings.changed", detail: token ? "Calendar feed: new address" : "Calendar feed: off" });
  return NextResponse.json({ url: token ? await feedUrl(venueId, token) : null });
}
