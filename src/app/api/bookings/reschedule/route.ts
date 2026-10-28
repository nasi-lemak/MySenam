import { NextRequest, NextResponse } from "next/server";
import { isMinute, parseClock } from "@/lib/interval";
import { jsonObject, refusal } from "@/lib/api";
import { notifyRescheduled, tickOutbox } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";
import { customerChangeRefusal, findBooking, getVenueIdForBookingCode, rescheduleBooking, rescheduleOptions } from "@/lib/store";
import { houseRuleRefusal } from "@/lib/house-rules";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** `?code&phone&date` → the start times this booking could change to that day; refused, saying why, once it is too late to change. */
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
  // Offer nothing that choosing would be refused for.
  const tooLate = await customerChangeRefusal(booking);
  if (tooLate) return refusal(tooLate);
  return NextResponse.json({ options: await rescheduleOptions(booking.code, date) });
}

/** `{ code, phone, date, start }` → the booking, at its new time (`start` in minutes of the day or HH:MM; `startHour` the older form). */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, phone, date, startHour } = body ?? {};
  const start =
    body.start !== undefined ? (typeof body.start === "string" ? parseClock(body.start) : body.start) : typeof startHour === "number" ? Math.round(startHour * 60) : null;
  if (typeof code !== "string" || typeof phone !== "string" || typeof date !== "string" || !isMinute(start))
    return NextResponse.json({ error: "code, phone, date and start are required." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  // The code and the phone number together, as for cancelling.
  const booking = await findBooking(code, phone);
  if (!booking) return NextResponse.json({ error: "Booking not found. Check the code and phone number.", code: "BOOKING_NOT_FOUND_CODE" }, { status: 404 });
  // The venue's house rules hold for the new day as for a new booking: the members' longer window
  // is the account's privilege, asked now as booking online asks it (a number the account that made
  // the booking has proved or is linked to), never the number typed on it alone.
  const venueId = await getVenueIdForBookingCode(booking.code);
  if (venueId !== null) {
    const madeBy = ((await getDb().prepare("SELECT user_id FROM bookings WHERE id = ?").get(booking.id)) as { user_id: number | null } | undefined)?.user_id ?? null;
    const tooMany = await houseRuleRefusal({ venueId, phone: booking.phone, userId: madeBy, dates: [date], excluding: booking.id, online: true });
    if (tooMany) return refusal(tooMany);
  }
  const result = await rescheduleBooking(booking.code, { date, start }, "customer");
  if (!result.ok) return refusal(result);
  await notifyRescheduled(result.booking, "customer", result.priceChange, booking);
  await tickOutbox();
  return NextResponse.json({ booking: result.booking, priceChange: result.priceChange });
}
