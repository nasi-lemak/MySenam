import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject } from "@/lib/api";
import { listHoursChanges, setHoursChange } from "@/lib/dated-changes";
import { datedRefusal, venueScope } from "@/lib/dated-changes-routes";

export const dynamic = "force-dynamic";

/** The venue's opening hours set from later dates, soonest first (ADR 0027). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scoped = await venueScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  return NextResponse.json({ changes: await listHoursChanges(scoped.venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ from, openMin, closeMin, weekHours? }`: the venue's hours from a later
 * date, as a whole (managers). Refused, with every booking listed, while
 * bookings already made on the dates it changes would fall outside them.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scoped = await venueScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const done = await setHoursChange(scoped.venueId, { from: body.from, openMin: body.openMin, closeMin: body.closeMin, weekHours: body.weekHours });
  if (!done.ok) return datedRefusal(done);
  await logAction(scoped.admin, { venueId: scoped.venueId, action: "hours.scheduled", detail: `Opening hours from ${done.change.from}: ${done.was} → ${done.now}` });
  return NextResponse.json({ change: done.change }, { status: 201 });
}
