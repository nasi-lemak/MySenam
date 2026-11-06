import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { overdueBlockDays, setOverdueBlockDays } from "@/lib/accounts";

export const dynamic = "force-dynamic";

/** `?venueId` → `{ overdueBlockDays }`: after how many days overdue an account's invoice stops new bookings on it; null for never (the default). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ overdueBlockDays: await overdueBlockDays(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId, overdueBlockDays }`: stop new bookings on an account once one of its invoices is that many days past its due day
 * (1 to 365; null or blank for never, as before). A manager's; in the activity log. Staff may go past it for one booking with a
 * reason (`POST /api/admin/accounts/charge`).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const venueId = Number(body?.venueId);
  if (!body || !Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const done = await setOverdueBlockDays(venueId, body.overdueBlockDays);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: `Company and school accounts: new bookings ${done.days === null ? "are not stopped by overdue invoices" : `stop once an invoice is ${done.days} days overdue`}`,
  });
  return NextResponse.json({ overdueBlockDays: done.days });
}
