import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { goLiveStatus, requestGoLive } from "@/lib/applications";
import { jsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { clearTestBookings } from "@/lib/test-bookings";

export const dynamic = "force-dynamic";

function venueOf(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `?venueId=` — draft, waiting, live or off the marketplace, and what it still needs. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueOf(req.nextUrl.searchParams.get("venueId"));
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const status = await goLiveStatus(venueId);
  if (!status) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId, clearTests? }` — send a draft to the platform owner to go live, clearing its test bookings if asked. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: { venueId?: unknown; clearTests?: unknown };
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = venueOf(body.venueId);
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const result = await requestGoLive(admin, venueId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, {
    venueId,
    action: "venue.go_live",
    detail: result.live ? "Put the venue live" : "Sent the venue to the platform to go live",
  });
  // Offered as it is sent: the test bookings made while setting up, cleared (lib/test-bookings.ts).
  const cleared = body.clearTests === true ? await clearTestBookings(admin, venueId) : null;
  return NextResponse.json({ live: result.live, status: await goLiveStatus(venueId), cleared });
}
