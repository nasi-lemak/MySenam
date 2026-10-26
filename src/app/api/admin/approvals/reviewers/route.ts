import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { linkCoachAccount } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/**
 * `{ venueId, coachId, email }`: link a coach to their own MySenam account
 * (by the account's email), or unlink it (`email: null`). A coach reviews
 * the applications the venue names them for only signed in to that account;
 * their private schedule link decides nothing (ADR 0020). Managers only
 * (lib/roles.ts). Recorded.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  const coachId = Number(body.coachId);
  if (!Number.isInteger(venueId) || venueId <= 0 || !Number.isInteger(coachId) || coachId <= 0)
    return NextResponse.json({ error: "venueId and coachId are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const done = await linkCoachAccount(venueId, coachId, body.email ?? null);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  await logAction(admin, {
    venueId,
    action: "approval.reviewer_account",
    detail: done.email ? `Linked coach ${done.coachName} to the account ${done.email}, to review applications` : `Unlinked coach ${done.coachName}'s account`,
  });
  return NextResponse.json({ ok: true, account: done.email });
}
