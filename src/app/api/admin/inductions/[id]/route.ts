import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { inductionById, revokeInduction } from "@/lib/store";
import { inductionTakenBack } from "@/lib/safety-flags";
import { logAction } from "@/lib/activity";
import { assignInduction } from "@/lib/participants";

export const dynamic = "force-dynamic";

/**
 * Whose an older number-keyed induction is (lib/participants.ts; ADR 0023),
 * decided by a manager with a reason, never on matching contact details:
 * `{ participantId, reason }` gives it to that participant (one this venue
 * knows, whose guardian is on the induction's number), keeping the name it
 * was filed under; `{ participantId: null, reason }` confirms it is the
 * number holder's own and closes its review flag.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const inductionId = Number((await params).id);
  if (!Number.isInteger(inductionId) || inductionId <= 0) return NextResponse.json({ error: "Invalid induction id." }, { status: 400 });
  const induction = await inductionById(inductionId);
  if (!induction) return NextResponse.json({ error: "Induction not found." }, { status: 404 });
  const denied = denyVenue(admin, induction.venueId);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const participantId = body.participantId === null ? null : Number(body.participantId);
  if (participantId !== null && (!Number.isInteger(participantId) || participantId <= 0))
    return NextResponse.json({ error: "participantId is a participant's id, or null." }, { status: 400 });
  const done = await assignInduction({ venueId: induction.venueId, inductionId, participantId, admin: { id: admin.id, name: admin.name }, reason: body.reason });
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
  await logAction(admin, {
    venueId: induction.venueId,
    action: participantId === null ? "induction.kept" : "induction.assigned",
    detail: `${participantId === null ? "Kept as the number holder's" : `Gave to participant ${participantId}`}: induction ${inductionId} filed as ${induction.name}; ${String(body.reason).slice(0, 200)}`,
  });
  return NextResponse.json({ induction: await inductionById(inductionId) });
}

/** Withdraw someone's out-of-hours access, keeping the record that it existed. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const inductionId = Number(id);
  if (!Number.isInteger(inductionId) || inductionId <= 0)
    return NextResponse.json({ error: "Invalid induction id." }, { status: 400 });

  const induction = await inductionById(inductionId);
  if (!induction) return NextResponse.json({ error: "Induction not found." }, { status: 404 });
  const denied = denyVenue(admin, induction.venueId);
  if (denied) return denied;

  const result = await revokeInduction(inductionId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, {
    venueId: induction.venueId,
    action: "induction.revoked",
    detail: `Induction ${inductionId}${induction.participantId ? ` (participant ${induction.participantId})` : `, ${induction.name}`}: out-of-hours access withdrawn`,
  });
  // Their upcoming bookings at a time the door is the way in are flagged for staff and the customer told once; none is cancelled (ADR 0058).
  const flagged = await inductionTakenBack(induction, admin);
  return NextResponse.json({ induction: result.induction, flagged });
}
