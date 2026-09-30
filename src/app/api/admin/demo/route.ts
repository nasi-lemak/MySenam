import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { demoState, refreshDemoData, seedDemoData } from "@/lib/demo";

export const dynamic = "force-dynamic";

/** Whether this install is empty enough to be worth filling, and if the demo has aged. */
export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  return NextResponse.json(demoState(), { headers: { "Cache-Control": "no-store" } });
}

/**
 * Fill an empty install with a plausible fortnight, or move an existing demo
 * onto today.
 *
 * Owner-only. Seeding is refused once anything has been sold, and reloading is
 * refused once any of it was sold for real — the two together are what stop
 * invented customers turning up in a working venue's day list, and what stop a
 * reload ever clearing a real booking.
 */
export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const result =
    body?.refresh === true
      ? refreshDemoData({ adminId: admin.id })
      : seedDemoData({ adminId: admin.id });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json(result);
}
