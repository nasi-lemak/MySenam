import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { findBooking } from "@/lib/store";
import { currentLocale } from "@/lib/locale";
import { cancelMovedLesson } from "@/lib/lesson-venue-moves";
import { notifyBookingCancelled, tickOutbox } from "@/lib/notify";
import { refundCancelled } from "@/lib/payments";
import { counterRefundLines } from "@/lib/counter-refunds";

export const dynamic = "force-dynamic";

/**
 * `{ code, phone }`: the customer cancels a lesson the venue moved, with everything back, within the window the move opened
 * (lib/lesson-venue-moves.ts). Their own act: nothing is refunded for them. Through the venue's own cancellation path: no late share, no
 * strike; online money goes back through the venue's gateway where it can and is otherwise owed for staff, credit and passes are restored,
 * a counter payment is owed back for the desk to hand over. `LESSON_MOVE_NO_OFFER` when no window is open.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, phone } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== "string" || typeof phone !== "string") return NextResponse.json({ error: "code and phone are required." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const booking = await findBooking(code, phone);
  if (!booking) return NextResponse.json({ error: "Booking not found. Check the code and phone number." }, { status: 404 });
  const result = await cancelMovedLesson(booking);
  if (!result.ok) return refusal(result);
  // Online money goes back as the venue's policy for what it cancels has it, before the customer is told.
  const refunds = [...(await refundCancelled([result.booking.id], { byVenue: true })), ...(await counterRefundLines([result.booking.id]))];
  await notifyBookingCancelled(result.booking, await currentLocale(), { refunds });
  await tickOutbox();
  return NextResponse.json({ booking: result.booking, refunds });
}
