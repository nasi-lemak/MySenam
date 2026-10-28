import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { notifyVenueCancelled } from "@/lib/notify";
import { bookingForVenue } from "@/lib/public-api";
import { venueCancel } from "@/lib/counter-refunds";
import { refundCancelled } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * Cancel one of the venue's bookings, as its staff would (write keys). The customer is told. A counter payment on it
 * is owed back, for the desk to hand back or give as credit (lib/counter-refunds.ts `venueCancel`).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const caller = await apiCaller(req, "write");
  if (caller instanceof NextResponse) return caller;
  const code = (await params).code;
  if (!(await bookingForVenue(caller.venueId, code))) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const done = await venueCancel(code, "api");
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: 409 });
  await refundCancelled([done.booking.id], { byVenue: true });
  await notifyVenueCancelled(done.booking);
  return NextResponse.json({ booking: await bookingForVenue(caller.venueId, code) });
}
