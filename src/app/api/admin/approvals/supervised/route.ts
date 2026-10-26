import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { refusalBody, setSupervised } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/**
 * `{ venueId, code, supervised: boolean, note }`: a manager arranges (or
 * stops) staff-supervised attendance on a booking, where the venue's safety
 * procedures allow it; `note` says who supervises, under which procedure. A
 * supervised booking is never given a door code, and it authorises no
 * unmanned use later (ADR 0020). Managers only (lib/roles.ts). Recorded in
 * the activity log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const done = await setSupervised(admin, venueId, body.code, body.supervised !== false, body.note);
  if (!done.ok) return NextResponse.json(refusalBody(done), { status: done.status });
  return NextResponse.json({ ok: true, code: done.code, supervised: body.supervised !== false });
}
