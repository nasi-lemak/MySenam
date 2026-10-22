import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { claimWaitlistOffer, getClass, getCourt } from "@/lib/store";
import { holdNewBookings, holdPolicy } from "@/lib/holds";
import { struckOut } from "@/lib/cancel-policy";
import { takesPaymentOnline } from "@/lib/payments";
import { notifyBookingConfirmed, rememberLocale, tickOutbox } from "@/lib/notify";
import { currentLocale } from "@/lib/locale";
import { isLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { token } = (body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || token.trim() === "")
    return NextResponse.json({ error: "token is required." }, { status: 400 });

  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = await claimWaitlistOffer(token);
  if (!result.ok) return refusal(result);

  // From here, as any booking: held until paid where the venue asks that (or
  // the number has too many no-shows), confirmed otherwise, in their language.
  const booking = result.booking;
  const court = (await getCourt(booking.courtId))!;
  const policy = await holdPolicy(court.venueId);
  const mustPay = (await struckOut(court.venueId, booking.phone)).out && (await takesPaymentOnline(court.venueId));
  const holdUntil =
    booking.paymentStatus === "unpaid" && booking.totalPrice > 0 && (policy.active || mustPay)
      ? await holdNewBookings([booking.id], policy.minutes)
      : null;
  if (holdUntil) booking.holdUntil = holdUntil;
  const locale = result.entry.locale && isLocale(result.entry.locale) ? result.entry.locale : await currentLocale();
  await rememberLocale([booking.id], locale);
  if (!holdUntil) await notifyBookingConfirmed([booking], locale, null);
  await tickOutbox();

  return NextResponse.json({
    holdUntil,
    booking: result.booking,
    session: result.booking.classId ? await getClass(result.booking.classId) : null,
  });
}
