import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import {
  cancelClassSession,
  getClass,
  getClassRoster,
  listClassWaitlist,
} from "@/lib/store";

export const dynamic = "force-dynamic";

async function resolve(req: NextRequest, params: Promise<{ id: string }>) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return { error: admin };

  const { id } = await params;
  const classId = Number(id);
  if (!Number.isInteger(classId) || classId <= 0)
    return { error: NextResponse.json({ error: "Invalid class id." }, { status: 400 }) };

  const session = getClass(classId);
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
    roster: getClassRoster(session.id),
    waitlist: listClassWaitlist(session.id),
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error, session } = await resolve(req, params);
  if (error) return error;

  const result = cancelClassSession(session.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ released: result.released });
}
