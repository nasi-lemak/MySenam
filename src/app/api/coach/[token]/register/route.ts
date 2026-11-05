import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { jsonObject, refusal } from "@/lib/api";
import { addWalkIn, isKind, markAttendance, registerFor, removeWalkIn, sessionInfo, sessionLabel, type Viewer } from "@/lib/attendance";
import { coachForToken } from "@/lib/coach-schedule";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A coach's register of their own sessions, at the private link the venue gave them (lib/coach-schedule.ts, lib/attendance.ts):
 *
 * - `GET ?id[&kind=lesson]` → the register of a lesson of theirs: the names of the people on it (no number), each mark. A session that is
 *   not theirs is answered as not found, whoever's it is.
 * - `POST { id, kind?, action: mark | walkin | remove, ... }` as at the desk (`/api/admin/attendance`), from the session's day, until the
 *   venue's days after; a closed register is a manager's to correct. Each change is in the venue's activity log under their name.
 *
 * A coach never locks a register, reads a report, or sees another coach's session.
 */
async function coachOf(
  req: NextRequest,
  params: Promise<{ token: string }>
): Promise<{ error: NextResponse; found?: undefined; viewer?: undefined } | { error?: undefined; found: NonNullable<Awaited<ReturnType<typeof coachForToken>>>; viewer: Viewer }> {
  const limited = await rateLimit(req, "official", "coach-register");
  if (limited) return { error: limited };
  const found = await coachForToken((await params).token);
  if (!found || !found.coach.active) return { error: NextResponse.json({ error: "This link is no longer in use." }, { status: 404 }) };
  const viewer: Viewer = { kind: "coach", coachId: found.coach.id, name: found.coach.name };
  return { found, viewer };
}

const refSession = (kind: unknown, id: unknown) => (isKind(kind ?? "lesson") && Number.isInteger(id) && (id as number) > 0 ? { kind: (kind ?? "lesson") as "class" | "lesson", id: id as number } : null);

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const who = await coachOf(req, params);
  if (who.error) return who.error;
  const ref = refSession(req.nextUrl.searchParams.get("kind") ?? undefined, Number(req.nextUrl.searchParams.get("id")));
  if (!ref) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const register = await registerFor(who.viewer, ref);
  if ("ok" in register) return refusal(register, 404);
  return NextResponse.json({ register }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const who = await coachOf(req, params);
  if (who.error) return who.error;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const ref = refSession(body.kind, body.id);
  if (!ref) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const info = await sessionInfo(ref);
  // Not theirs is not found, as for a read.
  if (!info || info.coachId !== who.found.coach.id) return NextResponse.json({ error: "That session was not found.", code: "ATTENDANCE_NOT_FOUND" }, { status: 404 });
  const log = (detail: string) =>
    logAction({ id: null, name: who.found.coach.name }, { venueId: info.venueId, action: "attendance.marked", detail: `${sessionLabel(info)}: ${detail}; at their own link` });
  const status = (code?: string) => (code === "ATTENDANCE_NOT_FOUND" ? 404 : code === "ATTENDANCE_EARLY" || code === "ATTENDANCE_CLOSED" ? 403 : 409);
  if (body.action === "mark") {
    const done = await markAttendance(who.viewer, ref, { key: body.key, mark: body.mark, note: body.note });
    if (!done.ok) return refusal(done, status(done.code));
    if (done.was !== done.line.mark) await log(`${done.was ? `${done.was} → ` : ""}${done.line.mark}`);
    return NextResponse.json({ line: done.line });
  }
  if (body.action === "walkin") {
    const done = await addWalkIn(who.viewer, ref, { name: body.name, mark: body.mark, note: body.note });
    if (!done.ok) return refusal(done, status(done.code));
    await log(`a walk-in added, ${done.line.mark}`);
    return NextResponse.json({ line: done.line }, { status: 201 });
  }
  if (body.action === "remove") {
    const done = await removeWalkIn(who.viewer, ref, { key: body.key });
    if (!done.ok) return refusal(done, status(done.code));
    await log("a walk-in removed");
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "action is mark, walkin or remove." }, { status: 400 });
}
