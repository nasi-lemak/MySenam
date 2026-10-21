import { NextRequest, NextResponse } from "next/server";
import { apiBooking, apiCaller } from "@/lib/api-keys";
import { notifyBookingConfirmed } from "@/lib/notify";
import { bookingsBetween, MAX_RANGE_DAYS, spanDays } from "@/lib/public-api";
import { createBooking, getCourt } from "@/lib/store";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

/** `?from=&to=` (at most 31 days) → the venue's bookings, cancelled ones included. */
export async function GET(req: NextRequest) {
  const caller = await apiCaller(req);
  if (caller instanceof NextResponse) return caller;
  const from = req.nextUrl.searchParams.get("from") ?? "";
  const to = req.nextUrl.searchParams.get("to") ?? from;
  if (!isValidDateString(from) || !isValidDateString(to) || to < from)
    return NextResponse.json({ error: "from and to (YYYY-MM-DD) are required, to not before from." }, { status: 400 });
  if (spanDays(from, to) > MAX_RANGE_DAYS) return NextResponse.json({ error: `At most ${MAX_RANGE_DAYS} days at a time.` }, { status: 400 });
  return NextResponse.json({ bookings: await bookingsBetween(caller.venueId, from, to) });
}

/**
 * `{ courtId, date, hours: [9, 10], name, phone, email? }` → a booking, as the
 * venue's own system makes it (write keys). The customer is sent the usual
 * confirmation. Unpaid; the venue settles it as any other.
 */
export async function POST(req: NextRequest) {
  const caller = await apiCaller(req, "write");
  if (caller instanceof NextResponse) return caller;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.courtId)) return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  const court = await getCourt(body.courtId as number);
  if (!court || court.venueId !== caller.venueId) return NextResponse.json({ error: "That court is not at this key's venue." }, { status: 404 });
  if (typeof body.date !== "string" || !isValidDateString(body.date)) return NextResponse.json({ error: "date (YYYY-MM-DD) is required." }, { status: 400 });
  if (!Array.isArray(body.hours) || body.hours.length === 0 || !body.hours.every((h) => typeof h === "number"))
    return NextResponse.json({ error: "hours is a list of slot start hours." }, { status: 400 });
  if (typeof body.name !== "string" || body.name.trim().length < 2 || typeof body.phone !== "string" || body.phone.trim().length < 7)
    return NextResponse.json({ error: "name and phone are required." }, { status: 400 });
  const made = await createBooking({
    courtId: court.id,
    date: body.date,
    hours: body.hours as number[],
    name: body.name.trim(),
    phone: body.phone.trim(),
    email: typeof body.email === "string" && body.email.trim() ? body.email.trim() : undefined,
  });
  if (!made.ok) return NextResponse.json({ error: made.error, code: made.code }, { status: 409 });
  await notifyBookingConfirmed([made.booking], "en", null);
  return NextResponse.json({ booking: apiBooking({ ...made.booking, courtName: court.name, sport: court.sport }) }, { status: 201 });
}
