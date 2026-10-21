import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { forgiveStrikes, strikesFor } from "@/lib/cancel-policy";
import { phoneKey } from "@/lib/phone";

export const dynamic = "force-dynamic";

/** `{ venueId, phone }`: this number's strikes here stop counting (lib/cancel-policy.ts). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as { venueId?: unknown; phone?: unknown } | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (typeof body.phone !== "string" || phoneKey(body.phone).length < 7)
    return NextResponse.json({ error: "phone is required." }, { status: 400 });
  await forgiveStrikes(venueId, body.phone, admin.id);
  await logAction(admin, { venueId, action: "strikes.forgiven", detail: `Number ending ${phoneKey(body.phone).slice(-4)}` });
  return NextResponse.json({ strikes: await strikesFor(venueId, body.phone) });
}
