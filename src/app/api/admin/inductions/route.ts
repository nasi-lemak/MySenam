import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getVenue, listInductions, recordInduction } from "@/lib/store";

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
  const { venueId, phone, name, note } = (body ?? {}) as Record<string, unknown>;

  if (!Number.isInteger(venueId) || (venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  if (typeof phone !== "string" || phone.trim() === "")
    return NextResponse.json({ error: "phone is required." }, { status: 400 });
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  if (note !== undefined && note !== null && typeof note !== "string")
    return NextResponse.json({ error: "note must be text." }, { status: 400 });

  const result = await recordInduction({
    venueId: venueId as number,
    phone,
    name,
    adminId: admin.id,
    note: (note as string | undefined) ?? undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ induction: result.induction }, { status: 201 });
}
