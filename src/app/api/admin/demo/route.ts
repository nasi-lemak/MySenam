import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { hasTradingHistory, seedDemoData } from "@/lib/demo";

export const dynamic = "force-dynamic";

/** Whether this install is empty enough to be worth filling. */
export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  return NextResponse.json(
    { empty: !hasTradingHistory() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Fill an empty install with a plausible fortnight.
 *
 * Owner-only, and refused outright once anything real has been sold — the two
 * together are what stop invented customers turning up in a working venue's
 * day list.
 */
export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  const result = seedDemoData({ adminId: admin.id });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json(result);
}
