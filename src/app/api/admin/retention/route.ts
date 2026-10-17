import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { pruneOldData, RETENTION, retentionDue, retentionLastRun } from "@/lib/privacy";

export const dynamic = "force-dynamic";

/**
 * Housekeeping is platform-wide — it reaches every venue's rows — so it is the
 * owner's, not a venue operator's.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  return NextResponse.json(
    { policy: RETENTION, due: await retentionDue(), lastRun: await retentionLastRun() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Apply the policy now rather than waiting for the next visit. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  return NextResponse.json(await pruneOldData());
}
