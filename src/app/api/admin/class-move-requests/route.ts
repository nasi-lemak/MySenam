import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { listMoveRequests } from "@/lib/class-move-requests";

export const dynamic = "force-dynamic";

/**
 * `?venueId?&days?` → `{ requests }`: the requests to move a class at the venues this account manages (a venue it does not manage is refused; with none named,
 * all of its own): every one waiting for a manager, and those decided or closed in the last `days` days (14 by default, at most 60). Front desk reads
 * them too, at its own venue (the outcome of what it asked for). Nobody enrolled is named: only counts. Requests that
 * have run out of time or whose class has begun, been cancelled or changed are closed first, and logged. Deciding is `POST /api/admin/class-move-requests/:id`.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const raw = req.nextUrl.searchParams.get("venueId");
  const venueId = raw === null ? undefined : Number(raw);
  if (venueId !== undefined) {
    if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId must be a venue." }, { status: 400 });
    const denied = denyVenue(admin, venueId);
    if (denied) return denied;
  }
  const days = Number(req.nextUrl.searchParams.get("days") ?? 14);
  const requests = await listMoveRequests(admin, {
    ...(venueId !== undefined ? { venueId } : {}),
    decidedDays: Number.isInteger(days) && days >= 1 && days <= 60 ? days : 14,
    mineOnly: false,
  });
  return NextResponse.json({ requests }, { headers: { "Cache-Control": "no-store" } });
}
