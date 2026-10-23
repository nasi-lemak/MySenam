import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin, type Admin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { activitiesForVenue, catalogue, createActivity, updateActivity, type ActivityInput, type ActivityOwner } from "@/lib/activities";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The activity catalogue as an operator sees it (lib/activities.ts, ADR
 * 0011): the platform's activities and their own, each with its template,
 * usual booking rules and how far its booking workflow is supported.
 *
 * `?venueId` → what that venue may offer. The platform owner, without a
 * venue, gets the whole catalogue, retired ones included.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const raw = req.nextUrl.searchParams.get("venueId");
  if (raw === null) {
    if (!isOwner(admin)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
    return NextResponse.json({ activities: await catalogue() }, { headers: { "Cache-Control": "no-store" } });
  }
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const venue = await owner(venueId);
  if (!venue) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  return NextResponse.json({ activities: await activitiesForVenue(venue) }, { headers: { "Cache-Control": "no-store" } });
}

async function owner(venueId: number): Promise<{ id: number; businessId: number | null } | null> {
  const row = (await getDb().prepare("SELECT id, business_id FROM venues WHERE id = ?").get(venueId)) as
    | { id: number; business_id: number | null }
    | undefined;
  return row ? { id: row.id, businessId: row.business_id } : null;
}

/** Whose a new or changed activity is: the venue's business (every branch), the venue, or, with no venue, the platform's. */
async function ownerFor(admin: Admin, venueId: unknown): Promise<ActivityOwner | NextResponse> {
  if (venueId === undefined || venueId === null) {
    if (!isOwner(admin)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
    return { businessId: null, venueId: null, platform: true };
  }
  if (!Number.isInteger(venueId) || (venueId as number) <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  const venue = await owner(venueId as number);
  if (!venue) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  return { businessId: venue.businessId, venueId: venue.id, platform: false };
}

/**
 * `{ venueId, names: { en, ms?, zh?, ta? }, category, icon?, aliases?, model, noun, capacity?, perPlayer?, maxPlayers? }`:
 * an activity of the operator's own (managers), offered on their courts and
 * found in search like any other. Without a venue, the platform owner adds
 * one for every venue.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const who = await ownerFor(admin, body.venueId);
  if (who instanceof NextResponse) return who;
  const made = await createActivity(body as unknown as ActivityInput, who);
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
  await logAction(admin, {
    venueId: who.venueId,
    action: "activity.created",
    detail: `${made.activity.names.en} (${made.activity.key}), ${made.activity.category}, booked as ${made.activity.template.model}`,
  });
  return NextResponse.json({ activity: made.activity }, { status: 201 });
}

/** `{ key, venueId, ...what changes, active? }`: change an operator's own, or retire it. The platform owner may also stop offering a built-in. */
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.key !== "string") return NextResponse.json({ error: "key is required." }, { status: 400 });
  if (body.active !== undefined && typeof body.active !== "boolean") return NextResponse.json({ error: "active is true or false." }, { status: 400 });
  const who = await ownerFor(admin, body.venueId);
  if (who instanceof NextResponse) return who;
  const changed = await updateActivity(body.key, body as Partial<ActivityInput> & { active?: boolean }, isOwner(admin) ? { ...who, platform: true } : who);
  if (!changed.ok) return NextResponse.json({ error: changed.error }, { status: changed.error === "Activity not found." ? 404 : 403 });
  await logAction(admin, {
    venueId: who.venueId,
    action: "activity.changed",
    detail: `${changed.activity.names.en} (${changed.activity.key})${changed.activity.active ? "" : ", no longer offered"}`,
  });
  return NextResponse.json({ activity: changed.activity });
}
