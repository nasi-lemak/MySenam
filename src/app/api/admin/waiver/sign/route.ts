import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { getBookingById, getCourt } from "@/lib/store";
import { signWaiver } from "@/lib/waivers";

export const dynamic = "force-dynamic";

/** `{ bookingId }`: the customer signed the venue's waiver on paper at the desk (lib/waivers.ts). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const booking = body && Number.isInteger(body.bookingId) ? await getBookingById(body.bookingId as number) : null;
  const court = booking ? await getCourt(booking.courtId) : null;
  if (!booking || !court) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;
  if (!(await signWaiver(court.venueId, { phone: booking.phone, name: booking.name, bookingId: booking.id, adminId: admin.id })))
    return NextResponse.json({ error: "This venue asks for no waiver." }, { status: 409 });
  await logAction(admin, { venueId: court.venueId, action: "waiver.signed", bookingCode: booking.code, detail: `${booking.name} signed the waiver on paper` });
  return NextResponse.json({ ok: true });
}
