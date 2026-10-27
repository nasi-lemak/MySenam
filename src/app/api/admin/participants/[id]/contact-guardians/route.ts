import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { confirmContactCode, issueClaimCode, recordInPersonAgreement, reportForContact, sendContactCode, type StaffAt } from "@/lib/contact-guardians";
import { participantAtVenue } from "@/lib/participants";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A guardian a venue recorded by name and number only, through its staff
 * (lib/contact-guardians.ts; docs/features/venue-operations.md#guardians-without-an-account).
 * Front desk or a manager, for a participant their venue knows (another
 * venue's staff get *not found*); `guardianId` is that guardian's
 * relationship. Each recorded in the participant's history and the activity
 * log.
 *
 * - `{ venueId, action: "sendCode", guardianId, purpose: "agree" | "withdraw" | "verify", requestId?, locale? }`:
 *   a one-time code to the number recorded for them (the code and the
 *   venue's name, nothing about the participant) → 201 `{ expiresAt, channel }`.
 * - `{ venueId, action: "confirmCode", guardianId, purpose, code, requestId? }`:
 *   the code they read back: their agreement to that request (`{ active }`,
 *   true once the relationship is made), their own relationship ended, or
 *   their number checked.
 * - `{ venueId, action: "inPerson", guardianId, requestId, reason }`: a
 *   manager only, and only where no code can be sent from this install:
 *   their agreement given in person, never proof of authority.
 * - `{ venueId, action: "claimCode", guardianId }` → 201 `{ code, expiresAt }`,
 *   shown once: for them to take their relationship over with their own
 *   account, once it has proved the number recorded for them.
 * - `{ venueId, action: "report", reporterId, guardianId, note? }`: they report
 *   another guardian's relationship as a mistake; flagged for a manager.
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
  const at: StaffAt = { venueId, admin: { id: admin.id, name: admin.name } };
  const who = `${participant.displayName} (participant ${participant.id})`;
  const refusal = (r: { error: string; code: string; status: number; vars?: Record<string, string | number> }) =>
    NextResponse.json({ error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) }, { status: r.status });
  const purpose = String(body.purpose ?? "");

  if (body.action === "sendCode") {
    // Each code costs money and reaches somebody's phone: held to the counter's own rate, as well as the number's daily limit.
    const limited = await rateLimit(req, "booking", "guardian-contact-code");
    if (limited) return limited;
    const sent = await sendContactCode(at, { participantId, guardianshipId: body.guardianId, purpose: body.purpose, requestId: body.requestId, locale: body.locale });
    if (!sent.ok) return refusal(sent);
    await logAction(admin, { venueId, action: "participant.guardian_code_sent", detail: `A code to the number recorded for a guardian of ${who} (${purpose})` });
    return NextResponse.json({ expiresAt: sent.expiresAt, channel: sent.channel }, { status: 201 });
  }
  if (body.action === "confirmCode") {
    const limited = await rateLimit(req, "bookingLookup", "guardian-contact-confirm");
    if (limited) return limited;
    const done = await confirmContactCode(at, { participantId, guardianshipId: body.guardianId, purpose: body.purpose, code: body.code, requestId: body.requestId });
    if (!done.ok) return refusal(done);
    if (done.purpose === "agree")
      await logAction(admin, { venueId, action: "participant.guardian_agreed_by_code", detail: `A guardian of ${who} recorded by name and number agreed, by a code to their number` });
    else if (done.purpose === "withdraw")
      await logAction(admin, { venueId, action: "participant.guardian_withdrawn", detail: `A guardian of ${who} recorded by name and number ended their own relationship, by a code to their number` });
    else await logAction(admin, { venueId, action: "participant.guardian_number_checked", detail: `The number recorded for a guardian of ${who} reached them` });
    return NextResponse.json({ ok: true, ...(done.active !== undefined ? { active: done.active } : {}) });
  }
  if (body.action === "inPerson") {
    if (admin.role === "desk") return NextResponse.json({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }, { status: 403 });
    const done = await recordInPersonAgreement(at, { participantId, guardianshipId: body.guardianId, requestId: body.requestId, reason: body.reason });
    if (!done.ok) return refusal(done);
    await logAction(admin, {
      venueId,
      action: "participant.guardian_agreed_in_person",
      detail: `Recorded in person the agreement of a guardian of ${who} recorded by name and number: ${String(body.reason ?? "").slice(0, 200)}`,
    });
    return NextResponse.json({ ok: true, active: done.active });
  }
  if (body.action === "claimCode") {
    const made = await issueClaimCode(at, { participantId, guardianshipId: body.guardianId });
    if (!made.ok) return refusal(made);
    await logAction(admin, { venueId, action: "participant.guardian_claim_code", detail: `Gave a guardian of ${who} recorded by name and number a code to take it over with an account` });
    return NextResponse.json({ code: made.code, expiresAt: made.expiresAt }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }
  if (body.action === "report") {
    const done = await reportForContact(at, { participantId, reporterId: body.reporterId, guardianshipId: body.guardianId, note: body.note });
    if (!done.ok) return refusal(done);
    await logAction(admin, { venueId, action: "participant.guardian_reported", detail: `A guardian of ${who} recorded by name and number reported another guardian's relationship as a mistake` });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "action is sendCode, confirmCode, inPerson, claimCode or report." }, { status: 400 });
}
