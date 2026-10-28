import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, type Admin } from "./admin-auth";
import { NOT_WAITING, type DatedRefusal } from "./dated-changes";
import { getCourt } from "./store";
import type { Court } from "./types";

/** What the routes for hours and rates from a date share (lib/dated-changes.ts, ADR 0027). */

/** The venue in the path, checked: this member of staff may touch it. */
export async function venueScope(req: NextRequest, params: Promise<{ id: string }>): Promise<{ admin: Admin; venueId: number } | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number((await params).id);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return { admin, venueId };
}

/** The court in the path, checked: this member of staff may touch its venue. */
export async function courtScope(req: NextRequest, params: Promise<{ id: string }>): Promise<{ admin: Admin; court: Court } | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const courtId = Number((await params).id);
  if (!Number.isInteger(courtId) || courtId <= 0) return NextResponse.json({ error: "Invalid court id." }, { status: 400 });
  const court = await getCourt(courtId);
  if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;
  return { admin, court };
}

/** The change id in the path, or null. */
export async function changeIdOf(params: Promise<{ changeId?: string }>): Promise<number | null> {
  const id = Number((await params).changeId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export { NOT_WAITING };

/** A refusal, with every booking it would leave outside the hours, for staff to move or cancel. */
export function datedRefusal(r: DatedRefusal): NextResponse {
  const missing = r.error === "Venue not found." || r.error === "Court not found." || r.error === NOT_WAITING;
  return NextResponse.json({ error: r.error, ...(r.stranded ? { stranded: r.stranded } : {}) }, { status: r.stranded ? 409 : missing ? 404 : 400 });
}
