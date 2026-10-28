import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { cashUpAs } from "@/lib/cash-up";

export const dynamic = "force-dynamic";

/**
 * `?venueId&date?&staffId?` → the day's cash-up (lib/cash-up.ts): every receipt and credit note of the day on the
 * venue's calendar, from every source, summed by how it was paid. Front desk gets its own, today or yesterday; a
 * manager anybody's (`staffId`) or everybody's, any day. `date` defaults to the venue's today.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const params = req.nextUrl.searchParams;
  const venueId = Number(params.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const result = await cashUpAs(admin, venueId, { date: params.get("date"), staffId: params.get("staffId") });
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  return NextResponse.json({ ...result.cashUp, scope: result.scope, deskDays: result.deskDays }, { headers: { "Cache-Control": "no-store" } });
}
