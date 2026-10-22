import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { loyaltyEvery, setLoyalty } from "@/lib/loyalty";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → how many paid hours earn a free one here, or null when off. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ every: await loyaltyEvery(venueId) });
}

/** `{ venueId, every: number | null }` (managers). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const set = await setLoyalty(venueId, body.every ?? null);
  if (!set.ok) return NextResponse.json(set, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: set.every === null ? "Loyalty hours off" : `Loyalty: one free hour every ${set.every} hours played`,
  });
  return NextResponse.json({ every: set.every });
}
