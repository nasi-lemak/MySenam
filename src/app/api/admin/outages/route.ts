import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createOutage, endOutage, listOutages, outageById } from "@/lib/outages";
import { getCourt } from "@/lib/store";

export const dynamic = "force-dynamic";

/** `?venueId=` — its courts' outages, now and to come. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ outages: await listOutages([venueId]) });
}

/**
 * `{ courtId, startsOn, endsOn: string | null, reason?, cancelAffected? }` —
 * take a court out. 409 with `affected` when something is booked in the
 * stretch and `cancelAffected` was not given.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const courtId = Number(body.courtId);
  const court = Number.isInteger(courtId) ? await getCourt(courtId) : null;
  if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;
  if (typeof body.startsOn !== "string" || (body.endsOn !== null && typeof body.endsOn !== "string"))
    return NextResponse.json({ error: "startsOn, and endsOn or null, are required." }, { status: 400 });
  const result = await createOutage({
    courtId,
    startsOn: body.startsOn,
    endsOn: (body.endsOn as string | null) || null,
    reason: typeof body.reason === "string" ? body.reason : undefined,
    adminId: admin.id,
    cancelAffected: body.cancelAffected === true,
  });
  if (!result.ok)
    return NextResponse.json({ error: result.error, affected: result.affected }, { status: result.affected ? 409 : 400 });
  return NextResponse.json({ outage: result.outage, cancelled: result.cancelled }, { status: 201 });
}

/** `?id=` — back in service from today. */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const outage = await outageById(Number(req.nextUrl.searchParams.get("id")));
  if (!outage) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const denied = denyVenue(admin, outage.venueId);
  if (denied) return denied;
  const result = await endOutage(outage.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
