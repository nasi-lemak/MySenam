import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { extendMembership, membershipById } from "@/lib/store";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

/** `{ days, reason? }` → the membership runs that many days longer (managers). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const membershipId = Number((await params).id);
  if (!Number.isInteger(membershipId) || membershipId <= 0) return NextResponse.json({ error: "Invalid membership id." }, { status: 400 });
  const existing = await membershipById(membershipId);
  if (!existing) return NextResponse.json({ error: "Membership not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { days?: unknown; reason?: unknown };
  const result = await extendMembership(membershipId, Number(body.days));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const why = typeof body.reason === "string" && body.reason.trim() ? `: ${body.reason.trim().slice(0, 200)}` : "";
  await logAction(admin, {
    venueId: existing.venueId,
    action: "membership.extended",
    detail: `${existing.code}, ${Number(body.days)} days, now until ${result.membership.expiresOn}${why}`,
  });
  return NextResponse.json({ membership: result.membership });
}
