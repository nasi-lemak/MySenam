import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject } from "@/lib/api";
import { setHoursChange, withdrawHoursChange } from "@/lib/dated-changes";
import { NOT_WAITING, changeIdOf, datedRefusal, venueScope } from "@/lib/dated-changes-routes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; changeId?: string }> };

/** `{ from, openMin, closeMin, weekHours? }`: change hours set from a later date, not yet in force (managers). */
export async function PATCH(req: NextRequest, { params }: Params) {
  const scoped = await venueScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  const id = await changeIdOf(params);
  if (id === null) return NextResponse.json({ error: NOT_WAITING }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const done = await setHoursChange(scoped.venueId, { id, from: body.from, openMin: body.openMin, closeMin: body.closeMin, weekHours: body.weekHours });
  if (!done.ok) return datedRefusal(done);
  await logAction(scoped.admin, { venueId: scoped.venueId, action: "hours.scheduled", detail: `Opening hours from ${done.change.from}: ${done.was} → ${done.now}` });
  return NextResponse.json({ change: done.change });
}

/** Withdraw hours set from a later date, not yet in force (managers): the hours before it stay. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const scoped = await venueScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  const id = await changeIdOf(params);
  if (id === null) return NextResponse.json({ error: NOT_WAITING }, { status: 404 });
  const done = await withdrawHoursChange(scoped.venueId, id);
  if (!done.ok) return datedRefusal(done);
  await logAction(scoped.admin, { venueId: scoped.venueId, action: "hours.withdrawn", detail: `Opening hours from ${done.change.from} withdrawn: ${done.then} stay` });
  return NextResponse.json({ ok: true });
}
