import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { updateVenue } from "@/lib/store";
import { CLOSE_HOUR, MAX_CANCEL_CUTOFF_HOURS, MAX_EMERGENCY_INFO, OPEN_HOUR } from "@/lib/types";

export const dynamic = "force-dynamic";

const FIELDS = ["name", "area", "address", "phone"] as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  const changes: {
    name?: string;
    area?: string;
    address?: string;
    phone?: string;
    cancelCutoffHours?: number;
    openHour?: number;
    closeHour?: number;
    staffedFrom?: number | null;
    staffedTo?: number | null;
    emergencyPhone?: string | null;
    emergencyInfo?: string | null;
  } = {};
  for (const field of FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length < 2)
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
    changes[field] = value;
  }

  const cutoff = input.cancelCutoffHours;
  if (cutoff !== undefined) {
    if (!Number.isInteger(cutoff) || (cutoff as number) < 0 || (cutoff as number) > MAX_CANCEL_CUTOFF_HOURS)
      return NextResponse.json(
        { error: `Cancellation cutoff must be 0–${MAX_CANCEL_CUTOFF_HOURS} hours.` },
        { status: 400 }
      );
    changes.cancelCutoffHours = cutoff as number;
  }

  for (const field of ["openHour", "closeHour"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < OPEN_HOUR || (value as number) > CLOSE_HOUR)
      return NextResponse.json(
        { error: `Opening hours must be whole hours between ${OPEN_HOUR} and ${CLOSE_HOUR}.` },
        { status: 400 }
      );
    changes[field] = value as number;
  }

  // null on both ends means "always staffed", which is every venue by default.
  for (const field of ["staffedFrom", "staffedTo"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === null) {
      changes[field] = null;
      continue;
    }
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 24)
      return NextResponse.json(
        { error: "A staffed hour must be a whole hour between 0 and 24." },
        { status: 400 }
      );
    changes[field] = value as number;
  }

  for (const field of ["emergencyPhone", "emergencyInfo"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string")
      return NextResponse.json({ error: `${field} must be text, or null.` }, { status: 400 });
    if (typeof value === "string" && value.length > MAX_EMERGENCY_INFO)
      return NextResponse.json(
        { error: `That is too long — keep it under ${MAX_EMERGENCY_INFO} characters.` },
        { status: 400 }
      );
    changes[field] = value as string | null;
  }

  if (Object.keys(changes).length === 0)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const result = await updateVenue(venueId, changes);
  if (!result.ok)
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "Venue not found." ? 404 : 400 }
    );
  return NextResponse.json({ venue: result.venue });
}
