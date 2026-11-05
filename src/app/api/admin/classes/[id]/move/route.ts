import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { jsonObject, readMinute } from "@/lib/api";
import { isMinute } from "@/lib/interval";
import { classMoveDetail, moveClasses, previewClassMove } from "@/lib/class-moves";
import { tickOutbox } from "@/lib/notify";
import { getClass } from "@/lib/store";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Move a class (lib/class-moves.ts; docs/features/programmes.md#moving-a-class), a manager's, as cancelling one is.
 *
 * `{ date, start, courtId?, scope?, preview? }`: the chosen session goes to `date` at `start` (minutes of the day, or
 * `startHour`/HH:MM as the other class routes read them), on `courtId` where the court changes; `scope` is `one` (the default),
 * `following` (it and the later sessions of its weekly series, each shifted by the same days and minutes) or `term` (every
 * session of the series not yet begun). With `preview: true` nothing changes: each session where it would go, who is enrolled
 * and waiting, who holds a pass entry or a membership's benefit, what is in the way and what each person would be told.
 * Otherwise all of it moves, or none (409 with `conflicts`), everyone enrolled or waiting is told once, and it is logged.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  const classId = Number(id);
  if (!Number.isInteger(classId) || classId <= 0) return NextResponse.json({ error: "Invalid class id." }, { status: 400 });
  const session = await getClass(classId);
  if (!session) return NextResponse.json({ error: "Class not found." }, { status: 404 });
  const denied = denyVenue(admin, session.venueId);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const start = readMinute(body, "start", "startHour");
  if (typeof body.date !== "string" || !isValidDateString(body.date) || !isMinute(start))
    return NextResponse.json({ error: "date (YYYY-MM-DD) and start (minutes of the day or HH:MM) are required." }, { status: 400 });
  if (body.courtId !== undefined && body.courtId !== null && (!Number.isInteger(body.courtId) || (body.courtId as number) <= 0))
    return NextResponse.json({ error: "courtId must be a court of this venue." }, { status: 400 });
  const to = { date: body.date, start, ...(typeof body.courtId === "number" ? { courtId: body.courtId } : {}) };

  if (body.preview === true) {
    const seen = await previewClassMove(session.id, to, body.scope);
    if (!seen.ok) return NextResponse.json({ error: seen.error, code: seen.code, vars: seen.vars }, { status: 409 });
    return NextResponse.json(seen);
  }
  const result = await moveClasses(admin, session.id, to, body.scope);
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code, vars: result.vars, ...("conflicts" in result && result.conflicts ? { conflicts: result.conflicts } : {}) }, { status: 409 });
  await logAction(admin, { venueId: session.venueId, action: "class.moved", detail: classMoveDetail(result) });
  await tickOutbox();
  return NextResponse.json({
    moveId: result.moveId,
    scope: result.scope,
    classes: result.moved.map((m) => m.after),
    skipped: result.skipped,
    told: result.told,
  });
}
