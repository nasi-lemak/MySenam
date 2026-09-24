import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { courtAccess, getCourt, updateCourt } from "@/lib/store";
import { MAX_ACCESS_CODE, MAX_CAPACITY, MAX_DEPOSIT, MIN_ACCESS_CODE } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_RATE = 1000;

/** One court, with the door code staff are allowed to see for it. */
export async function GET(
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

  return NextResponse.json(
    { court, access: courtAccess(courtId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

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
  const {
    name,
    offPeakRate,
    peakRate,
    capacity,
    memberOffPeakRate,
    memberPeakRate,
    deposit,
    unmanned,
    accessCode,
  } = (body ?? {}) as Record<string, unknown>;

  const changes: {
    name?: string;
    offPeakRate?: number;
    peakRate?: number;
    memberOffPeakRate?: number | null;
    memberPeakRate?: number | null;
    capacity?: number;
    deposit?: number;
    unmanned?: boolean;
    accessCode?: string | null;
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
  // null clears a member rate, putting members back on the public price.
  for (const [key, rate] of [
    ["memberOffPeakRate", memberOffPeakRate],
    ["memberPeakRate", memberPeakRate],
  ] as const) {
    if (rate === undefined) continue;
    if (rate === null) {
      changes[key] = null;
      continue;
    }
    if (!Number.isInteger(rate) || (rate as number) < 0 || (rate as number) > MAX_RATE)
      return NextResponse.json({ error: `${key} must be RM0–${MAX_RATE}, or blank.` }, { status: 400 });
    changes[key] = rate as number;
  }

  if (capacity !== undefined) {
    if (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > MAX_CAPACITY)
      return NextResponse.json(
        { error: `Capacity must be 1–${MAX_CAPACITY}.` },
        { status: 400 }
      );
    changes.capacity = capacity as number;
  }

  if (deposit !== undefined) {
    if (!Number.isInteger(deposit) || (deposit as number) < 0 || (deposit as number) > MAX_DEPOSIT)
      return NextResponse.json({ error: `A deposit must be RM0–${MAX_DEPOSIT}.` }, { status: 400 });
    changes.deposit = deposit as number;
  }

  if (unmanned !== undefined) {
    if (typeof unmanned !== "boolean")
      return NextResponse.json({ error: "unmanned must be true or false." }, { status: 400 });
    changes.unmanned = unmanned;
  }

  // null clears the code, which also closes the door on unmanned use.
  if (accessCode !== undefined) {
    if (accessCode !== null && typeof accessCode !== "string")
      return NextResponse.json({ error: "accessCode must be text, or null." }, { status: 400 });
    if (typeof accessCode === "string" && accessCode.trim() !== "") {
      const trimmed = accessCode.trim();
      if (trimmed.length < MIN_ACCESS_CODE || trimmed.length > MAX_ACCESS_CODE)
        return NextResponse.json(
          { error: `A door code must be ${MIN_ACCESS_CODE}–${MAX_ACCESS_CODE} characters.` },
          { status: 400 }
        );
    }
    changes.accessCode = accessCode as string | null;
  }

  if (Object.keys(changes).length === 0)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const result = updateCourt(courtId, changes);
  if (!result.ok)
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "Court not found." ? 404 : 409 }
    );
  return NextResponse.json(
    { court: result.court, access: courtAccess(courtId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
