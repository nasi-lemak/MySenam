import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { claimWaitlistOffer, getClass, getCourt } from "@/lib/store";
import { holdNewBookings, holdPolicy } from "@/lib/holds";
import { struckOut } from "@/lib/cancel-policy";
import { guestSurge } from "@/lib/limits";
import { getDb } from "@/lib/db";
import { takesPaymentOnline } from "@/lib/payments";
import { notifyBookingConfirmed, rememberLocale, tickOutbox } from "@/lib/notify";
import { currentLocale } from "@/lib/locale";
import { isLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/** Booked without an account (an entry a guest made, or the counter or the API). */
async function withoutAccount(bookingId: number): Promise<boolean> {
  const row = (await getDb().prepare("SELECT user_id FROM bookings WHERE id = ?").get(bookingId)) as { user_id: number | null } | undefined;
  return !row || row.user_id === null;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { token, agreeWaiver } = (body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || token.trim() === "")
    return NextResponse.json({ error: "token is required." }, { status: 400 });

  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;

  // The venue's waiver is asked here, where the booking is made: ticked on the claim page (lib/store.ts).
  const result = await claimWaitlistOffer(token, { agreeWaiver: agreeWaiver === true });
  if (!result.ok) return refusal(result);

  // From here, as any booking: held until paid where the venue asks that (or
  // the number has too many no-shows), confirmed otherwise, in their language.
  // Every place the entry waited for: a class enrolment each, or one booking of them all.
  const booking = result.booking;
  const bookings = result.bookings;
  const court = (await getCourt(booking.courtId))!;
  const policy = await holdPolicy(court.venueId);
  // So is one from a number past its no-shows, or without an account while the venue is flooded with unpaid guest bookings (lib/limits.ts).
  const mustPay =
    ((await struckOut(court.venueId, booking.phone)).out || ((await withoutAccount(booking.id)) && (await guestSurge(court.venueId)))) &&
    (await takesPaymentOnline(court.venueId));
  const unpaid = bookings.filter((b) => b.paymentStatus === "unpaid" && b.totalPrice > 0);
  const holdUntil = unpaid.length > 0 && (policy.active || mustPay) ? await holdNewBookings(unpaid.map((b) => b.id), policy.minutes) : null;
  if (holdUntil) for (const b of unpaid) b.holdUntil = holdUntil;
  const locale = result.entry.locale && isLocale(result.entry.locale) ? result.entry.locale : await currentLocale();
  await rememberLocale(bookings.map((b) => b.id), locale);
  if (!holdUntil) for (const b of bookings) await notifyBookingConfirmed([b], locale, null);
  await tickOutbox();

  return NextResponse.json({
    holdUntil,
    booking: result.booking,
    bookings,
    session: result.booking.classId ? await getClass(result.booking.classId) : null,
  });
}
