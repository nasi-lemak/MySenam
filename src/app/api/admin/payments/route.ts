import { NextRequest, NextResponse } from "next/server";
import { canAccessVenue, denyVenue, requireAdmin } from "@/lib/admin-auth";
import { notifyPaid, notifyPaidSeries } from "@/lib/notify";
import {
  getVenueIdForBookingCode,
  getVenueIdsForSeriesCode,
  paySeries,
  setPaymentStatus,
} from "@/lib/store";
import { COUNTER_METHODS, PAID_VIA_LABELS, type CounterMethod } from "@/lib/types";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";

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
  const { code, seriesCode, paid, via } = (body ?? {}) as Record<string, unknown>;
  // How the desk took the money: cash, DuitNow QR, a transfer or a card terminal.
  if (via !== undefined && via !== null && !COUNTER_METHODS.includes(via as CounterMethod))
    return NextResponse.json({ error: `via must be one of ${COUNTER_METHODS.join(", ")}.` }, { status: 400 });
  const method = (via ?? null) as CounterMethod | null;

  if (typeof seriesCode === "string" && seriesCode.trim() !== "") {
    const venueIds = await getVenueIdsForSeriesCode(seriesCode);
    if (venueIds.length === 0)
      return NextResponse.json({ error: "Series not found." }, { status: 404 });
    if (!venueIds.every((id) => canAccessVenue(admin, id)))
      return NextResponse.json({ error: "You do not manage that venue." }, { status: 403 });

    const result = await paySeries(seriesCode, method);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    await logAction(admin, {
      venueId: venueIds[0],
      action: "payment.paid",
      bookingCode: seriesCode,
      detail: `${result.paid} sessions of a series${method ? `, by ${PAID_VIA_LABELS[method]}` : ""}`,
    });
    await notifyPaidSeries(seriesCode, "counter");
    return NextResponse.json({ paid: result.paid });
  }

  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code or seriesCode is required." }, { status: 400 });
  if (typeof paid !== "boolean")
    return NextResponse.json({ error: "paid must be true or false." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  const result = await setPaymentStatus(code, paid, method);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, {
    venueId,
    action: paid ? "payment.paid" : "payment.unpaid",
    bookingCode: result.booking.code,
    detail: `${money(result.booking.totalPrice)}${paid && method ? `, by ${PAID_VIA_LABELS[method]}` : ""}`,
  });
  if (paid) await notifyPaid([result.booking], "counter");
  return NextResponse.json({ booking: result.booking });
}
