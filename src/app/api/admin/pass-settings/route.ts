import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { jsonObject, refusal } from "@/lib/api";
import { DEFAULT_RESTORE_GRACE_DAYS, passRestoreGraceDays, setPassRestoreGraceDays } from "@/lib/pass-validity";

export const dynamic = "force-dynamic";

/** `?venueId` → `{ settings: { restoreGraceDays, recommended } }`: the days an ended pass is extended by when entries are given back to it (0: off). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ settings: { restoreGraceDays: await passRestoreGraceDays(venueId), recommended: DEFAULT_RESTORE_GRACE_DAYS } }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId, restoreGraceDays }`: whole days, 0 to 365. A manager's (lib/roles.ts); in the activity log. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Number.isInteger(body.venueId) || (body.venueId as number) <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const done = await setPassRestoreGraceDays(venueId, body.restoreGraceDays);
  if (!done.ok) return refusal(done, 400);
  if (done.days !== done.was) await logAction(admin, { venueId, action: "settings.changed", detail: `Passes: days an ended pass is extended when entries are given back ${done.was} → ${done.days}` });
  return NextResponse.json({ settings: { restoreGraceDays: done.days, recommended: DEFAULT_RESTORE_GRACE_DAYS } });
}
