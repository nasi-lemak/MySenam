import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { closeRequest, recordException, reviewGuardian, type StaffScope } from "@/lib/guardian-requests";
import { linkByStaff, participantForStaff, revokeGuardianship } from "@/lib/participants";

export const dynamic = "force-dynamic";

/**
 * A manager's corrections to a participant this venue knows
 * (lib/participants.ts, lib/guardian-requests.ts; ADR 0023), each with a
 * reason, recorded in the participant's history and the activity log:
 *
 * - `{ venueId, action: "revokeGuardian", guardianId, reason }`: that
 *   relationship ends; whoever held it makes nothing new for the participant.
 * - `{ venueId, action: "suspendGuardian" | "confirmGuardian", guardianId, reason }`:
 *   pause a relationship while a reported mistake is looked at (it acts for
 *   nobody meanwhile), or keep one flagged or paused, closing the flag.
 * - `{ venueId, action: "exception", requestId, category, reason, reviewOn, suppressNotice? }`:
 *   the narrow exception to an existing guardian's agreement on a request
 *   (custody dispute, guardian unavailable, safeguarding), never proof of
 *   guardianship.
 * - `{ venueId, action: "closeRequest", requestId, reason }`: refuse or
 *   cancel a request still open.
 * - `{ venueId, action: "link", email, reason }`: the participant's own
 *   login from now on, the account named by its email.
 *
 * The platform owner may act on a participant no venue knows with
 * `{ owner: true }` in place of `venueId` (except `link`). Another guardian
 * is never added here: that is a request (`POST .../guardians`).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const participantId = Number((await params).id);
  if (!Number.isInteger(participantId) || participantId <= 0) return NextResponse.json({ error: "Invalid participant id." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  let scope: StaffScope;
  if (body.owner === true && isOwner(admin)) scope = { owner: true };
  else {
    const venueId = Number(body.venueId);
    if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
    const denied = denyVenue(admin, venueId);
    if (denied) return denied;
    scope = { venueId };
  }
  const venueId = "venueId" in scope ? scope.venueId : null;
  const participant = await participantForStaff(scope, participantId);
  if (!participant) return NextResponse.json({ error: "No such participant here.", code: "PTC_NOT_FOUND" }, { status: 404 });
  const by = { id: admin.id, name: admin.name };
  const who = `${participant.displayName} (participant ${participant.id})`;
  const why = String(body.reason ?? "").slice(0, 200);
  const refusal = (r: { error: string; code: string; status: number; vars?: Record<string, string | number> }) =>
    NextResponse.json({ error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) }, { status: r.status });
  if (body.action === "revokeGuardian") {
    const guardianId = Number(body.guardianId);
    if (!Number.isInteger(guardianId) || guardianId <= 0) return NextResponse.json({ error: "guardianId is required." }, { status: 400 });
    const done = await revokeGuardianship(guardianId, venueId !== null ? { venueId, participantId, admin: by } : { owner: true, participantId, admin: by }, body.reason);
    if (!done.ok) return refusal(done);
    await logAction(admin, { venueId, action: "participant.guardian_revoked", detail: `Revoked a guardian of ${who}: ${why}` });
    return NextResponse.json({ ok: true });
  }
  if (body.action === "suspendGuardian" || body.action === "confirmGuardian") {
    const suspend = body.action === "suspendGuardian";
    const done = await reviewGuardian(scope, by, participantId, body.guardianId, suspend ? "suspend" : "confirm", body.reason);
    if (!done.ok) return refusal(done);
    await logAction(admin, {
      venueId,
      action: suspend ? "participant.guardian_suspended" : "participant.guardian_confirmed",
      detail: `${suspend ? "Paused" : "Kept"} a guardian of ${who}: ${why}`,
    });
    return NextResponse.json({ ok: true });
  }
  if (body.action === "exception") {
    const done = await recordException(scope, by, body.requestId, {
      category: body.category,
      reason: body.reason,
      reviewOn: body.reviewOn,
      suppressNotice: body.suppressNotice,
      participantId,
    });
    if (!done.ok) return refusal(done);
    await logAction(admin, {
      venueId,
      action: "participant.guardian_exception",
      detail: `Exception (${String(body.category)}) to a guardian's agreement for ${who}, review by ${String(body.reviewOn)}: ${why}`,
    });
    return NextResponse.json({ ok: true, active: done.active });
  }
  if (body.action === "closeRequest") {
    const done = await closeRequest(scope, by, body.requestId, body.reason, participantId);
    if (!done.ok) return refusal(done);
    await logAction(admin, { venueId, action: "participant.guardian_request_closed", detail: `Closed a guardian request for ${who}: ${why}` });
    return NextResponse.json({ ok: true });
  }
  if (body.action === "link" && venueId !== null) {
    const done = await linkByStaff({ venueId, participantId, email: body.email, admin: by, reason: body.reason });
    if (!done.ok) return refusal(done);
    await logAction(admin, { venueId, action: "participant.linked", detail: `Linked ${who} to their own login: ${why}` });
    return NextResponse.json({ participant: done.participant });
  }
  return NextResponse.json({ error: "action is revokeGuardian, suspendGuardian, confirmGuardian, exception, closeRequest or link." }, { status: 400 });
}
