import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { jsonObject, refusal } from "@/lib/api";
import { isKind, lockRegister, sessionInfo, sessionLabel, staffViewer } from "@/lib/attendance";

export const dynamic = "force-dynamic";

/**
 * `{ kind, id, locked }`: a manager closes a session's register (from then only a manager corrects it, with a reason) or opens it again.
 * Managers only (lib/roles.ts); in the activity log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isKind(body.kind) || !Number.isInteger(body.id) || typeof body.locked !== "boolean")
    return NextResponse.json({ error: "kind (class or lesson), id and locked are required." }, { status: 400 });
  const ref = { kind: body.kind, id: body.id as number };
  const info = await sessionInfo(ref);
  if (!info) return NextResponse.json({ error: "That session was not found.", code: "ATTENDANCE_NOT_FOUND" }, { status: 404 });
  const denied = denyVenue(admin, info.venueId);
  if (denied) return denied;
  const done = await lockRegister(staffViewer(admin), ref, body.locked);
  if (!done.ok) return refusal(done, 403);
  await logAction(admin, { venueId: info.venueId, action: done.locked ? "attendance.locked" : "attendance.unlocked", detail: sessionLabel(info) });
  return NextResponse.json({ locked: done.locked });
}
