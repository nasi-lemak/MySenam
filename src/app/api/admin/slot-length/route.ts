import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { setSlotMinutes } from "@/lib/store";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → whether the venue's sports are sold by the hour or the half hour, unless a sport says otherwise. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const row = (await getDb().prepare("SELECT slot_minutes FROM venues WHERE id = ?").get(venueId)) as { slot_minutes: number } | undefined;
  return NextResponse.json({ slotMinutes: row?.slot_minutes === 30 ? 30 : 60 });
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
    detail: result.slotMinutes === 30 ? "Sports sold by the half hour, unless their own rule says" : "Sports sold by the hour, unless their own rule says",
  });
  return NextResponse.json(result);
}
