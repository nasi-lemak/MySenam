import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import {
  getClass,
  getClassRoster,
  listClassWaitlist,
} from "@/lib/store";

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

  return { session };
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

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error, session } = await resolve(req, params);
  if (error) return error;

  const result = await cancelClassAndTell(session.id);
  await tickOutbox();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ released: result.released });
}
