import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { contactCodesAvailable, openNoticeTasks } from "@/lib/contact-guardians";
import { openRequestsFor } from "@/lib/guardian-requests";
import { createAtVenue, participantsForVenue, reviewQueue, type VenueParticipant } from "@/lib/participants";
import { getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Participants at the counter (lib/participants.ts; ADR 0023).
 *
 * `?venueId&phone`: the participants this venue knows (added here, or with a
 * booking, application, sign-off, induction or waiver here or at another
 * branch of its business) whose guardian is on that number, for staff to
 * choose from: a child to induct or sign off, never a match that decides
 * anything by itself. A number is needed: no browsing. Each with the
 * guardian requests still open for them (lib/guardian-requests.ts).
 *
 * `?venueId&review=1`: what a manager has to look at instead (a
 * relationship flagged for review or paused), for participants this venue
 * knows; the platform owner without `venueId`, for any.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  // Each with the requests still open, and tasks to tell a guardian recorded by name and number of a change (lib/contact-guardians.ts).
  const withRequests = async (found: VenueParticipant[], venueIds: number[] | null) => {
    const requests = await openRequestsFor(found.map((p) => p.id));
    const tasks = await openNoticeTasks(venueIds, found.map((p) => p.id));
    return found.map((p) => ({
      ...p,
      requests: requests.get(p.id) ?? [],
      noticeTasks: tasks.filter((t) => t.participantId === p.id).map((t) => ({ id: t.id, guardianName: t.guardianName, change: t.change, why: t.why })),
    }));
  };
  const review = req.nextUrl.searchParams.get("review") === "1";
  // The review list is a manager's: front desk finds participants only by a guardian's number.
  if (review && admin.role === "desk")
    return NextResponse.json({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }, { status: 403 });
  if (review &&!req.nextUrl.searchParams.get("venueId") && isOwner(admin))
    return NextResponse.json({ participants: await withRequests(await reviewQueue({ owner: true }), null), codesPossible: contactCodesAvailable() }, { headers: { "Cache-Control": "no-store" } });
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (review) return NextResponse.json({ participants: await withRequests(await reviewQueue({ venueId }), [venueId]), codesPossible: contactCodesAvailable() }, { headers: { "Cache-Control": "no-store" } });
  const phone = req.nextUrl.searchParams.get("phone") ?? "";
  if (phone.replace(/\D/g, "").length < 7) return NextResponse.json({ error: "phone is required." }, { status: 400 });
  return NextResponse.json(
    { participants: await withRequests(await participantsForVenue(venueId, phone), [venueId]), codesPossible: contactCodesAvailable() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Add a participant at the counter: `{ venueId, displayName, birthYear?,
 * guardianName, guardianPhone, relationship, authority: true }`, the
 * guardian having declared their relationship and authority to the member of
 * staff signed in, who is recorded. Seen by this venue (and its business),
 * never by others. Nothing is matched or merged with anybody on the number.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!(await getVenue(venueId))) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const made = await createAtVenue({
    venueId,
    admin: { id: admin.id, name: admin.name },
    displayName: body.displayName,
    birthYear: body.birthYear,
    guardian: { name: body.guardianName, phone: body.guardianPhone, relationship: body.relationship, authority: body.authority },
    note: body.note,
  });
  if (!made.ok) return NextResponse.json({ error: made.error, code: made.code }, { status: made.status });
  await logAction(admin, { venueId, action: "participant.created", detail: `Added ${made.participant.displayName} (participant ${made.participant.id}) at the counter` });
  return NextResponse.json({ participant: made.participant }, { status: 201 });
}
