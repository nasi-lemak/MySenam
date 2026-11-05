import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import type { Admin } from "@/lib/admin-auth";
import { jsonObject, refusal } from "@/lib/api";
import { addWalkIn, isKind, markAttendance, registerFor, removeWalkIn, sessionInfo, sessionLabel, staffViewer, type SessionInfo, type SessionRef } from "@/lib/attendance";

export const dynamic = "force-dynamic";

/** The session a request names, once the member of staff is known to manage its venue; or the answer to send. */
async function sessionOf(
  admin: Admin,
  kind: unknown,
  id: unknown
): Promise<{ error: NextResponse; ref?: undefined; info?: undefined } | { error?: undefined; ref: SessionRef; info: SessionInfo }> {
  if (!isKind(kind) || !Number.isInteger(id) || (id as number) <= 0) return { error: NextResponse.json({ error: "kind (class or lesson) and id are required." }, { status: 400 }) };
  const ref: SessionRef = { kind, id: id as number };
  const info = await sessionInfo(ref);
  if (!info) return { error: NextResponse.json({ error: "That session was not found.", code: "ATTENDANCE_NOT_FOUND" }, { status: 404 }) };
  const denied = denyVenue(admin, info.venueId);
  if (denied) return { error: denied };
  return { ref, info };
}

/** `?kind=class|lesson&id` → the session's register: who is expected, each mark, whether it is open, early or closed (lib/attendance.ts). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const p = req.nextUrl.searchParams;
  const found = await sessionOf(admin, p.get("kind"), Number(p.get("id")));
  if (found.error) return found.error;
  const register = await registerFor(staffViewer(admin), found.ref);
  if ("ok" in register) return refusal(register, 404);
  return NextResponse.json({ register }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ kind, id, action, ... }`, front desk and managers (the same terms: from the session's day until the venue's days after, a manager at any
 * time, after that with a `reason`):
 * - `mark`: `{ key, mark: present|absent|late|excused, note?, reason? }`
 * - `walkin`: `{ name, mark?, note?, reason? }`, somebody who came without being on the list
 * - `remove`: `{ key, reason? }`, a walk-in added by mistake
 * Moves no money and changes no pass or policy (lib/attendance.ts). Each write is in the activity log with the session, never a name.
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
  const found = await sessionOf(admin, body.kind, body.id);
  if (found.error) return found.error;
  const viewer = staffViewer(admin);
  const label = sessionLabel(found.info);
  const log = (action: string, detail: string) => logAction(admin, { venueId: found.info.venueId, action, detail });
  const why = (late: boolean) => (late ? `; reason: ${String(body.reason).trim().slice(0, 200)}` : "");
  const status = (code?: string) => (code === "ATTENDANCE_NOT_FOUND" ? 404 : code === "ATTENDANCE_EARLY" || code === "ATTENDANCE_CLOSED" ? 403 : 409);
  if (body.action === "mark") {
    const done = await markAttendance(viewer, found.ref, { key: body.key, mark: body.mark, note: body.note, reason: body.reason });
    if (!done.ok) return refusal(done, status(done.code));
    if (done.was !== done.line.mark || done.late)
      await log(done.late ? "attendance.corrected" : "attendance.marked", `${label}: ${done.was ? `${done.was} → ` : ""}${done.line.mark}${why(done.late)}`);
    return NextResponse.json({ line: done.line, late: done.late });
  }
  if (body.action === "walkin") {
    const done = await addWalkIn(viewer, found.ref, { name: body.name, mark: body.mark, note: body.note, reason: body.reason });
    if (!done.ok) return refusal(done, status(done.code));
    await log(done.late ? "attendance.corrected" : "attendance.marked", `${label}: a walk-in added, ${done.line.mark}${why(done.late)}`);
    return NextResponse.json({ line: done.line, late: done.late }, { status: 201 });
  }
  if (body.action === "remove") {
    const done = await removeWalkIn(viewer, found.ref, { key: body.key, reason: body.reason });
    if (!done.ok) return refusal(done, status(done.code));
    await log(done.late ? "attendance.corrected" : "attendance.marked", `${label}: a walk-in removed${why(done.late)}`);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "action is mark, walkin or remove." }, { status: 400 });
}
