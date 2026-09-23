import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  applyPromo,
  createBookingOnAnyCourt,
  createBookingSeries,
  findBooking,
  getCourt,
  getVenue,
  payBookingFromWallet,
  payBookingWithPass,
} from "@/lib/store";
import { rateLimit } from "@/lib/rate-limit";
import { isValidDateString } from "@/lib/time";
import { MAX_RECUR_WEEKS, Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { courtId, venueId, sport, date, hours, name, phone, email, weeks, skipConflicts, payFromWallet, payWithPass, promoCode } =
    (body ?? {}) as Record<string, unknown>;

  // Either name a court, or name a venue and sport and let us pick the
  // cheapest one that is free.
  const anyCourt = courtId === undefined || courtId === null;
  if (anyCourt) {
    if (!Number.isInteger(venueId) || (venueId as number) <= 0)
      return NextResponse.json(
        { error: "Give a courtId, or a venueId and sport to pick one for you." },
        { status: 400 }
      );
    if (typeof sport !== "string" || !SPORTS.includes(sport as Sport))
      return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  } else if (!Number.isInteger(courtId) || (courtId as number) <= 0) {
    return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  }
  if (typeof date !== "string" || !isValidDateString(date))
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  if (!Array.isArray(hours) || hours.some((h) => !Number.isInteger(h)))
    return NextResponse.json({ error: "hours must be an array of integers." }, { status: 400 });
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim()))
    return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });
  if (email !== undefined && email !== null && email !== "" &&
      (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
  if (weeks !== undefined &&
      (!Number.isInteger(weeks) || (weeks as number) < 1 || (weeks as number) > MAX_RECUR_WEEKS))
    return NextResponse.json(
      { error: `weeks must be between 1 and ${MAX_RECUR_WEEKS}.` },
      { status: 400 }
    );

  const limited = rateLimit(req, "booking");
  if (limited) return limited;

  const user = getSessionUser(req);
  const common = {
    date,
    hours: hours as number[],
    weeks: (weeks as number) ?? 1,
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    userId: user?.id,
    skipConflicts: skipConflicts === true,
  };

  const result = anyCourt
    ? createBookingOnAnyCourt({
        ...common,
        venueId: venueId as number,
        sport: sport as Sport,
      })
    : createBookingSeries({ ...common, courtId: courtId as number });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  // A code is claimed before anything is settled, so paying from credit or a
  // pass charges the discounted figure. Like paying, it is best-effort: a code
  // that has run out leaves the booking standing at full price with the reason.
  let promoError: string | null = null;
  let discount = 0;
  if (typeof promoCode === "string" && promoCode.trim() !== "") {
    for (const booking of result.bookings) {
      const applied = applyPromo(booking.id, promoCode);
      if (!applied.ok) {
        if (!promoError) promoError = applied.error;
      } else {
        booking.totalPrice = applied.newTotal;
        discount += applied.discount;
      }
    }
  }

  // Settling is best-effort: an empty wallet or a spent pass leaves the
  // booking standing as unpaid rather than throwing it away.
  const payErrors: string[] = [];
  if (typeof payWithPass === "string" && payWithPass.trim() !== "") {
    // The pass itself proves entitlement: it must match the booking's phone
    // number, which payBookingWithPass checks.
    for (const booking of result.bookings) {
      const paid = payBookingWithPass(booking.id, payWithPass);
      if (!paid.ok) payErrors.push(paid.error);
      else booking.paymentStatus = "paid";
    }
  } else if (payFromWallet === true && user) {
    for (const booking of result.bookings) {
      const paid = payBookingFromWallet(booking.id);
      if (!paid.ok) payErrors.push(paid.error);
      else booking.paymentStatus = "paid";
    }
  }

  const court = getCourt(result.bookings[0].courtId)!;
  const venue = getVenue(court.venueId)!;
  return NextResponse.json(
    {
      booking: result.bookings[0],
      bookings: result.bookings,
      skipped: result.skipped,
      seriesCode: result.seriesCode,
      walletError: payErrors[0] ?? null,
      promoError,
      discount,
      court,
      venue: { id: venue.id, name: venue.name, area: venue.area },
    },
    { status: 201 }
  );
}

export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const phone = params.get("phone");
  if (!code || !phone)
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });

  const limited = rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const booking = findBooking(code, phone);
  if (!booking)
    return NextResponse.json(
      { error: "Booking not found. Check the code and phone number." },
      { status: 404 }
    );

  const court = getCourt(booking.courtId)!;
  const venue = getVenue(court.venueId)!;
  return NextResponse.json({
    booking,
    court,
    venue: {
      id: venue.id,
      name: venue.name,
      area: venue.area,
      address: venue.address,
      cancelCutoffHours: venue.cancelCutoffHours,
    },
  });
}
