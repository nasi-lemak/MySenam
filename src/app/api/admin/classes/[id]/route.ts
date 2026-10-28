import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import {
  getClass,
  getClassRoster,
  listClassWaitlist,
} from "@/lib/store";
import { logAction, logClassCancelled } from "@/lib/activity";
import { changeClass, classChangeDetail } from "@/lib/class-changes";
import { refusal } from "@/lib/api";

import { cancelClassAndTell, tickOutbox } from "@/lib/notify";

export const dynamic = "force-dynamic";

async function resolve(req: NextRequest, params: Promise<{ id: string }>) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return { error: admin };

  const { id } = await params;
  const classId = Number(id);
  if (!Number.isInteger(classId) || classId <= 0)
    return { error: NextResponse.json({ error: "Invalid class id." }, { status: 400 }) };

  const session = await getClass(classId);
  if (!session)
    return { error: NextResponse.json({ error: "Class not found." }, { status: 404 }) };
  const denied = denyVenue(admin, session.venueId);
  if (denied) return { error: denied };

  return { admin, session };
}

/** The roster for a class. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error, session } = await resolve(req, params);
  if (error) return error;
  return NextResponse.json({
    session,
    roster: await getClassRoster(session.id),
    waitlist: await listClassWaitlist(session.id),
  });
}

/**
 * `{ name?, instructor?, capacity?, price?, series? }` — change a class
 * that has not started (lib/class-changes.ts): more places are offered to
 * its waiting list, fewer never below those taken or offered, a new price
 * for enrolments from now on; `series: true` changes the later sessions of
 * its weekly series too. Answers each session as it is now.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error, admin, session } = await resolve(req, params);
  if (error) return error;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await changeClass(session.id, {
    name: body.name,
    instructor: body.instructor,
    capacity: body.capacity,
    price: body.price,
    series: body.series,
  });
  if (!result.ok) return refusal(result, 409);
  await logAction(admin, { venueId: session.venueId, action: "class.changed", detail: classChangeDetail(result.changed) });
  if (result.offered > 0) await tickOutbox();
  return NextResponse.json({ classes: result.changed.map((c) => c.after), offered: result.offered });
}

/** Call the class off: every enrolment cancelled, refunded and told; each is in the activity log. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error, admin, session } = await resolve(req, params);
  if (error) return error;

  const result = await cancelClassAndTell(session.id);
  await tickOutbox();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logClassCancelled(admin, result.session ?? session, result.cancelled ?? []);
  return NextResponse.json({ released: result.released });
}
