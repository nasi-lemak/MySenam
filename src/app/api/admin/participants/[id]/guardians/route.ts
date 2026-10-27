import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { requestAtVenue } from "@/lib/guardian-requests";
import { participantAtVenue } from "@/lib/participants";

export const dynamic = "force-dynamic";

/**
 * Another adult asks, in person, to become a guardian of a participant this
 * venue knows (lib/guardian-requests.ts `requestAtVenue`;
 * docs/features/venue-operations.md#another-guardian-by-invitation):
 * `{ venueId, proposedName?, email? }`, the adult as staff know them, and
 * optionally their MySenam account by its email so that only it may accept.
 * Front desk or a manager. Starts a request and gives a single-use code,
 * shown this once, for the adult to accept signed in to their own account
 * with their own declaration. It grants nothing: an existing guardian
 * agrees online, or a manager records an exception, before the adult may act
 * for the participant. No new participant, nothing matched or merged.
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
  const done = await requestAtVenue({ venueId, participantId, admin: { id: admin.id, name: admin.name }, proposedName: body.proposedName, email: body.email });
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, ...(done.vars ? { vars: done.vars } : {}) }, { status: done.status });
  await logAction(admin, {
    venueId,
    action: "participant.guardian_requested",
    detail: `Invited ${done.proposedName} to become a guardian of ${participant.displayName} (participant ${participant.id}); pending until accepted and agreed`,
  });
  return NextResponse.json(
    { request: { id: done.requestId, code: done.code, expiresAt: done.expiresAt, consentPossible: done.consentPossible }, participant },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
