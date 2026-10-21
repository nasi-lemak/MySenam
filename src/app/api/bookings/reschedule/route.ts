import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { notifyRescheduled, tickOutbox } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";
import { findBooking, getVenueIdForBookingCode, rescheduleBooking, rescheduleOptions } from "@/lib/store";
import { houseRuleRefusal } from "@/lib/house-rules";

export const dynamic = "force-dynamic";

/** `?code&phone&date` → the start times this booking could change to that day. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const code = p.get("code") ?? "";
  const phone = p.get("phone") ?? "";
  const date = p.get("date") ?? "";
  if (!code || !phone || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return NextResponse.json({ error: "code, phone and date are required." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const booking = await findBooking(code, phone);
  if (!booking) return NextResponse.json({ error: "Booking not found. Check the code and phone number.", code: "BOOKING_NOT_FOUND_CODE" }, { status: 404 });
  return NextResponse.json({ options: await rescheduleOptions(booking.code, date) });
}

/** `{ code, phone, date, startHour }` → the booking, at its new time. */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, phone, date, startHour } = body ?? {};
  if (typeof code !== "string" || typeof phone !== "string" || typeof date !== "string" || !Number.isInteger(startHour))
    return NextResponse.json({ error: "code, phone, date and startHour are required." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  // The code and the phone number together, as for cancelling.
  const booking = await findBooking(code, phone);
  if (!booking) return NextResponse.json({ error: "Booking not found. Check the code and phone number.", code: "BOOKING_NOT_FOUND_CODE" }, { status: 404 });
  // The venue's house rules hold for the new day as for a new booking.
  const venueId = await getVenueIdForBookingCode(booking.code);
  if (venueId !== null) {
    const tooMany = await houseRuleRefusal({ venueId, phone: booking.phone, dates: [date], excluding: booking.id });
    if (tooMany) return refusal(tooMany);
  }
  const result = await rescheduleBooking(booking.code, { date, startHour: startHour as number }, "customer");
  if (!result.ok) return refusal(result);
  await notifyRescheduled(result.booking, "customer", result.priceChange);
  await tickOutbox();
  return NextResponse.json({ booking: result.booking, priceChange: result.priceChange });
}
