import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { membershipFlags, resolveMembershipFlag } from "@/lib/membership-flags";

export const dynamic = "force-dynamic";

/**
 * Bookings flagged for staff after a membership stopped covering somebody on
 * them (lib/membership-flags.ts): `?venueId` → `flags`, those not yet dealt with.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ flags: await membershipFlags(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId, flagId, note }`: a flagged booking has been dealt with (cancelled
 * on the venue's terms, admitted at the desk, or kept), with what was done;
 * on record and in the activity log. Nothing is cancelled here.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  const flagId = Number(body.flagId);
  if (!Number.isInteger(venueId) || venueId <= 0 || !Number.isInteger(flagId) || flagId <= 0)
    return NextResponse.json({ error: "venueId and flagId are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const flag = (await membershipFlags(venueId)).find((f) => f.id === flagId);
  if (!(await resolveMembershipFlag(admin, venueId, flagId, body.note)))
    return NextResponse.json({ error: "Say what was done with this booking.", code: "APR_REASON_NEEDED" }, { status: 400 });
  await logAction(admin, {
    venueId,
    action: "membership.flag_resolved",
    ...(flag ? { bookingCode: flag.bookingCode } : {}),
    detail: `${flag ? `${flag.name}, membership ${flag.membershipCode}` : `Flag ${flagId}`}: ${String(body.note).trim().slice(0, 300)}`,
  });
  return NextResponse.json({ ok: true, flags: await membershipFlags(venueId) });
}
