import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { jsonObject, refusal } from "@/lib/api";
import { lessonSettings, setLessonSettings } from "@/lib/lesson-venue-moves";

export const dynamic = "force-dynamic";

/** `?venueId` → `{ moveRefundDays, attendanceLockDays }`: how long a customer may cancel a lesson the venue moved, and how long after a session its register stays open. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ settings: await lessonSettings(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId, moveRefundDays?, attendanceLockDays? }`: whole days. A manager's (lib/roles.ts); in the activity log. */
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
  const done = await setLessonSettings(venueId, body);
  if (!done.ok) return refusal({ ok: false, error: done.error }, 400);
  if (done.changed.length > 0) await logAction(admin, { venueId, action: "settings.changed", detail: `Lessons and registers: ${done.changed.join("; ")}` });
  return NextResponse.json({ settings: done.settings });
}
