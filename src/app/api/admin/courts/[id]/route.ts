import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getCourt, updateCourt } from "@/lib/store";
import { MAX_CAPACITY } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_RATE = 1000;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const courtId = Number(id);
  if (!Number.isInteger(courtId) || courtId <= 0)
    return NextResponse.json({ error: "Invalid court id." }, { status: 400 });

  const court = getCourt(courtId);
  if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { name, offPeakRate, peakRate, capacity } = (body ?? {}) as Record<string, unknown>;

  const changes: {
    name?: string;
    offPeakRate?: number;
    peakRate?: number;
    capacity?: number;
  } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length < 2)
      return NextResponse.json({ error: "Court name is too short." }, { status: 400 });
    changes.name = name;
  }
  for (const [key, rate] of [["offPeakRate", offPeakRate], ["peakRate", peakRate]] as const) {
    if (rate !== undefined) {
      if (!Number.isInteger(rate) || (rate as number) < 1 || (rate as number) > MAX_RATE)
        return NextResponse.json({ error: `${key} must be RM1–${MAX_RATE}.` }, { status: 400 });
      changes[key] = rate as number;
    }
  }
  if (capacity !== undefined) {
    if (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > MAX_CAPACITY)
      return NextResponse.json(
        { error: `Capacity must be 1–${MAX_CAPACITY}.` },
        { status: 400 }
      );
    changes.capacity = capacity as number;
  }

  if (Object.keys(changes).length === 0)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const result = updateCourt(courtId, changes);
  if (!result.ok)
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "Court not found." ? 404 : 409 }
    );
  return NextResponse.json({ court: result.court });
}
