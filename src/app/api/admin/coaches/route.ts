import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { listCoaches, retireCoach, saveCoach } from "@/lib/coaching";
import { coachContacts, setCoachEmail, setCoachLink } from "@/lib/coach-schedule";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  return denied ?? { admin, venueId };
}

/** `?venueId` → the venue's coaches, those retired last. */
export async function GET(req: NextRequest) {
  const v = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (v instanceof NextResponse) return v;
  return NextResponse.json({ coaches: await listCoaches(v.venueId), contacts: Object.fromEntries(await coachContacts(v.venueId)) });
}

/**
 * `{ venueId, id?, name, bio?, sports, rate, hours: [{ weekday, from, until }] }`: add a coach, or change one.
 * `{ venueId, id, action: "email", email }`: where they hear of lessons.
 * `{ venueId, id, action: "link", on }`: their private schedule link, made afresh or withdrawn.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const v = await venueOf(req, body.venueId);
  if (v instanceof NextResponse) return v;
  if (body.action === "email" || body.action === "link") {
    if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
    if (body.action === "email") {
      const set = await setCoachEmail(body.id as number, v.venueId, body.email);
      if (!set.ok) return NextResponse.json(set, { status: 400 });
    } else if (!(await setCoachLink(body.id as number, v.venueId, body.on === true))) {
      return NextResponse.json({ error: "Coach not found." }, { status: 404 });
    }
    await logAction(v.admin, { venueId: v.venueId, action: "settings.changed", detail: `Coach ${body.id}: ${body.action === "email" ? "email" : body.on === true ? "new schedule link" : "schedule link withdrawn"}` });
    return NextResponse.json({ coaches: await listCoaches(v.venueId), contacts: Object.fromEntries(await coachContacts(v.venueId)) });
  }
  const result = await saveCoach(v.venueId, {
    id: body.id,
    name: body.name,
    bio: body.bio,
    sports: body.sports,
    rate: body.rate,
    hours: body.hours,
  });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  await logAction(v.admin, { venueId: v.venueId, action: "settings.changed", detail: `Coach: ${result.coach.name}` });
  return NextResponse.json({ coach: result.coach, coaches: await listCoaches(v.venueId) });
}

/** `?venueId&id`: no more lessons with them; those booked stand. */
export async function DELETE(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const v = await venueOf(req, p.get("venueId"));
  if (v instanceof NextResponse) return v;
  if (!(await retireCoach(Number(p.get("id")), v.venueId))) return NextResponse.json({ error: "Coach not found." }, { status: 404 });
  await logAction(v.admin, { venueId: v.venueId, action: "settings.changed", detail: `Coach retired: ${p.get("id")}` });
  return NextResponse.json({ coaches: await listCoaches(v.venueId) });
}
