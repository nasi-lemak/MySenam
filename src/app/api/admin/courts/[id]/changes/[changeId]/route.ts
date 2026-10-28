import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject } from "@/lib/api";
import { setCourtHoursChange, setCourtRates, withdrawCourtChange } from "@/lib/dated-changes";
import { NOT_WAITING, changeIdOf, courtScope, datedRefusal } from "@/lib/dated-changes-routes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; changeId?: string }> };

/** Change rates or own hours set from a later date, not yet in force (managers): the same body as adding one. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const scoped = await courtScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  const { admin, court } = scoped;
  const id = await changeIdOf(params);
  if (id === null) return NextResponse.json({ error: NOT_WAITING }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (body.kind === "hours") {
    const done = await setCourtHoursChange(court, { id, from: body.from, weekHours: body.weekHours });
    if (!done.ok) return datedRefusal(done);
    await logAction(admin, { venueId: court.venueId, action: "hours.scheduled", detail: `${court.name}'s own hours from ${done.change.from}: ${done.now}` });
    return NextResponse.json({ change: done.change });
  }
  if (body.kind !== "rates") return NextResponse.json({ error: "kind is rates or hours." }, { status: 400 });
  const done = await setCourtRates(court, {
    id,
    from: body.from,
    offPeakRate: body.offPeakRate,
    peakRate: body.peakRate,
    memberOffPeakRate: body.memberOffPeakRate,
    memberPeakRate: body.memberPeakRate,
    activities: body.activities,
  });
  if (!done.ok) return datedRefusal(done);
  await logAction(admin, { venueId: court.venueId, action: "rates.scheduled", detail: `${court.name} rates from ${done.change.from}: ${done.was} → ${done.now}` });
  return NextResponse.json({ change: done.change });
}

/** Withdraw rates or own hours set from a later date, not yet in force (managers). */
export async function DELETE(req: NextRequest, { params }: Params) {
  const scoped = await courtScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  const { admin, court } = scoped;
  const id = await changeIdOf(params);
  if (id === null) return NextResponse.json({ error: NOT_WAITING }, { status: 404 });
  const done = await withdrawCourtChange(court, id);
  if (!done.ok) return datedRefusal(done);
  await logAction(admin, {
    venueId: court.venueId,
    action: done.kind === "rates" ? "rates.withdrawn" : "hours.withdrawn",
    detail: `${court.name}: ${done.kind === "rates" ? "rates" : "own hours"} from ${done.from} withdrawn`,
  });
  return NextResponse.json({ ok: true });
}
