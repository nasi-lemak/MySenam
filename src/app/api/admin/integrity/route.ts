import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { checkIntegrity } from "@/lib/integrity";

export const dynamic = "force-dynamic";

/**
 * Do the bookings and the court time they hold agree, now (lib/integrity.ts)?
 * The scheduler asks once a day and raises an alert; this is for the platform
 * owner to ask again after putting something right.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  const problems = await checkIntegrity();
  return NextResponse.json({ ok: problems.length === 0, problems }, { headers: { "Cache-Control": "no-store" } });
}
