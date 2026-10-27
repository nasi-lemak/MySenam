import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { discountStacking, setDiscountStacking } from "@/lib/discounts";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → `{ stacking }`: whether a concession price and a promo code go together here (lib/discounts.ts). */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ stacking: await discountStacking(venueId) });
}

/**
 * `{ venueId, stacking: "never" | "promotion" }`: one discount at a time (the
 * default), or a concession price with a code where the code allows it. A
 * manager's setting; it applies to bookings made from then on.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const done = await setDiscountStacking(venueId, body.stacking);
  if (!done.ok) return NextResponse.json(done, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: `Discounts together: ${done.stacking === "promotion" ? "a concession price with a code that allows it" : "one discount at a time"}`,
  });
  return NextResponse.json({ stacking: done.stacking });
}
