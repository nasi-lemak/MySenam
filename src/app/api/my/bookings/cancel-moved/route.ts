import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { cancelMovedLesson } from "@/lib/lesson-venue-moves";
import { currentLocale } from "@/lib/locale";
import { notifyBookingCancelled, tickOutbox } from "@/lib/notify";
import { refundCancelled } from "@/lib/payments";
import { counterRefundLines } from "@/lib/counter-refunds";
import { getBookingById } from "@/lib/store";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * `{ bookingId }`: a signed-in customer cancels a lesson of theirs the venue moved, with everything back, within the window the move
 * opened: as `POST /api/bookings/cancel-moved`, for a booking on their own account.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { bookingId } = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(bookingId)) return NextResponse.json({ error: "bookingId is required." }, { status: 400 });
  const mine = (await getDb().prepare("SELECT 1 AS x FROM bookings WHERE id = ? AND user_id = ?").get(bookingId, user.id)) as { x: number } | undefined;
  const booking = mine ? await getBookingById(bookingId as number) : null;
  if (!booking) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const result = await cancelMovedLesson(booking);
  if (!result.ok) return refusal(result);
  const refunds = [...(await refundCancelled([result.booking.id], { byVenue: true })), ...(await counterRefundLines([result.booking.id]))];
  await notifyBookingCancelled(result.booking, await currentLocale(), { refunds });
  await tickOutbox();
  return NextResponse.json({ booking: result.booking, refunds });
}
