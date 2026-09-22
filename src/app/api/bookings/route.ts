import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { createBookingSeries, findBooking, getCourt, getVenue } from "@/lib/store";
import { rateLimit } from "@/lib/rate-limit";
import { isValidDateString } from "@/lib/time";
import { MAX_RECUR_WEEKS } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { courtId, date, hours, name, phone, email, weeks, skipConflicts } = (body ??
    {}) as Record<string, unknown>;

  if (!Number.isInteger(courtId) || (courtId as number) <= 0)
    return NextResponse.json({ error: "courtId is required." }, { status: 400 });
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
  const result = createBookingSeries({
    courtId: courtId as number,
    date,
    hours: hours as number[],
    weeks: (weeks as number) ?? 1,
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    userId: user?.id,
    skipConflicts: skipConflicts === true,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  const court = getCourt(result.bookings[0].courtId)!;
  const venue = getVenue(court.venueId)!;
  return NextResponse.json(
    {
      booking: result.bookings[0],
      bookings: result.bookings,
      skipped: result.skipped,
      seriesCode: result.seriesCode,
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
    venue: { id: venue.id, name: venue.name, area: venue.area, address: venue.address },
  });
}
