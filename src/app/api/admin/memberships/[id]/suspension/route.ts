import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { membershipById } from "@/lib/store";
import { suspendMembership, suspensionHistory } from "@/lib/membership-suspensions";

export const dynamic = "force-dynamic";

async function membershipFor(req: NextRequest, params: Promise<{ id: string }>) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const membershipId = Number((await params).id);
  if (!Number.isInteger(membershipId) || membershipId <= 0) return NextResponse.json({ error: "Invalid membership id." }, { status: 400 });
  const existing = await membershipById(membershipId);
  if (!existing) return NextResponse.json({ error: "Membership not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;
  return { admin, existing };
}

/** Every suspension of the membership, oldest first: its dates, who suspended it and why, who lifted it, when and why. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await membershipFor(req, params);
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ suspensions: await suspensionHistory(found.existing.id) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ from, until?, reason }` (managers): suspend the membership from `from`
 * (today or later) until `until`, or until reactivated where left out
 * (lib/membership-suspensions.ts). On those dates it covers nobody; bookings
 * already made for them are flagged for staff (`flagged`), never cancelled or
 * refunded; the holder is emailed; it is in the activity log.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await membershipFor(req, params);
  if (found instanceof NextResponse) return found;
  const body = (await req.json().catch(() => null)) as { from?: unknown; until?: unknown; reason?: unknown } | null;
  const done = await suspendMembership({ id: found.admin.id, name: found.admin.name }, found.existing.id, body ?? {});
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, vars: done.vars }, { status: done.status });
  return NextResponse.json({
    suspension: done.suspension,
    flagged: done.flagged,
    expiresOn: done.expiresOn,
    extension: done.extension,
    membership: await membershipById(found.existing.id),
  });
}
