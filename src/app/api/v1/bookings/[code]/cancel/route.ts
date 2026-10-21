import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { notifyVenueCancelled } from "@/lib/notify";
import { bookingForVenue } from "@/lib/public-api";
import { adminCancelBooking } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Cancel one of the venue's bookings, as its staff would (write keys). The customer is told. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const caller = await apiCaller(req, "write");
  if (caller instanceof NextResponse) return caller;
  const code = (await params).code;
  if (!(await bookingForVenue(caller.venueId, code))) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const done = await adminCancelBooking(code);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: 409 });
  await notifyVenueCancelled(done.booking);
  return NextResponse.json({ booking: await bookingForVenue(caller.venueId, code) });
}
