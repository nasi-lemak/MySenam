import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { setSportRules, sportRules } from "@/lib/sport-rules";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → each sport's own rules here, over the venue's (lib/sport-rules.ts). */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ rules: await sportRules(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId, sport, cutoffHours, lateKeep, peak, slotMinutes }`, each null for the venue's (managers). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const set = await setSportRules(venueId, body.sport, { cutoffHours: body.cutoffHours, lateKeep: body.lateKeep, peak: body.peak, slotMinutes: body.slotMinutes });
  if (!set.ok) return NextResponse.json(set, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: set.rules ? `Rules for ${body.sport}: ${JSON.stringify(set.rules)}` : `${body.sport} back on the venue's rules`,
  });
  return NextResponse.json({ rules: set.rules });
}
