import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { holdPolicy, setHoldPolicy } from "@/lib/holds";
import { logFromRequest } from "@/lib/activity";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → whether online bookings must be paid online to be held. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ policy: await holdPolicy(venueId) });
}

/** `{ venueId, on, minutes, depositPercent?, offerMinutes? }`: depositPercent null for the whole price; offerMinutes the waiting-list offer window (not given: as it was). */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const result = await setHoldPolicy(venueId, {
    on: body.on === true,
    minutes: body.minutes === undefined ? undefined : Number(body.minutes),
    depositPercent: body.depositPercent === undefined ? undefined : body.depositPercent === null ? null : Number(body.depositPercent),
    offerMinutes: body.offerMinutes === undefined ? undefined : Number(body.offerMinutes),
  });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: `Pay online to hold: ${
      result.policy.on
        ? `on, ${result.policy.minutes} minutes${result.policy.depositPercent ? `, a ${result.policy.depositPercent}% deposit` : ""}`
        : "off"
    }; waiting-list offers last up to ${result.policy.offerMinutes} minutes`,
  });
  return NextResponse.json({ policy: result.policy });
}
