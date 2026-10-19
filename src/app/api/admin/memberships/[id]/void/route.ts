import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { membershipById, voidMembership } from "@/lib/store";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const membershipId = Number(id);
  if (!Number.isInteger(membershipId) || membershipId <= 0)
    return NextResponse.json({ error: "Invalid membership id." }, { status: 400 });

  const existing = await membershipById(membershipId);
  if (!existing) return NextResponse.json({ error: "Membership not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;

  const result = await voidMembership(membershipId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, { venueId: existing.venueId, action: "membership.voided", detail: `Membership ${membershipId}` });
  return NextResponse.json({ membership: result.membership });
}
