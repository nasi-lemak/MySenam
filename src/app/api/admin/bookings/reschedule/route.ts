import { NextRequest, NextResponse } from "next/server";
import { isSlotHour } from "@/lib/time";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { notifyRescheduled, tickOutbox } from "@/lib/notify";
import { getCourt, getVenueIdForBookingCode, rescheduleBooking, rescheduleOptions } from "@/lib/store";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/** `?code&date` → the start times this booking could change to that day. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return NextResponse.json({ error: "code and date are required." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ options: await rescheduleOptions(code, date) });
}

/** `{ code, date, startHour, courtId? }` → the booking at its new time; the customer is told. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, date, startHour, courtId } = body ?? {};
  if (typeof code !== "string" || typeof date !== "string" || !isSlotHour(startHour))
    return NextResponse.json({ error: "code, date and startHour are required." }, { status: 400 });
  if (courtId !== undefined && courtId !== null && !Number.isInteger(courtId))
    return NextResponse.json({ error: "courtId must be a court's id." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (typeof courtId === "number") {
    const target = await getCourt(courtId);
    if (!target) return NextResponse.json({ error: "Court not found." }, { status: 404 });
    const deniedTarget = denyVenue(admin, target.venueId);
    if (deniedTarget) return deniedTarget;
  }
  const result = await rescheduleBooking(
    code,
    { date, startHour: startHour as number, ...(typeof courtId === "number" ? { courtId } : {}) },
    "staff"
  );
  if (!result.ok) return NextResponse.json(result, { status: 409 });
  await logAction(admin, {
    venueId,
    action: "booking.rescheduled",
    bookingCode: result.booking.code,
    detail: `${result.from.date} ${result.from.startHour}:00 → ${result.booking.date} ${result.booking.startHour}:00${
      result.priceChange !== 0 ? `, price ${result.priceChange > 0 ? "+" : ""}${money(result.priceChange)}` : ""
    }`,
  });
  await notifyRescheduled(result.booking, "staff", result.priceChange);
  await tickOutbox();
  return NextResponse.json({
    booking: result.booking,
    priceChange: result.priceChange,
    unchargedDifference: result.unchargedDifference,
  });
}
