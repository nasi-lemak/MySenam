import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getVenue, listInductions, recordInduction } from "@/lib/store";
import { participantAtVenue } from "@/lib/participants";

export const dynamic = "force-dynamic";

/** Everyone cleared to use this venue outside staffed hours. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!await getVenue(venueId)) return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  return NextResponse.json({ inductions: await listInductions(venueId) });
}

/**
 * Record that an operator has shown somebody round in person. The operator is
 * taken from the session, never from the body: an induction is worth something
 * only because a named person stands behind it.
 *
 * `{ venueId, phone, name, note? }`: the holder of that number themself.
 * `{ venueId, phone, participantId, note? }`: a participant this venue knows
 * (lib/participants.ts), the number being their guardian's to reach them:
 * the induction is the participant's alone, never the number holder's.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { venueId, phone, name, note, participantId } = (body ?? {}) as Record<string, unknown>;

  if (!Number.isInteger(venueId) || (venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  if (typeof phone !== "string" || phone.trim() === "")
    return NextResponse.json({ error: "phone is required." }, { status: 400 });
  // For a participant: one this venue knows, by id; their name is theirs, not typed.
  const participant =
    participantId === undefined || participantId === null ? null : await participantAtVenue(venueId as number, participantId);
  if (participantId !== undefined && participantId !== null && !participant)
    return NextResponse.json({ error: "No such participant here.", code: "PTC_NOT_FOUND" }, { status: 404 });
  if (!participant && (typeof name !== "string" || name.trim().length < 2))
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  if (note !== undefined && note !== null && typeof note !== "string")
    return NextResponse.json({ error: "note must be text." }, { status: 400 });

  const result = await recordInduction({
    venueId: venueId as number,
    phone,
    name: participant ? participant.displayName : (name as string),
    adminId: admin.id,
    note: (note as string | undefined) ?? undefined,
    participant: participant ? { id: participant.id, name: participant.displayName } : null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ induction: result.induction }, { status: 201 });
}
