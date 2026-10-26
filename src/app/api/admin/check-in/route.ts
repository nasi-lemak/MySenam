import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { checkIn, checkOut, getVenueIdForBookingCode, markPlace } from "@/lib/store";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

/**
 * `{ code }` checks a booking in, `{ code, out: true }` out. `{ code, placeId,
 * mark }` records one person a booking names (lib/participant-bookings.ts):
 * `arrived`, `no_show`, or `clear`; who recorded it is kept, and logged.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, out, placeId, mark } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code is required." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  if (placeId !== undefined) {
    if (!Number.isInteger(placeId) || (mark !== "arrived" && mark !== "no_show" && mark !== "clear"))
      return NextResponse.json({ error: "placeId and mark (arrived, no_show or clear) are required." }, { status: 400 });
    const marked = await markPlace(code, placeId as number, mark, { id: admin.id, name: admin.name });
    if (!marked.ok) return NextResponse.json({ error: marked.error, ...(marked.code ? { code: marked.code } : {}) }, { status: 409 });
    const who = marked.places.find((p) => p.placeId === placeId);
    await logAction(admin, { venueId, action: `attendance.${mark}`, bookingCode: marked.booking.code, detail: `${who?.name ?? "Somebody"} (place ${placeId})` });
    return NextResponse.json({ booking: marked.booking, people: marked.places });
  }

  const result = out === true ? await checkOut(code) : await checkIn(code);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ booking: result.booking });
}
