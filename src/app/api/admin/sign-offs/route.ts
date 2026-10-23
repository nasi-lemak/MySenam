import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { venueMayOffer } from "@/lib/activities";
import { addSignOff, listSignOffs, revokeSignOff } from "@/lib/sign-offs";

export const dynamic = "force-dynamic";

/**
 * Staff sign-offs (lib/sign-offs.ts): who has been checked for an activity
 * that needs it here (a belay check, a range briefing).
 *
 * `?venueId` → those still in force.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ signOffs: await listSignOffs(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId, sport?, phone, name, note?, expiresOn? }`: staff have checked
 * this person (for one activity, or anything here). Who did is taken from
 * the session, and it is recorded.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const sport = body.sport === undefined || body.sport === null || body.sport === "" ? null : body.sport;
  if (sport !== null && (typeof sport !== "string" || !(await venueMayOffer(venueId, sport))))
    return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  if (typeof body.phone !== "string" || typeof body.name !== "string")
    return NextResponse.json({ error: "phone and name are required." }, { status: 400 });
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string")
    return NextResponse.json({ error: "note must be text." }, { status: 400 });
  if (body.expiresOn !== undefined && body.expiresOn !== null && typeof body.expiresOn !== "string")
    return NextResponse.json({ error: "expiresOn is a date." }, { status: 400 });
  const made = await addSignOff({
    venueId,
    sport,
    phone: body.phone,
    name: body.name,
    note: (body.note as string | null | undefined) ?? null,
    expiresOn: (body.expiresOn as string | null | undefined) ?? null,
    adminId: admin.id,
  });
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
  await logAction(admin, {
    venueId,
    action: "signoff.added",
    detail: `${made.signOff.name} (${made.signOff.phone}): ${sport ?? "anything here"}${made.signOff.expiresOn ? ` until ${made.signOff.expiresOn}` : ""}`,
  });
  return NextResponse.json({ signOff: made.signOff }, { status: 201 });
}

/** `?venueId&id`: taken back. */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(venueId) || venueId <= 0 || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!(await revokeSignOff(venueId, id))) return NextResponse.json({ error: "Sign-off not found." }, { status: 404 });
  await logAction(admin, { venueId, action: "signoff.revoked", detail: `Sign-off ${id}` });
  return NextResponse.json({ ok: true });
}
