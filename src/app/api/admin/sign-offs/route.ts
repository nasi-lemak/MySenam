import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin, type Admin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { logAction } from "@/lib/activity";
import { venueMayOffer } from "@/lib/activities";
import { addSignOff, listSignOffs, revokeSignOff, signOffAt } from "@/lib/sign-offs";

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

/** May this admin speak for every branch of the venue's business? */
async function forWholeBusiness(admin: Admin, venueId: number): Promise<boolean> {
  if (isOwner(admin)) return true;
  const venue = (await getDb().prepare("SELECT business_id FROM venues WHERE id = ?").get(venueId)) as { business_id: number | null } | undefined;
  return venue?.business_id !== null && venue?.business_id !== undefined && admin.businessId === venue.business_id;
}

/**
 * `{ venueId, sport?, phone, name, email?, kind?, reference?, note?, expiresOn?, wholeBusiness? }`:
 * staff have checked this person (for one activity, or anything here), or
 * seen a certification (`kind: "certification"`, with what was seen and when
 * it runs out). `email` links it to that customer's account; otherwise it is
 * linked to an account that has proved the number, if any. `wholeBusiness`
 * (a manager of the business) makes it good at every branch. Who gave it is
 * taken from the session, and it is recorded.
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
  for (const key of ["email", "reference"] as const)
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string")
      return NextResponse.json({ error: `${key} must be text.` }, { status: 400 });
  if (body.kind !== undefined && body.kind !== "operational" && body.kind !== "certification")
    return NextResponse.json({ error: "kind is operational or certification." }, { status: 400 });
  const wholeBusiness = body.wholeBusiness === true;
  if (wholeBusiness && !(await forWholeBusiness(admin, venueId)))
    return NextResponse.json({ error: "Only whoever runs the business records a sign-off for every branch." }, { status: 403 });
  const made = await addSignOff({
    venueId,
    wholeBusiness,
    sport,
    phone: body.phone,
    name: body.name,
    email: (body.email as string | null | undefined) ?? null,
    kind: (body.kind as "operational" | "certification" | undefined) ?? "operational",
    reference: (body.reference as string | null | undefined) ?? null,
    note: (body.note as string | null | undefined) ?? null,
    expiresOn: (body.expiresOn as string | null | undefined) ?? null,
    adminId: admin.id,
  });
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
  const so = made.signOff;
  await logAction(admin, {
    venueId,
    action: "signoff.added",
    detail: `${so.kind === "certification" ? `Certification ${so.reference}` : "Sign-off"} for ${so.name} (${so.phone}${so.userId ? `, account ${so.userId}` : ", no account linked"}): ${
      sport ?? "anything"
    } ${so.businessId ? "at every branch" : "here"}${so.expiresOn ? ` until ${so.expiresOn}` : ""}`,
  });
  return NextResponse.json({ signOff: made.signOff }, { status: 201 });
}

/** `?venueId&id[&reason]`: taken back, by whom and why recorded. One for every branch needs whoever runs the business. */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(venueId) || venueId <= 0 || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const reason = req.nextUrl.searchParams.get("reason");
  const found = await signOffAt(venueId, id);
  if (!found || found.revokedAt) return NextResponse.json({ error: "Sign-off not found." }, { status: 404 });
  if (found.businessId !== null && !(await forWholeBusiness(admin, venueId)))
    return NextResponse.json({ error: "Only whoever runs the business takes back a sign-off for every branch." }, { status: 403 });
  if (!(await revokeSignOff(venueId, id, { adminId: admin.id, reason, wholeBusiness: found.businessId !== null })))
    return NextResponse.json({ error: "Sign-off not found." }, { status: 404 });
  await logAction(admin, {
    venueId,
    action: "signoff.revoked",
    detail: `${found.kind === "certification" ? "Certification" : "Sign-off"} for ${found.name} (${found.phone}): ${found.sport ?? "anything"}${reason ? `; ${reason.slice(0, 200)}` : ""}`,
  });
  return NextResponse.json({ ok: true });
}
