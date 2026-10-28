import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { membershipById, voidMembership } from "@/lib/store";
import { oweBackMembership, stopRenewalOf } from "@/lib/payments";
import { logAction } from "@/lib/activity";
import { withTransaction } from "@/lib/db";
import { asStaff } from "@/lib/acting-staff";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/**
 * Cancel a membership (managers). `{ refund: true }`: what an online payment
 * took for it is owed back too, listed under *Refunds owed* (lib/payments.ts
 * `oweBackMembership`); left out, nothing is owed back, as before.
 */
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

  const body = (await req.json().catch(() => null)) as { refund?: unknown } | null;
  const refund = body?.refund === true;
  // Voided and owed back together, or neither.
  // As the manager cancelling it, so its credit note says who (lib/acting-staff.ts).
  const { result, owed } = await asStaff(admin, () =>
    withTransaction(async () => {
      const voided = await voidMembership(membershipId);
      return { result: voided, owed: voided.ok && refund ? await oweBackMembership(membershipId) : null };
    })
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  // One that renews itself stops charging too; if the gateway will not say so, staff are told to stop it there.
  const renewal = await stopRenewalOf(membershipId);
  // Its holder's and covered people's bookings from today on that it no longer covers: flagged for staff, never cancelled.
  const flagged = result.flagged ?? 0;
  await logAction(admin, {
    venueId: existing.venueId,
    action: "membership.voided",
    detail: `Membership ${membershipId}${owed !== null ? `, ${money(owed)} paid online owed back` : ""}${flagged > 0 ? `; ${flagged} booking(s) flagged for staff` : ""}`,
  });
  return NextResponse.json({
    membership: result.membership,
    flagged,
    ...(owed !== null ? { owedBack: owed } : {}),
    ...(renewal ? { warning: `It still renews at the gateway: ${renewal}` } : {}),
  });
}
