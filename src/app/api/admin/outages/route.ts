import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createOutage, endOutage, listOutages, outageById, outagesMissingLateHours, repairLateHours } from "@/lib/outages";
import { formatMinute } from "@/lib/interval";
import { getCourt } from "@/lib/store";
import { jsonObject } from "@/lib/api";
import { logAction, logCancelledBookings, logClassCancelled, logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

/**
 * `?venueId=` — its courts' outages, now and to come, and `lateHoursOpen`:
 * the ids of those whose last night's late hours are not closed (outages
 * from before migration 0090; `PATCH` closes them).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({
    outages: await listOutages([venueId]),
    lateHoursOpen: (await outagesMissingLateHours([venueId])).map((m) => m.outage.id),
  });
}

/**
 * `{ venueId, id? }` — close the late hours of the last night of this
 * venue's outages (or of one) where they are free, as a court taken out now
 * would; answers `repairs`, each with what it `claimed` and the bookings and
 * classes there (`collisions`), which are left as they are.
 */
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await jsonObject(req).catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (body.id !== undefined && !Number.isInteger(body.id)) return NextResponse.json({ error: "id must be a number." }, { status: 400 });
  const repairs = await repairLateHours({ venueIds: [venueId], ...(body.id !== undefined ? { outageId: body.id as number } : {}) });
  for (const r of repairs.filter((x) => x.claimed.length > 0))
    await logFromRequest(req, {
      venueId,
      action: "settings.changed",
      detail: `${r.courtName} out of service: the late hours after ${r.date} closed too (${r.claimed.map((s) => `${formatMinute(s.start)}–${formatMinute(s.end)}`).join(", ")})${
        r.collisions.length > 0 ? `; ${r.collisions.length} booking(s) or class(es) there left as they are` : ""
      }`,
    });
  return NextResponse.json({ repairs });
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
    body = (await jsonObject(req)) as Record<string, unknown>;
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
    safety: body.safety === true,
  });
  if (!result.ok)
    return NextResponse.json({ error: result.error, affected: result.affected }, { status: result.affected ? 409 : 400 });
  await logFromRequest(req, {
    venueId: court.venueId,
    action: "settings.changed",
    detail: `${court.name} out of service ${body.startsOn as string}${body.endsOn ? ` to ${body.endsOn as string}` : ", until further notice"}${body.safety === true ? " [safety closure]" : ""}`,
  });
  // Each booking and class it called off, under its own code (as a closed day's are).
  const why = `${court.name} out of service`;
  for (const c of result.classesOff ?? []) await logClassCancelled(admin, c.session, c.enrolments, why);
  await logCancelledBookings(admin, court.venueId, result.bookingsOff ?? [], why);
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
  await logAction(admin, { venueId: outage.venueId, action: "settings.changed", detail: `${outage.courtName} back in service (out from ${outage.startsOn})` });
  return NextResponse.json({ ok: true });
}
