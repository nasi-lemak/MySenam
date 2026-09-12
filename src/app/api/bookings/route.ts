import { NextRequest, NextResponse } from "next/server";
import { createBooking, findBooking, getCourt, getVenue } from "@/lib/store";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { courtId, date, hours, name, phone, email } = (body ?? {}) as Record<string, unknown>;

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

  const result = createBooking({
    courtId: courtId as number,
    date,
    hours: hours as number[],
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  const court = getCourt(result.booking.courtId)!;
  const venue = getVenue(court.venueId)!;
  return NextResponse.json(
    { booking: result.booking, court, venue: { id: venue.id, name: venue.name, area: venue.area } },
    { status: 201 }
  );
}

export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const phone = params.get("phone");
  if (!code || !phone)
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });

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
