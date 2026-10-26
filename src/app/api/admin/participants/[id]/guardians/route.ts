import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { addGuardianAtVenue, participantAtVenue } from "@/lib/participants";

export const dynamic = "force-dynamic";

/**
 * Another adult at the counter becomes a guardian of a participant this
 * venue knows (lib/participants.ts `addGuardianAtVenue`;
 * docs/features/venue-operations.md#a-second-guardian-at-the-counter):
 * `{ venueId, guardianName, guardianPhone, relationship, authority: true, note? }`,
 * the adult having declared their relationship and authority to the member
 * of staff signed in, who is recorded. Front desk or a manager. Named by
 * contact details only: a MySenam account is a manager's
 * (`PATCH /api/admin/participants/[id]`, `addGuardian`). No new participant,
 * nothing matched or merged on the number.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const participantId = Number((await params).id);
  if (!Number.isInteger(participantId) || participantId <= 0) return NextResponse.json({ error: "Invalid participant id." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const participant = await participantAtVenue(venueId, participantId);
  if (!participant) return NextResponse.json({ error: "No such participant here.", code: "PTC_NOT_FOUND" }, { status: 404 });
  const done = await addGuardianAtVenue({
    venueId,
    participantId,
    admin: { id: admin.id, name: admin.name },
    guardian: { name: body.guardianName, phone: body.guardianPhone, relationship: body.relationship, authority: body.authority },
    note: body.note,
  });
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, ...(done.vars ? { vars: done.vars } : {}) }, { status: done.status });
  await logAction(admin, {
    venueId,
    action: "participant.guardian_added",
    detail: `Added ${done.guardianName} as a guardian of ${participant.displayName} (participant ${participant.id}) on their declaration at the counter${done.otherGuardians > 0 ? `; ${done.otherGuardians} other guardian(s) on record` : ""}`,
  });
  return NextResponse.json({ ok: true, guardianId: done.guardianshipId, participant }, { status: 201 });
}
