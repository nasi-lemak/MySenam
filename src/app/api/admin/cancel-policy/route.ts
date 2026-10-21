import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { cancelPolicy, setCancelPolicy } from "@/lib/cancel-policy";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → what a late cancellation or a no-show costs at the venue. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ policy: await cancelPolicy(venueId) });
}

/** `{ venueId, lateKeep, strikeLimit, strikeDays, onlineRefunds }`; null turns the first two off. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const result = await setCancelPolicy(venueId, body);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  const p = result.policy;
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: `Late cancelling: ${p.lateKeep === null ? "off" : `keep ${p.lateKeep}%`}; strikes: ${
      p.strikeLimit === null ? "off" : `${p.strikeLimit} in ${p.strikeDays} days`
    }; online refunds: ${p.onlineRefunds}`,
  });
  return NextResponse.json({ policy: p });
}
