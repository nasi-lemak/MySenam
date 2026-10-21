import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { cancelUserBooking } from "@/lib/store";
import { currentLocale } from "@/lib/locale";
import { notifyBookingCancelled, tickOutbox } from "@/lib/notify";
import { refundCancelled } from "@/lib/payments";

export const dynamic = "force-dynamic";

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
  if (!Number.isInteger(bookingId))
    return NextResponse.json({ error: "bookingId is required." }, { status: 400 });

  const result = await cancelUserBooking(user.id, bookingId as number);
  if (!result.ok) return refusal(result);
  // Money paid online goes back as the venue chose, before the customer is told.
  const refunds = await refundCancelled([result.booking.id]);

  await notifyBookingCancelled(result.booking, await currentLocale(), { kept: result.kept ?? null, refunds });
  // A cancellation is what frees a place, so it is also what makes an
  // offer worth telling somebody about.
  await tickOutbox();
  return NextResponse.json({ booking: result.booking, kept: result.kept ?? null, refunds });
}
