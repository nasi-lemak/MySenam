import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { createAtVenue, participantsForVenue } from "@/lib/participants";
import { getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Participants at the counter (lib/participants.ts; ADR 0023).
 *
 * `?venueId&phone`: the participants this venue knows (added here, or with a
 * booking, application, sign-off, induction or waiver here or at another
 * branch of its business) whose guardian is on that number, for staff to
 * choose from: a child to induct or sign off, never a match that decides
 * anything by itself. A number is needed: no browsing.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const phone = req.nextUrl.searchParams.get("phone") ?? "";
  if (phone.replace(/\D/g, "").length < 7) return NextResponse.json({ error: "phone is required." }, { status: 400 });
  return NextResponse.json({ participants: await participantsForVenue(venueId, phone) }, { headers: { "Cache-Control": "no-store" } });
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
