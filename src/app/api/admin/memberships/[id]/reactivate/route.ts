import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { membershipById } from "@/lib/store";
import { reactivateMembership } from "@/lib/membership-suspensions";

export const dynamic = "force-dynamic";

/**
 * `{ reason }` (managers): reactivate a suspended membership from today
 * (lib/membership-suspensions.ts). Its history is kept; bookings flagged by
 * the suspension stay for staff to decide; the holder is emailed; it is in
 * the activity log.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const membershipId = Number((await params).id);
  if (!Number.isInteger(membershipId) || membershipId <= 0) return NextResponse.json({ error: "Invalid membership id." }, { status: 400 });
  const existing = await membershipById(membershipId);
  if (!existing) return NextResponse.json({ error: "Membership not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  const done = await reactivateMembership({ id: admin.id, name: admin.name }, membershipId, body ?? {});
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, vars: done.vars }, { status: done.status });
  return NextResponse.json({ lifted: done.lifted, expiresOn: done.expiresOn, extension: done.extension, membership: await membershipById(membershipId) });
}
