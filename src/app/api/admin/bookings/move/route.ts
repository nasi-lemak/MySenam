import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getCourt, getVenueIdForBookingCode, moveBooking, moveTargetsFor } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Courts this booking could move to, for the staff picker. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json({ error: "code is required." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  return NextResponse.json({ courts: await moveTargetsFor(code) });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, courtId } = (body ?? {}) as Record<string, unknown>;

  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  if (!Number.isInteger(courtId) || (courtId as number) <= 0)
    return NextResponse.json({ error: "courtId is required." }, { status: 400 });

  // Scope on both ends: the admin must manage the booking's venue, and the
  // target court must belong to it too.
  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  const target = await getCourt(courtId as number);
  if (!target) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const deniedTarget = denyVenue(admin, target.venueId);
  if (deniedTarget) return deniedTarget;

  const result = await moveBooking(code, courtId as number);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({
    booking: result.booking,
    from: result.fromCourt.name,
    to: result.toCourt.name,
  });
}
