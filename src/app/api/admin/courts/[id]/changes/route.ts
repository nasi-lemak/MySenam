import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject } from "@/lib/api";
import { listCourtChanges, setCourtHoursChange, setCourtRates } from "@/lib/dated-changes";
import { courtScope, datedRefusal } from "@/lib/dated-changes-routes";

export const dynamic = "force-dynamic";

/** The court's rates and own hours set from later dates, soonest first (ADR 0027). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scoped = await courtScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  const mine = (await listCourtChanges(scoped.court.venueId)).find((c) => c.courtId === scoped.court.id);
  return NextResponse.json({ rates: mine?.rates ?? [], hours: mine?.hours ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * From a later date (managers), as a whole:
 * `{ kind: "rates", from, offPeakRate, peakRate, memberOffPeakRate?, memberPeakRate?, activities? }`, the court's
 * rates and its other activities' own rates; bookings already made keep their price.
 * `{ kind: "hours", from, weekHours }`, its own hours by weekday (null: the venue's), refused with every booking listed
 * while bookings already made on the dates it changes would fall outside them.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scoped = await courtScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  const { admin, court } = scoped;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (body.kind === "hours") {
    const done = await setCourtHoursChange(court, { from: body.from, weekHours: body.weekHours });
    if (!done.ok) return datedRefusal(done);
    await logAction(admin, { venueId: court.venueId, action: "hours.scheduled", detail: `${court.name}'s own hours from ${done.change.from}: ${done.now}` });
    return NextResponse.json({ change: done.change }, { status: 201 });
  }
  if (body.kind !== "rates") return NextResponse.json({ error: "kind is rates or hours." }, { status: 400 });
  const done = await setCourtRates(court, {
    from: body.from,
    offPeakRate: body.offPeakRate,
    peakRate: body.peakRate,
    memberOffPeakRate: body.memberOffPeakRate,
    memberPeakRate: body.memberPeakRate,
    activities: body.activities,
  });
  if (!done.ok) return datedRefusal(done);
  await logAction(admin, { venueId: court.venueId, action: "rates.scheduled", detail: `${court.name} rates from ${done.change.from}: ${done.was} → ${done.now}` });
  return NextResponse.json({ change: done.change }, { status: 201 });
}
