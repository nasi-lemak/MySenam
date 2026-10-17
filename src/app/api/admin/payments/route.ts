import { NextRequest, NextResponse } from "next/server";
import { canAccessVenue, denyVenue, requireAdmin } from "@/lib/admin-auth";
import {
  getVenueIdForBookingCode,
  getVenueIdsForSeriesCode,
  paySeries,
  setPaymentStatus,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, seriesCode, paid } = (body ?? {}) as Record<string, unknown>;

  if (typeof seriesCode === "string" && seriesCode.trim() !== "") {
    const venueIds = await getVenueIdsForSeriesCode(seriesCode);
    if (venueIds.length === 0)
      return NextResponse.json({ error: "Series not found." }, { status: 404 });
    if (!venueIds.every((id) => canAccessVenue(admin, id)))
      return NextResponse.json({ error: "You do not manage that venue." }, { status: 403 });

    const result = await paySeries(seriesCode);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ paid: result.paid });
  }

  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code or seriesCode is required." }, { status: 400 });
  if (typeof paid !== "boolean")
    return NextResponse.json({ error: "paid must be true or false." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  const result = await setPaymentStatus(code, paid);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ booking: result.booking });
}
