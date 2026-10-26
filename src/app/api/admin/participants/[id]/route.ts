import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { linkByStaff, participantAtVenue, revokeGuardianship } from "@/lib/participants";

export const dynamic = "force-dynamic";

/**
 * A manager's corrections to a participant this venue knows
 * (lib/participants.ts; ADR 0023), each with a reason, recorded in the
 * participant's history and the activity log:
 *
 * - `{ venueId, action: "revokeGuardian", guardianId, reason }`: that
 *   relationship ends; whoever held it makes nothing new for the participant.
 * - `{ venueId, action: "link", email, reason }`: the participant's own
 *   login from now on, the account named by its email.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const by = { id: admin.id, name: admin.name };
  if (body.action === "revokeGuardian") {
    const guardianId = Number(body.guardianId);
    const owned = Number.isInteger(guardianId) && guardianId > 0;
    const done = owned ? await revokeGuardianship(guardianId, { venueId, participantId, admin: by }, body.reason) : null;
    if (!done) return NextResponse.json({ error: "guardianId is required." }, { status: 400 });
    if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
    await logAction(admin, { venueId, action: "participant.guardian_revoked", detail: `Revoked a guardian of ${participant.displayName} (participant ${participant.id}): ${String(body.reason).slice(0, 200)}` });
    return NextResponse.json({ ok: true });
  }
  if (body.action === "link") {
    const done = await linkByStaff({ venueId, participantId, email: body.email, admin: by, reason: body.reason });
    if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
    await logAction(admin, { venueId, action: "participant.linked", detail: `Linked ${participant.displayName} (participant ${participant.id}) to their own login: ${String(body.reason).slice(0, 200)}` });
    return NextResponse.json({ participant: done.participant });
  }
  return NextResponse.json({ error: "action is revokeGuardian or link." }, { status: 400 });
}
