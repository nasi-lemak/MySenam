import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { describePolicy, policiesFor, sportPolicyAt, updatePolicy, venuePolicyLevels, type PolicyScope } from "@/lib/booking-policy";
import { getDb } from "@/lib/db";
import { getCourt } from "@/lib/store";
import { type Sport } from "@/lib/types";
import { courtOffers, courtSports, sportsOf } from "@/lib/court-activities";

export const dynamic = "force-dynamic";

/**
 * A venue's booking policies (lib/booking-policy.ts): when bookings may
 * start, how long they run, buffers, notice, sign-offs, and how their time
 * is priced. Each level inherits what it leaves unset: one activity on one
 * court from the court, the court from its activity at the venue, that from
 * the venue, the venue from its business, and the business from the
 * activity's usual rules in the catalogue.
 *
 * `?venueId` → each level's own settings, and what each court (for its main
 * activity), each activity, and each activity on each court comes to.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const courts = (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ? ORDER BY id").all(venueId)) as { id: number }[];
  const full = (await Promise.all(courts.map((c) => getCourt(c.id)))).filter((c) => c !== null);
  const resolved = await policiesFor(full.map((c) => ({ id: c.id, venueId: c.venueId, sport: c.sport })));
  const sports = sportsOf(full);
  const bySport = Object.fromEntries(await Promise.all(sports.map(async (s) => [s, await sportPolicyAt(venueId, s)])));
  // Each activity on each court that offers more than one.
  const products: Record<number, Record<string, unknown>> = {};
  for (const c of full)
    for (const sport of courtSports(c).slice(1)) {
      const p = (await policiesFor([{ id: c.id, venueId: c.venueId, sport }])).get(c.id)!;
      (products[c.id] ??= {})[sport] = { ...p, summary: describePolicy(p) };
    }
  return NextResponse.json(
    {
      levels: await venuePolicyLevels(venueId),
      effective: {
        sports: bySport,
        courts: Object.fromEntries([...resolved].map(([id, p]) => [id, { ...p, summary: describePolicy(p) }])),
        products,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `{ venueId, level: "business" | "venue" | "sport" | "court", sport?, courtId?, settings }`:
 * change one level's settings (managers). A court with `sport` is that
 * activity on that court alone. A setting given as null goes back
 * to inheriting; one left out is kept. Bookings already made keep the time
 * and price they were made at.
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
  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return NextResponse.json({ error: "settings must be an object." }, { status: 400 });

  let scope: PolicyScope;
  let label: string;
  switch (body.level) {
    case "business": {
      // Every branch inherits it: for whoever runs the business (or the platform).
      const venue = (await getDb().prepare("SELECT business_id FROM venues WHERE id = ?").get(venueId)) as { business_id: number | null } | undefined;
      const business = venue?.business_id ?? null;
      if (business === null) return NextResponse.json({ error: "This venue is not part of a business." }, { status: 400 });
      if (!isOwner(admin) && admin.businessId !== business)
        return NextResponse.json({ error: "Only whoever runs the business sets rules for every branch." }, { status: 403 });
      scope = { business };
      label = "every branch";
      break;
    }
    case "venue":
      scope = { venue: venueId };
      label = "the venue";
      break;
    case "sport":
      if (typeof body.sport !== "string" || !(await isActivity(body.sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
      scope = { venue: venueId, sport: body.sport as Sport };
      label = body.sport;
      break;
    case "court": {
      const court = Number.isInteger(body.courtId) ? await getCourt(body.courtId as number) : null;
      if (!court || court.venueId !== venueId) return NextResponse.json({ error: "Court not found." }, { status: 404 });
      if (body.sport !== undefined && body.sport !== null) {
        if (typeof body.sport !== "string" || !courtOffers(court, body.sport))
          return NextResponse.json({ error: `${court.name} is not booked for that.` }, { status: 400 });
        scope = { court: court.id, sport: body.sport };
        label = `${body.sport} on ${court.name}`;
      } else {
        scope = { court: court.id };
        label = court.name;
      }
      break;
    }
    default:
      return NextResponse.json({ error: "level is business, venue, sport or court." }, { status: 400 });
  }
  const saved = await updatePolicy(scope, settings as Record<string, unknown>);
  if (!saved.ok) return NextResponse.json(saved, { status: 400 });
  await logAction(admin, { venueId, action: "settings.changed", detail: `Booking rules for ${label}: ${JSON.stringify(settings).slice(0, 400)}` });
  return NextResponse.json({ settings: saved.settings });
}
