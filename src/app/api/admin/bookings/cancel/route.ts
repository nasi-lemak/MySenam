import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { adminCancelBooking, getVenueIdForBookingCode } from "@/lib/store";
import { notifyVenueCancelled, tickOutbox } from "@/lib/notify";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";
import { refusal } from "@/lib/api";
import { refundCancelled } from "@/lib/payments";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code is required." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  const result = await adminCancelBooking(code);
  if (!result.ok) return refusal(result);
  // Paid online: it goes back now, as when a customer cancels, rather than waiting on staff.
  await refundCancelled([result.booking.id], { byVenue: true });
  await logAction(admin, {
    venueId,
    action: "booking.cancelled",
    bookingCode: result.booking.code,
    detail: `${result.booking.date} ${result.booking.startHour}:00, ${result.booking.name}, ${money(result.booking.totalPrice)}${
      result.booking.paymentStatus === "paid" ? " (was paid)" : ""
    }`,
  });
  // The customer is told, and the desk sees until they have seen it.
  const notice = await notifyVenueCancelled(result.booking);
  await tickOutbox();
  return NextResponse.json({ booking: result.booking, noticeId: notice });
}
