import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { claimWaitlistOffer, getClass, getCourt, getVenue } from "@/lib/store";
import { holdNewBookings, holdPolicy } from "@/lib/holds";
import { struckOut } from "@/lib/cancel-policy";
import { getDb } from "@/lib/db";
import { takesPaymentOnline } from "@/lib/payments";
import { claimHold, describeOffer } from "@/lib/waitlist-offer";
import { bookingLinkToken } from "@/lib/booking-access";
import { refuse } from "@/lib/entitlements";
import { notifyBookingConfirmed, rememberLocale, tickOutbox } from "@/lib/notify";
import { currentLocale } from "@/lib/locale";
import { isLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/** Booked without an account (an entry a guest made, or the counter or the API). */
async function withoutAccount(bookingId: number): Promise<boolean> {
  const row = (await getDb().prepare("SELECT user_id FROM bookings WHERE id = ?").get(bookingId)) as { user_id: number | null } | undefined;
  return !row || row.user_id === null;
}

/**
 * `?token` → what the offer is, before it is claimed (lib/waitlist-offer.ts):
 * the venue, the court or class, the day and time, who it is for, the price
 * now, until when it stands, and whether claiming it holds the booking until
 * it is paid online, and for how long. Changes nothing; the token is the only
 * way in, as for claiming.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token || token.trim() === "") return NextResponse.json({ error: "token is required." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const found = await describeOffer(token);
  if (!found.ok) return refusal(refuse(found.code), found.code === "OFFER_INVALID" ? 404 : 410);
  return NextResponse.json({ offer: found.offer }, { headers: { "Cache-Control": "no-store" } });
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
  // So is one from a number past its no-shows, or without an account while the venue is flooded with unpaid guest bookings
  // (lib/limits.ts): the same rule the offer page said before the claim (lib/waitlist-offer.ts).
  const hold = await claimHold(court.venueId, booking.phone, !(await withoutAccount(booking.id)));
  const unpaid = bookings.filter((b) => b.paymentStatus === "unpaid" && b.totalPrice > 0);
  const holdUntil = unpaid.length > 0 && hold.hold ? await holdNewBookings(unpaid.map((b) => b.id), hold.minutes) : null;
  if (holdUntil) for (const b of unpaid) b.holdUntil = holdUntil;
  const locale = result.entry.locale && isLocale(result.entry.locale) ? result.entry.locale : await currentLocale();
  await rememberLocale(bookings.map((b) => b.id), locale);
  if (!holdUntil) for (const b of bookings) await notifyBookingConfirmed([b], locale, null);
  await tickOutbox();

  const venue = (await getVenue(court.venueId))!;
  return NextResponse.json({
    holdUntil,
    booking: result.booking,
    bookings,
    session: result.booking.classId ? await getClass(result.booking.classId) : null,
    // For the page to say it as the booking form's confirmation does: where, and how to pay while it is held.
    court: { id: court.id, name: court.name },
    venue: { id: venue.id, name: venue.name, area: venue.area, timeZone: venue.timeZone },
    payOnline: await takesPaymentOnline(court.venueId),
    depositPercent: holdUntil && policy.active && !(await struckOut(court.venueId, booking.phone)).out ? policy.depositPercent : null,
    // Its own signed link, to pay with and to open it on My Booking (lib/booking-access.ts).
    link: bookingLinkToken(booking.code, booking.date),
  });
}
