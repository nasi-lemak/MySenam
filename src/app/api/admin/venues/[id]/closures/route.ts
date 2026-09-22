import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { closeVenueDay, listVenueClosures, reopenVenueDay } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

/** Resolve the venue in the path, checking this admin may touch it. */
async function scope(
  req: NextRequest,
  params: Promise<{ id: string }>
): Promise<number | NextResponse> {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return venueId;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await scope(req, params);
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ closures: listVenueClosures(venueId, todayISO()) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await scope(req, params);
  if (venueId instanceof NextResponse) return venueId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const date = input.date;
  if (typeof date !== "string" || !isValidDateString(date))
    return NextResponse.json({ error: "A valid date is required." }, { status: 400 });
  const reason = typeof input.reason === "string" ? input.reason : undefined;

  const result = closeVenueDay(venueId, date, reason);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ closure: result.closure }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await scope(req, params);
  if (venueId instanceof NextResponse) return venueId;

  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!isValidDateString(date))
    return NextResponse.json({ error: "A valid date is required." }, { status: 400 });
  if (!reopenVenueDay(venueId, date).ok)
    return NextResponse.json({ error: "That day is not closed." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
