import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { placeRetentionHold, releaseRetentionHold, retentionHoldsAt } from "@/lib/approval-retention";

export const dynamic = "force-dynamic";

/**
 * Keeping an application to be approved for an activity past its time, for
 * an actual legal, safety or dispute reason (lib/approval-retention.ts).
 * Managers and the platform owner only (lib/roles.ts); a manager's hold is
 * short and capped, and every hold ends on its review day unless renewed.
 * `?venueId` → the venue's holds, those in force first.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ holds: await retentionHoldsAt(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId, requestId, basis, reason, reviewBy }`: place a hold (or renew one, as a new hold). Recorded. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const placed = await placeRetentionHold(admin, { venueId, requestId: body.requestId, basis: body.basis, reason: body.reason, reviewBy: body.reviewBy });
  if (!placed.ok) return NextResponse.json({ error: placed.error }, { status: placed.status });
  return NextResponse.json({ hold: placed.hold }, { status: 201 });
}

/** `{ venueId, id, reason }`: let a hold go before its review day. Recorded. */
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const released = await releaseRetentionHold(admin, { venueId, holdId: body.id, reason: body.reason });
  if (!released.ok) return NextResponse.json({ error: released.error }, { status: released.status });
  return NextResponse.json({ ok: true });
}
