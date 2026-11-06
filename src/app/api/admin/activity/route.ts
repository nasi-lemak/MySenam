import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { listActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

/**
 * The staff activity log, for managers (lib/roles.ts): `?venueId` for one
 * venue, else every venue this account manages; `?from&to` (YYYY-MM-DD) and
 * `?code` for one booking's history.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const p = req.nextUrl.searchParams;
  const venueId = p.get("venueId") ? Number(p.get("venueId")) : null;
  if (venueId !== null) {
    const denied = denyVenue(admin, venueId);
    if (denied) return denied;
  }
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  return NextResponse.json({
    actions: await listActivity(venueId !== null ? [venueId] : admin.venueIds, {
      from: date(p.get("from")),
      to: date(p.get("to")),
      bookingCode: p.get("code") ?? undefined,
      limit: Number(p.get("limit")) || 200,
      // A business's managers also read what was done at business level, which has no venue, beside any venue's.
      businessId: admin.businessId,
    }),
  });
}
