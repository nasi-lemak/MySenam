import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { courtLinks, setCourtParts } from "@/lib/court-links";
import { getCourt } from "@/lib/store";

export const dynamic = "force-dynamic";

/** `?venueId` → which courts take which (lib/court-links.ts). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ links: await courtLinks(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ courtId, parts: number[] }`: the courts booking this one takes too, replacing the list (managers). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const court = Number.isInteger(body.courtId) ? await getCourt(body.courtId as number) : null;
  if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;
  const set = await setCourtParts(court.id, body.parts);
  if (!set.ok) return NextResponse.json(set, { status: 409 });
  await logFromRequest(req, {
    venueId: court.venueId,
    action: "settings.changed",
    detail: set.parts.length ? `${court.name} now takes courts ${set.parts.join(", ")} when booked` : `${court.name} takes no other court`,
  });
  return NextResponse.json({ parts: set.parts });
}
